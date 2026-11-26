"""Employees, departments and work schedules. Your ERP is expected to be the master list: PUT keeps WorkSight in step."""

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import JSONResponse
from pydantic import AwareDatetime
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.api_keys import ApiClient, require_scope
from app.database import get_db
from app.errors import ApiError
from app.models import Department, Employee, FaceTemplate, Office, WorkSchedule
from app.routers.faces import enrolment_base_url, issue_mobile_session
from app.v1 import schemas
from app.v1.common import (
    MAX_LIMIT,
    audit,
    clean_code,
    employee_or_404,
    find_employee,
    iso,
    iso_ms,
    keyset_page,
    page_json,
    to_utc,
)

router = APIRouter(tags=["Employees"])
CodePath = Path(description="The employee's code (case doesn't matter)", examples=["EMP-001"])


def schedule_json(ws: Optional[WorkSchedule]) -> Optional[dict]:
    if ws is None:
        return None
    return {
        "name": ws.name,
        "startTime": ws.start_time,
        "endTime": ws.end_time,
        "graceMinutes": ws.grace_minutes,
        "workingDays": sorted({int(d) for d in ws.working_days.split(",") if d.strip().isdigit()}),
    }


def _enrolled_ids(db: Session, employee_ids: list[str]) -> set[str]:
    if not employee_ids:
        return set()
    return set(
        db.scalars(
            select(FaceTemplate.employee_id).where(
                FaceTemplate.employee_id.in_(employee_ids), FaceTemplate.status == "ACTIVE"
            )
        )
    )


def employee_json(emp: Employee, enrolled: bool) -> dict:
    return {
        "employeeCode": emp.employee_code,
        "id": emp.id,
        "fullName": emp.full_name,
        "email": emp.email,
        "phoneNumber": emp.phone_number,
        "jobTitle": emp.job_title,
        "department": emp.department.name if emp.department else None,
        "workSchedule": schedule_json(emp.work_schedule),
        "employmentType": emp.employment_type,
        "joiningDate": emp.joining_date,
        "isActive": emp.is_active,
        "faceEnrolled": enrolled,
        "createdAt": iso_ms(emp.created_at),
        "updatedAt": iso_ms(emp.updated_at),
    }


@router.get("/employees", response_model=schemas.EmployeeList, summary="List employees")
def list_employees(
    active: Optional[bool] = Query(None, description="Only active (true) or inactive (false) employees; default both"),
    updatedSince: Optional[AwareDatetime] = Query(
        None, description="Only employees changed at or after this time, for incremental sync"
    ),
    limit: int = Query(100, ge=1, le=MAX_LIMIT),
    cursor: Optional[str] = Query(None, description="page.nextCursor from the previous page"),
    _client: ApiClient = Depends(require_scope("employees:read")),
    db: Session = Depends(get_db),
):
    """All employees, oldest change first. To sync, store the last `updatedAt` you received and pass it as
    `updatedSince` next time; follow `page.nextCursor` until it is null."""
    stmt = select(Employee).options(joinedload(Employee.department), joinedload(Employee.work_schedule))
    if active is not None:
        stmt = stmt.where(Employee.is_active.is_(active))
    if updatedSince is not None:
        stmt = stmt.where(Employee.updated_at >= to_utc(updatedSince))
    rows, nxt = keyset_page(db, stmt, Employee.updated_at, Employee.id, lambda e: (e.updated_at, e.id), limit, cursor)
    enrolled = _enrolled_ids(db, [e.id for e in rows])
    return {"success": True, "data": [employee_json(e, e.id in enrolled) for e in rows], "page": page_json(limit, nxt)}


@router.get("/employees/{employeeCode}", response_model=schemas.EmployeeOne, summary="Get one employee")
def get_employee(
    employeeCode: str = CodePath,
    _client: ApiClient = Depends(require_scope("employees:read")),
    db: Session = Depends(get_db),
):
    emp = employee_or_404(db, employeeCode)
    return {"success": True, "data": employee_json(emp, bool(_enrolled_ids(db, [emp.id])))}


def _department(db: Session, name: str) -> Department:
    name = name.strip()
    dept = db.scalar(select(Department).where(func.lower(Department.name) == name.lower()).limit(1))
    if dept:
        return dept
    office = db.scalar(select(Office).order_by(Office.created_at).limit(1))
    if office is None:
        raise ApiError(409, "WorkSight has no office set up yet, so departments can't be created")
    dept = Department(name=name, office_id=office.id)
    db.add(dept)
    db.flush()
    return dept


def _work_schedule(db: Session, name: str) -> WorkSchedule:
    ws = db.scalar(select(WorkSchedule).where(func.lower(WorkSchedule.name) == name.strip().lower()).limit(1))
    if ws is None:
        names = db.scalars(select(WorkSchedule.name).order_by(WorkSchedule.name)).all()
        raise ApiError(400, f"No work schedule named '{name}'", availableWorkSchedules=list(names))
    return ws


