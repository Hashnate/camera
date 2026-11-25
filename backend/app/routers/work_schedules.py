"""Work schedules (shift hours, grace periods, and working days) managed from Settings."""

import json
import re
from typing import Any, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import ApiError
from app.models import AuditLog, Employee, Office, WorkSchedule
from app.permissions import Perm
from app.security import AuthUser, current_user, json_body, require_perm
from app.serialize import ser

router = APIRouter(prefix="/api/work-schedules", tags=["work-schedules"], dependencies=[Depends(current_user)])

require_setup = require_perm(Perm.SETUP_MANAGE)

_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
_VALID_DAYS = {"1", "2", "3", "4", "5", "6", "7"}
_MAX_NAME_LEN = 100
_MAX_GRACE_MIN = 240


def _parse_time(raw: Any, label: str) -> tuple[int, str]:
    """Validate an HH:MM 24-hour string and return (minutes_since_midnight, normalized_hhmm)."""
    text = str(raw or "").strip()
    m = _TIME_RE.match(text)
    if not m:
        raise ApiError(400, f"{label} must be in HH:MM (24-hour) format")
    hour, minute = int(m.group(1)), int(m.group(2))
    return hour * 60 + minute, f"{hour:02d}:{minute:02d}"


def _parse_grace(raw: Any) -> int:
    """Validate graceMinutes as an integer in [0, 240]."""
    if isinstance(raw, bool):
        raise ApiError(400, "graceMinutes must be a whole number")
    try:
        num = float(raw)
    except (TypeError, ValueError):
        raise ApiError(400, "graceMinutes must be a whole number")
    if num != int(num):
        raise ApiError(400, "graceMinutes must be a whole number")
    minutes = int(num)
    if minutes < 0 or minutes > _MAX_GRACE_MIN:
        raise ApiError(400, f"graceMinutes must be between 0 and {_MAX_GRACE_MIN}")
    return minutes


def _parse_working_days(raw: Any) -> str:
    """Normalize working days (comma-separated string or list of 1..7) into sorted '1,2,...'."""
    if isinstance(raw, (list, tuple, set)):
        tokens = [str(x).strip() for x in raw if str(x).strip()]
    elif isinstance(raw, str):
        tokens = [t.strip() for t in raw.split(",") if t.strip()]
    else:
        raise ApiError(400, "workingDays must be a comma-separated list of weekdays (1-7)")

    if not tokens or any(t not in _VALID_DAYS for t in tokens):
        raise ApiError(400, "Choose at least one valid working day (1=Mon to 7=Sun)")
    return ",".join(sorted(set(tokens), key=int))


def _parse_name(raw: Any) -> str:
    name = str(raw or "").strip()
    if not name:
        raise ApiError(400, "Schedule name is required")
    if len(name) > _MAX_NAME_LEN:
        raise ApiError(400, f"Schedule name must be at most {_MAX_NAME_LEN} characters")
    return name


def _validate_range(start_raw: Any, end_raw: Any) -> tuple[str, str]:
    start_min, start_hhmm = _parse_time(start_raw, "startTime")
    end_min, end_hhmm = _parse_time(end_raw, "endTime")
    if end_min <= start_min:
        raise ApiError(400, "End time must be after start time")
    return start_hhmm, end_hhmm


def _resolve_office(db: Session, office_id: Optional[str]) -> Office:
    if office_id:
        office = db.get(Office, str(office_id))
        if not office:
            raise ApiError(404, "Office not found")
        return office
    office = db.scalar(select(Office).order_by(Office.created_at.asc()).limit(1))
    if not office:
        raise ApiError(400, "No office exists yet. Create the company and office first.")
    return office


def _ensure_unique_name(db: Session, office_id: str, name: str, exclude_id: Optional[str] = None) -> None:
    q = select(WorkSchedule.id).where(
        WorkSchedule.office_id == office_id,
        func.lower(WorkSchedule.name) == name.lower(),
    )
    if exclude_id:
        q = q.where(WorkSchedule.id != exclude_id)
    if db.scalar(q):
        raise ApiError(409, f"A work schedule named '{name}' already exists")


def _employee_counts(db: Session) -> dict[str, int]:
    rows = db.execute(
        select(Employee.work_schedule_id, func.count())
        .where(Employee.work_schedule_id.is_not(None))
        .group_by(Employee.work_schedule_id)
    ).all()
    return {ws_id: int(cnt) for ws_id, cnt in rows if ws_id}


def _schedule_json(ws: WorkSchedule, count: int) -> dict:
    return ser(ws, employeeCount=count)


