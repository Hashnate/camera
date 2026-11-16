"""Working hours inside the office, per day and per period."""

from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, today_utc
from app.errors import ApiError
from app.models import Employee
from app.security import current_user
from app.services.presence import day_json, load_presence, scheduled_minutes

router = APIRouter(prefix="/api/work-hours", tags=["work-hours"], dependencies=[Depends(current_user)])

MAX_RANGE_DAYS = 92


def _parse(d: str, name: str) -> date:
    try:
        return date.fromisoformat(d)
    except ValueError:
        raise ApiError(400, f"{name} must be YYYY-MM-DD")


def _active_employees(db: Session) -> list[Employee]:
    return db.scalars(select(Employee).where(Employee.is_active.is_(True)).order_by(Employee.full_name)).all()


def _settings() -> dict:
    return {"presenceGapMin": settings.PRESENCE_GAP_MIN, "sightingCreditMin": settings.SIGHTING_CREDIT_MIN}


@router.get("/daily")
def daily(date: Optional[str] = None, db: Session = Depends(get_db)):
    """One day: each active employee's time inside, away, sessions and current state."""
    day = (_parse(date, "date") if date else _parse(today_utc(), "date")).isoformat()
    presence = load_presence(db, day, day)
    is_today = day == today_utc()
    rows = [day_json(emp, (presence.get(emp.id) or [None])[0], is_today) for emp in _active_employees(db)]
    inside = [r["insideMinutes"] for r in rows if r["date"]]
    return {
        "success": True,
        "date": day,
        "isToday": is_today,
        "settings": _settings(),
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
def summary(startDate: str, endDate: str, db: Session = Depends(get_db)):
    """Totals per employee over a date range, with a per-day breakdown."""
    start, end = _parse(startDate, "startDate"), _parse(endDate, "endDate")
    if end < start:
        raise ApiError(400, "endDate must be on or after startDate")
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        raise ApiError(400, f"Range is limited to {MAX_RANGE_DAYS} days")

    presence = load_presence(db, start.isoformat(), end.isoformat())
    dates = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]

    rows = []
    for emp in _active_employees(db):
        days = {d.record.date: d for d in presence.get(emp.id, []) if d.record.check_in}
        inside = {k: d.inside_minutes() for k, d in days.items()}
        span = {k: d.span_minutes() for k, d in days.items()}
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
                "totalSpanMinutes": sum(span.values()),
                "avgInsideMinutes": round(sum(inside.values()) / len(days)) if days else 0,
                "scheduledMinutesPerDay": sched,
                "measuredDays": sum(1 for d in days.values() if d.measured),
                "days": [{"date": k, "insideMinutes": inside.get(k, 0), "spanMinutes": span.get(k, 0)} for k in dates],
            }
        )
    return {
        "success": True,
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "dates": dates,
        "settings": _settings(),
        "data": rows,
    }
