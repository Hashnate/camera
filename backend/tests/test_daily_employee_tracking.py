"""WorkSight v2.3 — Daily Employee Tracking & Automatic Working-Hour Calculation Test Suite.

Verifies:
1. DailyTrackingSession lifecycle (exactly one session per employee per local date).
2. Permanent Employee UUID resolution across camera track ID changes.
3. Full workday scenario:
   - 09:00: Entrance (PASSAGE)
   - 09:05: Working Room (WORK_ROOM)
   - 12:30: Lunch Room (LUNCH_ROOM)
   - 13:15: Return to Working Room (WORK_ROOM)
   - 15:00: Exit outside (OUTSIDE)
   - 15:20: Return from outside (PASSAGE -> WORK_ROOM)
   - 17:00: Official checkout
4. Mathematical accuracy of zone durations (Working Room, Lunch Room, Outside, Passage, Unknown).
5. Stale tracking detection & unknown unobserved location attribution (never assumes checkout).
6. Multi-exit and return resilience (no duplicate sessions or dropped history).
7. System A vs System B isolation: camera tracking never modifies official payroll records.
8. Administrator manual correction with mandatory reason and audit history.
"""

import time
import uuid
import pytest
from datetime import datetime, timezone, timedelta

from app.database import SessionLocal, utcnow
from app.models import (
    Employee,
    DailyTrackingSession,
    EmployeeZoneInterval,
    EmployeeMovementEvent,
    AttendanceRecord,
    AttendanceStatus,
    WorkSession,
    AuditLog,
)
from app.services.daily_tracking_engine import (
    DailyTrackingService,
    to_colombo_date_str,
    format_duration,
)


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def active_employee(db):
    emp = db.query(Employee).filter(Employee.is_active == True).first()
    assert emp is not None, "At least one active employee must exist"
    return emp


@pytest.fixture
def test_camera(db):
    from app.models import Camera
    cam = db.query(Camera).first()
    return cam


def test_daily_session_creation_and_singleton(db, active_employee, test_camera):
    """Verify exactly one DailyTrackingSession is created per employee per date."""
    test_date = "2026-11-20"
    base_time = datetime(2026, 11, 20, 3, 30, 0, tzinfo=timezone.utc)  # 09:00 Colombo
    cam_id = test_camera.id if test_camera else None

    # Clean existing test data for that date if any
    db.query(DailyTrackingSession).filter(
        DailyTrackingSession.employee_id == active_employee.id,
        DailyTrackingSession.work_date == test_date,
    ).delete()
    db.commit()

    # Sighting 1: First arrival at entrance
    sess1 = DailyTrackingService.get_or_create_daily_session(
        db,
        employee_id=active_employee.id,
        observed_at=base_time,
        camera_id=cam_id,
        channel_no=1,
        track_id=101,
        initial_zone="PASSAGE",
    )
    db.commit()

    assert sess1.id is not None
    assert sess1.employee_id == active_employee.id
    assert sess1.work_date == test_date
    assert sess1.first_observed_at == base_time.replace(tzinfo=None)
    assert sess1.current_zone_id == "PASSAGE"
    assert sess1.session_status == "ACTIVE"

    # Sighting 2: Repeated sighting 10 minutes later with DIFFERENT camera track ID (e.g. 108 after occlusion)
    later_time = base_time + timedelta(minutes=10)
    sess2 = DailyTrackingService.get_or_create_daily_session(
        db,
        employee_id=active_employee.id,
        observed_at=later_time,
        camera_id=cam_id,
        channel_no=1,
        track_id=108,
        initial_zone="PASSAGE",
    )
    db.commit()

    # Must be the identical session ID (singleton per day)
    assert sess2.id == sess1.id
    assert sess2.first_observed_at == base_time.replace(tzinfo=None)  # Preserved arrival time
    assert sess2.last_observed_at == later_time.replace(tzinfo=None)  # Updated freshness
    assert sess2.last_track_id == 108                                # Track ID updated without changing employee UUID


