"""Background auto-attendance worker.

One thread per watched camera channel: pull a frame -> detect faces -> match against the
enrolled gallery -> once an employee is matched in CONFIRM_FRAMES frames within
CONFIRM_WINDOW_SEC, report them to the backend, which marks attendance.

Frames are processed in memory only; nothing is written to disk.
"""

import logging
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Optional

from backend_client import BackendClient
from config import settings
from face_engine import FaceEngine, Gallery
from sources import FrameSource, HLSSource, SnapshotSource, open_override_source

log = logging.getLogger("ai.worker")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ChannelWorker(threading.Thread):
    def __init__(self, manager: "RecognitionManager", camera: dict, channel_no: int):
        super().__init__(daemon=True, name=f"cam-{camera['id'][:8]}-ch{channel_no}")
        self.m = manager
        self.camera = camera
        self.channel_no = channel_no
        self.stop_event = threading.Event()
        self.source: Optional[FrameSource] = None
        self.hls_disabled_until = 0.0
        self.hls_failures: deque = deque()  # timestamps of recent HLS drop-outs
        self.matches: dict[str, deque] = defaultdict(deque)  # employeeId -> match timestamps
        self.state = {
            "cameraId": camera["id"],
            "cameraName": camera.get("name"),
            "channelNo": channel_no,
            "source": None,
            "state": "starting",
            "lastFrameAt": None,
            "framesProcessed": 0,
            "facesDetected": 0,
            "lastError": None,
        }

    # -------------------------------------------------------------- sources

    def _open_source(self) -> FrameSource:
        if settings.SOURCE_OVERRIDE:
            return open_override_source(settings.SOURCE_OVERRIDE)
        mode = settings.FRAME_SOURCE
        use_hls = mode == "hls" or (mode == "auto" and time.time() >= self.hls_disabled_until)
        if use_hls:
            try:
                return HLSSource(self.m.client, self.camera["id"], self.channel_no)
            except Exception as exc:
                if mode == "hls":
                    raise
                log.warning("[%s] HLS unavailable (%s); falling back to snapshots", self.name, exc)
                self.hls_disabled_until = time.time() + settings.HLS_RETRY_AFTER_SEC
        return SnapshotSource(self.m.client, self.camera["id"], self.channel_no)

    def _close_source(self) -> None:
        if self.source:
            try:
                self.source.close()
            except Exception:
                pass
        self.source = None

    # -------------------------------------------------------------- main loop

    def run(self) -> None:
        backoff = 2.0
        while not self.stop_event.is_set():
            # Nobody enrolled: don't pull video from the camera at all.
            if not len(self.m.gallery):
                self._close_source()
                self.state.update(state="idle", source=None, lastError="No employees enrolled")
                self.stop_event.wait(5)
                continue
            try:
                if self.source is None:
                    self.state.update(state="connecting", source=None)
                    self.source = self._open_source()
                    self.state.update(state="running", source=self.source.kind, lastError=None)
                    backoff = 2.0
                    # Switching back from snapshot fallback to HLS when the retry window passes.
                elif (
                    self.source.kind == "snapshot"
                    and settings.FRAME_SOURCE == "auto"
                    and not settings.SOURCE_OVERRIDE
                    and time.time() >= self.hls_disabled_until
                ):
                    self._close_source()
                    continue

                started = time.time()
                frame = self.source.read()
                if frame is not None:
                    self._process(frame)
                self.stop_event.wait(max(0.0, self.source.interval - (time.time() - started)))
            except Exception as exc:
                msg = str(exc)
                if "refresh due" not in msg:
                    log.warning("[%s] %s", self.name, msg)
                    self.state.update(state="error", lastError=msg)
                was_hls = self.source is not None and self.source.kind == "hls"
                self._close_source()
                if "refresh due" in msg:
                    continue
                if was_hls:
                    # Live streams drop now and then: reconnect straight away with a fresh URL, and only
                    # fall back to (rate-limited) snapshots if it keeps failing.
                    now = time.time()
                    self.hls_failures.append(now)
                    while self.hls_failures and now - self.hls_failures[0] > 600:
                        self.hls_failures.popleft()
                    if len(self.hls_failures) >= 3:
                        log.warning("[%s] live stream unstable; using snapshots for %ds", self.name, settings.HLS_RETRY_AFTER_SEC)
                        self.hls_disabled_until = now + settings.HLS_RETRY_AFTER_SEC
                        self.hls_failures.clear()
                    self.stop_event.wait(2)
                    continue
                self.stop_event.wait(backoff)
                backoff = min(backoff * 2, 60)
        self._close_source()

    def _process(self, frame) -> None:
        now = time.time()
        faces = self.m.engine.analyze(frame)
        self.state["framesProcessed"] += 1
        self.state["facesDetected"] += len(faces)
        self.state["lastFrameAt"] = _iso(now)

        for face in faces:
            emp_id, sim = self.m.gallery.match(face.embedding, settings.MATCH_THRESHOLD, settings.MATCH_MARGIN)
            if not emp_id:
                continue
            hits = self.matches[emp_id]
            hits.append((now, sim))
            while hits and now - hits[0][0] > settings.CONFIRM_WINDOW_SEC:
                hits.popleft()
            if len(hits) >= settings.CONFIRM_FRAMES:
                best = max(s for _, s in hits)
                hits.clear()
                self.m.report(emp_id, best, self.camera["id"], self.channel_no, now)

    def stop(self) -> None:
        self.stop_event.set()


