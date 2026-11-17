"""SQLAlchemy models.

Table, column and enum names mirror the original Prisma schema exactly (e.g. table "User",
column "passwordHash", enum type "UserRole"), so this backend works against a database that
Prisma created, and `python -m app.seed` creates the same schema on an empty database.
Python attributes are snake_case; the serializer emits the camelCase column names.
"""

import enum
import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    Date,
    Double,
    Enum,
    ForeignKey,
    Index,
    Integer,
    JSON,
    LargeBinary,
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
    phone_number: Mapped[Optional[str]] = mapped_column("phoneNumber", Text)
    employment_type: Mapped[Optional[str]] = mapped_column("employmentType", Text)
    joining_date: Mapped[Optional[str]] = mapped_column("joiningDate", Text)
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


# ---------------------------------------------------------------- WorkSight v2.0 Hybrid Architecture Models


class FaceTemplate(Base):
    """AES-256-GCM encrypted face embedding template for authorized employees."""

    __tablename__ = "FaceTemplate"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True)
    encrypted_embedding: Mapped[bytes] = mapped_column("encryptedEmbedding", LargeBinary, nullable=False)
    embedding_iv: Mapped[str] = mapped_column("embeddingIv", Text, nullable=False)
    embedding_tag: Mapped[str] = mapped_column("embeddingTag", Text, nullable=False)
    encryption_key_id: Mapped[str] = mapped_column("encryptionKeyId", Text, default="v2-master-key-01", nullable=False)
    algorithm: Mapped[str] = mapped_column(Text, default="AES-256-GCM", nullable=False)
    model_version: Mapped[str] = mapped_column("modelVersion", Text, default="SFace-2021dec", nullable=False)
    quality_score: Mapped[float] = mapped_column("qualityScore", Double, default=1.0, nullable=False)
    sample_count: Mapped[int] = mapped_column("sampleCount", Integer, default=1, nullable=False)
    status: Mapped[str] = mapped_column(Text, default="ACTIVE", nullable=False)  # ACTIVE | REVOKED
    enrollment_authorization_reference: Mapped[Optional[str]] = mapped_column("enrollmentAuthorizationReference", Text)
    enrolled_by_id: Mapped[Optional[str]] = mapped_column("enrolledById", Text, _fk("User.id", "SET NULL"))
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)
    revoked_at: Mapped[Optional[datetime]] = mapped_column("revokedAt", Timestamp)

    employee: Mapped[Employee] = relationship()


class RecognitionObservation(Base):
    """System A: Observational evidence from camera face recognition without automatic attendance."""

    __tablename__ = "RecognitionObservation"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column("eventId", Text, unique=True, default=_uuid, nullable=False)
    employee_id: Mapped[Optional[str]] = mapped_column("employeeId", Text, _fk("Employee.id", "SET NULL"), index=True)
    camera_id: Mapped[Optional[str]] = mapped_column("cameraId", Text, _fk("Camera.id", "SET NULL"))
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    zone_id: Mapped[Optional[str]] = mapped_column("zoneId", Text, _fk("OfficeZone.id", "SET NULL"))
    observed_at: Mapped[datetime] = mapped_column("observedAt", Timestamp, nullable=False, index=True)
    received_at: Mapped[datetime] = mapped_column("receivedAt", Timestamp, default=utcnow, nullable=False)
    similarity_score: Mapped[Optional[float]] = mapped_column("similarityScore", Double)
    recognition_model: Mapped[str] = mapped_column("recognitionModel", Text, default="SFace", nullable=False)
    recognition_version: Mapped[str] = mapped_column("recognitionVersion", Text, default="2021dec", nullable=False)
    track_ref: Mapped[Optional[str]] = mapped_column("trackRef", Text)
    deduplication_key: Mapped[Optional[str]] = mapped_column("deduplicationKey", Text, index=True)
    is_unknown: Mapped[bool] = mapped_column("isUnknown", Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)

    employee: Mapped[Optional[Employee]] = relationship()
    camera: Mapped[Optional[Camera]] = relationship()


