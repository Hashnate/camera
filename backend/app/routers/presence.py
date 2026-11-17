"""System A — Real-Time Presence APIs."""

import hmac
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, Header
from sqlalchemy import select, desc
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import RecognitionObservation, PresenceSession, User
from app.security import current_user, json_body
from app.services import presence_engine
from app.serialize import ser, ser_all

router = APIRouter(prefix="/api/presence", tags=["presence"])


def require_service_key(x_service_key: str = Header(default="")) -> None:
    if not settings.AI_SERVICE_KEY or not hmac.compare_digest(x_service_key, settings.AI_SERVICE_KEY):
        raise ApiError(401, "Invalid service key")


@router.get("/overview", dependencies=[Depends(current_user)])
def presence_overview(db: Session = Depends(get_db)):
    """Return real-time presence snapshot for all active employees."""
    data = presence_engine.get_current_presence_overview(db)
    return {"success": True, "data": data}


@router.get("/observations", dependencies=[Depends(current_user)])
def recent_observations(limit: int = 50, db: Session = Depends(get_db)):
    """Return recent camera observations."""
    obs = db.scalars(
        select(RecognitionObservation)
        .order_by(desc(RecognitionObservation.observed_at))
        .limit(limit)
    ).all()

    return {
        "success": True,
        "data": [
            {
                "id": o.id,
                "eventId": o.event_id,
                "employeeId": o.employee_id,
                "employeeName": o.employee.full_name if o.employee else None,
                "cameraId": o.camera_id,
                "channelNo": o.channel_no,
                "zoneId": o.zone_id,
                "observedAt": o.observed_at.isoformat(),
                "similarityScore": o.similarity_score,
                "isUnknown": o.is_unknown,
            }
            for o in obs
        ],
    }


# Internal ingestion router for Python AI Service
internal_router = APIRouter(prefix="/api/internal/presence", tags=["internal-presence"], dependencies=[Depends(require_service_key)])


@internal_router.post("/observations")
def ingest_observation_event(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    """Authenticated endpoint for AI service to deliver camera observations.
    
    CRITICAL: Does NOT create official attendance check-in or checkout events.
    """
    event_id = body.get("eventId")
    if not event_id:
        raise ApiError(400, "eventId is required")

    employee_id = body.get("employeeId")
    camera_id = body.get("cameraId")
    channel_no = int(body.get("channelNo", 1))
    similarity_score = float(body.get("similarityScore", 0.0)) if body.get("similarityScore") is not None else None
    track_ref = body.get("trackRef")
    zone_id = body.get("zoneId")
    is_unknown = bool(body.get("isUnknown", False))

    raw_observed = body.get("observedAt")
    if raw_observed:
        try:
            observed_at = datetime.fromisoformat(str(raw_observed))
            if observed_at.tzinfo is not None:
                observed_at = observed_at.astimezone(timezone.utc).replace(tzinfo=None)
        except Exception:
            observed_at = utcnow()
    else:
        observed_at = utcnow()

    obs, session = presence_engine.ingest_observation(
        db=db,
        event_id=event_id,
        employee_id=employee_id,
        camera_id=camera_id,
        channel_no=channel_no,
        observed_at=observed_at,
        similarity_score=similarity_score,
        track_ref=track_ref,
        zone_id=zone_id,
        is_unknown=is_unknown,
    )
    db.commit()

    return {
        "success": True,
        "data": {
            "observationId": obs.id,
            "presenceStatus": session.current_status if session else None,
        },
    }
