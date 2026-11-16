"""Face enrolment for automatic attendance (opt-in, consent recorded).

Enrolment photos are forwarded to the AI service to compute an embedding and are never stored.
"""

import httpx
from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import Employee, FaceEnrollment, UserRole
from app.security import AuthUser, current_user, require_role
from app.serialize import value

router = APIRouter(prefix="/api/faces", tags=["faces"], dependencies=[Depends(current_user)])

can_manage = require_role(UserRole.SUPER_ADMIN, UserRole.OFFICE_ADMIN, UserRole.HR_MANAGER)


def _summary_rows(db: Session, employee_id: str | None = None) -> list[dict]:
    stmt = select(
        FaceEnrollment.employee_id,
        func.count(),
        func.min(FaceEnrollment.consent_given_at),
        func.max(FaceEnrollment.created_at),
    ).group_by(FaceEnrollment.employee_id)
    if employee_id:
        stmt = stmt.where(FaceEnrollment.employee_id == employee_id)
    return [
        {"employeeId": emp_id, "samples": n, "consentGivenAt": value(consent), "lastEnrolledAt": value(last)}
        for emp_id, n, consent, last in db.execute(stmt)
    ]


@router.get("")
def list_enrollments(db: Session = Depends(get_db)):
    """Which employees are enrolled (no biometric data is returned)."""
    rows = _summary_rows(db)
    return {"success": True, "count": len(rows), "maxSamples": settings.MAX_FACE_SAMPLES, "data": rows}


@router.post("/{employee_id}")
async def enroll(
    employee_id: str,
    image: UploadFile = File(...),
    consent: str = Form(...),
    source: str = Form("UPLOAD"),
    user: AuthUser = Depends(can_manage),
    db: Session = Depends(get_db),
):
    if consent.lower() not in ("true", "1", "yes"):
        raise ApiError(400, "The employee's consent to face recognition is required before enrolment.")

    emp = db.get(Employee, employee_id)
    if not emp:
        raise ApiError(404, "Employee not found")

    existing = db.scalar(select(func.count()).select_from(FaceEnrollment).where(FaceEnrollment.employee_id == emp.id))
    if existing >= settings.MAX_FACE_SAMPLES:
        raise ApiError(409, f"Already {existing} face samples (max {settings.MAX_FACE_SAMPLES}). Remove them to re-enrol.")

    data = await image.read()
    if not data:
        raise ApiError(400, "Empty image")

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{settings.AI_SERVICE_URL}/embed",
                headers={"X-Service-Key": settings.AI_SERVICE_KEY},
                files={"image": (image.filename or "face.jpg", data, image.content_type or "image/jpeg")},
            )
    except httpx.HTTPError as exc:
        raise ApiError(503, f"AI service unreachable at {settings.AI_SERVICE_URL}: {exc}")
    finally:
        del data  # the photo is not kept

    if resp.status_code == 422:
        raise ApiError(422, resp.json().get("detail", "No usable face in the photo"))
    if resp.status_code != 200:
        raise ApiError(502, f"AI service error ({resp.status_code}): {resp.text[:200]}")

    db.add(
        FaceEnrollment(
            employee_id=emp.id,
            embedding=resp.json()["embedding"],
            source="WEBCAM" if source.upper() == "WEBCAM" else "UPLOAD",
            consent_given_at=utcnow(),
            consent_recorded_by_id=user.id,
        )
    )
    db.commit()
    summary = _summary_rows(db, emp.id)[0]
    return JSONResponse(
        {"success": True, "message": f"Face sample {summary['samples']} enrolled for {emp.full_name}", "data": summary},
        status_code=201,
    )


@router.delete("/{employee_id}", dependencies=[Depends(can_manage)])
def revoke(employee_id: str, db: Session = Depends(get_db)):
    """Revoke consent: permanently deletes all of the employee's face data."""
    result = db.execute(delete(FaceEnrollment).where(FaceEnrollment.employee_id == employee_id))
    db.commit()
    return {"success": True, "message": f"Deleted {result.rowcount} face sample(s)", "deleted": result.rowcount}
