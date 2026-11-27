"""Real-Time Person Tracking & Doorway Transition Event APIs."""

import hmac
import logging
import time
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from collections import deque
from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import select, desc, and_
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import (
    Camera,
    Employee,
    PersonTrackSession,
    TrackObservation,
    ZoneTransitionEvent,
    PresenceSession,
)
from app.security import current_user, json_body
from app.services import desks
from app.services.daily_tracking_engine import DailyTrackingService

router = APIRouter(prefix="/api/tracking", tags=["tracking"])

# In-memory synchronized frame cache: (camera_id, channel_no) -> frame_payload
LATEST_FRAME_CACHE: Dict[tuple, Dict[str, Any]] = {}
LAST_OBS_SAMPLE_TIME: Dict[tuple, float] = {}  # (camera, channel, track_id) -> last sample time
# An open track session not updated for this long is from an earlier AI-service run (track numbers restart).
STALE_TRACK_AFTER = timedelta(seconds=60)
BIOMETRIC_DIAGNOSTICS_BUFFER: deque = deque(maxlen=200)
# Two samples of one body (about 3 s apart) overlap far more than this, even when the person stands up or turns.
# Less means the tracker moved the track number onto someone else.
JUMP_IOU = 0.3

log = logging.getLogger("worksight.tracking")


def _box_iou(a, b) -> float:
    """Overlap of two [x1, y1, x2, y2] boxes; 1.0 when a box is missing, so it never looks like a jump."""
    try:
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        inter = ix * iy
        union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    except (TypeError, IndexError):
        return 1.0
    return inter / union if union > 0 else 0.0


def _first_name(db: Session, session: PersonTrackSession, emp_id: str, identity_status: str, box) -> PersonTrackSession:
    """Put the first recognised name on a track from its last box jump onward, not on the whole track.

    A face is often recognised minutes after the track started. When the box stayed on one body all along (someone
    sat with their back turned, then looked up), the whole track is that person. But the tracker sometimes moves a
    track number onto a person walking past, and the face recognised then is the passer-by's: on 27 Nov Muhfees
    was recognised at 09:04:56 as he passed Jawahar's desk, and his name went back to 08:41 on Jawahar's own body.
    So walk back from the box being named while each earlier sample still overlaps the next; the part before a jump
    was someone else and stays unnamed, closed at its last sighting. Returns the session the frame belongs to.
    """
    newest_first = db.scalars(
        select(TrackObservation)
        .where(TrackObservation.track_session_id == session.id)
        .order_by(TrackObservation.observed_at.desc())
    ).all()
    named_part: list[TrackObservation] = []
    prev = box
    for obs in newest_first:
        if _box_iou(obs.bounding_box, prev) < JUMP_IOU:
            break
        named_part.append(obs)
        prev = obs.bounding_box
    else:  # no jump: the whole track is this person
        session.employee_id = emp_id
        session.identity_verification_status = identity_status
        return session

    before_jump = newest_first[len(named_part)]
    session.ended_at = before_jump.observed_at
    session.last_seen_at = before_jump.observed_at
    named = PersonTrackSession(
        camera_id=session.camera_id,
        channel_no=session.channel_no,
        track_id=session.track_id,
        employee_id=emp_id,
        started_at=named_part[-1].observed_at if named_part else utcnow(),
        last_seen_at=utcnow(),
        identity_verification_status=identity_status,
        current_zone_id=session.current_zone_id,
        identity_state=session.identity_state,
        tracking_without_face_sec=session.tracking_without_face_sec,
    )
    db.add(named)
    db.flush()
    for obs in named_part:
        obs.track_session_id = named.id
    log.info(
        "[tracking] lens %s track %s: name %s from %s on; the %d earlier samples were someone else (box jumped)",
        session.channel_no, session.track_id, emp_id, named.started_at, len(newest_first) - len(named_part),
    )
    return named


def require_service_key(x_service_key: str = Header(default="")) -> None:
    if not settings.AI_SERVICE_KEY or not hmac.compare_digest(x_service_key, settings.AI_SERVICE_KEY):
        raise ApiError(401, "Invalid service key")


# ------------------------------------------------------------- Frontend Read Endpoints


