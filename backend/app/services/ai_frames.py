"""Pictures from cameras that the browser can't play directly (RTSP, USB, ...), via the AI service.

The AI service already holds the video open for every lens it watches, so a live preview is just its latest frame.
For a lens it isn't watching (or details being tested before saving), it opens the stream once and grabs a frame.
"""

import base64
from typing import Optional

import httpx

from app.config import settings
from app.errors import ApiError


def _headers() -> dict:
    return {"X-Service-Key": settings.AI_SERVICE_KEY}


def _fail(resp: httpx.Response) -> ApiError:
    try:
        detail = resp.json().get("detail")
    except ValueError:
        detail = resp.text[:200]
    return ApiError(502 if resp.status_code >= 500 else 400, str(detail or f"AI service error {resp.status_code}"))


def grab(source: dict, key: Optional[str] = None, timeout: float = 20.0) -> tuple[bytes, int, int]:
    """Picture from a source: (jpeg, width, height). With `key`, the AI service keeps the stream open for live
    previews; without, it opens it once (tests). Raises ApiError with a readable message."""
    try:
        resp = httpx.post(f"{settings.AI_SERVICE_URL}/grab-frame", json={"source": source, "key": key}, headers=_headers(), timeout=timeout)
    except httpx.HTTPError:
        raise ApiError(503, "The AI service is not running, so the camera can't be tested. Start the system and try again.")
    if resp.status_code != 200:
        raise _fail(resp)
    return resp.content, int(resp.headers.get("X-Frame-Width", 0)), int(resp.headers.get("X-Frame-Height", 0))


def latest(camera_id: str, channel_no: int) -> Optional[bytes]:
    """Most recent frame of a lens the AI service is watching, or None."""
    try:
        resp = httpx.get(f"{settings.AI_SERVICE_URL}/preview/{camera_id}/{channel_no}", headers=_headers(), timeout=5.0)
    except httpx.HTTPError:
        return None
    return resp.content if resp.status_code == 200 else None


def data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
