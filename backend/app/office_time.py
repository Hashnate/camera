"""Office time: the database stores naive UTC; the integration API and webhooks speak office time with its offset."""

from datetime import date, datetime, time, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import func

from app.config import settings
from app.errors import ApiError

OFFICE_TZ = ZoneInfo(settings.OFFICE_TZ)


def iso(dt: Optional[datetime]) -> Optional[str]:
    """Naive UTC -> '2026-11-26T09:02:00+05:30'."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(OFFICE_TZ).isoformat(timespec="seconds")


def iso_ms(dt: Optional[datetime]) -> Optional[str]:
    """Like iso() with milliseconds: for updatedAt, which callers pass back as updatedSince."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(OFFICE_TZ).isoformat(timespec="milliseconds")


def to_utc(dt: datetime) -> datetime:
    """A time from a caller -> naive UTC. Times without an offset are refused: they'd be ambiguous."""
    if dt.tzinfo is None:
        raise ApiError(400, f"Time '{dt.isoformat()}' needs a UTC offset, e.g. 2026-11-26T09:00:00+05:30")
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def local_date(dt_utc: datetime) -> str:
    """The office calendar date of a naive-UTC instant."""
    return dt_utc.replace(tzinfo=timezone.utc).astimezone(OFFICE_TZ).date().isoformat()


def local_date_sql(col):
    """SQL for local_date() of a naive-UTC timestamp column, as 'YYYY-MM-DD'."""
    return func.to_char(func.timezone(settings.OFFICE_TZ, func.timezone("UTC", col)), "YYYY-MM-DD")


def office_today() -> date:
    return datetime.now(OFFICE_TZ).date()


def office_time_utc(day: date, hhmm: str) -> datetime:
    """'09:00' on an office date -> naive UTC."""
    hour, minute = (int(x) for x in hhmm.split(":"))
    local = datetime.combine(day, time(hour, minute), tzinfo=OFFICE_TZ)
    return local.astimezone(timezone.utc).replace(tzinfo=None)
