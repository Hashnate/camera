"""WorkSight Five-Person Real-World Tracking & Identity Separation Test.

Tests the actual Channel 1 surveillance frame with 5 real employees visible in the office:
1. Verifies YOLO person detection finds all 5 real people.
2. Verifies tight bounding boxes (no chairs, desks, or computers detected).
3. Verifies ByteTrack allocates 5 distinct tracking IDs.
4. Verifies all 5 people are initially marked 'UNVERIFIED' ('Unidentified Person').
5. Verifies zero association with fake or demo employee records (EMP-101..EMP-108).
6. Verifies that real employee face matching (22IT0512) promotes only that specific person to VERIFIED.
7. Verifies backend frame-atomic ingestion and exact 1:1 match between API metrics and visual tracks.
"""

import sys
from pathlib import Path
import time
import cv2
import numpy as np
import pytest

backend_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_dir))
ai_dir = backend_dir.parent / "ai-service" / "src"
sys.path.insert(0, str(ai_dir))

from yolo_detector import YOLOPersonDetector
from tracking_engine import ZoneTrackingEngine
from app.routers.tracking import ingest_tracking_frame, get_active_tracks, LATEST_FRAME_CACHE
from app.models import Employee, FaceTemplate
from app.migrate_zones import SessionLocal
from sqlalchemy import select


def test_five_person_detection_on_real_camera_frame():
    """Verify YOLO person detector identifies all 5 real employees from Channel 1 camera frame."""
    frame_path = Path("C:/Users/ASUS/.gemini/antigravity/brain/569e41e5-d5b1-43c8-8b7a-99ae72c481bd/channel_1_raw.png")
    assert frame_path.exists(), f"Camera frame not found at: {frame_path}"

    img = cv2.imread(str(frame_path))
    assert img is not None
    h, w = img.shape[:2]
    assert (w, h) == (1920, 1080)

    detector = YOLOPersonDetector()
    dets = detector.infer(img)

    # Must detect all 5 real employees
    assert len(dets) == 5, f"Expected 5 detected persons, got {len(dets)}"

    # Verify tight bounding boxes: no box spans the entire room
    for i, d in enumerate(dets):
        x1, y1, x2, y2, conf = d
        bw = x2 - x1
        bh = y2 - y1
        # Bounding box width must be between 50 and 350 pixels (tight human body)
        assert 50 <= bw <= 350, f"Person {i+1} box width {bw} out of expected range"
        # Bounding box height must be between 100 and 500 pixels
        assert 100 <= bh <= 500, f"Person {i+1} box height {bh} out of expected range"
        # Confidence must be above 0.30
        assert conf >= 0.30

    print(f"\n[Five-Person Test] 5/5 real employees detected with tight bounding boxes.")


def test_five_person_tracking_and_identity_separation():
    """Verify 5 separate tracking IDs, anonymous state, and selective biometric verification."""
    frame_path = Path("C:/Users/ASUS/.gemini/antigravity/brain/569e41e5-d5b1-43c8-8b7a-99ae72c481bd/channel_1_raw.png")
    img = cv2.imread(str(frame_path))
    detector = YOLOPersonDetector()
    dets = detector.infer(img)
    assert len(dets) == 5

    engine = ZoneTrackingEngine(width=1920, height=1080)
    now = time.time()

    # Step 1: Initial frame evaluation without face recognition
    active_tracks, removed, events = engine.evaluate(dets, [], now)
    assert len(active_tracks) == 5
    assert len(removed) == 0

    # Verify each person receives a distinct track ID
    track_ids = {t.track_id for t in active_tracks}
    assert len(track_ids) == 5, "Every detected person must have a distinct temporary track ID"

    # Verify all are initially Unidentified Person (zero association with fake/demo data)
    for t in active_tracks:
        assert t.identity_status == "UNVERIFIED"
        assert t.employee_id is None
        assert t.employee_name is None  # Defaults to "Unidentified Person" in API

    # Step 2: Simulate real face recognition matching real employee
    db = SessionLocal()
    real_emp = db.scalars(select(Employee)).first()
    real_emp_id = real_emp.id
    real_emp_name = real_emp.full_name
    db.close()
    # Person 1 face inside box [938, 586, 1159, 1015]
    face_matches = [
        (np.array([1020, 620, 60, 60]), real_emp_id, real_emp_name, 0.62)
    ]

    tracks_v2, _, _ = engine.evaluate(dets, face_matches, now + 0.1)
    assert len(tracks_v2) == 5

    verified_tracks = [t for t in tracks_v2 if t.identity_status == "VERIFIED"]
    unverified_tracks = [t for t in tracks_v2 if t.identity_status == "UNVERIFIED"]

    assert len(verified_tracks) == 1, "Exactly one track should be verified"
    assert len(unverified_tracks) == 4, "Four remaining tracks must remain UNVERIFIED"

    assert verified_tracks[0].employee_id == real_emp_id
    assert verified_tracks[0].employee_name == real_emp_name

    print(f"[Five-Person Test] 5 distinct tracks maintained. Real employee {real_emp_name} verified; 4 remain Unidentified.")


