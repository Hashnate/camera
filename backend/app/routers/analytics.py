from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db, today_utc
from app.errors import ApiError
from app.models import (
    AttendanceRecord,
    Camera,
    CameraEvent,
    CameraStatus,
    DetectionEvent,
    Employee,
    OccupancyRecord,
    OfficeZone,
)
from app.security import current_user, json_body
from app.serialize import ser, ser_all

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _count(db: Session, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where))


def _latest_occupancy(db: Session, zone_id: str, limit: int) -> list[OccupancyRecord]:
    return db.scalars(
        select(OccupancyRecord)
        .where(OccupancyRecord.zone_id == zone_id)
        .order_by(OccupancyRecord.recorded_at.desc())
        .limit(limit)
    ).all()


@router.get("/overview", dependencies=[Depends(current_user)])
def overview(db: Session = Depends(get_db)):
    total_employees = _count(db, Employee, Employee.is_active.is_(True))
    today_records = db.scalars(select(AttendanceRecord).where(AttendanceRecord.date == today_utc())).all()
    total_cameras = _count(db, Camera)
    online_cameras = _count(db, Camera, Camera.status == CameraStatus.ONLINE)
    zones = db.scalars(select(OfficeZone)).all()
    recent_events = db.scalars(select(CameraEvent).order_by(CameraEvent.timestamp.desc()).limit(5)).all()

    present = sum(1 for r in today_records if r.check_in is not None)
    late = sum(1 for r in today_records if r.is_late)

    zone_rows = []
    occupied = 0
    for z in zones:
        latest = _latest_occupancy(db, z.id, 1)
        current = latest[0].person_count if latest else 0
        if current > 0:
            occupied += 1
        zone_rows.append(
            {"id": z.id, "name": z.name, "type": z.type.value, "capacity": z.capacity, "currentOccupancy": current}
        )

    return {
        "success": True,
        "data": {
            "summary": {
                "totalEmployees": total_employees,
                "presentCount": present,
                "absentCount": max(0, total_employees - present),
                "lateCount": late,
                "totalCameras": total_cameras,
                "onlineCameras": online_cameras,
                "offlineCameras": max(0, total_cameras - online_cameras),
                "totalZones": len(zones),
                "occupiedZonesCount": occupied,
            },
            "zones": zone_rows,
            "recentAlerts": [
                ser(e, camera=ser(e.camera, only=("name", "serialNumber"))) for e in recent_events
            ],
        },
    }


@router.get("/occupancy", dependencies=[Depends(current_user)])
def zone_occupancy(db: Session = Depends(get_db)):
    zones = db.scalars(select(OfficeZone)).all()
    return {
        "success": True,
        "data": [ser(z, occupancyRecords=ser_all(_latest_occupancy(db, z.id, 24))) for z in zones],
    }


@router.post("/events")
def record_detection_event(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    """Ingestion endpoint for the Python AI computer-vision service (no auth, as before)."""
    camera_id, event_type = body.get("cameraId"), body.get("eventType")
    if not camera_id or not event_type:
        raise ApiError(400, "cameraId and eventType are required")

    zone_id = body.get("zoneId") or None
    person_count = int(body["personCount"]) if body.get("personCount") is not None else 1

    event = DetectionEvent(
        camera_id=camera_id,
        zone_id=zone_id,
        channel_no=body.get("channelNo") or 1,
        tracking_id=body.get("trackingId") or None,
        event_type=event_type,
        confidence=float(body["confidence"]) if body.get("confidence") else None,
        person_count=person_count,
    )
    db.add(event)

    # An occupancy count for a zone is also stored as an OccupancyRecord.
    if zone_id and event_type == "OCCUPANCY_COUNT":
        zone = db.get(OfficeZone, zone_id)
        count = int(body.get("personCount") or 0)
        db.add(
            OccupancyRecord(
                zone_id=zone_id, person_count=count, is_over_capacity=bool(zone and count > zone.capacity)
            )
        )

    db.commit()
    return JSONResponse({"success": True, "data": ser(event)}, status_code=201)
