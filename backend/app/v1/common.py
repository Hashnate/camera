"""Shared pieces of the integration API: office time, dates, paging cursors, employee lookup and the audit trail."""

import base64
import json
import re
from datetime import date, datetime, timedelta
from typing import Callable, Optional

from sqlalchemy import func, select, tuple_
from sqlalchemy.orm import Session

from app.api_keys import ApiClient
from app.errors import ApiError
from app.models import AuditLog, Employee
from app.office_time import (  # noqa: F401  (re-exported for the v1 modules)
    OFFICE_TZ,
    iso,
    iso_ms,
    local_date,
    local_date_sql,
    office_time_utc,
    office_today,
    to_utc,
)

MAX_LIMIT = 500
CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")


def date_range(start: Optional[date], end: Optional[date], max_days: int) -> tuple[date, date]:
    if start is None or end is None:
        raise ApiError(400, "from and to are required (YYYY-MM-DD, office dates)")
    if end < start:
        raise ApiError(400, "to must be on or after from")
    if (end - start).days + 1 > max_days:
        raise ApiError(400, f"The range is limited to {max_days} days")
    return start, end


def days_between(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


# ---------------------------------------------------------------- paging
# Lists are ordered by (updatedAt, id) and paged with an opaque cursor, so a sync can resume exactly where it
# stopped and nothing is skipped or repeated while rows change between pages.


def encode_cursor(ts: datetime, row_id: str) -> str:
    raw = json.dumps([ts.isoformat(), row_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        ts, row_id = json.loads(base64.urlsafe_b64decode(padded))
        return datetime.fromisoformat(ts), str(row_id)
    except Exception:
        raise ApiError(400, "Invalid cursor: pass back the page.nextCursor value unchanged")


def keyset_page(db: Session, stmt, ts_col, id_col, key: Callable, limit: int, cursor: Optional[str]):
    """Run `stmt` one page at a time. Returns (rows, next cursor or None)."""
    if cursor:
        ts, row_id = decode_cursor(cursor)
        stmt = stmt.where(tuple_(ts_col, id_col) > tuple_(ts, row_id))
    rows = db.scalars(stmt.order_by(ts_col, id_col).limit(limit + 1)).unique().all()
    more = len(rows) > limit
    rows = rows[:limit]
    return rows, (encode_cursor(*key(rows[-1])) if more and rows else None)


def page_json(limit: int, next_cursor: Optional[str]) -> dict:
    return {"limit": limit, "nextCursor": next_cursor}


# ---------------------------------------------------------------- employees


def clean_code(code: str) -> str:
    code = (code or "").strip().upper()
    if not CODE_RE.match(code):
        raise ApiError(
            400,
            "employeeCode must be 1-40 characters: letters, digits, '.', '_' or '-', starting with a letter or digit",
        )
    return code


def find_employee(db: Session, code: str) -> Optional[Employee]:
    return db.scalar(select(Employee).where(func.upper(Employee.employee_code) == clean_code(code)))


def employee_or_404(db: Session, code: str) -> Employee:
    emp = find_employee(db, code)
    if emp is None:
        raise ApiError(404, f"No employee with code '{code}'")
    return emp


# ---------------------------------------------------------------- audit


def audit(db: Session, client: ApiClient, action: str, entity_type: str, entity_id: Optional[str], details: dict) -> None:
    """Record a change made through the API (no user: the key's name says who). Caller commits."""
    db.add(
        AuditLog(
            user_id=None,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=json.dumps({"apiKey": client.name, "apiKeyId": client.key_id, **details}, default=str),
            ip_address=client.ip,
        )
    )
