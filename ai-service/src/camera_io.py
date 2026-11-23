"""Opening any kind of camera: RTSP (IP cameras, recorders), HTTP (snapshot, MJPEG or HLS links) and USB.

A "source spec" comes from the backend (/internal/cameras or a test request):
    {"type": "rtsp" | "http" | "usb", "url": "rtsp://user:pass@host:554/...", "key": "..."}
EZVIZ cloud cameras are handled in sources.py / worker.py as before.

Credentials only ever travel inside the URL given here; every message this module produces masks them.
"""

import base64
import hashlib
import logging
import os
import socket
import threading
import time
from typing import Optional
from urllib.parse import unquote, urlsplit, urlunsplit

import cv2
import httpx
import numpy as np

from sources import FrameSource, LatestFrameCapture

# Most cameras behave better over TCP (no lost UDP packets / grey smears); must be set before the first capture.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

log = logging.getLogger("ai.camera_io")
OPEN_TIMEOUT_MS = 10_000
READ_TIMEOUT_MS = 10_000


class SourceError(Exception):
    """A readable reason a camera could not be opened."""


# ---------------------------------------------------------------- URL helpers


def split_url(url: str) -> tuple[str, Optional[str], Optional[str]]:
    parts = urlsplit(url)
    if "@" not in parts.netloc:
        return url, None, None
    userinfo, hostport = parts.netloc.rsplit("@", 1)
    user, _, pwd = userinfo.partition(":")
    return urlunsplit((parts.scheme, hostport, parts.path, parts.query, parts.fragment)), unquote(user), unquote(pwd)


def mask(url: str) -> str:
    clean, user, _ = split_url(url or "")
    if not user:
        return url
    p = urlsplit(clean)
    return urlunsplit((p.scheme, f"***@{p.netloc}", p.path, p.query, p.fragment))


# ---------------------------------------------------------------- RTSP diagnosis


def _rtsp_request(sock: socket.socket, url: str, cseq: int, auth: Optional[str]) -> tuple[int, dict]:
    lines = [f"DESCRIBE {url} RTSP/1.0", f"CSeq: {cseq}", "Accept: application/sdp", "User-Agent: WorkSight"]
    if auth:
        lines.append(f"Authorization: {auth}")
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    data = b""
    while b"\r\n\r\n" not in data and len(data) < 65536:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    first, *rest = head.split("\r\n") if head else [""]
    try:
        status = int(first.split()[1]) if first.startswith("RTSP/") else 0  # e.g. a web server answers HTTP/1.1
    except (IndexError, ValueError):
        status = 0
    headers: dict[str, str] = {}
    for line in rest:
        k, _, v = line.partition(":")
        headers.setdefault(k.strip().lower(), v.strip())
    return status, headers


def _digest(challenge: str, user: str, pwd: str, url: str) -> str:
    fields = {}
    for part in challenge[len("Digest"):].split(","):
        k, _, v = part.strip().partition("=")
        fields[k.lower()] = v.strip('"')
    realm, nonce = fields.get("realm", ""), fields.get("nonce", "")
    ha1 = hashlib.md5(f"{user}:{realm}:{pwd}".encode()).hexdigest()
    ha2 = hashlib.md5(f"DESCRIBE:{url}".encode()).hexdigest()
    resp = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
    return f'Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{url}", response="{resp}"'


def explain_rtsp(url: str) -> str:
    """Ask the camera directly why a stream won't open (reachable? login? path?). Never raises."""
    clean, user, pwd = split_url(url)
    p = urlsplit(clean)
    host, port = p.hostname or "", p.port or 554
    try:
        sock = socket.create_connection((host, port), timeout=5)
    except OSError:
        return f"Can't reach {host} on port {port}. Check the IP address, that the camera is on, and that RTSP is enabled."
    try:
        sock.settimeout(5)
        status, headers = _rtsp_request(sock, clean, 1, None)
        if status == 401:
            if not user:
                return "The camera needs a username and password."
            challenge = headers.get("www-authenticate", "")
            if challenge.lower().startswith("digest"):
                auth = _digest(challenge, user, pwd or "", clean)
            else:
                auth = "Basic " + base64.b64encode(f"{user}:{pwd or ''}".encode()).decode()
            status, _ = _rtsp_request(sock, clean, 2, auth)
            if status == 401:
                return "The camera refused the username or password."
        if status == 404:
            return "The camera is reachable but has no stream at that address. Check the brand or the stream path."
        if status == 200:
            return "The camera answered, but no picture arrived. It may use a video format this PC can't decode (try the sub-stream), or it is busy."
        if status == 0:
            return f"Something is listening on {host}:{port}, but it isn't an RTSP camera."
        return f"The camera answered with RTSP error {status}."
    except OSError:
        return f"{host}:{port} stopped answering. Check the camera's network connection."
    finally:
        sock.close()


# ---------------------------------------------------------------- sources


class StreamSource(LatestFrameCapture):
    """RTSP / MJPEG over HTTP / USB, read continuously in the background."""

    def __init__(self, target, kind: str):
        try:
            super().__init__(target, kind)
        except RuntimeError:
            raise SourceError(_open_failure(target, kind))

    def _open(self, target):  # used by LatestFrameCapture
        if isinstance(target, int):
            cap = cv2.VideoCapture(target, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(target)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)  # ask for HD; the camera picks the nearest it supports
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
            return cap
        return cv2.VideoCapture(
            target, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MS, cv2.CAP_PROP_READ_TIMEOUT_MSEC, READ_TIMEOUT_MS]
        )

    def latest(self) -> Optional[np.ndarray]:
        """Newest frame without consuming the queue (for previews)."""
        if self.failed:
            raise SourceError(f"The {self.kind} stream stopped.")
        with self._lock:
            return self._queue[-1] if self._queue else None