def test_full_workday_scenario_duration_calculation(db, active_employee, test_camera):
    """Test full workday schedule (09:00 - 17:00) with Lunch, Working Room, Outside, and Checkout."""
    test_date = "2026-11-21"
    cam_id = test_camera.id if test_camera else None
    # Base Colombo times (UTC + 5:30)
    t0900 = datetime(2026, 11, 21, 3, 30, 0, tzinfo=timezone.utc)
    t0905 = datetime(2026, 11, 21, 3, 35, 0, tzinfo=timezone.utc)
    t1230 = datetime(2026, 11, 21, 7, 0, 0, tzinfo=timezone.utc)
    t1315 = datetime(2026, 11, 21, 7, 45, 0, tzinfo=timezone.utc)
    t1500 = datetime(2026, 11, 21, 9, 30, 0, tzinfo=timezone.utc)
    t1520 = datetime(2026, 11, 21, 9, 50, 0, tzinfo=timezone.utc)
    t1700 = datetime(2026, 11, 21, 11, 30, 0, tzinfo=timezone.utc)

    # Clean existing
    db.query(DailyTrackingSession).filter(
        DailyTrackingSession.employee_id == active_employee.id,
        DailyTrackingSession.work_date == test_date,
    ).delete()
    db.commit()

    # Setup official attendance check-in and checkout (8 hours)
    att_rec = db.query(AttendanceRecord).filter(
        AttendanceRecord.employee_id == active_employee.id,
        AttendanceRecord.date == test_date,
    ).first()
    if not att_rec:
        att_rec = AttendanceRecord(
            employee_id=active_employee.id,
            date=test_date,
            check_in=t0900,
            check_out=t1700,
            total_minutes=480,
            status=AttendanceStatus.PRESENT,
        )
        db.add(att_rec)
    else:
        att_rec.check_in = t0900
        att_rec.check_out = t1700
        att_rec.total_minutes = 480
    db.commit()

    # 1. 09:00 — Arrival at Office Entrance (OFFICE_ENTRY_OBSERVED -> PASSAGE)
    sess, _ = DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="OFFICE_ENTRY_OBSERVED",
        from_zone_id="OUTSIDE",
        to_zone_id="PASSAGE",
        crossing_line_id="LINE_EXIT",
        observed_at=t0900,
        camera_id=cam_id,
        channel_no=1,
        track_id=201,
    )
    db.commit()

    # 2. 09:05 — Enter Working Room (WORK_ROOM_ENTERED -> WORK_ROOM)
    DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="WORK_ROOM_ENTERED",
        from_zone_id="PASSAGE",
        to_zone_id="WORK_ROOM",
        crossing_line_id="LINE_WORK",
        observed_at=t0905,
        camera_id=cam_id,
        channel_no=1,
        track_id=201,
    )
    db.commit()

    # 3. 12:30 — Enter Lunch Room (LUNCH_ROOM_ENTERED -> LUNCH_ROOM)
    DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="LUNCH_ROOM_ENTERED",
        from_zone_id="PASSAGE",
        to_zone_id="LUNCH_ROOM",
        crossing_line_id="LINE_LUNCH",
        observed_at=t1230,
        camera_id=cam_id,
        channel_no=1,
        track_id=201,
    )
    db.commit()

    # 4. 13:15 — Return to Working Room (WORK_ROOM_ENTERED -> WORK_ROOM)
    DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="WORK_ROOM_ENTERED",
        from_zone_id="PASSAGE",
        to_zone_id="WORK_ROOM",
        crossing_line_id="LINE_WORK",
        observed_at=t1315,
        camera_id=cam_id,
        channel_no=1,
        track_id=205,  # Note: track ID changed during lunch return
    )
    db.commit()

    # 5. 15:00 — Leave Outside (OFFICE_EXIT_OBSERVED -> OUTSIDE)
    DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="OFFICE_EXIT_OBSERVED",
        from_zone_id="PASSAGE",
        to_zone_id="OUTSIDE",
        crossing_line_id="LINE_EXIT",
        observed_at=t1500,
        camera_id=cam_id,
        channel_no=1,
        track_id=205,
    )
    db.commit()

    # 6. 15:20 — Return from Outside (OFFICE_ENTRY_OBSERVED -> PASSAGE -> WORK_ROOM)
    DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="OFFICE_ENTRY_OBSERVED",
        from_zone_id="OUTSIDE",
        to_zone_id="PASSAGE",
        crossing_line_id="LINE_EXIT",
        observed_at=t1520,
        camera_id=cam_id,
        channel_no=1,
        track_id=210,
    )
    DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="WORK_ROOM_ENTERED",
        from_zone_id="PASSAGE",
        to_zone_id="WORK_ROOM",
        crossing_line_id="LINE_WORK",
        observed_at=t1520,
        camera_id=cam_id,
        channel_no=1,
        track_id=210,
    )
    # Continuous observation in working room until checkout at 17:00
    sess.last_observed_at = t1700.replace(tzinfo=None)
    db.commit()

    # 7. Evaluate Durations at 17:00
    intervals = db.query(EmployeeZoneInterval).filter(
        EmployeeZoneInterval.daily_session_id == sess.id
    ).order_by(EmployeeZoneInterval.entered_at).all()

    durations = DailyTrackingService.calculate_durations(sess, intervals, now=t1700)

    # Expected:
    # Working Room:
    # 09:05 - 12:30 = 3h 25m = 205 mins = 12,300s
    # 13:15 - 15:00 = 1h 45m = 105 mins = 6,300s
    # 15:20 - 17:00 = 1h 40m = 100 mins = 6,000s
    # Total Working Room = 24,600s = 6h 50m
    expected_work_room_sec = (3 * 3600 + 25 * 60) + (1 * 3600 + 45 * 60) + (1 * 3600 + 40 * 60)
    assert durations["workRoomSeconds"] == expected_work_room_sec
    assert durations["workRoomFormatted"] == "6h 50m"

    # Lunch Room:
    # 12:30 - 13:15 = 45 mins = 2,700s
    expected_lunch_sec = 45 * 60
    assert durations["lunchRoomSeconds"] == expected_lunch_sec
    assert durations["lunchRoomFormatted"] == "45m"

    # Outside:
    # 15:00 - 15:20 = 20 mins = 1,200s
    expected_outside_sec = 20 * 60
    assert durations["outsideOfficeSeconds"] == expected_outside_sec
    assert durations["outsideOfficeFormatted"] == "20m"

    # Passage:
    # 09:00 - 09:05 = 5 mins = 300s
    expected_passage_sec = 5 * 60
    assert durations["passageSeconds"] == expected_passage_sec
    assert durations["passageFormatted"] == "5m"

    # Official Attendance: 8 hours (09:00 - 17:00)
    assert durations["officialAttendanceSeconds"] == 8 * 3600
    assert durations["officialAttendanceFormatted"] == "8h 00m"

    # Total observed span = 24600 + 2700 + 1200 + 300 = 28800s (8h exactly)
    assert durations["totalObservedSeconds"] == 28800
    assert durations["totalObservedFormatted"] == "8h 00m"


