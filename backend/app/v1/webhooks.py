"""Webhooks a system registers with its own API key, so WorkSight tells it about arrivals as they happen."""

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api_keys import ApiClient, require_scope
from app.database import get_db
from app.errors import ApiError
from app.models import WebhookEndpoint
from app.services import webhooks as hooks
from app.v1 import schemas
from app.v1.common import audit

router = APIRouter(tags=["Webhooks"])
Scope = require_scope("attendance:read")  # events carry the same data /presence/now gives
IdPath = Path(description="The webhook's id")


def _own(db: Session, client: ApiClient, webhook_id: str) -> WebhookEndpoint:
    ep = db.get(WebhookEndpoint, webhook_id)
    if ep is None or ep.api_key_id != client.key_id:
        raise ApiError(404, "No webhook with that id for this API key")
    return ep


@router.get("/webhooks", response_model=schemas.WebhookList, summary="List your webhooks")
def list_webhooks(client: ApiClient = Depends(Scope), db: Session = Depends(get_db)):
    """Webhooks made with this API key."""
    eps = db.scalars(
        select(WebhookEndpoint).where(WebhookEndpoint.api_key_id == client.key_id).order_by(WebhookEndpoint.created_at)
    ).all()
    return {"success": True, "data": [hooks.endpoint_json(e) for e in eps]}


@router.post("/webhooks", response_model=schemas.WebhookCreated, status_code=201, summary="Add a webhook")
def add_webhook(body: schemas.WebhookCreate, client: ApiClient = Depends(Scope), db: Session = Depends(get_db)):
    """From now on WorkSight POSTs each event to `url`. Events from earlier today are not sent.

    The answer holds `secret`, shown only once: use it to check the `X-WorkSight-Signature` header of every
    delivery. The address must be public and use https."""
    ep, secret = hooks.create_endpoint(
        db, body.url, body.events, body.awayAfterMin, body.description, api_key_id=client.key_id
    )
    audit(db, client, "API_WEBHOOK_CREATE", "WebhookEndpoint", ep.id, {"url": ep.url, "events": ep.events})
    db.commit()
    db.refresh(ep)
    return JSONResponse({"success": True, "data": {**hooks.endpoint_json(ep), "secret": secret}}, status_code=201)


@router.delete("/webhooks/{webhookId}", summary="Remove a webhook")
def remove_webhook(webhookId: str = IdPath, client: ApiClient = Depends(Scope), db: Session = Depends(get_db)):
    ep = _own(db, client, webhookId)
    audit(db, client, "API_WEBHOOK_DELETE", "WebhookEndpoint", ep.id, {"url": ep.url})
    db.delete(ep)
    db.commit()
    return {"success": True, "message": "Webhook removed. Nothing more will be sent to it."}


@router.post("/webhooks/{webhookId}/test", response_model=schemas.DeliveryOne, summary="Send a test event")
def test_webhook(webhookId: str = IdPath, client: ApiClient = Depends(Scope), db: Session = Depends(get_db)):
    """Sends a `webhook.test` event straight away and returns what happened. Not retried."""
    d = hooks.send_test(db, _own(db, client, webhookId))
    return {"success": True, "data": hooks.delivery_json(d)}


@router.get("/webhooks/{webhookId}/deliveries", response_model=schemas.DeliveryList, summary="Recent deliveries")
def deliveries(
    webhookId: str = IdPath,
    limit: int = Query(50, ge=1, le=200),
    client: ApiClient = Depends(Scope),
    db: Session = Depends(get_db),
):
    """Newest first, kept for 30 days."""
    ep = _own(db, client, webhookId)
    return {"success": True, "data": [hooks.delivery_json(d) for d in hooks.recent_deliveries(db, ep, limit)]}
