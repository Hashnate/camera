"""Adapter for the official EZVIZ Open Platform (open.ezvizlife.com)."""

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import httpx

from app.config import settings

log = logging.getLogger("worksight.ezviz")


class EZVIZError(Exception):
    pass


@dataclass
class DeviceChannelInfo:
    channel_no: int
    channel_name: str
    status: int
    is_encrypt: int
    video_level: Optional[int] = None
    pic_url: Optional[str] = None


@dataclass
class DeviceInfo:
    device_serial: str
    device_name: str
    device_type: str
    status: int  # 1 online, 0 offline
    defence: int
    device_version: Optional[str] = None
    channels: list[DeviceChannelInfo] = field(default_factory=list)


@dataclass
class StreamUrlResult:
    url: str
    protocol: int  # 1 ezopen, 2 hls, 3 rtmp
    channel_no: int
    expire_time: Optional[str] = None


@dataclass
class SnapshotResult:
    pic_url: str
    timestamp: str


def _now_ms() -> int:
    return int(time.time() * 1000)


DEFAULT_BASE_URL = "https://open.ezvizlife.com"
SETUP_HINT = "Add the EZVIZ App Key and App Secret in Settings > EZVIZ account."


def _post_to(base_url: str, path: str, data: dict, timeout: float = 10.0) -> dict:
    try:
        resp = httpx.post(f"{base_url}{path}", data=data, timeout=timeout)
    except httpx.HTTPError as exc:
        raise EZVIZError(f"Could not reach EZVIZ at {base_url} ({exc.__class__.__name__})")
    try:
        return resp.json()
    except ValueError:
        raise EZVIZError(f"Non-JSON response from EZVIZ ({resp.status_code})")


def request_token(app_key: str, app_secret: str, base_url: str) -> tuple[str, int]:
    """Exchange App Key + Secret for an access token: (token, expiry epoch ms). Raises EZVIZError."""
    if not app_key or not app_secret:
        raise EZVIZError(f"EZVIZ camera account is not set up. {SETUP_HINT}")
    body = _post_to(base_url, "/api/lapp/token/get", {"appKey": app_key, "appSecret": app_secret})
    data = body.get("data") or {}
    if str(body.get("code")) == "200" and data.get("accessToken"):
        return data["accessToken"], data.get("expireTime") or _now_ms() + 7 * 24 * 3600 * 1000
    raise EZVIZError(f"EZVIZ rejected the App Key / Secret: [{body.get('code')}] {body.get('msg') or 'Unknown error'}")


