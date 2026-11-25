"""Background auto-attendance worker.

One thread per watched camera channel: pull a frame -> detect faces -> match against the
enrolled gallery -> once an employee is matched in CONFIRM_FRAMES frames within
CONFIRM_WINDOW_SEC, report them to the backend, which marks attendance.

Frames are processed in memory only; nothing is written to disk.
"""

import logging
import re
import threading
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from backend_client import BackendClient
from config import settings
from face_engine import FaceEngine, Gallery
from camera_io import mask, open_spec
from sources import FrameSource, HLSSource, SnapshotSource, open_override_source
from yolo_detector import YOLOPersonDetector
from camera_motion import CameraMotionEstimator
from tracking_engine import ZoneTrackingEngine

log = logging.getLogger("ai.worker")


def _eye_distance(face) -> Optional[float]:
    """Pixels between the two eye landmarks: a robust measure of how much face detail we have."""
    if len(face.landmarks) < 2:
        return None
    (rx, ry), (lx, ly) = face.landmarks[0], face.landmarks[1]
    return ((lx - rx) ** 2 + (ly - ry) ** 2) ** 0.5


# Recognition settings that can change while running. Defaults come from ai-service/.env; the dashboard's
# Settings page overrides them (fetched from the backend every RUNTIME_CONFIG_REFRESH_SEC).
TUNABLE_TYPES = {
    "matchThreshold": float,
    "matchMargin": float,
    "smallFaceEyePx": float,
    "smallFaceMatchThreshold": float,
    "confirmFrames": int,
    "confirmWindowSec": float,
    "reportCooldownSec": float,
    "minFaceSize": int,
    "frameSource": str,
}


def env_tunables() -> dict:
    return {
        "matchThreshold": settings.MATCH_THRESHOLD,
        "matchMargin": settings.MATCH_MARGIN,
        "smallFaceEyePx": settings.SMALL_FACE_EYE_PX,
        "smallFaceMatchThreshold": settings.SMALL_FACE_MATCH_THRESHOLD,
        "confirmFrames": settings.CONFIRM_FRAMES,
        "confirmWindowSec": settings.CONFIRM_WINDOW_SEC,
        "reportCooldownSec": settings.REPORT_COOLDOWN_SEC,
        "minFaceSize": settings.MIN_FACE_SIZE,
        "frameSource": settings.FRAME_SOURCE,
    }


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


_PAN_TILT_NAME = re.compile(r"pan[\s_-]*tilt|\bptz?\b", re.IGNORECASE)


