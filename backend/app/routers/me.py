"""The signed-in person's own records ("My time"). Always scoped to the employee linked to the login,
so an Employee account can never read anyone else's data."""

from datetime import date as date_cls, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db, today_utc
from app.errors import ApiError
from app.models import Employee
from app.security import AuthUser, current_user
from app.services import settings_store
from app.services.presence import day_json, load_presence

router = APIRouter(prefix="/api/me", tags=["me"])


def _my_employee(me: AuthUser, db: Session) -> Employee:
    emp = db.get(Employee, me.employee_id) if me.employee_id else None
    if emp is None:
        raise ApiError(404, "Your login isn't linked to an employee record yet. Ask your admin.", code="NO_EMPLOYEE_LINK")
    return emp


def _parse(d: Optional[str]) -> str:
    if not d:
        return today_utc()
    try:
        return date_cls.fromisoformat(d).isoformat()
    except ValueError:
        raise ApiError(400, "date must be YYYY-MM-DD")


@router.get("/office-time")
def my_office_time(
    date: Optional[str] = None,
    days: int = Query(14, ge=1, le=62),
    me: AuthUser = Depends(current_user),
    db: Session = Depends(get_db),
):
    """One day in detail (time inside, away periods, sessions) plus a short history ending on that day."""
    emp = _my_employee(me, db)
    day = _parse(date)
    end = date_cls.fromisoformat(day)
    start = end - timedelta(days=days - 1)
    gap = settings_store.value("attendance", "awayAfterMin")
    presence = {d.record.date: d for d in load_presence(db, start.isoformat(), day, gap, employee_id=emp.id).get(emp.id, [])}
    today = today_utc()
    history = []
    for i in range(days):
        k = (end - timedelta(days=i)).isoformat()
        d = presence.get(k)
        present = bool(d and d.record.check_in)
        history.append({
            "date": k,
            "present": present,
            "isLate": bool(d.record.is_late) if present else False,
            "insideMinutes": d.inside_minutes() if present else 0,
            "awayMinutes": round(d.away_seconds() / 60) if present else 0,
            "timesAway": len(d.away_periods()) if present else 0,
            "firstSeen": day_json(emp, d, k == today, gap)["firstSeen"] if present else None,
            "lastSeen": day_json(emp, d, k == today, gap)["lastSeen"] if present else None,
        })
    present_days = [h for h in history if h["present"]]
    return {
        "success": True,
        "date": day,
        "today": today,
        "isToday": day == today,
        "awayAfterMin": gap,
        "day": day_json(emp, presence.get(day), day == today, gap),
        "history": history,
        "summary": {
            "days": days,
            "daysPresent": len(present_days),
            "lateDays": sum(1 for h in present_days if h["isLate"]),
            "totalInsideMinutes": sum(h["insideMinutes"] for h in present_days),
            "avgInsideMinutes": round(sum(h["insideMinutes"] for h in present_days) / len(present_days)) if present_days else 0,
        },
    }
