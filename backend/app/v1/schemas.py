"""Request and response shapes of the integration API. These are the v1 contract: add fields, never change or remove.

Times are ISO 8601 in office time with the offset (e.g. 2026-11-26T09:02:00+05:30); dates are office dates (YYYY-MM-DD).
"""

from datetime import date
from typing import Literal, Optional

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class _Out(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class _In(BaseModel):
    # Unknown fields are refused, so a typo ("fullname") is an error instead of being silently ignored.
    model_config = ConfigDict(extra="forbid")


class Error(_Out):
    success: Literal[False] = False
    message: str


class Page(_Out):
    limit: int
    nextCursor: Optional[str] = Field(None, description="Pass as `cursor` to get the next page; null on the last page")


# ---------------------------------------------------------------- employees


class WorkSchedule(_Out):
    name: str
    startTime: str = Field(description="Office time, HH:MM")
    endTime: str = Field(description="Office time, HH:MM")
    graceMinutes: int = Field(description="Minutes after startTime before an arrival counts as late")
    workingDays: list[int] = Field(description="ISO weekdays: 1 = Monday ... 7 = Sunday")


class Department(_Out):
    name: str
    employees: int = Field(description="Active employees in the department")


class Employee(_Out):
    employeeCode: str = Field(description="Your key for the employee. Unique, upper case.")
    id: str = Field(description="WorkSight's own id. Never changes, even if the employeeCode is edited.")
    fullName: str
    email: Optional[str]
    phoneNumber: Optional[str]
    jobTitle: str
    department: Optional[str]
    workSchedule: Optional[WorkSchedule] = Field(description="null = no fixed hours (never counted late)")
    employmentType: Optional[str]
    joiningDate: Optional[str]
    isActive: bool = Field(description="Inactive employees aren't recognised by the cameras")
    faceEnrolled: bool = Field(
        description="Has an active face enrolment, so the cameras can recognise them. "
        "Read at request time: enrolling doesn't change updatedAt."
    )
    createdAt: str
    updatedAt: str = Field(description="Millisecond precision; pass the last one you saw as updatedSince")


class EmployeeList(_Out):
    success: bool = True
    data: list[Employee]
    page: Page


class EmployeeOne(_Out):
    success: bool = True
    data: Employee


class EmployeeUpsert(_In):
    """Fields you leave out are not changed. To add a new employee, fullName is required."""

    fullName: Optional[str] = Field(None, min_length=1, max_length=120)
    email: Optional[str] = Field(None, max_length=200)
    phoneNumber: Optional[str] = Field(None, max_length=40)
    jobTitle: Optional[str] = Field(None, max_length=120)
    department: Optional[str] = Field(
        None, min_length=1, max_length=120, description="Department name; created if it doesn't exist"
    )
    workSchedule: Optional[str] = Field(
        None, max_length=120, description="Name of an existing work schedule; null for no fixed hours"
    )
    employmentType: Optional[str] = Field(None, max_length=60, description="e.g. Full-Time, Part-Time, Contract")
    joiningDate: Optional[date] = None
    isActive: Optional[bool] = Field(None, description="false when someone leaves: the cameras stop recognising them")


class DepartmentList(_Out):
    success: bool = True
    data: list[Department]


class WorkScheduleList(_Out):
    success: bool = True
    data: list[WorkSchedule]


class EnrolmentLink(_Out):
    employeeCode: str
    url: Optional[str] = Field(description="Open on the employee's phone. null if no public address is set up.")
    token: str = Field(description="One-time token in the link. Shown once.")
    expiresAt: str


class EnrolmentLinkOne(_Out):
    success: bool = True
    data: EnrolmentLink


# ---------------------------------------------------------------- attendance


class Attendance(_Out):
    id: str = Field(description="Stable id of the record: upsert on it when syncing")
    employeeCode: str
    employeeName: str
    date: str = Field(description="Office date of the check-in")
    status: Literal["PRESENT", "LATE", "EARLY_DEPARTURE", "HALF_DAY", "ABSENT"]
    checkIn: Optional[str]
    checkOut: Optional[str] = Field(
        description="For camera attendance this is the last time they were seen, so it moves on during the day"
    )
    workedMinutes: int = Field(description="checkIn to checkOut, including time away. See /timesheets for time inside.")
    isLate: bool
    isEarlyDeparture: bool
    source: Literal["CAMERA", "MANUAL"]
    updatedAt: str = Field(description="Millisecond precision; pass the last one you saw as updatedSince")


class AttendanceList(_Out):
    success: bool = True
    data: list[Attendance]
    page: Page


class AttendanceOne(_Out):
    success: bool = True
    data: Attendance


class CheckIn(_In):
    employeeCode: str = Field(min_length=1, max_length=40)
    at: Optional[AwareDatetime] = Field(
        None, description="When it happened, with a UTC offset. Default: now. Up to 31 days back, not in the future."
    )


class CheckOut(CheckIn):
    pass


class TimesheetDay(_Out):
    date: str
    isWorkingDay: Optional[bool] = Field(description="From the work schedule; null if they have none")
    present: bool
    checkIn: Optional[str]
    lastSeen: Optional[str]
    insideMinutes: int = Field(description="Time actually inside the office (camera sightings), away periods excluded")
    awayMinutes: int
    timesAway: int
    spanMinutes: int = Field(description="checkIn to lastSeen")
    isLate: bool
    lateByMinutes: int
    isEarlyDeparture: bool
    measured: bool = Field(description="false = manual check-in without camera sightings: inside = span")


class TimesheetTotals(_Out):
    daysPresent: int
    workingDays: Optional[int] = Field(description="Working days in the range per the schedule; null without one")
    lateDays: int
    earlyDepartureDays: int
    insideMinutes: int
    awayMinutes: int
    spanMinutes: int


class Timesheet(_Out):
    employeeCode: str
    fullName: str
    department: Optional[str]
    isActive: bool
    scheduledMinutesPerDay: Optional[int]
    totals: TimesheetTotals
    days: list[TimesheetDay] = Field(description="Every date in the range, present or not")


class TimesheetList(_Out):
    success: bool = True
    from_: str = Field(alias="from")
    to: str
    awayAfterMin: int = Field(description="Unseen for longer than this counts as away")
    data: list[Timesheet]


class PresenceItem(_Out):
    employeeCode: str
    fullName: str
    department: Optional[str]
    state: Literal["IN_OFFICE", "AWAY", "NOT_SEEN_TODAY"] = Field(
        description="IN_OFFICE: seen within awayAfterMin. AWAY: here today, not seen since (stepped out or gone home)."
    )
    checkIn: Optional[str]
    lastSeen: Optional[str]
    insideMinutes: int


class PresenceSummary(_Out):
    employees: int
    inOffice: int
    away: int
    notSeenToday: int


class PresenceNow(_Out):
    success: bool = True
    date: str
    asOf: str
    awayAfterMin: int
    summary: PresenceSummary
    data: list[PresenceItem]


# ---------------------------------------------------------------- webhooks


class Webhook(_Out):
    id: str
    url: str
    description: Optional[str]
    events: list[str]
    awayAfterMin: int = Field(description="Unseen for longer than this counts as went_away")
    createdAt: str
    createdBy: Literal["api", "dashboard"]
    apiKeyName: Optional[str]
    isActive: bool = Field(description="false once the API key it was made with is revoked")
    lastDeliveryAt: Optional[str]
    lastStatus: Optional[Literal["OK", "FAILING"]]
    lastError: Optional[str]


class WebhookWithSecret(Webhook):
    secret: str = Field(description="Signing secret (whsec_...). Shown once: store it to verify X-WorkSight-Signature.")


class WebhookList(_Out):
    success: bool = True
    data: list[Webhook]


class WebhookCreated(_Out):
    success: bool = True
    data: WebhookWithSecret


class WebhookCreate(_In):
    url: str = Field(min_length=8, max_length=500, description="https:// address WorkSight will POST events to")
    events: Optional[list[str]] = Field(None, description="Default: all of employee.arrived, employee.went_away, employee.came_back")
    awayAfterMin: int = Field(15, ge=1, le=120, description="Minutes unseen before employee.went_away is sent")
    description: Optional[str] = Field(None, max_length=200)


class Delivery(_Out):
    id: str = Field(description="Also the event's id in the body: use it to ignore repeats")
    event: str
    status: Literal["PENDING", "SENDING", "DELIVERED", "FAILED"]
    attempts: int
    createdAt: str
    deliveredAt: Optional[str]
    nextAttemptAt: Optional[str]
    lastStatusCode: Optional[int]
    lastError: Optional[str]
    data: Optional[dict]


class DeliveryList(_Out):
    success: bool = True
    data: list[Delivery]


class DeliveryOne(_Out):
    success: bool = True
    data: Delivery