class HttpImageSource(FrameSource):
    """A link that returns one still picture per request (snapshot.jpg / cgi). Polled about once a second."""

    kind = "http"
    interval = 1.0

    def __init__(self, url: str):
        self.url, user, pwd = split_url(url)
        self._client = httpx.Client(timeout=10.0, follow_redirects=True)
        self._basic = httpx.BasicAuth(user, pwd or "") if user else None
        self._digest = httpx.DigestAuth(user, pwd or "") if user else None
        self._auth = self._basic

    def _get(self) -> bytes:
        try:
            r = self._client.get(self.url, auth=self._auth)
            if r.status_code == 401 and self._digest is not None and self._auth is not self._digest:
                self._auth = self._digest  # many cameras want digest
                r = self._client.get(self.url, auth=self._auth)
        except httpx.HTTPError as exc:
            raise SourceError(f"Can't reach {urlsplit(self.url).hostname} ({exc.__class__.__name__}).")
        if r.status_code == 401:
            raise SourceError("The camera refused the username or password." if self._basic else "The camera needs a username and password.")
        if r.status_code >= 400:
            raise SourceError(f"The camera answered HTTP {r.status_code} for that link.")
        return r.content

    def read(self) -> Optional[np.ndarray]:
        data = self._get()
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise SourceError("That link didn't return a picture (JPEG/PNG). Use a snapshot link or an MJPEG stream link.")
        return img

    def latest(self) -> Optional[np.ndarray]:
        return self.read()

    def close(self) -> None:
        self._client.close()


def _open_failure(target, kind: str) -> str:
    if kind == "usb":
        return f"No USB camera at number {target}, or another program is using it."
    if kind == "rtsp":
        return explain_rtsp(target)
    return "Could not open the stream. Check the link, username and password."


def _http_kind(url: str) -> str:
    """HTTP links can be a single picture, an MJPEG stream or an HLS playlist; look at what the camera sends."""
    clean, user, pwd = split_url(url)
    if urlsplit(clean).path.lower().endswith(".m3u8"):
        return "hls"
    auth = httpx.DigestAuth(user, pwd or "") if user else None
    try:
        with httpx.Client(timeout=8.0, follow_redirects=True) as c:
            with c.stream("GET", clean, auth=auth) as r:
                if r.status_code == 401 and user:
                    return "image"  # let HttpImageSource report the login problem
                ctype = r.headers.get("content-type", "").lower()
    except httpx.HTTPError:
        return "image"
    if "multipart" in ctype:
        return "mjpeg"
    if "mpegurl" in ctype:
        return "hls"
    return "image"


def open_spec(spec: dict) -> FrameSource:
    """Open a non-EZVIZ source spec for continuous reading. Raises SourceError."""
    kind, url = spec.get("type"), spec.get("url") or ""
    if kind == "usb":
        try:
            index = int(url.split(":", 1)[1])
        except (IndexError, ValueError):
            raise SourceError("USB camera must be usb:0, usb:1, …")
        return StreamSource(index, "usb")
    if kind == "rtsp":
        return StreamSource(url, "rtsp")
    if kind == "http":
        sub = _http_kind(url)
        return HttpImageSource(url) if sub == "image" else StreamSource(url, sub)
    raise SourceError(f"Unknown camera type: {kind}")


def grab_once(spec: dict, timeout: float = 15.0) -> np.ndarray:
    """Open a source, return one good frame, close it."""
    src = open_spec(spec)
    try:
        end = time.time() + timeout
        while time.time() < end:
            frame = src.latest() if hasattr(src, "latest") else src.read()
            if frame is not None and frame.size:
                return frame
            time.sleep(0.1)
        raise SourceError(
            explain_rtsp(spec.get("url", "")) if spec.get("type") == "rtsp" else "The camera connected but sent no picture."
        )
    finally:
        src.close()


class PreviewPool:
    """Keeps a stream open for a short while after a preview request, so a live view polling once a second
    doesn't reconnect to the camera every time. Idle streams close after IDLE_SEC."""

    IDLE_SEC = 30.0

    def __init__(self) -> None:
        self._items: dict[str, tuple[FrameSource, float]] = {}
        self._lock = threading.Lock()

    def frame(self, key: str, spec: dict) -> np.ndarray:
        self._expire()
        with self._lock:
            item = self._items.get(key)
        if item is None:
            src = open_spec(spec)
            with self._lock:
                self._items[key] = (src, time.time())
        else:
            src = item[0]
        try:
            end = time.time() + 12
            while time.time() < end:
                frame = src.latest() if hasattr(src, "latest") else src.read()
                if frame is not None:
                    with self._lock:
                        self._items[key] = (src, time.time())
                    return frame
                time.sleep(0.1)
            raise SourceError("The camera sent no picture.")
        except Exception:
            self.drop(key)
            raise

    def drop(self, key: str) -> None:
        with self._lock:
            item = self._items.pop(key, None)
        if item:
            item[0].close()

    def _expire(self) -> None:
        now = time.time()
        with self._lock:
            stale = [k for k, (_, used) in self._items.items() if now - used > self.IDLE_SEC]
        for k in stale:
            self.drop(k)


def to_jpeg(frame: np.ndarray, max_width: int = 1280, quality: int = 80) -> bytes:
    h, w = frame.shape[:2]
    if w > max_width:
        frame = cv2.resize(frame, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise SourceError("Could not encode the picture.")
    return buf.tobytes()
