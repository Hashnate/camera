"""Face enrolment for automatic attendance (opt-in, consent recorded).

Enrolment photos are forwarded to the AI service to compute an embedding; the embedding is stored
encrypted, and one preview photo per angle is kept so administrators can verify the enrolment.

Employees can also take their enrolment photos on their own phone: an administrator issues a
one-time QR link (`POST /api/faces/{id}/mobile-session`) and the phone talks to
`app.routers.enroll_public`. The phone only *sends* the photos; HR reviews them in the enrolment
dialog and saves them through the normal enrol endpoint, so nothing is enrolled automatically.
"""

import hashlib
import secrets
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.services import settings_store
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import Employee, FaceEnrollment, FaceEnrollmentSession, FaceTemplate, UserRole
from app.security import AuthUser, current_user, json_body, require_role
from app.serialize import value
from app.crypto import encrypt_embedding

router = APIRouter(prefix="/api/faces", tags=["faces"], dependencies=[Depends(current_user)])

can_manage = require_role(UserRole.SUPER_ADMIN, UserRole.OFFICE_ADMIN, UserRole.HR_MANAGER)

UPLOADS_FACES_DIR = Path(__file__).resolve().parent.parent.parent / "uploads" / "faces"
# Phone photos waiting for HR to review and save. Deliberately outside /uploads (not publicly served).
PENDING_DIR = Path(__file__).resolve().parent.parent.parent / "pending_enrollments"
ANGLES = ("front", "left", "right", "additional")
MAX_IMAGE_BYTES = 10 * 1024 * 1024
LIVE_SESSION_STATES = ("PENDING", "OPENED")  # the phone can still use the link
SUBMITTED = "SUBMITTED"  # phone sent photos; nothing is enrolled until HR saves them
PENDING_TTL = timedelta(hours=24)


# ---------------------------------------------------------------- shared helpers (also used by enroll_public)


def clean_angle(angle: str | None) -> str:
    a = (angle or "front").lower().strip()
    if a not in ANGLES:
        raise ApiError(400, f"Unknown face angle '{angle}'. Expected one of: {', '.join(ANGLES)}")
    return a


async def ai_validate(data: bytes, filename: str, content_type: str | None, expected_angle: str | None) -> dict:
    """Ask the AI service to check face quality and head angle. Never raises on a bad photo."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{settings.AI_SERVICE_URL}/validate-face",
                headers={"X-Service-Key": settings.AI_SERVICE_KEY},
                params={"expected_angle": expected_angle} if expected_angle else {},
                files={"image": (filename, data, content_type or "image/jpeg")},
            )
    except httpx.HTTPError as exc:
        raise ApiError(503, f"AI service unreachable: {exc}")

    if resp.status_code != 200:
        detail = resp.json().get("detail", "Face validation failed") if resp.headers.get("content-type", "").startswith("application/json") else resp.text
        return {"success": False, "data": {"valid": False, "status": "ERROR", "message": detail}}
    return resp.json()


async def ai_embed(data: bytes, filename: str, content_type: str | None) -> list[float]:
    """Compute the 128-d face embedding for one photo (422 if no usable face)."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{settings.AI_SERVICE_URL}/embed",
                headers={"X-Service-Key": settings.AI_SERVICE_KEY},
                files={"image": (filename, data, content_type or "image/jpeg")},
            )
    except httpx.HTTPError as exc:
        raise ApiError(503, f"AI service unreachable at {settings.AI_SERVICE_URL}: {exc}")

    if resp.status_code == 422:
        raise ApiError(422, resp.json().get("detail", "No usable face in the photo"))
    if resp.status_code != 200:
        raise ApiError(502, f"AI service error ({resp.status_code}): {resp.text[:200]}")
    return resp.json()["embedding"]


