"""Webhooks: WorkSight tells another system (an ERP) the moment someone arrives, goes away or comes back.

How it works
- A webhook is a URL plus the events it wants (WebhookEndpoint). It is made by an admin in the dashboard
  (/api/integrations/webhooks) or by another system with its API key (/api/v1/webhooks).
- A background thread (start()/stop(), run from app.main's lifespan) works out everyone's presence for today once a
  minute, from the same camera sightings as /api/v1/timesheets, and queues an event for each change since last time
  (WebhookDelivery). Away = unseen for the webhook's own awayAfterMin (default 15), not the dashboard's setting.
- It sends queued events every few seconds: an HTTPS POST of JSON, signed with the webhook's secret. Anything but a
  2xx answer is retried with back-off for about a day, then marked FAILED.

Each employee's day is a fixed sequence, so missed ticks (a restart, a slow ERP) catch up exactly:
    arrived (first sighting) -> went_away (last sighting before a gap) -> came_back (first after it) -> ...
WebhookPresenceState keeps how many of today's events a webhook has been sent per employee; each tick sends the rest.
A new webhook starts from the current state ("primed"), so it isn't flooded with events from earlier in the day.

The signature header is `X-WorkSight-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
"""

import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import socket
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Callable, Optional
from urllib.parse import urlsplit

import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.crypto import decrypt_text, encrypt_text
from app.database import SessionLocal, utcnow
from app.errors import ApiError
from app.models import Employee, WebhookDelivery, WebhookEndpoint, WebhookPresenceState
from app.office_time import iso, local_date, office_today
from app.services.presence import DayPresence, load_presence

log = logging.getLogger("worksight.webhooks")

EVENTS: dict[str, str] = {
    "employee.arrived": "Seen for the first time today (or checked in by hand)",
    "employee.went_away": "Not seen for the webhook's away time: stepped out or gone home",
    "employee.came_back": "Seen again after being away",
}
TEST_EVENT = "webhook.test"
SECRET_PREFIX = "whsec_"

PRESENCE_EVERY = timedelta(seconds=60)  # working out presence takes ~2 s on a day's sightings
SEND_EVERY_SEC = 10
TIMEOUT_SEC = 10
SENDS_PER_TICK = 50
# Wait before attempt 2, 3, ...; after the last one the delivery is FAILED (~22 h after the first).
RETRY_AFTER = [timedelta(minutes=m) for m in (1, 5, 15, 60, 180, 360, 720)]
KEEP_DELIVERIES = timedelta(days=30)

# Swapped in tests.
_transport: Optional[httpx.BaseTransport] = None
_resolve: Callable = socket.getaddrinfo


# ---------------------------------------------------------------- addresses


