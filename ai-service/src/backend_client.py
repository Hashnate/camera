"""Calls from the AI service to the WorkSight backend's internal (service-key) API."""

import httpx

from config import settings


class BackendClient:
    def __init__(self) -> None:
        self._http = httpx.Client(
            base_url=settings.BACKEND_API_URL,
            headers={"X-Service-Key": settings.AI_SERVICE_KEY},
            timeout=15.0,
        )

    @staticmethod
    def _check(r: httpx.Response) -> dict:
        if r.is_error:
            try:
                msg = r.json().get("message") or r.text
            except ValueError:
                msg = r.text
            raise RuntimeError(f"Backend {r.status_code}: {msg[:300]}")
        return r.json()["data"]

    def _get(self, path: str, **params):
        return self._check(self._http.get(path, params=params))

    def gallery(self) -> list[dict]:
        return self._get("/internal/face-gallery")

    def cameras(self) -> list[dict]:
        return self._get("/internal/cameras")

    def stream_url(self, camera_id: str, channel_no: int) -> str:
        return self._get(f"/internal/cameras/{camera_id}/stream", channel=channel_no)["streamUrl"]

    def snapshot_bytes(self, camera_id: str, channel_no: int) -> bytes:
        pic_url = self._get(f"/internal/cameras/{camera_id}/snapshot", channel=channel_no)["picUrl"]
        r = httpx.get(pic_url, timeout=15.0)
        r.raise_for_status()
        return r.content

    def report_recognition(self, payload: dict) -> dict:
        return self._check(self._http.post("/internal/recognitions", json=payload))
