"""Office Zone Configuration & Doorway Line APIs."""

import hmac
from typing import List, Optional
from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import Camera, CameraZoneConfiguration, DoorCrossingLine, UserRole
from app.security import current_user, require_role, json_body, AuthUser
from app.serialize import ser, ser_all

admin_only = require_role(UserRole.SUPER_ADMIN, UserRole.OFFICE_ADMIN, UserRole.HR_MANAGER)


def current_user_or_service_key(
    request: Request,
    db: Session = Depends(get_db),
    x_service_key: Optional[str] = Header(default=None),
) -> Optional[AuthUser]:
    if x_service_key and settings.AI_SERVICE_KEY and hmac.compare_digest(x_service_key, settings.AI_SERVICE_KEY):
        return None
    return current_user(request, db)


router = APIRouter(prefix="/api", tags=["zones"])


@router.get("/zones", dependencies=[Depends(current_user_or_service_key)])
def get_zones(db: Session = Depends(get_db)):
    """Return all configured zones across cameras."""
    zones = db.scalars(select(CameraZoneConfiguration).where(CameraZoneConfiguration.enabled.is_(True))).all()
    return {"success": True, "count": len(zones), "data": ser_all(zones)}


@router.get("/cameras/{camera_id}/zone-config", dependencies=[Depends(current_user_or_service_key)])
def get_camera_zone_config(
    camera_id: str,
    channel: int = Query(1, alias="channel"),
    db: Session = Depends(get_db),
):
    """Return the polygon zones and doorway crossing lines for a camera channel."""
    cam = db.get(Camera, camera_id)
    if not cam:
        raise ApiError(404, "Camera not found")

    zones = db.scalars(
        select(CameraZoneConfiguration).where(
            CameraZoneConfiguration.camera_id == camera_id,
            CameraZoneConfiguration.channel_no == channel,
        )
    ).all()

    lines = db.scalars(
        select(DoorCrossingLine).where(
            DoorCrossingLine.camera_id == camera_id,
            DoorCrossingLine.channel_no == channel,
        )
    ).all()

    return {
        "success": True,
        "data": {
            "cameraId": camera_id,
            "channelNo": channel,
            "zones": ser_all(zones),
            "lines": ser_all(lines),
        },
    }


@router.put("/cameras/{camera_id}/zone-config", dependencies=[Depends(admin_only)])
def update_camera_zone_config(
    camera_id: str,
    channel: int = Query(1, alias="channel"),
    body: dict = Depends(json_body),
    user: AuthUser = Depends(admin_only),
    db: Session = Depends(get_db),
):
    """Save updated polygon boundaries and crossing lines."""
    cam = db.get(Camera, camera_id)
    if not cam:
        raise ApiError(404, "Camera not found")

    new_zones = body.get("zones", [])
    new_lines = body.get("lines", [])

    # Update or insert zones
    for z in new_zones:
        zone_id = z.get("zoneId")
        if not zone_id:
            continue
        existing = db.scalar(
            select(CameraZoneConfiguration).where(
                CameraZoneConfiguration.camera_id == camera_id,
                CameraZoneConfiguration.channel_no == channel,
                CameraZoneConfiguration.zone_id == zone_id,
            )
        )
        if existing:
            existing.zone_name = z.get("zoneName", existing.zone_name)
            existing.normalized_polygon = z.get("normalizedPolygon", existing.normalized_polygon)
            existing.enabled = z.get("enabled", existing.enabled)
            existing.configuration_version += 1
            existing.updated_at = utcnow()
        else:
            db.add(
                CameraZoneConfiguration(
                    camera_id=camera_id,
                    channel_no=channel,
                    zone_id=zone_id,
                    zone_name=z.get("zoneName", zone_id),
                    normalized_polygon=z.get("normalizedPolygon", []),
                    enabled=z.get("enabled", True),
                )
            )

    # Update or insert lines
    for l in new_lines:
        line_id = l.get("lineId")
        if not line_id:
            continue
        existing_line = db.scalar(
            select(DoorCrossingLine).where(
                DoorCrossingLine.camera_id == camera_id,
                DoorCrossingLine.channel_no == channel,
                DoorCrossingLine.line_id == line_id,
            )
        )
        if existing_line:
            existing_line.line_name = l.get("lineName", existing_line.line_name)
            existing_line.normalized_start_point = l.get("normalizedStartPoint", existing_line.normalized_start_point)
            existing_line.normalized_end_point = l.get("normalizedEndPoint", existing_line.normalized_end_point)
            existing_line.direction_mapping = l.get("directionMapping", existing_line.direction_mapping)
            existing_line.enabled = l.get("enabled", existing_line.enabled)
            existing_line.updated_at = utcnow()
        else:
            db.add(
                DoorCrossingLine(
                    camera_id=camera_id,
                    channel_no=channel,
                    line_id=line_id,
                    line_name=l.get("lineName", line_id),
                    normalized_start_point=l.get("normalizedStartPoint", [0, 0]),
                    normalized_end_point=l.get("normalizedEndPoint", [1, 1]),
                    direction_mapping=l.get("directionMapping", {}),
                    enabled=l.get("enabled", True),
                )
            )

    db.commit()
    return {"success": True, "message": "Camera zone and doorway line configuration updated."}
