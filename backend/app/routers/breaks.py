"""WorkSight v2.8 — Break & Away-Time Engine REST Router."""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, Query, Path
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.orm import Session, joinedload

from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import (
    BreakPolicy,
    BreakInterval,
    BreakCorrectionAudit,
    Employee,
    DailyTrackingSession,
    Company,
)
from app.security import AuthUser, current_user
from app.services.break_engine import BreakEngineService
from app.services.daily_tracking_engine import to_colombo_date_str, format_duration

router = APIRouter(prefix="/api/breaks", tags=["breaks"])


# ------------------------------------------------------------- Schemas (support both camelCase & snake_case)


class PolicyUpsertSchema(BaseModel):
    id: Optional[str] = None
    company_id: Optional[str] = None
    companyId: Optional[str] = None
    employee_id: Optional[str] = None
    employeeId: Optional[str] = None
    break_type: Optional[str] = None
    breakType: Optional[str] = None
    name: str
    allowed_duration_minutes: Optional[int] = Field(None, ge=1, le=480)
    allowedDurationMinutes: Optional[int] = Field(None, ge=1, le=480)
    is_paid: Optional[bool] = None
    isPaid: Optional[bool] = None
    max_count_per_day: Optional[int] = Field(None, ge=1, le=10)
    maxCountPerDay: Optional[int] = Field(None, ge=1, le=10)
    notes: Optional[str] = None

    def resolve_break_type(self) -> str:
        val = self.break_type or self.breakType
        if not val:
            raise ApiError(400, "break_type is required.")
        return val.upper()

    def resolve_allowed_duration(self) -> int:
        val = self.allowed_duration_minutes if self.allowed_duration_minutes is not None else self.allowedDurationMinutes
        if val is None:
            raise ApiError(400, "allowed_duration_minutes is required.")
        return int(val)

    def resolve_is_paid(self) -> bool:
        if self.is_paid is not None:
            return self.is_paid
        if self.isPaid is not None:
            return self.isPaid
        return False

    def resolve_max_count(self) -> int:
        if self.max_count_per_day is not None:
            return self.max_count_per_day
        if self.maxCountPerDay is not None:
            return self.maxCountPerDay
        return 1

    def resolve_employee_id(self) -> Optional[str]:
        return self.employee_id or self.employeeId

    def resolve_company_id(self) -> Optional[str]:
        return self.company_id or self.companyId


class BreakDeclareSchema(BaseModel):
    employee_id: Optional[str] = None
    employeeId: Optional[str] = None
    break_type: Optional[str] = None
    breakType: Optional[str] = None
    duration_minutes: Optional[int] = Field(None, ge=1, le=240)
    durationMinutes: Optional[int] = Field(None, ge=1, le=240)
    started_at: Optional[datetime] = None
    startedAt: Optional[datetime] = None
    notes: Optional[str] = None

    def resolve_employee_id(self) -> str:
        val = self.employee_id or self.employeeId
        if not val:
            raise ApiError(400, "employee_id is required.")
        return val

    def resolve_break_type(self) -> str:
        val = self.break_type or self.breakType
        if not val:
            raise ApiError(400, "break_type is required.")
        return val.upper()

    def resolve_duration_minutes(self) -> int:
        val = self.duration_minutes if self.duration_minutes is not None else self.durationMinutes
        if val is None:
            raise ApiError(400, "duration_minutes is required.")
        return int(val)


class BreakCorrectSchema(BaseModel):
    new_duration_seconds: Optional[int] = Field(None, ge=0)
    newDurationSeconds: Optional[int] = Field(None, ge=0)
    new_classification: Optional[str] = None
    newClassification: Optional[str] = None
    reason: str = Field(..., min_length=5, description="Mandatory audit explanation")

    def resolve_duration_seconds(self) -> Optional[int]:
        if self.new_duration_seconds is not None:
            return self.new_duration_seconds
        return self.newDurationSeconds

    def resolve_classification(self) -> Optional[str]:
        return self.new_classification or self.newClassification


# ------------------------------------------------------------- Endpoints