class EZVIZProvider:
    """Talks to EZVIZ with the account saved in Settings (falls back to backend/.env on old installs)."""

    def __init__(self) -> None:
        self._token: Optional[str] = None
        self._token_expires_at = 0  # epoch ms
        self._token_creds: Optional[tuple] = None  # the account the cached token belongs to
        if settings.EZVIZ_ACCESS_TOKEN:
            self._token = settings.EZVIZ_ACCESS_TOKEN
            # Assume a pre-supplied token is good for 6 days.
            self._token_expires_at = _now_ms() + 6 * 24 * 3600 * 1000
            self._token_creds = (
                settings.EZVIZ_APP_KEY,
                settings.EZVIZ_APP_SECRET,
                (settings.EZVIZ_API_BASE_URL or DEFAULT_BASE_URL).rstrip("/"),
            )

    @staticmethod
    def _creds() -> tuple[str, str, str]:
        from app.services import settings_store

        c = settings_store.get("ezviz")
        return c["appKey"], c["appSecret"], (c["apiBaseUrl"] or DEFAULT_BASE_URL).rstrip("/")

    @property
    def base_url(self) -> str:
        return self._creds()[2]

    def is_configured(self) -> bool:
        key, secret, _ = self._creds()
        return bool(key and secret) or bool(self._token and self._token_creds == self._creds())

    def _post(self, path: str, data: dict, timeout: float = 10.0) -> dict:
        return _post_to(self.base_url, path, data, timeout)

    TOKEN_EXPIRED_CODES = {"10002"}

    def _call(self, path: str, data: dict, timeout: float = 10.0) -> dict:
        """POST with the access token; on 'token expired' renew it once and retry."""
        body = self._post(path, {"accessToken": self.authenticate(), **data}, timeout)
        if str(body.get("code")) in self.TOKEN_EXPIRED_CODES:
            log.warning("[EZVIZProvider] Access token rejected (%s); renewing", body.get("code"))
            self._token, self._token_expires_at = None, 0
            try:
                token = self.authenticate()
            except Exception as exc:
                raise EZVIZError(f"EZVIZ access token expired and could not be renewed ({exc}). {SETUP_HINT}")
            body = self._post(path, {"accessToken": token, **data}, timeout)
        return body

    def authenticate(self) -> str:
        """Return a cached accessToken, refreshing it from EZVIZ when close to expiry or when the account changed."""
        creds = self._creds()
        if self._token and self._token_creds != creds:
            self._token, self._token_expires_at = None, 0  # account changed in Settings
        if self._token and _now_ms() < self._token_expires_at - 60_000:
            return self._token

        try:
            self._token, self._token_expires_at = request_token(*creds)
            self._token_creds = creds
            return self._token
        except Exception as exc:
            log.error("[EZVIZProvider] Error authenticating: %s", exc)
            if self._token:
                # Fall back to the pre-configured token on network problems.
                return self._token
            raise

    def get_device_list(self, page_start: int = 0, page_size: int = 10) -> list[DeviceInfo]:
        body = self._call("/api/lapp/device/list", {"pageStart": page_start, "pageSize": page_size})
        if body.get("code") == "200" and isinstance(body.get("data"), list):
            return [
                DeviceInfo(
                    device_serial=d.get("deviceSerial"),
                    device_name=d.get("deviceName"),
                    device_type=d.get("deviceType"),
                    status=d.get("status"),
                    defence=d.get("defence"),
                    device_version=d.get("deviceVersion"),
                )
                for d in body["data"]
            ]
        raise EZVIZError(f"Failed to list devices: [{body.get('code')}] {body.get('msg')}")

    def get_device_info(self, device_serial: str) -> Optional[DeviceInfo]:
        devices = self.get_device_list(0, 50)
        device = next((d for d in devices if d.device_serial.upper() == device_serial.upper()), None)
        if not device:
            return None
        try:
            device.channels = self.get_camera_channels(device_serial)
        except Exception as exc:
            log.warning("[EZVIZProvider] Could not load channels for %s: %s", device_serial, exc)
        return device

    def get_all_channels(self) -> dict[str, list[DeviceChannelInfo]]:
        """Every channel on the account, grouped by device serial (upper case). One API call."""
        body = self._call("/api/lapp/camera/list", {"pageStart": 0, "pageSize": 50})
        out: dict[str, list[DeviceChannelInfo]] = {}
        if body.get("code") == "200" and isinstance(body.get("data"), list):
            for c in body["data"]:
                out.setdefault(str(c.get("deviceSerial", "")).upper(), []).append(
                    DeviceChannelInfo(
                        channel_no=c.get("channelNo"),
                        channel_name=c.get("channelName") or f"Channel {c.get('channelNo')}",
                        status=c.get("status"),
                        is_encrypt=c.get("isEncrypt") if c.get("isEncrypt") is not None else 0,
                        video_level=c.get("videoLevel"),
                        pic_url=c.get("picUrl"),
                    )
                )
        for chans in out.values():
            chans.sort(key=lambda ch: ch.channel_no or 0)
        return out

    def get_camera_channels(self, device_serial: str) -> list[DeviceChannelInfo]:
        """All channels for a device (e.g. 1 = wide lens, 2 = pan-tilt)."""
        return self.get_all_channels().get(device_serial.upper(), [])

    def get_stream_url(self, device_serial: str, channel_no: int = 1, protocol: int = 2) -> StreamUrlResult:
        """Live stream address. protocol 2 = HLS (.m3u8), 1 = ezopen."""
        body = self._call(
            "/api/lapp/live/address/get",
            {
                "deviceSerial": device_serial,
                "channelNo": channel_no,
                "protocol": protocol,
                "quality": 1,  # HD
                # EZVIZ's default link lives ~30 s, which cuts players off at the next playlist reload.
                "expireTime": settings.EZVIZ_STREAM_EXPIRE_SEC,
            },
            timeout=12.0,
        )
        data = body.get("data") or {}
        if body.get("code") == "200" and data.get("url"):
            return StreamUrlResult(
                url=data["url"], protocol=protocol, channel_no=channel_no, expire_time=data.get("expireTime")
            )
        raise EZVIZError(f"Failed to get stream URL: [{body.get('code')}] {body.get('msg') or 'Unknown error'}")

    def capture_snapshot(self, device_serial: str, channel_no: int = 1) -> SnapshotResult:
        body = self._call("/api/lapp/device/capture", {"deviceSerial": device_serial, "channelNo": channel_no})
        data = body.get("data") or {}
        if body.get("code") == "200" and data.get("picUrl"):
            ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            return SnapshotResult(pic_url=data["picUrl"], timestamp=ts)
        raise EZVIZError(f"Failed to capture snapshot: [{body.get('code')}] {body.get('msg') or 'Unknown error'}")

    def get_connection_status(self, device_serial: str) -> tuple[bool, int]:
        """Returns (is_online, raw_status)."""
        device = self.get_device_info(device_serial)
        if not device:
            return False, 0
        return device.status == 1, device.status


ezviz_provider = EZVIZProvider()
