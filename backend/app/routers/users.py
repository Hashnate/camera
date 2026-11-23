"""User accounts and access levels (Users & access page). Needs the users.manage permission.

Safety rules
  - Nobody can change their own role, disable or delete themselves (so an admin can't lock everyone out).
  - Only a Super admin can create, change, reset or delete a Super admin, or make someone a Super admin.
  - An Employee login must be linked to an employee record; one login per employee.
  - Passwords set here are temporary: the person must choose their own at first sign-in.
"""

import json
import re
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import AuditLog, Employee, User, UserRole
from app.permissions import PROTECTED_ROLES, ROLE_INFO, perms_for
from app.security import AuthUser, current_user, hash_password, json_body, password_problem, temporary_password
from app.serialize import value

router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[Depends(current_user)])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _json(u: User, db: Session, me: AuthUser) -> dict:
    emp = db.get(Employee, u.employee_id) if u.employee_id else None
    now = utcnow()
    return {
        "id": u.id,
        "email": u.email,
        "fullName": u.full_name,
        "role": u.role.value,
        "roleLabel": ROLE_INFO[u.role][0],
        "isActive": u.is_active,
        "isLocked": bool(u.locked_until and u.locked_until > now),
        "mustChangePassword": u.must_change_password,
        "lastLoginAt": value(u.last_login_at),
        "createdAt": value(u.created_at),
        "employee": {"id": emp.id, "fullName": emp.full_name, "employeeCode": emp.employee_code} if emp else None,
        "isYou": u.id == me.id,
        "canEdit": _may_touch(me, u.role),
    }


def audit(db: Session, actor_id: Optional[str], action: str, user: User, **details) -> None:
    """Record an account change (who did what to whom) in the audit log."""
    db.add(
        AuditLog(
            user_id=actor_id,
            action=action,
            entity_type="User",
            entity_id=user.id,
            details=json.dumps({"email": user.email, **details}),
        )
    )


def _may_touch(me: AuthUser, role: UserRole) -> bool:
    return me.role == UserRole.SUPER_ADMIN or role not in PROTECTED_ROLES


def _get(db: Session, user_id: str, me: AuthUser) -> User:
    u = db.get(User, user_id)
    if not u:
        raise ApiError(404, "User not found")
    if not _may_touch(me, u.role):
        raise ApiError(403, "Only a Super admin can change a Super admin's account.")
    return u


def _role(raw, me: AuthUser) -> UserRole:
    try:
        role = UserRole(str(raw))
    except ValueError:
        raise ApiError(400, "Choose an access level")
    if not _may_touch(me, role):
        raise ApiError(403, "Only a Super admin can give Super admin access.")
    return role


def _email(raw, db: Session, exclude_id: Optional[str] = None) -> str:
    email = str(raw or "").strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 200:
        raise ApiError(400, "Enter a valid email address")
    q = select(User.id).where(func.lower(User.email) == email)
    if exclude_id:
        q = q.where(User.id != exclude_id)
    if db.scalar(q):
        raise ApiError(409, "Another user already signs in with this email")
    return email


def _employee(raw, db: Session, exclude_user_id: Optional[str] = None) -> Optional[str]:
    if not raw:
        return None
    emp = db.get(Employee, str(raw))
    if not emp:
        raise ApiError(404, "Employee not found")
    q = select(User).where(User.employee_id == emp.id)
    if exclude_user_id:
        q = q.where(User.id != exclude_user_id)
    other = db.scalar(q)
    if other:
        raise ApiError(409, f"{emp.full_name} already has a login ({other.email})")
    return emp.id


def _active_super_admins(db: Session) -> int:
    return db.scalar(
        select(func.count()).select_from(User).where(User.role == UserRole.SUPER_ADMIN, User.is_active.is_(True))
    ) or 0


@router.get("/roles")
def roles(me: AuthUser = Depends(current_user)):
    return {
        "success": True,
        "data": [
            {
                "value": r.value,
                "label": ROLE_INFO[r][0],
                "description": ROLE_INFO[r][1],
                "permissions": sorted(p.value for p in perms_for(r)),
                "assignable": _may_touch(me, r),
            }
            for r in ROLE_INFO
        ],
    }


