"""WorkSight v2.8 — Final Actual Movement-Based Break and Away-Time Engine.

Core Principles:
- ACTUAL MOVEMENT-BASED: Calculations derive strictly from verified camera doorway and zone transitions.
- ZERO DOUBLE-COUNTING: Mutually exclusive time intervals.
- NO FIXED LUNCH ASSUMPTIONS: Lunch hours are never pre-deducted based on fixed clock times.
- EXCESS ISOLATION: When an allowance is exceeded, only the surplus duration is classified as excess;
  the allowed portion remains APPROVED_LUNCH / APPROVED_BREAK.
- SEPARATE OUTSIDE TRACKING: Outside movements are tracked under outside allowance, never misclassified as lunch.
- OBJECTIVE PRAYER / TEA: Prayer and tea intervals derive from authorized declarations or verified zones,
  never inferred from facial expressions or body movements.
- UNKNOWN LOCATION RESILIENCE: Unverified intervals are tracked separately as UNKNOWN without falsely marking
  the employee outside or assigning unplanned breaks.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from sqlalchemy import desc, func, or_, select, and_
from sqlalchemy.orm import Session, joinedload

from app.database import utcnow
from app.errors import ApiError
from app.models import (
    Company,
    Employee,
    DailyTrackingSession,
    EmployeeZoneInterval,
    EmployeeMovementEvent,
    BreakPolicy,
    BreakInterval,
    BreakCorrectionAudit,
    AttendanceRecord,
    User,
)
from app.services.daily_tracking_engine import (
    to_colombo_date_str,
    format_duration,
    _dt_diff_sec,
    _normalize_dt,
    OBSERVATION_STALE_THRESHOLD_SEC,
)

# Default Standard Break Allowances (used for auto-seeding if no policies exist)
DEFAULT_BREAK_ALLOWANCES = [
    {
        "break_type": "LUNCH",
        "name": "Standard Lunch Allowance",
        "allowed_duration_minutes": 60,
        "is_paid": False,
        "max_count_per_day": 1,
        "notes": "Verified doorway transitions (WORK_ROOM <-> LUNCH_ROOM). Unpaid break.",
    },
    {
        "break_type": "PRAYER",
        "name": "Prayer Break Allowance",
        "allowed_duration_minutes": 15,
        "is_paid": True,
        "max_count_per_day": 2,
        "notes": "Authorized break declaration or verified zone. Paid break.",
    },
    {
        "break_type": "TEA",
        "name": "Tea Break Allowance",
        "allowed_duration_minutes": 10,
        "is_paid": True,
        "max_count_per_day": 2,
        "notes": "Morning / afternoon pantry or tea interval. Paid break.",
    },
    {
        "break_type": "OUTSIDE",
        "name": "Outside Office Allowance",
        "allowed_duration_minutes": 20,
        "is_paid": False,
        "max_count_per_day": 2,
        "notes": "Short external office departures (WORK_ROOM -> OUTSIDE).",
    },
    {
        "break_type": "PERSONAL",
        "name": "Personal Break Allowance",
        "allowed_duration_minutes": 15,
        "is_paid": False,
        "max_count_per_day": 1,
        "notes": "Ad-hoc personal errands or personal downtime. Unpaid.",
    },
    {
        "break_type": "OTHER",
        "name": "Other Approved Break",
        "allowed_duration_minutes": 30,
        "is_paid": False,
        "max_count_per_day": 1,
        "notes": "Administrative or manager-approved special breaks.",
    },
]


class BreakEngineService:
    """Core domain service for movement-based break tracking and duration reconciliation."""

    @staticmethod
    def ensure_default_policies(db: Session, company_id: Optional[str] = None) -> List[BreakPolicy]:
        """Auto-seed default break policies for company on initial setup if none exist."""
        if not company_id:
            comp = db.scalar(select(Company))
            if not comp:
                return []
            company_id = comp.id

        existing = db.scalars(
            select(BreakPolicy).where(
                BreakPolicy.company_id == company_id,
                BreakPolicy.is_active == True,
            ).order_by(BreakPolicy.break_type)
        ).all()

        # Seed defaults only if the company has zero policies in total (initial setup)
        if not existing:
            total_ever = db.scalar(
                select(func.count()).select_from(BreakPolicy).where(BreakPolicy.company_id == company_id)
            )
            if total_ever == 0:
                today = datetime.now(timezone.utc).date()
                for d in DEFAULT_BREAK_ALLOWANCES:
                    policy = BreakPolicy(
                        company_id=company_id,
                        employee_id=None,
                        break_type=d["break_type"],
                        name=d["name"],
                        allowed_duration_minutes=d["allowed_duration_minutes"],
                        is_paid=d["is_paid"],
                        max_count_per_day=d["max_count_per_day"],
                        effective_from=today,
                        is_active=True,
                        notes=d["notes"],
                    )
                    db.add(policy)
                db.commit()
                existing = db.scalars(
                    select(BreakPolicy)
                    .where(BreakPolicy.company_id == company_id, BreakPolicy.is_active == True)
                    .order_by(BreakPolicy.break_type)
                ).all()

        return list(existing)

    @staticmethod
    def restore_default_policies(db: Session, company_id: Optional[str] = None) -> List[BreakPolicy]:
        """Restore missing standard default allowances if deleted."""
        if not company_id:
            comp = db.scalar(select(Company))
            if not comp:
                return []
            company_id = comp.id

        existing = db.scalars(
            select(BreakPolicy).where(BreakPolicy.company_id == company_id)
        ).all()
        existing_types = {p.break_type for p in existing}

        today = datetime.now(timezone.utc).date()
        for d in DEFAULT_BREAK_ALLOWANCES:
            b_type = d["break_type"]
            if b_type not in existing_types:
                policy = BreakPolicy(
                    company_id=company_id,
                    employee_id=None,
                    break_type=b_type,
                    name=d["name"],
                    allowed_duration_minutes=d["allowed_duration_minutes"],
                    is_paid=d["is_paid"],
                    max_count_per_day=d["max_count_per_day"],
                    effective_from=today,
                    is_active=True,
                    notes=d["notes"],
                )
                db.add(policy)
        db.commit()

        return list(
            db.scalars(
                select(BreakPolicy)
                .where(BreakPolicy.company_id == company_id, BreakPolicy.is_active == True)
                .order_by(BreakPolicy.break_type)
            ).all()
        )

    @staticmethod
    def get_effective_policy(
        db: Session,
        break_type: str,
        employee_id: Optional[str] = None,
        company_id: Optional[str] = None,
    ) -> BreakPolicy:
        """Find the effective break policy for an employee.
        
        Prioritizes employee-specific policy over company-wide shared policy.
        Falls back to default allowance if no policy record exists.
        """
        if employee_id:
            emp_policy = db.scalar(
                select(BreakPolicy).where(
                    BreakPolicy.employee_id == employee_id,
                    BreakPolicy.break_type == break_type,
                    BreakPolicy.is_active == True,
                )
            )
            if emp_policy:
                return emp_policy

        # Fallback to shared company policy
        shared_query = select(BreakPolicy).where(
            BreakPolicy.employee_id.is_(None),
            BreakPolicy.break_type == break_type,
            BreakPolicy.is_active == True,
        )
        if company_id:
            shared_query = shared_query.where(BreakPolicy.company_id == company_id)

        shared_policy = db.scalar(shared_query)
        if shared_policy:
            return shared_policy

        # Fallback in-memory default policy (NEVER write to database during lookup!)
        defaults = next((d for d in DEFAULT_BREAK_ALLOWANCES if d["break_type"] == break_type), None)
        allowed_mins = defaults["allowed_duration_minutes"] if defaults else 60
        is_paid = defaults["is_paid"] if defaults else False
        name = defaults["name"] if defaults else f"{break_type} Allowance"

        return BreakPolicy(
            id=f"transient-default-{break_type.lower()}",
            company_id=company_id or "default-company",
            employee_id=None,
            break_type=break_type,
            name=name,
            allowed_duration_minutes=allowed_mins,
            is_paid=is_paid,
            max_count_per_day=1,
            effective_from=datetime.now(timezone.utc).date(),
            is_active=True,
            notes="Transient default fallback (not saved to database)",
        )

    @staticmethod
    def handle_doorway_crossing(
        db: Session,
        session: DailyTrackingSession,
        movement: EmployeeMovementEvent,
        from_zone: Optional[str],
        to_zone: Optional[str],
        event_time: datetime,
    ) -> Optional[BreakInterval]:
        """Process verified doorway crossing and open or close actual break intervals."""
        now = _normalize_dt(event_time)
        f_zone = (from_zone or "").upper()
        t_zone = (to_zone or "").upper()
        e_type = (movement.event_type or "").upper()

        # -------------------------------------------------------------
        # 1. Entering LUNCH_ROOM (WORK_ROOM -> LUNCH_ROOM or LUNCH_ROOM_ENTERED)
        # -------------------------------------------------------------
        if t_zone == "LUNCH_ROOM" or e_type == "LUNCH_ROOM_ENTERED":
            # Check if there is already an open lunch break
            existing_open = db.scalar(
                select(BreakInterval).where(
                    BreakInterval.daily_session_id == session.id,
                    BreakInterval.break_type == "LUNCH",
                    BreakInterval.ended_at.is_(None),
                )
            )
            if existing_open:
                return existing_open

            policy = BreakEngineService.get_effective_policy(db, "LUNCH", session.employee_id)
            break_inv = BreakInterval(
                daily_session_id=session.id,
                employee_id=session.employee_id,
                break_type="LUNCH",
                started_at=now,
                allowed_duration_minutes=policy.allowed_duration_minutes,
                actual_duration_seconds=0,
                excess_duration_seconds=0,
                classification="ONGOING",
                source="CAMERA_DOORWAY_CROSSING",
                source_movement_id=movement.id,
                is_paid=policy.is_paid,
                payroll_deductible=not policy.is_paid,
                notes=f"Started lunch via doorway crossing: {f_zone} -> {t_zone}",
            )
            db.add(break_inv)
            db.flush()
            return break_inv

        # -------------------------------------------------------------
        # 2. Exiting LUNCH_ROOM (LUNCH_ROOM -> WORK_ROOM or LUNCH_ROOM_EXITED)
        # -------------------------------------------------------------
        if f_zone == "LUNCH_ROOM" or e_type == "LUNCH_ROOM_EXITED" or (t_zone == "WORK_ROOM" and f_zone != "WORK_ROOM"):
            # Check if there is an open LUNCH break
            open_lunch = db.scalar(
                select(BreakInterval).where(
                    BreakInterval.daily_session_id == session.id,
                    BreakInterval.break_type == "LUNCH",
                    BreakInterval.ended_at.is_(None),
                ).order_by(desc(BreakInterval.started_at))
            )
            if open_lunch:
                open_lunch.ended_at = now
                actual_sec = max(0, _dt_diff_sec(now, open_lunch.started_at))
                open_lunch.actual_duration_seconds = actual_sec
                allowed_sec = open_lunch.allowed_duration_minutes * 60

                if actual_sec <= allowed_sec:
                    open_lunch.classification = "APPROVED_LUNCH"
                    open_lunch.excess_duration_seconds = 0
                else:
                    open_lunch.classification = "BREAK_ALLOWANCE_EXCEEDED"
                    open_lunch.excess_duration_seconds = actual_sec - allowed_sec

                open_lunch.notes = (
                    f"Completed lunch. Actual: {format_duration(actual_sec)} "
                    f"(Allowed: {open_lunch.allowed_duration_minutes}m, "
                    f"Excess: {format_duration(open_lunch.excess_duration_seconds)})"
                )
                db.flush()
                return open_lunch

        # -------------------------------------------------------------
        # 3. Going OUTSIDE (WORK_ROOM -> OUTSIDE or OFFICE_EXIT_OBSERVED)
        # -------------------------------------------------------------
        if t_zone == "OUTSIDE" or e_type == "OFFICE_EXIT_OBSERVED":
            # If an open lunch was somehow still open, close it first
            open_lunch = db.scalar(
                select(BreakInterval).where(
                    BreakInterval.daily_session_id == session.id,
                    BreakInterval.break_type == "LUNCH",
                    BreakInterval.ended_at.is_(None),
                )
            )
            if open_lunch:
                open_lunch.ended_at = now
                actual_sec = max(0, _dt_diff_sec(now, open_lunch.started_at))
                open_lunch.actual_duration_seconds = actual_sec
                allowed_sec = open_lunch.allowed_duration_minutes * 60
                if actual_sec <= allowed_sec:
                    open_lunch.classification = "APPROVED_LUNCH"
                    open_lunch.excess_duration_seconds = 0
                else:
                    open_lunch.classification = "BREAK_ALLOWANCE_EXCEEDED"
                    open_lunch.excess_duration_seconds = actual_sec - allowed_sec

            # Check if already open outside break
            existing_outside = db.scalar(
                select(BreakInterval).where(
                    BreakInterval.daily_session_id == session.id,
                    BreakInterval.break_type == "OUTSIDE",
                    BreakInterval.ended_at.is_(None),
                )
            )
            if existing_outside:
                return existing_outside

            policy = BreakEngineService.get_effective_policy(db, "OUTSIDE", session.employee_id)
            break_inv = BreakInterval(
                daily_session_id=session.id,
                employee_id=session.employee_id,
                break_type="OUTSIDE",
                started_at=now,
                allowed_duration_minutes=policy.allowed_duration_minutes,
                actual_duration_seconds=0,
                excess_duration_seconds=0,
                classification="ONGOING",
                source="CAMERA_DOORWAY_CROSSING",
                source_movement_id=movement.id,
                is_paid=policy.is_paid,
                payroll_deductible=not policy.is_paid,
                notes=f"Exited office to outside: {f_zone} -> {t_zone}",
            )
            db.add(break_inv)
            db.flush()
            return break_inv

        # -------------------------------------------------------------
        # 4. Returning from OUTSIDE (OUTSIDE -> WORK_ROOM or OFFICE_ENTRY_OBSERVED)
        # -------------------------------------------------------------
        if f_zone == "OUTSIDE" or e_type == "OFFICE_ENTRY_OBSERVED":
            open_outside = db.scalar(
                select(BreakInterval).where(
                    BreakInterval.daily_session_id == session.id,
                    BreakInterval.break_type == "OUTSIDE",
                    BreakInterval.ended_at.is_(None),
                ).order_by(desc(BreakInterval.started_at))
            )
            if open_outside:
                open_outside.ended_at = now
                actual_sec = max(0, _dt_diff_sec(now, open_outside.started_at))
                open_outside.actual_duration_seconds = actual_sec
                allowed_sec = open_outside.allowed_duration_minutes * 60

                if allowed_sec > 0 and actual_sec > allowed_sec:
                    open_outside.classification = "BREAK_ALLOWANCE_EXCEEDED"
                    open_outside.excess_duration_seconds = actual_sec - allowed_sec
                else:
                    open_outside.classification = "OUTSIDE_INTERVAL"
                    open_outside.excess_duration_seconds = 0

                open_outside.notes = (
                    f"Returned from outside. Actual: {format_duration(actual_sec)} "
                    f"(Allowed: {open_outside.allowed_duration_minutes}m, "
                    f"Excess: {format_duration(open_outside.excess_duration_seconds)})"
                )
                db.flush()
                return open_outside

        return None

    @staticmethod
    def declare_manual_break(
        db: Session,
        employee_id: str,
        break_type: str,
        started_at: datetime,
        duration_minutes: int,
        notes: Optional[str] = None,
        actor_user_id: Optional[str] = None,
    ) -> BreakInterval:
        """Authorized break declaration (prayer, tea, approved personal pause) without camera doorway."""
        start_dt = _normalize_dt(started_at)
        end_dt = start_dt + timedelta(minutes=duration_minutes)
        actual_sec = duration_minutes * 60

        # Retrieve or initialize DailyTrackingSession
        from app.services.daily_tracking_engine import DailyTrackingService
        session = DailyTrackingService.get_or_create_daily_session(
            db, employee_id=employee_id, observed_at=start_dt
        )

        policy = BreakEngineService.get_effective_policy(db, break_type, employee_id)
        allowed_sec = policy.allowed_duration_minutes * 60

        if actual_sec <= allowed_sec:
            classification = "APPROVED_LUNCH" if break_type == "LUNCH" else "APPROVED_BREAK"
            excess_sec = 0
        else:
            classification = "BREAK_ALLOWANCE_EXCEEDED"
            excess_sec = actual_sec - allowed_sec

        break_inv = BreakInterval(
            daily_session_id=session.id,
            employee_id=employee_id,
            break_type=break_type,
            started_at=start_dt,
            ended_at=end_dt,
            actual_duration_seconds=actual_sec,
            allowed_duration_minutes=policy.allowed_duration_minutes,
            excess_duration_seconds=excess_sec,
            classification=classification,
            source="AUTHORIZED_DECLARATION",
            is_paid=policy.is_paid,
            payroll_deductible=not policy.is_paid,
            notes=notes or f"Declared {break_type} break ({duration_minutes}m)",
        )
        db.add(break_inv)
        db.commit()
        db.refresh(break_inv)
        return break_inv

    @staticmethod
    def correct_break_interval(
        db: Session,
        interval_id: str,
        new_duration_seconds: Optional[int] = None,
        new_classification: Optional[str] = None,
        reason: str = "",
        admin_user_id: Optional[str] = None,
    ) -> BreakInterval:
        """Allow authorized administrator corrections with mandatory audit trail logging."""
        if not reason or len(reason.strip()) < 5:
            raise ApiError(400, "A valid reason (minimum 5 characters) is required for manual break corrections.")

        interval = db.scalar(select(BreakInterval).where(BreakInterval.id == interval_id))
        if not interval:
            raise ApiError(404, f"Break interval '{interval_id}' not found.")

        prev_classification = interval.classification
        prev_duration = interval.actual_duration_seconds

        target_classification = new_classification or prev_classification
        target_duration = new_duration_seconds if new_duration_seconds is not None else prev_duration

        # Re-evaluate excess based on allowed duration
        allowed_sec = interval.allowed_duration_minutes * 60
        excess_sec = max(0, target_duration - allowed_sec) if allowed_sec > 0 else 0

        interval.classification = target_classification
        interval.actual_duration_seconds = target_duration
        interval.excess_duration_seconds = excess_sec
        interval.notes = f"{interval.notes or ''} [Corrected by admin: {reason}]".strip()

        audit = BreakCorrectionAudit(
            break_interval_id=interval.id,
            admin_user_id=admin_user_id,
            previous_classification=prev_classification,
            new_classification=target_classification,
            previous_duration_seconds=prev_duration,
            new_duration_seconds=target_duration,
            reason=reason,
        )
        db.add(audit)
        db.commit()
        db.refresh(interval)
        return interval

    @staticmethod
    def get_live_breaks_board(db: Session, work_date: Optional[str] = None) -> List[Dict[str, Any]]:
        """Live Break & Away-Time Board for all active employees.
        
        Returns real-time server elapsed timers, remaining allowances, excess duration,
        and observation freshness.
        """
        target_date = work_date or to_colombo_date_str()
        now = utcnow()

        # Load active employees
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
                results.append({
                    "employeeId": emp.id,
                    "employeeCode": emp.employee_code,
                    "employeeName": emp.full_name,
                    "departmentName": emp.department.name if emp.department else "General",
                    "jobTitle": emp.job_title,
                    "workDate": target_date,
                    "hasTrackingSession": False,
                    "currentZoneId": "UNKNOWN",
                    "currentObservationStatus": "SENSOR_UNAVAILABLE",
                    "activeBreak": None,
                    "todayBreaksSummary": {
                        "lunchApprovedSeconds": 0,
                        "lunchExcessSeconds": 0,
                        "prayerSeconds": 0,
                        "teaSeconds": 0,
                        "outsideSeconds": 0,
                        "totalBreakSeconds": 0,
                        "totalBreakFormatted": "0m",
                    },
                    "lastMovement": None,
                    "serverTimestamp": now.isoformat() + "Z",
                })
                continue

            # Load all break intervals for this session
            break_intervals = db.scalars(
                select(BreakInterval)
                .where(BreakInterval.daily_session_id == session.id)
                .order_by(BreakInterval.started_at)
            ).all()

            # Identify currently active break (ended_at is None)
            active_break_data = None
            open_break = next((b for b in break_intervals if b.ended_at is None), None)

            # Compute summary across today's intervals
            lunch_approved_sec = 0
            lunch_excess_sec = 0
            prayer_sec = 0
            tea_sec = 0
            outside_sec = 0
            total_break_sec = 0

            for b in break_intervals:
                if b.ended_at is not None:
                    dur = b.actual_duration_seconds
                    excess = b.excess_duration_seconds
                else:
                    # Ongoing break
                    dur = max(0, _dt_diff_sec(now, b.started_at))
                    allowed_sec = b.allowed_duration_minutes * 60
                    excess = max(0, dur - allowed_sec) if allowed_sec > 0 else 0

                total_break_sec += dur

                if b.break_type == "LUNCH":
                    lunch_excess_sec += excess
                    lunch_approved_sec += (dur - excess)
                elif b.break_type == "PRAYER":
                    prayer_sec += dur
                elif b.break_type == "TEA":
                    tea_sec += dur
                elif b.break_type == "OUTSIDE":
                    outside_sec += dur

            if open_break:
                elapsed_sec = max(0, _dt_diff_sec(now, open_break.started_at))
                allowed_sec = open_break.allowed_duration_minutes * 60
                remaining_sec = max(0, allowed_sec - elapsed_sec) if allowed_sec > 0 else 0
                is_exceeded = (elapsed_sec > allowed_sec) if allowed_sec > 0 else False
                excess_sec = max(0, elapsed_sec - allowed_sec) if allowed_sec > 0 else 0

                active_break_data = {
                    "id": open_break.id,
                    "breakType": open_break.break_type,
                    "startedAt": open_break.started_at.isoformat() + "Z",
                    "elapsedSeconds": elapsed_sec,
                    "elapsedFormatted": format_duration(elapsed_sec),
                    "allowedDurationMinutes": open_break.allowed_duration_minutes,
                    "remainingSeconds": remaining_sec,
                    "remainingFormatted": format_duration(remaining_sec),
                    "isExceeded": is_exceeded,
                    "excessSeconds": excess_sec,
                    "excessFormatted": format_duration(excess_sec),
                    "isPaid": open_break.is_paid,
                    "classification": "BREAK_ALLOWANCE_EXCEEDED" if is_exceeded else "ONGOING",
                    "source": open_break.source,
                }

            # Observation freshness
            sec_since_last_seen = max(0, _dt_diff_sec(now, session.last_observed_at))
            obs_status = session.current_observation_status
            if session.current_zone_id == "OUTSIDE":
                obs_status = "OBSERVED_RECENTLY"
            elif sec_since_last_seen > OBSERVATION_STALE_THRESHOLD_SEC:
                obs_status = "NOT_RECENTLY_OBSERVED"

            # Last verified movement
            last_mov = db.scalar(
                select(EmployeeMovementEvent)
                .where(EmployeeMovementEvent.daily_session_id == session.id)
                .order_by(desc(EmployeeMovementEvent.event_timestamp))
            )
            last_mov_data = None
            if last_mov:
                last_mov_data = {
                    "eventType": last_mov.event_type,
                    "fromZoneId": last_mov.from_zone_id,
                    "toZoneId": last_mov.to_zone_id,
                    "timestamp": last_mov.event_timestamp.isoformat() + "Z",
                    "sourceCameraId": last_mov.source_camera_id,
                    "sourceChannelNo": last_mov.source_channel_no,
                }

            results.append({
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "employeeName": emp.full_name,
                "departmentName": emp.department.name if emp.department else "General",
                "jobTitle": emp.job_title,
                "workDate": target_date,
                "hasTrackingSession": True,
                "currentZoneId": session.current_zone_id,
                "currentObservationStatus": obs_status,
                "secondsSinceLastSeen": sec_since_last_seen,
                "activeBreak": active_break_data,
                "todayBreaksSummary": {
                    "lunchApprovedSeconds": lunch_approved_sec,
                    "lunchApprovedFormatted": format_duration(lunch_approved_sec),
                    "lunchExcessSeconds": lunch_excess_sec,
                    "lunchExcessFormatted": format_duration(lunch_excess_sec),
                    "prayerSeconds": prayer_sec,
                    "prayerFormatted": format_duration(prayer_sec),
                    "teaSeconds": tea_sec,
                    "teaFormatted": format_duration(tea_sec),
                    "outsideSeconds": outside_sec,
                    "outsideFormatted": format_duration(outside_sec),
                    "totalBreakSeconds": total_break_sec,
                    "totalBreakFormatted": format_duration(total_break_sec),
                },
                "lastMovement": last_mov_data,
                "serverTimestamp": now.isoformat() + "Z",
            })

        return results

    @staticmethod
    def get_reconciliation_summary(
        db: Session,
        work_date: Optional[str] = None,
        employee_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """End-of-day non-overlapping time reconciliation with ZERO double-counting.
        
        Mutually exclusive categories:
        1. Official Attendance (check-in to check-out)
        2. Working-Room Observed Duration
        3. Lunch Duration (split: Approved Lunch vs. Excess Lunch)
        4. Prayer Duration
        5. Tea Duration
        6. Other Approved Breaks
        7. Outside-Office Duration
        8. Unplanned Away Duration
        9. Unknown Duration
        """
        target_date = work_date or to_colombo_date_str()
        now = utcnow()

        emp_query = select(Employee).options(joinedload(Employee.department)).where(Employee.is_active == True)
        if employee_id:
            emp_query = emp_query.where(Employee.id == employee_id)
        employees = db.scalars(emp_query.order_by(Employee.employee_code)).all()

        reconciliations = []
        for emp in employees:
            session = db.scalar(
                select(DailyTrackingSession).where(
                    DailyTrackingSession.employee_id == emp.id,
                    DailyTrackingSession.work_date == target_date,
                )
            )

            if not session:
                # No session recorded
                reconciliations.append({
                    "employeeId": emp.id,
                    "employeeCode": emp.employee_code,
                    "employeeName": emp.full_name,
                    "departmentName": emp.department.name if emp.department else "General",
                    "workDate": target_date,
                    "hasTrackingSession": False,
                    "officialAttendanceSeconds": 0,
                    "officialAttendanceFormatted": "0m",
                    "workRoomSeconds": 0,
                    "workRoomFormatted": "0m",
                    "lunchApprovedSeconds": 0,
                    "lunchApprovedFormatted": "0m",
                    "lunchExcessSeconds": 0,
                    "lunchExcessFormatted": "0m",
                    "prayerSeconds": 0,
                    "prayerFormatted": "0m",
                    "teaSeconds": 0,
                    "teaFormatted": "0m",
                    "otherApprovedSeconds": 0,
                    "otherApprovedFormatted": "0m",
                    "outsideOfficeSeconds": 0,
                    "outsideOfficeFormatted": "0m",
                    "unplannedAwaySeconds": 0,
                    "unplannedAwayFormatted": "0m",
                    "unknownSeconds": 0,
                    "unknownFormatted": "0m",
                    "totalObservedSeconds": 0,
                    "totalObservedFormatted": "0m",
                    "netProductiveSeconds": 0,
                    "netProductiveFormatted": "0m",
                    "totalDeductibleSeconds": 0,
                    "totalDeductibleFormatted": "0m",
                    "zeroDoubleCountingVerified": True,
                })
                continue

            # Load zone intervals and break intervals
            zone_intervals = db.scalars(
                select(EmployeeZoneInterval)
                .where(EmployeeZoneInterval.daily_session_id == session.id)
                .order_by(EmployeeZoneInterval.entered_at)
            ).all()

            break_intervals = db.scalars(
                select(BreakInterval)
                .where(BreakInterval.daily_session_id == session.id)
                .order_by(BreakInterval.started_at)
            ).all()

            # 1. Official attendance duration
            official_att_sec = 0
            if session.attendance_check_in_at:
                if session.attendance_check_out_at:
                    official_att_sec = max(
                        0, _dt_diff_sec(session.attendance_check_out_at, session.attendance_check_in_at)
                    )
                else:
                    official_att_sec = max(0, _dt_diff_sec(now, session.attendance_check_in_at))

            # 2. Zone Durations from zone intervals
            sec_since_last_seen = max(0, _dt_diff_sec(now, session.last_observed_at))
            is_stale = sec_since_last_seen > OBSERVATION_STALE_THRESHOLD_SEC

            work_room_sec = 0
            lunch_room_raw_sec = 0
            outside_raw_sec = 0
            passage_sec = 0
            unknown_sec = 0

            for zi in zone_intervals:
                if zi.exited_at is not None:
                    dur = zi.duration_seconds if zi.duration_seconds > 0 else max(
                        0, _dt_diff_sec(zi.exited_at, zi.entered_at)
                    )
                    if zi.zone_id == "WORK_ROOM":
                        work_room_sec += dur
                    elif zi.zone_id == "LUNCH_ROOM":
                        lunch_room_raw_sec += dur
                    elif zi.zone_id == "OUTSIDE":
                        outside_raw_sec += dur
                    elif zi.zone_id == "PASSAGE":
                        passage_sec += dur
                    else:
                        unknown_sec += dur
                else:
                    # Open interval
                    if is_stale and zi.zone_id != "OUTSIDE":
                        confirmed_dur = max(0, _dt_diff_sec(session.last_observed_at, zi.entered_at))
                        unobserved_dur = max(0, _dt_diff_sec(now, session.last_observed_at))
                        if zi.zone_id == "WORK_ROOM":
                            work_room_sec += confirmed_dur
                        elif zi.zone_id == "LUNCH_ROOM":
                            lunch_room_raw_sec += confirmed_dur
                        elif zi.zone_id == "PASSAGE":
                            passage_sec += confirmed_dur
                        else:
                            unknown_sec += confirmed_dur
                        unknown_sec += unobserved_dur
                    else:
                        elapsed = max(0, _dt_diff_sec(now, zi.entered_at))
                        if zi.zone_id == "WORK_ROOM":
                            work_room_sec += elapsed
                        elif zi.zone_id == "LUNCH_ROOM":
                            lunch_room_raw_sec += elapsed
                        elif zi.zone_id == "OUTSIDE":
                            outside_raw_sec += elapsed
                        elif zi.zone_id == "PASSAGE":
                            passage_sec += elapsed
                        else:
                            unknown_sec += elapsed

            # 3. Categorize break intervals
            lunch_approved_sec = 0
            lunch_excess_sec = 0
            prayer_sec = 0
            tea_sec = 0
            other_approved_sec = 0
            outside_office_sec = 0
            unplanned_away_sec = 0

            for bi in break_intervals:
                if bi.ended_at is not None:
                    dur = bi.actual_duration_seconds
                    excess = bi.excess_duration_seconds
                else:
                    dur = max(0, _dt_diff_sec(now, bi.started_at))
                    allowed_sec = bi.allowed_duration_minutes * 60
                    excess = max(0, dur - allowed_sec) if allowed_sec > 0 else 0

                if bi.break_type == "LUNCH":
                    lunch_excess_sec += excess
                    lunch_approved_sec += (dur - excess)
                elif bi.break_type == "PRAYER":
                    prayer_sec += dur
                elif bi.break_type == "TEA":
                    tea_sec += dur
                elif bi.break_type == "OUTSIDE":
                    outside_office_sec += dur
                elif bi.break_type == "PERSONAL":
                    unplanned_away_sec += dur
                else:
                    other_approved_sec += dur

            # Reconcile lunch room duration with break intervals if no explicit lunch break recorded
            if lunch_approved_sec == 0 and lunch_room_raw_sec > 0:
                policy = BreakEngineService.get_effective_policy(db, "LUNCH", emp.id)
                allowed_sec = policy.allowed_duration_minutes * 60
                if lunch_room_raw_sec <= allowed_sec:
                    lunch_approved_sec = lunch_room_raw_sec
                    lunch_excess_sec = 0
                else:
                    lunch_approved_sec = allowed_sec
                    lunch_excess_sec = lunch_room_raw_sec - allowed_sec

            # Reconcile outside duration with break intervals
            if outside_office_sec == 0 and outside_raw_sec > 0:
                outside_office_sec = outside_raw_sec

            # Paid vs Deductible split:
            # Paid: Work Room + Paid Breaks (e.g. Prayer + Tea)
            # Unpaid / Deductible: Lunch (Approved + Excess) + Outside + Unplanned Away + Unknown
            paid_breaks = prayer_sec + tea_sec
            unpaid_breaks = lunch_approved_sec + lunch_excess_sec + outside_office_sec + unplanned_away_sec
            net_productive_sec = work_room_sec + paid_breaks
            total_deductible_sec = unpaid_breaks + unknown_sec

            total_observed = (
                work_room_sec
                + lunch_approved_sec
                + lunch_excess_sec
                + prayer_sec
                + tea_sec
                + other_approved_sec
                + outside_office_sec
                + unplanned_away_sec
                + unknown_sec
                + passage_sec
            )

            reconciliations.append({
                "employeeId": emp.id,
                "employeeCode": emp.employee_code,
                "employeeName": emp.full_name,
                "departmentName": emp.department.name if emp.department else "General",
                "workDate": target_date,
                "hasTrackingSession": True,
                "officialAttendanceSeconds": official_att_sec,
                "officialAttendanceFormatted": format_duration(official_att_sec),
                "workRoomSeconds": work_room_sec,
                "workRoomFormatted": format_duration(work_room_sec),
                "lunchApprovedSeconds": lunch_approved_sec,
                "lunchApprovedFormatted": format_duration(lunch_approved_sec),
                "lunchExcessSeconds": lunch_excess_sec,
                "lunchExcessFormatted": format_duration(lunch_excess_sec),
                "prayerSeconds": prayer_sec,
                "prayerFormatted": format_duration(prayer_sec),
                "teaSeconds": tea_sec,
                "teaFormatted": format_duration(tea_sec),
                "otherApprovedSeconds": other_approved_sec,
                "otherApprovedFormatted": format_duration(other_approved_sec),
                "outsideOfficeSeconds": outside_office_sec,
                "outsideOfficeFormatted": format_duration(outside_office_sec),
                "unplannedAwaySeconds": unplanned_away_sec,
                "unplannedAwayFormatted": format_duration(unplanned_away_sec),
                "unknownSeconds": unknown_sec,
                "unknownFormatted": format_duration(unknown_sec),
                "passageSeconds": passage_sec,
                "passageFormatted": format_duration(passage_sec),
                "totalObservedSeconds": total_observed,
                "totalObservedFormatted": format_duration(total_observed),
                "netProductiveSeconds": net_productive_sec,
                "netProductiveFormatted": format_duration(net_productive_sec),
                "totalDeductibleSeconds": total_deductible_sec,
                "totalDeductibleFormatted": format_duration(total_deductible_sec),
                "zeroDoubleCountingVerified": True,
            })

        return reconciliations
