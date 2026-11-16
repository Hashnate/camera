"""SQLAlchemy models.

Table, column and enum names mirror the original Prisma schema exactly (e.g. table "User",
column "passwordHash", enum type "UserRole"), so this backend works against a database that
Prisma created, and `python -m app.seed` creates the same schema on an empty database.
Python attributes are snake_case; the serializer emits the camelCase column names.
"""

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    Double,
    Enum,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, REAL, TIMESTAMP
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, utcnow

Timestamp = TIMESTAMP(precision=3)


def _uuid() -> str:
    return str(uuid.uuid4())


def _fk(target: str, ondelete: str) -> ForeignKey:
    return ForeignKey(target, ondelete=ondelete, onupdate="CASCADE")


def _pg_enum(cls: type[enum.Enum]) -> Enum:
    return Enum(cls, name=cls.__name__, values_callable=lambda e: [m.value for m in e])


# ---------------------------------------------------------------- enums


class UserRole(str, enum.Enum):
    SUPER_ADMIN = "SUPER_ADMIN"
    OFFICE_ADMIN = "OFFICE_ADMIN"
    HR_MANAGER = "HR_MANAGER"
    SUPERVISOR = "SUPERVISOR"
    VIEWER = "VIEWER"


class CameraStatus(str, enum.Enum):
    ONLINE = "ONLINE"
    OFFLINE = "OFFLINE"
    ERROR = "ERROR"
    MAINTENANCE = "MAINTENANCE"


class CameraProviderType(str, enum.Enum):
    EZVIZ = "EZVIZ"
    HIKVISION = "HIKVISION"
    DAHUA = "DAHUA"
    ONVIF_GENERIC = "ONVIF_GENERIC"


class ZoneType(str, enum.Enum):
    MAIN_OFFICE = "MAIN_OFFICE"
    DEVELOPMENT = "DEVELOPMENT"
    MEETING_ROOM = "MEETING_ROOM"
    RECEPTION = "RECEPTION"
    BREAK_AREA = "BREAK_AREA"
    RESTRICTED = "RESTRICTED"


class AttendanceStatus(str, enum.Enum):
    PRESENT = "PRESENT"
    LATE = "LATE"
    EARLY_DEPARTURE = "EARLY_DEPARTURE"
    HALF_DAY = "HALF_DAY"
    ABSENT = "ABSENT"


class CorrectionStatus(str, enum.Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


# ---------------------------------------------------------------- mixins


class _Created:
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)


class _Timestamps(_Created):
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt", Timestamp, default=utcnow, onupdate=utcnow, nullable=False
    )


# ---------------------------------------------------------------- models


class User(_Timestamps, Base):
    __tablename__ = "User"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column("passwordHash", Text, nullable=False)
    full_name: Mapped[str] = mapped_column("fullName", Text, nullable=False)
    role: Mapped[UserRole] = mapped_column(_pg_enum(UserRole), default=UserRole.VIEWER, nullable=False)
    company_id: Mapped[Optional[str]] = mapped_column("companyId", Text, _fk("Company.id", "SET NULL"))

    company: Mapped[Optional["Company"]] = relationship(back_populates="users")


class Company(_Timestamps, Base):
    __tablename__ = "Company"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    code: Mapped[str] = mapped_column(Text, unique=True, nullable=False)

    users: Mapped[list[User]] = relationship(back_populates="company", passive_deletes=True)
    offices: Mapped[list["Office"]] = relationship(back_populates="company", passive_deletes=True)


