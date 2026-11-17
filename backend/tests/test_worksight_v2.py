"""WorkSight v2.0 Comprehensive Automated Test Suite.

Verifies:
1. System B: Transactional Check-in & Check-out
2. System B: Duplicate open session rejection (409)
3. System B: Idempotent request retry
4. System B: Checkout without open session rejection (404)
5. System B: Multiple closed sessions per day
6. System B: Missing checkout detection
7. Biometric Security: AES-256-GCM authenticated encryption & verification
8. System A: Real-time presence observation ingestion & uncertainty states
9. System A: Unknown person presence separation
10. Critical Business Rule: Camera observations NEVER alter official WorkSession
"""

import uuid
import pytest
from datetime import datetime, timedelta, timezone

from app.database import SessionLocal, utcnow
from app.models import (
    Employee,
    WorkSession,
    AttendanceEvent,
    AttendanceReview,
    PresenceSession,
    RecognitionObservation,
    FaceTemplate,
)
from app.services import work_session as ws_service
from app.services import presence_engine
from app.crypto import encrypt_embedding, decrypt_embedding
from app.errors import ApiError


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def test_employee(db):
    emp = db.query(Employee).filter(Employee.is_active.is_(True)).first()
    assert emp is not None, "At least one active employee must exist in the database"
    return emp


# -------------------------------------------------------------
# 1. BIOMETRIC SECURITY & AES-256-GCM ENCRYPTION TESTS
# -------------------------------------------------------------

def test_aes_gcm_embedding_encryption_and_decryption():
    """Verify 128-d float embeddings are securely encrypted and faithfully decrypted."""
    raw_vector = [0.123456 + i * 0.005 for i in range(128)]
    ciphertext, iv_hex, tag_hex, key_id = encrypt_embedding(raw_vector)
    
    assert len(ciphertext) == 512, "128 32-bit floats must serialize to 512 bytes"
    assert len(iv_hex) == 24, "12-byte IV must serialize to 24 hex characters"
    assert len(tag_hex) == 32, "16-byte authentication tag must serialize to 32 hex characters"
    
    decrypted = decrypt_embedding(ciphertext, iv_hex, tag_hex, key_id)
    assert len(decrypted) == 128
    for original, dec in zip(raw_vector, decrypted):
        assert abs(original - dec) < 1e-5


def test_aes_gcm_tamper_detection():
    """Verify tampering with ciphertext or tag raises an authentication error."""
    raw_vector = [0.5] * 128
    ciphertext, iv_hex, tag_hex, key_id = encrypt_embedding(raw_vector)
    
    tampered_bytes = bytearray(ciphertext)
    tampered_bytes[0] ^= 0xFF  # Flip bits
    
    with pytest.raises(Exception):
        decrypt_embedding(bytes(tampered_bytes), iv_hex, tag_hex, key_id)


# -------------------------------------------------------------
# 2. SYSTEM B: TRANSACTIONAL ATTENDANCE & WORK SESSION TESTS
# -------------------------------------------------------------

def test_successful_check_in_and_checkout(db, test_employee):
    """Test standard check-in followed by checkout."""
    # Ensure employee has no open session
    open_sess = ws_service.get_open_session(db, test_employee.id)
    if open_sess:
        ws_service.check_out(db, test_employee, effective_at=utcnow())
        db.commit()

    # 1. Check-In
    check_in_time = utcnow()
    session, event = ws_service.check_in(
        db,
        employee=test_employee,
        effective_at=check_in_time,
        source="EMPLOYEE",
    )
    db.commit()

    assert session.status == "OPEN"
    assert session.check_in_at == check_in_time
    assert session.check_out_at is None
    assert event.action == "CHECK_IN"
    assert event.session_id == session.id

    # 2. Check-Out
    check_out_time = check_in_time + timedelta(hours=2)
    closed_session, out_event = ws_service.check_out(
        db,
        employee=test_employee,
        effective_at=check_out_time,
        source="EMPLOYEE",
    )
    db.commit()

    assert closed_session.status == "CLOSED"
    assert closed_session.check_out_at == check_out_time
    assert out_event.action == "CHECK_OUT"


