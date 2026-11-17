"""WorkSight v2.3 — Daily Employee Tracking & Automatic Working-Hour Calculation Engine.

Responsibilities:
1. Resolves permanent Employee UUID identities (never relies on temporary camera track IDs).
2. Manages DailyTrackingSession lifecycle (one persistent session per employee per local date).
3. Records verified doorway crossings into EmployeeMovementEvent and manages contiguous EmployeeZoneIntervals.
4. Computes live, non-overlapping zone durations:
   - Working Room (WORK_ROOM)
   - Lunch Room (LUNCH_ROOM)
   - Outside Office (OUTSIDE)
   - Unknown / Unobserved Location (UNKNOWN)
   - Official Hybrid Attendance (separate from camera-observed presence)
5. Timezone-safe calculations with Asia/Colombo (+05:30).
"""

import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List, Tuple
from sqlalchemy import select, and_, or_, desc
from sqlalchemy.orm import Session, joinedload

from app.database import utcnow
from app.errors import ApiError
from app.models import (
    Employee,
    DailyTrackingSession,
    EmployeeZoneInterval,
    EmployeeMovementEvent,
    AttendanceRecord,
    WorkSession,
    AuditLog,
    Camera,
)

# Configured Timezone: Asia/Colombo (UTC +05:30)
COLOMBO_OFFSET = timedelta(hours=5, minutes=30)
COLOMBO_TZ = timezone(COLOMBO_OFFSET)

OBSERVATION_STALE_THRESHOLD_SEC = 60  # After 60s without camera hit, observation is marked stale


def _normalize_dt(dt: Optional[datetime]) -> datetime:
    """Normalize any datetime (aware or naive) to naive UTC."""
    if dt is None:
        return utcnow()
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _dt_diff_sec(dt1: datetime, dt2: datetime) -> int:
    """Return signed difference (dt1 - dt2) in whole seconds safely across aware/naive datetimes."""
    n1 = _normalize_dt(dt1)
    n2 = _normalize_dt(dt2)
    return int((n1 - n2).total_seconds())


def get_colombo_now() -> datetime:
    """Return current wall-clock datetime in Asia/Colombo timezone."""
    return datetime.now(COLOMBO_TZ)


def to_colombo_date_str(dt: Optional[datetime] = None) -> str:
    """Convert a UTC or naive datetime into YYYY-MM-DD date string in Asia/Colombo."""
    if dt is None:
        dt = datetime.now(timezone.utc)
    elif dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(COLOMBO_TZ).strftime("%Y-%m-%d")


def format_duration(seconds: int) -> str:
    """Format seconds into human-readable e.g. '4h 15m' or '25m'."""
    sec = max(0, int(seconds))
    hrs = sec // 3600
    mins = (sec % 3600) // 60
    if hrs > 0:
        return f"{hrs}h {mins:02d}m"
    return f"{mins}m"


