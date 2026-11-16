"""Create any missing tables and seed default records.

    python -m app.seed

Safe to re-run: existing records are found and updated rather than duplicated.
"""

import random
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import Base, SessionLocal, engine, today_utc, utcnow
from app.models import (
    AttendanceRecord,
    AttendanceStatus,
    Camera,
    CameraChannel,
    CameraProviderType,
    CameraStatus,
    Company,
    Department,
    Employee,
    OccupancyRecord,
    Office,
    OfficeZone,
    User,
    UserRole,
    WorkSchedule,
    ZoneType,
)
from app.security import hash_password


def _get_or_create(db: Session, model, where: dict, create: dict | None = None):
    obj = db.scalar(select(model).filter_by(**where))
    if obj is None:
        obj = model(**where, **(create or {}))
        db.add(obj)
        db.flush()
    return obj


def _local_time_today_as_utc(hour: int, minute: int) -> datetime:
    """Today at hour:minute in the server's local time, stored as naive UTC."""
    local = datetime.now().astimezone().replace(hour=hour, minute=minute, second=0, microsecond=0)
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def seed(db: Session) -> None:
    print("[Seed] Starting WorkSight database initialization...")

    # 1. Company
    company = _get_or_create(db, Company, {"code": "WORKSIGHT-HQ"}, {"name": "WorkSight Technologies Ltd"})

    # 2. Office
    office = _get_or_create(
        db,
        Office,
        {"company_id": company.id},
        {"name": "Headquarters - Innovation Park", "address": "42 Silicon Avenue, Floor 4", "timezone": "UTC"},
    )

    # 3. Departments
    depts = {
        name: _get_or_create(db, Department, {"office_id": office.id, "name": name}, {"code": name[:3].upper()}).id
        for name in ("Engineering", "Product & Design", "Operations", "Human Resources")
    }

    # 4. Work schedule
    schedule = _get_or_create(
        db,
        WorkSchedule,
        {"office_id": office.id},
        {
            "name": "Standard Working Hours",
            "start_time": "09:00",
            "end_time": "17:00",
            "grace_minutes": 15,
            "working_days": "1,2,3,4,5",
        },
    )

    # 5. Super admin
    admin = _get_or_create(
        db,
        User,
        {"email": "admin@worksight.io"},
        {
            "full_name": "Chief Workplace Administrator",
            "role": UserRole.SUPER_ADMIN,
            "company_id": company.id,
            "password_hash": "",
        },
    )
    admin.password_hash = hash_password("Admin@123456")
    print(f"[Seed] Super Admin created: {admin.email} / Admin@123456")

    # 6. Employees
    samples = [
        ("EMP-101", "Alex Morgan", "Senior Full Stack Engineer", "Engineering"),
        ("EMP-102", "Sarah Chen", "Lead AI Engineer", "Engineering"),
        ("EMP-103", "David Kim", "UI/UX Product Designer", "Product & Design"),
        ("EMP-104", "Elena Rostova", "Operations Lead", "Operations"),
        ("EMP-105", "Marcus Johnson", "HR Generalist", "Human Resources"),
        ("EMP-106", "Priya Sharma", "Computer Vision Specialist", "Engineering"),
        ("EMP-107", "James Wilson", "DevOps & Cloud Architect", "Engineering"),
        ("EMP-108", "Amina Hassan", "Quality Assurance Analyst", "Operations"),
    ]
    employees = []
    for code, name, title, dept in samples:
        emp = _get_or_create(
            db,
            Employee,
            {"employee_code": code},
            {
                "email": f"{name.lower().replace(' ', '.', 1)}@worksight.io",
                "assigned_zone": "Main Workstation Area",
                "full_name": name,
                "job_title": title,
                "department_id": depts[dept],
            },
        )
        emp.full_name, emp.job_title = name, title
        emp.department_id, emp.work_schedule_id = depts[dept], schedule.id
        employees.append(emp)

    # 7. Office zones, each with a sample occupancy reading when first created
    for name, ztype, cap in [
        ("Engineering Workspace", ZoneType.DEVELOPMENT, 15),
        ("Conference Room Alpha", ZoneType.MEETING_ROOM, 8),
        ("Executive Reception", ZoneType.RECEPTION, 4),
        ("Breakout Lounge", ZoneType.BREAK_AREA, 6),
    ]:
        zone = db.scalar(select(OfficeZone).filter_by(office_id=office.id, name=name))
        if zone is None:
            zone = OfficeZone(office_id=office.id, name=name, type=ztype, capacity=cap)
            db.add(zone)
            db.flush()
            db.add(OccupancyRecord(zone_id=zone.id, person_count=random.randint(1, cap - 1)))

    # 8. EZVIZ H7c dual-lens camera
    camera = _get_or_create(
        db,
        Camera,
        {"serial_number": "BC7652775"},
        {"office_id": office.id, "provider": CameraProviderType.EZVIZ, "name": "", "model": ""},
    )
    camera.name = "EZVIZ H7c Dual-Lens (BC7652775)"
    camera.model = "CS-H7c-R100-8G44WF"
    camera.status = CameraStatus.ONLINE
    camera.firmware_ver = "V5.3.8 build 250812"
    camera.location = "Innovation Bay & Central Workstations"
    camera.last_online_at = utcnow()

    for channel_no, channel_name in [(1, "Hashnate -WL (Wide Lens)"), (2, "Hashnate -PT (Pan-Tilt Lens)")]:
        ch = _get_or_create(
            db, CameraChannel, {"camera_id": camera.id, "channel_no": channel_no}, {"channel_name": channel_name}
        )
        ch.channel_name, ch.is_encrypted, ch.status = channel_name, False, 0

    print(f"[Seed] EZVIZ Dual-Lens Camera configured: {camera.name} ({camera.serial_number}) with 2 channels")

    # 9. Today's attendance (left alone if already present)
    today = today_utc()
    for emp, (h, m), status, late in [
        (employees[0], (8, 52), AttendanceStatus.PRESENT, False),
        (employees[1], (8, 58), AttendanceStatus.PRESENT, False),
        (employees[2], (9, 24), AttendanceStatus.LATE, True),
    ]:
        _get_or_create(
            db,
            AttendanceRecord,
            {"employee_id": emp.id, "date": today},
            {"check_in": _local_time_today_as_utc(h, m), "status": status, "is_late": late},
        )

    db.commit()
    print("[Seed] Database initialization complete!")


def main() -> None:
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        seed(db)


if __name__ == "__main__":
    main()