@router.get("/live")
def get_live_breaks(
    date: Optional[str] = Query(None, description="Local date YYYY-MM-DD"),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Return real-time live break board for all registered active employees."""
    target_date = date or to_colombo_date_str()
    data = BreakEngineService.get_live_breaks_board(db, target_date)
    return {
        "success": True,
        "date": target_date,
        "count": len(data),
        "data": data,
    }


@router.get("/policies")
def get_break_policies(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Return all configured active break policies without auto-seeding deleted ones."""
    company_id = user.company_id
    if not company_id:
        comp = db.scalar(select(Company))
        company_id = comp.id if comp else None

    query = select(BreakPolicy).where(BreakPolicy.is_active == True)
    if company_id:
        query = query.where(BreakPolicy.company_id == company_id)

    policies = db.scalars(query.order_by(BreakPolicy.break_type)).all()

    # Initial first-run seed ONLY if total count in company is 0 ever
    if not policies and company_id:
        total_ever = db.scalar(
            select(func.count()).select_from(BreakPolicy).where(BreakPolicy.company_id == company_id)
        )
        if total_ever == 0:
            policies = BreakEngineService.ensure_default_policies(db, company_id)

    return {
        "success": True,
        "count": len(policies),
        "data": [
            {
                "id": p.id,
                "companyId": p.company_id,
                "employeeId": p.employee_id,
                "breakType": p.break_type,
                "name": p.name,
                "allowedDurationMinutes": p.allowed_duration_minutes,
                "isPaid": p.is_paid,
                "maxCountPerDay": p.max_count_per_day,
                "effectiveFrom": p.effective_from.isoformat() if p.effective_from else None,
                "isActive": p.is_active,
                "notes": p.notes,
            }
            for p in policies
        ],
    }


@router.post("/policies")
def upsert_break_policy(
    payload: PolicyUpsertSchema,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Create or update break policy configuration."""
    company_id = payload.resolve_company_id() or user.company_id
    if not company_id:
        comp = db.scalar(select(Company))
        company_id = comp.id if comp else None

    if not company_id:
        raise ApiError(400, "Company identifier is required.")

    break_type = payload.resolve_break_type()
    allowed_duration = payload.resolve_allowed_duration()
    is_paid = payload.resolve_is_paid()
    max_count = payload.resolve_max_count()
    emp_id = payload.resolve_employee_id()

    if payload.id:
        policy = db.scalar(select(BreakPolicy).where(BreakPolicy.id == payload.id))
        if not policy:
            raise ApiError(404, f"Break policy '{payload.id}' not found.")
        policy.break_type = break_type
        policy.name = payload.name
        policy.allowed_duration_minutes = allowed_duration
        policy.is_paid = is_paid
        policy.max_count_per_day = max_count
        policy.notes = payload.notes
        if emp_id is not None:
            policy.employee_id = emp_id if emp_id else None
    else:
        policy = BreakPolicy(
            company_id=company_id,
            employee_id=emp_id if emp_id else None,
            break_type=break_type,
            name=payload.name,
            allowed_duration_minutes=allowed_duration,
            is_paid=is_paid,
            max_count_per_day=max_count,
            effective_from=datetime.now(timezone.utc).date(),
            is_active=True,
            notes=payload.notes,
        )
        db.add(policy)

    db.commit()
    db.refresh(policy)
    return {
        "success": True,
        "message": f"Break policy for '{policy.break_type}' saved successfully.",
        "data": {
            "id": policy.id,
            "breakType": policy.break_type,
            "name": policy.name,
            "allowedDurationMinutes": policy.allowed_duration_minutes,
            "isPaid": policy.is_paid,
        },
    }


@router.delete("/policies/{policy_id}")
def delete_break_policy(
    policy_id: str = Path(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Delete a configured break policy."""
    policy = db.scalar(select(BreakPolicy).where(BreakPolicy.id == policy_id))
    if not policy:
        raise ApiError(404, f"Break policy '{policy_id}' not found.")

    name = policy.name
    b_type = policy.break_type
    db.delete(policy)
    db.commit()
    return {
        "success": True,
        "message": f"Break policy '{name}' ({b_type}) deleted successfully.",
        "id": policy_id,
    }


@router.post("/policies/restore-defaults")
def restore_default_policies(
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Restore standard default break allowances."""
    policies = BreakEngineService.restore_default_policies(db, user.company_id)
    return {
        "success": True,
        "message": "Default break policies restored successfully.",
        "count": len(policies),
    }


@router.get("/history")
def get_break_history(
    date: Optional[str] = Query(None, description="Local date YYYY-MM-DD"),
    employee_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Return chronological ledger of all break intervals."""
    target_date = date or to_colombo_date_str()
    query = (
        select(BreakInterval)
        .options(
            joinedload(BreakInterval.employee),
            joinedload(BreakInterval.daily_session),
        )
        .join(DailyTrackingSession, BreakInterval.daily_session_id == DailyTrackingSession.id)
        .where(DailyTrackingSession.work_date == target_date)
    )

    if employee_id:
        query = query.where(BreakInterval.employee_id == employee_id)

    intervals = db.scalars(query.order_by(desc(BreakInterval.started_at))).all()

    now = utcnow()
    records = []
    for inv in intervals:
        dur = inv.actual_duration_seconds if inv.ended_at else max(0, int((now - inv.started_at).total_seconds()))
        records.append({
            "id": inv.id,
            "employeeId": inv.employee_id,
            "employeeName": inv.employee.full_name if inv.employee else "Unknown",
            "employeeCode": inv.employee.employee_code if inv.employee else "",
            "breakType": inv.break_type,
            "startedAt": inv.started_at.isoformat() + "Z",
            "endedAt": inv.ended_at.isoformat() + "Z" if inv.ended_at else None,
            "durationSeconds": dur,
            "durationFormatted": format_duration(dur),
            "allowedDurationMinutes": inv.allowed_duration_minutes,
            "excessDurationSeconds": inv.excess_duration_seconds,
            "excessDurationFormatted": format_duration(inv.excess_duration_seconds),
            "classification": inv.classification,
            "isPaid": inv.is_paid,
            "source": inv.source,
            "notes": inv.notes,
            "isOngoing": inv.ended_at is None,
        })

    return {
        "success": True,
        "date": target_date,
        "count": len(records),
        "data": records,
    }


@router.delete("/intervals/{interval_id}")
def delete_break_interval(
    interval_id: str = Path(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Delete an erroneous break interval record."""
    interval = db.scalar(select(BreakInterval).where(BreakInterval.id == interval_id))
    if not interval:
        raise ApiError(404, f"Break interval '{interval_id}' not found.")

    b_type = interval.break_type
    db.delete(interval)
    db.commit()
    return {
        "success": True,
        "message": f"Break interval '{b_type}' deleted successfully.",
        "id": interval_id,
    }


@router.post("/intervals/{interval_id}/end")
def end_ongoing_break(
    interval_id: str = Path(...),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Manually end an active ongoing break."""
    interval = db.scalar(select(BreakInterval).where(BreakInterval.id == interval_id))
    if not interval:
        raise ApiError(404, f"Break interval '{interval_id}' not found.")
    if interval.ended_at is not None:
        return {"success": True, "message": "Break already ended.", "data": {"id": interval.id}}

    now = utcnow()
    interval.ended_at = now
    dur_sec = max(0, int((now - interval.started_at).total_seconds()))
    interval.actual_duration_seconds = dur_sec
    allowed_sec = interval.allowed_duration_minutes * 60
    if allowed_sec > 0 and dur_sec > allowed_sec:
        interval.classification = "BREAK_ALLOWANCE_EXCEEDED"
        interval.excess_duration_seconds = dur_sec - allowed_sec
    else:
        interval.classification = (
            "APPROVED_LUNCH"
            if interval.break_type == "LUNCH"
            else ("OUTSIDE_INTERVAL" if interval.break_type == "OUTSIDE" else "APPROVED_BREAK")
        )
        interval.excess_duration_seconds = 0
    interval.notes = f"{interval.notes or ''} [Ended manually by admin]".strip()
    db.commit()
    return {
        "success": True,
        "message": f"Break '{interval.break_type}' ended successfully ({format_duration(dur_sec)}).",
        "data": {
            "id": interval.id,
            "durationSeconds": dur_sec,
            "durationFormatted": format_duration(dur_sec),
            "classification": interval.classification,
        },
    }


@router.post("/declare")
def declare_break(
    payload: BreakDeclareSchema,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Declare authorized break interval (prayer, tea, approved personal break)."""
    employee_id = payload.resolve_employee_id()
    break_type = payload.resolve_break_type()
    duration_minutes = payload.resolve_duration_minutes()

    emp = db.scalar(select(Employee).where(Employee.id == employee_id))
    if not emp:
        raise ApiError(404, f"Employee '{employee_id}' not found.")

    start_time = payload.started_at or payload.startedAt or utcnow()
    inv = BreakEngineService.declare_manual_break(
        db=db,
        employee_id=employee_id,
        break_type=break_type,
        started_at=start_time,
        duration_minutes=duration_minutes,
        notes=payload.notes,
        actor_user_id=user.id,
    )

    return {
        "success": True,
        "message": f"Break '{inv.break_type}' declared successfully for {emp.full_name}.",
        "data": {
            "id": inv.id,
            "employeeId": inv.employee_id,
            "breakType": inv.break_type,
            "actualDurationSeconds": inv.actual_duration_seconds,
            "allowedDurationMinutes": inv.allowed_duration_minutes,
            "classification": inv.classification,
            "excessDurationSeconds": inv.excess_duration_seconds,
        },
    }


@router.post("/intervals/{interval_id}/correct")
def correct_break_interval(
    interval_id: str = Path(...),
    payload: BreakCorrectSchema = ...,
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """Allow authorized administrator corrections with mandatory audit trail."""
    new_dur = payload.resolve_duration_seconds()
    new_class = payload.resolve_classification()

    inv = BreakEngineService.correct_break_interval(
        db=db,
        interval_id=interval_id,
        new_duration_seconds=new_dur,
        new_classification=new_class,
        reason=payload.reason,
        admin_user_id=user.id,
    )

    return {
        "success": True,
        "message": "Break interval corrected successfully.",
        "data": {
            "id": inv.id,
            "breakType": inv.break_type,
            "classification": inv.classification,
            "actualDurationSeconds": inv.actual_duration_seconds,
            "excessDurationSeconds": inv.excess_duration_seconds,
            "notes": inv.notes,
        },
    }


@router.get("/reconciliation")
def get_time_reconciliation(
    date: Optional[str] = Query(None, description="Local date YYYY-MM-DD"),
    employee_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: AuthUser = Depends(current_user),
):
    """End-of-day mutually exclusive time reconciliation with ZERO double-counting."""
    target_date = date or to_colombo_date_str()
    data = BreakEngineService.get_reconciliation_summary(db, target_date, employee_id)
    return {
        "success": True,
        "date": target_date,
        "count": len(data),
        "data": data,
    }
