import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from dotenv import load_dotenv

# Finds backend/.env by searching upward from this file, so the working directory doesn't matter.
load_dotenv()


def _sqlalchemy_url(url: str) -> str:
    """Convert a Prisma-style DATABASE_URL into one SQLAlchemy/psycopg accepts.

    Prisma URLs look like postgresql://user:pass@host:5432/db?schema=public.
    `schema` is Prisma-only, so it is dropped (public is the default search path anyway).
    """
    if not url:
        return url
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k != "schema"]
    scheme = parts.scheme
    if scheme in ("postgresql", "postgres"):
        scheme = "postgresql+psycopg"
    return urlunsplit((scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


class Settings:
    PORT: int = int(os.getenv("PORT", "5000"))
    APP_ENV: str = os.getenv("APP_ENV") or os.getenv("NODE_ENV") or "development"
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")
    SQLALCHEMY_URL: str = _sqlalchemy_url(DATABASE_URL)
    JWT_SECRET: str = os.getenv("JWT_SECRET", "worksight_default_secret_key_change_in_production")
    JWT_EXPIRES_DAYS: int = 7

    # EZVIZ Open Platform. Set from the dashboard (Settings > Camera account); these .env values are only the
    # defaults used until something is saved there.
    EZVIZ_APP_KEY: str = os.getenv("EZVIZ_APP_KEY", "")
    EZVIZ_APP_SECRET: str = os.getenv("EZVIZ_APP_SECRET", "")
    EZVIZ_ACCESS_TOKEN: str = os.getenv("EZVIZ_ACCESS_TOKEN", "")
    EZVIZ_API_BASE_URL: str = os.getenv("EZVIZ_API_BASE_URL", "https://open.ezvizlife.com")
    EZVIZ_DEVICE_SERIAL: str = os.getenv("EZVIZ_DEVICE_SERIAL", "")
    EZVIZ_STREAM_EXPIRE_SEC: int = int(os.getenv("EZVIZ_STREAM_EXPIRE_SEC", "7200"))  # live-stream link lifetime

    FRONTEND_URL: str = os.getenv("FRONTEND_URL", "http://localhost:3000")
    # The office's timezone (IANA name). The integration API (/api/v1) gives every time in it, with its offset.
    # Same as the server's TZ, which the rest of the app already uses for work schedules.
    OFFICE_TZ: str = os.getenv("OFFICE_TZ") or os.getenv("TZ") or "Asia/Colombo"

    # AI face-recognition service (automatic attendance)
    AI_SERVICE_URL: str = os.getenv("AI_SERVICE_URL", "http://127.0.0.1:8000").rstrip("/")
    # Shared secret the AI service sends as X-Service-Key; internal endpoints are disabled if empty.
    AI_SERVICE_KEY: str = os.getenv("AI_SERVICE_KEY", "")
    # From here on, values are defaults: Settings > Attendance / Phone enrolment in the dashboard override them.
    # A sighting this long after check-in updates the check-out time ("last seen").
    AUTO_CHECKOUT_MIN_GAP_MIN: int = int(os.getenv("AUTO_CHECKOUT_MIN_GAP_MIN", "30"))
    # Repeat sightings of the same employee within this window are ignored.
    RECOGNITION_DEDUP_SEC: int = int(os.getenv("RECOGNITION_DEDUP_SEC", "60"))
    MAX_FACE_SAMPLES: int = int(os.getenv("MAX_FACE_SAMPLES", "5"))
    # Phone self-enrolment (QR code): how long a link stays valid.
    MOBILE_ENROLL_TTL_MIN: int = int(os.getenv("MOBILE_ENROLL_TTL_MIN", "15"))
    # Base URL the QR code points at, e.g. "https://worksight.example.com" or "https://{lan_ip}:3443"
    # ({lan_ip} = this PC's current Wi-Fi IP; see frontend/scripts/lan-https.mjs). Empty = plain http on the Wi-Fi IP.
    MOBILE_ENROLL_BASE_URL: str = os.getenv("MOBILE_ENROLL_BASE_URL", "").rstrip("/")
    # Minutes credited per stay so a single sighting isn't counted as zero time.
    SIGHTING_CREDIT_MIN: int = int(os.getenv("SIGHTING_CREDIT_MIN", "1"))

    @property
    def is_production(self) -> bool:
        return self.APP_ENV == "production"


settings = Settings()
