"""System B — Hybrid Attendance APIs."""

from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.orm import Session

from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import Employee, WorkSession, AttendanceEvent, AttendanceReview, User, UserRole
from app.security import current_user, require_role, json_body, AuthUser
from app.services import work_session as ws_service
from app.serialize import ser, ser_all

admin_only = require_role(UserRole.SUPER_ADMIN, UserRole.OFFICE_ADMIN, UserRole.HR_MANAGER)

router = APIRouter(prefix="/api/attendance", tags=["attendance"], dependencies=[Depends(current_user)])


@router.post("/check-in")
def employee_check_in(
    body: dict = Depends(json_body),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Explicit authorized employee check-in."""
    employee_id = body.get("employeeId")
    
    # If not specified, look for employee matching user email/code or fallback to first active for dev
    emp = None
    if employee_id:
        emp = db.get(Employee, employee_id)
    if not emp and user.email:
        emp = db.scalar(select(Employee).where(Employee.email == user.email))
    if not emp:
        # Default to first active employee
        emp = db.scalar(select(Employee).where(Employee.is_active.is_(True)))

    if not emp:
        raise ApiError(404, "No active employee profile associated with request.")

    idempotency_key = body.get("idempotencyKey")
    session, event = ws_service.check_in(
        db,
        employee=emp,
        actor_user=user,
        source="EMPLOYEE",
        idempotency_key=idempotency_key,
        reason=body.get("reason"),
    )
    db.commit()

    return {
        "success": True,
        "message": f"Successfully checked in {emp.full_name}",
        "data": {
            "session": ser(session),
            "event": ser(event),
        },
    }


@router.post("/check-out")
def employee_check_out(
    body: dict = Depends(json_body),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Explicit authorized employee check-out."""
    employee_id = body.get("employeeId")
    emp = None
    if employee_id:
        emp = db.get(Employee, employee_id)
    if not emp and user.email:
        emp = db.scalar(select(Employee).where(Employee.email == user.email))
    if not emp:
        emp = db.scalar(select(Employee).where(Employee.is_active.is_(True)))

    if not emp:
        raise ApiError(404, "No active employee profile associated with request.")

    idempotency_key = body.get("idempotencyKey")
    session, event = ws_service.check_out(
        db,
        employee=emp,
        actor_user=user,
        source="EMPLOYEE",
        idempotency_key=idempotency_key,
        reason=body.get("reason"),
    )
    db.commit()

    return {
        "success": True,
        "message": f"Successfully checked out {emp.full_name}",
        "data": {
            "session": ser(session),
            "event": ser(event),
        },
    }


@router.get("/me/today")
def me_today(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Return today's attendance status and open work session for the authenticated user."""
    emp = None
    if user.email:
        emp = db.scalar(select(Employee).where(Employee.email == user.email))
    if not emp:
        emp = db.scalar(select(Employee).where(Employee.is_active.is_(True)))

    if not emp:
        return {"success": True, "data": None}

    open_sess = ws_service.get_open_session(db, emp.id)
    recent_sess = ws_service.get_employee_sessions(db, emp.id, limit=5)

    return {
        "success": True,
        "data": {
            "employee": ser(emp),
            "openSession": ser(open_sess) if open_sess else None,
            "recentSessions": ser_all(recent_sess),
        },
    }


@router.get("/me/history")
def me_history(
    limit: int = 30,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Historical work sessions for current user."""
    emp = None
    if user.email:
        emp = db.scalar(select(Employee).where(Employee.email == user.email))
    if not emp:
        emp = db.scalar(select(Employee).where(Employee.is_active.is_(True)))

    if not emp:
        return {"success": True, "data": []}

    sessions = ws_service.get_employee_sessions(db, emp.id, limit=limit)
    return {"success": True, "data": ser_all(sessions)}


@router.get("/reviews")
def get_reviews(
    status: Optional[str] = None,
    user: AuthUser = Depends(admin_only),
    db: Session = Depends(get_db),
):
    """Administrator attendance exception review queue."""
    query = select(AttendanceReview).order_by(desc(AttendanceReview.created_at))
    if status:
        query = query.where(AttendanceReview.status == status)
    reviews = db.scalars(query).all()
    
    return {
        "success": True,
        "data": [
            {
                "id": r.id,
                "employeeId": r.employee_id,
                "employeeName": r.employee.full_name if r.employee else "Unknown",
                "sessionId": r.session_id,
                "issueType": r.issue_type,
                "description": r.description,
                "status": r.status,
                "resolution": r.resolution,
                "createdAt": r.created_at.isoformat(),
                "resolvedAt": r.resolved_at.isoformat() if r.resolved_at else None,
            }
            for r in reviews
        ],
    }


@router.post("/reviews/{review_id}/resolve")
def resolve_review(
    review_id: str,
    body: dict = Depends(json_body),
    user: AuthUser = Depends(admin_only),
    db: Session = Depends(get_db),
):
    """Resolve an attendance exception."""
    rev = db.get(AttendanceReview, review_id)
    if not rev:
        raise ApiError(404, "Review record not found")

    rev.status = body.get("status", "RESOLVED")
    rev.resolution = body.get("resolution", "Resolved by administrator")
    rev.resolved_by_id = user.id
    rev.resolved_at = utcnow()
    db.commit()

    return {"success": True, "data": ser(rev)}
