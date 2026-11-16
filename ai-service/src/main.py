import hmac
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel

from config import settings
from face_engine import FaceEngine, FaceEngineError, decode_image
from worker import RecognitionManager

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ai")

engine: Optional[FaceEngine] = None
manager: Optional[RecognitionManager] = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global engine, manager
    engine = FaceEngine(min_face_size=settings.MIN_FACE_SIZE)
    log.info("[AI Service] Face engine loaded (YuNet + SFace)")
    if not settings.AI_SERVICE_KEY:
        log.warning("[AI Service] AI_SERVICE_KEY is not set; the backend will reject recognition reports.")
    if settings.ENABLE_WORKER:
        manager = RecognitionManager(engine)
        manager.start()
        log.info("[AI Service] Auto-attendance worker started (backend: %s)", settings.BACKEND_API_URL)
    yield
    if manager:
        manager.stop()


app = FastAPI(
    title="WorkSight AI Computer Vision Engine",
    description="Face recognition for automatic attendance, plus occupancy event reporting",
    version="2.0.0",
    lifespan=lifespan,
)


def require_service_key(x_service_key: str = Header(default="")) -> None:
    if not settings.AI_SERVICE_KEY or not hmac.compare_digest(x_service_key, settings.AI_SERVICE_KEY):
        raise HTTPException(status_code=401, detail="Invalid service key")


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "WorkSight AI Engine",
        "models": ["YuNet face detector", "SFace face recognizer"],
        "workerEnabled": settings.ENABLE_WORKER,
    }


@app.post("/embed", dependencies=[Depends(require_service_key)])
async def embed(image: UploadFile = File(...)):
    """Face embedding for an enrolment photo. The photo is processed in memory and discarded."""
    data = await image.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")
    try:
        vec = engine.embed_single(decode_image(data))
    except FaceEngineError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"embedding": [round(float(x), 6) for x in vec]}


@app.get("/status", dependencies=[Depends(require_service_key)])
def status():
    if not manager:
        return {"running": False, "workerEnabled": False, "channels": [], "recent": []}
    return {"workerEnabled": True, **manager.status()}


# ---------------------------------------------------------------- occupancy (unchanged stub)


class ZoneConfig(BaseModel):
    zone_id: str
    name: str
    polygon: List[List[float]]  # normalised [[x,y], ...]


class FrameProcessRequest(BaseModel):
    camera_id: str
    channel_no: int = 1
    snapshot_url: Optional[str] = None
    confidence_threshold: float = 0.45


@app.post("/process-frame")
def process_frame(req: FrameProcessRequest):
    """Counts faces in a snapshot and reports an OCCUPANCY_COUNT event to the backend."""
    if not req.snapshot_url:
        raise HTTPException(status_code=400, detail="Snapshot URL is required")
    try:
        img = decode_image(httpx.get(req.snapshot_url, timeout=15).content)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not load snapshot: {exc}")
    faces = engine.analyze(img)
    payload = {
        "cameraId": req.camera_id,
        "channelNo": req.channel_no,
        "eventType": "OCCUPANCY_COUNT",
        "personCount": len(faces),
        "confidence": round(max((f.score for f in faces), default=0.0), 3) or None,
    }
    try:
        httpx.post(f"{settings.BACKEND_API_URL}/analytics/events", json=payload, timeout=5)
    except Exception as exc:
        log.warning("[AI Service] Could not notify backend: %s", exc)
    return {
        "success": True,
        "detectedPersons": len(faces),
        "channelNo": req.channel_no,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=settings.PORT, app_dir="src", reload=False)
