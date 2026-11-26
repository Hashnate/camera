"""Attendance, timesheets (time inside the office), who is in now, and manual check-in / check-out."""

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import AwareDatetime
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.api_keys import ApiClient, require_scope
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import AttendanceRecord, Employee, RecognitionEvent
from app.services import attendance as rules
from app.services.presence import DayPresence, current_state, gap_minutes, load_presence, scheduled_minutes
from app.v1 import schemas
from app.v1.common import (
    MAX_LIMIT,
    audit,
    date_range,
    days_between,
    employee_or_404,
    iso,
    iso_ms,
    keyset_page,
    local_date,
    local_date_sql,
    office_time_utc,
    office_today,
    page_json,
    to_utc,
)

router = APIRouter(tags=["Attendance"])

MAX_ATTENDANCE_DAYS = 366
MAX_TIMESHEET_DAYS = 92
MAX_BACKDATE = timedelta(days=31)
CLOCK_SKEW = timedelta(minutes=2)
AwayParam = Query(None, ge=1, le=120, description="Minutes unseen before it counts as away; default from WorkSight settings")

# The office date an attendance record belongs to: the local date of its check-in (stored dates are UTC dates).
_WORK_DATE = func.coalesce(local_date_sql(AttendanceRecord.check_in), AttendanceRecord.date)


def _camera_record_ids(db: Session, ids: list[str]) -> set[str]:
    """Records whose check-in came from the cameras."""
    if not ids:
        return set()
    return set(
        db.scalars(
            select(RecognitionEvent.attendance_record_id).where(
                RecognitionEvent.attendance_record_id.in_(ids), RecognitionEvent.action == "CHECK_IN"
            )
        )
    )


def attendance_json(rec: AttendanceRecord, from_camera: bool) -> dict:
    return {
        "id": rec.id,
        "employeeCode": rec.employee.employee_code,
        "employeeName": rec.employee.full_name,
        "date": local_date(rec.check_in) if rec.check_in else rec.date,
        "status": rec.status.value,
        "checkIn": iso(rec.check_in),
        "checkOut": iso(rec.check_out),
        "workedMinutes": rec.total_minutes,
        "isLate": rec.is_late,
        "isEarlyDeparture": rec.is_early_departure,
        "source": "CAMERA" if from_camera else "MANUAL",
        "updatedAt": iso_ms(rec.updated_at),
    }


@router.get("/attendance", response_model=schemas.AttendanceList, summary="List attendance records")
def list_attendance(
    from_: Optional[date] = Query(None, alias="from", description="First office date (YYYY-MM-DD)"),
    to: Optional[date] = Query(None, description="Last office date; default = from"),
    employeeCode: Optional[str] = Query(None),
    updatedSince: Optional[AwareDatetime] = Query(
        None, description="Only records changed at or after this time, for incremental sync"
    ),
    limit: int = Query(100, ge=1, le=MAX_LIMIT),
    cursor: Optional[str] = Query(None, description="page.nextCursor from the previous page"),
    _client: ApiClient = Depends(require_scope("attendance:read")),
    db: Session = Depends(get_db),
):
    """One record per employee per day they were present: check-in, check-out, late and early departure.
    Days with no record are days the employee wasn't seen. Give `from`/`to`, `updatedSince`, or both.

    Records keep changing during the day (camera check-out = last time seen) and after HR corrections, so sync
    with `updatedSince` and upsert on `id`."""
    if from_ is None and to is not None:
        raise ApiError(400, "to needs from")
    if from_ is None and updatedSince is None:
        raise ApiError(400, "Give from (and to), or updatedSince")

    stmt = select(AttendanceRecord).join(AttendanceRecord.employee).options(joinedload(AttendanceRecord.employee))
    if from_ is not None:
        start, end = date_range(from_, to or from_, MAX_ATTENDANCE_DAYS)
        stmt = stmt.where(_WORK_DATE >= start.isoformat(), _WORK_DATE <= end.isoformat())
    if employeeCode:
        stmt = stmt.where(AttendanceRecord.employee_id == employee_or_404(db, employeeCode).id)
    if updatedSince is not None:
        stmt = stmt.where(AttendanceRecord.updated_at >= to_utc(updatedSince))

    rows, nxt = keyset_page(
        db, stmt, AttendanceRecord.updated_at, AttendanceRecord.id, lambda r: (r.updated_at, r.id), limit, cursor
    )
    camera = _camera_record_ids(db, [r.id for r in rows])
    return {"success": True, "data": [attendance_json(r, r.id in camera) for r in rows], "page": page_json(limit, nxt)}


# ---------------------------------------------------------------- timesheets and who is in


