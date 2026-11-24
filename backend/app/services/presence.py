"""Time actually spent inside the office, reconstructed from camera sightings.

The AI service reports each recognised employee about once a minute while they are
visible. Sightings closer together than the gap (Settings > Attendance > awayAfterMin, or ?gapMin= per request)
are joined into one continuous "inside" session; a longer gap is an away period
(stepped outside, lunch, meeting elsewhere, gone home).

    away    = sum of away periods (last sighting before a gap -> first sighting after it)
    inside  = first -> last sighting, minus away, plus a small credit for the final sighting
    span    = check-in -> last sighting (what the attendance ledger shows)

This only measures what the camera can see: aim a lens at the work area (not only the door)
for meaningful "inside" figures. Records without camera sightings (manual check-ins) report
their check-in -> check-out span with measured=False.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, literal, select, text
from sqlalchemy.orm import Session

from app.services import settings_store
from app.database import today_utc, utcnow
from app.models import AttendanceRecord, Employee, PersonTrackSession, RecognitionEvent, TrackObservation, WorkSchedule
from app.serialize import value

# Body tracking: while a recognised person is followed as a body (face turned away, moved seats), the track
# counts as seen. It is sampled at this interval, well under the smallest "away after" gap (1 min).
TRACK_SAMPLE_SEC = 30
# A body track whose face evidence broke (persistent conflicting faces) is not trusted.
UNTRUSTED_TRACK_STATES = ("REQUIRES_REVERIFICATION",)


@dataclass
class DayPresence:
    record: AttendanceRecord
    sessions: list[tuple[datetime, datetime]] = field(default_factory=list)
    last_seen: Optional[datetime] = None
    sightings: int = 0
    # Manual check-in today with no check-out yet: count time up to now.
    open_until: Optional[datetime] = None

    @property
    def measured(self) -> bool:
        return bool(self.sessions)

    def away_periods(self) -> list[tuple[datetime, datetime]]:
        """Gaps between sessions: (last sighting before, first sighting after)."""
        return [(a[1], b[0]) for a, b in zip(self.sessions, self.sessions[1:])]

    def away_seconds(self) -> int:
        return round(sum((b - a).total_seconds() for a, b in self.away_periods()))

    def inside_seconds(self) -> int:
        if self.measured:
            first, last = self.sessions[0][0], self.sessions[-1][1]
            credit = settings_store.value("attendance", "sightingCreditMin") * 60
            return max(0, round((last - first).total_seconds()) - self.away_seconds() + credit)
        return self.span_minutes() * 60

    def inside_minutes(self) -> int:
        return round(self.inside_seconds() / 60)

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


def gap_minutes(gap_min: Optional[int] = None) -> int:
    return gap_min or settings_store.value("attendance", "awayAfterMin")


def _sessions(times: list[datetime], gap_min: Optional[int] = None) -> list[tuple[datetime, datetime]]:
    gap = timedelta(minutes=gap_minutes(gap_min))
    sessions: list[tuple[datetime, datetime]] = []
    for t in times:
        if sessions and t - sessions[-1][1] <= gap:
            sessions[-1] = (sessions[-1][0], t)
        else:
            sessions.append((t, t))
    return sessions


def load_presence(
    db: Session, start_date: str, end_date: str, gap_min: Optional[int] = None, employee_id: Optional[str] = None
) -> dict[str, list[DayPresence]]:
    """Presence per employee for attendance dates in [start_date, end_date] (YYYY-MM-DD); one employee if given."""
    q = select(AttendanceRecord).where(AttendanceRecord.date >= start_date, AttendanceRecord.date <= end_date)
    if employee_id:
        q = q.where(AttendanceRecord.employee_id == employee_id)
    records = db.scalars(q).all()
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
        face_counts = {rec_id: len(ts) for rec_id, ts in times.items()}

        # Named body tracks fill in the time between face sightings. Uses the track's actual position samples
        # (one every few seconds), one point per TRACK_SAMPLE_SEC bucket, so only time the body was really
        # observed counts: never a stretch between a track's start and end that it wasn't seen.
        rec_by_key = {(d.record.employee_id, d.record.date): rid for rid, d in by_record.items()}
        range_start = datetime.fromisoformat(start_date)
        range_end = datetime.fromisoformat(end_date) + timedelta(days=1)
        bucket = func.date_bin(text(f"interval '{TRACK_SAMPLE_SEC} seconds'"), TrackObservation.observed_at, literal(datetime(2000, 1, 1)))
        track_rows = db.execute(
            select(PersonTrackSession.employee_id, func.max(TrackObservation.observed_at))
            .join(PersonTrackSession, PersonTrackSession.id == TrackObservation.track_session_id)
            .where(
                PersonTrackSession.employee_id.in_({emp for emp, _ in rec_by_key}),
                PersonTrackSession.identity_state.not_in(UNTRUSTED_TRACK_STATES),
                TrackObservation.observed_at >= range_start,
                TrackObservation.observed_at < range_end,
            )
            .group_by(PersonTrackSession.employee_id, bucket)
        )
        for emp_id, t in track_rows:
            rec_id = rec_by_key.get((emp_id, t.date().isoformat()))  # same day key as record_date()
            if rec_id and rec_id in face_counts:
                times[rec_id].append(t)

        for rec_id, ts in times.items():
            ts.sort()
            day = by_record[rec_id]
            day.sessions = _sessions(ts, gap_min)
            day.last_seen = ts[-1]
            day.sightings = face_counts.get(rec_id, 0)

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


def current_state(day: Optional[DayPresence], is_today: bool, gap_min: Optional[int] = None) -> str:
    """IN_OFFICE (seen within the gap window), LEFT (was here today), or ABSENT."""
    if day is None or day.record.check_in is None:
        return "ABSENT"
    if not is_today:
        return "LEFT"
    if day.measured:
        recent = utcnow() - day.last_seen <= timedelta(minutes=gap_minutes(gap_min))
        return "IN_OFFICE" if recent else "LEFT"
    return "LEFT" if day.record.check_out else "IN_OFFICE"


def _local_to_utc(date_str: str, hhmm: str) -> datetime:
    """'2026-11-23' + '09:00' in the server's timezone (the office's) -> naive UTC."""
    local = datetime.fromisoformat(f"{date_str}T{hhmm}").astimezone()  # naive -> server local time
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def schedule_json(schedule: Optional[WorkSchedule], date_str: Optional[str]) -> Optional[dict]:
    """The employee's working hours on that date, as instants the browser can place on a timeline."""
    if not schedule or not date_str:
        return None
    return {
        "name": schedule.name,
        "start": schedule.start_time,
        "end": schedule.end_time,
        "graceMinutes": schedule.grace_minutes,
        "startAt": value(_local_to_utc(date_str, schedule.start_time)),
        "endAt": value(_local_to_utc(date_str, schedule.end_time)),
    }