class PresenceSession(Base):
    """System A: Real-time employee presence state tracking with uncertainty."""

    __tablename__ = "PresenceSession"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True)
    started_at: Mapped[datetime] = mapped_column("startedAt", Timestamp, default=utcnow, nullable=False)
    last_observed_at: Mapped[datetime] = mapped_column("lastObservedAt", Timestamp, default=utcnow, nullable=False)
    closed_at: Mapped[Optional[datetime]] = mapped_column("closedAt", Timestamp)
    current_status: Mapped[str] = mapped_column(
        "currentStatus", Text, default="OBSERVED_RECENTLY", nullable=False
    )  # OBSERVED_RECENTLY | NOT_RECENTLY_OBSERVED | SENSOR_UNAVAILABLE
    current_zone_id: Mapped[Optional[str]] = mapped_column("currentZoneId", Text)
    last_camera_id: Mapped[Optional[str]] = mapped_column("lastCameraId", Text, _fk("Camera.id", "SET NULL"))
    last_channel_no: Mapped[Optional[int]] = mapped_column("lastChannelNo", Integer)
    last_similarity: Mapped[Optional[float]] = mapped_column("lastSimilarity", Double)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", Timestamp, default=utcnow, onupdate=utcnow, nullable=False)

    employee: Mapped[Employee] = relationship()


class WorkSession(Base):
    """System B: Transactional work session representing official authorized attendance."""

    __tablename__ = "WorkSession"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True)
    check_in_at: Mapped[datetime] = mapped_column("checkInAt", Timestamp, nullable=False)
    check_out_at: Mapped[Optional[datetime]] = mapped_column("checkOutAt", Timestamp)
    status: Mapped[str] = mapped_column(Text, default="OPEN", nullable=False)  # OPEN | CLOSED
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", Timestamp, default=utcnow, onupdate=utcnow, nullable=False)

    employee: Mapped[Employee] = relationship()


class AttendanceEvent(Base):
    """System B: Immutable attendance event for check-in/out audits and corrections."""

    __tablename__ = "AttendanceEvent"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    idempotency_key: Mapped[str] = mapped_column("idempotencyKey", Text, unique=True, nullable=False)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True)
    action: Mapped[str] = mapped_column(Text, nullable=False)  # CHECK_IN | CHECK_OUT
    source: Mapped[str] = mapped_column(Text, default="EMPLOYEE", nullable=False)  # EMPLOYEE | ADMIN
    effective_at: Mapped[datetime] = mapped_column("effectiveAt", Timestamp, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column("recordedAt", Timestamp, default=utcnow, nullable=False)
    actor_user_id: Mapped[Optional[str]] = mapped_column("actorUserId", Text, _fk("User.id", "SET NULL"))
    reason: Mapped[Optional[str]] = mapped_column(Text)
    session_id: Mapped[Optional[str]] = mapped_column("sessionId", Text, _fk("WorkSession.id", "CASCADE"))

    employee: Mapped[Employee] = relationship()
    session: Mapped[Optional[WorkSession]] = relationship()


class AttendanceReview(Base):
    """System B: Exception and dispute review queue for administrator decisions."""

    __tablename__ = "AttendanceReview"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True)
    session_id: Mapped[Optional[str]] = mapped_column("sessionId", Text, _fk("WorkSession.id", "SET NULL"))
    issue_type: Mapped[str] = mapped_column(
        "issueType", Text, nullable=False
    )  # MISSING_CHECKOUT | MISSED_CHECKIN | ATTENDANCE_CORRECTION | SESSION_CONFLICT | EMPLOYEE_DISPUTE
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, default="OPEN", nullable=False)  # OPEN | RESOLVED | DISMISSED
    resolved_by_id: Mapped[Optional[str]] = mapped_column("resolvedById", Text, _fk("User.id", "SET NULL"))
    resolution: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)
    resolved_at: Mapped[Optional[datetime]] = mapped_column("resolvedAt", Timestamp)

    employee: Mapped[Employee] = relationship()


