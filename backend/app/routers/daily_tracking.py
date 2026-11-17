"""WorkSight v2.3 — Daily Employee Tracking & Automatic Working-Hour Calculation APIs."""

import hmac
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, Header, Query, Path
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import Employee, DailyTrackingSession, EmployeeZoneInterval, User
from app.security import current_user, json_body
from app.services.daily_tracking_engine import (
    DailyTrackingService,
    to_colombo_date_str,
    format_duration,
)

router = APIRouter(prefix="/api/tracking/daily", tags=["daily-tracking"])
internal_daily_router = APIRouter(prefix="/api/internal/tracking", tags=["internal-daily-tracking"])


def require_service_key(x_service_key: str = Header(default="")) -> None:
    if not settings.AI_SERVICE_KEY or not hmac.compare_digest(x_service_key, settings.AI_SERVICE_KEY):
        raise ApiError(401, "Invalid service key")


# ------------------------------------------------------------- Frontend Read APIs (Require User Auth)


@router.get("", dependencies=[Depends(current_user)])
def get_daily_tracking_sessions(
    date: Optional[str] = Query(default=None, description="Local date in YYYY-MM-DD format (Asia/Colombo)"),
    db: Session = Depends(get_db),
):
    """Return daily tracking sessions for all employees on the specified date."""
    target_date = date or to_colombo_date_str()
    data = DailyTrackingService.get_live_overview_for_date(db, target_date)
    return {
        "success": True,
        "date": target_date,
        "count": len(data),
        "data": data,
    }


@router.get("/live", dependencies=[Depends(current_user)])
def get_daily_tracking_live(db: Session = Depends(get_db)):
    """Return live real-time status of all employees with current zone, freshness, and live durations."""
    target_date = to_colombo_date_str()
    data = DailyTrackingService.get_live_overview_for_date(db, target_date)
    return {
        "success": True,
        "date": target_date,
        "timestamp": utcnow().isoformat() + "Z",
        "count": len(data),
        "data": data,
    }


@router.get("/summary", dependencies=[Depends(current_user)])
def get_daily_tracking_summary(
    date: Optional[str] = Query(default=None, description="Local date in YYYY-MM-DD format"),
    db: Session = Depends(get_db),
):
    """Aggregate organization-wide summary statistics for the workday."""
    target_date = date or to_colombo_date_str()
    records = DailyTrackingService.get_live_overview_for_date(db, target_date)

    total_tracked = len([r for r in records if r.get("hasTrackingSession")])
    in_work_room = len([r for r in records if r.get("currentZoneId") == "WORK_ROOM"])
    in_lunch_room = len([r for r in records if r.get("currentZoneId") == "LUNCH_ROOM"])
    in_passage = len([r for r in records if r.get("currentZoneId") == "PASSAGE"])
    outside = len([r for r in records if r.get("currentZoneId") == "OUTSIDE"])
    unknown = len([r for r in records if r.get("currentZoneId") == "UNKNOWN" or r.get("currentObservationStatus") == "NOT_RECENTLY_OBSERVED"])

    total_work_seconds = sum(r["durations"]["workRoomSeconds"] for r in records)
    total_lunch_seconds = sum(r["durations"]["lunchRoomSeconds"] for r in records)
    total_attendance_seconds = sum(r["durations"]["officialAttendanceSeconds"] for r in records)

    avg_work_seconds = int(total_work_seconds / total_tracked) if total_tracked > 0 else 0

    return {
        "success": True,
        "date": target_date,
        "summary": {
            "totalEmployees": len(records),
            "totalTrackedEmployees": total_tracked,
            "currentlyInWorkingRoom": in_work_room,
            "currentlyInLunchRoom": in_lunch_room,
            "currentlyInPassage": in_passage,
            "currentlyOutside": outside,
            "currentlyUnknown": unknown,
            "totalWorkingRoomSeconds": total_work_seconds,
            "totalWorkingRoomFormatted": format_duration(total_work_seconds),
            "totalLunchRoomSeconds": total_lunch_seconds,
            "totalLunchRoomFormatted": format_duration(total_lunch_seconds),
            "totalAttendanceSeconds": total_attendance_seconds,
            "totalAttendanceFormatted": format_duration(total_attendance_seconds),
            "averageWorkingRoomPerEmployee": format_duration(avg_work_seconds),
        },
    }