class RecognitionManager:
    """Owns the shared engine/gallery, starts one ChannelWorker per watched channel."""

    def __init__(self, engine: FaceEngine):
        self.engine = engine
        self.client = BackendClient()
        self.gallery = Gallery()
        self.workers: dict[tuple[str, int], ChannelWorker] = {}
        self.recent: deque = deque(maxlen=30)
        self.last_reported: dict[str, float] = {}
        self._report_lock = threading.Lock()
        self._stop = threading.Event()
        self.gallery_loaded_at: Optional[str] = None
        self.last_error: Optional[str] = None
        self._thread = threading.Thread(target=self._supervise, daemon=True, name="recognition-supervisor")

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        for w in self.workers.values():
            w.stop()

    # -------------------------------------------------------------- supervision

    def _watched_channels(self, camera: dict) -> list[int]:
        chans = [c["channelNo"] for c in camera.get("channels", [])] or [1]
        if settings.WATCH_CHANNELS.strip().lower() != "all":
            wanted = {int(x) for x in settings.WATCH_CHANNELS.split(",") if x.strip()}
            chans = [c for c in chans if c in wanted]
        return chans

    def _targets(self) -> list[tuple[dict, int]]:
        cameras = self.client.cameras()
        if settings.SOURCE_OVERRIDE:
            # A single local source stands in for one camera channel.
            cam = next((c for c in cameras if c["id"] == settings.SOURCE_OVERRIDE_CAMERA_ID), None)
            cam = cam or (cameras[0] if cameras else None)
            return [(cam, 1)] if cam else []
        return [(cam, ch) for cam in cameras for ch in self._watched_channels(cam)]

    def _supervise(self) -> None:
        next_gallery = next_cameras = 0.0
        while not self._stop.is_set():
            now = time.time()
            try:
                if now >= next_gallery:
                    self.gallery.load(self.client.gallery())
                    self.gallery_loaded_at = _iso(now)
                    next_gallery = now + settings.GALLERY_REFRESH_SEC
                if now >= next_cameras:
                    self._sync_workers(self._targets())
                    next_cameras = now + settings.CAMERA_REFRESH_SEC
                self.last_error = None
            except Exception as exc:
                self.last_error = f"Backend unreachable: {exc}"
                log.warning("[supervisor] %s", self.last_error)
                next_gallery = next_cameras = now + 10
            self._stop.wait(2)

    def _sync_workers(self, targets: list[tuple[dict, int]]) -> None:
        wanted = {(cam["id"], ch): (cam, ch) for cam, ch in targets}
        for key in list(self.workers):
            if key not in wanted or not self.workers[key].is_alive():
                self.workers.pop(key).stop()
        for key, (cam, ch) in wanted.items():
            if key not in self.workers:
                w = ChannelWorker(self, cam, ch)
                self.workers[key] = w
                w.start()
                log.info("[supervisor] watching %s channel %s", cam.get("name"), ch)

    # -------------------------------------------------------------- reporting

    def report(self, employee_id: str, similarity: float, camera_id: str, channel_no: int, ts: float) -> None:
        with self._report_lock:
            if ts - self.last_reported.get(employee_id, 0) < settings.REPORT_COOLDOWN_SEC:
                return
            self.last_reported[employee_id] = ts
        entry = {
            "employeeId": employee_id,
            "fullName": self.gallery.names.get(employee_id, ""),
            "similarity": round(similarity, 3),
            "cameraId": camera_id,
            "channelNo": channel_no,
            "seenAt": _iso(ts),
        }
        try:
            result = self.client.report_recognition(
                {k: entry[k] for k in ("employeeId", "cameraId", "channelNo", "similarity", "seenAt")}
            )
            entry["action"] = result.get("action")
            log.info("[recognition] %s (%.2f) -> %s", entry["fullName"], similarity, entry["action"])
        except Exception as exc:
            entry["action"] = "REPORT_FAILED"
            entry["error"] = str(exc)
            with self._report_lock:
                self.last_reported.pop(employee_id, None)  # retry on next confirmation
            log.warning("[recognition] could not report %s: %s", employee_id, exc)
        self.recent.appendleft(entry)

    def status(self) -> dict:
        return {
            "running": not self._stop.is_set(),
            "galleryEmployees": len({*self.gallery.employee_ids}),
            "galleryEmbeddings": len(self.gallery),
            "galleryLoadedAt": self.gallery_loaded_at,
            "lastError": self.last_error,
            "sourceOverride": bool(settings.SOURCE_OVERRIDE),
            "settings": {
                "frameSource": settings.FRAME_SOURCE,
                "matchThreshold": settings.MATCH_THRESHOLD,
                "confirmFrames": settings.CONFIRM_FRAMES,
                "confirmWindowSec": settings.CONFIRM_WINDOW_SEC,
            },
            "channels": [dict(w.state) for w in self.workers.values()],
            "recent": list(self.recent),
        }
