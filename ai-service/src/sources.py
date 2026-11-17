"""Frame sources. Each returns the most recent frame (BGR ndarray) or None."""

import logging
import threading
import time
from collections import deque
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from backend_client import BackendClient
from config import settings
from face_engine import decode_image

log = logging.getLogger("ai.sources")


class FrameSource:
    kind = "base"
    interval = settings.FRAME_INTERVAL_SEC

    def read(self) -> Optional[np.ndarray]:
        raise NotImplementedError

    def close(self) -> None:
        pass


class LatestFrameCapture(FrameSource):
    """Wraps cv2.VideoCapture with a reader thread that decodes continuously.

    Live HLS arrives in bursts (a few seconds of video per segment), so instead of keeping
    only the newest frame we keep frames spaced FRAME_INTERVAL_SEC apart *in video time*
    and hand them out in order. That gives an even ~2 frames per second of footage
    regardless of how the stream is chunked, and the bounded queue keeps us near real time.
    """

    interval = 0.05  # poll the queue often; pacing happens in the reader thread

    def __init__(self, target, kind: str):
        self.kind = kind
        self._target = target
        self._queue: deque = deque(maxlen=max(4, int(8 / settings.FRAME_INTERVAL_SEC)))
        self._frame_at = 0.0
        self._last_kept = -1e9
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.failed = False
        self._cap = cv2.VideoCapture(target, cv2.CAP_FFMPEG) if isinstance(target, str) else cv2.VideoCapture(target)
        if not self._cap.isOpened():
            self.failed = True
            raise RuntimeError(f"Could not open video source ({kind})")
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        misses = 0
        while not self._stop.is_set():
            try:
                ok, frame = self._cap.read()
            except Exception as exc:
                misses += 1
                if misses > 20:
                    self.failed = True
                    return
                time.sleep(0.2)
                continue

            if not ok:
                misses += 1
                if misses > 50:
                    self.failed = True
                    return
                time.sleep(0.1)
                continue
            misses = 0
            pos = self._cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            stamp = pos if pos > 0 else time.time()
            if stamp < self._last_kept:  # stream restarted its clock
                self._last_kept = -1e9
            if stamp - self._last_kept < settings.FRAME_INTERVAL_SEC:
                continue
            self._last_kept = stamp
            with self._lock:
                self._queue.append(frame)
                self._frame_at = time.time()

    def read(self) -> Optional[np.ndarray]:
        if self.failed:
            raise RuntimeError(f"{self.kind} stream ended or stalled")
        with self._lock:
            if not self._queue:
                return None
            if time.time() - self._frame_at > 15:
                self._queue.clear()
                return None
            return self._queue.popleft()

    def close(self) -> None:
        self._stop.set()
        self._cap.release()


class HLSSource(LatestFrameCapture):
    """EZVIZ live HLS stream; the signed URL is refreshed periodically."""

    def __init__(self, client: BackendClient, camera_id: str, channel_no: int):
        url = client.stream_url(camera_id, channel_no)
        self.opened_at = time.time()
        super().__init__(url, "hls")

    def read(self) -> Optional[np.ndarray]:
        if time.time() - self.opened_at > settings.STREAM_URL_REFRESH_SEC:
            raise RuntimeError("stream URL refresh due")
        return super().read()


class SnapshotSource(FrameSource):
    """EZVIZ device capture API: one still image per call (slow, but robust)."""

    kind = "snapshot"
    interval = settings.SNAPSHOT_INTERVAL_SEC

    def __init__(self, client: BackendClient, camera_id: str, channel_no: int):
        self._client, self._camera_id, self._channel_no = client, camera_id, channel_no

    def read(self) -> Optional[np.ndarray]:
        return decode_image(self._client.snapshot_bytes(self._camera_id, self._channel_no))


class FolderSource(FrameSource):
    """Cycles through the images in a folder (for testing without a camera)."""

    kind = "folder"

    def __init__(self, folder: str):
        exts = {".jpg", ".jpeg", ".png", ".bmp"}
        self._files = sorted(p for p in Path(folder).iterdir() if p.suffix.lower() in exts)
        if not self._files:
            raise RuntimeError(f"No images in {folder}")
        self._i = 0

    def read(self) -> Optional[np.ndarray]:
        path = self._files[self._i % len(self._files)]
        self._i += 1
        return cv2.imread(str(path))


class VideoFileSource(FrameSource):
    """Plays a video file at real-time pace, looping at the end (for testing)."""

    kind = "file"

    def __init__(self, path: str):
        self._cap = cv2.VideoCapture(path)
        if not self._cap.isOpened():
            raise RuntimeError(f"Could not open video file {path}")
        fps = self._cap.get(cv2.CAP_PROP_FPS) or 25
        self._skip = max(0, int(fps * self.interval) - 1)

    def read(self) -> Optional[np.ndarray]:
        for _ in range(self._skip):
            self._cap.grab()
        ok, frame = self._cap.read()
        if not ok:
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self._cap.read()
        return frame if ok else None

    def close(self) -> None:
        self._cap.release()


def open_override_source(spec: str) -> FrameSource:
    if spec.startswith("webcam:"):
        return LatestFrameCapture(int(spec.split(":", 1)[1]), "webcam")
    if Path(spec).is_dir():
        return FolderSource(spec)
    return VideoFileSource(spec)
