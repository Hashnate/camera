"""Tests for the integration API (/api/v1), its API keys, and key management (/api/integrations/keys).

Everything runs inside a transaction that is rolled back, so the database is left as it was.
"""

import unittest
from datetime import date, datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import v1
from app.api_keys import SCOPES, create_key
from app.database import engine, get_db, utcnow
from app.main import app
from app.models import ApiKey, AttendanceRecord, AuditLog, Employee, RecognitionEvent, User, UserRole, WorkSchedule
from app.permissions import perms_for
from app.security import AuthUser, current_user
from app.v1.common import OFFICE_TZ

ALL = list(SCOPES)


def utc(local: datetime) -> datetime:
    """Office time -> naive UTC, as stored."""
    return local.replace(tzinfo=OFFICE_TZ).astimezone(timezone.utc).replace(tzinfo=None)


class ApiV1Tests(unittest.TestCase):
    def setUp(self):
        self.conn = engine.connect()
        self.trans = self.conn.begin()
        self.db = Session(bind=self.conn, join_transaction_mode="create_savepoint", expire_on_commit=False)

        def override_db():
            yield self.db

        v1.api.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_db] = override_db
        self.client = TestClient(app)

        _, self.key = create_key(self.db, "Test ERP", ALL)
        _, self.read_key = create_key(self.db, "Read only", ["employees:read", "attendance:read"])
        self.db.commit()
        self.schedule = self.db.scalar(select(WorkSchedule).limit(1))
        self.assertIsNotNone(self.schedule, "seed data should include a work schedule")

    def tearDown(self):
        v1.api.dependency_overrides.clear()
        app.dependency_overrides.clear()
        self.db.close()
        self.trans.rollback()
        self.conn.close()

    # ------------------------------------------------------------ helpers

    def call(self, method, path, key=None, **kw):
        headers = kw.pop("headers", {})
        if key is not False:
            headers["Authorization"] = f"Bearer {key or self.key}"
        return self.client.request(method, f"/api/v1{path}", headers=headers, **kw)

    def make_employee(self, code, **fields):
        res = self.call("PUT", f"/employees/{code}", json={"fullName": f"Person {code}", **fields})
        self.assertIn(res.status_code, (200, 201), res.text)
        return self.db.scalar(select(Employee).where(Employee.employee_code == code.upper()))

    def add_day(self, emp, check_in_utc, sightings_min=(), check_out_utc=None):
        rec = AttendanceRecord(employee_id=emp.id, date=check_in_utc.date().isoformat(), check_in=check_in_utc,
                               check_out=check_out_utc)
        if check_out_utc:
            rec.total_minutes = round((check_out_utc - check_in_utc).total_seconds() / 60)
        self.db.add(rec)
        self.db.flush()
        for i, m in enumerate(sightings_min):
            self.db.add(RecognitionEvent(employee_id=emp.id, similarity=0.7, channel_no=1,
                                         action="CHECK_IN" if i == 0 else "SEEN", attendance_record_id=rec.id,
                                         seen_at=check_in_utc + timedelta(minutes=m)))
        self.db.flush()
        return rec

    # ------------------------------------------------------------ keys

    def test_keys_are_required_and_checked(self):
        self.assertEqual(self.call("GET", "/employees", key=False).status_code, 401)
        self.assertEqual(self.call("GET", "/employees", key="ws_live_nope").status_code, 401)
        res = self.call("GET", "/employees", key="eyJhbGciOiJIUzI1NiJ9.x.y")  # a dashboard login token
        self.assertEqual(res.status_code, 401)
        self.assertIn("ws_live_", res.json()["message"])
        ok = self.client.get("/api/v1/employees", headers={"X-API-Key": self.key})
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(self.db.scalar(select(ApiKey).where(ApiKey.name == "Test ERP")).last_used_at)

    def test_scopes_limit_what_a_key_can_do(self):
        res = self.call("PUT", "/employees/T-1", key=self.read_key, json={"fullName": "X"})
        self.assertEqual(res.status_code, 403)
        self.assertFalse(res.json()["success"])
        self.assertIn("employees:write", res.json()["message"])

    def test_dashboard_manages_keys(self):
        admin = self.db.scalar(select(User).limit(1))
        app.dependency_overrides[current_user] = lambda: AuthUser(
            id=admin.id, email=admin.email, role=UserRole.OFFICE_ADMIN, full_name="Admin", company_id=None,
            perms=perms_for(UserRole.OFFICE_ADMIN),
        )
        res = self.client.post("/api/integrations/keys", json={"name": "ERPNext", "scopes": ["attendance:read"]})
        self.assertEqual(res.status_code, 201, res.text)
        made = res.json()["data"]
        self.assertTrue(made["key"].startswith("ws_live_"))
        self.assertEqual(made["scopes"], ["attendance:read"])

        listed = self.client.get("/api/integrations/keys").json()
        row = next(k for k in listed["data"] if k["id"] == made["id"])
        self.assertNotIn("key", row)
        self.assertNotIn("keyHash", row)

        self.assertEqual(self.call("GET", "/presence/now", key=made["key"]).status_code, 200)
        self.assertEqual(self.call("GET", "/employees", key=made["key"]).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/integrations/keys/{made['id']}").status_code, 200)
        self.assertEqual(self.call("GET", "/presence/now", key=made["key"]).status_code, 401)

        bad = self.client.post("/api/integrations/keys", json={"name": "X", "scopes": ["everything"]})
        self.assertEqual(bad.status_code, 400)

    def test_key_management_needs_users_manage(self):
        admin = self.db.scalar(select(User).limit(1))
        admin.role = UserRole.HR_MANAGER
        admin.must_change_password = False
        self.db.flush()
        from app.security import create_token

        res = self.client.get("/api/integrations/keys", headers={"Authorization": f"Bearer {create_token(admin)}"})
        self.assertEqual(res.status_code, 403)

    # ------------------------------------------------------------ employees

    def test_employee_upsert(self):
        res = self.call("PUT", "/employees/hr-emp-00012", json={
            "fullName": "Amal Perera", "email": "amal@example.com", "department": "Finance",
            "workSchedule": self.schedule.name.upper(), "joiningDate": "2026-01-05", "jobTitle": "Accountant",
        })
        self.assertEqual(res.status_code, 201, res.text)
        data = res.json()["data"]
        self.assertEqual(data["employeeCode"], "HR-EMP-00012")
        self.assertEqual(data["department"], "Finance")
        self.assertEqual(data["workSchedule"]["name"], self.schedule.name)
        self.assertIsInstance(data["workSchedule"]["workingDays"], list)
        self.assertEqual(data["joiningDate"], "2026-01-05")
        self.assertFalse(data["faceEnrolled"])
        self.assertRegex(data["updatedAt"], r"\.\d{3}\+05:30$")

        res = self.call("PUT", "/employees/HR-EMP-00012", json={"jobTitle": "Senior Accountant", "workSchedule": None})
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()["data"]
        self.assertEqual(data["jobTitle"], "Senior Accountant")
        self.assertIsNone(data["workSchedule"])
        self.assertEqual(data["email"], "amal@example.com")  # not sent, not changed

        self.assertEqual(self.call("GET", "/employees/Hr-Emp-00012").json()["data"]["fullName"], "Amal Perera")
        actions = self.db.scalars(select(AuditLog.action).where(AuditLog.entity_id == data["id"])).all()
        self.assertEqual(sorted(actions), ["API_EMPLOYEE_CREATE", "API_EMPLOYEE_UPDATE"])

    def test_employee_upsert_refuses_bad_input(self):
        self.assertEqual(self.call("PUT", "/employees/NEW-1", json={"email": "a@b.c"}).status_code, 400)
        self.assertEqual(self.call("PUT", "/employees/NEW-1", json={"fullName": "A", "fullname": "B"}).status_code, 400)
        self.assertEqual(self.call("PUT", "/employees/bad%20code", json={"fullName": "A"}).status_code, 400)
        res = self.call("PUT", "/employees/NEW-1", json={"fullName": "A", "workSchedule": "Night shift 99"})
        self.assertEqual(res.status_code, 400)
        self.assertIn("availableWorkSchedules", res.json())
        self.make_employee("NEW-2")
        self.assertEqual(self.call("PUT", "/employees/NEW-2", json={"isActive": None}).status_code, 400)
        self.assertEqual(self.call("GET", "/employees/NOPE-404").status_code, 404)

    def test_employee_list_pages_and_incremental_sync(self):
        before = datetime.now(timezone.utc) - timedelta(seconds=1)
        for i in range(3):
            self.make_employee(f"PG-{i}")
        seen, cursor = [], None
        while True:
            params = {"limit": 2, "updatedSince": before.isoformat()}
            if cursor:
                params["cursor"] = cursor
            body = self.call("GET", "/employees", params=params).json()
            seen += [e["employeeCode"] for e in body["data"]]
            cursor = body["page"]["nextCursor"]
            if not cursor:
                break
        self.assertEqual(sorted(c for c in seen if c.startswith("PG-")), ["PG-0", "PG-1", "PG-2"])
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(self.call("GET", "/employees", params={"cursor": "garbage"}).status_code, 400)
        naive = self.call("GET", "/employees", params={"updatedSince": "2026-01-01T00:00:00"})
        self.assertEqual(naive.status_code, 400)

    def test_enrolment_link(self):
        self.make_employee("ENR-1")
        res = self.call("POST", "/employees/ENR-1/enrolment-link")
        self.assertEqual(res.status_code, 201, res.text)
        data = res.json()["data"]
        self.assertTrue(data["token"])
        if data["url"]:
            self.assertIn(f"/enroll?token={data['token']}", data["url"])
        self.make_employee("ENR-2", isActive=False)
        self.assertEqual(self.call("POST", "/employees/ENR-2/enrolment-link").status_code, 400)

    def test_departments_and_schedules(self):
        self.assertTrue(self.call("GET", "/departments").json()["data"])
        names = [w["name"] for w in self.call("GET", "/work-schedules").json()["data"]]
        self.assertIn(self.schedule.name, names)

    # ------------------------------------------------------------ attendance

    def test_attendance_uses_office_dates_and_offsets(self):
        emp = self.make_employee("ATT-1")
        # 02:00 in the office on 10 Nov is 9 Nov in UTC: it still belongs to 10 Nov.
        early = self.add_day(emp, utc(datetime(2026, 11, 10, 2, 0)), check_out_utc=utc(datetime(2026, 11, 10, 6, 0)))
        self.add_day(emp, utc(datetime(2026, 11, 11, 9, 5)), sightings_min=(0, 1, 2))
        self.assertEqual(early.date, "2026-11-09")

        body = self.call("GET", "/attendance", params={"from": "2026-11-10", "employeeCode": "att-1"}).json()
        self.assertEqual(len(body["data"]), 1)
        row = body["data"][0]
        self.assertEqual(row["date"], "2026-11-10")
        self.assertEqual(row["checkIn"], "2026-11-10T02:00:00+05:30")
        self.assertEqual(row["workedMinutes"], 240)
        self.assertEqual(row["source"], "MANUAL")

        both = self.call("GET", "/attendance", params={"from": "2026-11-10", "to": "2026-11-11", "employeeCode": "ATT-1"})
        self.assertEqual([r["source"] for r in sorted(both.json()["data"], key=lambda r: r["date"])], ["MANUAL", "CAMERA"])
        self.assertEqual(self.call("GET", "/attendance").status_code, 400)
        self.assertEqual(self.call("GET", "/attendance", params={"from": "2026-11-12", "to": "2026-11-01"}).status_code, 400)

    def test_manual_check_in_and_out(self):
        self.make_employee("MAN-1")
        at = (datetime.now(OFFICE_TZ) - timedelta(hours=3)).replace(microsecond=0)
        res = self.call("POST", "/attendance/check-in", json={"employeeCode": "MAN-1", "at": at.isoformat()})
        self.assertEqual(res.status_code, 201, res.text)
        self.assertEqual(res.json()["data"]["checkIn"], at.isoformat())
        again = self.call("POST", "/attendance/check-in", json={"employeeCode": "MAN-1", "at": at.isoformat()})
        self.assertEqual(again.status_code, 409)

        out = self.call("POST", "/attendance/check-out", json={"employeeCode": "MAN-1"})
        self.assertEqual(out.status_code, 200, out.text)
        self.assertAlmostEqual(out.json()["data"]["workedMinutes"], 180, delta=1)

        future = (datetime.now(OFFICE_TZ) + timedelta(hours=1)).isoformat()
        self.assertEqual(self.call("POST", "/attendance/check-in", json={"employeeCode": "MAN-1", "at": future}).status_code, 400)
        self.assertEqual(self.call("POST", "/attendance/check-in",
                                   json={"employeeCode": "MAN-1", "at": "2026-11-20T09:00:00"}).status_code, 400)
        self.make_employee("MAN-2")
        self.assertEqual(self.call("POST", "/attendance/check-out", json={"employeeCode": "MAN-2"}).status_code, 409)
        self.assertEqual(self.call("POST", "/attendance/check-in", json={"employeeCode": "MAN-1"}, key=self.read_key).status_code, 403)

    def test_timesheets(self):
        emp = self.make_employee("TS-1", workSchedule=self.schedule.name)
        start = utc(datetime(2026, 11, 3, 9, 0))  # a Tuesday
        # Seen every minute 0-60, away 60-120, back 120-180.
        self.add_day(emp, start, sightings_min=[*range(0, 61), *range(120, 181)])
        gone = self.make_employee("TS-2")
        self.add_day(gone, utc(datetime(2026, 11, 4, 10, 0)), sightings_min=range(0, 31))
        self.call("PUT", "/employees/TS-2", json={"isActive": False})

        body = self.call("GET", "/timesheets", params={"from": "2026-11-02", "to": "2026-11-08", "awayAfterMin": 5}).json()
        self.assertEqual((body["from"], body["to"], body["awayAfterMin"]), ("2026-11-02", "2026-11-08", 5))
        ts = next(t for t in body["data"] if t["employeeCode"] == "TS-1")
        self.assertEqual(len(ts["days"]), 7)
        day = next(d for d in ts["days"] if d["date"] == "2026-11-03")
        self.assertTrue(day["present"] and day["measured"])
        self.assertEqual(day["checkIn"], "2026-11-03T09:00:00+05:30")
        self.assertEqual(day["awayMinutes"], 60)
        self.assertEqual(day["timesAway"], 1)
        self.assertEqual(day["spanMinutes"], 180)
        self.assertAlmostEqual(day["insideMinutes"], 120, delta=2)
        self.assertEqual(ts["totals"]["daysPresent"], 1)
        self.assertIsNotNone(ts["totals"]["workingDays"])
        self.assertEqual(sum(1 for d in ts["days"] if not d["present"]), 6)

        left = next((t for t in body["data"] if t["employeeCode"] == "TS-2"), None)
        self.assertIsNotNone(left, "an employee who left is still in the timesheet for days they worked")
        self.assertFalse(left["isActive"])
        self.assertEqual(self.call("GET", "/timesheets", params={"from": "2026-01-01", "to": "2026-12-31"}).status_code, 400)

    def test_presence_now(self):
        now = utcnow()
        here = self.make_employee("NOW-1")
        stepped_out = self.make_employee("NOW-2")
        self.make_employee("NOW-3")
        self.add_day(here, now - timedelta(minutes=10), sightings_min=range(0, 10))
        self.add_day(stepped_out, now - timedelta(minutes=60), sightings_min=range(0, 20))
        body = self.call("GET", "/presence/now").json()
        self.assertEqual(body["date"], datetime.now(OFFICE_TZ).date().isoformat())
        state = {d["employeeCode"]: d["state"] for d in body["data"]}
        self.assertEqual(state["NOW-1"], "IN_OFFICE")
        self.assertEqual(state["NOW-2"], "AWAY")
        self.assertEqual(state["NOW-3"], "NOT_SEEN_TODAY")
        self.assertEqual(body["summary"]["employees"], len(body["data"]))

    # ------------------------------------------------------------ docs

    def test_docs_list_only_the_integration_api(self):
        spec = self.client.get("/api/v1/openapi.json").json()
        self.assertEqual(spec["info"]["title"], "WorkSight API")
        self.assertIn("/employees/{employeeCode}", spec["paths"])
        self.assertIn("/timesheets", spec["paths"])
        self.assertFalse(any("internal" in p or "cameras" in p for p in spec["paths"]))
        self.assertEqual(self.client.get("/api/v1/docs").status_code, 200)


if __name__ == "__main__":
    unittest.main()
