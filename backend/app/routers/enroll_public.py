"""Public (no login) endpoints behind the one-time QR link for phone self-enrolment.

The only credential is the random token in the QR code. It is valid for MOBILE_ENROLL_TTL_MIN
minutes, can be used to submit exactly once, and is invalidated when a newer QR code is issued.
The frontend proxies `/api/public/enroll/*` to this router, so phones never talk to port 5000.
"""

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import Employee, FaceEnrollmentSession
from app.routers.faces import (
    MAX_IMAGE_BYTES,
    PENDING_DIR,
    SUBMITTED,
    ai_embed,
    ai_validate,
    hash_token,
    pending_path,
    session_status,
)
from app.serialize import value

router = APIRouter(prefix="/api/public/enroll", tags=["public-enroll"])

REQUIRED_ANGLES = ("front", "left", "right")
_GONE = {
    SUBMITTED: "Your photos have been sent. HR will review and save them, so you can close this page.",
    "COMPLETED": "This link has already been used. Your face is enrolled, so you can close this page.",
    "CANCELLED": "This link was replaced or cancelled. Ask HR to show you a new QR code.",
    "EXPIRED": "This link has expired. Ask HR to show you a new QR code.",
}


def _load(db: Session, token: str, *, lock: bool = False) -> tuple[FaceEnrollmentSession, Employee]:
    if not token or len(token) > 128:
        raise ApiError(404, "This enrolment link is not valid.", code="INVALID")
    stmt = select(FaceEnrollmentSession).where(FaceEnrollmentSession.token_hash == hash_token(token))
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    sess = db.scalars(stmt).first()
    if not sess:
        raise ApiError(404, "This enrolment link is not valid. Ask HR to show you a new QR code.", code="INVALID")

    status = session_status(sess, utcnow())
    if status in _GONE:
        raise ApiError(410, _GONE[status], code=status)

    emp = db.get(Employee, sess.employee_id)
    if not emp or not emp.is_active:
        raise ApiError(410, "This employee profile is no longer active.", code="CANCELLED")
    return sess, emp


async def _read_image(upload: UploadFile, label: str) -> bytes:
    data = await upload.read()
    if not data:
        raise ApiError(400, f"The {label} photo is empty. Please retake it.")
    if len(data) > MAX_IMAGE_BYTES:
        raise ApiError(413, f"The {label} photo is too large (max 10 MB).")
    return data


@router.get("/{token}")
def open_link(token: str, db: Session = Depends(get_db)):
    """Called when the employee opens the link; lets the HR screen show 'opened on phone'."""
    sess, emp = _load(db, token)
    if sess.status == "PENDING":
        sess.status = "OPENED"
        sess.opened_at = utcnow()
        db.commit()
    return {
        "success": True,
        "data": {
            "employee": {
                "firstName": emp.full_name.split()[0] if emp.full_name else "",
                "fullName": emp.full_name,
                "employeeCode": emp.employee_code,
            },
            "expiresAt": value(sess.expires_at),
            "secondsRemaining": max(0, int((sess.expires_at - utcnow()).total_seconds())),
            "requiredAngles": list(REQUIRED_ANGLES),
        },
    }


@router.post("/{token}/validate")
async def validate(
    token: str,
    image: UploadFile = File(...),
    expected_angle: str = Form(None),
    db: Session = Depends(get_db),
):
    """Quality / angle check for one photo before the employee moves to the next step."""
    _load(db, token)
    db.rollback()  # don't hold a transaction open during the AI call
    data = await _read_image(image, "captured")
    return await ai_validate(data, image.filename or "validate.jpg", image.content_type, expected_angle)


@router.post("/{token}/submit")
async def submit(
    token: str,
    consent: str = Form(...),
    front: UploadFile = File(...),
    left: UploadFile = File(...),
    right: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Send all angles to HR for review (nothing is enrolled yet), then burn the link."""
    if consent.lower() not in ("true", "1", "yes"):
        raise ApiError(400, "Please tick the consent box before submitting.")

    _load(db, token)  # fail fast before the slow AI work
    db.rollback()

    images = {
        "front": await _read_image(front, "front"),
        "left": await _read_image(left, "left"),
        "right": await _read_image(right, "right"),
    }

    # Check each photo has a usable face now, so the employee can retake it on the spot.
    # (If the AI service is down, accept the photos; HR's save will check them again.)
    for angle, data in images.items():
        try:
            await ai_embed(data, f"{angle}.jpg", "image/jpeg")
        except ApiError as exc:
            if exc.status_code == 422:
                raise ApiError(422, f"{angle.title()} photo: {exc.message}. Please retake it.", angle=angle)
            if exc.status_code not in (502, 503):
                raise

    # Lock the row so two submits racing on the same link can't both succeed.
    sess, emp = _load(db, token, lock=True)
    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    for angle, data in images.items():
        pending_path(sess.id, angle).write_bytes(data)
    # Nothing is enrolled here: HR reviews these photos in the enrolment dialog and saves them.
    sess.status = SUBMITTED
    sess.angles_enrolled = ",".join(images)
    db.commit()

    return {
        "success": True,
        "message": "Photos sent. HR will review and save your enrolment.",
        "data": {"angles": list(images)},
    }
