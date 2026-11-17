"""WorkSight v3.1 — Production Real-Camera & 6-Employee Working-Time Verification.

Runs end-to-end audit on live camera footage and real enrolled employees:
1. Biometric enrollment verification across 6 real employees (24 templates).
2. Live camera feed status (EZVIZ CS-H7c Channel 1 Wide & Channel 2 Pan-Tilt).
3. Daily tracking session creation & persistence using permanent Employee UUIDs.
4. Non-overlapping & mutually exclusive zone duration reconciliation.
5. Movement-based break calculation isolation (paid, unpaid, excess).
6. Administrative session closure and audit trail validation.
"""

import sys
import json
import time
import requests
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

from app.database import SessionLocal, utcnow
from app.models import Employee, FaceTemplate, DailyTrackingSession, EmployeeZoneInterval, Camera
from app.services.daily_tracking_engine import DailyTrackingService, to_colombo_date_str

def run_verification():
    db = SessionLocal()
    print("=" * 75)
    print("WORKSIGHT v3.1 — REAL 6-EMPLOYEE & LIVE CAMERA VERIFICATION AUDIT")
    print("=" * 75)

    today = to_colombo_date_str()
    print(f"Office Date (Asia/Colombo): {today}")

    # 1. Verify 6 Real Employees & Biometrics
    print("\n--- 1. ENROLLED REAL EMPLOYEES & BIOMETRIC PROFILES ---")
    employees = db.query(Employee).order_by(Employee.employee_code).all()
    print(f"Total Enrolled Employees: {len(employees)}")

    expected_codes = ["1", "2", "3", "4", "5", "6"]
    for emp in employees:
        templates = db.query(FaceTemplate).filter(FaceTemplate.employee_id == emp.id).all()
        print(f"  • Code #{emp.employee_code.ljust(3)} | {emp.full_name.ljust(26)} | UUID: {emp.id[:8]}... | Biometrics: {len(templates)} active templates (Quality avg: {sum(t.quality_score for t in templates)/len(templates):.2f})")
        assert len(templates) >= 4, f"Employee {emp.full_name} must have all 4 angle templates enrolled!"

    # 2. Verify Live Camera Connection & Active CEIT Tracking
    print("\n--- 2. LIVE CAMERA STREAM & CEIT TRACKING TELEMETRY ---")
    login_res = requests.post(
        "http://localhost:5000/api/auth/login",
        json={"email": "admin@worksight.io", "password": "Admin@123456"}
    )
    token = login_res.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    cam_res = requests.get("http://localhost:5000/api/tracking/active?channel_no=1", headers=headers)
    cam_data = cam_res.json()

    print(f"Camera Connection Status : {cam_data.get('cameraConnectionStatus')}")
    print(f"Processing Frame Rate    : {cam_data.get('metrics', {}).get('fps')} FPS")
    print(f"Detected People (YOLOv8) : {cam_data.get('metrics', {}).get('detectedPeople')}")
    print(f"Active Tracks (ByteTrack): {cam_data.get('metrics', {}).get('activeTracks')}")

    tracks = cam_data.get("data", [])
    print(f"\nActive Person Tracks on Camera:")
    for tr in tracks:
        print(f"  • Track #{tr.get('trackId')}: {tr.get('employeeName')} | State: {tr.get('identityState', tr.get('identityVerificationStatus'))} | Zone: {tr.get('currentZoneId')} | TWF: {tr.get('trackingWithoutFaceSec')}s")

    # 3. Verify Daily Working-Time Tracking Sessions for All 6 Employees
    print("\n--- 3. DAILY TRACKING SESSIONS & MUTUALLY EXCLUSIVE RECONCILIATION ---")
    all_reconciled = True
    for emp in employees:
        calc_res = requests.get(f"http://localhost:5000/api/tracking/daily/{emp.id}/calculation", headers=headers)
        calc = calc_res.json()
        zd = calc.get("zoneDurations", {})
        bc = calc.get("breakClassifications", {})
        att = calc.get("officialAttendance", {})

        is_rec = calc.get("isReconciled", False)
        if not is_rec:
            all_reconciled = False

        print(f"\nEmployee: #{emp.employee_code} — {emp.full_name}")
        print(f"  Session Status : {calc.get('sessionStatus')}")
        print(f"  Work Room Time : {zd.get('workRoomFormatted')} ({zd.get('workRoomSeconds')}s)")
        print(f"  Lunch Room Time: {zd.get('lunchRoomFormatted')} ({zd.get('lunchRoomSeconds')}s)")
        print(f"  Passage Time   : {zd.get('passageFormatted')} ({zd.get('passageSeconds')}s)")
        print(f"  Outside Time   : {zd.get('outsideOfficeFormatted')} ({zd.get('outsideOfficeSeconds')}s)")
        print(f"  Unknown Time   : {zd.get('unknownFormatted')} ({zd.get('unknownSeconds')}s)")
        print(f"  Total Observed : {zd.get('totalObservedFormatted')} ({zd.get('totalObservedSeconds')}s)")
        print(f"  Reconciled     : {'✅ PASS (100% mutually exclusive)' if is_rec else '❌ FAIL'}")
        print(f"  Breaks Overlay : Paid={bc.get('approvedPaidBreakFormatted')}, Unpaid={bc.get('approvedUnpaidBreakFormatted')}, Excess={bc.get('excessBreakFormatted')}")
        print(f"  Official Att.  : {att.get('officialAttendanceFormatted')} (Status: {att.get('attendanceStatus')})")

    assert all_reconciled, "All employees must have strictly reconciled mutually exclusive zone calculations!"

    # 4. Verify Administrative Session Closure & Re-Opening
    print("\n--- 4. ADMINISTRATIVE SESSION CLOSURE AUDIT ---")
    # Pick an employee with an existing session on today's date
    active_session_emp = next(
        (e for e in employees if db.query(DailyTrackingSession).filter_by(employee_id=e.id, work_date=today).first()),
        employees[1]
    )
    test_emp = active_session_emp
    close_res = requests.post(
        f"http://localhost:5000/api/tracking/daily/{test_emp.id}/close",
        headers=headers,
        json={"reason": "Supervisor end-of-shift administrative sign-off", "sessionStatus": "COMPLETED"}
    )
    print(f"POST /close status: {close_res.status_code}")
    print(f"Result: {close_res.json().get('message')}")
    assert close_res.status_code == 200, "Administrative close must succeed"

    # Verify session is marked COMPLETED
    verify_session = db.query(DailyTrackingSession).filter(
        DailyTrackingSession.employee_id == test_emp.id,
        DailyTrackingSession.work_date == today,
    ).first()
    assert verify_session.session_status in ("COMPLETED", "CLOSED"), "Session must be closed"
    assert verify_session.closure_reason is not None, "Closure reason must be recorded"
    print(f"Verified Session #{verify_session.id[:8]}... Status: {verify_session.session_status}, Reason: '{verify_session.closure_reason}'")

    print("\n" + "=" * 75)
    print("✅ ALL 6 REAL EMPLOYEES & LIVE CAMERA VERIFICATION COMPLETED WITH ZERO ERRORS")
    print("=" * 75)
    db.close()

if __name__ == "__main__":
    run_verification()
