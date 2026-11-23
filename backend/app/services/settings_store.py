"""Settings changed from the dashboard (Settings page), stored in the database.

Every field has a built-in default (for the camera account, the old backend/.env values, so existing installs
keep working). Whatever is saved from the dashboard overrides the default. Secrets are encrypted at rest and are
never sent to the browser: the dashboard only learns whether one is set.

Reads are cached in memory; saving a section clears the cache, so changes apply straight away.
"""

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from app.config import settings
from app.crypto import decrypt_text, encrypt_text
from app.database import SessionLocal
from app.errors import ApiError

log = logging.getLogger("worksight.settings")


@dataclass(frozen=True)
class Field:
    kind: str  # int | float | str | url | secret | choice
    default: Any
    min: Optional[float] = None
    max: Optional[float] = None
    choices: tuple = ()
    allow_empty: bool = True


SCHEMA: dict[str, dict[str, Field]] = {
    # EZVIZ Open Platform account the cameras are registered to.
    "ezviz": {
        "appKey": Field("str", settings.EZVIZ_APP_KEY),
        "appSecret": Field("secret", settings.EZVIZ_APP_SECRET),
        "apiBaseUrl": Field("url", settings.EZVIZ_API_BASE_URL or "https://open.ezvizlife.com", allow_empty=False),
    },
    # Read by the AI service every ~30 s (see /api/internal/runtime-config).
    "recognition": {
        "matchThreshold": Field("float", 0.46, 0.30, 0.80),
        "matchMargin": Field("float", 0.08, 0.0, 0.30),
        "smallFaceEyePx": Field("int", 32, 0, 200),
        "smallFaceMatchThreshold": Field("float", 0.57, 0.30, 0.90),
        "confirmFrames": Field("int", 2, 1, 10),
        "confirmWindowSec": Field("int", 10, 2, 60),
        "reportCooldownSec": Field("int", 60, 10, 600),
        "minFaceSize": Field("int", 50, 20, 300),
        "frameSource": Field("choice", "auto", choices=("auto", "hls", "snapshot")),
    },
    "attendance": {
        # No sighting for longer than this = away. Office Time and Overview use it unless the viewer picks another.
        "awayAfterMin": Field("int", 2, 1, 120),
        # Minutes credited per stay so a single sighting isn't counted as zero time.
        "sightingCreditMin": Field("int", settings.SIGHTING_CREDIT_MIN, 0, 15),
        # A sighting this long after check-in moves the check-out time ("last seen").
        "autoCheckoutGapMin": Field("int", settings.AUTO_CHECKOUT_MIN_GAP_MIN, 1, 240),
        # Repeat sightings of the same person within this window are ignored.
        "recognitionDedupSec": Field("int", settings.RECOGNITION_DEDUP_SEC, 0, 600),
    },
    "enrollment": {
        # Address the QR code points at. "{lan_ip}" = this PC's current Wi-Fi address. Empty = plain http on the Wi-Fi IP.
        "mobileBaseUrl": Field("url", settings.MOBILE_ENROLL_BASE_URL),
        "mobileLinkTtlMin": Field("int", settings.MOBILE_ENROLL_TTL_MIN, 5, 120),
        "maxFaceSamples": Field("int", settings.MAX_FACE_SAMPLES, 3, 10),
    },
}

_CACHE_TTL_SEC = 30.0
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _section(name: str) -> dict[str, Field]:
    if name not in SCHEMA:
        raise ApiError(404, f"Unknown settings section: {name}")
    return SCHEMA[name]


def _stored(db: Session, name: str) -> dict:
    from app.models import SystemSetting  # local import: models import nothing from here, but keep startup light

    row = db.get(SystemSetting, name)
    return dict(row.value) if row and isinstance(row.value, dict) else {}