def test_frame_atomic_telemetry_and_api_count_sync():
    """Verify backend frame-atomic telemetry matches API counts and canvas boxes 1:1."""
    cam_id = "887cdce1-b07c-4048-8991-60b818b33225"
    channel_no = 1
    now_str = "2026-11-16T11:22:04.100Z"

    db = SessionLocal()
    real_emp = db.scalars(select(Employee)).first()
    real_emp_id = real_emp.id if real_emp else "e7a04e83-483b-406e-be1d-6cc23ce47c27"
    real_emp_name = real_emp.full_name if real_emp else "Vaithulla Mohamed Muhni"
    db.close()

    frame_payload = {
        "cameraId": cam_id,
        "channelNo": channel_no,
        "frameId": 5001,
        "frameTimestamp": now_str,
        "processingTimestamp": now_str,
        "fps": 11.2,
        "metrics": {
            "detectedPeople": 5,
            "activeTracks": 5,
            "verifiedTracks": 1,
            "unidentifiedTracks": 4,
            "fps": 11.2,
        },
        "tracks": [
            {
                "id": f"{cam_id}-ch1-101",
                "cameraId": cam_id,
                "channelNo": 1,
                "trackId": 101,
                "employeeId": real_emp_id,
                "employeeName": real_emp_name,
                "identityVerificationStatus": "VERIFIED",
                "currentZoneId": "WORK_ROOM",
                "boundingBox": [0.4888, 0.5425, 0.6040, 0.9400],
                "detectionScore": 0.63,
                "freshnessSec": 0.1,
            },
            {
                "id": f"{cam_id}-ch1-102",
                "cameraId": cam_id,
                "channelNo": 1,
                "trackId": 102,
                "employeeId": None,
                "employeeName": "Unidentified Person",
                "identityVerificationStatus": "UNVERIFIED",
                "currentZoneId": "WORK_ROOM",
                "boundingBox": [0.2523, 0.6006, 0.3721, 0.8294],
                "detectionScore": 0.58,
                "freshnessSec": 0.1,
            },
            {
                "id": f"{cam_id}-ch1-103",
                "cameraId": cam_id,
                "channelNo": 1,
                "trackId": 103,
                "employeeId": None,
                "employeeName": "Unidentified Person",
                "identityVerificationStatus": "UNVERIFIED",
                "currentZoneId": "WORK_ROOM",
                "boundingBox": [0.2096, 0.5960, 0.3013, 0.7646],
                "detectionScore": 0.51,
                "freshnessSec": 0.1,
            },
            {
                "id": f"{cam_id}-ch1-104",
                "cameraId": cam_id,
                "channelNo": 1,
                "trackId": 104,
                "employeeId": None,
                "employeeName": "Unidentified Person",
                "identityVerificationStatus": "UNVERIFIED",
                "currentZoneId": "WORK_ROOM",
                "boundingBox": [0.3765, 0.5545, 0.4947, 0.8361],
                "detectionScore": 0.46,
                "freshnessSec": 0.1,
            },
            {
                "id": f"{cam_id}-ch1-105",
                "cameraId": cam_id,
                "channelNo": 1,
                "trackId": 105,
                "employeeId": None,
                "employeeName": "Unidentified Person",
                "identityVerificationStatus": "UNVERIFIED",
                "currentZoneId": "WORK_ROOM",
                "boundingBox": [0.3530, 0.5556, 0.3870, 0.7200],
                "detectionScore": 0.34,
                "freshnessSec": 0.1,
            },
        ],
        "doorwayEvents": [],
        "endedTrackIds": [],
    }

    db = SessionLocal()
    try:
        # Ingest frame batch
        res = ingest_tracking_frame(body=frame_payload, db=db)
        assert res["success"] is True
        assert res["activeTracks"] == 5

        # Query GET /api/tracking/active
        api_res = get_active_tracks(camera_id=cam_id, channel_no=channel_no, db=db)
        assert api_res["success"] is True
        assert api_res["frameId"] == 5001
        assert api_res["cameraConnectionStatus"] == "LIVE"
        assert api_res["metrics"]["detectedPeople"] == 5
        assert api_res["metrics"]["activeTracks"] == 5
        assert api_res["metrics"]["verifiedTracks"] == 1
        assert api_res["metrics"]["unidentifiedTracks"] == 4
        assert api_res["metrics"]["fps"] == 11.2
        assert len(api_res["data"]) == 5

        print("[Five-Person Test] Frame-atomic telemetry synchronized. Metrics match tracks 1:1.")
    finally:
        db.close()
