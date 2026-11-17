from app.database import SessionLocal
from app.models import Employee, FaceTemplate

db = SessionLocal()
emps = db.query(Employee).order_by(Employee.employee_code).all()
print(f"Total employees: {len(emps)}")
for e in emps:
    active_count = db.query(FaceTemplate).filter(FaceTemplate.employee_id == e.id, FaceTemplate.status == "ACTIVE").count()
    all_count = db.query(FaceTemplate).filter(FaceTemplate.employee_id == e.id).count()
    print(f"UUID: {e.id} | Code: {e.employee_code} | Name: {e.full_name} | Email: {e.email} | Active: {e.is_active} | Active Templates: {active_count} (Total: {all_count})")
db.close()