@router.get("")
def list_users(me: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    users = db.scalars(select(User).order_by(User.full_name)).all()
    return {"success": True, "count": len(users), "data": [_json(u, db, me) for u in users]}


@router.post("")
def create_user(body: dict = Depends(json_body), me: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    """Create a login. Returns a temporary password once; the person changes it at first sign-in."""
    name = str(body.get("fullName") or "").strip()[:100]
    if not name:
        raise ApiError(400, "Enter the person's name")
    email = _email(body.get("email"), db)
    role = _role(body.get("role"), me)
    employee_id = _employee(body.get("employeeId"), db)
    if role == UserRole.EMPLOYEE and not employee_id:
        raise ApiError(400, "Choose which employee this login belongs to")

    password = str(body.get("password") or "")
    if password:
        problem = password_problem(password, email)
        if problem:
            raise ApiError(400, problem)
    else:
        password = temporary_password()

    u = User(
        email=email,
        full_name=name,
        role=role,
        password_hash=hash_password(password),
        company_id=me.company_id,
        employee_id=employee_id,
        must_change_password=True,
        is_active=True,
    )
    db.add(u)
    db.flush()
    audit(db, me.id, "USER_CREATED", u, role=role.value, employeeId=employee_id)
    db.commit()
    return {"success": True, "data": _json(u, db, me), "temporaryPassword": password}


@router.patch("/{user_id}")
def update_user(user_id: str, body: dict = Depends(json_body), me: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    """Change name, email, access level, linked employee, or switch the account on/off / unlock it."""
    u = _get(db, user_id, me)
    is_you = u.id == me.id
    sign_out = False
    before = {"fullName": u.full_name, "email": u.email, "role": u.role.value, "employeeId": u.employee_id, "isActive": u.is_active}

    if "fullName" in body:
        name = str(body.get("fullName") or "").strip()[:100]
        if not name:
            raise ApiError(400, "Enter the person's name")
        u.full_name = name
    if "email" in body:
        u.email = _email(body.get("email"), db, exclude_id=u.id)
    if "role" in body:
        role = _role(body.get("role"), me)
        if role != u.role:
            if is_you:
                raise ApiError(400, "You can't change your own access level. Ask another admin.")
            if u.role == UserRole.SUPER_ADMIN and u.is_active and _active_super_admins(db) <= 1:
                raise ApiError(400, "This is the only Super admin. Make someone else Super admin first.")
            u.role = role
            sign_out = True
    if "employeeId" in body:
        u.employee_id = _employee(body.get("employeeId"), db, exclude_user_id=u.id)
    if u.role == UserRole.EMPLOYEE and not u.employee_id:
        raise ApiError(400, "An Employee login must be linked to an employee")
    if "isActive" in body:
        active = bool(body["isActive"])
        if not active and is_you:
            raise ApiError(400, "You can't disable your own account.")
        if not active and u.role == UserRole.SUPER_ADMIN and u.is_active and _active_super_admins(db) <= 1:
            raise ApiError(400, "This is the only Super admin, so it can't be disabled.")
        if active != u.is_active:
            u.is_active = active
            sign_out = sign_out or not active
    if body.get("unlock"):
        u.locked_until = None
        u.failed_logins = 0

    if sign_out:
        u.token_version = (u.token_version or 0) + 1  # signs them out everywhere
    after = {"fullName": u.full_name, "email": u.email, "role": u.role.value, "employeeId": u.employee_id, "isActive": u.is_active}
    changed = {k: [before[k], after[k]] for k in after if before[k] != after[k]}
    if changed or body.get("unlock"):
        audit(db, me.id, "USER_UPDATED", u, changes=changed, unlocked=bool(body.get("unlock")))
    db.commit()
    return {"success": True, "data": _json(u, db, me)}


@router.post("/{user_id}/reset-password")
def reset_password(user_id: str, me: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    """New temporary password (shown once). Signs the person out everywhere and unlocks the account."""
    u = _get(db, user_id, me)
    if u.id == me.id:
        raise ApiError(400, "To change your own password, use Change password in your account menu.")
    password = temporary_password()
    u.password_hash = hash_password(password)
    u.must_change_password = True
    u.token_version = (u.token_version or 0) + 1
    u.locked_until = None
    u.failed_logins = 0
    audit(db, me.id, "USER_PASSWORD_RESET", u)
    db.commit()
    return {"success": True, "data": _json(u, db, me), "temporaryPassword": password}


@router.delete("/{user_id}")
def delete_user(user_id: str, me: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    u = _get(db, user_id, me)
    if u.id == me.id:
        raise ApiError(400, "You can't delete your own account.")
    if u.role == UserRole.SUPER_ADMIN and u.is_active and _active_super_admins(db) <= 1:
        raise ApiError(400, "This is the only Super admin, so it can't be deleted.")
    audit(db, me.id, "USER_DELETED", u, role=u.role.value)
    db.delete(u)
    db.commit()
    return {"success": True, "message": "User deleted"}


ACTION_TEXT = {
    "USER_CREATED": "created the account",
    "USER_UPDATED": "changed the account",
    "USER_PASSWORD_RESET": "reset the password",
    "USER_DELETED": "deleted the account",
    "USER_PASSWORD_CHANGED": "changed their own password",
    "USER_LOCKED": "was locked after too many wrong passwords",
}


@router.get("/activity")
def activity(limit: int = 30, db: Session = Depends(get_db)):
    """Recent account changes, newest first."""
    rows = db.scalars(
        select(AuditLog).where(AuditLog.entity_type == "User").order_by(AuditLog.created_at.desc()).limit(min(max(limit, 1), 200))
    ).all()
    names = {u.id: u.full_name for u in db.scalars(select(User)).all()}
    out = []
    for r in rows:
        try:
            d = json.loads(r.details or "{}")
        except ValueError:
            d = {}
        out.append({
            "id": r.id,
            "at": value(r.created_at),
            "action": r.action,
            "text": ACTION_TEXT.get(r.action, r.action.lower()),
            "actor": names.get(r.user_id) if r.user_id else None,
            "target": names.get(r.entity_id) or d.get("email"),
            "changes": d.get("changes"),
        })
    return {"success": True, "data": out}
