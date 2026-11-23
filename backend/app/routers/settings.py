"""System settings changed from the dashboard (Settings page).

Anyone signed in can read them (no secrets are ever returned); only admins can change them.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import UserRole
from app.providers.ezviz import DEFAULT_BASE_URL, EZVIZError, _post_to, request_token
from app.routers.cameras import ADMIN_ROLES, require_admin
from app.security import AuthUser, current_user, json_body
from app.services import settings_store

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def all_settings(user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    return {
        "success": True,
        "canEdit": user.role in ADMIN_ROLES,
        "data": {name: settings_store.public(name, db) for name in settings_store.SCHEMA},
    }


@router.put("/{section}")
def update_section(
    section: str,
    body: dict = Depends(json_body),
    user: AuthUser = Depends(require_admin),
    db: Session = Depends(get_db),
):
    return {"success": True, "data": settings_store.save(db, section, body, user.id)}


@router.post("/ezviz/test", dependencies=[Depends(require_admin)])
def test_ezviz(body: dict = Depends(json_body)):
    """Check an EZVIZ App Key / Secret without saving it. Empty fields use the saved values."""
    current = settings_store.get("ezviz")
    key = str(body.get("appKey") or current["appKey"] or "").strip()
    secret = str(body.get("appSecret") or current["appSecret"] or "").strip()
    base = str(body.get("apiBaseUrl") or current["apiBaseUrl"] or DEFAULT_BASE_URL).strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        return {"success": True, "data": {"ok": False, "message": "The API address must start with https://"}}
    try:
        token, _ = request_token(key, secret, base)
        listing = _post_to(base, "/api/lapp/device/list", {"accessToken": token, "pageStart": 0, "pageSize": 50})
    except EZVIZError as exc:
        return {"success": True, "data": {"ok": False, "message": str(exc)}}
    count = len(listing.get("data") or []) if str(listing.get("code")) == "200" else None
    message = (
        f"Connected. {count} camera{'' if count == 1 else 's'} on this account."
        if count is not None
        else f"Signed in, but the camera list failed: {listing.get('msg') or listing.get('code')}"
    )
    return {"success": True, "data": {"ok": count is not None, "deviceCount": count, "message": message}}