@router.put(
    "/employees/{employeeCode}",
    response_model=schemas.EmployeeOne,
    summary="Add or update an employee",
    responses={201: {"model": schemas.EmployeeOne, "description": "Added"}, 200: {"description": "Updated"}},
)
def upsert_employee(
    body: schemas.EmployeeUpsert,
    employeeCode: str = CodePath,
    client: ApiClient = Depends(require_scope("employees:write")),
    db: Session = Depends(get_db),
):
    """Adds the employee if the code is new (201), otherwise updates it (200). Only the fields you send change.

    Employees are never deleted through the API: set `isActive: false` when someone leaves. Their attendance history
    stays, and the cameras stop recognising them. A new employee still needs a face enrolment before the cameras
    can recognise them: see `POST /employees/{employeeCode}/enrolment-link`."""
    code = clean_code(employeeCode)
    sent = body.model_fields_set
    for required in ("fullName", "department", "isActive"):
        if required in sent and getattr(body, required) is None:
            raise ApiError(400, f"{required} can't be null")

    emp = find_employee(db, code)
    created = emp is None
    if created:
        if not body.fullName:
            raise ApiError(400, "fullName is required to add a new employee")
        dept = _department(db, body.department) if body.department else None
        if dept is None:
            dept = db.scalar(select(Department).order_by(Department.name).limit(1)) or _department(db, "General")
        emp = Employee(
            employee_code=code,
            full_name=body.fullName.strip(),
            job_title="Employee",
            department_id=dept.id,
            employment_type="Full-Time",
            is_active=True,
        )
        db.add(emp)

    changes: dict = {}

    def put(attr: str, field: str, val):
        if getattr(emp, attr) != val:
            setattr(emp, attr, val)
            changes[field] = val

    if "fullName" in sent:
        put("full_name", "fullName", body.fullName.strip())
    if "email" in sent:
        put("email", "email", (body.email or "").strip() or None)
    if "phoneNumber" in sent:
        put("phone_number", "phoneNumber", (body.phoneNumber or "").strip() or None)
    if "jobTitle" in sent:
        put("job_title", "jobTitle", (body.jobTitle or "").strip() or "Employee")
    if "department" in sent:
        dept = _department(db, body.department)
        if emp.department_id != dept.id:
            emp.department_id = dept.id
            changes["department"] = dept.name
    if "workSchedule" in sent:
        ws_id = _work_schedule(db, body.workSchedule).id if body.workSchedule else None
        if emp.work_schedule_id != ws_id:
            emp.work_schedule_id = ws_id
            changes["workSchedule"] = body.workSchedule
    if "employmentType" in sent:
        put("employment_type", "employmentType", (body.employmentType or "").strip() or None)
    if "joiningDate" in sent:
        put("joining_date", "joiningDate", body.joiningDate.isoformat() if body.joiningDate else None)
    if "isActive" in sent:
        put("is_active", "isActive", body.isActive)

    if created or changes:
        db.flush()
        audit(db, client, "API_EMPLOYEE_CREATE" if created else "API_EMPLOYEE_UPDATE", "Employee", emp.id,
              {"employeeCode": code, "changes": changes})
    db.commit()
    db.refresh(emp)
    data = {"success": True, "data": employee_json(emp, bool(_enrolled_ids(db, [emp.id])))}
    return JSONResponse(data, status_code=201) if created else data


@router.post(
    "/employees/{employeeCode}/enrolment-link",
    response_model=schemas.EnrolmentLinkOne,
    status_code=201,
    summary="Create a face-enrolment link",
)
def enrolment_link(
    employeeCode: str = CodePath,
    client: ApiClient = Depends(require_scope("employees:write")),
    db: Session = Depends(get_db),
):
    """A one-time link the employee opens on their phone to enrol their face, so the cameras can recognise them.
    Send it to them by SMS or email. It expires after the time set in WorkSight (Settings > Phone enrolment);
    a new link cancels any older one. HR then checks and saves the photos in WorkSight."""
    emp = employee_or_404(db, employeeCode)
    sess, token = issue_mobile_session(db, emp, created_by_id=None)
    audit(db, client, "API_ENROLMENT_LINK", "Employee", emp.id, {"employeeCode": emp.employee_code})
    db.commit()
    base = enrolment_base_url()
    return {
        "success": True,
        "data": {
            "employeeCode": emp.employee_code,
            "url": f"{base}/enroll?token={token}" if base else None,
            "token": token,
            "expiresAt": iso(sess.expires_at),
        },
    }


@router.get("/departments", response_model=schemas.DepartmentList, summary="List departments")
def list_departments(
    _client: ApiClient = Depends(require_scope("employees:read")), db: Session = Depends(get_db)
):
    counts = dict(
        db.execute(
            select(Employee.department_id, func.count()).where(Employee.is_active.is_(True)).group_by(Employee.department_id)
        ).all()
    )
    depts = db.scalars(select(Department).order_by(Department.name)).all()
    return {"success": True, "data": [{"name": d.name, "employees": counts.get(d.id, 0)} for d in depts]}


@router.get("/work-schedules", response_model=schemas.WorkScheduleList, summary="List work schedules")
def list_work_schedules(
    _client: ApiClient = Depends(require_scope("employees:read")), db: Session = Depends(get_db)
):
    """Use a schedule's `name` as `workSchedule` when adding or updating an employee."""
    return {
        "success": True,
        "data": [schedule_json(w) for w in db.scalars(select(WorkSchedule).order_by(WorkSchedule.name)).all()],
    }
