"""Minimal ONVIF client: find cameras on the local network and read their stream addresses.

ONVIF is the open standard most IP cameras and recorders speak (Hikvision, Dahua, Axis, Uniview, Reolink, Hanwha,
TP-Link VIGI, ...). Two parts:
  discover()      WS-Discovery: one multicast "who is a camera?" message on each network adapter; cameras answer
                  with their address. Read-only, nothing is changed on any device.
  read_streams()  signs in (WS-Security digest, or HTTP digest as a fallback) and asks for the device information,
                  the media profiles and an RTSP address for each profile.
No extra libraries: plain SOAP over httpx and the standard-library XML parser.
"""

import base64
import hashlib
import logging
import os
import socket
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import unquote, urlsplit
from xml.sax.saxutils import escape

import httpx

from app.services.camera_sources import split_credentials

log = logging.getLogger("worksight.onvif")

MULTICAST = ("239.255.255.250", 3702)
MAX_RESPONSE = 512 * 1024


class OnvifError(Exception):
    pass


# ---------------------------------------------------------------- XML helpers (namespace-agnostic)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _first(el: Optional[ET.Element], name: str) -> Optional[ET.Element]:
    if el is None:
        return None
    return next((x for x in el.iter() if _local(x.tag) == name), None)


def _all(el: ET.Element, name: str) -> list[ET.Element]:
    return [x for x in el.iter() if _local(x.tag) == name]


def _text(el: Optional[ET.Element], name: str) -> Optional[str]:
    found = _first(el, name)
    return found.text.strip() if found is not None and found.text else None


def _parse(data: bytes) -> ET.Element:
    if len(data) > MAX_RESPONSE:
        raise OnvifError("Response too large")
    if b"<!DOCTYPE" in data[:2000] or b"<!ENTITY" in data[:2000]:
        raise OnvifError("Unexpected XML from device")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise OnvifError(f"Unreadable reply from device ({exc})")


# ---------------------------------------------------------------- discovery


def _probe(with_types: bool) -> bytes:
    types = "<d:Types>dn:NetworkVideoTransmitter</d:Types>" if with_types else ""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
        'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
        'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        f"<e:Header><w:MessageID>uuid:{uuid.uuid4()}</w:MessageID>"
        '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>'
        '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>'
        f"</e:Header><e:Body><d:Probe>{types}</d:Probe></e:Body></e:Envelope>"
    ).encode()


def _local_ipv4() -> list[str]:
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:  # the adapter used for the default route
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith(("127.", "169.254.")))


def _scope(scopes: list[str], key: str) -> Optional[str]:
    for s in scopes:
        marker = f"onvif://www.onvif.org/{key}/"
        if s.lower().startswith(marker):
            return unquote(s[len(marker):]).replace("_", " ").strip() or None
    return None


def discover(timeout: float = 3.0) -> list[dict]:
    """Cameras that answer an ONVIF probe on any local network adapter."""
    found: dict[str, dict] = {}
    sockets = []
    for ip in _local_ipv4() or ["0.0.0.0"]:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
            if ip != "0.0.0.0":
                s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(ip))
            s.bind((ip, 0))
            s.setblocking(False)
            for with_types in (True, False):
                s.sendto(_probe(with_types), MULTICAST)
            sockets.append(s)
        except OSError as exc:
            log.info("[onvif] probe on %s failed: %s", ip, exc)
    end = time.time() + timeout
    while time.time() < end and sockets:
        for s in sockets:
            try:
                data, addr = s.recvfrom(65535)
            except (BlockingIOError, OSError):
                continue
            try:
                root = _parse(data)
            except OnvifError:
                continue
            for match in _all(root, "ProbeMatch"):
                xaddrs = (_text(match, "XAddrs") or "").split()
                scopes = (_text(match, "Scopes") or "").split()
                # Prefer an address on the same host that answered.
                xaddr = next((x for x in xaddrs if urlsplit(x).hostname == addr[0]), xaddrs[0] if xaddrs else None)
                if not xaddr:
                    continue
                host = urlsplit(xaddr).hostname or addr[0]
                found[host] = {
                    "host": host,
                    "port": urlsplit(xaddr).port or 80,
                    "deviceUrl": xaddr,
                    "name": _scope(scopes, "name"),
                    "hardware": _scope(scopes, "hardware"),
                    "manufacturer": _scope(scopes, "mfr") or _scope(scopes, "manufacturer"),
                    "isRecorder": any("/type/nvr" in sc.lower() or "/type/dvr" in sc.lower() for sc in scopes),
                }
        time.sleep(0.05)
    for s in sockets:
        s.close()
    return sorted(found.values(), key=lambda d: tuple(int(p) if p.isdigit() else 0 for p in d["host"].split(".")))