def _audit(db: Session, actor_id: str, action: str, ws: WorkSchedule, **details) -> None:
    db.add(
        AuditLog(
            user_id=actor_id,
            action=action,
            entity_type="WorkSchedule",
            entity_id=ws.id,
            details=json.dumps({"name": ws.name, **details}),
        )
    )


@router.get("")
def list_work_schedules(user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    """List all work schedules with assigned employee counts."""
    schedules = db.scalars(select(WorkSchedule).order_by(WorkSchedule.name.asc())).all()
    counts = _employee_counts(db)
    return {
        "success": True,
        "canEdit": user.can(Perm.SETUP_MANAGE),
        "data": [_schedule_json(ws, counts.get(ws.id, 0)) for ws in schedules],
    }


@router.post("", dependencies=[Depends(require_setup)])
def create_work_schedule(
    body: dict = Depends(json_body),
    user: AuthUser = Depends(require_setup),
    db: Session = Depends(get_db),
):
    """Create a new work schedule for the office."""
    office = _resolve_office(db, body.get("officeId"))
    name = _parse_name(body.get("name"))
    _ensure_unique_name(db, office.id, name)
    start_time, end_time = _validate_range(body.get("startTime"), body.get("endTime"))
    grace = _parse_grace(15 if body.get("graceMinutes") is None else body.get("graceMinutes"))
    working_days = _parse_working_days("1,2,3,4,5" if body.get("workingDays") is None else body.get("workingDays"))

    ws = WorkSchedule(
        office_id=office.id,
        name=name,
        start_time=start_time,
        end_time=end_time,
        grace_minutes=grace,
        working_days=working_days,
    )
    db.add(ws)
    db.flush()
    _audit(
        db,
        user.id,
        "WORK_SCHEDULE_CREATED",
        ws,
        startTime=start_time,
        endTime=end_time,
        graceMinutes=grace,
        workingDays=working_days,
    )
    db.commit()
    db.refresh(ws)
    return JSONResponse({"success": True, "data": _schedule_json(ws, 0)}, status_code=201)


@router.patch("/{schedule_id}", dependencies=[Depends(require_setup)])
def update_work_schedule(
    schedule_id: str,
    body: dict = Depends(json_body),
    user: AuthUser = Depends(require_setup),
    db: Session = Depends(get_db),
):
    """Update an existing work schedule's name, shift hours, grace period, or working days."""
    ws = db.get(WorkSchedule, schedule_id)
    if not ws:
        raise ApiError(404, "Work schedule not found")

    if "name" in body:
        name = _parse_name(body["name"])
        _ensure_unique_name(db, ws.office_id, name, exclude_id=ws.id)
        ws.name = name

    if "startTime" in body or "endTime" in body:
        next_start = body["startTime"] if "startTime" in body else ws.start_time
        next_end = body["endTime"] if "endTime" in body else ws.end_time
        ws.start_time, ws.end_time = _validate_range(next_start, next_end)

    if "graceMinutes" in body:
        ws.grace_minutes = _parse_grace(body["graceMinutes"])

    if "workingDays" in body:
        ws.working_days = _parse_working_days(body["workingDays"])

    _audit(
        db,
        user.id,
        "WORK_SCHEDULE_UPDATED",
        ws,
        startTime=ws.start_time,
        endTime=ws.end_time,
        graceMinutes=ws.grace_minutes,
        workingDays=ws.working_days,
    )
    db.commit()
    db.refresh(ws)
    count = db.scalar(
        select(func.count()).select_from(Employee).where(Employee.work_schedule_id == ws.id)
    ) or 0
    return {"success": True, "data": _schedule_json(ws, int(count))}


@router.delete("/{schedule_id}", dependencies=[Depends(require_setup)])
def delete_work_schedule(
    schedule_id: str,
    user: AuthUser = Depends(require_setup),
    db: Session = Depends(get_db),
):
    """Delete a work schedule, clearing any employee assignments to flexible (none)."""
    ws = db.get(WorkSchedule, schedule_id)
    if not ws:
        raise ApiError(404, "Work schedule not found")

    result = db.execute(
        update(Employee).where(Employee.work_schedule_id == schedule_id).values(work_schedule_id=None)
    )
    unassigned = int(result.rowcount or 0)
    _audit(db, user.id, "WORK_SCHEDULE_DELETED", ws, unassignedEmployees=unassigned)
    db.delete(ws)
    db.commit()
    return {
        "success": True,
        "message": "Work schedule deleted",
        "unassignedEmployees": unassigned,
    }
