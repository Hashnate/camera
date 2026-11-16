"""Dashboard view of automatic attendance: recent recognitions and AI worker status."""

from typing import Optional

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import RecognitionEvent
from app.security import current_user
from app.serialize import ser

router = APIRouter(prefix="/api/recognition", tags=["recognition"], dependencies=[Depends(current_user)])


@router.get("/events")
def events(limit: int = 50, actions: Optional[str] = None, db: Session = Depends(get_db)):
    """Recent recognitions; `actions=CHECK_IN,CHECK_OUT` filters out the once-a-minute SEEN updates."""
    stmt = select(RecognitionEvent)
    if actions:
        stmt = stmt.where(RecognitionEvent.action.in_([a.strip().upper() for a in actions.split(",") if a.strip()]))
    rows = db.scalars(stmt.order_by(RecognitionEvent.seen_at.desc()).limit(max(1, min(limit, 200)))).all()
    data = [
        ser(
            e,
            employee=ser(e.employee, only=("id", "fullName", "employeeCode", "jobTitle")),
            camera=ser(e.camera, only=("id", "name")),
        )
        for e in rows
    ]
    return {"success": True, "count": len(data), "data": data}


@router.get("/status")
def status():
    """AI service worker status (proxied so the browser never needs the service key)."""
    try:
        r = httpx.get(
            f"{settings.AI_SERVICE_URL}/status", headers={"X-Service-Key": settings.AI_SERVICE_KEY}, timeout=5
        )
        r.raise_for_status()
        return {"success": True, "data": {"reachable": True, **r.json()}}
    except Exception as exc:
        return {
            "success": True,
            "data": {"reachable": False, "error": f"AI service unreachable at {settings.AI_SERVICE_URL}: {exc}"},
        }
