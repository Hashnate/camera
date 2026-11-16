from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import ApiError
from app.models import AttendanceRecord, Department, Employee, WorkSchedule
from app.security import current_user, json_body
from app.serialize import ser, ser_all

router = APIRouter(prefix="/api/employees", tags=["employees"], dependencies=[Depends(current_user)])

# JSON field -> model attribute for fields a client may set.
_EDITABLE = {
    "fullName": "full_name",
    "email": "email",
    "jobTitle": "job_title",
    "departmentId": "department_id",
    "workScheduleId": "work_schedule_id",
    "assignedZone": "assigned_zone",
    "isActive": "is_active",
}


def employee_json(emp: Employee, **extra) -> dict:
    return ser(emp, department=ser(emp.department), workSchedule=ser(emp.work_schedule), **extra)


def _get_or_404(db: Session, employee_id: str) -> Employee:
    emp = db.get(Employee, employee_id)
    if not emp:
        raise ApiError(404, "Employee not found")
    return emp


@router.get("")
def list_employees(db: Session = Depends(get_db)):
    employees = db.scalars(select(Employee).order_by(Employee.full_name.asc())).all()
    return {"success": True, "count": len(employees), "data": [employee_json(e) for e in employees]}


@router.get("/form-options")
def form_options(db: Session = Depends(get_db)):
    """Departments and work schedules for the add-employee form."""
    depts = db.scalars(select(Department).order_by(Department.name)).all()
    schedules = db.scalars(select(WorkSchedule).order_by(WorkSchedule.name)).all()
    return {
        "success": True,
        "data": {
            "departments": [{"id": d.id, "name": d.name} for d in depts],
            "workSchedules": [
                {"id": w.id, "name": w.name, "startTime": w.start_time, "endTime": w.end_time} for w in schedules
            ],
        },
    }


@router.get("/{employee_id}")
def get_employee(employee_id: str, db: Session = Depends(get_db)):
    emp = _get_or_404(db, employee_id)
    records = db.scalars(
        select(AttendanceRecord)
        .where(AttendanceRecord.employee_id == emp.id)
        .order_by(AttendanceRecord.date.desc())
        .limit(30)
    ).all()
    return {"success": True, "data": employee_json(emp, attendanceRecords=ser_all(records))}


@router.post("")
def create_employee(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    code, name, dept = body.get("employeeCode"), body.get("fullName"), body.get("departmentId")
    if not code or not name or not dept:
        raise ApiError(400, "employeeCode, fullName, and departmentId are required")

    if db.scalar(select(Employee).where(Employee.employee_code == code)):
        raise ApiError(409, "Employee code already exists")

    emp = Employee(
        employee_code=code,
        full_name=name,
        email=body.get("email"),
        job_title=body.get("jobTitle") or "Team Member",
        department_id=dept,
        work_schedule_id=body.get("workScheduleId"),
        assigned_zone=body.get("assignedZone"),
    )
    db.add(emp)
    db.commit()
    return JSONResponse({"success": True, "data": employee_json(emp)}, status_code=201)


@router.patch("/{employee_id}")
def update_employee(employee_id: str, body: dict = Depends(json_body), db: Session = Depends(get_db)):
    emp = _get_or_404(db, employee_id)
    # Only fields present in the body are changed (an explicit null clears a nullable field).
    for key, attr in _EDITABLE.items():
        if key in body:
            setattr(emp, attr, body[key])
    db.commit()
    db.refresh(emp)
    return {"success": True, "data": employee_json(emp)}


@router.delete("/{employee_id}")
def delete_employee(employee_id: str, db: Session = Depends(get_db)):
    _get_or_404(db, employee_id)
    # Core delete so the database's ON DELETE CASCADE removes attendance records.
    db.execute(delete(Employee).where(Employee.id == employee_id))
    db.commit()
    return {"success": True, "message": "Employee removed successfully"}