def day_json(
    emp: Employee, day: Optional[DayPresence], is_today: bool, gap_min: Optional[int] = None, date: Optional[str] = None
) -> dict:
    sched = scheduled_minutes(emp.work_schedule)
    on_date = day.record.date if day else date
    base = {
        "employee": {
            "id": emp.id,
            "fullName": emp.full_name,
            "employeeCode": emp.employee_code,
            "jobTitle": emp.job_title,
            "department": emp.department.name if emp.department else None,
        },
        "scheduledMinutes": sched,
        "schedule": schedule_json(emp.work_schedule, on_date),
        "state": current_state(day, is_today, gap_min),
    }
    if day is None:
        return {**base, "date": None, "measured": False, "checkIn": None, "firstSeen": None, "lastSeen": None,
                "insideMinutes": 0, "insideSeconds": 0, "spanMinutes": 0, "awayMinutes": 0, "awaySeconds": 0,
                "sightings": 0, "sessions": [], "awayPeriods": [], "isLate": False, "lateByMinutes": 0,
                "longestAwaySeconds": 0}
    away = day.away_seconds()
    late_by = 0
    if day.record.is_late and day.record.check_in and emp.work_schedule:
        start_utc = _local_to_utc(day.record.date, emp.work_schedule.start_time)
        late_by = max(0, round((day.record.check_in - start_utc).total_seconds() / 60))
    periods = day.away_periods()
    return {
        **base,
        "date": day.record.date,
        "measured": day.measured,
        "checkIn": value(day.record.check_in),
        "firstSeen": value(day.sessions[0][0]) if day.measured else None,
        "lastSeen": value(day.last_seen or day.record.check_out),
        "insideMinutes": day.inside_minutes(),
        "insideSeconds": day.inside_seconds(),
        "spanMinutes": day.span_minutes(),
        "awayMinutes": round(away / 60),
        "awaySeconds": away,
        "sightings": day.sightings,
        "isLate": day.record.is_late,
        "lateByMinutes": late_by,
        "longestAwaySeconds": round(max(((b - a).total_seconds() for a, b in periods), default=0)),
        "sessions": [
            {"start": value(s), "end": value(e), "seconds": round((e - s).total_seconds())} for s, e in day.sessions
        ],
        "awayPeriods": [
            {"start": value(a), "end": value(b), "seconds": round((b - a).total_seconds())} for a, b in periods
        ],
    }