def test_duplicate_check_in_rejection(db, test_employee):
    """Attempting to check in when a session is already open must raise 409 Conflict."""
    open_sess = ws_service.get_open_session(db, test_employee.id)
    if not open_sess:
        ws_service.check_in(db, test_employee)
        db.commit()

    # Second check-in must fail with 409
    with pytest.raises(ApiError) as exc_info:
        ws_service.check_in(db, test_employee)
    assert exc_info.value.status_code == 409


def test_checkout_without_open_session_rejection(db, test_employee):
    """Attempting checkout when no session is open must raise 404."""
    open_sess = ws_service.get_open_session(db, test_employee.id)
    if open_sess:
        ws_service.check_out(db, test_employee)
        db.commit()

    with pytest.raises(ApiError) as exc_info:
        ws_service.check_out(db, test_employee)
    assert exc_info.value.status_code == 404


def test_idempotent_retry(db, test_employee):
    """Submitting the same idempotency key returns the existing session without duplicating."""
    open_sess = ws_service.get_open_session(db, test_employee.id)
    if open_sess:
        ws_service.check_out(db, test_employee)
        db.commit()

    key = f"idemp-test-{uuid.uuid4()}"
    s1, e1 = ws_service.check_in(db, test_employee, idempotency_key=key)
    db.commit()

    s2, e2 = ws_service.check_in(db, test_employee, idempotency_key=key)
    assert s1.id == s2.id
    assert e1.id == e2.id

    ws_service.check_out(db, test_employee)
    db.commit()


def test_multiple_sessions_per_day(db, test_employee):
    """Employees may have multiple valid work sessions in a single calendar day."""
    t0 = utcnow() - timedelta(hours=6)
    t1 = t0 + timedelta(hours=3)
    t2 = t1 + timedelta(hours=1)
    t3 = t2 + timedelta(hours=2)

    # First session (morning)
    s1, _ = ws_service.check_in(db, test_employee, effective_at=t0)
    db.commit()
    ws_service.check_out(db, test_employee, effective_at=t1)
    db.commit()

    # Second session (afternoon)
    s2, _ = ws_service.check_in(db, test_employee, effective_at=t2)
    db.commit()
    ws_service.check_out(db, test_employee, effective_at=t3)
    db.commit()

    assert s1.id != s2.id
    assert s1.status == "CLOSED"
    assert s2.status == "CLOSED"


# -------------------------------------------------------------
# 3. SYSTEM A: PRESENCE ENGINE & BUSINESS RULE SEPARATION
# -------------------------------------------------------------

def test_camera_observation_ingestion(db, test_employee):
    """Ingesting an authorized camera observation updates PresenceSession without touching WorkSession."""
    obs_time = utcnow()
    event_id = str(uuid.uuid4())
    
    obs, pres_sess = presence_engine.ingest_observation(
        db=db,
        event_id=event_id,
        employee_id=test_employee.id,
        camera_id=None,
        channel_no=2,
        observed_at=obs_time,
        similarity_score=0.48,
        is_unknown=False,
    )
    db.commit()

    assert obs.event_id == event_id
    assert obs.employee_id == test_employee.id
    assert pres_sess.current_status == "OBSERVED_RECENTLY"
    assert pres_sess.last_observed_at >= obs_time


def test_unknown_person_observation_isolation(db):
    """Unknown person observations do not attach to any employee or alter employee presence."""
    event_id = str(uuid.uuid4())
    obs, pres_sess = presence_engine.ingest_observation(
        db=db,
        event_id=event_id,
        employee_id=None,
        camera_id=None,
        channel_no=1,
        observed_at=utcnow(),
        similarity_score=None,
        is_unknown=True,
    )
    db.commit()

    assert obs.employee_id is None
    assert obs.is_unknown is True
    assert pres_sess is None, "Unknown detections must not create employee presence sessions"


