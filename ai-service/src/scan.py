"""Enrol from the office camera: live face scanning with a strict "full view" gate.

The dashboard polls `scan_lens()` for a lens; every face in the latest frame comes back with where it is,
whether it is a full, clear view, and if not, why. When the operator's chosen face is a full view, the
dashboard asks `capture()` for exactly that face from exactly that frame (by scan id + index), which returns
its embedding (to the backend only) and a small crop for the operator to review.

A face only counts as a full view when every check passes:
  big enough, confidently detected, sharp, well lit, facing the camera (not turned or tilted far),
  and entirely inside the picture.
"""

import base64
import itertools
import threading
import time
from collections import deque
from typing import Optional

import cv2
import numpy as np

from face_engine import DetectedFace, Gallery

# Full-view thresholds (stricter than recognition: these become the reference samples).
MIN_FACE_PX = 60  # shorter side of the face box, in frame pixels
MIN_EYE_PX = 24  # distance between the eyes
MIN_DETECTION = 0.80
MIN_SHARPNESS = 35.0  # variance of the Laplacian on the face crop
MIN_BRIGHTNESS, MAX_BRIGHTNESS = 55.0, 225.0
YAW_RANGE = (0.45, 2.2)  # nose-to-eye distance ratio; outside = turned too far
PITCH_RANGE = (0.20, 0.88)  # nose position between eyes and mouth; outside = looking far up/down
EDGE_MARGIN_PX = 4

ISSUE_TEXT = {
    "TOO_FAR": "Too small: too far from the camera",
    "UNCLEAR": "Face not clear enough",
    "BLURRY": "Blurry (moving)",
    "TOO_DARK": "Too dark",
    "TOO_BRIGHT": "Too bright",
    "TURNED_AWAY": "Turned away from the camera",
    "TILTED": "Looking too far up or down",
    "CUT_OFF": "Partly outside the picture",
}

PREVIEW_MAX_W = 960
CACHE_PER_LENS = 6  # recent scans kept so a capture refers to the exact frame the operator saw

_ids = itertools.count(1)
_lock = threading.Lock()
_cache: dict[tuple[str, int], deque] = {}


def _pose(face: DetectedFace) -> tuple[str, float, float]:
    """(label, yaw ratio, pitch ratio) from the 5 landmarks."""
    (rx, ry), (lx, ly), (nx, ny), (mrx, mry), (mlx, mly) = face.landmarks
    yaw = abs(nx - rx) / (abs(lx - nx) + 1e-5)
    eye_y, mouth_y = (ry + ly) / 2.0, (mry + mly) / 2.0
    pitch = (ny - eye_y) / (mouth_y - eye_y + 1e-5)
    if pitch > 0.72:
        label = "DOWN"
    elif yaw < 0.7:
        label = "LEFT"
    elif yaw > 1.45:
        label = "RIGHT"
    else:
        label = "FRONT"
    return label, yaw, pitch


def full_view_issues(face: DetectedFace, frame_w: int, frame_h: int) -> list[str]:
    x, y, w, h = face.box
    issues: list[str] = []
    eye_px = float(np.hypot(face.landmarks[0][0] - face.landmarks[1][0], face.landmarks[0][1] - face.landmarks[1][1])) if face.landmarks else 0.0
    if min(w, h) < MIN_FACE_PX or face.rejection_reason == "FACE_TOO_SMALL":
        issues.append("TOO_FAR")
    elif eye_px < MIN_EYE_PX:
        issues.append("TURNED_AWAY")  # a big face with the eyes close together is turned sideways
    if face.score < MIN_DETECTION or face.rejection_reason in ("LOW_DETECTION_CONFIDENCE", "ABNORMAL_ASPECT_RATIO"):
        issues.append("UNCLEAR")
    if face.sharpness < MIN_SHARPNESS:
        issues.append("BLURRY")
    if face.brightness < MIN_BRIGHTNESS:
        issues.append("TOO_DARK")
    elif face.brightness > MAX_BRIGHTNESS:
        issues.append("TOO_BRIGHT")
    if face.landmarks:
        _, yaw, pitch = _pose(face)
        if not YAW_RANGE[0] <= yaw <= YAW_RANGE[1] and "TURNED_AWAY" not in issues:
            issues.append("TURNED_AWAY")
        if not PITCH_RANGE[0] <= pitch <= PITCH_RANGE[1]:
            issues.append("TILTED")
    m = EDGE_MARGIN_PX
    inside = lambda px, py: x - 1 <= px <= x + w + 1 and y - 1 <= py <= y + h + 1  # noqa: E731
    if (
        x < m or y < m or x + w > frame_w - m or y + h > frame_h - m
        or face.rejection_reason == "CROP_OUT_OF_BOUNDS"
        or (face.landmarks and not all(inside(px, py) for px, py in face.landmarks))
    ):
        issues.append("CUT_OFF")
    if not issues and (not face.is_valid or face.embedding is None):
        issues.append("UNCLEAR")
    return issues