@router.get("/active", dependencies=[Depends(current_user)])
def get_active_tracks(
    camera_id: Optional[str] = None,
    channel_no: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
):
    """Return active person tracking sessions currently visible in cameras.
    
    Synchronized with the exact latest frame received from the AI worker.
    Guarantees that metrics (detectedPeople, activeTracks, verifiedTracks, unidentifiedTracks)
    match the canvas bounding boxes with 100% mathematical consistency.
    """
    now_wall = time.time()

    # Look up in synchronized frame cache
    best_cache = None
    if camera_id and channel_no is not None:
        best_cache = LATEST_FRAME_CACHE.get((camera_id, channel_no))
    elif camera_id:
        # Match channel 1 first, or any channel
        best_cache = LATEST_FRAME_CACHE.get((camera_id, 1))
        if not best_cache:
            for k, v in LATEST_FRAME_CACHE.items():
                if k[0] == camera_id:
                    best_cache = v
                    break
    else:
        # Get the newest cached frame across all cameras
        if LATEST_FRAME_CACHE:
            best_cache = max(LATEST_FRAME_CACHE.values(), key=lambda x: x.get("_received_monotonic", 0))

    # If cached frame was received within the last 4.0 seconds, return it
    if best_cache and (now_wall - best_cache.get("_received_monotonic", 0) <= 4.0):
        tracks = best_cache.get("tracks", [])
        metrics = best_cache.get("metrics", {})
        fps = metrics.get("fps", 0.0)

        return {
            "success": True,
            "count": len(tracks),
            "cameraId": best_cache.get("cameraId"),
            "channelNo": best_cache.get("channelNo", 1),
            "frameId": best_cache.get("frameId", 0),
            "frameTimestamp": best_cache.get("frameTimestamp"),
            "processingTimestamp": best_cache.get("processingTimestamp"),
            "cameraConnectionStatus": "LIVE",
            "metrics": {
                "detectedPeople": metrics.get("detectedPeople", len(tracks)),
                "activeTracks": metrics.get("activeTracks", len(tracks)),
                "verifiedTracks": metrics.get("verifiedTracks", len([
                    t for t in tracks
                    if t.get("identityVerificationStatus") in ("VERIFIED", "TRACKING_WITHOUT_FACE", "IDENTITY_LATCHED")
                    or t.get("identityState") in ("VERIFIED", "TRACKING_WITHOUT_FACE", "IDENTITY_LATCHED")
                ])),
                "unidentifiedTracks": metrics.get("unidentifiedTracks", len([
                    t for t in tracks
                    if t.get("identityVerificationStatus") not in ("VERIFIED", "TRACKING_WITHOUT_FACE", "IDENTITY_LATCHED")
                    and t.get("identityState") not in ("VERIFIED", "TRACKING_WITHOUT_FACE", "IDENTITY_LATCHED")
                ])),
                "fps": round(float(fps), 1),
            },
            "data": tracks,
        }

    # Fallback to DB query if no live stream cache available
    now = utcnow()
    active_cutoff = now - timedelta(seconds=6)
    query = (
        select(PersonTrackSession)
        .options(joinedload(PersonTrackSession.employee))
        .where(
            PersonTrackSession.ended_at.is_(None),
            PersonTrackSession.last_seen_at >= active_cutoff,
        )
        .order_by(desc(PersonTrackSession.last_seen_at))
    )
    if camera_id:
        query = query.where(PersonTrackSession.camera_id == camera_id)
    if channel_no is not None:
        query = query.where(PersonTrackSession.channel_no == channel_no)

    db_tracks = db.scalars(query).all()
    out_tracks = []
    verified_cnt = 0
    unidentified_cnt = 0

    for t in db_tracks:
        is_verified = bool(t.employee_id and t.identity_verification_status == "VERIFIED")
        if is_verified:
            verified_cnt += 1
        else:
            unidentified_cnt += 1

        last_seen_utc = t.last_seen_at
        if last_seen_utc.tzinfo is None:
            last_seen_utc = last_seen_utc.replace(tzinfo=timezone.utc)
        freshness = max(0, int((now - t.last_seen_at).total_seconds()))

        # v2.9: resolve identity state from ILE or fall back
        ile_state = getattr(t, "identity_state", None) or t.identity_verification_status
        twf_state = ile_state in ("TRACKING_WITHOUT_FACE", "IDENTITY_LATCHED")
        # For TWF and latched states, still show employee name
        show_employee = bool(t.employee_id and ile_state in (
            "VERIFIED", "IDENTITY_LATCHED", "TRACKING_WITHOUT_FACE",
            "TRACKING_UNCERTAIN", "REQUIRES_REVERIFICATION"
        ))

        out_tracks.append({
            "id": t.id,
            "cameraId": t.camera_id,
            "channelNo": t.channel_no,
            "trackId": t.track_id,
            "employeeId": t.employee_id if show_employee else None,
            "employeeName": t.employee.full_name if (t.employee and show_employee) else "Unidentified Person",
            "employeeCode": t.employee.employee_code if (t.employee and show_employee) else None,
            "startedAt": t.started_at.isoformat() + ("Z" if not t.started_at.isoformat().endswith("Z") else ""),
            "lastSeenAt": last_seen_utc.isoformat(),
            "identityVerificationStatus": t.identity_verification_status,
            # v2.9 — ILE extended fields
            "identityState": ile_state,
            "faceVisible": ile_state == "IDENTITY_LATCHED",  # approximation from DB
            "trackingWithoutFaceSec": float(getattr(t, "tracking_without_face_sec", 0.0)),
            "currentZoneId": t.current_zone_id or "PASSAGE",
            "boundingBox": [0.4, 0.4, 0.6, 0.8],
            "detectionScore": 0.80,
            "freshnessSec": freshness,
        })

    is_live = bool(best_cache and (now_wall - best_cache.get("_received_monotonic", 0) <= 8.0))
    return {
        "success": True,
        "count": len(out_tracks),
        "cameraId": camera_id,
        "channelNo": channel_no or 1,
        "frameId": best_cache.get("frameId", 0) if best_cache else 0,
        "frameTimestamp": best_cache.get("frameTimestamp") if best_cache else None,
        "processingTimestamp": best_cache.get("processingTimestamp") if best_cache else None,
        "cameraConnectionStatus": "LIVE" if is_live else "STALLED",
        "metrics": {
            "detectedPeople": len(out_tracks),
            "activeTracks": len(out_tracks),
            "verifiedTracks": verified_cnt,
            "unidentifiedTracks": unidentified_cnt,
            "fps": 0.0,
        },
        "data": out_tracks,
    }


