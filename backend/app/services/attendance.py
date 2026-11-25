"""Attendance rules shared by manual check-in/out and camera-based automatic attendance.

Conventions (unchanged from the original API):
- Times are stored as naive UTC.
- A record's `date` is the UTC calendar date.
- Lateness and early departure compare against the work schedule in the server's local time.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.services import settings_store
from app.models import AttendanceRecord, AttendanceStatus, Employee, RecognitionEvent, WorkSchedule


def _local(utc_naive: datetime) -> datetime:
    return utc_naive.replace(tzinfo=timezone.utc).astimezone()


def _schedule_time(local_dt: datetime, hhmm: str, extra_minutes: int = 0) -> datetime:
    hour, minute = (int(x) for x in hhmm.split(":"))
    return local_dt.replace(hour=hour, minute=0, second=0, microsecond=0) + timedelta(minutes=minute + extra_minutes)


def is_late(schedule: Optional[WorkSchedule], at_utc: datetime) -> bool:
    if not schedule:
        return False
    local = _local(at_utc)
    grace = 15 if schedule.grace_minutes is None else schedule.grace_minutes
    return local > _schedule_time(local, schedule.start_time, grace)


def is_early_departure(schedule: Optional[WorkSchedule], at_utc: datetime) -> bool:
    if not schedule:
        return False
    local = _local(at_utc)
    return local < _schedule_time(local, schedule.end_time)


def record_date(at_utc: datetime) -> str:
    return at_utc.date().isoformat()


def find_record(db: Session, employee_id: str, date: str) -> Optional[AttendanceRecord]:
    return db.scalar(
        select(AttendanceRecord).where(AttendanceRecord.employee_id == employee_id, AttendanceRecord.date == date)
    )


def check_in(db: Session, emp: Employee, at_utc: datetime, record: Optional[AttendanceRecord] = None) -> AttendanceRecord:
    """Create or fill today's record with a check-in. Caller commits."""
    record = record or find_record(db, emp.id, record_date(at_utc)) or AttendanceRecord(
        employee_id=emp.id, date=record_date(at_utc)
    )
    late = is_late(emp.work_schedule, at_utc)
    record.check_in = at_utc
    record.is_late = late
    record.status = AttendanceStatus.LATE if late else AttendanceStatus.PRESENT
    db.add(record)
    return record


def check_out(emp: Employee, record: AttendanceRecord, at_utc: datetime) -> AttendanceRecord:
    """Set check-out and worked minutes on a record that has a check-in. Caller commits."""
    record.check_out = at_utc
    record.total_minutes = max(0, round((at_utc - record.check_in).total_seconds() / 60))
    record.is_early_departure = is_early_departure(emp.work_schedule, at_utc)
    return record


def apply_recognition(
    db: Session,
    emp: Employee,
    seen_at: datetime,
    similarity: float,
    camera_id: Optional[str],
    channel_no: int,
) -> tuple[str, Optional[RecognitionEvent]]:
    """Turn a confirmed face match into attendance. Returns (action, stored event or None).

    - first sighting of the day                    -> CHECK_IN
    - sighting >= AUTO_CHECKOUT_MIN_GAP_MIN later  -> CHECK_OUT (check-out = last time seen)
    - otherwise                                     -> SEEN
    - repeat within RECOGNITION_DEDUP_SEC          -> DUPLICATE (not stored)
    """
    recent = db.scalar(
        select(RecognitionEvent.id).where(
            RecognitionEvent.employee_id == emp.id,
            RecognitionEvent.seen_at > seen_at - timedelta(seconds=settings_store.value("attendance", "recognitionDedupSec")),
            RecognitionEvent.seen_at <= seen_at + timedelta(seconds=settings_store.value("attendance", "recognitionDedupSec")),
        )
    )
    if recent:
        return "DUPLICATE", None

    record = find_record(db, emp.id, record_date(seen_at))
    if not emp.is_active:
        action = "IGNORED_INACTIVE"
    elif record is None or record.check_in is None:
        record = check_in(db, emp, seen_at, record)
        action = "CHECK_IN"
    elif seen_at < record.check_in:
        # Seen earlier than the recorded check-in (e.g. manual entry was late): move it back.
        record = check_in(db, emp, seen_at, record)
        if record.check_out:
            check_out(emp, record, record.check_out)
        action = "CHECK_IN"
    elif seen_at - record.check_in >= timedelta(minutes=settings_store.value("attendance", "autoCheckoutGapMin")) and (
        record.check_out is None or seen_at > record.check_out
    ):
        check_out(emp, record, seen_at)
        action = "CHECK_OUT"
    else:
        action = "SEEN"

    db.flush()
    event = RecognitionEvent(
        employee_id=emp.id,
        camera_id=camera_id,
        channel_no=channel_no,
        similarity=similarity,
        action=action,
        attendance_record_id=record.id if record else None,
        seen_at=seen_at,
    )
    db.add(event)
    return action, event