class CameraHealthEvent(Base):
    """System A: Camera and channel health tracking."""

    __tablename__ = "CameraHealthEvent"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    camera_id: Mapped[str] = mapped_column("cameraId", Text, _fk("Camera.id", "CASCADE"), nullable=False, index=True)
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)  # ONLINE | DEGRADED | OFFLINE
    observed_at: Mapped[datetime] = mapped_column("observedAt", Timestamp, default=utcnow, nullable=False)
    error_code: Mapped[Optional[str]] = mapped_column("errorCode", Text)
    reconnect_attempts: Mapped[int] = mapped_column("reconnectAttempts", Integer, default=0, nullable=False)
    last_frame_at: Mapped[Optional[datetime]] = mapped_column("lastFrameAt", Timestamp)
    inference_latency: Mapped[Optional[float]] = mapped_column("inferenceLatency", Double)
    dropped_frames: Mapped[int] = mapped_column("droppedFrames", Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)


# ------------------------------------------------------------- Real-Time Tracking & Office Zone Detection Models


class CameraZoneConfiguration(Base):
    """Normalized polygon boundary configuration for office zones."""

    __tablename__ = "CameraZoneConfiguration"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    camera_id: Mapped[str] = mapped_column("cameraId", Text, _fk("Camera.id", "CASCADE"), nullable=False, index=True)
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    zone_id: Mapped[str] = mapped_column("zoneId", Text, nullable=False)  # WORK_ROOM, LUNCH_ROOM, PASSAGE, MAIN_EXIT
    zone_name: Mapped[str] = mapped_column("zoneName", Text, nullable=False)
    normalized_polygon: Mapped[list] = mapped_column("normalizedPolygon", JSON, nullable=False)  # [[x,y], [x,y], ...]
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    configuration_version: Mapped[int] = mapped_column("configurationVersion", Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", Timestamp, default=utcnow, onupdate=utcnow, nullable=False)

    camera: Mapped[Camera] = relationship()


class DoorCrossingLine(Base):
    """Directional doorway crossing line for movement detection."""

    __tablename__ = "DoorCrossingLine"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    camera_id: Mapped[str] = mapped_column("cameraId", Text, _fk("Camera.id", "CASCADE"), nullable=False, index=True)
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    line_id: Mapped[str] = mapped_column("lineId", Text, nullable=False)  # LINE_WORK, LINE_LUNCH, LINE_EXIT
    line_name: Mapped[str] = mapped_column("lineName", Text, nullable=False)
    normalized_start_point: Mapped[list] = mapped_column("normalizedStartPoint", JSON, nullable=False)  # [x, y]
    normalized_end_point: Mapped[list] = mapped_column("normalizedEndPoint", JSON, nullable=False)      # [x, y]
    direction_mapping: Mapped[dict] = mapped_column("directionMapping", JSON, nullable=False)
    # e.g. {"forward": {"event": "LUNCH_ROOM_ENTERED", "from": "PASSAGE", "to": "LUNCH_ROOM"},
    #       "backward": {"event": "LUNCH_ROOM_EXITED", "from": "LUNCH_ROOM", "to": "PASSAGE"}}
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column("updatedAt", Timestamp, default=utcnow, onupdate=utcnow, nullable=False)

    camera: Mapped[Camera] = relationship()


class PersonTrackSession(Base):
    """Temporary per-camera person tracking session."""

    __tablename__ = "PersonTrackSession"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    camera_id: Mapped[str] = mapped_column("cameraId", Text, _fk("Camera.id", "CASCADE"), nullable=False, index=True)
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    track_id: Mapped[int] = mapped_column("trackId", Integer, nullable=False)
    employee_id: Mapped[Optional[str]] = mapped_column("employeeId", Text, _fk("Employee.id", "SET NULL"), index=True)
    started_at: Mapped[datetime] = mapped_column("startedAt", Timestamp, default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column("lastSeenAt", Timestamp, default=utcnow, nullable=False)
    ended_at: Mapped[Optional[datetime]] = mapped_column("endedAt", Timestamp)
    identity_verification_status: Mapped[str] = mapped_column(
        "identityVerificationStatus", Text, default="UNVERIFIED", nullable=False
    )  # UNVERIFIED | VERIFIED | UNCERTAIN
    current_zone_id: Mapped[Optional[str]] = mapped_column("currentZoneId", Text)
    # v2.9 — ILE extended columns
    identity_state: Mapped[str] = mapped_column("identityState", Text, default="UNVERIFIED", nullable=False)
    last_face_seen_at: Mapped[Optional[datetime]] = mapped_column("lastFaceSeenAt", Timestamp)
    tracking_without_face_sec: Mapped[float] = mapped_column("trackingWithoutFaceSec", Double, default=0.0, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)

    employee: Mapped[Optional[Employee]] = relationship()
    camera: Mapped[Camera] = relationship()


class TrackObservation(Base):
    """Sampled bounding box & position observation within a track session."""

    __tablename__ = "TrackObservation"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    track_session_id: Mapped[str] = mapped_column("trackSessionId", Text, _fk("PersonTrackSession.id", "CASCADE"), nullable=False, index=True)
    observed_at: Mapped[datetime] = mapped_column("observedAt", Timestamp, default=utcnow, nullable=False)
    bounding_box: Mapped[list] = mapped_column("boundingBox", JSON, nullable=False)  # [x, y, w, h] normalized
    zone_id: Mapped[Optional[str]] = mapped_column("zoneId", Text)
    detection_score: Mapped[float] = mapped_column("detectionScore", Double, default=0.0, nullable=False)
    recognition_observation_id: Mapped[Optional[str]] = mapped_column("recognitionObservationId", Text, _fk("RecognitionObservation.id", "SET NULL"))
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)

    session: Mapped[PersonTrackSession] = relationship()


class ZoneTransitionEvent(Base):
    """Verified doorway crossing / zone movement event."""

    __tablename__ = "ZoneTransitionEvent"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[Optional[str]] = mapped_column("employeeId", Text, _fk("Employee.id", "SET NULL"), index=True)
    track_session_id: Mapped[Optional[str]] = mapped_column("trackSessionId", Text, _fk("PersonTrackSession.id", "SET NULL"))
    camera_id: Mapped[str] = mapped_column("cameraId", Text, _fk("Camera.id", "CASCADE"), nullable=False)
    channel_no: Mapped[int] = mapped_column("channelNo", Integer, default=1, nullable=False)
    crossing_line_id: Mapped[str] = mapped_column("crossingLineId", Text, nullable=False)  # LINE_WORK, LINE_LUNCH, LINE_EXIT
    from_zone_id: Mapped[str] = mapped_column("fromZoneId", Text, nullable=False)
    to_zone_id: Mapped[str] = mapped_column("toZoneId", Text, nullable=False)
    event_type: Mapped[str] = mapped_column("eventType", Text, nullable=False)
    # WORK_ROOM_ENTERED, WORK_ROOM_EXITED, LUNCH_ROOM_ENTERED, LUNCH_ROOM_EXITED, OFFICE_ENTRY_OBSERVED, OFFICE_EXIT_OBSERVED
    observed_at: Mapped[datetime] = mapped_column("observedAt", Timestamp, default=utcnow, nullable=False, index=True)
    verification_status: Mapped[str] = mapped_column("verificationStatus", Text, default="VERIFIED", nullable=False)  # VERIFIED | ANONYMOUS | UNCERTAIN
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)

    employee: Mapped[Optional[Employee]] = relationship()
    camera: Mapped[Camera] = relationship()


