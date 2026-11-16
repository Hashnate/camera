from dataclasses import dataclass
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


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def create_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "id": user.id,
        "email": user.email,
        "role": user.role.value,
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


def current_user(request: Request, db: Session = Depends(get_db)) -> AuthUser:
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

    return AuthUser(
        id=user.id,
        email=user.email,
        role=user.role,
        full_name=user.full_name,
        company_id=user.company_id,
    )


def require_role(*allowed: UserRole):
    """Dependency factory: `Depends(require_role(UserRole.SUPER_ADMIN, ...))`."""

    def _check(user: AuthUser = Depends(current_user)) -> AuthUser:
        if user.role not in allowed:
            names = ", ".join(r.value for r in allowed)
            raise ApiError(403, f"Forbidden: requires one of [{names}] role permissions")
        return user

    return _check


async def json_body(request: Request) -> dict:
    """Loosely parsed JSON body (missing or invalid body -> {}), like express.json()."""
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
