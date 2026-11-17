"""System A — Real-Time Employee Presence State Machine.

Maintains observational evidence from camera face recognition.
Expresses presence with explicit uncertainty:
  - OBSERVED_RECENTLY (verified sighting within freshness window, e.g. 120s)
  - NOT_RECENTLY_OBSERVED (no recent sighting; NOT assumed to have left building)
  - SENSOR_UNAVAILABLE (camera coverage offline or degraded)
Deduplicates overlapping observations between Channel 1 and Channel 2.
NEVER writes official check-in or checkout events.
"""

from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Tuple
from sqlalchemy import select, and_, or_, desc
from sqlalchemy.orm import Session

from app.database import utcnow
from app.models import (
    Employee,
    PresenceSession,
    RecognitionObservation,
    CameraHealthEvent,
    Camera,
    WorkSession,
)

FRESHNESS_WINDOW_SEC = 120
DEDUP_WINDOW_SEC = 3


def ingest_observation(
    db: Session,
    event_id: str,
    employee_id: Optional[str],
    camera_id: Optional[str],
    channel_no: int,
    observed_at: datetime,
    similarity_score: Optional[float] = None,
    track_ref: Optional[str] = None,
    zone_id: Optional[str] = None,
    is_unknown: bool = False,
) -> Tuple[RecognitionObservation, Optional[PresenceSession]]:
    """Ingest camera observation evidence and update real-time presence states."""
    now = utcnow()
    
    # 1. Deduplication key (combining employee/unknown, approximate timestamp window)
    bucket = int(observed_at.timestamp() // DEDUP_WINDOW_SEC)
    dedup_key = f"{employee_id or 'unknown'}-{bucket}"

    existing_obs = db.scalar(
        select(RecognitionObservation).where(RecognitionObservation.event_id == event_id)
    )
    if existing_obs:
        return existing_obs, None

    # 2. Store immutable observation record
    obs = RecognitionObservation(
        event_id=event_id,
        employee_id=employee_id,
        camera_id=camera_id,
        channel_no=channel_no,
        zone_id=zone_id,
        observed_at=observed_at,
        received_at=now,
        similarity_score=similarity_score,
        recognition_model="SFace",
        recognition_version="2021dec",
        track_ref=track_ref,
        deduplication_key=dedup_key,
        is_unknown=is_unknown or (employee_id is None),
    )
    db.add(obs)
    db.flush()

    # 3. Unknown faces do not update enrolled employee presence
    if not employee_id:
        return obs, None

    # 4. Update or open presence session for enrolled employee
    session = db.scalar(
        select(PresenceSession)
        .where(PresenceSession.employee_id == employee_id, PresenceSession.closed_at.is_(None))
        .order_by(desc(PresenceSession.last_observed_at))
    )

    if not session:
        session = PresenceSession(
            employee_id=employee_id,
            started_at=observed_at,
            last_observed_at=observed_at,
            current_status="OBSERVED_RECENTLY",
            current_zone_id=zone_id,
            last_camera_id=camera_id,
            last_channel_no=channel_no,
            last_similarity=similarity_score,
        )
        db.add(session)
    else:
        session.last_observed_at = max(session.last_observed_at, observed_at)
        session.current_status = "OBSERVED_RECENTLY"
        if zone_id:
            session.current_zone_id = zone_id
        session.last_camera_id = camera_id
        session.last_channel_no = channel_no
        session.last_similarity = similarity_score
        session.updated_at = now

    db.flush()
    return obs, session


def evaluate_presence_states(db: Session, freshness_sec: int = FRESHNESS_WINDOW_SEC) -> None:
    """Transition stale OBSERVED_RECENTLY sessions to NOT_RECENTLY_OBSERVED."""
    cutoff = utcnow() - timedelta(seconds=freshness_sec)
    stale_sessions = db.scalars(
        select(PresenceSession).where(
            PresenceSession.current_status == "OBSERVED_RECENTLY",
            PresenceSession.last_observed_at < cutoff,
            PresenceSession.closed_at.is_(None),
        )
    ).all()

    for sess in stale_sessions:
        sess.current_status = "NOT_RECENTLY_OBSERVED"
        sess.updated_at = utcnow()
    db.flush()


def get_current_presence_overview(db: Session) -> List[Dict[str, Any]]:
    """Return latest presence snapshot for all active employees with explicit location uncertainty."""
    evaluate_presence_states(db)
    employees = db.scalars(select(Employee).where(Employee.is_active.is_(True)).order_by(Employee.employee_code)).all()
    results = []
    now = utcnow()

    for emp in employees:
        session = db.scalar(
            select(PresenceSession)
            .where(PresenceSession.employee_id == emp.id)
            .order_by(desc(PresenceSession.last_observed_at))
        )
        # Check official System B work session
        open_ws = db.scalar(
            select(WorkSession)
            .where(WorkSession.employee_id == emp.id, WorkSession.status == "OPEN")
        )
        closed_ws = db.scalar(
            select(WorkSession)
            .where(WorkSession.employee_id == emp.id, WorkSession.status == "CLOSED")
            .order_by(desc(WorkSession.check_out_at))
        )
        if open_ws:
            attendance_status = "CHECKED_IN"
        elif closed_ws:
            attendance_status = "CHECKED_OUT"
        else:
            attendance_status = "NOT_CHECKED_IN"

        status = session.current_status if session else "NOT_RECENTLY_OBSERVED"
        is_observed_now = (status == "OBSERVED_RECENTLY")
        freshness_sec = int((now - session.last_observed_at).total_seconds()) if session and session.last_observed_at else None

        last_obs_iso = None
        if session and session.last_observed_at:
            last_obs_iso = session.last_observed_at.isoformat()
            if not last_obs_iso.endswith("Z"):
                last_obs_iso += "Z"

        source_camera_label = None
        if session and session.last_channel_no:
            lens_name = "Ch 1 (Wide Lens)" if session.last_channel_no == 1 else "Ch 2 (Pan-Tilt)"
            source_camera_label = f"EZVIZ CS-H7c • {lens_name}"

        results.append(
            {
                "employeeId": emp.id,
                "fullName": emp.full_name,
                "employeeCode": emp.employee_code,
                "department": emp.department.name if emp.department else None,
                "status": status,
                "attendanceStatus": attendance_status,
                "locationUncertainty": not is_observed_now,
                "identityVerificationStatus": "VERIFIED" if (session and session.last_similarity and session.last_similarity >= 0.24) else "UNVERIFIED",
                "lastObservedAt": last_obs_iso,
                "trackingFreshnessSec": freshness_sec,
                "lastCameraId": session.last_camera_id if session else None,
                "lastChannelNo": session.last_channel_no if session else None,
                "sourceCamera": source_camera_label,
                "lastSimilarity": session.last_similarity if session else None,
                "currentZoneId": session.current_zone_id if session else None,
            }
        )
    return results