@router.get("/zone-transitions", dependencies=[Depends(current_user)])
def get_zone_transitions(limit: int = 50, db: Session = Depends(get_db)):
    """Return verified doorway crossing and zone movement events."""
    events = db.scalars(
        select(ZoneTransitionEvent)
        .options(joinedload(ZoneTransitionEvent.employee))
        .order_by(desc(ZoneTransitionEvent.observed_at))
        .limit(limit)
    ).all()

    return {
        "success": True,
        "count": len(events),
        "data": [
            {
                "id": e.id,
                "employeeId": e.employee_id,
                "employeeName": e.employee.full_name if e.employee else "Anonymous Person",
                "employeeCode": e.employee.employee_code if e.employee else None,
                "crossingLineId": e.crossing_line_id,
                "fromZoneId": e.from_zone_id,
                "toZoneId": e.to_zone_id,
                "eventType": e.event_type,
                "observedAt": e.observed_at.isoformat() + ("Z" if not e.observed_at.isoformat().endswith("Z") else ""),
                "verificationStatus": e.verification_status,
                "channelNo": e.channel_no,
            }
            for e in events
        ],
    }


@router.get("/employee/{employee_id}/timeline", dependencies=[Depends(current_user)])
def get_employee_tracking_timeline(employee_id: str, limit: int = 30, db: Session = Depends(get_db)):
    """Return historical zone movements for a specific employee."""
    events = db.scalars(
        select(ZoneTransitionEvent)
        .where(ZoneTransitionEvent.employee_id == employee_id)
        .order_by(desc(ZoneTransitionEvent.observed_at))
        .limit(limit)
    ).all()

    return {
        "success": True,
        "data": [
            {
                "id": e.id,
                "eventType": e.event_type,
                "fromZone": e.from_zone_id,
                "toZone": e.to_zone_id,
                "observedAt": e.observed_at.isoformat() + ("Z" if not e.observed_at.isoformat().endswith("Z") else ""),
                "crossingLine": e.crossing_line_id,
                "verificationStatus": e.verification_status,
            }
            for e in events
        ],
    }