def _is_pan_tilt(lens_name: str) -> bool:
    """Lens names like "Hashnate -PT (Pan-Tilt Lens)" or "Front PTZ"."""
    return bool(_PAN_TILT_NAME.search(lens_name or ""))


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
        self.tracking_engine: Optional[ZoneTrackingEngine] = None
        self.yolo_detector: Optional[YOLOPersonDetector] = None
        self.frame_id = 0
        self.last_track_sync = 0.0
        self.fps_times: deque = deque(maxlen=20)
        self.current_fps: float = 0.0
        # Where this lens's video comes from (EZVIZ cloud, RTSP, HTTP or USB) and a key that changes with it.
        self.spec: dict = next(
            (ch.get("source") or {} for ch in camera.get("channels", []) if ch.get("channelNo") == channel_no), {}
        ) or {"type": "ezviz"}
        self.source_key = self.spec.get("key")
        # Latest frame, for the dashboard's live preview of cameras a browser can't play (RTSP, USB, ...).
        self.last_frame = None
        self.last_frame_at = 0.0

        # Body tracking on every lens: a recognised person keeps their identity while the face is turned away
        # or they move seats, and the backend counts that tracked time as "inside".
        self.camera_motion = CameraMotionEstimator()  # pan / tilt lenses move on their own (auto-tracking)
        try:
            # Weak detections (0.15-0.30: people half hidden behind a monitor) reach the tracker, which only uses them
            # to keep existing tracks alive; new tracks still need a confident (>= 0.30) detection.
            self.yolo_detector = YOLOPersonDetector(conf_threshold=0.15, iou_threshold=0.45)
            self.tracking_engine = ZoneTrackingEngine(width=1920, height=1080)
            lens_name = next(
                (ch.get("channelName") or "" for ch in camera.get("channels", []) if ch.get("channelNo") == channel_no), ""
            )
            if _is_pan_tilt(lens_name):
                # The picture moves with the lens, so "same spot" hand-overs gave names to the wrong people (25 Nov).
                self.tracking_engine.handoff_enabled = False
                log.info("[%s] %s is a pan-tilt lens: no same-spot name hand-over", self.name, lens_name)
            self._sync_zones()
        except Exception as e:
            log.warning("[%s] Could not initialize YOLO person tracking: %s", self.name, e)

        self.state = {
            "cameraId": camera["id"],
            "cameraName": camera.get("name"),
            "channelNo": channel_no,
            "source": None,
            "state": "starting",
            "lastFrameAt": None,
            "framesProcessed": 0,
            "facesDetected": 0,
            "fps": 0.0,
            "lastError": None,
        }

    def _sync_zones(self) -> None:
        if not self.tracking_engine:
            return
        try:
            cfg = self.m.client.zone_config(self.camera["id"], self.channel_no)
            zones = cfg.get("zones", [])
            lines = cfg.get("lines", [])
            self.tracking_engine.set_config(zones, lines)
            log.info("[%s] Synchronized %d office zones and %d crossing lines", self.name, len(zones), len(lines))
        except Exception as e:
            log.warning("[%s] Failed to sync zones: %s", self.name, e)

    # -------------------------------------------------------------- sources

    def _open_source(self) -> FrameSource:
        if settings.SOURCE_OVERRIDE:
            return open_override_source(settings.SOURCE_OVERRIDE)
        if self.spec.get("type", "ezviz") != "ezviz":
            return open_spec(self.spec)  # RTSP / HTTP / USB
        mode = self.m.cfg["frameSource"]
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
                elif not settings.SOURCE_OVERRIDE and (
                    (
                        self.source.kind == "snapshot"
                        and self.m.cfg["frameSource"] == "auto"
                        and time.time() >= self.hls_disabled_until
                    )
                    # Frame source changed in Settings.
                    or (self.source.kind == "snapshot" and self.m.cfg["frameSource"] == "hls")
                    or (self.source.kind == "hls" and self.m.cfg["frameSource"] == "snapshot")
                ):
                    self._close_source()
                    continue

                started = time.time()
                frame = self.source.read()
                if frame is not None:
                    self._process(frame)
                self.stop_event.wait(max(0.0, self.source.interval - (time.time() - started)))
            except Exception as exc:
                msg = mask(str(exc))
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
        cfg = self.m.cfg  # one consistent set of settings for this frame
        self.last_frame, self.last_frame_at = frame, time.time()
        self.frame_id += 1
        now = time.time()
        self.fps_times.append(now)
        if len(self.fps_times) >= 2:
            dt = self.fps_times[-1] - self.fps_times[0]
            self.current_fps = round((len(self.fps_times) - 1) / dt, 1) if dt > 0 else 0.0
        self.state["fps"] = self.current_fps
        self.state["framesProcessed"] += 1
        self.state["lastFrameAt"] = _iso(now)

        # 1. Face recognition analysis (every frame on every lens, so body tracks get named quickly)
        face_matches = []
        pending_matches = []  # (face_id, employee_id, similarity): reported after the body-tracking check below
        blocked_faces: set = set()  # faces on a body already locked to a different employee
        faces = self.m.engine.analyze(frame)
        self.state["facesDetected"] += len(faces)
        for face in faces:
            if not face.is_valid or face.embedding is None:
                continue  # Skip degraded/rejected face crop from identity assignment

            # Small (distant / partial) faces need a stronger match: they caused false identifications.
            eye_px = _eye_distance(face)
            threshold = cfg["matchThreshold"]
            if eye_px is not None and eye_px < cfg["smallFaceEyePx"]:
                threshold = max(threshold, cfg["smallFaceMatchThreshold"])
            match_res = self.m.gallery.match_diagnostic(
                face.embedding, threshold=threshold, margin=cfg["matchMargin"]
            )

            face_matches.append((
                face.box,
                match_res.employee_id,
                match_res.employee_name or "",
                match_res.similarity,
                face.face_id,
                {
                    "qualityScore": face.quality_score,
                    "sharpness": face.sharpness,
                    "brightness": face.brightness,
                    "isAmbiguous": match_res.is_ambiguous,
                    "margin": match_res.margin,
                    "runnerUpSimilarity": match_res.runner_up_similarity,
                    "rejectionReason": match_res.rejection_reason,
                    "eyeDistancePx": round(eye_px, 1) if eye_px is not None else None,
                    "thresholdUsed": threshold,
                }
            ))

            if match_res.is_match and match_res.employee_id:
                pending_matches.append((face.face_id, match_res.employee_id, match_res.similarity))

        # 2. Multi-person tracking & doorway crossing
        if self.tracking_engine and self.yolo_detector:
            if now - self.last_track_sync > 60.0:
                self._sync_zones()
                self.last_track_sync = now

            h, w = frame.shape[:2]
            if self.tracking_engine.width != w or self.tracking_engine.height != h:
                self.tracking_engine.width = w
                self.tracking_engine.height = h

            try:
                dets = self.yolo_detector.infer(frame)
                motion = self.camera_motion.estimate(frame, dets)
                if motion is not None:
                    self.state["cameraMovedAt"] = _iso(now)
                tracks, removed_tracks, events, diagnostics = self.tracking_engine.evaluate(
                    dets, face_matches, now, return_diagnostics=True, frame=frame, camera_motion=motion
                )
                # A face that matched employee B on a body already locked to employee A is a misidentification
                # (e.g. A mid-turn): don't log it as a sighting of B.
                blocked_faces = {
                    d.get("faceId") for d in diagnostics if str(d.get("note", "")).startswith("Protected")
                }

                # Prepare single atomic frame batch payload
                tracks_data = [
                    {
                        "id": f"{self.camera['id']}-ch{self.channel_no}-{tr.track_id}",
                        "cameraId": self.camera["id"],
                        "channelNo": self.channel_no,
                        "trackId": tr.track_id,
                        "employeeId": tr.employee_id,
                        "employeeName": tr.employee_name or "Unidentified Person",
                        "employeeCode": getattr(tr, "employee_code", None),
                        "startedAt": _iso(tr.started_at),
                        "lastSeenAt": _iso(tr.last_seen),
                        "identityVerificationStatus": tr.identity_status,
                        "currentZoneId": tr.current_zone_id or "PASSAGE",
                        "boundingBox": [
                            round(float(v) / (w if i % 2 == 0 else h), 4)
                            for i, v in enumerate(tr.bbox)
                        ],
                        "detectionScore": round(float(tr.score), 2),
                        "freshnessSec": round(max(0.0, now - tr.last_seen), 1),
                        "faceId": getattr(tr, "face_id", None),
                        "faceQuality": getattr(tr, "face_quality", 0.0),
                        # v2.9 — ILE extended fields
                        "identityState": getattr(tr, "identity_state", tr.identity_status),
                        "faceVisible": getattr(tr, "face_currently_visible", False),
                        "trackingWithoutFaceSec": round(getattr(tr, "tracking_without_face_sec", 0.0), 1),
                    }
                    for tr in tracks
                ]

                verified_cnt = len([
                    t for t in tracks
                    if t.identity_status in ("VERIFIED", "TRACKING_WITHOUT_FACE", "IDENTITY_LATCHED")
                ])
                unidentified_cnt = len(tracks) - verified_cnt

                frame_payload = {
                    "cameraId": self.camera["id"],
                    "channelNo": self.channel_no,
                    "frameId": self.frame_id,
                    "frameTimestamp": _iso(now),
                    "processingTimestamp": _iso(time.time()),
                    "fps": self.current_fps,
                    "metrics": {
                        "detectedPeople": len(dets),
                        "activeTracks": len(tracks),
                        "verifiedTracks": verified_cnt,
                        "unidentifiedTracks": unidentified_cnt,
                        "fps": self.current_fps,
                    },
                    "tracks": tracks_data,
                    "doorwayEvents": events,
                    "endedTrackIds": [r.track_id for r in removed_tracks],
                    "diagnostics": diagnostics,
                }

                # Single atomic POST request to backend
                self.m.client.report_tracking_frame(frame_payload)

                for ev in events:
                    log.info(
                        "[tracking] DOORWAY EVENT: %s -> %s (Emp: %s / %s)",
                        ev.get("crossingLineId"),
                        ev.get("eventType"),
                        ev.get("employeeName"),
                        ev.get("employeeId"),
                    )

            except Exception as e:
                log.warning("[tracking] tracking evaluation failed: %s", e)

        # 3. Confirmed face matches become sightings (unless the body tracker vetoed them above)
        for face_id, employee_id, similarity in pending_matches:
            if face_id in blocked_faces:
                log.info("[recognition] ignored %s match (%.2f): face is on a body locked to another employee",
                         self.m.gallery.names.get(employee_id, employee_id), similarity)
                continue
            hits = self.matches[employee_id]
            hits.append((now, similarity))
            while hits and now - hits[0][0] > cfg["confirmWindowSec"]:
                hits.popleft()
            if len(hits) >= cfg["confirmFrames"]:
                best = max(s for _, s in hits)
                hits.clear()
                self.m.report(employee_id, best, self.camera["id"], self.channel_no, now)

    def stop(self) -> None:
        self.stop_event.set()


