"""API keys for the integration API (/api/v1): what another system, such as an ERP, signs in with.

A key looks like `ws_live_<43 random characters>`. It is shown once when created; only its SHA-256 hash is stored,
so a leaked database doesn't leak working keys. Each key carries scopes (what it may do) and can be revoked.

Create and manage keys from the dashboard API (/api/integrations/keys, needs users.manage), or on the server:

    python -m app.api_keys create "ERPNext" --scopes employees:read,attendance:read
    python -m app.api_keys list
    python -m app.api_keys revoke <id>
"""

import argparse
import hashlib
import secrets
import sys
from dataclasses import dataclass
from datetime import timedelta
from typing import Optional

from fastapi import Depends, Request
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db, utcnow
from app.errors import ApiError
from app.models import ApiKey

KEY_PREFIX = "ws_live_"

# Scope -> what it allows (shown when creating a key and in the API docs).
SCOPES: dict[str, str] = {
    "employees:read": "List employees, departments and work schedules",
    "employees:write": "Add and update employees, and issue face-enrolment links",
    "attendance:read": "Attendance records, timesheets (time inside the office) and who is in now",
    "attendance:write": "Record manual check-ins and check-outs",
}
READ_SCOPES = tuple(s for s in SCOPES if s.endswith(":read"))

# lastUsedAt is written at most this often per key, so busy integrations don't write on every call.
_TOUCH_EVERY = timedelta(minutes=1)


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def clean_scopes(scopes) -> list[str]:
    """Validated, de-duplicated scopes in a stable order. Raises ApiError(400) on an unknown one."""
    wanted = {str(s).strip() for s in (scopes or []) if str(s).strip()}
    unknown = sorted(wanted - SCOPES.keys())
    if unknown:
        raise ApiError(400, f"Unknown scope(s): {', '.join(unknown)}", validScopes=list(SCOPES))
    if not wanted:
        raise ApiError(400, "Choose at least one scope", validScopes=list(SCOPES))
    return [s for s in SCOPES if s in wanted]


def create_key(db: Session, name: str, scopes, created_by_id: Optional[str] = None) -> tuple[ApiKey, str]:
    """Store a new key and return it with the raw key (the only time the raw key exists). Caller commits."""
    name = (name or "").strip()
    if not name:
        raise ApiError(400, "Give the key a name, e.g. the system that will use it")
    if len(name) > 80:
        raise ApiError(400, "Key name is too long (80 characters at most)")
    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    key = ApiKey(
        name=name,
        key_prefix=raw[: len(KEY_PREFIX) + 6],
        key_hash=hash_key(raw),
        scopes=" ".join(clean_scopes(scopes)),
        created_by_id=created_by_id,
    )
    db.add(key)
    return key, raw


def key_json(key: ApiKey) -> dict:
    from app.serialize import value

    return {
        "id": key.id,
        "name": key.name,
        "keyPrefix": key.key_prefix,
        "scopes": key.scopes.split(),
        "createdAt": value(key.created_at),
        "lastUsedAt": value(key.last_used_at),
        "revokedAt": value(key.revoked_at),
        "isActive": key.revoked_at is None,
    }


# ---------------------------------------------------------------- request authentication

# Declared so the API docs show an "Authorize" button for both ways of sending the key.
_bearer = HTTPBearer(auto_error=False, description="Authorization: Bearer ws_live_...")
_header = APIKeyHeader(name="X-API-Key", auto_error=False, description="X-API-Key: ws_live_...")


@dataclass(frozen=True)
class ApiClient:
    """The system calling the integration API."""

    key_id: str
    name: str
    scopes: frozenset[str]
    ip: Optional[str]


def api_client(
    request: Request,
    bearer: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    header_key: Optional[str] = Depends(_header),
    db: Session = Depends(get_db),
) -> ApiClient:
    raw = (header_key or (bearer.credentials if bearer else "") or "").strip()
    if not raw:
        raise ApiError(401, "API key required. Send it as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.")
    if not raw.startswith(KEY_PREFIX):
        raise ApiError(401, "That isn't a WorkSight API key. Keys start with 'ws_live_'.")
    key = db.scalar(select(ApiKey).where(ApiKey.key_hash == hash_key(raw)))
    if key is None:
        raise ApiError(401, "Invalid API key")
    if key.revoked_at is not None:
        raise ApiError(401, "This API key has been revoked")

    now = utcnow()
    if key.last_used_at is None or now - key.last_used_at >= _TOUCH_EVERY:
        key.last_used_at = now
        db.commit()

    ip = request.headers.get("x-real-ip") or (request.client.host if request.client else None)
    return ApiClient(key_id=key.id, name=key.name, scopes=frozenset(key.scopes.split()), ip=ip)


def require_scope(scope: str):
    """Dependency: the calling key must have `scope`."""
    if scope not in SCOPES:
        raise ValueError(f"unknown scope {scope}")

    def _check(client: ApiClient = Depends(api_client)) -> ApiClient:
        if scope not in client.scopes:
            raise ApiError(403, f"This API key doesn't have the '{scope}' scope ({SCOPES[scope].lower()}).")
        return client

    return _check


# ---------------------------------------------------------------- command line


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.api_keys", description="Manage integration API keys.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create", help="create a key (printed once)")
    c.add_argument("name", help="who will use it, e.g. ERPNext")
    c.add_argument(
        "--scopes",
        default=",".join(READ_SCOPES),
        help=f"comma-separated, from: {', '.join(SCOPES)} (default: all read scopes)",
    )
    sub.add_parser("list", help="list keys")
    r = sub.add_parser("revoke", help="revoke a key")
    r.add_argument("id")
    args = parser.parse_args(argv)

    from app.database import engine

    ApiKey.__table__.create(engine, checkfirst=True)  # in case the backend hasn't restarted since this was added
    with SessionLocal() as db:
        if args.cmd == "create":
            try:
                key, raw = create_key(db, args.name, args.scopes.split(","))
            except ApiError as exc:
                print(f"error: {exc.message}", file=sys.stderr)
                return 2
            db.commit()
            print(f"Created key {key.id} for {key.name} ({key.scopes}).")
            print("Copy it now, it won't be shown again:")
            print(raw)
        elif args.cmd == "list":
            for key in db.scalars(select(ApiKey).order_by(ApiKey.created_at)).all():
                state = "revoked" if key.revoked_at else "active"
                used = key.last_used_at.isoformat(timespec="seconds") + "Z" if key.last_used_at else "never"
                print(f"{key.id}  {key.key_prefix}…  {state:7}  last used {used:22}  {key.name}  [{key.scopes}]")
        elif args.cmd == "revoke":
            key = db.get(ApiKey, args.id)
            if key is None:
                print("error: no key with that id", file=sys.stderr)
                return 2
            key.revoked_at = key.revoked_at or utcnow()
            db.commit()
            print(f"Revoked {key.name} ({key.key_prefix}…)")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
