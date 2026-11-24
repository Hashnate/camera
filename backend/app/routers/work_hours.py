"""Working hours inside the office, per day and per period, from camera face sightings.

`gapMin` (optional, 1-120) sets how long someone must go unseen before it counts as an away
period; it defaults to Settings > Attendance > "Count someone as away after".
"""

from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.services import settings_store
from app.database import get_db, today_utc
from app.errors import ApiError
from app.models import AttendanceRecord, Camera, Employee, RecognitionEvent
from app.security import current_user
from app.serialize import value
from app.services.presence import day_json, gap_minutes, load_presence, scheduled_minutes

router = APIRouter(prefix="/api/work-hours", tags=["work-hours"], dependencies=[Depends(current_user)])

MAX_RANGE_DAYS = 92
GapParam = Query(None, ge=1, le=120, description="Minutes unseen before it counts as away")


def _parse(d: str, name: str) -> date:
    try:
        return date.fromisoformat(d)
    except ValueError:
        raise ApiError(400, f"{name} must be YYYY-MM-DD")


def _active_employees(db: Session) -> list[Employee]:
    return db.scalars(select(Employee).where(Employee.is_active.is_(True)).order_by(Employee.full_name)).all()


def _settings(gap_min: Optional[int]) -> dict:
    return {
        "presenceGapMin": gap_minutes(gap_min),
        "defaultPresenceGapMin": settings_store.value("attendance", "awayAfterMin"),
        "sightingCreditMin": settings_store.value("attendance", "sightingCreditMin"),
        "recognitionDedupSec": settings_store.value("attendance", "recognitionDedupSec"),
    }


@router.get("/daily")
def daily(date: Optional[str] = None, gapMin: Optional[int] = GapParam, db: Session = Depends(get_db)):
    """One day: every active employee's time inside, away periods, sessions and current state."""
    day = (_parse(date, "date") if date else _parse(today_utc(), "date")).isoformat()
    presence = load_presence(db, day, day, gapMin)
    is_today = day == today_utc()
    rows = [day_json(emp, (presence.get(emp.id) or [None])[0], is_today, gapMin, day) for emp in _active_employees(db)]
    inside = [r["insideMinutes"] for r in rows if r["date"]]
    return {
        "success": True,
        "date": day,
        "today": today_utc(),
        "isToday": is_today,
        "settings": _settings(gapMin),
        "summary": {
            "employees": len(rows),
            "present": sum(1 for r in rows if r["date"]),
            "inOfficeNow": sum(1 for r in rows if r["state"] == "IN_OFFICE") if is_today else None,
            "totalInsideMinutes": sum(inside),
            "avgInsideMinutes": round(sum(inside) / len(inside)) if inside else 0,
        },
        "data": rows,
    }


@router.get("/summary")
def summary(startDate: str, endDate: str, gapMin: Optional[int] = GapParam, db: Session = Depends(get_db)):
    """Totals per employee over a date range, with a per-day breakdown (every day, every employee)."""
    start, end = _parse(startDate, "startDate"), _parse(endDate, "endDate")
    if end < start:
        raise ApiError(400, "endDate must be on or after startDate")
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        raise ApiError(400, f"Range is limited to {MAX_RANGE_DAYS} days")

    presence = load_presence(db, start.isoformat(), end.isoformat(), gapMin)
    dates = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]

    rows = []
    for emp in _active_employees(db):
        days = {d.record.date: d for d in presence.get(emp.id, []) if d.record.check_in}
        inside = {k: d.inside_minutes() for k, d in days.items()}
        span = {k: d.span_minutes() for k, d in days.items()}
        away = {k: round(d.away_seconds() / 60) for k, d in days.items()}
        sched = scheduled_minutes(emp.work_schedule)
        rows.append(
            {
                "employee": {
                    "id": emp.id,
                    "fullName": emp.full_name,
                    "employeeCode": emp.employee_code,
                    "department": emp.department.name if emp.department else None,
                },
                "daysPresent": len(days),
                "lateDays": sum(1 for d in days.values() if d.record.is_late),
                "totalInsideMinutes": sum(inside.values()),
                "totalAwayMinutes": sum(away.values()),
                "totalSpanMinutes": sum(span.values()),
                "avgInsideMinutes": round(sum(inside.values()) / len(days)) if days else 0,
                "scheduledMinutesPerDay": sched,
                "measuredDays": sum(1 for d in days.values() if d.measured),
                "days": [
                    {
                        "date": k,
                        "present": k in days,
                        "isLate": bool(days[k].record.is_late) if k in days else False,
                        "firstSeen": value(days[k].sessions[0][0]) if k in days and days[k].measured else None,
                        "lastSeen": value(days[k].last_seen) if k in days else None,
                        "insideMinutes": inside.get(k, 0),
                        "awayMinutes": away.get(k, 0),
                        "timesAway": len(days[k].away_periods()) if k in days else 0,
                        "spanMinutes": span.get(k, 0),
                    }
                    for k in dates
                ],
            }
        )
    return {
        "success": True,
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "today": today_utc(),
        "dates": dates,
        "settings": _settings(gapMin),
        "data": rows,
    }


@router.get("/{employee_id}/sightings")
def sightings(employee_id: str, date: Optional[str] = None, db: Session = Depends(get_db)):
    """Every camera sighting of one employee on one day (the raw log behind the totals)."""
    day = (_parse(date, "date") if date else _parse(today_utc(), "date")).isoformat()
    if not db.get(Employee, employee_id):
        raise ApiError(404, "Employee not found")
    record = db.scalar(
        select(AttendanceRecord).where(AttendanceRecord.employee_id == employee_id, AttendanceRecord.date == day)
    )
    if not record:
        return {"success": True, "date": day, "count": 0, "data": []}
    rows = db.execute(
        select(RecognitionEvent.seen_at, RecognitionEvent.action, RecognitionEvent.similarity, RecognitionEvent.channel_no, Camera.name)
        .join(Camera, Camera.id == RecognitionEvent.camera_id, isouter=True)
        .where(RecognitionEvent.attendance_record_id == record.id, RecognitionEvent.action != "IGNORED_INACTIVE")
        .order_by(RecognitionEvent.seen_at)
    ).all()
    data = [
        {"seenAt": value(t), "action": a, "similarity": round(s, 3), "channelNo": ch, "cameraName": cam}
        for t, a, s, ch, cam in rows
    ]
    return {"success": True, "date": day, "count": len(data), "data": data}