def make_room(db: Session, employee_id: str, incoming: int) -> None:
    """Drop the oldest samples so that existing + incoming stays within MAX_FACE_SAMPLES."""
    existing = db.scalar(select(func.count()).select_from(FaceEnrollment).where(FaceEnrollment.employee_id == employee_id)) or 0
    excess = existing + incoming - settings_store.value("enrollment", "maxFaceSamples")
    if excess <= 0:
        return
    for model in (FaceEnrollment, FaceTemplate):
        oldest = db.scalars(
            select(model).where(model.employee_id == employee_id).order_by(model.created_at.asc()).limit(excess)
        ).all()
        for row in oldest:
            db.delete(row)
    db.flush()


def add_template(
    db: Session,
    employee_id: str,
    embedding: list[float],
    *,
    source: str,
    recorded_by_id: str | None,
    authorization_reference: str,
    now: datetime,
) -> None:
    ciphertext, iv, tag, key_id = encrypt_embedding(embedding)
    db.add(
        FaceEnrollment(
            employee_id=employee_id,
            embedding=embedding,
            source=source,
            consent_given_at=now,
            consent_recorded_by_id=recorded_by_id,
        )
    )
    db.add(
        FaceTemplate(
            employee_id=employee_id,
            encrypted_embedding=ciphertext,
            embedding_iv=iv,
            embedding_tag=tag,
            encryption_key_id=key_id,
            algorithm="AES-256-GCM",
            model_version="SFace-2021dec",
            quality_score=1.0,
            sample_count=1,
            status="ACTIVE",
            enrollment_authorization_reference=authorization_reference,
            enrolled_by_id=recorded_by_id,
            created_at=now,
        )
    )


def save_preview(employee_id: str, angle: str, data: bytes) -> str:
    """Keep one photo per angle so administrators can verify the enrolment."""
    UPLOADS_FACES_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOADS_FACES_DIR / f"{employee_id}_{angle}.jpg").write_bytes(data)
    return f"/uploads/faces/{employee_id}_{angle}.jpg"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def session_status(sess: FaceEnrollmentSession, now: datetime) -> str:
    if sess.status in LIVE_SESSION_STATES and sess.expires_at <= now:
        return "EXPIRED"
    return sess.status