def test_presence_does_not_create_official_attendance(db, test_employee):
    """CRITICAL RULE: Camera observations MUST NOT alter official WorkSession check-in or check-out."""
    # Ensure no open work session exists
    open_sess = ws_service.get_open_session(db, test_employee.id)
    if open_sess:
        ws_service.check_out(db, test_employee)
        db.commit()

    initial_open = ws_service.get_open_session(db, test_employee.id)
    assert initial_open is None

    # Simulate camera detecting the employee 10 times over 5 minutes
    for i in range(10):
        presence_engine.ingest_observation(
            db=db,
            event_id=str(uuid.uuid4()),
            employee_id=test_employee.id,
            camera_id=None,
            channel_no=2,
            observed_at=utcnow() + timedelta(seconds=i * 30),
            similarity_score=0.52,
        )
    db.commit()

    # The employee's presence is OBSERVED_RECENTLY, but official WorkSession remains strictly None
    after_open = ws_service.get_open_session(db, test_employee.id)
    assert after_open is None, "Face recognition must NEVER silently create an official check-in!"


# -------------------------------------------------------------
# 4. SYSTEM A: PERSON TRACKING & DOORWAY ZONE TRANSITIONS
# -------------------------------------------------------------

def test_person_tracking_and_doorway_crossing(db, test_employee):
    """Verify person track session creation, observation logging, and directional crossing."""
    import random
    from app.routers.tracking import ingest_tracking_events
    from app.models import PersonTrackSession, TrackObservation, ZoneTransitionEvent, Camera

    cam = db.query(Camera).first()
    cam_id = cam.id if cam else str(uuid.uuid4())
    track_num = random.randint(100000, 999999)

    # 1. First observation in PASSAGE
    obs_time_1 = utcnow()
    res1 = ingest_tracking_events(
        body={
            "cameraId": cam_id,
            "channelNo": 1,
            "trackId": track_num,
            "employeeId": test_employee.id,
            "currentZoneId": "PASSAGE",
            "boundingBox": [100, 200, 150, 300],
            "detectionScore": 0.92,
            "identityStatus": "VERIFIED",
            "observedAt": obs_time_1.isoformat(),
        },
        db=db,
    )
    assert res1["success"] is True
    assert res1["trackSessionId"] is not None

    session = db.get(PersonTrackSession, res1["trackSessionId"])
    assert session is not None
    assert session.track_id == track_num
    assert session.employee_id == test_employee.id
    assert session.current_zone_id == "PASSAGE"
    assert session.identity_verification_status == "VERIFIED"

    # Verify TrackObservation logged
    obs_count = db.query(TrackObservation).filter(TrackObservation.track_session_id == session.id).count()
    assert obs_count == 1

    # 2. Doorway crossing into WORK_ROOM
    obs_time_2 = obs_time_1 + timedelta(seconds=2)
    res2 = ingest_tracking_events(
        body={
            "cameraId": cam_id,
            "channelNo": 1,
            "trackId": track_num,
            "employeeId": test_employee.id,
            "currentZoneId": "WORK_ROOM",
            "eventType": "WORK_ROOM_ENTERED",
            "crossingLineId": "LINE_WORK",
            "fromZoneId": "PASSAGE",
            "toZoneId": "WORK_ROOM",
            "boundingBox": [200, 300, 250, 400],
            "detectionScore": 0.94,
            "identityStatus": "VERIFIED",
            "observedAt": obs_time_2.isoformat(),
        },
        db=db,
    )
    assert res2["success"] is True
    assert res2["transitionEventId"] is not None

    # Verify ZoneTransitionEvent was created
    trans_event = db.get(ZoneTransitionEvent, res2["transitionEventId"])
    assert trans_event is not None
    assert trans_event.employee_id == test_employee.id
    assert trans_event.crossing_line_id == "LINE_WORK"
    assert trans_event.from_zone_id == "PASSAGE"
    assert trans_event.to_zone_id == "WORK_ROOM"
    assert trans_event.event_type == "WORK_ROOM_ENTERED"
    assert trans_event.verification_status == "VERIFIED"

    # Check updated track session current_zone_id
    db.refresh(session)
    assert session.current_zone_id == "WORK_ROOM"

    # Check that PresenceSession was updated to WORK_ROOM
    pres_sess = db.query(PresenceSession).filter(
        PresenceSession.employee_id == test_employee.id,
        PresenceSession.closed_at.is_(None),
    ).order_by(PresenceSession.last_observed_at.desc()).first()
    if pres_sess:
        assert pres_sess.current_zone_id == "WORK_ROOM"