# ---------------------------------------------------------------- authenticated calls

NS_DEVICE = "http://www.onvif.org/ver10/device/wsdl"
NS_MEDIA = "http://www.onvif.org/ver10/media/wsdl"
NS_SCHEMA = "http://www.onvif.org/ver10/schema"


def _security(username: str, password: str, clock_offset: timedelta) -> str:
    nonce = os.urandom(16)
    created = (datetime.now(timezone.utc) + clock_offset).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + password.encode()).digest()).decode()
    return (
        '<wsse:Security s:mustUnderstand="1" '
        'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" '
        'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
        f"<wsse:UsernameToken><wsse:Username>{escape(username)}</wsse:Username>"
        '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
        f"{digest}</wsse:Password>"
        '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">'
        f"{base64.b64encode(nonce).decode()}</wsse:Nonce><wsu:Created>{created}</wsu:Created>"
        "</wsse:UsernameToken></wsse:Security>"
    )


class _Session:
    def __init__(self, device_url: str, username: str, password: str):
        self.device_url = device_url
        self.username, self.password = username or "", password or ""
        self.clock_offset = timedelta(0)
        self.http_digest = False
        self.http = httpx.Client(timeout=8.0, follow_redirects=False)

    def call(self, url: str, body: str, auth: bool = True) -> ET.Element:
        header = _security(self.username, self.password, self.clock_offset) if auth and self.username else ""
        envelope = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
            f"<s:Header>{header}</s:Header><s:Body>{body}</s:Body></s:Envelope>"
        )
        kwargs = {"auth": httpx.DigestAuth(self.username, self.password)} if self.http_digest and auth else {}
        try:
            r = self.http.post(url, content=envelope.encode(), headers={"Content-Type": "application/soap+xml; charset=utf-8"}, **kwargs)
        except httpx.HTTPError as exc:
            host = urlsplit(url).hostname
            raise OnvifError(f"Could not reach {host} ({exc.__class__.__name__}). Check the IP address and that the camera is on.")
        if r.status_code == 401 and auth and self.username and not self.http_digest:
            self.http_digest = True  # some devices (e.g. Dahua) want HTTP digest instead of WS-Security
            return self.call(url, body, auth)
        if r.status_code == 404 or "xml" not in r.headers.get("content-type", "xml").lower():
            u = urlsplit(url)
            raise OnvifError(
                f"No ONVIF service at {u.hostname}:{u.port or 80}. Turn on ONVIF in the camera's settings "
                "(it may need its own ONVIF user), or try port 80, 8000 or 8080."
            )
        root = _parse(r.content)
        fault = _first(root, "Fault")
        if fault is not None or r.status_code >= 400:
            reason = " ".join(x.text.strip() for x in fault.iter() if x.text and x.text.strip()) if fault is not None else ""
            low = reason.lower().replace(" ", "")
            if r.status_code in (401, 403) or any(w in low for w in ("notauthorized", "authenticat", "authority", "password")):
                raise OnvifError("The camera refused the username or password.")
            raise OnvifError(f"The camera returned an error: {reason[:160] or r.status_code}")
        return root

    def sync_clock(self) -> None:
        """Digest sign-in includes a timestamp; follow the camera's clock so a skewed clock doesn't fail it."""
        try:
            root = self.call(self.device_url, f'<tds:GetSystemDateAndTime xmlns:tds="{NS_DEVICE}"/>', auth=False)
            utc = _first(root, "UTCDateTime")
            d, t = _first(utc, "Date"), _first(utc, "Time")
            cam = datetime(
                int(_text(d, "Year")), int(_text(d, "Month")), int(_text(d, "Day")),
                int(_text(t, "Hour")), int(_text(t, "Minute")), int(_text(t, "Second")), tzinfo=timezone.utc,
            )
            self.clock_offset = cam - datetime.now(timezone.utc)
        except Exception:
            self.clock_offset = timedelta(0)