def check_url(url: str, allow_private: bool) -> str:
    """The URL if WorkSight may send to it; else ApiError(400).

    Always https, except that an admin may use plain http on a private network. Never this server itself
    (loopback) or link-local/metadata addresses; private networks only for admins.
    """
    url = (url or "").strip()
    if len(url) > 500:
        raise ApiError(400, "The webhook URL is too long")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise ApiError(400, "That isn't a valid URL")
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ApiError(400, "The webhook URL must start with https://")
    if parts.username or parts.password:
        raise ApiError(400, "Don't put a username or password in the webhook URL")
    try:
        infos = _resolve(parts.hostname, port or (443 if parts.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        raise ApiError(400, f"Can't find the server '{parts.hostname}'")
    private = False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast or ip.is_reserved:
            raise ApiError(400, "WorkSight can't send webhooks to that address")
        if ip.is_private:
            private = True
    if private and not allow_private:
        raise ApiError(400, "That address is on a private network. An admin can add it in Settings > Integrations.")
    if parts.scheme == "http" and not (allow_private and private):
        raise ApiError(400, "The webhook URL must start with https://")
    return url


def clean_events(events) -> list[str]:
    wanted = {str(e).strip() for e in (events if events is not None else EVENTS) if str(e).strip()}
    unknown = sorted(wanted - EVENTS.keys())
    if unknown:
        raise ApiError(400, f"Unknown event(s): {', '.join(unknown)}", validEvents=list(EVENTS))
    if not wanted:
        raise ApiError(400, "Choose at least one event", validEvents=list(EVENTS))
    return [e for e in EVENTS if e in wanted]


# ---------------------------------------------------------------- managing webhooks


def create_endpoint(
    db: Session,
    url: str,
    events=None,
    away_after_min: int = 15,
    description: Optional[str] = None,
    *,
    allow_private: bool = False,
    api_key_id: Optional[str] = None,
    created_by_id: Optional[str] = None,
) -> tuple[WebhookEndpoint, str]:
    """Store a webhook and record everyone's current state, so only later changes are sent. Commits.

    Returns the webhook and its signing secret (the only time the plain secret is handed out)."""
    if not isinstance(away_after_min, int) or not 1 <= away_after_min <= 120:
        raise ApiError(400, "awayAfterMin must be a whole number of minutes from 1 to 120")
    if description is not None and len(description) > 200:
        raise ApiError(400, "description is too long (200 characters at most)")
    secret = SECRET_PREFIX + secrets.token_urlsafe(32)
    ep = WebhookEndpoint(
        url=check_url(url, allow_private),
        events=" ".join(clean_events(events)),
        away_after_min=away_after_min,
        description=(description or "").strip() or None,
        secret_enc=encrypt_text(secret),
        allow_private=allow_private,
        api_key_id=api_key_id,
        created_by_id=created_by_id,
    )
    db.add(ep)
    db.flush()
    prime(db, ep)
    db.commit()
    return ep, secret


def endpoint_json(ep: WebhookEndpoint) -> dict:
    return {
        "id": ep.id,
        "url": ep.url,
        "description": ep.description,
        "events": ep.events.split(),
        "awayAfterMin": ep.away_after_min,
        "createdAt": iso(ep.created_at),
        "createdBy": "api" if ep.api_key_id else "dashboard",
        "apiKeyName": ep.api_key.name if ep.api_key else None,
        "isActive": is_active(ep),
        "lastDeliveryAt": iso(ep.last_delivery_at),
        "lastStatus": ep.last_status,
        "lastError": ep.last_error,
    }


def delivery_json(d: WebhookDelivery) -> dict:
    return {
        "id": d.id,
        "event": d.event,
        "status": d.status,
        "attempts": d.attempts,
        "createdAt": iso(d.created_at),
        "deliveredAt": iso(d.delivered_at),
        "nextAttemptAt": iso(d.next_attempt_at) if d.status == "PENDING" else None,
        "lastStatusCode": d.last_status_code,
        "lastError": d.last_error,
        "data": json.loads(d.payload).get("data"),
    }


def is_active(ep: WebhookEndpoint) -> bool:
    """A webhook made with an API key stops when that key is revoked."""
    return ep.api_key_id is None or (ep.api_key is not None and ep.api_key.revoked_at is None)


def recent_deliveries(db: Session, ep: WebhookEndpoint, limit: int = 50) -> list[WebhookDelivery]:
    return db.scalars(
        select(WebhookDelivery)
        .where(WebhookDelivery.endpoint_id == ep.id)
        .order_by(WebhookDelivery.created_at.desc())
        .limit(limit)
    ).all()


def send_test(db: Session, ep: WebhookEndpoint) -> WebhookDelivery:
    """Send a webhook.test event now (not retried) and return its delivery."""
    d = _queue(db, ep, TEST_EVENT, {"message": "Test event from WorkSight. Answer with any 2xx status."})
    d.status = "SENDING"
    db.commit()
    _deliver(db, d, retry=False)
    return d


# ---------------------------------------------------------------- presence -> events


@dataclass
class _Event:
    name: str
    at: datetime  # naive UTC


def day_events(parts: list[DayPresence], now: datetime, away_after: timedelta) -> list[_Event]:
    """The day's events in order, from one employee's presence records for one office date."""
    parts = sorted((p for p in parts if p.record.check_in), key=lambda p: p.record.check_in)
    if not parts:
        return []
    sessions = sorted(s for p in parts for s in p.sessions)
    if not sessions:  # manual check-in without camera sightings
        out = [_Event("employee.arrived", parts[0].record.check_in)]
        if parts[-1].record.check_out:
            out.append(_Event("employee.went_away", parts[-1].record.check_out))
        return out
    out = [_Event("employee.arrived", parts[0].record.check_in)]
    for i, (_start, end) in enumerate(sessions):
        last = i == len(sessions) - 1
        if last and now - end <= away_after:
            break  # still here
        out.append(_Event("employee.went_away", end))
        if not last:
            out.append(_Event("employee.came_back", sessions[i + 1][0]))
    return out


def _today_events(db: Session, gap_min: int, today: date, now: datetime) -> dict[str, list[_Event]]:
    """Employee id -> today's events, for one away time."""
    presence = load_presence(db, (today - timedelta(days=1)).isoformat(), today.isoformat(), gap_min)
    out = {}
    for emp_id, days in presence.items():
        parts = [d for d in days if d.record.check_in and local_date(d.record.check_in) == today.isoformat()]
        if parts:
            out[emp_id] = day_events(parts, now, timedelta(minutes=gap_min))
    return out


def prime(db: Session, ep: WebhookEndpoint, events: Optional[dict] = None) -> None:
    """Mark everything up to now as already sent for this webhook. Caller commits."""
    today, now = office_today(), utcnow()
    if events is None:
        events = _today_events(db, ep.away_after_min, today, now)
    db.execute(delete(WebhookPresenceState).where(WebhookPresenceState.endpoint_id == ep.id))
    for emp_id, evs in events.items():
        db.add(WebhookPresenceState(endpoint_id=ep.id, employee_id=emp_id, date=today.isoformat(), emitted=len(evs)))
    ep.primed_at = now


def queue_presence_events(db: Session) -> int:
    """Queue every presence event not yet sent, for every active webhook. Returns how many. Commits."""
    endpoints = [ep for ep in db.scalars(select(WebhookEndpoint)).all() if is_active(ep)]
    if not endpoints:
        return 0
    today, now = office_today(), utcnow()
    by_gap: dict[int, dict] = {}
    names = {e.id: e for e in db.scalars(select(Employee)).all()}
    queued = 0
    for ep in endpoints:
        if ep.away_after_min not in by_gap:
            by_gap[ep.away_after_min] = _today_events(db, ep.away_after_min, today, now)
        events = by_gap[ep.away_after_min]
        if ep.primed_at is None:
            prime(db, ep, events)
            continue
        wanted = set(ep.events.split())
        states = {
            s.employee_id: s
            for s in db.scalars(select(WebhookPresenceState).where(WebhookPresenceState.endpoint_id == ep.id))
        }
        for emp_id, evs in events.items():
            state = states.get(emp_id)
            if state is None:
                state = WebhookPresenceState(endpoint_id=ep.id, employee_id=emp_id, date=today.isoformat(), emitted=0)
                db.add(state)
            elif state.date != today.isoformat():
                state.date, state.emitted = today.isoformat(), 0
            emp = names.get(emp_id)
            for ev in evs[state.emitted:]:
                if ev.name in wanted and emp is not None:
                    _queue(db, ep, ev.name, {
                        "employeeCode": emp.employee_code,
                        "fullName": emp.full_name,
                        "date": today.isoformat(),
                        "at": iso(ev.at),
                    })
                    queued += 1
            state.emitted = max(state.emitted, len(evs))
    db.commit()
    return queued


# ---------------------------------------------------------------- sending


def _queue(db: Session, ep: WebhookEndpoint, event: str, data: dict) -> WebhookDelivery:
    now, event_id = utcnow(), str(uuid.uuid4())
    payload = json.dumps({"id": event_id, "event": event, "createdAt": iso(now), "data": data}, separators=(",", ":"))
    d = WebhookDelivery(
        id=event_id, endpoint_id=ep.id, event=event, payload=payload, status="PENDING", created_at=now, next_attempt_at=now
    )
    db.add(d)
    db.flush()
    return d


def sign(secret: str, timestamp: int, body: bytes) -> str:
    mac = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={mac}"


def _deliver(db: Session, d: WebhookDelivery, retry: bool = True) -> bool:
    """Send one delivery and record the outcome. Commits. True if the receiver answered 2xx."""
    ep = d.endpoint
    body = d.payload.encode()
    code, error = None, None
    try:
        check_url(ep.url, ep.allow_private)  # again at send time: the name may now point somewhere else
        ts = int(time.time())
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "WorkSight-Webhooks/1.0",
            "X-WorkSight-Event": d.event,
            "X-WorkSight-Delivery": d.id,
            "X-WorkSight-Signature": sign(decrypt_text(ep.secret_enc), ts, body),
        }
        with httpx.Client(timeout=TIMEOUT_SEC, follow_redirects=False, transport=_transport) as client:
            code = client.post(ep.url, content=body, headers=headers).status_code
        if not 200 <= code < 300:
            error = f"Answered {code}" + (" (redirects aren't followed)" if 300 <= code < 400 else "")
    except ApiError as exc:
        error = exc.message
    except httpx.TimeoutException:
        error = f"No answer within {TIMEOUT_SEC} s"
    except httpx.HTTPError as exc:
        error = f"Couldn't connect: {exc.__class__.__name__}"
    except Exception:
        log.exception("[Webhooks] sending %s failed", d.id)
        error = "WorkSight couldn't send it (see the backend log)"

    now = utcnow()
    d.attempts += 1
    d.last_status_code = code
    d.last_error = error
    ok = error is None
    if ok:
        d.status, d.delivered_at = "DELIVERED", now
        ep.last_status, ep.last_error = "OK", None
    else:
        ep.last_status, ep.last_error = "FAILING", error
        if retry and d.attempts <= len(RETRY_AFTER):
            d.status, d.next_attempt_at = "PENDING", now + RETRY_AFTER[d.attempts - 1]
        else:
            d.status = "FAILED"
    ep.last_delivery_at = now
    db.commit()
    return ok


def send_due(db: Session, limit: int = SENDS_PER_TICK) -> int:
    """Send deliveries that are due, oldest first. A webhook that fails is skipped for the rest of the tick."""
    due = db.scalars(
        select(WebhookDelivery)
        .where(WebhookDelivery.status == "PENDING", WebhookDelivery.next_attempt_at <= utcnow())
        .order_by(WebhookDelivery.created_at)
        .limit(limit)
    ).all()
    failing: set[str] = set()
    sent = 0
    for d in due:
        if d.endpoint_id in failing or not is_active(d.endpoint):
            continue
        if _deliver(db, d):
            sent += 1
        else:
            failing.add(d.endpoint_id)
    return sent


def purge(db: Session) -> None:
    cutoff = utcnow() - KEEP_DELIVERIES
    db.execute(delete(WebhookDelivery).where(WebhookDelivery.status != "PENDING", WebhookDelivery.created_at < cutoff))
    db.execute(delete(WebhookPresenceState).where(WebhookPresenceState.updated_at < utcnow() - timedelta(days=3)))
    db.commit()


# ---------------------------------------------------------------- background thread


class _Worker(threading.Thread):
    def __init__(self):
        super().__init__(name="webhooks", daemon=True)
        self.stopping = threading.Event()
        self.last_presence = datetime.min
        self.last_purge = datetime.min

    def run(self):
        log.info("[Webhooks] sender started")
        while not self.stopping.wait(SEND_EVERY_SEC):
            try:
                self.tick()
            except Exception:
                log.exception("[Webhooks] tick failed")

    def tick(self):
        now = utcnow()
        with SessionLocal() as db:
            if not db.scalar(select(WebhookEndpoint.id).limit(1)):
                return
            if now - self.last_presence >= PRESENCE_EVERY:
                self.last_presence = now
                n = queue_presence_events(db)
                if n:
                    log.info("[Webhooks] queued %d event(s)", n)
            send_due(db)
            if now - self.last_purge >= timedelta(hours=1):
                self.last_purge = now
                purge(db)


_worker: Optional[_Worker] = None


def start() -> None:
    """Start the sender (once per process; the backend runs one uvicorn process)."""
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = _Worker()
        _worker.start()


def stop() -> None:
    if _worker is not None:
        _worker.stopping.set()

