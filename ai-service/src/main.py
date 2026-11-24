import hmac
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from camera_io import PreviewPool, SourceError, grab_once, mask, to_jpeg
from config import settings
from face_engine import FaceEngine, FaceEngineError, decode_image
from worker import RecognitionManager
import scan as scan_mod

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ai")

engine: Optional[FaceEngine] = None
manager: Optional[RecognitionManager] = None
preview_pool = PreviewPool()


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


@app.post("/validate-face", dependencies=[Depends(require_service_key)])
async def validate_face(image: UploadFile = File(...), expected_angle: Optional[str] = None):
    """Validate face image quality, lighting, blur, and head orientation."""
    data = await image.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")
    try:
        res = engine.validate_face(decode_image(data), expected_angle=expected_angle)
        return {"success": True, "data": res}
    except FaceEngineError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/status", dependencies=[Depends(require_service_key)])
def status():
    if not manager:
        return {"running": False, "workerEnabled": False, "channels": [], "recent": []}
    return {"workerEnabled": True, **manager.status()}


# ---------------------------------------------------------------- camera pictures (tests and live previews)


class GrabRequest(BaseModel):
    source: dict  # {"type": "rtsp"|"http"|"usb", "url": ...}
    key: Optional[str] = None  # set for live previews: keeps the stream open between requests


def _jpeg_response(frame) -> Response:
    h, w = frame.shape[:2]
    return Response(
        to_jpeg(frame),
        media_type="image/jpeg",
        headers={"X-Frame-Width": str(w), "X-Frame-Height": str(h), "Cache-Control": "no-store"},
    )


@app.post("/grab-frame", dependencies=[Depends(require_service_key)])
def grab_frame(req: GrabRequest):
    """Open a camera (or reuse an open preview stream) and return one picture. Used by "Test connection"."""
    try:
        frame = preview_pool.frame(req.key, req.source) if req.key else grab_once(req.source)
    except SourceError as exc:
        raise HTTPException(status_code=400, detail=mask(str(exc)))
    except Exception as exc:
        log.warning("[grab-frame] %s", mask(str(exc)))
        raise HTTPException(status_code=400, detail="Could not get a picture from the camera.")
    return _jpeg_response(frame)


@app.get("/preview/{camera_id}/{channel_no}", dependencies=[Depends(require_service_key)])
def preview(camera_id: str, channel_no: int):
    """Latest frame of a lens that recognition is watching (404 if it isn't watched right now)."""
    frame = manager.latest_frame(camera_id, channel_no) if manager else None
    if frame is None:
        raise HTTPException(status_code=404, detail="Not watching this lens")
    return _jpeg_response(frame)


# ---------------------------------------------------------------- enrol from the office camera (live scanning)


@app.get("/scan/{camera_id}/{channel_no}", dependencies=[Depends(require_service_key)])
def scan(camera_id: str, channel_no: int):
    """Latest frame of a watched lens with every face's full-view verdict (see scan.py)."""
    frame = manager.latest_frame(camera_id, channel_no) if manager else None
    if frame is None:
        raise HTTPException(status_code=404, detail="This lens isn't being watched right now, or has no recent picture.")
    return scan_mod.scan_lens(engine, manager.gallery, camera_id, channel_no, frame)


class ScanCaptureRequest(BaseModel):
    cameraId: str
    channelNo: int
    scanId: str
    faceIndex: int


@app.post("/scan/capture", dependencies=[Depends(require_service_key)])
def scan_capture(req: ScanCaptureRequest):
    """Embedding + review crop of one face from a recent scan. Only full views are accepted."""
    if not manager:
        raise HTTPException(status_code=503, detail="Recognition is not running")
    try:
        res = scan_mod.capture(manager.gallery, req.cameraId, req.channelNo, req.scanId, req.faceIndex)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if res is None:
        raise HTTPException(status_code=410, detail="That picture has expired; the scan moved on.")
    return res


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
        httpx.post(
            f"{settings.BACKEND_API_URL}/analytics/events",
            json=payload,
            headers={"X-Service-Key": settings.AI_SERVICE_KEY},
            timeout=5,
        )
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
