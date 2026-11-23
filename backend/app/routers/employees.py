from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import ApiError
from app.models import AttendanceRecord, Department, Employee, WorkSchedule, OfficeZone
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
    "phoneNumber": "phone_number",
    "employmentType": "employment_type",
    "joiningDate": "joining_date",
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
    """Departments, work schedules, and office zones for employee registration."""
    depts = db.scalars(select(Department).order_by(Department.name)).all()
    schedules = db.scalars(select(WorkSchedule).order_by(WorkSchedule.name)).all()
    zones = db.scalars(select(OfficeZone).order_by(OfficeZone.name)).all()

    return {
        "success": True,
        "data": {
            "departments": [{"id": d.id, "name": d.name} for d in depts],
            "workSchedules": [
                {"id": w.id, "name": w.name, "startTime": w.start_time, "endTime": w.end_time} for w in schedules
            ],
            "zones": [{"id": z.id, "name": z.name} for z in zones],
            "designationsByDepartment": {
                "Engineering": [
                    "Software Engineer",
                    "Senior Software Engineer",
                    "Lead Systems Architect",
                    "Full Stack Developer",
                    "DevOps Engineer",
                    "QA Automation Engineer",
                    "Backend Engineer",
                    "Frontend Engineer",
                ],
                "Product & Design": [
                    "Product Manager",
                    "UI/UX Designer",
                    "Product Designer",
                    "Design Lead",
                    "Product Owner",
                ],
                "Operations": [
                    "Operations Manager",
                    "Office Administrator",
                    "Facilities Lead",
                    "Logistics Specialist",
                ],
                "Human Resources": [
                    "HR Manager",
                    "Talent Acquisition Specialist",
                    "HR Generalist",
                    "People Operations Associate",
                ],
                "Management": [
                    "Director",
                    "Chief Executive Officer",
                    "Chief Technology Officer",
                    "Engineering Manager",
                    "Team Lead",
                ],
            },
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
    code = body.get("employeeCode")
    name = body.get("fullName")
    dept = body.get("departmentId")
    if not code or not name:
        raise ApiError(400, "employeeCode and fullName are required")

    clean_code = str(code).strip().upper()
    if db.scalar(select(Employee).where(Employee.employee_code == clean_code)):
        raise ApiError(409, f"Employee code '{clean_code}' already exists")

    # Resolve department
    dept_obj = None
    if dept:
        dept_obj = db.get(Department, dept)
        if not dept_obj:
            dept_obj = db.scalar(select(Department).where(Department.name.ilike(str(dept).strip())))

    if not dept_obj:
        # Fallback to first department or create
        dept_obj = db.scalar(select(Department).order_by(Department.name))
        if not dept_obj:
            dept_obj = Department(name="Engineering")
            db.add(dept_obj)
            db.commit()
            db.refresh(dept_obj)

    # Resolve work schedule
    ws_id = body.get("workScheduleId")
    ws_obj = None
    if ws_id:
        ws_obj = db.get(WorkSchedule, ws_id)
        if not ws_obj:
            ws_obj = db.scalar(select(WorkSchedule).where(WorkSchedule.name.ilike(str(ws_id).strip())))
    # No schedule chosen = no fixed hours (never late), rather than silently picking one.

    emp = Employee(
        employee_code=clean_code,
        full_name=str(name).strip(),
        email=body.get("email"),
        job_title=(body.get("jobTitle") or "").strip() or "Employee",
        department_id=dept_obj.id,
        work_schedule_id=ws_obj.id if ws_obj else None,
        assigned_zone=body.get("assignedZone") or None,
        phone_number=body.get("phoneNumber"),
        employment_type=body.get("employmentType") or "Full-Time",
        joining_date=body.get("joiningDate"),
        is_active=bool(body.get("isActive", True)),
    )
    db.add(emp)
    db.commit()
    return JSONResponse({"success": True, "data": employee_json(emp)}, status_code=201)


@router.patch("/{employee_id}")
def update_employee(employee_id: str, body: dict = Depends(json_body), db: Session = Depends(get_db)):
    emp = _get_or_404(db, employee_id)
    # Check employeeCode if updated
    if "employeeCode" in body and body["employeeCode"] != emp.employee_code:
        new_code = str(body["employeeCode"]).strip()
        if not new_code:
            raise ApiError(400, "Employee ID/code cannot be empty")
        existing = db.scalar(select(Employee).where(Employee.employee_code == new_code, Employee.id != employee_id))
        if existing:
            raise ApiError(409, f"Employee code '{new_code}' already exists")
        emp.employee_code = new_code

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
