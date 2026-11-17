"""System B — Hybrid Attendance & Work Session Service.

Manages transactional employee check-in, check-out, multi-session daily tracking,
immutable attendance event logs, idempotency, and administrator exception reviews.
Does NOT infer working hours from camera visibility.
"""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple, List
from sqlalchemy import select, and_, or_
from sqlalchemy.orm import Session

from app.database import utcnow
from app.errors import ApiError
from app.models import (
    Employee,
    WorkSession,
    AttendanceEvent,
    AttendanceReview,
    AuditLog,
    User,
    AttendanceRecord,
    AttendanceStatus,
)


def _gen_key() -> str:
    return str(uuid.uuid4())


def get_open_session(db: Session, employee_id: str) -> Optional[WorkSession]:
    """Find the single currently open work session for an employee."""
    return db.scalar(
        select(WorkSession).where(
            WorkSession.employee_id == employee_id,
            WorkSession.status == "OPEN",
        )
    )


def check_in(
    db: Session,
    employee: Employee,
    effective_at: Optional[datetime] = None,
    actor_user: Optional[User] = None,
    source: str = "EMPLOYEE",
    idempotency_key: Optional[str] = None,
    reason: Optional[str] = None,
) -> Tuple[WorkSession, AttendanceEvent]:
    """Execute transactional employee check-in."""
    now = effective_at or utcnow()
    key = idempotency_key or f"checkin-{employee.id}-{now.isoformat()}-{_gen_key()[:8]}"

    # 1. Check idempotency
    existing_event = db.scalar(select(AttendanceEvent).where(AttendanceEvent.idempotency_key == key))
    if existing_event and existing_event.session:
        return existing_event.session, existing_event

    # 2. Check for an already open work session
    active_session = get_open_session(db, employee.id)
    if active_session:
        raise ApiError(409, f"Employee {employee.full_name} already has an active open work session.")

    # 3. Create new WorkSession
    session = WorkSession(
        employee_id=employee.id,
        check_in_at=now,
        status="OPEN",
    )
    db.add(session)
    db.flush()

    # 4. Create immutable AttendanceEvent
    event = AttendanceEvent(
        idempotency_key=key,
        employee_id=employee.id,
        action="CHECK_IN",
        source=source,
        effective_at=now,
        recorded_at=utcnow(),
        actor_user_id=actor_user.id if actor_user else None,
        reason=reason,
        session_id=session.id,
    )
    db.add(event)

    # 5. Maintain legacy AttendanceRecord for backwards compatibility
    today_str = now.date().isoformat()
    record = db.scalar(select(AttendanceRecord).where(AttendanceRecord.employee_id == employee.id, AttendanceRecord.date == today_str))
    if not record:
        record = AttendanceRecord(employee_id=employee.id, date=today_str, check_in=now, status=AttendanceStatus.PRESENT)
        db.add(record)
    elif record.check_in is None:
        record.check_in = now
        record.status = AttendanceStatus.PRESENT

    # 6. Audit log
    db.add(
        AuditLog(
            user_id=actor_user.id if actor_user else None,
            action="ATTENDANCE_CHECK_IN",
            entity_type="WorkSession",
            entity_id=session.id,
            details=f"Employee {employee.full_name} checked in via {source}",
        )
    )
    db.flush()
    return session, event


def check_out(
    db: Session,
    employee: Employee,
    effective_at: Optional[datetime] = None,
    actor_user: Optional[User] = None,
    source: str = "EMPLOYEE",
    idempotency_key: Optional[str] = None,
    reason: Optional[str] = None,
) -> Tuple[WorkSession, AttendanceEvent]:
    """Execute transactional employee check-out."""
    now = effective_at or utcnow()
    key = idempotency_key or f"checkout-{employee.id}-{now.isoformat()}-{_gen_key()[:8]}"

    # 1. Check idempotency
    existing_event = db.scalar(select(AttendanceEvent).where(AttendanceEvent.idempotency_key == key))
    if existing_event and existing_event.session:
        return existing_event.session, existing_event

    # 2. Find open session
    active_session = get_open_session(db, employee.id)
    if not active_session:
        raise ApiError(404, f"No active open work session found for employee {employee.full_name}.")

    if now < active_session.check_in_at:
        raise ApiError(400, "Check-out time cannot be earlier than check-in time.")

    # 3. Close WorkSession
    active_session.check_out_at = now
    active_session.status = "CLOSED"

    # 4. Create immutable AttendanceEvent
    event = AttendanceEvent(
        idempotency_key=key,
        employee_id=employee.id,
        action="CHECK_OUT",
        source=source,
        effective_at=now,
        recorded_at=utcnow(),
        actor_user_id=actor_user.id if actor_user else None,
        reason=reason,
        session_id=active_session.id,
    )
    db.add(event)

    # 5. Maintain legacy AttendanceRecord
    today_str = now.date().isoformat()
    record = db.scalar(select(AttendanceRecord).where(AttendanceRecord.employee_id == employee.id, AttendanceRecord.date == today_str))
    if record:
        record.check_out = now
        if record.check_in:
            record.total_minutes = max(0, round((now - record.check_in).total_seconds() / 60))

    # 6. Audit log
    worked_min = round((now - active_session.check_in_at).total_seconds() / 60)
    db.add(
        AuditLog(
            user_id=actor_user.id if actor_user else None,
            action="ATTENDANCE_CHECK_OUT",
            entity_type="WorkSession",
            entity_id=active_session.id,
            details=f"Employee {employee.full_name} checked out via {source}. Duration: {worked_min} min.",
        )
    )
    db.flush()
    return active_session, event


def get_employee_sessions(db: Session, employee_id: str, limit: int = 30) -> List[WorkSession]:
    return list(
        db.scalars(
            select(WorkSession)
            .where(WorkSession.employee_id == employee_id)
            .order_by(WorkSession.check_in_at.desc())
            .limit(limit)
        ).all()
    )


def detect_and_create_reviews(db: Session, threshold_hours: int = 12) -> int:
    """Scan for open work sessions exceeding the threshold and generate reviews."""
    cutoff = utcnow() - timedelta(hours=threshold_hours)
    stale_sessions = db.scalars(
        select(WorkSession).where(
            WorkSession.status == "OPEN",
            WorkSession.check_in_at < cutoff,
        )
    ).all()

    created_count = 0
    for sess in stale_sessions:
        # Check if review already exists
        existing = db.scalar(
            select(AttendanceReview).where(
                AttendanceReview.session_id == sess.id,
                AttendanceReview.issue_type == "MISSING_CHECKOUT",
            )
        )
        if not existing:
            rev = AttendanceReview(
                employee_id=sess.employee_id,
                session_id=sess.id,
                issue_type="MISSING_CHECKOUT",
                description=f"Work session opened at {sess.check_in_at.isoformat()} exceeds {threshold_hours}h without checkout.",
                status="OPEN",
            )
            db.add(rev)
            created_count += 1
    db.flush()
    return created_count