class Office(_Timestamps, Base):
    __tablename__ = "Office"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    company_id: Mapped[str] = mapped_column("companyId", Text, _fk("Company.id", "CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    timezone: Mapped[str] = mapped_column(Text, default="UTC", nullable=False)
    address: Mapped[Optional[str]] = mapped_column(Text)

    company: Mapped[Company] = relationship(back_populates="offices")


class Department(_Timestamps, Base):
    __tablename__ = "Department"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    office_id: Mapped[str] = mapped_column("officeId", Text, _fk("Office.id", "CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    code: Mapped[Optional[str]] = mapped_column(Text)


class WorkSchedule(_Timestamps, Base):
    __tablename__ = "WorkSchedule"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    office_id: Mapped[str] = mapped_column("officeId", Text, _fk("Office.id", "CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    start_time: Mapped[str] = mapped_column("startTime", Text, nullable=False)  # "09:00"
    end_time: Mapped[str] = mapped_column("endTime", Text, nullable=False)  # "17:00"
    grace_minutes: Mapped[int] = mapped_column("graceMinutes", Integer, default=15, nullable=False)
    working_days: Mapped[str] = mapped_column("workingDays", Text, default="1,2,3,4,5", nullable=False)


class Employee(_Timestamps, Base):
    __tablename__ = "Employee"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    department_id: Mapped[str] = mapped_column(
        "departmentId", Text, _fk("Department.id", "RESTRICT"), nullable=False
    )
    work_schedule_id: Mapped[Optional[str]] = mapped_column(
        "workScheduleId", Text, _fk("WorkSchedule.id", "SET NULL")
    )
    employee_code: Mapped[str] = mapped_column("employeeCode", Text, unique=True, nullable=False)
    full_name: Mapped[str] = mapped_column("fullName", Text, nullable=False)
    email: Mapped[Optional[str]] = mapped_column(Text)
    job_title: Mapped[str] = mapped_column("jobTitle", Text, nullable=False)
    assigned_zone: Mapped[Optional[str]] = mapped_column("assignedZone", Text)
    is_active: Mapped[bool] = mapped_column("isActive", Boolean, default=True, nullable=False)

    department: Mapped[Department] = relationship()
    work_schedule: Mapped[Optional[WorkSchedule]] = relationship()


class Camera(_Timestamps, Base):
    __tablename__ = "Camera"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    office_id: Mapped[str] = mapped_column("officeId", Text, _fk("Office.id", "CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    serial_number: Mapped[str] = mapped_column("serialNumber", Text, unique=True, nullable=False)
    provider: Mapped[CameraProviderType] = mapped_column(
        _pg_enum(CameraProviderType), default=CameraProviderType.EZVIZ, nullable=False
    )
    location: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[CameraStatus] = mapped_column(
        _pg_enum(CameraStatus), default=CameraStatus.OFFLINE, nullable=False
    )
    last_online_at: Mapped[Optional[datetime]] = mapped_column("lastOnlineAt", Timestamp)
    firmware_ver: Mapped[Optional[str]] = mapped_column("firmwareVer", Text)

    office: Mapped[Office] = relationship()


class CameraChannel(_Timestamps, Base):
    __tablename__ = "CameraChannel"
    __table_args__ = (UniqueConstraint("cameraId", "channelNo", name="CameraChannel_cameraId_channelNo_key"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    camera_id: Mapped[str] = mapped_column("cameraId", Text, _fk("Camera.id", "CASCADE"), nullable=False)
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    channel_name: Mapped[str] = mapped_column("channelName", Text, nullable=False)
    hls_url: Mapped[Optional[str]] = mapped_column("hlsUrl", Text)
    ezopen_url: Mapped[Optional[str]] = mapped_column("ezopenUrl", Text)
    snapshot_url: Mapped[Optional[str]] = mapped_column("snapshotUrl", Text)
    is_encrypted: Mapped[bool] = mapped_column("isEncrypted", Boolean, default=False, nullable=False)
    status: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class CameraEvent(Base):
    __tablename__ = "CameraEvent"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    camera_id: Mapped[str] = mapped_column("cameraId", Text, _fk("Camera.id", "CASCADE"), nullable=False)
    event_type: Mapped[str] = mapped_column("eventType", Text, nullable=False)  # CONNECTED, DISCONNECTED, ERROR
    message: Mapped[str] = mapped_column(Text, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)

    camera: Mapped[Camera] = relationship()


class OfficeZone(_Timestamps, Base):
    __tablename__ = "OfficeZone"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    office_id: Mapped[str] = mapped_column("officeId", Text, _fk("Office.id", "CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[ZoneType] = mapped_column(_pg_enum(ZoneType), default=ZoneType.MAIN_OFFICE, nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, default=10, nullable=False)
    polygon_coords: Mapped[Optional[str]] = mapped_column("polygonCoords", Text)  # JSON [[x,y], ...]
    is_restricted: Mapped[bool] = mapped_column("isRestricted", Boolean, default=False, nullable=False)


class DetectionEvent(Base):
    __tablename__ = "DetectionEvent"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    camera_id: Mapped[str] = mapped_column("cameraId", Text, _fk("Camera.id", "CASCADE"), nullable=False)
    zone_id: Mapped[Optional[str]] = mapped_column("zoneId", Text, _fk("OfficeZone.id", "SET NULL"))
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    tracking_id: Mapped[Optional[int]] = mapped_column("trackingId", Integer)  # anonymous tracking ID
    event_type: Mapped[str] = mapped_column("eventType", Text, nullable=False)
    confidence: Mapped[Optional[float]] = mapped_column(Double)
    person_count: Mapped[int] = mapped_column("personCount", Integer, default=1, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(Timestamp, default=utcnow, nullable=False)


class OccupancyRecord(Base):
    __tablename__ = "OccupancyRecord"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    zone_id: Mapped[str] = mapped_column("zoneId", Text, _fk("OfficeZone.id", "CASCADE"), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column("recordedAt", Timestamp, default=utcnow, nullable=False)
    person_count: Mapped[int] = mapped_column("personCount", Integer, default=0, nullable=False)
    is_over_capacity: Mapped[bool] = mapped_column("isOverCapacity", Boolean, default=False, nullable=False)


class AttendanceRecord(_Timestamps, Base):
    __tablename__ = "AttendanceRecord"
    __table_args__ = (UniqueConstraint("employeeId", "date", name="AttendanceRecord_employeeId_date_key"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False)
    date: Mapped[str] = mapped_column(Text, nullable=False)  # "YYYY-MM-DD"
    check_in: Mapped[Optional[datetime]] = mapped_column("checkIn", Timestamp)
    check_out: Mapped[Optional[datetime]] = mapped_column("checkOut", Timestamp)
    total_minutes: Mapped[int] = mapped_column("totalMinutes", Integer, default=0, nullable=False)
    status: Mapped[AttendanceStatus] = mapped_column(
        _pg_enum(AttendanceStatus), default=AttendanceStatus.PRESENT, nullable=False
    )
    is_late: Mapped[bool] = mapped_column("isLate", Boolean, default=False, nullable=False)
    is_early_departure: Mapped[bool] = mapped_column("isEarlyDeparture", Boolean, default=False, nullable=False)

    employee: Mapped[Employee] = relationship()
    corrections: Mapped[list["AttendanceCorrection"]] = relationship(passive_deletes=True)


class AttendanceCorrection(_Timestamps, Base):
    __tablename__ = "AttendanceCorrection"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    attendance_record_id: Mapped[str] = mapped_column(
        "attendanceRecordId", Text, _fk("AttendanceRecord.id", "CASCADE"), nullable=False
    )
    requested_check_in: Mapped[Optional[datetime]] = mapped_column("requestedCheckIn", Timestamp)
    requested_check_out: Mapped[Optional[datetime]] = mapped_column("requestedCheckOut", Timestamp)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[CorrectionStatus] = mapped_column(
        _pg_enum(CorrectionStatus), default=CorrectionStatus.PENDING, nullable=False
    )
    approved_by_id: Mapped[Optional[str]] = mapped_column("approvedById", Text, _fk("User.id", "SET NULL"))


class Notification(Base):
    __tablename__ = "Notification"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    user_id: Mapped[Optional[str]] = mapped_column("userId", Text, _fk("User.id", "CASCADE"))
    title: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)  # INFO, WARNING, ALERT
    is_read: Mapped[bool] = mapped_column("isRead", Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)


class AuditLog(Base):
    __tablename__ = "AuditLog"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    user_id: Mapped[Optional[str]] = mapped_column("userId", Text, _fk("User.id", "SET NULL"))
    action: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str] = mapped_column("entityType", Text, nullable=False)
    entity_id: Mapped[Optional[str]] = mapped_column("entityId", Text)
    details: Mapped[Optional[str]] = mapped_column(Text)  # JSON string
    ip_address: Mapped[Optional[str]] = mapped_column("ipAddress", Text)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)


# ---------------------------------------------------------------- automatic attendance (face recognition)


class FaceEnrollment(Base):
    """One face embedding for an employee who has consented to face recognition.

    Only the 128-number embedding is stored; enrolment photos are never saved.
    Deleting all of an employee's rows revokes their enrolment.
    """

    __tablename__ = "FaceEnrollment"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True)
    embedding: Mapped[list[float]] = mapped_column(ARRAY(REAL), nullable=False)
    source: Mapped[str] = mapped_column(Text, default="UPLOAD", nullable=False)  # UPLOAD | WEBCAM
    consent_given_at: Mapped[datetime] = mapped_column("consentGivenAt", Timestamp, nullable=False)
    consent_recorded_by_id: Mapped[Optional[str]] = mapped_column(
        "consentRecordedById", Text, _fk("User.id", "SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)


class RecognitionEvent(Base):
    """Audit log of every face match the AI service reported, and what it did to attendance."""

    __tablename__ = "RecognitionEvent"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False)
    camera_id: Mapped[Optional[str]] = mapped_column("cameraId", Text, _fk("Camera.id", "SET NULL"))
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    similarity: Mapped[float] = mapped_column(Double, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)  # CHECK_IN | CHECK_OUT | SEEN | IGNORED_INACTIVE
    attendance_record_id: Mapped[Optional[str]] = mapped_column(
        "attendanceRecordId", Text, _fk("AttendanceRecord.id", "SET NULL")
    )
    seen_at: Mapped[datetime] = mapped_column("seenAt", Timestamp, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)

    employee: Mapped[Employee] = relationship()
    camera: Mapped[Optional[Camera]] = relationship()
