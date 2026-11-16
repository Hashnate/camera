"""Time actually spent inside the office, reconstructed from camera sightings.

The AI service reports each recognised employee about once a minute while they are
visible. Sightings closer together than PRESENCE_GAP_MIN are joined into one continuous
"inside" session; a longer gap counts as time away (lunch, meetings elsewhere, gone home).

    inside  = sum of session lengths (+ a small credit per session for the sighting itself)
    span    = first check-in -> last sighting (what the attendance ledger shows)
    away    = span - inside

This only measures what the camera can see: aim a lens at the work area (not only the door)
for meaningful "inside" figures. Records without camera sightings (manual check-ins) report
their check-in -> check-out span with measured=False.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import today_utc, utcnow
from app.models import AttendanceRecord, Employee, RecognitionEvent, WorkSchedule
from app.serialize import value


@dataclass
class DayPresence:
    record: AttendanceRecord
    sessions: list[tuple[datetime, datetime]] = field(default_factory=list)
    last_seen: Optional[datetime] = None
    # Manual check-in today with no check-out yet: count time up to now.
    open_until: Optional[datetime] = None

    @property
    def measured(self) -> bool:
        return bool(self.sessions)

    def inside_minutes(self) -> int:
        if self.measured:
            credit = timedelta(minutes=settings.SIGHTING_CREDIT_MIN)
            return round(sum(((e - s) + credit for s, e in self.sessions), timedelta()).total_seconds() / 60)
        return self.span_minutes()

    def span_minutes(self) -> int:
        start = self.record.check_in
        end = max(filter(None, [self.record.check_out, self.last_seen, self.open_until]), default=None)
        if not start or not end:
            return 0
        return max(0, round((end - start).total_seconds() / 60))


def scheduled_minutes(schedule: Optional[WorkSchedule]) -> Optional[int]:
    if not schedule:
        return None
    sh, sm = (int(x) for x in schedule.start_time.split(":"))
    eh, em = (int(x) for x in schedule.end_time.split(":"))
    return max(0, (eh * 60 + em) - (sh * 60 + sm))


def _sessions(times: list[datetime]) -> list[tuple[datetime, datetime]]:
    gap = timedelta(minutes=settings.PRESENCE_GAP_MIN)
    sessions: list[tuple[datetime, datetime]] = []
    for t in times:
        if sessions and t - sessions[-1][1] <= gap:
            sessions[-1] = (sessions[-1][0], t)
        else:
            sessions.append((t, t))
    return sessions


def load_presence(db: Session, start_date: str, end_date: str) -> dict[str, list[DayPresence]]:
    """Presence per employee for attendance dates in [start_date, end_date] (YYYY-MM-DD)."""
    records = db.scalars(
        select(AttendanceRecord).where(AttendanceRecord.date >= start_date, AttendanceRecord.date <= end_date)
    ).all()
    by_record = {r.id: DayPresence(record=r) for r in records}

    if by_record:
        times: dict[str, list[datetime]] = defaultdict(list)
        rows = db.execute(
            select(RecognitionEvent.attendance_record_id, RecognitionEvent.seen_at)
            .where(
                RecognitionEvent.attendance_record_id.in_(list(by_record)),
                RecognitionEvent.action != "IGNORED_INACTIVE",
            )
            .order_by(RecognitionEvent.seen_at)
        )
        for rec_id, seen_at in rows:
            times[rec_id].append(seen_at)
        for rec_id, ts in times.items():
            day = by_record[rec_id]
            day.sessions = _sessions(ts)
            day.last_seen = ts[-1]

    today, now = today_utc(), utcnow()
    for day in by_record.values():
        if day.record.date == today and not day.measured and day.record.check_in and not day.record.check_out:
            day.open_until = now

    out: dict[str, list[DayPresence]] = defaultdict(list)
    for day in by_record.values():
        out[day.record.employee_id].append(day)
    for days in out.values():
        days.sort(key=lambda d: d.record.date)
    return out


def current_state(day: Optional[DayPresence], is_today: bool) -> str:
    """IN_OFFICE (seen within the gap window), LEFT (was here today), or ABSENT."""
    if day is None or day.record.check_in is None:
        return "ABSENT"
    if not is_today:
        return "LEFT"
    if day.measured:
        recent = utcnow() - day.last_seen <= timedelta(minutes=settings.PRESENCE_GAP_MIN)
        return "IN_OFFICE" if recent else "LEFT"
    return "LEFT" if day.record.check_out else "IN_OFFICE"


def day_json(emp: Employee, day: Optional[DayPresence], is_today: bool) -> dict:
    sched = scheduled_minutes(emp.work_schedule)
    base = {
        "employee": {
            "id": emp.id,
            "fullName": emp.full_name,
            "employeeCode": emp.employee_code,
            "jobTitle": emp.job_title,
            "department": emp.department.name if emp.department else None,
        },
        "scheduledMinutes": sched,
        "state": current_state(day, is_today),
    }
    if day is None:
        return {**base, "date": None, "measured": False, "checkIn": None, "lastSeen": None,
                "insideMinutes": 0, "spanMinutes": 0, "awayMinutes": 0, "sessions": [], "isLate": False}
    inside, span = day.inside_minutes(), day.span_minutes()
    credit = timedelta(minutes=settings.SIGHTING_CREDIT_MIN)
    return {
        **base,
        "date": day.record.date,
        "measured": day.measured,
        "checkIn": value(day.record.check_in),
        "lastSeen": value(day.last_seen or day.record.check_out),
        "insideMinutes": inside,
        "spanMinutes": span,
        "awayMinutes": max(0, span - inside),
        "isLate": day.record.is_late,
        "sessions": [
            {"start": value(s), "end": value(e + credit), "minutes": round(((e - s) + credit).total_seconds() / 60)}
            for s, e in day.sessions
        ],
    }