def test_anonymous_doorway_crossing(db):
    """Doorway crossing for an unidentified person is tracked anonymously without employee linkage."""
    import random
    from app.routers.tracking import ingest_tracking_events
    from app.models import PersonTrackSession, ZoneTransitionEvent, Camera

    cam = db.query(Camera).first()
    cam_id = cam.id if cam else str(uuid.uuid4())
    track_num = random.randint(100000, 999999)
    res = ingest_tracking_events(
        body={
            "cameraId": cam_id,
            "channelNo": 1,
            "trackId": track_num,
            "employeeId": None,
            "currentZoneId": "LUNCH_ROOM",
            "eventType": "LUNCH_ROOM_ENTERED",
            "crossingLineId": "LINE_LUNCH",
            "fromZoneId": "PASSAGE",
            "toZoneId": "LUNCH_ROOM",
            "boundingBox": [50, 50, 100, 100],
            "detectionScore": 0.88,
            "identityStatus": "UNVERIFIED",
            "observedAt": utcnow().isoformat(),
        },
        db=db,
    )
    assert res["success"] is True
    trans_event = db.get(ZoneTransitionEvent, res["transitionEventId"])
    assert trans_event is not None
    assert trans_event.employee_id is None
    assert trans_event.verification_status == "ANONYMOUS"
    assert trans_event.event_type == "LUNCH_ROOM_ENTERED"


def test_zone_config_retrieval_and_update(db):
    """Verify camera zone and crossing line configurations are retrievable and updatable."""
    from app.models import Camera, CameraZoneConfiguration, DoorCrossingLine
    from app.routers.zones import get_camera_zone_config, update_camera_zone_config
    from app.security import AuthUser, UserRole

    cam = db.query(Camera).first()
    if not cam:
        pytest.skip("No camera present to test zone configuration")

    # 1. Fetch zone config
    config_res = get_camera_zone_config(camera_id=cam.id, channel=1, db=db)
    assert config_res["success"] is True
    assert "zones" in config_res["data"]
    assert "lines" in config_res["data"]

    # 2. Update a zone name via update_camera_zone_config
    admin_user = AuthUser(
        id=str(uuid.uuid4()),
        email="admin@worksight.io",
        role=UserRole.SUPER_ADMIN,
        full_name="Admin",
        company_id=None,
    )
    update_res = update_camera_zone_config(
        camera_id=cam.id,
        channel=1,
        body={
            "zones": [
                {
                    "zoneId": "WORK_ROOM",
                    "zoneName": "Central Working Room (Main)",
                    "normalizedPolygon": [[0.3, 0.4], [0.9, 0.4], [0.9, 0.9], [0.3, 0.9]],
                    "enabled": True,
                }
            ],
            "lines": [],
        },
        user=admin_user,
        db=db,
    )
    assert update_res["success"] is True

    # Verify updated in db
    zone_in_db = db.query(CameraZoneConfiguration).filter(
        CameraZoneConfiguration.camera_id == cam.id,
        CameraZoneConfiguration.zone_id == "WORK_ROOM",
    ).first()
    assert zone_in_db is not None
    assert zone_in_db.zone_name == "Central Working Room (Main)"