def _employee_scores(gallery: Gallery, embedding: np.ndarray, top: int = 3) -> list[dict]:
    if embedding is None or not len(gallery):
        return []
    sims = gallery.matrix @ embedding
    best: dict[str, float] = {}
    for i, emp in enumerate(gallery.employee_ids):
        best[emp] = max(best.get(emp, -1.0), float(sims[i]))
    ranked = sorted(best.items(), key=lambda kv: kv[1], reverse=True)[:top]
    return [{"employeeId": e, "name": gallery.names.get(e, ""), "similarity": round(s, 3)} for e, s in ranked]


def _jpeg_b64(img: np.ndarray, quality: int = 72) -> str:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf.tobytes()).decode() if ok else ""


def scan_lens(engine, gallery: Gallery, camera_id: str, channel_no: int, frame: np.ndarray) -> dict:
    """Analyse one frame for the scanner. Returns the picture (downscaled JPEG) and every face's full-view verdict."""
    h, w = frame.shape[:2]
    faces = engine.analyze(frame)
    scan_id = f"{int(time.time())}-{next(_ids)}"
    with _lock:
        _cache.setdefault((camera_id, channel_no), deque(maxlen=CACHE_PER_LENS)).append((scan_id, frame, faces, time.time()))

    scale = min(1.0, PREVIEW_MAX_W / w)
    preview = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale < 1.0 else frame
    out = []
    for i, f in enumerate(faces):
        x, y, fw, fh = f.box
        issues = full_view_issues(f, w, h)
        pose = _pose(f)[0] if f.landmarks else None
        scores = _employee_scores(gallery, f.embedding, top=1)
        out.append(
            {
                "index": i,
                "box": [round(x / w, 4), round(y / h, 4), round(fw / w, 4), round(fh / h, 4)],
                "fullView": not issues,
                "issues": [{"code": c, "text": ISSUE_TEXT[c]} for c in issues],
                "pose": pose,
                "qualityScore": f.quality_score,
                "metrics": {"sizePx": int(min(fw, fh)), "brightness": f.brightness, "sharpness": f.sharpness, "detection": round(f.score, 2)},
                "looksLike": scores[0] if scores else None,
            }
        )
    return {
        "scanId": scan_id,
        "cameraId": camera_id,
        "channelNo": channel_no,
        "width": w,
        "height": h,
        "image": "data:image/jpeg;base64," + _jpeg_b64(preview),
        "faces": out,
        "at": time.time(),
    }


def capture(gallery: Gallery, camera_id: str, channel_no: int, scan_id: str, index: int) -> Optional[dict]:
    """The exact face the operator saw. None if that scan has expired; raises ValueError if it isn't a full view."""
    with _lock:
        entry = next((e for e in _cache.get((camera_id, channel_no), ()) if e[0] == scan_id), None)
    if entry is None:
        return None
    _, frame, faces, _ = entry
    if not 0 <= index < len(faces):
        raise ValueError("No such face in that picture")
    face = faces[index]
    h, w = frame.shape[:2]
    issues = full_view_issues(face, w, h)
    if issues:
        raise ValueError(", ".join(ISSUE_TEXT[c] for c in issues))

    x, y, fw, fh = face.box
    pad = int(0.35 * max(fw, fh))
    crop = frame[max(0, y - pad) : min(h, y + fh + pad), max(0, x - pad) : min(w, x + fw + pad)]
    if crop.shape[0] > 240:
        s = 240 / crop.shape[0]
        crop = cv2.resize(crop, (int(crop.shape[1] * s), 240))
    return {
        "embedding": [round(float(v), 6) for v in face.embedding],
        "crop": "data:image/jpeg;base64," + _jpeg_b64(crop, 85),
        "pose": _pose(face)[0],
        "qualityScore": face.quality_score,
        "faceSizePx": int(min(fw, fh)),
        "matches": _employee_scores(gallery, face.embedding, top=3),
    }
