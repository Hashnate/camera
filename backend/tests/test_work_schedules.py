"""Tests for /api/work-schedules CRUD, permissions, validation, and 0-minute grace support."""

from datetime import datetime, timezone
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import engine, get_db
from app.main import app
from app.models import Department, Employee, Office, User, UserRole, WorkSchedule
from app.permissions import perms_for
from app.security import AuthUser, current_user
from app.services.attendance import is_late


def _make_auth(role: UserRole, user_id: str) -> AuthUser:
    return AuthUser(
        id=user_id,
        email=f"{role.value.lower()}@test.local",
        role=role,
        full_name=role.value,
        company_id=None,
        perms=perms_for(role),
    )


class WorkSchedulesTests(unittest.TestCase):
    def setUp(self):
        self.conn = engine.connect()
        self.trans = self.conn.begin()
        self.db = Session(bind=self.conn, join_transaction_mode="create_savepoint", expire_on_commit=False)

        admin_user = self.db.scalar(select(User).limit(1))
        self.actor_id = admin_user.id if admin_user else "test-actor"
        self.role = UserRole.OFFICE_ADMIN

        def override_db():
            yield self.db

        def override_user():
            return _make_auth(self.role, self.actor_id)

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[current_user] = override_user
        self.client = TestClient(app, raise_server_exceptions=True)

    def tearDown(self):
        app.dependency_overrides.clear()
        self.db.close()
        self.trans.rollback()
        self.conn.close()

    def test_crud_and_employee_unassignment(self):
        res = self.client.get("/api/work-schedules")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["success"])
        self.assertTrue(body["canEdit"])

        # Create schedule with 0 grace minutes and custom working days
        created = self.client.post(
            "/api/work-schedules",
            json={
                "name": "Early Shift QA",
                "startTime": "8:00",
                "endTime": "16:30",
                "graceMinutes": 0,
                "workingDays": ["5", "1", "3", "2", "4"],
            },
        )
        self.assertEqual(created.status_code, 201, created.text)
        sched = created.json()["data"]
        self.assertEqual(sched["startTime"], "08:00")
        self.assertEqual(sched["endTime"], "16:30")
        self.assertEqual(sched["graceMinutes"], 0)
        self.assertEqual(sched["workingDays"], "1,2,3,4,5")
        self.assertEqual(sched["employeeCount"], 0)

        # Duplicate name rejected (409)
        dup = self.client.post(
            "/api/work-schedules",
            json={"name": "early shift qa", "startTime": "09:00", "endTime": "17:00"},
        )
        self.assertEqual(dup.status_code, 409)

        # Update start/end/grace/days
        updated = self.client.patch(
            f"/api/work-schedules/{sched['id']}",
            json={"startTime": "08:30", "graceMinutes": 10, "workingDays": "1,2,3,4,5,6"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        u_data = updated.json()["data"]
        self.assertEqual(u_data["startTime"], "08:30")
        self.assertEqual(u_data["endTime"], "16:30")
        self.assertEqual(u_data["graceMinutes"], 10)
        self.assertEqual(u_data["workingDays"], "1,2,3,4,5,6")

        # Assign an employee to this schedule, verify employeeCount, then delete and verify unassignment
        dept = self.db.scalar(select(Department).limit(1))
        self.assertIsNotNone(dept)
        emp = Employee(
            employee_code="QA-WS-001",
            full_name="Schedule Test User",
            job_title="Tester",
            department_id=dept.id,
            work_schedule_id=sched["id"],
        )
        self.db.add(emp)
        self.db.flush()

        listed = self.client.get("/api/work-schedules").json()["data"]
        matched = [x for x in listed if x["id"] == sched["id"]][0]
        self.assertEqual(matched["employeeCount"], 1)

        deleted = self.client.delete(f"/api/work-schedules/{sched['id']}")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["unassignedEmployees"], 1)
        self.db.refresh(emp)
        self.assertIsNone(emp.work_schedule_id)

    def test_validation_rejects_bad_inputs(self):
        for payload in (
            {"name": "   ", "startTime": "09:00", "endTime": "17:00"},
            {"name": "Bad Time", "startTime": "25:00", "endTime": "17:00"},
            {"name": "End Before Start", "startTime": "17:00", "endTime": "09:00"},
            {"name": "Equal Times", "startTime": "09:00", "endTime": "09:00"},
            {"name": "Neg Grace", "startTime": "09:00", "endTime": "17:00", "graceMinutes": -1},
            {"name": "Bool Grace", "startTime": "09:00", "endTime": "17:00", "graceMinutes": True},
            {"name": "No Days", "startTime": "09:00", "endTime": "17:00", "workingDays": ""},
            {"name": "Bad Day", "startTime": "09:00", "endTime": "17:00", "workingDays": "1,8"},
        ):
            res = self.client.post("/api/work-schedules", json=payload)
            self.assertEqual(res.status_code, 400, f"Expected 400 for {payload}, got {res.status_code}: {res.text}")

    def test_permission_enforcement(self):
        # HR_MANAGER can view schedules (REPORTS_VIEW) but cannot modify them (SETUP_MANAGE)
        self.role = UserRole.HR_MANAGER
        res = self.client.get("/api/work-schedules")
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json()["canEdit"])

        post_res = self.client.post(
            "/api/work-schedules",
            json={"name": "Unauthorized", "startTime": "09:00", "endTime": "17:00"},
        )
        self.assertEqual(post_res.status_code, 403)

    def test_zero_grace_minutes_marks_late_immediately(self):
        office = self.db.scalar(select(Office).limit(1))
        ws = WorkSchedule(
            office_id=office.id,
            name="Strict",
            start_time="09:00",
            end_time="17:00",
            grace_minutes=0,
            working_days="1,2,3,4,5",
        )
        # Convert local 09:01 and 09:00 to naive UTC for the test server timezone
        local_900 = datetime(2026, 11, 25, 9, 0, 0).astimezone()
        local_901 = datetime(2026, 11, 25, 9, 1, 0).astimezone()
        utc_900 = local_900.astimezone(timezone.utc).replace(tzinfo=None)
        utc_901 = local_901.astimezone(timezone.utc).replace(tzinfo=None)

        self.assertFalse(is_late(ws, utc_900))
        self.assertTrue(is_late(ws, utc_901))


if __name__ == "__main__":
    unittest.main()
