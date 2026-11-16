from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db, today_utc, utcnow
from app.errors import ApiError
from app.models import (
    AttendanceCorrection,
    AttendanceRecord,
    AttendanceStatus,
    CorrectionStatus,
    Employee,
    RecognitionEvent,
)
from app.security import current_user, json_body
from app.services import attendance as rules
from app.serialize import ser, ser_all

router = APIRouter(prefix="/api/attendance", tags=["attendance"], dependencies=[Depends(current_user)])


def _auto_record_ids(db: Session, records: list[AttendanceRecord]) -> set[str]:
    """Records whose check-in came from the camera."""
    ids = [r.id for r in records]
    if not ids:
        return set()
    return set(
        db.scalars(
            select(RecognitionEvent.attendance_record_id).where(
                RecognitionEvent.attendance_record_id.in_(ids), RecognitionEvent.action == "CHECK_IN"
            )
        )
    )


def _record_json(rec: AttendanceRecord, *, with_schedule: bool, auto_ids: set[str]) -> dict:
    emp = rec.employee
    emp_rel = {"department": ser(emp.department)}
    if with_schedule:
        emp_rel["workSchedule"] = ser(emp.work_schedule)
    return ser(
        rec,
        employee=ser(emp, **emp_rel),
        corrections=ser_all(rec.corrections),
        source="AUTO" if rec.id in auto_ids else "MANUAL",
    )


def _parse_datetime(raw: str) -> datetime:
    """Parse an ISO date/time string into naive UTC (naive input is treated as UTC)."""
    try:
        dt = datetime.fromisoformat(str(raw))
    except ValueError:
        raise ApiError(400, f"Invalid date: {raw}")
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _find_today(db: Session, employee_id: str, today: str) -> Optional[AttendanceRecord]:
    return db.scalar(
        select(AttendanceRecord).where(
            AttendanceRecord.employee_id == employee_id, AttendanceRecord.date == today
        )
    )


@router.get("/today")
def today_attendance(db: Session = Depends(get_db)):
    today = today_utc()
    records = db.scalars(
        select(AttendanceRecord)
        .where(AttendanceRecord.date == today)
        .order_by(AttendanceRecord.check_in.desc())
    ).all()

    total = db.scalar(select(func.count()).select_from(Employee).where(Employee.is_active.is_(True)))
    present = sum(1 for r in records if r.status in (AttendanceStatus.PRESENT, AttendanceStatus.LATE))
    late = sum(1 for r in records if r.is_late)
    auto_ids = _auto_record_ids(db, records)

    return {
        "success": True,
        "date": today,
        "stats": {
            "totalEmployees": total,
            "presentCount": present,
            "lateCount": late,
            "absentCount": max(0, total - present),
        },
        "records": [_record_json(r, with_schedule=True, auto_ids=auto_ids) for r in records],
    }


@router.get("/history")
def attendance_history(
    startDate: Optional[str] = None,
    endDate: Optional[str] = None,
    departmentId: Optional[str] = None,
    db: Session = Depends(get_db),
):
    stmt = select(AttendanceRecord)
    if startDate and endDate:
        stmt = stmt.where(AttendanceRecord.date >= startDate, AttendanceRecord.date <= endDate)
    if departmentId:
        stmt = stmt.join(AttendanceRecord.employee).where(Employee.department_id == departmentId)
    records = db.scalars(stmt.order_by(AttendanceRecord.date.desc()).limit(100)).all()
    auto_ids = _auto_record_ids(db, records)
    return {
        "success": True,
        "count": len(records),
        "data": [_record_json(r, with_schedule=False, auto_ids=auto_ids) for r in records],
    }


@router.post("/check-in")
def check_in(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    employee_id = body.get("employeeId")
    if not employee_id:
        raise ApiError(400, "employeeId is required")

    emp = db.get(Employee, employee_id)
    if not emp:
        raise ApiError(404, "Employee not found")

    now = utcnow()
    existing = _find_today(db, emp.id, today_utc())
    if existing and existing.check_in:
        raise ApiError(400, "Employee already checked in today", record=ser(existing))

    record = rules.check_in(db, emp, now, existing)
    db.commit()
    db.refresh(record)
    return {"success": True, "message": "Check-in recorded", "data": ser(record)}


@router.post("/check-out")
def check_out(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    employee_id = body.get("employeeId")
    if not employee_id:
        raise ApiError(400, "employeeId is required")

    now = utcnow()
    record = _find_today(db, employee_id, today_utc())
    if not record or not record.check_in:
        raise ApiError(400, "No check-in found for today")

    rules.check_out(record.employee, record, now)
    db.commit()
    db.refresh(record)
    return {"success": True, "message": "Check-out recorded", "data": ser(record)}


@router.post("/correction")
def request_correction(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    record_id, reason = body.get("attendanceRecordId"), body.get("reason")
    if not record_id or not reason:
        raise ApiError(400, "Record ID and reason are required")

    correction = AttendanceCorrection(
        attendance_record_id=record_id,
        requested_check_in=_parse_datetime(body["requestedCheckIn"]) if body.get("requestedCheckIn") else None,
        requested_check_out=_parse_datetime(body["requestedCheckOut"]) if body.get("requestedCheckOut") else None,
        reason=reason,
        status=CorrectionStatus.PENDING,
    )
    db.add(correction)
    db.commit()
    return JSONResponse({"success": True, "data": ser(correction)}, status_code=201)
