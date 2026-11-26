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

# An arrival needs one face match at least this strong. Someone who isn't enrolled is matched to the closest enrolled
# colleague, weakly but again and again: on 26 Nov Sivathees, before his enrolment, matched Afham at 0.47-0.50 and
# checked Afham in while he was away. Every real arrival measured (23-26 Nov) reached 0.55 within 10 minutes.
CONFIRM_SIM = 0.55
CONFIRM_WINDOW = timedelta(minutes=20)  # how far back an arrival can be dated to the weaker sightings before it
UNCONFIRMED = "UNCONFIRMED"  # RecognitionEvent.action of a first sighting not yet confirmed (no attendance record)


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

    - first sighting of the day                    -> CHECK_IN, once a match reaches CONFIRM_SIM; weaker ones before
                                                      that are UNCONFIRMED (no record), and the check-in is dated
                                                      back to the first of an unbroken run of them
    - sighting >= AUTO_CHECKOUT_MIN_GAP_MIN later  -> CHECK_OUT (check-out = last time seen)
    - otherwise                                     -> SEEN
    - repeat within RECOGNITION_DEDUP_SEC          -> DUPLICATE (not stored)
    """
    dedup = timedelta(seconds=settings_store.value("attendance", "recognitionDedupSec"))
    recent_q = select(RecognitionEvent.id).where(
        RecognitionEvent.employee_id == emp.id,
        RecognitionEvent.seen_at > seen_at - dedup,
        RecognitionEvent.seen_at <= seen_at + dedup,
    )
    if similarity >= CONFIRM_SIM:  # a match that can confirm an arrival is never a repeat of an unconfirmed one
        recent_q = recent_q.where(RecognitionEvent.action != UNCONFIRMED)
    if db.scalar(recent_q):
        return "DUPLICATE", None

    record = find_record(db, emp.id, record_date(seen_at))
    if not emp.is_active:
        action = "IGNORED_INACTIVE"
    elif record is None or record.check_in is None:
        if similarity < CONFIRM_SIM:
            action = UNCONFIRMED
        else:
            earlier = _unconfirmed_run(db, emp.id, seen_at)
            record = check_in(db, emp, earlier[-1].seen_at if earlier else seen_at, record)
            db.flush()
            for ev in earlier:  # they were this person after all: count them
                ev.attendance_record_id = record.id
                ev.action = "SEEN"
            if earlier:
                earlier[-1].action = "CHECK_IN"
            action = "SEEN" if earlier else "CHECK_IN"
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
        attendance_record_id=record.id if record and action != UNCONFIRMED else None,
        seen_at=seen_at,
    )
    db.add(event)
    return action, event


def _unconfirmed_run(db: Session, employee_id: str, seen_at: datetime) -> list[RecognitionEvent]:
    """This person's UNCONFIRMED sightings leading up to seen_at, newest first: within CONFIRM_WINDOW, on the same
    day, and none more than the "away after" gap from the next, so an unrelated weak match earlier is left out."""
    gap = timedelta(minutes=settings_store.value("attendance", "awayAfterMin"))
    rows = db.scalars(
        select(RecognitionEvent)
        .where(
            RecognitionEvent.employee_id == employee_id,
            RecognitionEvent.action == UNCONFIRMED,
            RecognitionEvent.seen_at >= seen_at - CONFIRM_WINDOW,
            RecognitionEvent.seen_at < seen_at,
        )
        .order_by(RecognitionEvent.seen_at.desc())
    ).all()
    run, last = [], seen_at
    for ev in rows:
        if last - ev.seen_at > gap or record_date(ev.seen_at) != record_date(seen_at):
            break
        run.append(ev)
        last = ev.seen_at
    return run