class DailyTrackingService:
    """Core domain service for employee daily tracking and zone duration calculation."""

    @staticmethod
    def get_or_create_daily_session(
        db: Session,
        employee_id: str,
        observed_at: Optional[datetime] = None,
        camera_id: Optional[str] = None,
        channel_no: Optional[int] = 1,
        track_id: Optional[int] = None,
        initial_zone: str = "PASSAGE",
    ) -> DailyTrackingSession:
        """Retrieve existing daily tracking session for employee on this date, or initialize a new one.
        
        Guarantees:
        - Exactly one DailyTrackingSession per employee per day.
        - Preserves firstObservedAt timestamp.
        - Does NOT create duplicate sessions for repeated face detections or doorway crossings.
        """
        now = _normalize_dt(observed_at)
        work_date = to_colombo_date_str(now)

        # 1. Search for existing session for (employee_id, work_date)
        session = db.scalar(
            select(DailyTrackingSession)
            .options(joinedload(DailyTrackingSession.employee))
            .where(
                DailyTrackingSession.employee_id == employee_id,
                DailyTrackingSession.work_date == work_date,
            )
        )

        if session:
            # Update last observed telemetry
            session.last_observed_at = now
            if camera_id:
                session.last_camera_id = camera_id
            if channel_no is not None:
                session.last_channel_no = channel_no
            if track_id is not None:
                session.last_track_id = track_id

            session.current_observation_status = "OBSERVED_RECENTLY"
            if session.session_status == "PAUSED":
                session.session_status = "ACTIVE"

            # Sync official attendance check-in/out timestamps if available
            DailyTrackingService._sync_official_attendance(db, session, work_date)
            return session

        # 2. Check official attendance records to pre-populate check_in_at
        check_in_at = None
        check_out_at = None
        att_rec = db.scalar(
            select(AttendanceRecord).where(
                AttendanceRecord.employee_id == employee_id,
                AttendanceRecord.date == work_date,
            )
        )
        if att_rec:
            check_in_at = _normalize_dt(att_rec.check_in) if att_rec.check_in else None
            check_out_at = _normalize_dt(att_rec.check_out) if att_rec.check_out else None

        # 3. Create brand new DailyTrackingSession
        session = DailyTrackingSession(
            employee_id=employee_id,
            work_date=work_date,
            first_observed_at=now,
            last_observed_at=now,
            attendance_check_in_at=check_in_at,
            attendance_check_out_at=check_out_at,
            session_status="ACTIVE",
            current_zone_id=initial_zone,
            current_observation_status="OBSERVED_RECENTLY",
            last_camera_id=camera_id,
            last_channel_no=channel_no,
            last_track_id=track_id,
        )
        db.add(session)
        db.flush()

        # 4. Open initial EmployeeZoneInterval
        initial_interval = EmployeeZoneInterval(
            daily_session_id=session.id,
            zone_id=initial_zone,
            entered_at=now,
            verification_status="VERIFIED",
            source_camera_id=camera_id,
            source_channel_no=channel_no,
        )
        db.add(initial_interval)
        db.flush()

        return session

    @staticmethod
    def _sync_official_attendance(db: Session, session: DailyTrackingSession, work_date: str) -> None:
        """Synchronize official attendance check-in/out timestamps from System B."""
        att_rec = db.scalar(
            select(AttendanceRecord).where(
                AttendanceRecord.employee_id == session.employee_id,
                AttendanceRecord.date == work_date,
            )
        )
        if att_rec:
            if att_rec.check_in and not session.attendance_check_in_at:
                session.attendance_check_in_at = _normalize_dt(att_rec.check_in)
            if att_rec.check_out:
                session.attendance_check_out_at = _normalize_dt(att_rec.check_out)

    @staticmethod
    def record_movement_event(
        db: Session,
        employee_id: str,
        event_type: str,
        from_zone_id: str,
        to_zone_id: str,
        crossing_line_id: Optional[str] = None,
        observed_at: Optional[datetime] = None,
        camera_id: Optional[str] = None,
        channel_no: int = 1,
        track_id: Optional[int] = None,
        confidence: float = 1.0,
    ) -> Tuple[DailyTrackingSession, EmployeeMovementEvent]:
        """Record verified doorway transition event and transition active zone interval."""
        if isinstance(crossing_line_id, datetime) and observed_at is None:
            observed_at = crossing_line_id
            crossing_line_id = None
        now = _normalize_dt(observed_at)
        work_date = to_colombo_date_str(now)

        # Check existing session to capture previous_last_observed before updating
        existing_session = db.scalar(
            select(DailyTrackingSession).where(
                DailyTrackingSession.employee_id == employee_id,
                DailyTrackingSession.work_date == work_date,
            )
        )
        prev_last_seen = existing_session.last_observed_at if existing_session else now

        # 1. Get or create daily tracking session
        session = DailyTrackingService.get_or_create_daily_session(
            db,
            employee_id=employee_id,
            observed_at=now,
            camera_id=camera_id,
            channel_no=channel_no,
            track_id=track_id,
            initial_zone=from_zone_id or "PASSAGE",
        )

        # 2. Insert immutable EmployeeMovementEvent
        movement = EmployeeMovementEvent(
            daily_session_id=session.id,
            employee_id=employee_id,
            camera_track_id=track_id,
            event_type=event_type,
            from_zone_id=from_zone_id,
            to_zone_id=to_zone_id,
            crossing_line_id=crossing_line_id,
            event_timestamp=now,
            verification_confidence=confidence,
            source_camera_id=camera_id,
            source_channel_no=channel_no,
        )
        db.add(movement)

        # 3. Reconcile Zone Intervals
        # Find currently open interval for this session
        open_interval = db.scalar(
            select(EmployeeZoneInterval)
            .where(
                EmployeeZoneInterval.daily_session_id == session.id,
                EmployeeZoneInterval.exited_at.is_(None),
            )
            .order_by(desc(EmployeeZoneInterval.entered_at))
        )

        if open_interval:
            if open_interval.zone_id != to_zone_id:
                # Check for unobserved gap (> 60s) before transition
                gap_sec = _dt_diff_sec(now, prev_last_seen)
                if (
                    gap_sec > OBSERVATION_STALE_THRESHOLD_SEC
                    and prev_last_seen > open_interval.entered_at
                    and open_interval.zone_id != "OUTSIDE"
                ):
                    # Close previous interval at the last verified camera observation
                    open_interval.exited_at = prev_last_seen
                    open_interval.duration_seconds = max(
                        0, _dt_diff_sec(prev_last_seen, open_interval.entered_at)
                    )
                    # Insert explicit UNKNOWN interval for the unobserved window
                    unknown_inv = EmployeeZoneInterval(
                        daily_session_id=session.id,
                        zone_id="UNKNOWN",
                        entered_at=prev_last_seen,
                        exited_at=now,
                        duration_seconds=gap_sec,
                        verification_status="UNCERTAIN",
                        notes="Unobserved gap before confirmed zone transition",
                        source_camera_id=camera_id,
                        source_channel_no=channel_no,
                    )
                    db.add(unknown_inv)
                else:
                    # Close normally at current timestamp
                    open_interval.exited_at = now
                    open_interval.duration_seconds = max(0, _dt_diff_sec(now, open_interval.entered_at))

                # Open new interval for target zone
                new_interval = EmployeeZoneInterval(
                    daily_session_id=session.id,
                    zone_id=to_zone_id,
                    entered_at=now,
                    verification_status="VERIFIED",
                    source_camera_id=camera_id,
                    source_channel_no=channel_no,
                )
                db.add(new_interval)
        else:
            # No open interval existed; create new
            new_interval = EmployeeZoneInterval(
                daily_session_id=session.id,
                zone_id=to_zone_id,
                entered_at=now,
                verification_status="VERIFIED",
                source_camera_id=camera_id,
                source_channel_no=channel_no,
            )
            db.add(new_interval)

        # 4. Update session zone and status
        session.current_zone_id = to_zone_id
        session.last_observed_at = now
        session.current_observation_status = "OBSERVED_RECENTLY"

        if to_zone_id == "OUTSIDE" or event_type == "OFFICE_EXIT_OBSERVED":
            session.session_status = "PAUSED"
        elif session.session_status == "PAUSED":
            session.session_status = "ACTIVE"

        # 5. WorkSight v2.8 Movement-Based Break Interval Reconciliation
        try:
            from app.services.break_engine import BreakEngineService
            BreakEngineService.handle_doorway_crossing(
                db, session, movement, from_zone_id, to_zone_id, now
            )
        except Exception as e:
            # Non-blocking break tracking safeguard
            pass

        db.flush()
        return session, movement

    @staticmethod
    def update_observation_pulse(
        db: Session,
        employee_id: str,
        camera_id: str,
        channel_no: int,
        track_id: int,
        zone_id: str,
        observed_at: Optional[datetime] = None,
    ) -> DailyTrackingSession:
        """Periodic observation pulse while employee is tracked within camera coverage."""
        now = _normalize_dt(observed_at)
        session = DailyTrackingService.get_or_create_daily_session(
            db,
            employee_id=employee_id,
            observed_at=now,
            camera_id=camera_id,
            channel_no=channel_no,
            track_id=track_id,
            initial_zone=zone_id,
        )

        session.last_observed_at = now
        session.last_camera_id = camera_id
        session.last_channel_no = channel_no
        session.last_track_id = track_id
        session.current_observation_status = "OBSERVED_RECENTLY"

        # Check if zone changed silently without doorway trigger
        if zone_id and zone_id != session.current_zone_id and zone_id != "UNKNOWN":
            open_interval = db.scalar(
                select(EmployeeZoneInterval)
                .where(
                    EmployeeZoneInterval.daily_session_id == session.id,
                    EmployeeZoneInterval.exited_at.is_(None),
                )
                .order_by(desc(EmployeeZoneInterval.entered_at))
            )
            if open_interval and open_interval.zone_id != zone_id:
                open_interval.exited_at = now
                open_interval.duration_seconds = max(0, _dt_diff_sec(now, open_interval.entered_at))
                new_interval = EmployeeZoneInterval(
                    daily_session_id=session.id,
                    zone_id=zone_id,
                    entered_at=now,
                    verification_status="VERIFIED",
                    source_camera_id=camera_id,
                    source_channel_no=channel_no,
                )
                db.add(new_interval)
                session.current_zone_id = zone_id

        return session

    @staticmethod
    def calculate_durations(
        session: DailyTrackingSession,
        intervals: List[EmployeeZoneInterval],
        now: Optional[datetime] = None,
        db: Optional[Session] = None,
        break_intervals: Optional[List[Any]] = None,
    ) -> Dict[str, Any]:
        """Compute exact non-overlapping zone durations and attendance metrics.
        
        Calculates:
        1. Working Room Duration (sum of WORK_ROOM intervals)
        2. Lunch Room Duration (sum of LUNCH_ROOM intervals)
        3. Outside Office Duration (sum of OUTSIDE intervals)
        4. Unknown / Unobserved Duration:
           - Accumulated UNKNOWN intervals.
           - Plus: if tracking is stale (> 60s) and employee is NOT known to be in OUTSIDE,
             the unobserved time is dynamically credited to UNKNOWN.
        5. Passage Duration (PASSAGE transition intervals)
        6. Official Attendance Duration (official checkout minus official check-in, or now - check-in).
        7. Orthogonal Break Classifications (paid, unpaid, excess, unplanned away) - NOT added to zone totals.
        """
        ref_now = _normalize_dt(now)

        zone_seconds: Dict[str, int] = {
            "WORK_ROOM": 0,
            "LUNCH_ROOM": 0,
            "OUTSIDE": 0,
            "PASSAGE": 0,
            "UNKNOWN": 0,
        }

        # Determine observation freshness
        sec_since_last_seen = max(0, _dt_diff_sec(ref_now, session.last_observed_at))
        is_stale = sec_since_last_seen > OBSERVATION_STALE_THRESHOLD_SEC

        observation_status = session.current_observation_status
        if session.current_zone_id == "OUTSIDE":
            observation_status = "OBSERVED_RECENTLY"  # Known outside; not considered sensor loss
        elif is_stale:
            observation_status = "NOT_RECENTLY_OBSERVED"

        for inv in intervals:
            zid = inv.zone_id if inv.zone_id in zone_seconds else "UNKNOWN"

            if inv.exited_at is not None:
                # Closed interval
                dur = inv.duration_seconds if inv.duration_seconds > 0 else max(
                    0, _dt_diff_sec(inv.exited_at, inv.entered_at)
                )
                zone_seconds[zid] += dur
            else:
                # Open / Ongoing interval
                if is_stale and zid != "OUTSIDE":
                    # Time up to last_observed_at belongs to the known zone
                    confirmed_time = max(0, _dt_diff_sec(session.last_observed_at, inv.entered_at))
                    zone_seconds[zid] += confirmed_time
                    # Time after last_observed_at until now is unobserved -> UNKNOWN
                    unobserved_time = max(0, _dt_diff_sec(ref_now, session.last_observed_at))
                    zone_seconds["UNKNOWN"] += unobserved_time
                else:
                    elapsed = max(0, _dt_diff_sec(ref_now, inv.entered_at))
                    zone_seconds[zid] += elapsed

        # Official Hybrid Attendance Duration
        official_attendance_sec = 0
        if session.attendance_check_in_at:
            if session.attendance_check_out_at:
                official_attendance_sec = max(
                    0, _dt_diff_sec(session.attendance_check_out_at, session.attendance_check_in_at)
                )
            else:
                official_attendance_sec = max(
                    0, _dt_diff_sec(ref_now, session.attendance_check_in_at)
                )

        # Mutually exclusive zone total
        total_observed_sec = sum(zone_seconds.values())

        # Break classifications (Independent overlay; never added to zone totals)
        paid_break_sec = 0
        unpaid_break_sec = 0
        excess_break_sec = 0
        unplanned_away_sec = 0

        b_intervals = break_intervals
        if b_intervals is None and db is not None:
            try:
                from app.models import BreakInterval
                b_intervals = db.scalars(
                    select(BreakInterval).where(BreakInterval.daily_session_id == session.id)
                ).all()
            except Exception:
                b_intervals = []

        if b_intervals:
            for b in b_intervals:
                b_dur = b.actual_duration_seconds if b.ended_at else max(0, _dt_diff_sec(ref_now, b.started_at))
                if getattr(b, "is_paid", False):
                    paid_break_sec += b_dur
                else:
                    unpaid_break_sec += b_dur
                excess_break_sec += getattr(b, "excess_duration_seconds", 0) or 0
                if getattr(b, "classification", "") == "UNPLANNED_AWAY":
                    unplanned_away_sec += b_dur

        return {
            "workRoomSeconds": zone_seconds["WORK_ROOM"],
            "workRoomFormatted": format_duration(zone_seconds["WORK_ROOM"]),
            "lunchRoomSeconds": zone_seconds["LUNCH_ROOM"],
            "lunchRoomFormatted": format_duration(zone_seconds["LUNCH_ROOM"]),
            "outsideOfficeSeconds": zone_seconds["OUTSIDE"],
            "outsideOfficeFormatted": format_duration(zone_seconds["OUTSIDE"]),
            "passageSeconds": zone_seconds["PASSAGE"],
            "passageFormatted": format_duration(zone_seconds["PASSAGE"]),
            "unknownSeconds": zone_seconds["UNKNOWN"],
            "unknownFormatted": format_duration(zone_seconds["UNKNOWN"]),
            "totalObservedSeconds": total_observed_sec,
            "totalObservedFormatted": format_duration(total_observed_sec),
            "officialAttendanceSeconds": official_attendance_sec,
            "officialAttendanceFormatted": format_duration(official_attendance_sec),
            "paidBreakSeconds": paid_break_sec,
            "paidBreakFormatted": format_duration(paid_break_sec),
            "unpaidBreakSeconds": unpaid_break_sec,
            "unpaidBreakFormatted": format_duration(unpaid_break_sec),
            "excessBreakSeconds": excess_break_sec,
            "excessBreakFormatted": format_duration(excess_break_sec),
            "unplannedAwaySeconds": unplanned_away_sec,
            "unplannedAwayFormatted": format_duration(unplanned_away_sec),
            "currentObservationStatus": observation_status,
            "secondsSinceLastSeen": sec_since_last_seen,
        }

    @staticmethod
    def get_live_overview_for_date(db: Session, work_date: Optional[str] = None) -> List[Dict[str, Any]]:
        """Return live tracking and duration status for all registered active employees on work_date."""
        target_date = work_date or to_colombo_date_str()
        now = utcnow()

        # Load all active employees
        employees = db.scalars(
            select(Employee)
            .options(joinedload(Employee.department))
            .where(Employee.is_active == True)
            .order_by(Employee.employee_code)
        ).all()

        results = []
        for emp in employees:
            session = db.scalar(
                select(DailyTrackingSession)
                .where(
                    DailyTrackingSession.employee_id == emp.id,
                    DailyTrackingSession.work_date == target_date,
                )
            )

            if not session:
                # Employee not observed yet today
                # Check if official attendance exists (e.g. manual check-in)
                att_rec = db.scalar(
                    select(AttendanceRecord).where(
                        AttendanceRecord.employee_id == emp.id,
                        AttendanceRecord.date == target_date,
                    )
                )
                att_status = "ABSENT"
                official_sec = 0
                check_in_str = None
                check_out_str = None
                if att_rec and att_rec.check_in:
                    att_status = att_rec.status.value if hasattr(att_rec.status, "value") else str(att_rec.status)
                    check_in_str = att_rec.check_in.isoformat()
                    if att_rec.check_out:
                        check_out_str = att_rec.check_out.isoformat()
                        official_sec = max(0, int((att_rec.check_out - att_rec.check_in).total_seconds()))
                    else:
                        official_sec = max(0, int((now - att_rec.check_in).total_seconds()))

                results.append({
                    "employeeId": emp.id,
                    "employeeCode": emp.employee_code,
                    "employeeName": emp.full_name,
                    "departmentName": emp.department.name if emp.department else "General",
                    "jobTitle": emp.job_title,
                    "workDate": target_date,
                    "hasTrackingSession": False,
                    "sessionStatus": "NOT_STARTED",
                    "currentZoneId": "UNKNOWN",
                    "currentObservationStatus": "SENSOR_UNAVAILABLE",
                    "firstObservedAt": None,
                    "lastObservedAt": None,
                    "attendanceCheckInAt": check_in_str,
                    "attendanceCheckOutAt": check_out_str,
                    "attendanceStatus": att_status,
                    "durations": {
                        "workRoomSeconds": 0,
                        "workRoomFormatted": "0m",
                        "lunchRoomSeconds": 0,
                        "lunchRoomFormatted": "0m",
                        "outsideOfficeSeconds": 0,
                        "outsideOfficeFormatted": "0m",
                        "passageSeconds": 0,
                        "passageFormatted": "0m",
                        "unknownSeconds": 0,
                        "unknownFormatted": "0m",
                        "totalObservedSeconds": 0,
                        "totalObservedFormatted": "0m",
                        "officialAttendanceSeconds": official_sec,
                        "officialAttendanceFormatted": format_duration(official_sec),
                        "currentObservationStatus": "SENSOR_UNAVAILABLE",
                        "secondsSinceLastSeen": 999999,
                    },
                })
                continue

            # Load all intervals for this session
            intervals = db.scalars(
                select(EmployeeZoneInterval)
                .where(EmployeeZoneInterval.daily_session_id == session.id)
                .order_by(EmployeeZoneInterval.entered_at)
            ).all()

            durations = DailyTrackingService.calculate_durations(session, list(intervals), now, db=db)

            # Determine attendance status
            att_status = "PRESENT"
            if session.attendance_check_out_at:
                att_status = "CHECKED_OUT"
            elif not session.attendance_check_in_at:
                att_status = "UNOFFICIAL_PRESENT"  # Camera observed, but official check-in pending

            results.append({
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "employeeName": emp.full_name,
                "departmentName": emp.department.name if emp.department else "General",
                "jobTitle": emp.job_title,
                "workDate": target_date,
                "hasTrackingSession": True,
                "dailySessionId": session.id,
                "sessionStatus": session.session_status,
                "currentZoneId": session.current_zone_id,
                "currentObservationStatus": durations["currentObservationStatus"],
                "firstObservedAt": session.first_observed_at.isoformat() + "Z",
                "lastObservedAt": session.last_observed_at.isoformat() + "Z",
                "attendanceCheckInAt": session.attendance_check_in_at.isoformat() + "Z" if session.attendance_check_in_at else None,
                "attendanceCheckOutAt": session.attendance_check_out_at.isoformat() + "Z" if session.attendance_check_out_at else None,
                "attendanceStatus": att_status,
                "durations": durations,
            })

        return results

    @staticmethod
    def get_employee_daily_detail(
        db: Session,
        employee_id: str,
        work_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Return rich single-employee daily report with intervals, chronological movement timeline, and durations."""
        target_date = work_date or to_colombo_date_str()
        now = utcnow()

        emp = db.scalar(
            select(Employee)
            .options(joinedload(Employee.department))
            .where(Employee.id == employee_id)
        )
        if not emp:
            raise ApiError(404, f"Employee '{employee_id}' not found")

        session = db.scalar(
            select(DailyTrackingSession)
            .where(
                DailyTrackingSession.employee_id == employee_id,
                DailyTrackingSession.work_date == target_date,
            )
        )

        if not session:
            return {
                "success": True,
                "employee": {
                    "id": emp.id,
                    "code": emp.employee_code,
                    "name": emp.full_name,
                    "department": emp.department.name if emp.department else "General",
                    "jobTitle": emp.job_title,
                },
                "workDate": target_date,
                "hasTrackingSession": False,
                "message": f"No tracking session recorded for {emp.full_name} on {target_date}.",
                "durations": {
                    "workRoomSeconds": 0,
                    "workRoomFormatted": "0m",
                    "lunchRoomSeconds": 0,
                    "lunchRoomFormatted": "0m",
                    "outsideOfficeSeconds": 0,
                    "outsideOfficeFormatted": "0m",
                    "passageSeconds": 0,
                    "passageFormatted": "0m",
                    "unknownSeconds": 0,
                    "unknownFormatted": "0m",
                    "totalObservedSeconds": 0,
                    "totalObservedFormatted": "0m",
                    "officialAttendanceSeconds": 0,
                    "officialAttendanceFormatted": "0m",
                },
                "intervals": [],
                "timeline": [],
            }

        intervals = db.scalars(
            select(EmployeeZoneInterval)
            .where(EmployeeZoneInterval.daily_session_id == session.id)
            .order_by(EmployeeZoneInterval.entered_at)
        ).all()

        movements = db.scalars(
            select(EmployeeMovementEvent)
            .where(EmployeeMovementEvent.daily_session_id == session.id)
            .order_by(desc(EmployeeMovementEvent.event_timestamp))
        ).all()

        durations = DailyTrackingService.calculate_durations(session, list(intervals), now, db=db)

        formatted_intervals = []
        for inv in intervals:
            dur_sec = inv.duration_seconds if inv.exited_at else max(0, int((now - inv.entered_at).total_seconds()))
            formatted_intervals.append({
                "id": inv.id,
                "zoneId": inv.zone_id,
                "enteredAt": inv.entered_at.isoformat() + "Z",
                "exitedAt": inv.exited_at.isoformat() + "Z" if inv.exited_at else None,
                "durationSeconds": dur_sec,
                "durationFormatted": format_duration(dur_sec),
                "verificationStatus": inv.verification_status,
                "sourceCameraId": inv.source_camera_id,
                "isOngoing": inv.exited_at is None,
            })

        formatted_timeline = []
        for m in movements:
            formatted_timeline.append({
                "id": m.id,
                "eventType": m.event_type,
                "fromZoneId": m.from_zone_id,
                "toZoneId": m.to_zone_id,
                "crossingLineId": m.crossing_line_id,
                "timestamp": m.event_timestamp.isoformat() + "Z",
                "verificationConfidence": m.verification_confidence,
                "cameraTrackId": m.camera_track_id,
                "sourceCameraId": m.source_camera_id,
                "sourceChannelNo": m.source_channel_no,
            })

        return {
            "success": True,
            "employee": {
                "id": emp.id,
                "code": emp.employee_code,
                "name": emp.full_name,
                "department": emp.department.name if emp.department else "General",
                "jobTitle": emp.job_title,
                "assignedZone": emp.assigned_zone,
            },
            "workDate": target_date,
            "hasTrackingSession": True,
            "dailySessionId": session.id,
            "sessionStatus": session.session_status,
            "currentZoneId": session.current_zone_id,
            "currentObservationStatus": durations["currentObservationStatus"],
            "firstObservedAt": session.first_observed_at.isoformat() + "Z",
            "lastObservedAt": session.last_observed_at.isoformat() + "Z",
            "attendanceCheckInAt": session.attendance_check_in_at.isoformat() + "Z" if session.attendance_check_in_at else None,
            "attendanceCheckOutAt": session.attendance_check_out_at.isoformat() + "Z" if session.attendance_check_out_at else None,
            "durations": durations,
            "intervals": formatted_intervals,
            "timeline": formatted_timeline,
        }

    @staticmethod
    def manual_correct_interval(
        db: Session,
        interval_id: str,
        new_zone_id: str,
        reason: str,
        actor_user_id: Optional[str] = None,
    ) -> EmployeeZoneInterval:
        """Allow authorized administrator corrections with mandatory reasons and audit history."""
        if not reason or len(reason.strip()) < 5:
            raise ApiError(400, "A valid reason (minimum 5 characters) is required for manual corrections.")

        interval = db.scalar(
            select(EmployeeZoneInterval).where(EmployeeZoneInterval.id == interval_id)
        )
        if not interval:
            raise ApiError(404, "Zone interval not found")

        old_zone = interval.zone_id
        interval.zone_id = new_zone_id
        interval.verification_status = "MANUALLY_CORRECTED"
        interval.notes = f"Corrected from {old_zone} to {new_zone_id}. Reason: {reason}"

        # Audit log
        db.add(
            AuditLog(
                user_id=actor_user_id,
                action="MANUAL_ZONE_CORRECTION",
                entity_type="EmployeeZoneInterval",
                entity_id=interval_id,
                details=f'{{"oldZone": "{old_zone}", "newZone": "{new_zone_id}", "reason": "{reason}"}}',
            )
        )
        db.commit()
        return interval

    @staticmethod
    def close_daily_session(
        db: Session,
        employee_id: str,
        work_date: Optional[str] = None,
        reason: Optional[str] = None,
        closed_by_user_id: Optional[str] = None,
        target_status: str = "COMPLETED",
    ) -> DailyTrackingSession:
        """Administratively close an ongoing or incomplete daily tracking session with audit reason."""
        target_date = work_date or to_colombo_date_str()
        now = utcnow()

        session = db.scalar(
            select(DailyTrackingSession).where(
                DailyTrackingSession.employee_id == employee_id,
                DailyTrackingSession.work_date == target_date,
            )
        )
        if not session:
            raise ApiError(404, f"No daily session found for employee '{employee_id}' on {target_date}.")

        # Close any open zone intervals
        open_intervals = db.scalars(
            select(EmployeeZoneInterval).where(
                EmployeeZoneInterval.daily_session_id == session.id,
                EmployeeZoneInterval.exited_at.is_(None),
            )
        ).all()
        for inv in open_intervals:
            inv.exited_at = now
            inv.duration_seconds = max(0, _dt_diff_sec(now, inv.entered_at))

        # Close any open break intervals
        try:
            from app.models import BreakInterval
            open_breaks = db.scalars(
                select(BreakInterval).where(
                    BreakInterval.daily_session_id == session.id,
                    BreakInterval.ended_at.is_(None),
                )
            ).all()
            for brk in open_breaks:
                brk.ended_at = now
                brk.actual_duration_seconds = max(0, _dt_diff_sec(now, brk.started_at))
                if getattr(brk, "allowed_duration_minutes", 0) > 0:
                    allowed_sec = brk.allowed_duration_minutes * 60
                    brk.excess_duration_seconds = max(0, brk.actual_duration_seconds - allowed_sec)
        except Exception:
            pass

        # Update session status (supports both legacy CLOSED and v3.1 COMPLETED/INCOMPLETE)
        valid_status = (
            target_status
            if target_status in ("COMPLETED", "CLOSED", "INCOMPLETE", "REVIEW_REQUIRED", "REQUIRES_REVIEW")
            else "COMPLETED"
        )
        session.session_status = valid_status
        session.closed_at = now
        session.closed_by_user_id = closed_by_user_id
        session.closure_reason = reason or "Administrative day-end closure"
        session.current_observation_status = "CLOSED"

        db.add(
            AuditLog(
                user_id=closed_by_user_id,
                action="DAILY_TRACKING_SESSION_CLOSED",
                entity_type="DailyTrackingSession",
                entity_id=session.id,
                details=f'{{"employeeId": "{employee_id}", "workDate": "{target_date}", "reason": "{session.closure_reason}", "finalStatus": "{valid_status}"}}',
            )
        )
        db.commit()
        return session

    @staticmethod
    def get_employee_daily_calculation(
        db: Session,
        employee_id: str,
        work_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Compute mutually exclusive zone totals and independent break classifications with reconciliation check."""
        detail = DailyTrackingService.get_employee_daily_detail(db, employee_id, work_date)
        durations = detail.get("durations", {})

        # Mutually exclusive sum of the 5 spatial zones
        zone_sum = (
            durations.get("workRoomSeconds", 0)
            + durations.get("lunchRoomSeconds", 0)
            + durations.get("passageSeconds", 0)
            + durations.get("outsideOfficeSeconds", 0)
            + durations.get("unknownSeconds", 0)
        )
        total_observed = durations.get("totalObservedSeconds", 0)
        is_reconciled = (zone_sum == total_observed)

        return {
            "success": True,
            "employeeId": employee_id,
            "employeeName": detail.get("employee", {}).get("name", "Unknown"),
            "employeeCode": detail.get("employee", {}).get("code"),
            "workDate": detail.get("workDate"),
            "sessionStatus": detail.get("sessionStatus", "NOT_STARTED"),
            "zoneDurations": {
                "workRoomSeconds": durations.get("workRoomSeconds", 0),
                "workRoomFormatted": durations.get("workRoomFormatted", "0m"),
                "lunchRoomSeconds": durations.get("lunchRoomSeconds", 0),
                "lunchRoomFormatted": durations.get("lunchRoomFormatted", "0m"),
                "passageSeconds": durations.get("passageSeconds", 0),
                "passageFormatted": durations.get("passageFormatted", "0m"),
                "outsideOfficeSeconds": durations.get("outsideOfficeSeconds", 0),
                "outsideOfficeFormatted": durations.get("outsideOfficeFormatted", "0m"),
                "unknownSeconds": durations.get("unknownSeconds", 0),
                "unknownFormatted": durations.get("unknownFormatted", "0m"),
                "totalObservedSeconds": total_observed,
                "totalObservedFormatted": durations.get("totalObservedFormatted", "0m"),
            },
            "breakClassifications": {
                "approvedPaidBreakSeconds": durations.get("paidBreakSeconds", 0),
                "approvedPaidBreakFormatted": durations.get("paidBreakFormatted", "0m"),
                "approvedUnpaidBreakSeconds": durations.get("unpaidBreakSeconds", 0),
                "approvedUnpaidBreakFormatted": durations.get("unpaidBreakFormatted", "0m"),
                "excessBreakSeconds": durations.get("excessBreakSeconds", 0),
                "excessBreakFormatted": durations.get("excessBreakFormatted", "0m"),
                "unplannedAwaySeconds": durations.get("unplannedAwaySeconds", 0),
                "unplannedAwayFormatted": durations.get("unplannedAwayFormatted", "0m"),
            },
            "officialAttendance": {
                "officialAttendanceSeconds": durations.get("officialAttendanceSeconds", 0),
                "officialAttendanceFormatted": durations.get("officialAttendanceFormatted", "0m"),
                "attendanceStatus": detail.get("attendanceStatus", "ABSENT"),
                "checkInAt": detail.get("attendanceCheckInAt"),
                "checkOutAt": detail.get("attendanceCheckOutAt"),
            },
            "isReconciled": is_reconciled,
            "reconciliationDifferenceSeconds": abs(total_observed - zone_sum),
        }

    @staticmethod
    def get_employee_daily_intervals(
        db: Session,
        employee_id: str,
        work_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Return clean, non-overlapping list of all discrete zone intervals for the employee and date."""
        detail = DailyTrackingService.get_employee_daily_detail(db, employee_id, work_date)
        return {
            "success": True,
            "employeeId": employee_id,
            "employeeName": detail.get("employee", {}).get("name", "Unknown"),
            "employeeCode": detail.get("employee", {}).get("code"),
            "workDate": detail.get("workDate"),
            "count": len(detail.get("intervals", [])),
            "intervals": detail.get("intervals", []),
        }