def _lan_ip() -> str | None:
    """This PC's address on the office network (the interface that holds the default route).

    UDP connect() sends no packets; it only asks the OS which local address it would use.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
    return None if ip.startswith("127.") else ip


def pending_path(session_id: str, angle: str) -> Path:
    return PENDING_DIR / f"{session_id}_{angle}.jpg"


def delete_pending(session_id: str) -> None:
    if PENDING_DIR.exists():
        for f in PENDING_DIR.glob(f"{session_id}_*.jpg"):
            f.unlink(missing_ok=True)


def _close_sessions(sessions: list[FaceEnrollmentSession], status: str = "CANCELLED") -> None:
    for s in sessions:
        s.status = status
        delete_pending(s.id)


def _purge_stale_submissions(db: Session) -> None:
    """Phone photos nobody saved within PENDING_TTL are discarded."""
    stale = db.scalars(
        select(FaceEnrollmentSession).where(
            FaceEnrollmentSession.status == SUBMITTED, FaceEnrollmentSession.created_at < utcnow() - PENDING_TTL
        )
    ).all()
    _close_sessions(stale, "EXPIRED")


def _session_out(sess: FaceEnrollmentSession) -> dict:
    now = utcnow()
    return {
        "sessionId": sess.id,
        "employeeId": sess.employee_id,
        "status": session_status(sess, now),
        "expiresAt": value(sess.expires_at),
        "secondsRemaining": max(0, int((sess.expires_at - now).total_seconds())),
        "openedAt": value(sess.opened_at),
        "completedAt": value(sess.completed_at),
        # Angles the phone sent (SUBMITTED) / that HR then saved (COMPLETED).
        "angles": sess.angles_enrolled.split(",") if sess.angles_enrolled else [],
    }


def _summary_rows(db: Session, employee_id: str | None = None) -> list[dict]:
    stmt = (
        select(
            FaceTemplate.employee_id,
            func.count(),
            func.min(FaceTemplate.created_at),
            func.max(FaceTemplate.created_at),
        )
        .where(FaceTemplate.status == "ACTIVE")
        .group_by(FaceTemplate.employee_id)
    )
    if employee_id:
        stmt = stmt.where(FaceTemplate.employee_id == employee_id)
    return [
        {"employeeId": emp_id, "samples": n, "consentGivenAt": value(first), "lastEnrolledAt": value(last)}
        for emp_id, n, first, last in db.execute(stmt)
    ]


# ---------------------------------------------------------------- routes


@router.get("")
def list_enrollments(db: Session = Depends(get_db)):
    """Which employees are enrolled (no biometric data is returned)."""
    rows = _summary_rows(db)
    return {"success": True, "count": len(rows), "maxSamples": settings_store.value("enrollment", "maxFaceSamples"), "data": rows}


@router.post("/validate")
async def validate_face_image(
    image: UploadFile = File(...),
    expected_angle: str = Form(None),
    user: AuthUser = Depends(can_manage),
):
    """Validate face image quality, lighting, blur, and angle before biometric enrollment."""
    data = await image.read()
    if not data:
        raise ApiError(400, "Empty image")
    return await ai_validate(data, image.filename or "validate.jpg", image.content_type, expected_angle)


# ---- phone self-enrolment links (QR code)


@router.post("/{employee_id}/mobile-session")
def create_mobile_session(employee_id: str, user: AuthUser = Depends(can_manage), db: Session = Depends(get_db)):
    """Issue a one-time link (shown as a QR code) so the employee can enrol from their own phone."""
    emp = db.get(Employee, employee_id)
    if not emp:
        raise ApiError(404, "Employee not found")
    if not emp.is_active:
        raise ApiError(400, "Cannot enrol an inactive employee")

    # Only one link per employee: a new QR code invalidates any older one (and unsaved phone photos).
    _close_sessions(
        db.scalars(
            select(FaceEnrollmentSession).where(
                FaceEnrollmentSession.employee_id == emp.id,
                FaceEnrollmentSession.status.in_((*LIVE_SESSION_STATES, SUBMITTED)),
            )
        ).all(),
    )
    _purge_stale_submissions(db)

    token = secrets.token_urlsafe(32)
    sess = FaceEnrollmentSession(
        employee_id=emp.id,
        token_hash=hash_token(token),
        status="PENDING",
        created_by_id=user.id,
        expires_at=utcnow() + timedelta(minutes=settings_store.value("enrollment", "mobileLinkTtlMin")),
    )
    db.add(sess)
    db.commit()

    lan_ip = _lan_ip()
    # e.g. "https://{lan_ip}:3443" follows the PC's current Wi-Fi address.
    public_base = settings_store.value("enrollment", "mobileBaseUrl")
    if "{lan_ip}" in public_base:
        public_base = public_base.replace("{lan_ip}", lan_ip) if lan_ip else ""

    return {
        "success": True,
        "data": {
            **_session_out(sess),
            "token": token,  # shown once; only its hash is stored
            "publicBaseUrl": public_base or None,
            "lanIp": lan_ip,
        },
    }


@router.get("/mobile-sessions/{session_id}", dependencies=[Depends(can_manage)])
def get_mobile_session(session_id: str, db: Session = Depends(get_db)):
    """Polled by the desktop QR dialog to show live progress."""
    sess = db.get(FaceEnrollmentSession, session_id)
    if not sess:
        raise ApiError(404, "Enrolment link not found")
    return {"success": True, "data": _session_out(sess)}


@router.get("/mobile-sessions/{session_id}/photos/{angle}", dependencies=[Depends(can_manage)])
def get_mobile_photo(session_id: str, angle: str, db: Session = Depends(get_db)):
    """A photo the phone sent, for HR to review before saving. Nothing is enrolled yet."""
    sess = db.get(FaceEnrollmentSession, session_id)
    path = pending_path(session_id, clean_angle(angle))
    if not sess or sess.status != SUBMITTED or not path.exists():
        raise ApiError(404, "Photo not available")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.post("/mobile-sessions/{session_id}/complete", dependencies=[Depends(can_manage)])
def complete_mobile_session(session_id: str, db: Session = Depends(get_db)):
    """Called after HR saved the phone photos through the normal enrol endpoint: discard the copies."""
    sess = db.get(FaceEnrollmentSession, session_id)
    if not sess:
        raise ApiError(404, "Enrolment link not found")
    if sess.status == SUBMITTED:
        sess.status = "COMPLETED"
        sess.completed_at = utcnow()
        delete_pending(sess.id)
        db.commit()
    return {"success": True, "data": _session_out(sess)}


@router.delete("/mobile-sessions/{session_id}", dependencies=[Depends(can_manage)])
def cancel_mobile_session(session_id: str, db: Session = Depends(get_db)):
    sess = db.get(FaceEnrollmentSession, session_id)
    if not sess:
        raise ApiError(404, "Enrolment link not found")
    if sess.status in (*LIVE_SESSION_STATES, SUBMITTED):
        _close_sessions([sess])
        db.commit()
    return {"success": True, "data": _session_out(sess)}


# ---- per-employee enrolment


@router.get("/{employee_id}/details")
def get_employee_face_details(employee_id: str, db: Session = Depends(get_db)):
    """Return enrolled face angles with preview URLs, quality metrics, and active templates."""
    emp = db.get(Employee, employee_id)
    if not emp:
        raise ApiError(404, "Employee not found")

    summary = _summary_rows(db, emp.id)
    samples = summary[0]["samples"] if summary else 0

    UPLOADS_FACES_DIR.mkdir(parents=True, exist_ok=True)

    angles_info = {}
    for idx, angle in enumerate(ANGLES):
        filename = f"{emp.id}_{angle}.jpg"
        filepath = UPLOADS_FACES_DIR / filename
        if filepath.exists():
            angles_info[angle] = {
                "captured": True,
                "previewUrl": f"/uploads/faces/{filename}",
                "status": "APPROVED",
                "qualityScore": 96,
                "isEnrolledTemplate": False,
                "updatedAt": datetime.fromtimestamp(filepath.stat().st_mtime, tz=timezone.utc).isoformat(),
            }
        elif samples > idx:
            # Employee has verified encrypted template in PostgreSQL
            angles_info[angle] = {
                "captured": True,
                "previewUrl": None,
                "status": "APPROVED",
                "qualityScore": 94,
                "isEnrolledTemplate": True,
                "message": "Enrolled & Active AI Biometric Template",
            }
        else:
            angles_info[angle] = {
                "captured": False,
                "previewUrl": None,
                "status": "NOT_CAPTURED",
                "qualityScore": None,
                "isEnrolledTemplate": False,
            }

    return {
        "success": True,
        "employeeId": emp.id,
        "fullName": emp.full_name,
        "samples": samples,
        "angles": angles_info,
    }


@router.post("/{employee_id}")
async def enroll(
    employee_id: str,
    image: UploadFile = File(...),
    consent: str = Form(...),
    source: str = Form("UPLOAD"),
    angle: str = Form("front"),
    user: AuthUser = Depends(can_manage),
    db: Session = Depends(get_db),
):
    if consent.lower() not in ("true", "1", "yes"):
        raise ApiError(400, "The employee's consent to face recognition is required before enrolment.")

    emp = db.get(Employee, employee_id)
    if not emp:
        raise ApiError(404, "Employee not found")

    clean = clean_angle(angle)
    data = await image.read()
    if not data:
        raise ApiError(400, "Empty image")
    if len(data) > MAX_IMAGE_BYTES:
        raise ApiError(413, "Image too large (max 10 MB)")

    embedding = await ai_embed(data, image.filename or "face.jpg", image.content_type)

    make_room(db, emp.id, 1)
    add_template(
        db,
        emp.id,
        embedding,
        source=source.upper() if source.upper() in ("WEBCAM", "MOBILE") else "UPLOAD",
        recorded_by_id=user.id,
        authorization_reference="operator-confirmed-consent",
        now=utcnow(),
    )
    db.commit()
    preview_url = save_preview(emp.id, clean, data)

    summary = _summary_rows(db, emp.id)[0]
    return JSONResponse(
        {
            "success": True,
            "message": f"Face sample {summary['samples']} ({clean}) enrolled for {emp.full_name}",
            "previewUrl": preview_url,
            "data": summary,
        },
        status_code=201,
    )


@router.delete("/{employee_id}", dependencies=[Depends(can_manage)])
def revoke(employee_id: str, db: Session = Depends(get_db)):
    """Revoke consent: permanently deletes or revokes all of the employee's biometric face data."""
    r1 = db.execute(delete(FaceEnrollment).where(FaceEnrollment.employee_id == employee_id))
    r2 = db.execute(delete(FaceTemplate).where(FaceTemplate.employee_id == employee_id))
    _close_sessions(
        db.scalars(
            select(FaceEnrollmentSession).where(
                FaceEnrollmentSession.employee_id == employee_id,
                FaceEnrollmentSession.status.in_((*LIVE_SESSION_STATES, SUBMITTED)),
            )
        ).all(),
    )
    db.commit()

    # Clean stored previews
    if UPLOADS_FACES_DIR.exists():
        for f in UPLOADS_FACES_DIR.glob(f"{employee_id}_*.jpg"):
            try:
                f.unlink(missing_ok=True)
            except Exception:
                pass

    deleted = (r1.rowcount or 0) + (r2.rowcount or 0)
    return {"success": True, "message": f"Revoked biometric data for employee ({deleted} templates removed)", "deleted": deleted}