@router.get("/report", dependencies=[Depends(current_user)])
def get_daily_tracking_report(
    date: Optional[str] = Query(default=None, description="Local date in YYYY-MM-DD format"),
    db: Session = Depends(get_db),
):
    """End-of-day report with employee zone breakdowns, exception audit, and attendance reconcile."""
    target_date = date or to_colombo_date_str()
    records = DailyTrackingService.get_live_overview_for_date(db, target_date)

    report_items = []
    exceptions = []

    for r in records:
        durs = r["durations"]
        emp_id = r["employeeId"]

        # Flag potential exceptions: e.g. unknown duration > 1 hour, or attendance check-in without camera observation
        if durs["unknownSeconds"] >= 3600:
            exceptions.append({
                "employeeId": emp_id,
                "employeeName": r["employeeName"],
                "issue": "HIGH_UNOBSERVED_DURATION",
                "details": f"Unobserved/Unknown duration exceeded 1 hour ({durs['unknownFormatted']}).",
            })
        if r["attendanceCheckInAt"] and not r["hasTrackingSession"]:
            exceptions.append({
                "employeeId": emp_id,
                "employeeName": r["employeeName"],
                "issue": "CHECKIN_WITHOUT_CAMERA_TRACKING",
                "details": "Official check-in was registered but no camera tracking observations occurred.",
            })

        report_items.append({
            "employeeId": emp_id,
            "employeeCode": r["employeeCode"],
            "employeeName": r["employeeName"],
            "department": r["departmentName"],
            "firstObservedAt": r.get("firstObservedAt"),
            "attendanceCheckInAt": r.get("attendanceCheckInAt"),
            "attendanceCheckOutAt": r.get("attendanceCheckOutAt"),
            "attendanceStatus": r.get("attendanceStatus"),
            "workRoomDuration": durs["workRoomFormatted"],
            "workRoomSeconds": durs["workRoomSeconds"],
            "lunchRoomDuration": durs["lunchRoomFormatted"],
            "lunchRoomSeconds": durs["lunchRoomSeconds"],
            "outsideDuration": durs["outsideOfficeFormatted"],
            "outsideSeconds": durs["outsideOfficeSeconds"],
            "unknownDuration": durs["unknownFormatted"],
            "unknownSeconds": durs["unknownSeconds"],
            "totalObservedDuration": durs["totalObservedFormatted"],
            "officialAttendanceDuration": durs["officialAttendanceFormatted"],
            "sessionStatus": r.get("sessionStatus"),
        })

    return {
        "success": True,
        "date": target_date,
        "generatedAt": utcnow().isoformat() + "Z",
        "employeeCount": len(report_items),
        "exceptionsCount": len(exceptions),
        "exceptions": exceptions,
        "records": report_items,
    }


@router.get("/{employee_id}", dependencies=[Depends(current_user)])
def get_daily_tracking_for_employee(
    employee_id: str = Path(..., description="Employee permanent UUID"),
    date: Optional[str] = Query(default=None, description="Local date in YYYY-MM-DD format"),
    db: Session = Depends(get_db),
):
    """Return single employee's daily tracking details and duration metrics."""
    return DailyTrackingService.get_employee_daily_detail(db, employee_id, date)


@router.get("/{employee_id}/timeline", dependencies=[Depends(current_user)])
def get_employee_daily_timeline(
    employee_id: str = Path(..., description="Employee permanent UUID"),
    date: Optional[str] = Query(default=None, description="Local date in YYYY-MM-DD format"),
    db: Session = Depends(get_db),
):
    """Return chronological movement events and doorway transitions for an employee."""
    detail = DailyTrackingService.get_employee_daily_detail(db, employee_id, date)
    return {
        "success": True,
        "employeeId": employee_id,
        "date": detail.get("workDate"),
        "timeline": detail.get("timeline", []),
        "intervals": detail.get("intervals", []),
    }


@router.get("/{employee_id}/zones", dependencies=[Depends(current_user)])
def get_employee_daily_zones(
    employee_id: str = Path(..., description="Employee permanent UUID"),
    date: Optional[str] = Query(default=None, description="Local date in YYYY-MM-DD format"),
    db: Session = Depends(get_db),
):
    """Return zone duration breakdown for a specific employee."""
    detail = DailyTrackingService.get_employee_daily_detail(db, employee_id, date)
    return {
        "success": True,
        "employeeId": employee_id,
        "date": detail.get("workDate"),
        "durations": detail.get("durations", {}),
        "intervals": detail.get("intervals", []),
    }