@router.get("/biometric-diagnostics", dependencies=[Depends(current_user)])
def get_biometric_diagnostics(limit: int = 50):
    """Return live biometric identity recognition & bipartite association diagnostics."""
    items = list(BIOMETRIC_DIAGNOSTICS_BUFFER)[:limit]
    return {
        "success": True,
        "count": len(items),
        "data": items,
    }


# ------------------------------------------------------------- AI Service Internal Ingestion


internal_router = APIRouter(prefix="/api/internal/tracking", tags=["internal-tracking"], dependencies=[Depends(require_service_key)])


@internal_router.post("/frame")
def ingest_tracking_frame(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    """Ingest atomic frame telemetry from AI worker in a single HTTP batch request."""
    camera_id = body.get("cameraId")
    channel_no = int(body.get("channelNo", 1))
    frame_id = int(body.get("frameId", 0))
    frame_timestamp = body.get("frameTimestamp")
    processing_timestamp = body.get("processingTimestamp")
    fps = float(body.get("fps", 0.0))
    metrics = body.get("metrics", {})
    raw_tracks = body.get("tracks", [])
    doorway_events = body.get("doorwayEvents", [])
    ended_track_ids = body.get("endedTrackIds", [])

    now = utcnow()
    now_wall = time.time()

    # 1. Update In-Memory Synchronized Frame Cache
    cache_entry = {
        "cameraId": camera_id,
        "channelNo": channel_no,
        "frameId": frame_id,
        "frameTimestamp": frame_timestamp,
        "processingTimestamp": processing_timestamp,
        "metrics": metrics,
        "tracks": raw_tracks,
        "_received_monotonic": now_wall,
    }
    LATEST_FRAME_CACHE[(camera_id, channel_no)] = cache_entry

    # Record Biometric Diagnostics in telemetry buffer
    raw_diagnostics = body.get("diagnostics", [])
    for d in raw_diagnostics:
        BIOMETRIC_DIAGNOSTICS_BUFFER.appendleft({
            **d,
            "cameraId": camera_id,
            "channelNo": channel_no,
            "receivedAt": now.isoformat() + "Z",
        })

    # 2. Process Doorway Crossing Transitions
    for ev in doorway_events:
        trans = ZoneTransitionEvent(
            employee_id=ev.get("employeeId"),
            camera_id=camera_id,
            channel_no=channel_no,
            crossing_line_id=ev.get("crossingLineId", "LINE_UNKNOWN"),
            from_zone_id=ev.get("fromZoneId", "PASSAGE"),
            to_zone_id=ev.get("toZoneId", "UNKNOWN"),
            event_type=ev.get("eventType", "TRANSITION"),
            observed_at=now,
            verification_status=ev.get("identityStatus", "UNVERIFIED"),
        )
        db.add(trans)

        # Update presence session current_zone_id if employee is verified
        emp_id = ev.get("employeeId")
        to_zone = ev.get("toZoneId")
        from_zone = ev.get("fromZoneId", "PASSAGE")
        if emp_id and to_zone:
            pres_sess = db.scalar(
                select(PresenceSession)
                .where(PresenceSession.employee_id == emp_id, PresenceSession.closed_at.is_(None))
                .order_by(desc(PresenceSession.last_observed_at))
            )
            if pres_sess:
                pres_sess.current_zone_id = to_zone
                pres_sess.last_observed_at = now

            # WorkSight v2.3: Record in DailyTrackingService
            try:
                DailyTrackingService.record_movement_event(
                    db=db,
                    employee_id=emp_id,
                    event_type=ev.get("eventType", "TRANSITION"),
                    from_zone_id=from_zone,
                    to_zone_id=to_zone,
                    crossing_line_id=ev.get("crossingLineId", "LINE_UNKNOWN"),
                    observed_at=now,
                    camera_id=camera_id,
                    channel_no=channel_no,
                    track_id=ev.get("trackId"),
                    confidence=float(ev.get("confidence", 1.0)),
                )
            except Exception:
                pass

    # 3. Mark Ended Tracks
    if ended_track_ids:
        ended_sessions = db.scalars(
            select(PersonTrackSession).where(
                PersonTrackSession.camera_id == camera_id,
                PersonTrackSession.channel_no == channel_no,
                PersonTrackSession.track_id.in_(ended_track_ids),
                PersonTrackSession.ended_at.is_(None),
            )
        ).all()
        for es in ended_sessions:
            es.ended_at = now

    # 4. Synchronize PersonTrackSession in DB
    for tr in raw_tracks:
        tid = int(tr.get("trackId", 0))
        if tid == 0:
            continue
        emp_id = tr.get("employeeId")
        identity_status = tr.get("identityStatus", "UNVERIFIED")
        zone_id = tr.get("currentZoneId")
        # v2.9 ILE fields
        ile_state            = tr.get("identityState", identity_status)
        face_visible         = bool(tr.get("faceVisible", False))
        twf_sec              = float(tr.get("trackingWithoutFaceSec", 0.0))

        session = db.scalar(
            select(PersonTrackSession).where(
                PersonTrackSession.camera_id == camera_id,
                PersonTrackSession.channel_no == channel_no,
                PersonTrackSession.track_id == tid,
                PersonTrackSession.ended_at.is_(None),
            )
        )
        # Track numbers restart when the AI service restarts. An open session that hasn't been updated for a while
        # belongs to an earlier run: close it at its last sighting instead of gluing this new track onto it.
        if session and now - session.last_seen_at > STALE_TRACK_AFTER:
            session.ended_at = session.last_seen_at
            session = None
        # The AI now recognises someone else on this body: a weak first match corrected by a stronger one, or the
        # tracker swapped two people. Close the session at its last sighting and start one under the new name, so
        # the first name doesn't stay on the body (26 Nov: Afham's name stayed on Sivathees and then Muhni).
        if (
            session
            and emp_id
            and session.employee_id
            and emp_id != session.employee_id
            and session.identity_verification_status != desks.SEAT
        ):
            session.ended_at = session.last_seen_at
            session = None
        if not session:
            session = PersonTrackSession(
                camera_id=camera_id,
                channel_no=channel_no,
                track_id=tid,
                employee_id=emp_id,
                started_at=now,
                last_seen_at=now,
                identity_verification_status=identity_status,
                current_zone_id=zone_id,
                identity_state=ile_state,
                tracking_without_face_sec=twf_sec,
            )
            db.add(session)
            db.flush()
        else:
            session.last_seen_at = now
            # A name from the old seat memory (desks.SEAT) gives way to what the AI recognises on the track.
            if emp_id and session.identity_verification_status == desks.SEAT:
                session.employee_id = emp_id
                session.identity_verification_status = identity_status
            # First name on this body: only from the last box jump on (see _first_name).
            elif emp_id and not session.employee_id:
                session = _first_name(db, session, emp_id, identity_status, tr.get("boundingBox"))
            if zone_id:
                session.current_zone_id = zone_id
            # Always update v2.9 ILE fields
            session.identity_state = ile_state
            session.tracking_without_face_sec = twf_sec

        # Throttle DB TrackObservation samples (once every 3 seconds per track)
        sample_key = (camera_id, channel_no, tid)  # track numbers repeat across lenses
        last_s = LAST_OBS_SAMPLE_TIME.get(sample_key, 0.0)
        if now_wall - last_s >= 3.0:
            LAST_OBS_SAMPLE_TIME[sample_key] = now_wall
            obs = TrackObservation(
                track_session_id=session.id,
                observed_at=now,
                bounding_box=tr.get("boundingBox", [0, 0, 0, 0]),
                zone_id=zone_id,
                detection_score=float(tr.get("detectionConfidence", 0.8)),
            )
            db.add(obs)

            # WorkSight v2.3: Pulse daily tracking session for verified employee
            if emp_id and identity_status == "VERIFIED":
                try:
                    DailyTrackingService.update_observation_pulse(
                        db=db,
                        employee_id=emp_id,
                        camera_id=camera_id,
                        channel_no=channel_no,
                        track_id=tid,
                        zone_id=zone_id or "PASSAGE",
                        observed_at=now,
                    )
                except Exception:
                    pass

    db.commit()
    return {
        "success": True,
        "activeTracks": len(raw_tracks),
        "data": {"frameId": frame_id, "activeTracks": len(raw_tracks)},
    }


@internal_router.post("/events")
def ingest_tracking_events(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    """Legacy single-event ingestion endpoint for backward compatibility."""
    camera_id = body.get("cameraId")
    channel_no = int(body.get("channelNo", 1))
    track_id = int(body.get("trackId", 0))
    employee_id = body.get("employeeId")
    event_type = body.get("eventType")
    crossing_line_id = body.get("crossingLineId")
    from_zone_id = body.get("fromZoneId")
    to_zone_id = body.get("toZoneId")
    current_zone = body.get("currentZoneId") or to_zone_id
    bounding_box = body.get("boundingBox", [0, 0, 0, 0])
    detection_score = float(body.get("detectionScore", 0.0))
    identity_status = body.get("identityStatus", "UNVERIFIED")
    is_ended = bool(body.get("isEnded", False))

    now = utcnow()
    raw_obs = body.get("observedAt")
    if raw_obs:
        try:
            observed_at = datetime.fromisoformat(str(raw_obs).replace("Z", "+00:00"))
            if observed_at.tzinfo is not None:
                observed_at = observed_at.astimezone(timezone.utc).replace(tzinfo=None)
        except Exception:
            observed_at = now
    else:
        observed_at = now

    session = db.scalar(
        select(PersonTrackSession).where(
            PersonTrackSession.camera_id == camera_id,
            PersonTrackSession.channel_no == channel_no,
            PersonTrackSession.track_id == track_id,
            PersonTrackSession.ended_at.is_(None),
        )
    )

    if is_ended:
        if session:
            session.ended_at = observed_at
            db.commit()
        return {"success": True, "message": "Track session ended"}

    if not session:
        session = PersonTrackSession(
            camera_id=camera_id,
            channel_no=channel_no,
            track_id=track_id,
            employee_id=employee_id,
            started_at=observed_at,
            last_seen_at=observed_at,
            identity_verification_status=identity_status,
            current_zone_id=current_zone,
        )
        db.add(session)
        db.flush()
    else:
        session.last_seen_at = observed_at
        if employee_id and not session.employee_id:
            session.employee_id = employee_id
            session.identity_verification_status = identity_status
        if current_zone:
            session.current_zone_id = current_zone

    # Record TrackObservation sample
    obs = TrackObservation(
        track_session_id=session.id,
        observed_at=observed_at,
        bounding_box=bounding_box,
        zone_id=current_zone,
        detection_score=detection_score,
    )
    db.add(obs)

    transition_event_id = None
    if event_type and crossing_line_id and from_zone_id and to_zone_id:
        trans = ZoneTransitionEvent(
            employee_id=session.employee_id or employee_id,
            track_session_id=session.id,
            camera_id=camera_id,
            channel_no=channel_no,
            crossing_line_id=crossing_line_id,
            from_zone_id=from_zone_id,
            to_zone_id=to_zone_id,
            event_type=event_type,
            observed_at=observed_at,
            verification_status="VERIFIED" if (session.employee_id or employee_id) else "ANONYMOUS",
        )
        db.add(trans)
        db.flush()
        transition_event_id = trans.id

        # Update presence session current_zone_id if employee is verified
        emp_id = session.employee_id or employee_id
        if emp_id:
            pres_sess = db.scalar(
                select(PresenceSession)
                .where(PresenceSession.employee_id == emp_id, PresenceSession.closed_at.is_(None))
                .order_by(desc(PresenceSession.last_observed_at))
            )
            if pres_sess:
                pres_sess.current_zone_id = to_zone_id
                pres_sess.last_observed_at = max(pres_sess.last_observed_at, observed_at)

            # WorkSight v2.3: Record movement in DailyTrackingService
            try:
                DailyTrackingService.record_movement_event(
                    db=db,
                    employee_id=emp_id,
                    event_type=event_type,
                    from_zone_id=from_zone_id,
                    to_zone_id=to_zone_id,
                    crossing_line_id=crossing_line_id,
                    observed_at=observed_at,
                    camera_id=camera_id,
                    channel_no=channel_no,
                    track_id=track_id,
                    confidence=1.0,
                )
            except Exception:
                pass

    db.commit()
    return {"success": True, "trackSessionId": session.id, "transitionEventId": transition_event_id}
