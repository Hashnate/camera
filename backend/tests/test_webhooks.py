"""Tests for webhooks: address checks, signing, retries, presence events, and the API / dashboard endpoints.

A fake receiver (httpx.MockTransport) and fake DNS stand in for the network. Runs in a rolled-back transaction.
"""

import hashlib
import hmac
import json
import socket
import unittest
from datetime import timedelta

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import v1
from app.api_keys import create_key
from app.database import engine, get_db, utcnow
from app.errors import ApiError
from app.main import app
from app.models import (
    ApiKey, AttendanceRecord, Department, Employee, RecognitionEvent, User, UserRole, WebhookDelivery, WebhookEndpoint,
)
from app.permissions import perms_for
from app.security import AuthUser, current_user
from app.services import webhooks as hooks

HOSTS = {
    "erp.example.com": "93.184.216.34",
    "erp.lan": "192.168.1.20",
    "localhost": "127.0.0.1",
    "metadata.internal": "169.254.169.254",
}


def fake_resolve(host, port, proto=0):
    if host not in HOSTS:
        raise socket.gaierror("not found")
    return [(socket.AF_INET, socket.SOCK_STREAM, proto, "", (HOSTS[host], port))]


class WebhookTests(unittest.TestCase):
    def setUp(self):
        self.conn = engine.connect()
        self.trans = self.conn.begin()
        self.db = Session(bind=self.conn, join_transaction_mode="create_savepoint", expire_on_commit=False)

        def override_db():
            yield self.db

        v1.api.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_db] = override_db
        self.client = TestClient(app)

        self.received: list[httpx.Request] = []
        self.answer = 200

        def handler(request: httpx.Request) -> httpx.Response:
            self.received.append(request)
            return httpx.Response(self.answer)

        self._old = (hooks._transport, hooks._resolve)
        hooks._transport = httpx.MockTransport(handler)
        hooks._resolve = fake_resolve

        self.key_row, self.key = create_key(self.db, "ERP", ["attendance:read"])
        _, self.other_key = create_key(self.db, "Other", ["attendance:read"])
        _, self.no_scope_key = create_key(self.db, "Employees only", ["employees:read"])
        self.db.commit()
        self.dept = self.db.scalar(select(Department).limit(1))

    def tearDown(self):
        hooks._transport, hooks._resolve = self._old
        v1.api.dependency_overrides.clear()
        app.dependency_overrides.clear()
        self.db.close()
        self.trans.rollback()
        self.conn.close()

    # ------------------------------------------------------------ helpers

    def call(self, method, path, key=None, **kw):
        return self.client.request(method, f"/api/v1{path}", headers={"X-API-Key": key or self.key}, **kw)

    def employee(self, code):
        emp = Employee(employee_code=code, full_name=f"Person {code}", job_title="T", department_id=self.dept.id)
        self.db.add(emp)
        self.db.flush()
        return emp

    def seen(self, emp, minutes_ago):
        """Camera sightings at these many minutes ago (a check-in at the first)."""
        times = sorted(utcnow() - timedelta(minutes=m) for m in minutes_ago)
        rec = self.db.scalar(select(AttendanceRecord).where(AttendanceRecord.employee_id == emp.id,
                                                            AttendanceRecord.date == times[0].date().isoformat()))
        if rec is None:
            rec = AttendanceRecord(employee_id=emp.id, date=times[0].date().isoformat(), check_in=times[0])
            self.db.add(rec)
            self.db.flush()
        for t in times:
            self.db.add(RecognitionEvent(employee_id=emp.id, similarity=0.7, channel_no=1, action="SEEN",
                                         attendance_record_id=rec.id, seen_at=t))
        self.db.flush()
        return times

    def add_webhook(self, **body):
        res = self.call("POST", "/webhooks", json={"url": "https://erp.example.com/hook", **body})
        self.assertEqual(res.status_code, 201, res.text)
        return res.json()["data"]

    def deliveries(self, webhook_id):
        return self.db.scalars(select(WebhookDelivery).where(WebhookDelivery.endpoint_id == webhook_id)
                               .order_by(WebhookDelivery.created_at)).all()

    # ------------------------------------------------------------ addresses

    def test_addresses(self):
        ok = hooks.check_url("https://erp.example.com/api/method/x", allow_private=False)
        self.assertEqual(ok, "https://erp.example.com/api/method/x")
        for url, private in [
            ("http://erp.example.com/x", False),       # plain http to the internet
            ("https://erp.lan/x", False),              # private network, not an admin
            ("https://localhost/x", True),             # this server, even for admins
            ("https://metadata.internal/x", True),     # cloud metadata
            ("https://user:pw@erp.example.com/x", True),
            ("ftp://erp.example.com/x", True),
            ("https://nowhere.invalid/x", True),
        ]:
            with self.assertRaises(ApiError, msg=url):
                hooks.check_url(url, allow_private=private)
        self.assertTrue(hooks.check_url("http://erp.lan:8080/x", allow_private=True))

    # ------------------------------------------------------------ API

    def test_api_manages_own_webhooks(self):
        made = self.add_webhook(events=["employee.arrived"], awayAfterMin=10, description="ERPNext live")
        self.assertTrue(made["secret"].startswith("whsec_"))
        self.assertEqual((made["events"], made["awayAfterMin"], made["createdBy"]), (["employee.arrived"], 10, "api"))

        listed = self.call("GET", "/webhooks").json()["data"]
        self.assertEqual([w["id"] for w in listed], [made["id"]])
        self.assertNotIn("secret", listed[0])
        self.assertEqual(self.call("GET", "/webhooks", key=self.other_key).json()["data"], [])
        self.assertEqual(self.call("DELETE", f"/webhooks/{made['id']}", key=self.other_key).status_code, 404)
        self.assertEqual(self.call("GET", "/webhooks", key=self.no_scope_key).status_code, 403)

        self.assertEqual(self.call("POST", "/webhooks", json={"url": "https://erp.lan/x"}).status_code, 400)
        self.assertEqual(self.call("POST", "/webhooks", json={"url": "https://erp.example.com/x", "events": ["nope"]}).status_code, 400)

        self.assertEqual(self.call("DELETE", f"/webhooks/{made['id']}").status_code, 200)
        self.assertEqual(self.call("GET", "/webhooks").json()["data"], [])

    def test_test_event_is_signed(self):
        made = self.add_webhook()
        res = self.call("POST", f"/webhooks/{made['id']}/test")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["data"]["status"], "DELIVERED")

        req = self.received[-1]
        self.assertEqual(str(req.url), "https://erp.example.com/hook")
        self.assertEqual(req.headers["X-WorkSight-Event"], "webhook.test")
        parts = dict(p.split("=", 1) for p in req.headers["X-WorkSight-Signature"].split(","))
        expected = hmac.new(made["secret"].encode(), f"{parts['t']}.".encode() + req.content, hashlib.sha256).hexdigest()
        self.assertEqual(parts["v1"], expected)
        body = json.loads(req.content)
        self.assertEqual((body["event"], body["id"]), ("webhook.test", req.headers["X-WorkSight-Delivery"]))

        self.answer = 503
        failed = self.call("POST", f"/webhooks/{made['id']}/test").json()["data"]
        self.assertEqual((failed["status"], failed["lastStatusCode"]), ("FAILED", 503))
        listed = self.call("GET", f"/webhooks/{made['id']}/deliveries").json()["data"]
        self.assertEqual([d["status"] for d in listed], ["FAILED", "DELIVERED"])

    # ------------------------------------------------------------ presence events

    def test_presence_events_flow(self):
        here = self.employee("WH-1")
        self.seen(here, range(40, 29, -1))   # here 40-30 min ago: gone for 30 min (> 15)
        made = self.add_webhook()            # primes: arrived and went_away already happened
        self.assertEqual(hooks.queue_presence_events(self.db), 0)

        back = self.seen(here, range(2, -1, -1))   # back 2 min ago
        later = self.employee("WH-2")
        arrived = self.seen(later, [1, 0])
        self.assertEqual(hooks.queue_presence_events(self.db), 2)
        self.assertEqual(hooks.queue_presence_events(self.db), 0, "each event is queued once")

        sent = hooks.send_due(self.db)
        self.assertEqual(sent, 2)
        events = {(b["event"], b["data"]["employeeCode"]): b["data"] for b in (json.loads(r.content) for r in self.received)}
        self.assertEqual(set(events), {("employee.came_back", "WH-1"), ("employee.arrived", "WH-2")})
        self.assertEqual(events[("employee.came_back", "WH-1")]["at"][:16], hooks.iso(back[0])[:16])
        self.assertEqual(events[("employee.arrived", "WH-2")]["at"][:16], hooks.iso(arrived[0])[:16])
        self.assertTrue(all(d.status == "DELIVERED" for d in self.deliveries(made["id"])))

    def test_event_filter_and_revoked_key(self):
        emp = self.employee("WH-3")
        made = self.add_webhook(events=["employee.arrived"])
        self.seen(emp, range(50, 39, -1))   # arrived and already went away
        self.assertEqual(hooks.queue_presence_events(self.db), 1)  # went_away isn't wanted
        self.assertEqual(self.deliveries(made["id"])[0].event, "employee.arrived")

        key = self.db.get(ApiKey, self.key_row.id)
        key.revoked_at = utcnow()
        self.db.commit()
        self.assertEqual(hooks.send_due(self.db), 0, "a revoked key's webhook sends nothing")
        self.assertEqual(self.received, [])

    def test_retries_then_gives_up(self):
        made = self.add_webhook()
        ep = self.db.get(WebhookEndpoint, made["id"])
        d = hooks._queue(self.db, ep, "employee.arrived", {"employeeCode": "X"})
        self.db.commit()
        self.answer = 500
        self.assertEqual(hooks.send_due(self.db), 0)
        self.assertEqual((d.status, d.attempts, d.last_status_code), ("PENDING", 1, 500))
        self.assertGreater(d.next_attempt_at, utcnow() + timedelta(seconds=50))
        self.assertEqual(ep.last_status, "FAILING")
        for _ in hooks.RETRY_AFTER:
            d.next_attempt_at = utcnow() - timedelta(seconds=1)
            self.db.commit()
            hooks.send_due(self.db)
        self.assertEqual((d.status, d.attempts), ("FAILED", len(hooks.RETRY_AFTER) + 1))

        self.answer = 200
        d2 = hooks._queue(self.db, ep, "employee.arrived", {"employeeCode": "Y"})
        self.db.commit()
        self.assertEqual(hooks.send_due(self.db), 1)
        self.assertEqual((d2.status, ep.last_status), ("DELIVERED", "OK"))

    def test_manual_check_in_day(self):
        emp = self.employee("WH-4")
        now = utcnow()
        rec = AttendanceRecord(employee_id=emp.id, date=(now - timedelta(hours=3)).date().isoformat(),
                               check_in=now - timedelta(hours=3), check_out=now - timedelta(hours=1))
        self.db.add(rec)
        self.db.flush()
        from app.services.presence import DayPresence
        evs = hooks.day_events([DayPresence(record=rec)], now, timedelta(minutes=15))
        self.assertEqual([e.name for e in evs], ["employee.arrived", "employee.went_away"])

    # ------------------------------------------------------------ dashboard

    def test_dashboard_can_use_office_network(self):
        admin = self.db.scalar(select(User).limit(1))
        app.dependency_overrides[current_user] = lambda: AuthUser(
            id=admin.id, email=admin.email, role=UserRole.OFFICE_ADMIN, full_name="A", company_id=None,
            perms=perms_for(UserRole.OFFICE_ADMIN),
        )
        res = self.client.post("/api/integrations/webhooks", json={"url": "http://erp.lan:8000/hook", "awayAfterMin": 20})
        self.assertEqual(res.status_code, 201, res.text)
        made = res.json()["data"]
        self.assertEqual(made["createdBy"], "dashboard")
        self.assertTrue(self.client.get("/api/integrations/webhooks").json()["data"])
        self.assertEqual(self.client.post(f"/api/integrations/webhooks/{made['id']}/test").json()["data"]["status"], "DELIVERED")
        self.assertEqual(self.client.delete(f"/api/integrations/webhooks/{made['id']}").status_code, 200)
        bad = self.client.post("/api/integrations/webhooks", json={"url": "https://localhost/x"})
        self.assertEqual(bad.status_code, 400)


if __name__ == "__main__":
    unittest.main()