def read_streams(host: str, port: int, username: str, password: str, device_url: Optional[str] = None) -> dict:
    """Device information plus one RTSP address per video input (the highest-resolution profile of each)."""
    url = device_url or f"http://{host}:{port or 80}/onvif/device_service"
    sess = _Session(url, username, password)
    sess.sync_clock()

    info_root = sess.call(url, f'<tds:GetDeviceInformation xmlns:tds="{NS_DEVICE}"/>')
    info = {k: _text(info_root, k) for k in ("Manufacturer", "Model", "FirmwareVersion", "SerialNumber")}

    caps = sess.call(url, f'<tds:GetCapabilities xmlns:tds="{NS_DEVICE}"><tds:Category>Media</tds:Category></tds:GetCapabilities>')
    media_url = _text(_first(caps, "Media"), "XAddr") or url
    # Some devices report an internal address; talk to the address we actually reached.
    m = urlsplit(media_url)
    if m.hostname and m.hostname != host:
        media_url = m._replace(netloc=urlsplit(url).netloc).geturl()

    profiles_root = sess.call(media_url, f'<trt:GetProfiles xmlns:trt="{NS_MEDIA}"/>')
    profiles = []
    for p in _all(profiles_root, "Profiles"):
        token = p.get("token")
        if not token:
            continue
        enc = _first(p, "VideoEncoderConfiguration")
        res = _first(enc, "Resolution")
        width = int(_text(res, "Width") or 0)
        height = int(_text(res, "Height") or 0)
        source = _text(_first(p, "VideoSourceConfiguration"), "SourceToken") or "default"
        profiles.append({"token": token, "name": _text(p, "Name") or token, "source": source,
                         "width": width, "height": height, "encoding": _text(enc, "Encoding")})
    if not profiles:
        raise OnvifError("The camera has no video profiles.")

    # One lens per video input; prefer the largest picture (faces need detail).
    best: dict[str, dict] = {}
    for p in profiles:
        if p["source"] not in best or p["width"] * p["height"] > best[p["source"]]["width"] * best[p["source"]]["height"]:
            best[p["source"]] = p
    lenses = []
    for i, p in enumerate(best.values(), start=1):
        root = sess.call(
            media_url,
            f'<trt:GetStreamUri xmlns:trt="{NS_MEDIA}" xmlns:tt="{NS_SCHEMA}"><trt:StreamSetup>'
            "<tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>"
            f"</trt:StreamSetup><trt:ProfileToken>{escape(p['token'])}</trt:ProfileToken></trt:GetStreamUri>",
        )
        uri = _text(root, "Uri")
        if not uri:
            continue
        uri, _, _ = split_credentials(uri)
        u = urlsplit(uri)
        if u.hostname and u.hostname != host:
            uri = uri.replace(u.hostname, host, 1)
        lenses.append({
            "channelNo": i,
            "channelName": p["name"] if len(best) > 1 else "Main view",
            "streamUrl": uri,
            "width": p["width"],
            "height": p["height"],
            "encoding": p["encoding"],
        })
    if not lenses:
        raise OnvifError("The camera did not give a stream address.")
    return {"device": info, "lenses": lenses}