def _source_key(camera: dict, channel_no: int) -> Optional[str]:
    ch = next((c for c in camera.get("channels", []) if c.get("channelNo") == channel_no), None)
    return ((ch or {}).get("source") or {}).get("key")


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
        # Replaced as a whole (never mutated), so a worker always sees one consistent set.
        self.cfg: dict = env_tunables()
        self.cfg_source = ".env"
        self.cfg_loaded_at: Optional[str] = None
        self._thread = threading.Thread(target=self._supervise, daemon=True, name="recognition-supervisor")

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        for w in self.workers.values():
            w.stop()

    # -------------------------------------------------------------- supervision

    def _watched_channels(self, camera: dict) -> list[int]:
        channels = camera.get("channels") or []
        if not channels:
            return [1]
        # Lenses with face recognition switched off in Settings are not watched.
        chans = [c["channelNo"] for c in channels if c.get("recognitionEnabled", True)]
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

    def _refresh_config(self) -> None:
        """Pull recognition settings saved in the dashboard; keep the current ones if the backend can't say."""
        try:
            remote = (self.client.runtime_config() or {}).get("recognition") or {}
        except Exception as exc:
            log.debug("[config] runtime config unavailable: %s", exc)
            return
        new = dict(self.cfg)
        for key, cast in TUNABLE_TYPES.items():
            if remote.get(key) is not None:
                try:
                    new[key] = cast(remote[key])
                except (TypeError, ValueError):
                    log.warning("[config] ignoring invalid %s=%r", key, remote[key])
        if new["frameSource"] not in ("auto", "hls", "snapshot"):
            new["frameSource"] = self.cfg["frameSource"]
        changed = {k: v for k, v in new.items() if self.cfg.get(k) != v}
        if changed:
            log.info("[config] recognition settings from the dashboard: %s", changed)
        self.engine.min_face_size = int(new["minFaceSize"])
        self.cfg = new
        self.cfg_source = "dashboard"
        self.cfg_loaded_at = _iso(time.time())

    def _supervise(self) -> None:
        next_gallery = next_cameras = next_config = 0.0
        while not self._stop.is_set():
            now = time.time()
            if now >= next_config:
                self._refresh_config()
                next_config = now + settings.RUNTIME_CONFIG_REFRESH_SEC
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
            w = self.workers[key]
            if key not in wanted or not w.is_alive() or w.source_key != _source_key(*wanted[key]):
                # Gone, crashed, or its address / login changed in Settings: (re)start it.
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
            if ts - self.last_reported.get(employee_id, 0) < self.cfg["reportCooldownSec"]:
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
        # System A: Report observational presence evidence (does not touch official attendance)
        try:
            self.client.report_observation({
                "eventId": str(uuid.uuid4()),
                "employeeId": employee_id,
                "cameraId": camera_id,
                "channelNo": channel_no,
                "similarityScore": round(similarity, 3),
                "observedAt": _iso(ts),
                "isUnknown": False,
            })
        except Exception as exc:
            log.warning("[presence] could not report observation for %s: %s", employee_id, exc)

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

    def latest_frame(self, camera_id: str, channel_no: int, max_age: float = 10.0):
        w = self.workers.get((camera_id, channel_no))
        if w is None or w.last_frame is None or time.time() - w.last_frame_at > max_age:
            return None
        return w.last_frame

    def status(self) -> dict:
        return {
            "running": not self._stop.is_set(),
            "galleryEmployees": len({*self.gallery.employee_ids}),
            "galleryEmbeddings": len(self.gallery),
            "galleryLoadedAt": self.gallery_loaded_at,
            "lastError": self.last_error,
            "sourceOverride": bool(settings.SOURCE_OVERRIDE),
            "settings": dict(self.cfg),
            "settingsSource": self.cfg_source,
            "settingsLoadedAt": self.cfg_loaded_at,
            "channels": [dict(w.state) for w in self.workers.values()],
            "recent": list(self.recent),
        }
