import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.errors import ApiError
from app.models import User, UserRole
from app.permissions import ANY_USER, PERM_TEXT, Perm, perms_for, required_permission


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def password_problem(password: str, email: str = "") -> Optional[str]:
    """Why a new password isn't acceptable, or None."""
    if len(password) < 8:
        return "Use at least 8 characters."
    if len(password) > 128:
        return "Use at most 128 characters."
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        return "Use both letters and numbers."
    if email and password.lower() == email.lower():
        return "Don't use your email address as the password."
    return None


def temporary_password() -> str:
    """Readable one-time password for a new account or a reset, e.g. 'kq7m-v2xd-9pwt'."""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"  # no look-alikes (l/1, o/0)
    while True:
        raw = "".join(secrets.choice(alphabet) for _ in range(12))
        if re.search(r"\d", raw) and re.search(r"[a-z]", raw):
            return f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def create_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "id": user.id,
        "email": user.email,
        "role": user.role.value,
        "ver": user.token_version or 0,  # older tokens stop working when this changes
        "iat": now,
        "exp": now + timedelta(days=settings.JWT_EXPIRES_DAYS),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm="HS256")


@dataclass
class AuthUser:
    id: str
    email: str
    role: UserRole
    full_name: str
    company_id: Optional[str]
    employee_id: Optional[str] = None
    must_change_password: bool = False
    perms: frozenset = field(default_factory=frozenset)

    def can(self, perm: Perm) -> bool:
        return perm in self.perms


# While a temporary password is in use, only these are allowed.
_PASSWORD_CHANGE_PATHS = {"/api/auth/me", "/api/auth/change-password", "/api/auth/logout"}


def current_user(request: Request, db: Session = Depends(get_db)) -> AuthUser:
    """The signed-in user, after checking the account and that their role may use this endpoint."""
    token: Optional[str] = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    elif request.cookies.get("token"):
        token = request.cookies["token"]

    if not token:
        raise ApiError(401, "Authentication required. No token provided.")

    try:
        decoded = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise ApiError(401, "Invalid or expired token", error=str(exc))

    user = db.get(User, decoded.get("id"))
    if not user:
        raise ApiError(401, "User not found or revoked.")
    if not user.is_active:
        raise ApiError(401, "This account is disabled. Ask your admin.")
    if decoded.get("ver", 0) != (user.token_version or 0):
        raise ApiError(401, "Your sign-in has expired. Please sign in again.")

    auth = AuthUser(
        id=user.id,
        email=user.email,
        role=user.role,
        full_name=user.full_name,
        company_id=user.company_id,
        employee_id=user.employee_id,
        must_change_password=user.must_change_password,
        perms=perms_for(user.role),
    )

    path = request.url.path.rstrip("/") or "/"
    if auth.must_change_password and path not in _PASSWORD_CHANGE_PATHS:
        raise ApiError(403, "Choose a new password first.", code="PASSWORD_CHANGE_REQUIRED")
    needed = required_permission(request.method, path)
    if needed is None:
        raise ApiError(403, "Your account doesn't have access to this.")
    if needed != ANY_USER and not auth.can(needed):
        raise ApiError(403, f"Your account can't {PERM_TEXT[needed]}. Ask an admin if you need this.")
    return auth


def require_perm(perm: Perm):
    """Dependency factory for an extra check inside an endpoint's own logic."""

    def _check(user: AuthUser = Depends(current_user)) -> AuthUser:
        if not user.can(perm):
            raise ApiError(403, f"Your account can't {PERM_TEXT[perm]}. Ask an admin if you need this.")
        return user

    return _check


def require_role(*allowed: UserRole):
    """Dependency factory: `Depends(require_role(UserRole.SUPER_ADMIN, ...))`."""

    def _check(user: AuthUser = Depends(current_user)) -> AuthUser:
        if user.role not in allowed:
            raise ApiError(403, "Your account doesn't have access to this. Ask an admin if you need it.")
        return user

    return _check


async def json_body(request: Request) -> dict:
    """Loosely parsed JSON body (missing or invalid body -> {}), like express.json()."""
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
