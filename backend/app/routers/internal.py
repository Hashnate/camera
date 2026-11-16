"""Service-to-service API used by the AI service (authenticated with X-Service-Key)."""

import hmac
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import Camera, CameraChannel, CameraProviderType, Employee, FaceEnrollment
from app.providers.ezviz import ezviz_provider
from app.security import json_body
from app.services.attendance import apply_recognition


def require_service_key(x_service_key: str = Header(default="")) -> None:
    if not settings.AI_SERVICE_KEY:
        raise ApiError(503, "AI service integration is not configured (AI_SERVICE_KEY is empty)")
    if not hmac.compare_digest(x_service_key, settings.AI_SERVICE_KEY):
        raise ApiError(401, "Invalid service key")


router = APIRouter(prefix="/api/internal", tags=["internal"], dependencies=[Depends(require_service_key)])


@router.get("/face-gallery")
def face_gallery(db: Session = Depends(get_db)):
    """Embeddings of active, enrolled employees."""
    rows = db.execute(
        select(FaceEnrollment.employee_id, Employee.full_name, FaceEnrollment.embedding)
        .join(Employee, Employee.id == FaceEnrollment.employee_id)
        .where(Employee.is_active.is_(True))
    ).all()
    return {
        "success": True,
        "data": [{"employeeId": e, "fullName": n, "embedding": list(v)} for e, n, v in rows],
    }


@router.get("/cameras")
def cameras(db: Session = Depends(get_db)):
    cams = db.scalars(select(Camera).where(Camera.provider == CameraProviderType.EZVIZ)).all()
    data = []
    for c in cams:
        chans = db.scalars(
            select(CameraChannel).where(CameraChannel.camera_id == c.id).order_by(CameraChannel.channel_no)
        ).all()
        data.append(
            {
                "id": c.id,
                "name": c.name,
                "serialNumber": c.serial_number,
                "channels": [{"channelNo": ch.channel_no, "channelName": ch.channel_name} for ch in chans],
            }
        )
    return {"success": True, "data": data}


def _camera(db: Session, camera_id: str) -> Camera:
    cam = db.get(Camera, camera_id)
    if not cam:
        raise ApiError(404, "Camera not found")
    return cam


@router.get("/cameras/{camera_id}/stream")
def stream(camera_id: str, channel: int = 1, db: Session = Depends(get_db)):
    cam = _camera(db, camera_id)
    try:
        result = ezviz_provider.get_stream_url(cam.serial_number, channel, 2)
    except Exception as exc:
        raise ApiError(502, f"EZVIZ stream error: {exc}")
    return {"success": True, "data": {"streamUrl": result.url, "expireTime": result.expire_time}}


@router.get("/cameras/{camera_id}/snapshot")
def snapshot(camera_id: str, channel: int = 1, db: Session = Depends(get_db)):
    cam = _camera(db, camera_id)
    try:
        snap = ezviz_provider.capture_snapshot(cam.serial_number, channel)
    except Exception as exc:
        raise ApiError(502, f"EZVIZ snapshot error: {exc}")
    return {"success": True, "data": {"picUrl": snap.pic_url}}


def _parse_seen_at(raw) -> datetime:
    now = utcnow()
    if not raw:
        return now
    try:
        dt = datetime.fromisoformat(str(raw))
    except ValueError:
        raise ApiError(400, f"Invalid seenAt: {raw}")
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    # Never accept sightings from the future (clock skew) or older than a day.
    if dt > now + timedelta(minutes=1) or dt < now - timedelta(days=1):
        raise ApiError(400, "seenAt is outside the accepted range")
    return min(dt, now)


@router.post("/recognitions")
def recognition(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    """A confirmed face match from the camera -> automatic attendance."""
    emp = db.get(Employee, body.get("employeeId") or "")
    if not emp:
        raise ApiError(404, "Employee not found")

    camera_id = body.get("cameraId")
    if camera_id and not db.get(Camera, camera_id):
        camera_id = None

    action, event = apply_recognition(
        db,
        emp,
        seen_at=_parse_seen_at(body.get("seenAt")),
        similarity=float(body.get("similarity") or 0),
        camera_id=camera_id,
        channel_no=int(body.get("channelNo") or 1),
    )
    db.commit()
    return {
        "success": True,
        "data": {
            "action": action,
            "eventId": event.id if event else None,
            "attendanceRecordId": event.attendance_record_id if event else None,
        },
    }
