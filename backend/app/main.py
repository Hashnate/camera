import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.errors import register_error_handlers
from app.database import Base, engine
from app.routers import analytics, attendance, auth, cameras, employees, faces, internal, recognition, work_hours

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("worksight")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    masked = re.sub(r":[^:@/]+@", ":****@", settings.DATABASE_URL)
    log.info("[WorkSight Backend] Server running on port %s in %s mode", settings.PORT, settings.APP_ENV)
    log.info("[WorkSight Backend] Database target: %s", masked)
    log.info("[WorkSight Backend] EZVIZ API Target: %s", settings.EZVIZ_API_BASE_URL)
    # Create any tables that don't exist yet (e.g. face enrolment tables); existing ones are untouched.
    Base.metadata.create_all(engine)
    with engine.begin() as conn:  # speeds up work-hours queries on existing databases
        conn.exec_driver_sql(
            'CREATE INDEX IF NOT EXISTS "RecognitionEvent_attendanceRecordId_seenAt_idx" '
            'ON "RecognitionEvent" ("attendanceRecordId", "seenAt")'
        )
    if not settings.AI_SERVICE_KEY:
        log.warning("[WorkSight Backend] AI_SERVICE_KEY not set: automatic attendance is disabled")
    yield


app = FastAPI(title="WorkSight Backend API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(dict.fromkeys([settings.FRONTEND_URL, "http://localhost:3000", "http://127.0.0.1:3000"])),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_error_handlers(app)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "WorkSight Backend API",
        "version": "1.0.0",
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }


for module in (auth, cameras, employees, attendance, analytics, faces, recognition, work_hours, internal):
    app.include_router(module.router)