def _by_office_date(days: list[DayPresence]) -> dict[str, list[DayPresence]]:
    """Presence grouped by the office date of each check-in (usually one record per date)."""
    out: dict[str, list[DayPresence]] = defaultdict(list)
    for d in days:
        if d.record.check_in:
            out[local_date(d.record.check_in)].append(d)
    for parts in out.values():
        parts.sort(key=lambda d: d.record.check_in)
    return out


def _end(d: DayPresence):
    return max(filter(None, [d.record.check_out, d.last_seen, d.open_until]), default=None)


def _day_json(emp: Employee, day: date, parts: list[DayPresence]) -> dict:
    ws = emp.work_schedule
    working = None
    if ws:
        working = str(day.isoweekday()) in {x.strip() for x in ws.working_days.split(",")}
    if not parts:
        return {
            "date": day.isoformat(), "isWorkingDay": working, "present": False, "checkIn": None, "lastSeen": None,
            "insideMinutes": 0, "awayMinutes": 0, "timesAway": 0, "spanMinutes": 0, "isLate": False,
            "lateByMinutes": 0, "isEarlyDeparture": False, "measured": False,
        }
    first, last = parts[0], parts[-1]
    check_in = first.record.check_in
    last_seen = max(filter(None, [p.last_seen or p.record.check_out for p in parts]), default=None)
    end = max(filter(None, [_end(p) for p in parts]), default=None)
    late_by = 0
    if first.record.is_late and ws:
        late_by = max(0, round((check_in - office_time_utc(day, ws.start_time)).total_seconds() / 60))
    return {
        "date": day.isoformat(),
        "isWorkingDay": working,
        "present": True,
        "checkIn": iso(check_in),
        "lastSeen": iso(last_seen),
        "insideMinutes": round(sum(p.inside_seconds() for p in parts) / 60),
        "awayMinutes": round(sum(p.away_seconds() for p in parts) / 60),
        "timesAway": sum(len(p.away_periods()) for p in parts),
        "spanMinutes": max(0, round((end - check_in).total_seconds() / 60)) if end else 0,
        "isLate": bool(first.record.is_late),
        "lateByMinutes": late_by,
        "isEarlyDeparture": bool(last.record.is_early_departure),
        "measured": any(p.measured for p in parts),
    }


@router.get("/timesheets", response_model=schemas.TimesheetList, summary="Timesheets: time inside per day")
def timesheets(
    from_: date = Query(alias="from", description="First office date (YYYY-MM-DD)"),
    to: date = Query(description="Last office date; at most 92 days after from"),
    employeeCode: Optional[str] = Query(None),
    awayAfterMin: Optional[int] = AwayParam,
    _client: ApiClient = Depends(require_scope("attendance:read")),
    db: Session = Depends(get_db),
):
    """For payroll: every employee, every date in the range, with the time they were actually inside the office
    (from camera sightings, away periods excluded) and totals. Includes inactive employees who were present in the
    range, so someone who left mid-month is still paid for the days they worked."""
    start, end = date_range(from_, to, MAX_TIMESHEET_DAYS)
    one = employee_or_404(db, employeeCode) if employeeCode else None
    # Stored dates are UTC dates; an office date can begin on the previous UTC date.
    presence = load_presence(db, (start - timedelta(days=1)).isoformat(), end.isoformat(), awayAfterMin,
                             employee_id=one.id if one else None)

    if one:
        emps = [one]
    else:
        present_ids = {emp_id for emp_id, days in presence.items() if days}
        emps = db.scalars(
            select(Employee)
            .options(joinedload(Employee.department), joinedload(Employee.work_schedule))
            .where(or_(Employee.is_active.is_(True), Employee.id.in_(present_ids)))
            .order_by(Employee.employee_code)
        ).unique().all()

    dates = days_between(start, end)
    data = []
    for emp in emps:
        by_date = _by_office_date(presence.get(emp.id, []))
        days = [_day_json(emp, d, by_date.get(d.isoformat(), [])) for d in dates]
        present = [d for d in days if d["present"]]
        data.append({
            "employeeCode": emp.employee_code,
            "fullName": emp.full_name,
            "department": emp.department.name if emp.department else None,
            "isActive": emp.is_active,
            "scheduledMinutesPerDay": scheduled_minutes(emp.work_schedule),
            "totals": {
                "daysPresent": len(present),
                "workingDays": sum(1 for d in days if d["isWorkingDay"]) if emp.work_schedule else None,
                "lateDays": sum(1 for d in present if d["isLate"]),
                "earlyDepartureDays": sum(1 for d in present if d["isEarlyDeparture"]),
                "insideMinutes": sum(d["insideMinutes"] for d in present),
                "awayMinutes": sum(d["awayMinutes"] for d in present),
                "spanMinutes": sum(d["spanMinutes"] for d in present),
            },
            "days": days,
        })
    return {"success": True, "from": start.isoformat(), "to": end.isoformat(),
            "awayAfterMin": gap_minutes(awayAfterMin), "data": data}


