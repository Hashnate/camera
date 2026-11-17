"""Tests for Employee CRUD operations (edit and delete with cascade)."""
import pytest
from sqlalchemy import select
from app.database import SessionLocal
from app.models import Employee, Department, FaceTemplate, AttendanceRecord

def test_employee_update_and_delete():
    db = SessionLocal()
    try:
        dept = db.query(Department).first()
        assert dept is not None

        # Create a test employee
        test_code = "TEST-TEMP-999"
        # Ensure clean state
        existing = db.scalar(select(Employee).where(Employee.employee_code == test_code))
        if existing:
            db.delete(existing)
            db.commit()

        emp = Employee(
            employee_code=test_code,
            full_name="Original Name",
            email="test.orig@example.com",
            job_title="Intern",
            department_id=dept.id,
            assigned_zone="Test Zone",
            is_active=True,
        )
        db.add(emp)
        db.commit()
        db.refresh(emp)
        emp_id = emp.id

        # Add a dummy FaceTemplate to test cascade
        ft = FaceTemplate(
            employee_id=emp_id,
            encrypted_embedding=b"dummy_encrypted_data",
            embedding_iv="dummy_iv",
            embedding_tag="dummy_tag",
            quality_score=0.98,
        )
        db.add(ft)
        db.commit()

        # 1. Update Employee details (Edit)
        emp.full_name = "Updated Name"
        emp.job_title = "Senior Developer"
        emp.assigned_zone = "Executive Room"
        emp.employee_code = "TEST-TEMP-888"
        db.commit()
        db.refresh(emp)

        assert emp.full_name == "Updated Name"
        assert emp.job_title == "Senior Developer"
        assert emp.assigned_zone == "Executive Room"
        assert emp.employee_code == "TEST-TEMP-888"

        # 2. Delete Employee (Cascade check)
        db.delete(emp)
        db.commit()

        # Verify Employee is deleted
        deleted_emp = db.get(Employee, emp_id)
        assert deleted_emp is None

        # Verify associated FaceTemplate was cascade deleted
        templates = db.scalars(select(FaceTemplate).where(FaceTemplate.employee_id == emp_id)).all()
        assert len(templates) == 0

    finally:
        db.close()
