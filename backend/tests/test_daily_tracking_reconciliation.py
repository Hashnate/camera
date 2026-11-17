"""Automated Daily Working-Time Tracking Reconciliation & Integrity Test Suite (WorkSight v3.1).

Covers:
1. Daily Time Reconciliation:
   - Strictly mutually exclusive zone intervals: Total Observed = Work Room + Lunch Room + Passage + Outside + Unknown.
   - Zero double-counting.
   - Gaps (>60s) classified as UNKNOWN without fabricating movement.
   - Break classifications (paid, unpaid, excess) remain an orthogonal classification layer.
2. Duplicate Interval Prevention:
   - Successive tracking pulses within the same zone maintain a single contiguous interval.
3. Incomplete Session & Administrative Closure:
   - Administrative closure with mandatory audit reason.
   - Backward-compatibility preservation of legacy statuses ('CLOSED', 'REQUIRES_REVIEW').
4. Attendance Decoupling:
   - Camera observations NEVER create or modify AttendanceRecord.
5. Verification with all 6 Real Employees:
   - Checks presence and calculation readiness for all 6 enrolled employees.
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Set up path to backend
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app.database import SessionLocal, utcnow
from app.models import (
    Employee,
    DailyTrackingSession,
    EmployeeZoneInterval,
    EmployeeMovementEvent,
    AttendanceRecord,
    BreakInterval,
    AuditLog,
    Camera,
)
from app.services.daily_tracking_engine import (
    DailyTrackingService,
    to_colombo_date_str,
    _normalize_dt,
)


class TestDailyTrackingReconciliation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = SessionLocal()
        cls.employees = cls.db.query(Employee).order_by(Employee.employee_code).all()
        cls.camera = cls.db.query(Camera).first()
        cls.camera_id = cls.camera.id if cls.camera else None
        cls.test_date = "2026-11-17"

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def tearDown(self):
        self.db.rollback()

    def test_01_six_real_employees_exist(self):
        """Verify all six real employees are present in the database."""
        self.assertGreaterEqual(len(self.employees), 6, "Expected at least 6 real employees")
        codes = [e.employee_code for e in self.employees]
        for c in ["1", "2", "3", "4", "5", "6"]:
            self.assertIn(c, codes, f"Employee code {c} should exist")
        print(f"\n[PASS] Verified {len(self.employees)} real employees in DB: {[e.full_name for e in self.employees[:6]]}")

    def test_02_time_reconciliation_formula(self):
        """Verify mutually exclusive zone formula: Total = Work + Lunch + Passage + Outside + Unknown."""
        emp = self.employees[0]
        # Create a mock session with distinct, non-overlapping intervals
        base_time = datetime(2026, 11, 17, 8, 30, 0)
        
        session = DailyTrackingSession(
            employee_id=emp.id,
            work_date="2099-01-01",  # Isolated test date
            first_observed_at=base_time,
            last_observed_at=base_time + timedelta(hours=8),
            session_status="ACTIVE",
            current_zone_id="WORK_ROOM",
        )
        self.db.add(session)
        self.db.flush()

        try:
            # 1. 08:30 - 12:30: WORK_ROOM (4 hours = 14400s)
            inv1 = EmployeeZoneInterval(
                daily_session_id=session.id,
                zone_id="WORK_ROOM",
                entered_at=base_time,
                exited_at=base_time + timedelta(hours=4),
                duration_seconds=14400,
                verification_status="VERIFIED",
            )
            # 2. 12:30 - 12:35: PASSAGE (5 mins = 300s)
            inv2 = EmployeeZoneInterval(
                daily_session_id=session.id,
                zone_id="PASSAGE",
                entered_at=base_time + timedelta(hours=4),
                exited_at=base_time + timedelta(hours=4, minutes=5),
                duration_seconds=300,
                verification_status="VERIFIED",
            )
            # 3. 12:35 - 13:20: LUNCH_ROOM (45 mins = 2700s)
            inv3 = EmployeeZoneInterval(
                daily_session_id=session.id,
                zone_id="LUNCH_ROOM",
                entered_at=base_time + timedelta(hours=4, minutes=5),
                exited_at=base_time + timedelta(hours=4, minutes=50),
                duration_seconds=2700,
                verification_status="VERIFIED",
            )
            # 4. 13:20 - 13:50: UNKNOWN gap (30 mins = 1800s)
            inv4 = EmployeeZoneInterval(
                daily_session_id=session.id,
                zone_id="UNKNOWN",
                entered_at=base_time + timedelta(hours=4, minutes=50),
                exited_at=base_time + timedelta(hours=5, minutes=20),
                duration_seconds=1800,
                verification_status="UNCERTAIN",
            )
            # 5. 13:50 - 16:30: WORK_ROOM (2 hours 40 mins = 9600s)
            inv5 = EmployeeZoneInterval(
                daily_session_id=session.id,
                zone_id="WORK_ROOM",
                entered_at=base_time + timedelta(hours=5, minutes=20),
                exited_at=base_time + timedelta(hours=8),
                duration_seconds=9600,
                verification_status="VERIFIED",
            )
            self.db.add_all([inv1, inv2, inv3, inv4, inv5])
            self.db.flush()

            # Also create an orthogonal BreakInterval (Lunch: 45m = 2700s, 0s excess)
            brk = BreakInterval(
                daily_session_id=session.id,
                employee_id=emp.id,
                break_type="LUNCH",
                started_at=base_time + timedelta(hours=4, minutes=5),
                ended_at=base_time + timedelta(hours=4, minutes=50),
                actual_duration_seconds=2700,
                allowed_duration_minutes=60,
                excess_duration_seconds=0,
                classification="APPROVED_LUNCH",
                is_paid=False,
            )
            self.db.add(brk)
            self.db.flush()

            # Calculate durations
            calc = DailyTrackingService.get_employee_daily_calculation(self.db, emp.id, "2099-01-01")
            
            zd = calc["zoneDurations"]
            work_sec = zd["workRoomSeconds"]
            lunch_sec = zd["lunchRoomSeconds"]
            passage_sec = zd["passageSeconds"]
            outside_sec = zd["outsideOfficeSeconds"]
            unknown_sec = zd["unknownSeconds"]
            total_obs = zd["totalObservedSeconds"]

            self.assertEqual(work_sec, 14400 + 9600)  # 24,000s
            self.assertEqual(passage_sec, 300)
            self.assertEqual(lunch_sec, 2700)
            self.assertEqual(unknown_sec, 1800)
            self.assertEqual(outside_sec, 0)
            self.assertEqual(total_obs, 24000 + 300 + 2700 + 1800)  # 28,800s = 8 hours
            self.assertTrue(calc["isReconciled"])
            self.assertEqual(calc["reconciliationDifferenceSeconds"], 0)

            # Verify break classification is orthogonal and NOT added to total
            bc = calc["breakClassifications"]
            self.assertEqual(bc["approvedUnpaidBreakSeconds"], 2700)
            self.assertEqual(bc["excessBreakSeconds"], 0)
            # Total observed remains exactly 28,800s, NOT 28,800 + 2,700!
            self.assertEqual(total_obs, 28800)
            print("\n[PASS] Verified strict mutually exclusive zone time reconciliation (zero double-counting).")
        finally:
            self.db.rollback()

    def test_03_duplicate_interval_prevention(self):
        """Verify repeated pulses or events in the same zone do not create duplicate intervals."""
        emp = self.employees[1]
        now = datetime(2099, 1, 2, 9, 0, 0)

        # Pulse 1 in WORK_ROOM
        s1 = DailyTrackingService.update_observation_pulse(
            self.db, emp.id, self.camera_id, 1, 101, "WORK_ROOM", now
        )
        self.db.flush()

        # Pulse 2 in WORK_ROOM 10s later
        s2 = DailyTrackingService.update_observation_pulse(
            self.db, emp.id, self.camera_id, 1, 101, "WORK_ROOM", now + timedelta(seconds=10)
        )
        self.db.flush()

        # Pulse 3 in WORK_ROOM 20s later
        s3 = DailyTrackingService.update_observation_pulse(
            self.db, emp.id, self.camera_id, 1, 101, "WORK_ROOM", now + timedelta(seconds=20)
        )
        self.db.flush()

        try:
            intervals = self.db.query(EmployeeZoneInterval).filter(
                EmployeeZoneInterval.daily_session_id == s1.id
            ).all()
            # Only ONE interval should exist for WORK_ROOM
            self.assertEqual(len(intervals), 1)
            self.assertIsNone(intervals[0].exited_at)
            self.assertEqual(intervals[0].zone_id, "WORK_ROOM")
            print("\n[PASS] Duplicate interval prevention verified (multiple pulses keep single open interval).")
        finally:
            self.db.rollback()

    def test_04_unobserved_gap_creates_unknown_interval(self):
        """Verify missing observations (>60s) before a transition create an explicit UNKNOWN interval."""
        emp = self.employees[2]
        t0 = datetime(2099, 1, 3, 9, 0, 0)

        # Initial pulse in WORK_ROOM at 09:00:00
        session = DailyTrackingService.get_or_create_daily_session(
            self.db, emp.id, t0, initial_zone="WORK_ROOM"
        )
        self.db.flush()

        # Last pulse in WORK_ROOM at 09:30:00
        t1 = t0 + timedelta(minutes=30)
        DailyTrackingService.update_observation_pulse(
            self.db, emp.id, self.camera_id, 1, 102, "WORK_ROOM", t1
        )
        self.db.flush()

        # Reappears at 10:15:00 (45 minutes gap!) crossing into LUNCH_ROOM
        t2 = t0 + timedelta(minutes=75)
        DailyTrackingService.record_movement_event(
            self.db, emp.id, "LUNCH_ROOM_ENTERED", "PASSAGE", "LUNCH_ROOM", "LINE_LUNCH", t2
        )
        self.db.flush()

        try:
            intervals = self.db.query(EmployeeZoneInterval).filter(
                EmployeeZoneInterval.daily_session_id == session.id
            ).order_by(EmployeeZoneInterval.entered_at).all()

            # Should have 3 distinct non-overlapping intervals:
            # 1. WORK_ROOM: 09:00 -> 09:30 (30m)
            # 2. UNKNOWN: 09:30 -> 10:15 (45m gap)
            # 3. LUNCH_ROOM: 10:15 -> ongoing
            self.assertEqual(len(intervals), 3)
            self.assertEqual(intervals[0].zone_id, "WORK_ROOM")
            self.assertEqual(intervals[0].duration_seconds, 1800)
            self.assertEqual(intervals[1].zone_id, "UNKNOWN")
            self.assertEqual(intervals[1].duration_seconds, 2700)
            self.assertEqual(intervals[2].zone_id, "LUNCH_ROOM")
            self.assertIsNone(intervals[2].exited_at)
            print("\n[PASS] Verified unobserved gap (>60s) is explicitly classified as UNKNOWN without fabricating presence.")
        finally:
            self.db.rollback()

    def test_05_administrative_session_close_with_audit(self):
        """Verify administrative closure sets COMPLETED/CLOSED, closes intervals, and writes AuditLog."""
        emp = self.employees[3]
        now = datetime(2099, 1, 4, 9, 0, 0)

        session = DailyTrackingService.get_or_create_daily_session(
            self.db, emp.id, now, initial_zone="WORK_ROOM"
        )
        self.db.flush()

        try:
            # Close session administratively
            closed_session = DailyTrackingService.close_daily_session(
                db=self.db,
                employee_id=emp.id,
                work_date="2099-01-04",
                reason="End of shift manual sign-off by supervisor",
                closed_by_user_id=None,
                target_status="COMPLETED",
            )
            self.assertEqual(closed_session.session_status, "COMPLETED")
            self.assertIsNotNone(closed_session.closed_at)
            self.assertEqual(closed_session.closure_reason, "End of shift manual sign-off by supervisor")

            # Check open intervals were closed
            open_invs = self.db.query(EmployeeZoneInterval).filter(
                EmployeeZoneInterval.daily_session_id == session.id,
                EmployeeZoneInterval.exited_at.is_(None),
            ).all()
            self.assertEqual(len(open_invs), 0)

            # Check audit log was written
            audit = self.db.query(AuditLog).filter(
                AuditLog.action == "DAILY_TRACKING_SESSION_CLOSED",
                AuditLog.entity_id == session.id,
            ).first()
            self.assertIsNotNone(audit)
            print("\n[PASS] Administrative session closure with audit log verified.")
        finally:
            self.db.rollback()

    def test_06_attendance_decoupling(self):
        """Verify camera-based daily tracking NEVER modifies AttendanceRecord."""
        emp = self.employees[4]
        now = datetime(2099, 1, 5, 8, 45, 0)

        # Confirm initial attendance record does not exist for future test date
        att_before = self.db.query(AttendanceRecord).filter(
            AttendanceRecord.employee_id == emp.id,
            AttendanceRecord.date == "2099-01-05",
        ).first()
        self.assertIsNone(att_before)

        # Trigger camera tracking session and movement events
        session = DailyTrackingService.get_or_create_daily_session(
            self.db, emp.id, now, initial_zone="PASSAGE"
        )
        DailyTrackingService.record_movement_event(
            self.db, emp.id, "WORK_ROOM_ENTERED", "PASSAGE", "WORK_ROOM", "LINE_WORK", now
        )
        self.db.flush()

        try:
            # Confirm AttendanceRecord was NOT created or modified by camera tracking
            att_after = self.db.query(AttendanceRecord).filter(
                AttendanceRecord.employee_id == emp.id,
                AttendanceRecord.date == "2099-01-05",
            ).first()
            self.assertIsNone(att_after, "Camera observations must NOT silently create or modify AttendanceRecord!")
            print("\n[PASS] Verified camera tracking is completely decoupled from official HR attendance.")
        finally:
            self.db.rollback()

    def test_07_backward_compatibility_preserves_closed_and_requires_review(self):
        """Verify legacy statuses 'CLOSED' and 'REQUIRES_REVIEW' are valid and queryable."""
        emp = self.employees[5]
        
        s1 = DailyTrackingSession(
            employee_id=emp.id,
            work_date="2099-01-06",
            first_observed_at=utcnow(),
            last_observed_at=utcnow(),
            session_status="CLOSED",
        )
        s2 = DailyTrackingSession(
            employee_id=emp.id,
            work_date="2099-01-07",
            first_observed_at=utcnow(),
            last_observed_at=utcnow(),
            session_status="REQUIRES_REVIEW",
        )
        self.db.add_all([s1, s2])
        self.db.flush()

        try:
            # Check overview for legacy closed session
            detail1 = DailyTrackingService.get_employee_daily_detail(self.db, emp.id, "2099-01-06")
            self.assertEqual(detail1["sessionStatus"], "CLOSED")

            # Check overview for legacy review session
            detail2 = DailyTrackingService.get_employee_daily_detail(self.db, emp.id, "2099-01-07")
            self.assertEqual(detail2["sessionStatus"], "REQUIRES_REVIEW")
            print("\n[PASS] Verified backward compatibility with legacy 'CLOSED' and 'REQUIRES_REVIEW' statuses.")
        finally:
            self.db.rollback()


if __name__ == "__main__":
    unittest.main()