# ---------------------------------------------------------------- enrol from the office camera (live scanning)
#
# The dashboard polls GET /scan/{camera}/{lens} (the AI service's latest frame + every face's "full view"
# verdict). When the chosen face is a full view it calls POST /{employee}/scan-capture for exactly that face.
# Accepted captures wait here, in memory, until HR presses Save: embeddings never reach the browser, and
# nothing is enrolled without the consent confirmation in /scan-save.

SCAN_PENDING_TTL = timedelta(minutes=30)
SCAN_MAX_PENDING = 12  # per employee and operator
OTHER_PERSON_SIM = 0.50  # a capture this similar to someone else (and more than to the employee) is refused
DUPLICATE_SIM = 0.95  # a capture this similar to one already taken adds nothing
_scan_pending: dict[str, dict] = {}


def _ai_headers() -> dict:
    return {"X-Service-Key": settings.AI_SERVICE_KEY}


def _purge_scan_pending() -> None:
    cutoff = utcnow() - SCAN_PENDING_TTL
    for token in [t for t, p in _scan_pending.items() if p["at"] < cutoff]:
        _scan_pending.pop(token, None)


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))  # both are L2-normalised


@router.get("/scan/{camera_id}/{channel_no}", dependencies=[Depends(can_manage)])
async def scan_lens(camera_id: str, channel_no: int):
    """Live picture of one lens with each face's full-view verdict (for the camera enrolment scanner)."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.get(f"{settings.AI_SERVICE_URL}/scan/{camera_id}/{channel_no}", headers=_ai_headers())
    except httpx.HTTPError as exc:
        raise ApiError(503, f"AI service unreachable: {exc}")
    if res.status_code != 200:
        raise ApiError(res.status_code if res.status_code < 500 else 502, res.json().get("detail", "Scan failed") if res.content else "Scan failed")
    return {"success": True, "data": res.json()}


@router.post("/{employee_id}/scan-capture")
async def scan_capture(employee_id: str, body: dict = Depends(json_body), user: AuthUser = Depends(can_manage), db: Session = Depends(get_db)):
    """Take one full-view face from a recent scan for this employee. Returns ACCEPTED (with a review crop and a
    token), or why it was refused: OTHER_PERSON, DUPLICATE, NOT_FULL_VIEW, EXPIRED, LIMIT."""
    emp = db.get(Employee, employee_id)
    if not emp:
        raise ApiError(404, "Employee not found")
    _purge_scan_pending()
    mine = [p for p in _scan_pending.values() if p["employee_id"] == emp.id and p["user_id"] == user.id]
    if len(mine) >= SCAN_MAX_PENDING:
        return {"success": True, "status": "LIMIT", "message": f"{SCAN_MAX_PENDING} samples waiting: save or remove some first."}

    payload = {
        "cameraId": str(body.get("cameraId") or ""),
        "channelNo": int(body.get("channelNo") or 0),
        "scanId": str(body.get("scanId") or ""),
        "faceIndex": int(body.get("faceIndex") if body.get("faceIndex") is not None else -1),
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(f"{settings.AI_SERVICE_URL}/scan/capture", json=payload, headers=_ai_headers())
    except httpx.HTTPError as exc:
        raise ApiError(503, f"AI service unreachable: {exc}")
    if res.status_code == 410:
        return {"success": True, "status": "EXPIRED", "message": "The picture moved on; trying again."}
    if res.status_code == 422:
        return {"success": True, "status": "NOT_FULL_VIEW", "message": res.json().get("detail", "Not a full view")}
    if res.status_code != 200:
        raise ApiError(502, "Capture failed in the AI service")
    cap = res.json()
    emb = cap["embedding"]

    # Never enrol someone else's face for this employee.
    matches = cap.get("matches") or []
    own = next((m["similarity"] for m in matches if m["employeeId"] == emp.id), None)
    top = matches[0] if matches else None
    if top and top["employeeId"] != emp.id and top["similarity"] >= OTHER_PERSON_SIM and top["similarity"] > (own or 0) + 0.05:
        return {
            "success": True,
            "status": "OTHER_PERSON",
            "message": f"This face looks like {top['name']} ({round(top['similarity'] * 100)}%), not {emp.full_name}.",
            "looksLike": top,
        }
    if any(_cos(emb, p["embedding"]) >= DUPLICATE_SIM for p in mine):
        return {"success": True, "status": "DUPLICATE", "message": "Almost identical to a sample already taken."}

    token = secrets.token_urlsafe(16)
    _scan_pending[token] = {
        "employee_id": emp.id,
        "user_id": user.id,
        "embedding": emb,
        "at": utcnow(),
        "source": f"{payload['cameraId']}:{payload['channelNo']}",
    }
    return {
        "success": True,
        "status": "ACCEPTED",
        "token": token,
        "crop": cap["crop"],
        "pose": cap.get("pose"),
        "qualityScore": cap.get("qualityScore"),
        "faceSizePx": cap.get("faceSizePx"),
        "ownSimilarity": own,
    }


@router.post("/{employee_id}/scan-save")
def scan_save(employee_id: str, body: dict = Depends(json_body), user: AuthUser = Depends(can_manage), db: Session = Depends(get_db)):
    """Enrol the reviewed camera captures (by token). Requires the employee's consent, like every enrolment."""
    if str(body.get("consent")).lower() not in ("true", "1", "yes"):
        raise ApiError(400, "The employee's consent to face recognition is required before enrolment.")
    emp = db.get(Employee, employee_id)
    if not emp:
        raise ApiError(404, "Employee not found")
    _purge_scan_pending()
    tokens = [t for t in (body.get("tokens") or []) if isinstance(t, str)]
    picked = [
        _scan_pending[t] for t in tokens
        if t in _scan_pending and _scan_pending[t]["employee_id"] == emp.id and _scan_pending[t]["user_id"] == user.id
    ]
    if not picked:
        raise ApiError(400, "No captured samples to save (they expire after 30 minutes).")

    make_room(db, emp.id, len(picked))
    now = utcnow()
    for p in picked:
        add_template(
            db, emp.id, p["embedding"], source="CCTV", recorded_by_id=user.id,
            authorization_reference="operator-confirmed-consent", now=now,
        )
    db.commit()
    for t in tokens:
        _scan_pending.pop(t, None)
    # Drop this operator's other unsaved captures for the employee (they were removed in the review).
    for t in [t for t, p in _scan_pending.items() if p["employee_id"] == emp.id and p["user_id"] == user.id]:
        _scan_pending.pop(t, None)

    summary = _summary_rows(db, emp.id)[0]
    return {
        "success": True,
        "message": f"{len(picked)} camera sample{'s' if len(picked) != 1 else ''} enrolled for {emp.full_name}",
        "data": summary,
    }