_STATE = {"IN_OFFICE": "IN_OFFICE", "LEFT": "AWAY", "ABSENT": "NOT_SEEN_TODAY"}


@router.get("/presence/now", response_model=schemas.PresenceNow, summary="Who is in the office now")
def presence_now(
    awayAfterMin: Optional[int] = AwayParam,
    _client: ApiClient = Depends(require_scope("attendance:read")),
    db: Session = Depends(get_db),
):
    """Every active employee's state right now. Poll it (e.g. once a minute) for a live board."""
    today = office_today()
    presence = load_presence(db, (today - timedelta(days=1)).isoformat(), today.isoformat(), awayAfterMin)
    emps = db.scalars(
        select(Employee).options(joinedload(Employee.department)).where(Employee.is_active.is_(True))
        .order_by(Employee.full_name)
    ).unique().all()
    data = []
    for emp in emps:
        parts = _by_office_date(presence.get(emp.id, [])).get(today.isoformat(), [])
        latest = parts[-1] if parts else None
        data.append({
            "employeeCode": emp.employee_code,
            "fullName": emp.full_name,
            "department": emp.department.name if emp.department else None,
            "state": _STATE[current_state(latest, True, awayAfterMin)],
            "checkIn": iso(parts[0].record.check_in) if parts else None,
            "lastSeen": iso(max(filter(None, [p.last_seen or p.record.check_out for p in parts]), default=None)),
            "insideMinutes": round(sum(p.inside_seconds() for p in parts) / 60),
        })
    count = lambda s: sum(1 for d in data if d["state"] == s)  # noqa: E731
    return {
        "success": True,
        "date": today.isoformat(),
        "asOf": iso(utcnow()),
        "awayAfterMin": gap_minutes(awayAfterMin),
        "summary": {"employees": len(data), "inOffice": count("IN_OFFICE"), "away": count("AWAY"),
                    "notSeenToday": count("NOT_SEEN_TODAY")},
        "data": data,
    }


# ---------------------------------------------------------------- manual check-in / check-out


def _when(at) -> datetime:
    now = utcnow()
    if at is None:
        return now
    when = to_utc(at)
    if when > now + CLOCK_SKEW:
        raise ApiError(400, "at can't be in the future")
    if when < now - MAX_BACKDATE:
        raise ApiError(400, "at can't be more than 31 days ago")
    return when


@router.post("/attendance/check-in", response_model=schemas.AttendanceOne, status_code=201, summary="Manual check-in")
def check_in(
    body: schemas.CheckIn,
    client: ApiClient = Depends(require_scope("attendance:write")),
    db: Session = Depends(get_db),
):
    """For people the cameras can't see (e.g. working off-site). Refused if they already checked in that day."""
    emp = employee_or_404(db, body.employeeCode)
    if not emp.is_active:
        raise ApiError(400, f"{emp.employee_code} is inactive")
    at = _when(body.at)
    record = rules.find_record(db, emp.id, rules.record_date(at))
    if record and record.check_in:
        raise ApiError(409, f"{emp.employee_code} already checked in at {iso(record.check_in)}",
                       data=attendance_json(record, bool(_camera_record_ids(db, [record.id]))))
    record = rules.check_in(db, emp, at, record)
    db.flush()
    audit(db, client, "API_CHECK_IN", "AttendanceRecord", record.id, {"employeeCode": emp.employee_code, "at": iso(at)})
    db.commit()
    db.refresh(record)
    return JSONResponse({"success": True, "data": attendance_json(record, False)}, status_code=201)


@router.post("/attendance/check-out", response_model=schemas.AttendanceOne, summary="Manual check-out")
def check_out(
    body: schemas.CheckOut,
    client: ApiClient = Depends(require_scope("attendance:write")),
    db: Session = Depends(get_db),
):
    """Closes the employee's latest check-in from the 24 hours before `at`. If the cameras see them again
    afterwards, the check-out moves to the time they were last seen."""
    emp = employee_or_404(db, body.employeeCode)
    at = _when(body.at)
    record = db.scalar(
        select(AttendanceRecord)
        .where(
            AttendanceRecord.employee_id == emp.id,
            AttendanceRecord.check_in.is_not(None),
            AttendanceRecord.check_in <= at,
            AttendanceRecord.check_in > at - timedelta(hours=24),
        )
        .order_by(AttendanceRecord.check_in.desc())
        .limit(1)
    )
    if record is None:
        raise ApiError(409, f"{emp.employee_code} has no check-in in the 24 hours before {iso(at)}")
    rules.check_out(emp, record, at)
    audit(db, client, "API_CHECK_OUT", "AttendanceRecord", record.id, {"employeeCode": emp.employee_code, "at": iso(at)})
    db.commit()
    db.refresh(record)
    return {"success": True, "data": attendance_json(record, bool(_camera_record_ids(db, [record.id])))}
