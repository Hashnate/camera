"""Remove all demo employees (EMP-101 through EMP-108) from WorkSight database."""

from app.database import SessionLocal
from app.models import (
    Employee,
    FaceTemplate,
    FaceEnrollment,
    AttendanceRecord,
    PersonTrackSession,
    ZoneTransitionEvent,
    PresenceSession,
    RecognitionEvent,
    RecognitionObservation,
    WorkSession,
    AttendanceEvent,
    AttendanceReview,
)
from sqlalchemy import select, delete, update

def remove_demo_employees():
    db = SessionLocal()
    demo_codes = ['EMP-101', 'EMP-102', 'EMP-103', 'EMP-104', 'EMP-105', 'EMP-106', 'EMP-107', 'EMP-108']
    
    demo_emps = db.scalars(select(Employee).where(Employee.employee_code.in_(demo_codes))).all()
    if not demo_emps:
        print("No demo employees found in database.")
        db.close()
        return

    demo_ids = [e.id for e in demo_emps]
    print(f"Found {len(demo_emps)} demo employees to remove:")
    for e in demo_emps:
        print(f"  - {e.employee_code}: {e.full_name} ({e.email})")

    # 1. Update PersonTrackSession to preserve anonymous track history without demo association
    track_res = db.execute(
        update(PersonTrackSession)
        .where(PersonTrackSession.employee_id.in_(demo_ids))
        .values(employee_id=None, identity_verification_status="UNVERIFIED")
    )
    print(f"Disassociated {track_res.rowcount} person track sessions (set to UNVERIFIED).")

    # 2. Update ZoneTransitionEvent to ANONYMOUS
    trans_res = db.execute(
        update(ZoneTransitionEvent)
        .where(ZoneTransitionEvent.employee_id.in_(demo_ids))
        .values(employee_id=None, verification_status="ANONYMOUS")
    )
    print(f"Disassociated {trans_res.rowcount} zone transition events (set to ANONYMOUS).")

    # 3. Clean all tables with foreign key to Employee
    for model, name in [
        (FaceTemplate, "FaceTemplate"),
        (FaceEnrollment, "FaceEnrollment"),
        (AttendanceRecord, "AttendanceRecord"),
        (PresenceSession, "PresenceSession"),
        (RecognitionEvent, "RecognitionEvent"),
        (RecognitionObservation, "RecognitionObservation"),
        (WorkSession, "WorkSession"),
        (AttendanceEvent, "AttendanceEvent"),
        (AttendanceReview, "AttendanceReview"),
    ]:
        del_res = db.execute(delete(model).where(model.employee_id.in_(demo_ids)))
        print(f"Deleted {del_res.rowcount} {name} records.")

    # 4. Delete the demo Employee records
    emp_res = db.execute(delete(Employee).where(Employee.id.in_(demo_ids)))
    print(f"Deleted {emp_res.rowcount} demo employee records.")

    db.commit()

    # 5. Verify remaining employees
    remaining = db.scalars(select(Employee).order_by(Employee.employee_code)).all()
    print(f"\nRemaining Employees in Database ({len(remaining)}):")
    for r in remaining:
        tmps = db.query(FaceTemplate).filter(FaceTemplate.employee_id == r.id, FaceTemplate.status == "ACTIVE").count()
        print(f"  * {r.employee_code} | {r.full_name} ({r.email}) | Active Face Templates: {tmps}")

    db.close()

if __name__ == "__main__":
    remove_demo_employees()