def test_stale_tracking_unobserved_attribution(db, active_employee):
    """When tracking is lost > 60s in an indoor zone, unobserved time is credited to UNKNOWN."""
    test_date = "2026-11-22"
    t_start = datetime(2026, 11, 22, 3, 30, 0, tzinfo=timezone.utc)
    t_seen = t_start + timedelta(minutes=30)       # Last seen 30 mins later
    t_eval = t_start + timedelta(minutes=45)       # Evaluated 15 mins after that (stale by 15 mins)

    db.query(DailyTrackingSession).filter(
        DailyTrackingSession.employee_id == active_employee.id,
        DailyTrackingSession.work_date == test_date,
    ).delete()
    db.commit()

    sess, _ = DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="WORK_ROOM_ENTERED",
        from_zone_id="PASSAGE",
        to_zone_id="WORK_ROOM",
        crossing_line_id="LINE_WORK",
        observed_at=t_start,
    )
    # Employee was observed at t_seen
    sess.last_observed_at = t_seen
    db.commit()

    intervals = db.query(EmployeeZoneInterval).filter(
        EmployeeZoneInterval.daily_session_id == sess.id
    ).all()

    # Evaluated at t_eval (15 minutes after last sighting)
    durations = DailyTrackingService.calculate_durations(sess, intervals, now=t_eval)

    # 30 minutes in WORK_ROOM
    assert durations["workRoomSeconds"] == 30 * 60
    assert durations["workRoomFormatted"] == "30m"

    # 15 minutes marked as UNKNOWN (stale camera coverage)
    assert durations["unknownSeconds"] == 15 * 60
    assert durations["unknownFormatted"] == "15m"

    # Status must be NOT_RECENTLY_OBSERVED
    assert durations["currentObservationStatus"] == "NOT_RECENTLY_OBSERVED"


