import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _f(name: str, default: float) -> float:
    return float(os.getenv(name, default))


class Settings:
    BACKEND_API_URL = os.getenv("BACKEND_API_URL", "http://localhost:5000/api").rstrip("/")
    # Shared secret for service-to-service calls (must equal AI_SERVICE_KEY in backend/.env).
    AI_SERVICE_KEY = os.getenv("AI_SERVICE_KEY", "")
    PORT = int(os.getenv("PORT", "8000"))

    # Background recognition worker
    ENABLE_WORKER = os.getenv("ENABLE_WORKER", "true").lower() in ("1", "true", "yes")
    # auto = live HLS stream, falling back to snapshots; or force "hls" / "snapshot".
    FRAME_SOURCE = os.getenv("FRAME_SOURCE", "auto").lower()
    # Dev/testing: read frames from a webcam ("webcam:0"), a video file, or a folder of images
    # instead of the EZVIZ camera. Recognitions are attributed to SOURCE_OVERRIDE_CAMERA_ID
    # (defaults to the first camera in the database).
    SOURCE_OVERRIDE = os.getenv("SOURCE_OVERRIDE", "")
    SOURCE_OVERRIDE_CAMERA_ID = os.getenv("SOURCE_OVERRIDE_CAMERA_ID", "")
    # Comma-separated channel numbers to watch, or "all".
    WATCH_CHANNELS = os.getenv("WATCH_CHANNELS", "all")

    FRAME_INTERVAL_SEC = _f("FRAME_INTERVAL_SEC", 0.08)  # analyse up to 12.5 frames/s from live video
    SNAPSHOT_INTERVAL_SEC = _f("SNAPSHOT_INTERVAL_SEC", 4.0)  # EZVIZ capture API is rate-limited
    HLS_RETRY_AFTER_SEC = _f("HLS_RETRY_AFTER_SEC", 300)  # after falling back to snapshots
    STREAM_URL_REFRESH_SEC = _f("STREAM_URL_REFRESH_SEC", 1800)

    MIN_FACE_SIZE = int(os.getenv("MIN_FACE_SIZE", "50"))  # pixels
    MATCH_THRESHOLD = _f("MATCH_THRESHOLD", 0.46)  # cosine similarity (strict SFace reference)
    MATCH_MARGIN = _f("MATCH_MARGIN", 0.08)  # best must beat other employees by this much (ambiguity guard)
    CONFIRM_FRAMES = int(os.getenv("CONFIRM_FRAMES", "2"))  # matches needed ...
    CONFIRM_WINDOW_SEC = _f("CONFIRM_WINDOW_SEC", 10)  # ... within this window
    REPORT_COOLDOWN_SEC = _f("REPORT_COOLDOWN_SEC", 60)  # per employee, avoid flooding the backend

    GALLERY_REFRESH_SEC = _f("GALLERY_REFRESH_SEC", 30)
    CAMERA_REFRESH_SEC = _f("CAMERA_REFRESH_SEC", 300)


settings = Settings()