# ------------------------------------------------------------- WorkSight v2.3 Daily Tracking & Zone Duration Models


class DailyTrackingSession(_Timestamps, Base):
    """Daily aggregated tracking session for an employee tied to permanent Employee UUID.

    Maintains firstObservedAt, attendance check-in/out references,
    session status, and real-time zone duration calculations across the working day.
    """

    __tablename__ = "DailyTrackingSession"
    __table_args__ = (
        UniqueConstraint("employeeId", "workDate", name="DailyTrackingSession_employeeId_workDate_key"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True)
    work_date: Mapped[str] = mapped_column("workDate", Text, nullable=False, index=True)  # "YYYY-MM-DD" local Asia/Colombo
    first_observed_at: Mapped[datetime] = mapped_column("firstObservedAt", Timestamp, default=utcnow, nullable=False)
    last_observed_at: Mapped[datetime] = mapped_column("lastObservedAt", Timestamp, default=utcnow, nullable=False)
    attendance_check_in_at: Mapped[Optional[datetime]] = mapped_column("attendanceCheckInAt", Timestamp)
    attendance_check_out_at: Mapped[Optional[datetime]] = mapped_column("attendanceCheckOutAt", Timestamp)
    session_status: Mapped[str] = mapped_column(
        "sessionStatus", Text, default="ACTIVE", nullable=False
    )  # ACTIVE | PAUSED | CLOSED | COMPLETED | INCOMPLETE | REQUIRES_REVIEW | REVIEW_REQUIRED
    current_zone_id: Mapped[str] = mapped_column(
        "currentZoneId", Text, default="UNKNOWN", nullable=False
    )  # WORK_ROOM | LUNCH_ROOM | PASSAGE | OUTSIDE | UNKNOWN
    current_observation_status: Mapped[str] = mapped_column(
        "currentObservationStatus", Text, default="OBSERVED_RECENTLY", nullable=False
    )  # OBSERVED_RECENTLY | NOT_RECENTLY_OBSERVED | SENSOR_UNAVAILABLE
    last_camera_id: Mapped[Optional[str]] = mapped_column("lastCameraId", Text, _fk("Camera.id", "SET NULL"))
    last_channel_no: Mapped[Optional[int]] = mapped_column("lastChannelNo", Integer)
    last_track_id: Mapped[Optional[int]] = mapped_column("lastTrackId", Integer)
    closed_at: Mapped[Optional[datetime]] = mapped_column("closedAt", Timestamp)
    closed_by_user_id: Mapped[Optional[str]] = mapped_column("closedByUserId", Text, _fk("User.id", "SET NULL"))
    closure_reason: Mapped[Optional[str]] = mapped_column("closureReason", Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)

    employee: Mapped[Employee] = relationship()
    camera: Mapped[Optional[Camera]] = relationship()
    intervals: Mapped[list["EmployeeZoneInterval"]] = relationship(
        back_populates="daily_session", cascade="all, delete-orphan", order_by="EmployeeZoneInterval.entered_at"
    )
    events: Mapped[list["EmployeeMovementEvent"]] = relationship(
        back_populates="daily_session", cascade="all, delete-orphan", order_by="EmployeeMovementEvent.event_timestamp"
    )
    break_intervals: Mapped[list["BreakInterval"]] = relationship(
        back_populates="daily_session", cascade="all, delete-orphan", order_by="BreakInterval.started_at"
    )


class EmployeeZoneInterval(Base):
    """Contiguous time interval spent by an employee in a specific office zone."""

    __tablename__ = "EmployeeZoneInterval"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    daily_session_id: Mapped[str] = mapped_column(
        "dailySessionId", Text, _fk("DailyTrackingSession.id", "CASCADE"), nullable=False, index=True
    )
    zone_id: Mapped[str] = mapped_column("zoneId", Text, nullable=False, index=True)
    # WORK_ROOM | LUNCH_ROOM | PASSAGE | OUTSIDE | UNKNOWN
    entered_at: Mapped[datetime] = mapped_column("enteredAt", Timestamp, nullable=False, index=True)
    exited_at: Mapped[Optional[datetime]] = mapped_column("exitedAt", Timestamp)
    duration_seconds: Mapped[int] = mapped_column("durationSeconds", Integer, default=0, nullable=False)
    verification_status: Mapped[str] = mapped_column(
        "verificationStatus", Text, default="VERIFIED", nullable=False
    )  # VERIFIED | UNCERTAIN | ESTIMATED
    source_camera_id: Mapped[Optional[str]] = mapped_column("sourceCameraId", Text, _fk("Camera.id", "SET NULL"))
    source_channel_no: Mapped[Optional[int]] = mapped_column("sourceChannelNo", Integer)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)

    daily_session: Mapped[DailyTrackingSession] = relationship(back_populates="intervals")
    camera: Mapped[Optional[Camera]] = relationship()


