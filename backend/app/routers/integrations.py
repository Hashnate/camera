"""Dashboard API for integration API keys and webhooks (Settings > Integrations). Needs users.manage.

The integration API itself lives in app.v1 and is used with these keys, not with a user login.
"""

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api_keys import SCOPES, create_key, key_json
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import ApiKey, User, WebhookEndpoint
from app.security import AuthUser, current_user, json_body
from app.services import webhooks as hooks

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


@router.get("/keys")
def list_keys(_user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    keys = db.scalars(select(ApiKey).order_by(ApiKey.revoked_at.is_not(None), ApiKey.created_at.desc())).all()
    makers = {k.created_by_id for k in keys if k.created_by_id}
    names = dict(db.execute(select(User.id, User.full_name).where(User.id.in_(makers))).all()) if makers else {}
    return {
        "success": True,
        "data": [{**key_json(k), "createdByName": names.get(k.created_by_id)} for k in keys],
        "scopes": [{"scope": s, "description": d} for s, d in SCOPES.items()],
        "docsPath": "/api/v1/docs",
    }


@router.post("/keys")
def new_key(body: dict = Depends(json_body), user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    scopes = body.get("scopes")
    if not isinstance(scopes, list):
        raise ApiError(400, "scopes must be a list", validScopes=list(SCOPES))
    key, raw = create_key(db, body.get("name"), scopes, created_by_id=user.id)
    db.commit()
    return JSONResponse(
        {"success": True, "data": {**key_json(key), "createdByName": user.full_name, "key": raw},
         "message": "Copy the key now: it won't be shown again."},
        status_code=201,
    )


@router.delete("/keys/{key_id}")
def revoke_key(key_id: str, _user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    key = db.get(ApiKey, key_id)
    if key is None:
        raise ApiError(404, "API key not found")
    if key.revoked_at is None:
        key.revoked_at = utcnow()
        db.commit()
    return {"success": True, "data": key_json(key), "message": f"Revoked. {key.name} can no longer use this key."}


# ---------------------------------------------------------------- webhooks


def _webhook(db: Session, webhook_id: str) -> WebhookEndpoint:
    ep = db.get(WebhookEndpoint, webhook_id)
    if ep is None:
        raise ApiError(404, "Webhook not found")
    return ep


@router.get("/webhooks")
def list_webhooks(_user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    eps = db.scalars(select(WebhookEndpoint).order_by(WebhookEndpoint.created_at.desc())).all()
    return {
        "success": True,
        "data": [hooks.endpoint_json(e) for e in eps],
        "events": [{"event": e, "description": d} for e, d in hooks.EVENTS.items()],
    }


@router.post("/webhooks")
def new_webhook(body: dict = Depends(json_body), user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    """Admins may also use plain http or a private (office network) address, e.g. an ERP on the LAN."""
    away = body.get("awayAfterMin", 15)
    events = body.get("events")
    if events is not None and not isinstance(events, list):
        raise ApiError(400, "events must be a list", validEvents=list(hooks.EVENTS))
    ep, secret = hooks.create_endpoint(
        db,
        str(body.get("url") or ""),
        events,
        away if isinstance(away, int) and not isinstance(away, bool) else -1,
        body.get("description"),
        allow_private=True,
        created_by_id=user.id,
    )
    return JSONResponse(
        {"success": True, "data": {**hooks.endpoint_json(ep), "secret": secret},
         "message": "Copy the signing secret now: it won't be shown again."},
        status_code=201,
    )


@router.delete("/webhooks/{webhook_id}")
def remove_webhook(webhook_id: str, _user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(_webhook(db, webhook_id))
    db.commit()
    return {"success": True, "message": "Webhook removed."}


@router.post("/webhooks/{webhook_id}/test")
def test_webhook(webhook_id: str, _user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    d = hooks.send_test(db, _webhook(db, webhook_id))
    return {"success": True, "data": hooks.delivery_json(d)}


@router.get("/webhooks/{webhook_id}/deliveries")
def webhook_deliveries(webhook_id: str, _user: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    ep = _webhook(db, webhook_id)
    return {"success": True, "data": [hooks.delivery_json(d) for d in hooks.recent_deliveries(db, ep)]}
