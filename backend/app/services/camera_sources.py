"""How WorkSight reaches each kind of camera.

Connection types
  EZVIZ  cloud account (EZVIZ Open Platform): live HLS + snapshots through the EZVIZ API.
  RTSP   any IP camera or recorder (NVR/DVR) on the network. Brand templates below build the stream address from
         the IP, or the address comes from ONVIF (app.services.onvif) or is typed in.
  HTTP   a still-image (snapshot) link or an MJPEG stream link.
  USB    a camera plugged into the PC that runs the AI service (usb:0 = the first one).

Stream addresses are stored WITHOUT credentials; the username and (encrypted) password live on the camera and are
added only when the AI service needs to open the stream.
"""

import hashlib
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote, unquote, urlsplit, urlunsplit

from app.crypto import decrypt_text
from app.errors import ApiError

CONNECTION_TYPES = ("EZVIZ", "RTSP", "HTTP", "USB")


@dataclass(frozen=True)
class Brand:
    id: str
    label: str
    port: int
    main: Optional[str]  # stream path template; {c} = channel (1-based), {c2} = zero-padded channel
    sub: Optional[str] = None
    username: str = "admin"
    multi_channel: bool = True  # recorders / multi-lens cameras use the channel number
    hint: str = ""


# Common RTSP addresses. "Test connection" confirms them; if one does not work, use "Find on this network" (ONVIF)
# or type the address from the camera's manual.
BRANDS: dict[str, Brand] = {
    b.id: b
    for b in (
        Brand("hikvision", "Hikvision (also HiLook, Annke, Hikvision recorders)", 554,
              "/Streaming/Channels/{c}01", "/Streaming/Channels/{c}02"),
        Brand("dahua", "Dahua (also Amcrest, Lorex, Imou wired)", 554,
              "/cam/realmonitor?channel={c}&subtype=0", "/cam/realmonitor?channel={c}&subtype=1"),
        Brand("uniview", "Uniview (UNV)", 554, "/unicast/c{c}/s0/live", "/unicast/c{c}/s1/live"),
        Brand("reolink", "Reolink", 554, "/h264Preview_{c2}_main", "/h264Preview_{c2}_sub",
              hint="Newer 4K models may need ONVIF or the address h265Preview_01_main."),
        Brand("tplink", "TP-Link Tapo / VIGI", 554, "/stream1", "/stream2", multi_channel=False, username="",
              hint="Tapo: create a camera account in the Tapo app (Camera settings > Advanced > Camera account)."),
        Brand("axis", "Axis", 554, "/axis-media/media.amp?camera={c}", None, username="root"),
        Brand("ezviz_local", "EZVIZ on the local network (RTSP)", 554,
              "/h264/ch{c}/main/av_stream", "/h264/ch{c}/sub/av_stream",
              hint="Turn on RTSP / LAN live view in the EZVIZ app. Username admin; password is the verification "
                   "code on the camera label."),
        Brand("custom", "Other brand (type the RTSP address)", 554, None, multi_channel=True, username=""),
    )
}


def provider_for(brand: Optional[str]) -> str:
    """Value for the legacy Camera.provider column."""
    return {"hikvision": "HIKVISION", "ezviz_local": "HIKVISION", "dahua": "DAHUA"}.get(brand or "", "ONVIF_GENERIC")


# ---------------------------------------------------------------- addresses and credentials


def split_credentials(url: str) -> tuple[str, Optional[str], Optional[str]]:
    """'rtsp://u:p@host/x' -> ('rtsp://host/x', 'u', 'p'). Credentials typed into an address are moved out of it."""
    parts = urlsplit(url)
    if "@" not in parts.netloc:
        return url, None, None
    userinfo, hostport = parts.netloc.rsplit("@", 1)
    user, _, pwd = userinfo.partition(":")
    return urlunsplit((parts.scheme, hostport, parts.path, parts.query, parts.fragment)), unquote(user) or None, unquote(pwd) or None


def with_credentials(url: str, username: Optional[str], password: Optional[str]) -> str:
    """Add credentials to an rtsp/http address (for the AI service only; never stored or shown)."""
    if not url or not username or url.startswith("usb:"):
        return url
    parts = urlsplit(url)
    userinfo = quote(username, safe="") + (":" + quote(password, safe="") if password else "")
    return urlunsplit((parts.scheme, f"{userinfo}@{parts.netloc}", parts.path, parts.query, parts.fragment))


def mask(url: Optional[str]) -> Optional[str]:
    """Hide credentials in an address before showing or logging it."""
    if not url:
        return url
    clean, user, _ = split_credentials(url)
    if not user:
        return url
    parts = urlsplit(clean)
    return urlunsplit((parts.scheme, f"***@{parts.netloc}", parts.path, parts.query, parts.fragment))


def clean_host(host: str) -> str:
    host = (host or "").strip()
    if "://" in host:  # someone pasted a full address
        host = urlsplit(host).hostname or ""
    host = host.strip("/ ")
    if not host or any(c in host for c in " /@?#"):
        raise ApiError(400, "Enter the camera's IP address, e.g. 192.168.1.64")
    return host


def brand_url(brand_id: str, host: str, port: Optional[int], channel: int, quality: str = "main") -> str:
    brand = BRANDS.get(brand_id)
    if not brand or not brand.main:
        raise ApiError(400, "Choose a brand, or type the RTSP address")
    template = brand.sub if quality == "sub" and brand.sub else brand.main
    path = template.format(c=channel, c2=f"{channel:02d}")
    return f"rtsp://{host}:{port or brand.port}{path}"


def validate_stream_url(kind: str, url: str) -> str:
    url = (url or "").strip()
    if kind == "USB":
        if not url.startswith("usb:") or not url[4:].isdigit():
            raise ApiError(400, "USB camera must be usb:0, usb:1, …")
        return url
    allowed = ("rtsp://", "rtsps://") if kind == "RTSP" else ("http://", "https://")
    if not url.lower().startswith(allowed):
        raise ApiError(400, f"The address must start with {' or '.join(allowed)}")
    if len(url) > 1000:
        raise ApiError(400, "The address is too long")
    return url


def camera_password(camera) -> Optional[str]:
    if not camera.password_enc:
        return None
    try:
        return decrypt_text(camera.password_enc)
    except Exception:
        return None


def source_for(camera, channel) -> dict:
    """What the AI service opens for one lens: {type, url (with credentials), key}.

    `key` changes whenever the address or login changes, so the AI service knows to reconnect.
    """
    kind = camera.connection_type or "EZVIZ"
    if kind == "EZVIZ":
        spec = {"type": "ezviz"}
    else:
        url = with_credentials(channel.stream_url or "", camera.username, camera_password(camera))
        spec = {"type": {"RTSP": "rtsp", "HTTP": "http", "USB": "usb"}[kind], "url": url}
    raw = f"{kind}|{channel.stream_url}|{camera.username}|{camera.password_enc}"
    spec["key"] = hashlib.sha256(raw.encode()).hexdigest()[:16]
    return spec


def adhoc_source(kind: str, url: str, username: Optional[str], password: Optional[str]) -> dict:
    """Source spec for testing details that are not saved yet."""
    return {"type": {"RTSP": "rtsp", "HTTP": "http", "USB": "usb"}[kind], "url": with_credentials(url, username, password)}
