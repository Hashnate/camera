"""Sign in, sign out, the signed-in user, and changing your own password."""

from datetime import timedelta

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import Employee, User
from app.permissions import ROLE_INFO, perms_for
from app.routers.users import audit
from app.security import (
    AuthUser,
    create_token,
    current_user,
    hash_password,
    json_body,
    password_problem,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

MAX_FAILED_LOGINS = 5
LOCK_MINUTES = 15
# Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
_DUMMY_HASH = hash_password("not-a-real-password-1")


def user_json(user: User, db: Session) -> dict:
    """The signed-in user as the dashboard needs it: who, which access, and which employee they are."""
    emp = db.get(Employee, user.employee_id) if user.employee_id else None
    return {
        "id": user.id,
        "email": user.email,
        "fullName": user.full_name,
        "role": user.role.value,
        "roleLabel": ROLE_INFO[user.role][0],
        "permissions": sorted(p.value for p in perms_for(user.role)),
        "mustChangePassword": user.must_change_password,
        "employee": {"id": emp.id, "fullName": emp.full_name, "employeeCode": emp.employee_code} if emp else None,
        "company": {"id": user.company.id, "name": user.company.name} if user.company else None,
    }


def _token_response(user: User, db: Session, message: str) -> JSONResponse:
    token = create_token(user)
    response = JSONResponse({"success": True, "message": message, "token": token, "user": user_json(user, db)})
    response.set_cookie(
        "token",
        token,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        max_age=settings.JWT_EXPIRES_DAYS * 24 * 60 * 60,
    )
    return response


@router.post("/login")
def login(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    email, password = str(body.get("email") or "").lower().strip(), str(body.get("password") or "")
    if not email or not password:
        raise ApiError(400, "Email and password are required")

    user = db.scalar(select(User).options(joinedload(User.company)).where(func.lower(User.email) == email))
    if user is None:
        verify_password(password, _DUMMY_HASH)
        raise ApiError(401, "Wrong email or password.")

    now = utcnow()
    if user.locked_until and user.locked_until > now:
        minutes = max(1, round((user.locked_until - now).total_seconds() / 60))
        raise ApiError(429, f"Too many wrong passwords. Try again in {minutes} minute{'s' if minutes != 1 else ''}, or ask your admin.")

    if not verify_password(password, user.password_hash):
        user.failed_logins = (user.failed_logins or 0) + 1
        if user.failed_logins >= MAX_FAILED_LOGINS:
            user.locked_until = now + timedelta(minutes=LOCK_MINUTES)
            user.failed_logins = 0
            audit(db, None, "USER_LOCKED", user, minutes=LOCK_MINUTES)
            db.commit()
            raise ApiError(429, f"Too many wrong passwords. This account is locked for {LOCK_MINUTES} minutes.")
        db.commit()
        raise ApiError(401, "Wrong email or password.")

    # Right password: only now say whether the account is switched off (so this reveals nothing to strangers).
    if not user.is_active:
        raise ApiError(403, "This account is disabled. Ask your admin.")

    user.failed_logins = 0
    user.locked_until = None
    user.last_login_at = now
    db.commit()
    return _token_response(user, db, "Login successful")


@router.post("/logout")
def logout():
    response = JSONResponse({"success": True, "message": "Logged out successfully"})
    response.delete_cookie("token")
    return response


@router.get("/me")
def get_me(auth: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    user = db.scalar(select(User).options(joinedload(User.company)).where(User.id == auth.id))
    return {"success": True, "user": user_json(user, db)}


@router.post("/change-password")
def change_password(body: dict = Depends(json_body), auth: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    """Change your own password. Signs out every other device; this one gets a fresh token."""
    user = db.get(User, auth.id)
    current, new = str(body.get("currentPassword") or ""), str(body.get("newPassword") or "")
    if not verify_password(current, user.password_hash):
        raise ApiError(400, "Your current password is wrong.")
    problem = password_problem(new, user.email)
    if problem:
        raise ApiError(400, problem)
    if verify_password(new, user.password_hash):
        raise ApiError(400, "Choose a password different from the current one.")
    user.password_hash = hash_password(new)
    user.must_change_password = False
    user.token_version = (user.token_version or 0) + 1
    audit(db, user.id, "USER_PASSWORD_CHANGED", user)
    db.commit()
    return _token_response(user, db, "Password changed")