@router.post("/{employee_id}/correct", dependencies=[Depends(current_user)])
def correct_employee_zone_interval(
    employee_id: str = Path(..., description="Employee permanent UUID"),
    body: dict = Depends(json_body),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Allow authorized administrator corrections with mandatory reasons and audit history."""
    interval_id = body.get("intervalId")
    new_zone_id = body.get("newZoneId")
    reason = body.get("reason", "")

    if not interval_id or not new_zone_id:
        raise ApiError(400, "intervalId and newZoneId are required.")

    interval = DailyTrackingService.manual_correct_interval(
        db=db,
        interval_id=interval_id,
        new_zone_id=new_zone_id,
        reason=reason,
        actor_user_id=user.id,
    )

    return {
        "success": True,
        "message": "Zone interval successfully corrected.",
        "intervalId": interval.id,
        "zoneId": interval.zone_id,
        "verificationStatus": interval.verification_status,
    }


@router.get("/{employee_id}/calculation", dependencies=[Depends(current_user)])
def get_employee_daily_calculation(
    employee_id: str = Path(..., description="Employee permanent UUID"),
    date: Optional[str] = Query(default=None, description="Local date in YYYY-MM-DD format"),
    db: Session = Depends(get_db),
):
    """Mutually exclusive zone duration totals and independent break classifications with reconciliation check."""
    return DailyTrackingService.get_employee_daily_calculation(db, employee_id, date)


@router.get("/{employee_id}/intervals", dependencies=[Depends(current_user)])
def get_employee_daily_intervals(
    employee_id: str = Path(..., description="Employee permanent UUID"),
    date: Optional[str] = Query(default=None, description="Local date in YYYY-MM-DD format"),
    db: Session = Depends(get_db),
):
    """Return clean, non-overlapping list of all discrete zone intervals for the employee and date."""
    return DailyTrackingService.get_employee_daily_intervals(db, employee_id, date)


@router.post("/{employee_id}/close", dependencies=[Depends(current_user)])
def close_employee_daily_session(
    employee_id: str = Path(..., description="Employee permanent UUID"),
    body: dict = Depends(json_body),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Administratively close an ongoing or incomplete daily tracking session with audit reason."""
    reason = body.get("reason", "Administrative day-end closure")
    target_status = body.get("sessionStatus", "COMPLETED")
    target_date = body.get("workDate")

    session = DailyTrackingService.close_daily_session(
        db=db,
        employee_id=employee_id,
        work_date=target_date,
        reason=reason,
        closed_by_user_id=user.id,
        target_status=target_status,
    )

    return {
        "success": True,
        "message": f"Daily tracking session for {employee_id} on {session.work_date} successfully marked {session.session_status}.",
        "sessionId": session.id,
        "employeeId": session.employee_id,
        "workDate": session.work_date,
        "sessionStatus": session.session_status,
        "closedAt": session.closed_at.isoformat() + "Z" if session.closed_at else None,
        "closureReason": session.closure_reason,
    }


# ------------------------------------------------------------- AI Service Ingestion API (Requires Service Key)


@internal_daily_router.post("/daily-events", dependencies=[Depends(require_service_key)])
def ingest_daily_tracking_events(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    """Ingest verified employee movement events or observation pulses from the AI Computer Vision worker."""
    events = body.get("events", [])
    if not events and body.get("employeeId"):
        events = [body]

    processed = 0
    now = utcnow()

    for ev in events:
        emp_id = ev.get("employeeId")
        if not emp_id:
            continue

        raw_ts = ev.get("timestamp") or ev.get("observedAt")
        event_time = now
        if raw_ts:
            try:
                event_time = datetime.fromisoformat(str(raw_ts).replace("Z", "+00:00"))
                if event_time.tzinfo is not None:
                    event_time = event_time.astimezone(timezone.utc).replace(tzinfo=None)
            except Exception:
                event_time = now

        cam_id = ev.get("cameraId")
        channel_no = int(ev.get("channelNo", 1))
        track_id = ev.get("cameraTrackId") or ev.get("trackId")
        event_type = ev.get("eventType")
        from_zone = ev.get("fromZoneId", "PASSAGE")
        to_zone = ev.get("toZoneId", "UNKNOWN")
        crossing_line = ev.get("crossingLineId")
        confidence = float(ev.get("confidence", 1.0))

        if event_type and event_type != "OBSERVATION_PULSE":
            # Doorway transition event
            DailyTrackingService.record_movement_event(
                db=db,
                employee_id=emp_id,
                event_type=event_type,
                from_zone_id=from_zone,
                to_zone_id=to_zone,
                crossing_line_id=crossing_line,
                observed_at=event_time,
                camera_id=cam_id,
                channel_no=channel_no,
                track_id=track_id,
                confidence=confidence,
            )
        else:
            # Observation pulse in current zone
            zone = ev.get("currentZoneId") or to_zone or "WORK_ROOM"
            DailyTrackingService.update_observation_pulse(
                db=db,
                employee_id=emp_id,
                camera_id=cam_id,
                channel_no=channel_no,
                track_id=track_id or 0,
                zone_id=zone,
                observed_at=event_time,
            )
        processed += 1

    db.commit()
    return {
        "success": True,
        "processed": processed,
    }