class EmployeeMovementEvent(Base):
    """Discrete doorway crossing or directional zone movement event for an employee."""

    __tablename__ = "EmployeeMovementEvent"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    daily_session_id: Mapped[str] = mapped_column(
        "dailySessionId", Text, _fk("DailyTrackingSession.id", "CASCADE"), nullable=False, index=True
    )
    employee_id: Mapped[str] = mapped_column("employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True)
    camera_track_id: Mapped[Optional[int]] = mapped_column("cameraTrackId", Integer)
    event_type: Mapped[str] = mapped_column("eventType", Text, nullable=False)
    # LUNCH_ROOM_ENTERED | LUNCH_ROOM_EXITED | WORK_ROOM_ENTERED | WORK_ROOM_EXITED | OFFICE_EXIT_OBSERVED | OFFICE_ENTRY_OBSERVED
    from_zone_id: Mapped[Optional[str]] = mapped_column("fromZoneId", Text)
    to_zone_id: Mapped[Optional[str]] = mapped_column("toZoneId", Text)
    crossing_line_id: Mapped[Optional[str]] = mapped_column("crossingLineId", Text)
    event_timestamp: Mapped[datetime] = mapped_column("eventTimestamp", Timestamp, nullable=False, index=True)
    verification_confidence: Mapped[float] = mapped_column("verificationConfidence", Double, default=1.0, nullable=False)
    source_camera_id: Mapped[Optional[str]] = mapped_column("sourceCameraId", Text, _fk("Camera.id", "SET NULL"))
    source_channel_no: Mapped[Optional[int]] = mapped_column("sourceChannelNo", Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)

    daily_session: Mapped[DailyTrackingSession] = relationship(back_populates="events")
    employee: Mapped[Employee] = relationship()
    camera: Mapped[Optional[Camera]] = relationship()


# ------------------------------------------------------------- WorkSight v2.8 Break & Away-Time Engine Models


class BreakPolicy(_Timestamps, Base):
    """Configurable break allowances and paid/unpaid rules."""

    __tablename__ = "BreakPolicy"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    company_id: Mapped[str] = mapped_column("companyId", Text, _fk("Company.id", "CASCADE"), nullable=False, index=True)
    employee_id: Mapped[Optional[str]] = mapped_column("employeeId", Text, _fk("Employee.id", "SET NULL"), index=True)
    # None = shared company-wide policy, or specific employee UUID for personalized allowances
    break_type: Mapped[str] = mapped_column("breakType", Text, nullable=False, index=True)
    # LUNCH | PRAYER | TEA | PERSONAL | OUTSIDE | OTHER
    name: Mapped[str] = mapped_column(Text, nullable=False)
    allowed_duration_minutes: Mapped[int] = mapped_column("allowedDurationMinutes", Integer, nullable=False)
    is_paid: Mapped[bool] = mapped_column("isPaid", Boolean, default=False, nullable=False)
    max_count_per_day: Mapped[int] = mapped_column("maxCountPerDay", Integer, default=1, nullable=False)
    effective_from: Mapped[date] = mapped_column("effectiveFrom", Date, default=utcnow, nullable=False)
    is_active: Mapped[bool] = mapped_column("isActive", Boolean, default=True, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)

    company: Mapped[Company] = relationship()
    employee: Mapped[Optional[Employee]] = relationship()


class BreakInterval(_Timestamps, Base):
    """Mutually exclusive verified break or away-time interval."""

    __tablename__ = "BreakInterval"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    daily_session_id: Mapped[str] = mapped_column(
        "dailySessionId", Text, _fk("DailyTrackingSession.id", "CASCADE"), nullable=False, index=True
    )
    employee_id: Mapped[str] = mapped_column(
        "employeeId", Text, _fk("Employee.id", "CASCADE"), nullable=False, index=True
    )
    break_type: Mapped[str] = mapped_column("breakType", Text, nullable=False, index=True)
    # LUNCH | PRAYER | TEA | PERSONAL | OUTSIDE | OTHER
    started_at: Mapped[datetime] = mapped_column("startedAt", Timestamp, nullable=False, index=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column("endedAt", Timestamp, index=True)
    actual_duration_seconds: Mapped[int] = mapped_column("actualDurationSeconds", Integer, default=0, nullable=False)
    allowed_duration_minutes: Mapped[int] = mapped_column("allowedDurationMinutes", Integer, default=0, nullable=False)
    excess_duration_seconds: Mapped[int] = mapped_column("excessDurationSeconds", Integer, default=0, nullable=False)
    classification: Mapped[str] = mapped_column("classification", Text, default="ONGOING", nullable=False)
    # APPROVED_LUNCH | BREAK_ALLOWANCE_EXCEEDED | OUTSIDE_INTERVAL | APPROVED_BREAK | UNPLANNED_AWAY | ONGOING
    source: Mapped[str] = mapped_column(Text, default="CAMERA_DOORWAY_CROSSING", nullable=False)
    # CAMERA_DOORWAY_CROSSING | AUTHORIZED_DECLARATION | ADMIN_OVERRIDE
    source_movement_id: Mapped[Optional[str]] = mapped_column(
        "sourceMovementId", Text, _fk("EmployeeMovementEvent.id", "SET NULL")
    )
    zone_interval_id: Mapped[Optional[str]] = mapped_column(
        "zoneIntervalId", Text, _fk("EmployeeZoneInterval.id", "SET NULL")
    )
    is_paid: Mapped[bool] = mapped_column("isPaid", Boolean, default=False, nullable=False)
    payroll_deductible: Mapped[bool] = mapped_column("payrollDeductible", Boolean, default=False, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)

    daily_session: Mapped[DailyTrackingSession] = relationship(back_populates="break_intervals")
    employee: Mapped[Employee] = relationship()
    source_movement: Mapped[Optional[EmployeeMovementEvent]] = relationship()
    zone_interval: Mapped[Optional[EmployeeZoneInterval]] = relationship()
    audits: Mapped[list["BreakCorrectionAudit"]] = relationship(
        back_populates="break_interval", cascade="all, delete-orphan", order_by="BreakCorrectionAudit.created_at"
    )


class BreakCorrectionAudit(Base):
    """Administrator audit record for manual break adjustments."""

    __tablename__ = "BreakCorrectionAudit"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    break_interval_id: Mapped[str] = mapped_column(
        "breakIntervalId", Text, _fk("BreakInterval.id", "CASCADE"), nullable=False, index=True
    )
    admin_user_id: Mapped[Optional[str]] = mapped_column("adminUserId", Text, _fk("User.id", "SET NULL"))
    previous_classification: Mapped[str] = mapped_column("previousClassification", Text, nullable=False)
    new_classification: Mapped[str] = mapped_column("newClassification", Text, nullable=False)
    previous_duration_seconds: Mapped[int] = mapped_column("previousDurationSeconds", Integer, nullable=False)
    new_duration_seconds: Mapped[int] = mapped_column("newDurationSeconds", Integer, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", Timestamp, default=utcnow, nullable=False)

    break_interval: Mapped[BreakInterval] = relationship(back_populates="audits")
    admin_user: Mapped[Optional[User]] = relationship()