def get(name: str, db: Optional[Session] = None) -> dict:
    """Effective values for a section (saved values over defaults), secrets decrypted. For server-side use only."""
    fields = _section(name)
    now = time.monotonic()
    with _lock:
        hit = _cache.get(name)
        if hit and now - hit[0] < _CACHE_TTL_SEC:
            return dict(hit[1])
    own = db is None
    session = db or SessionLocal()
    try:
        stored = _stored(session, name)
    except Exception as exc:  # database down: fall back to defaults rather than breaking every request
        log.warning("[settings] could not read %s: %s", name, exc)
        stored = {}
    finally:
        if own:
            session.close()
    out = {}
    for key, f in fields.items():
        v = stored.get(key, f.default)
        if f.kind == "secret" and key in stored:
            try:
                v = decrypt_text(v) if v else ""
            except Exception:
                log.error("[settings] could not decrypt %s.%s (encryption key changed?)", name, key)
                v = ""
        out[key] = v
    with _lock:
        _cache[name] = (now, out)
    return dict(out)


def value(name: str, key: str) -> Any:
    return get(name)[key]


def public(name: str, db: Optional[Session] = None) -> dict:
    """What the dashboard may see: secrets are replaced by `<key>Set: true/false`."""
    fields = _section(name)
    stored = _stored(db, name) if db is not None else None
    eff = get(name, db)
    values, saved = {}, []
    for key, f in fields.items():
        if f.kind == "secret":
            values[key] = ""
            values[f"{key}Set"] = bool(eff[key])
        else:
            values[key] = eff[key]
        if stored is not None and key in stored:
            saved.append(key)
    defaults = {k: ("" if f.kind == "secret" else f.default) for k, f in fields.items()}
    return {"values": values, "defaults": defaults, "customised": saved}


def _clean(name: str, key: str, f: Field, raw: Any) -> Any:
    label = f"{name}.{key}"
    if f.kind in ("int", "float"):
        try:
            num = float(raw)
        except (TypeError, ValueError):
            raise ApiError(400, f"{label} must be a number")
        if f.kind == "int":
            if num != int(num):
                raise ApiError(400, f"{label} must be a whole number")
            num = int(num)
        if (f.min is not None and num < f.min) or (f.max is not None and num > f.max):
            raise ApiError(400, f"{label} must be between {f.min:g} and {f.max:g}")
        return num
    if f.kind == "choice":
        if raw not in f.choices:
            raise ApiError(400, f"{label} must be one of: {', '.join(f.choices)}")
        return raw
    text = "" if raw is None else str(raw).strip()
    if len(text) > 500:
        raise ApiError(400, f"{label} is too long")
    if f.kind == "url" and text:
        text = text.rstrip("/")
        parts = urlsplit(text.replace("{lan_ip}", "127.0.0.1"))
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ApiError(400, f"{label} must start with http:// or https://")
    if not text and not f.allow_empty:
        raise ApiError(400, f"{label} cannot be empty")
    return text


def save(db: Session, name: str, changes: dict, user_id: Optional[str]) -> dict:
    """Validate and store changes to one section. Unknown keys are rejected.

    Secrets: an empty or missing value keeps the current one; send `"<key>Clear": true` to remove it.
    A field set to null goes back to its default.
    """
    from app.models import SystemSetting

    fields = _section(name)
    allowed = set(fields) | {f"{k}Clear" for k, f in fields.items() if f.kind == "secret"}
    unknown = set(changes) - allowed
    if unknown:
        raise ApiError(400, f"Unknown setting(s): {', '.join(sorted(unknown))}")

    stored = _stored(db, name)
    for key, f in fields.items():
        if f.kind == "secret":
            if changes.get(f"{key}Clear"):
                stored[key] = ""
            elif changes.get(key):
                stored[key] = encrypt_text(_clean(name, key, f, changes[key]))
            continue
        if key not in changes:
            continue
        if changes[key] is None:
            stored.pop(key, None)
        else:
            stored[key] = _clean(name, key, f, changes[key])

    row = db.get(SystemSetting, name)
    if row is None:
        db.add(SystemSetting(key=name, value=stored, updated_by_id=user_id))
    else:
        row.value = stored  # new dict object so SQLAlchemy sees the change
        row.updated_by_id = user_id
    db.commit()
    invalidate(name)
    return public(name, db)


def invalidate(name: Optional[str] = None) -> None:
    with _lock:
        if name:
            _cache.pop(name, None)
        else:
            _cache.clear()