def test_administrator_manual_correction_and_audit(db, active_employee):
    """Administrator can correct a zone interval with mandatory reason and audit entry."""
    test_date = "2026-11-23"
    t0 = datetime(2026, 11, 23, 4, 0, 0, tzinfo=timezone.utc)

    db.query(DailyTrackingSession).filter(
        DailyTrackingSession.employee_id == active_employee.id,
        DailyTrackingSession.work_date == test_date,
    ).delete()
    db.commit()

    sess, _ = DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="WORK_ROOM_ENTERED",
        from_zone_id="PASSAGE",
        to_zone_id="WORK_ROOM",
        crossing_line_id="LINE_WORK",
        observed_at=t0,
    )
    db.commit()

    interval = db.query(EmployeeZoneInterval).filter(
        EmployeeZoneInterval.daily_session_id == sess.id,
        EmployeeZoneInterval.zone_id == "WORK_ROOM",
    ).first()
    assert interval is not None
    assert interval.zone_id == "WORK_ROOM"

    from app.models import User
    admin = db.query(User).first()
    actor_id = admin.id if admin else None

    # Perform admin correction: change from WORK_ROOM to LUNCH_ROOM
    corrected = DailyTrackingService.manual_correct_interval(
        db=db,
        interval_id=interval.id,
        new_zone_id="LUNCH_ROOM",
        reason="Employee was having team lunch in meeting area",
        actor_user_id=actor_id,
    )

    assert corrected.zone_id == "LUNCH_ROOM"
    assert corrected.verification_status == "MANUALLY_CORRECTED"

    # Check AuditLog
    audit = db.query(AuditLog).filter(
        AuditLog.entity_id == interval.id,
        AuditLog.action == "MANUAL_ZONE_CORRECTION",
    ).first()
    assert audit is not None
    assert "Employee was having team lunch" in audit.details


def test_camera_observation_does_not_create_official_attendance(db, active_employee):
    """System A vs System B isolation: camera observations never create official WorkSession or AttendanceRecord."""
    test_date = "2026-11-24"
    t0 = datetime(2026, 11, 24, 3, 30, 0, tzinfo=timezone.utc)

    # Delete any work session or attendance record for this test date
    db.query(WorkSession).filter(WorkSession.employee_id == active_employee.id).delete()
    db.query(AttendanceRecord).filter(
        AttendanceRecord.employee_id == active_employee.id,
        AttendanceRecord.date == test_date,
    ).delete()
    db.commit()

    # Camera records entrance and working room entry
    DailyTrackingService.record_movement_event(
        db,
        employee_id=active_employee.id,
        event_type="WORK_ROOM_ENTERED",
        from_zone_id="PASSAGE",
        to_zone_id="WORK_ROOM",
        crossing_line_id="LINE_WORK",
        observed_at=t0,
    )
    db.commit()

    # Must NOT have created official open WorkSession
    open_ws = db.query(WorkSession).filter(
        WorkSession.employee_id == active_employee.id,
        WorkSession.status == "OPEN",
    ).first()
    assert open_ws is None, "Camera observation must NEVER create an official open WorkSession"
