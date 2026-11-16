"""Face detection (YuNet) + face embeddings (SFace), both from OpenCV's model zoo.

Runs on CPU with only opencv + numpy. Embeddings are 128-d, L2-normalised float vectors;
two faces are the same person when their cosine similarity is above ~0.36 (OpenCV's
reference threshold). We default to a stricter value; see settings.MATCH_THRESHOLD.
"""

import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
DETECTOR_MODEL = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
RECOGNIZER_MODEL = MODELS_DIR / "face_recognition_sface_2021dec.onnx"


class FaceEngineError(Exception):
    pass


@dataclass
class DetectedFace:
    box: tuple[int, int, int, int]  # x, y, w, h in pixels
    score: float  # detector confidence
    embedding: np.ndarray  # (128,) float32, L2-normalised


class FaceEngine:
    def __init__(self, min_face_size: int = 60, detect_threshold: float = 0.85):
        for p in (DETECTOR_MODEL, RECOGNIZER_MODEL):
            if not p.exists():
                raise FaceEngineError(f"Model file missing: {p}. Run: python download_models.py")
        self.min_face_size = min_face_size
        self._detector = cv2.FaceDetectorYN.create(str(DETECTOR_MODEL), "", (320, 320), detect_threshold, 0.3, 5000)
        self._recognizer = cv2.FaceRecognizerSF.create(str(RECOGNIZER_MODEL), "")
        # OpenCV DNN objects are not thread-safe; the API and the worker share one engine.
        self._lock = threading.Lock()

    def analyze(self, image: np.ndarray, max_side: int = 1280) -> list[DetectedFace]:
        """Detect every face in a BGR image and compute its embedding."""
        if image is None or image.size == 0:
            raise FaceEngineError("Empty image")

        scale = 1.0
        h, w = image.shape[:2]
        if max(h, w) > max_side:
            scale = max_side / max(h, w)
            image = cv2.resize(image, (int(w * scale), int(h * scale)))
            h, w = image.shape[:2]

        with self._lock:
            self._detector.setInputSize((w, h))
            _, faces = self._detector.detect(image)
            results: list[DetectedFace] = []
            if faces is None:
                return results
            for row in faces:
                x, y, fw, fh = row[:4]
                if min(fw, fh) < self.min_face_size * scale:
                    continue  # too small / far away to recognise reliably
                aligned = self._recognizer.alignCrop(image, row)
                feat = self._recognizer.feature(aligned).flatten().astype(np.float32)
                feat /= np.linalg.norm(feat) + 1e-9
                box = tuple(int(v / scale) for v in (x, y, fw, fh))
                results.append(DetectedFace(box=box, score=float(row[-1]), embedding=feat))
        return results

    def embed_single(self, image: np.ndarray) -> np.ndarray:
        """Embedding for an enrolment photo, which must contain exactly one clear face."""
        faces = self.analyze(image)
        if not faces:
            raise FaceEngineError("No face found. Use a clear, front-facing photo with good lighting.")
        if len(faces) > 1:
            # Allow group-ish photos only if one face clearly dominates.
            faces.sort(key=lambda f: f.box[2] * f.box[3], reverse=True)
            a0 = faces[0].box[2] * faces[0].box[3]
            a1 = faces[1].box[2] * faces[1].box[3]
            if a1 > 0.5 * a0:
                raise FaceEngineError("More than one face found. The photo must show only the employee.")
        return faces[0].embedding


def decode_image(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise FaceEngineError("Could not read image. Upload a JPEG or PNG.")
    return img


class Gallery:
    """In-memory matrix of enrolled embeddings for fast nearest-neighbour matching."""

    def __init__(self) -> None:
        self.employee_ids: list[str] = []
        self.names: dict[str, str] = {}
        self.matrix = np.zeros((0, 128), dtype=np.float32)

    def load(self, entries: list[dict]) -> None:
        ids, vecs, names = [], [], {}
        for e in entries:
            v = np.asarray(e["embedding"], dtype=np.float32)
            if v.shape != (128,):
                continue
            ids.append(e["employeeId"])
            vecs.append(v / (np.linalg.norm(v) + 1e-9))
            names[e["employeeId"]] = e.get("fullName", "")
        self.employee_ids = ids
        self.names = names
        self.matrix = np.vstack(vecs) if vecs else np.zeros((0, 128), dtype=np.float32)

    def __len__(self) -> int:
        return len(self.employee_ids)

    def match(self, embedding: np.ndarray, threshold: float, margin: float) -> tuple[str | None, float]:
        """Best-matching employee, or None if below threshold or too close to a different employee."""
        if not len(self):
            return None, 0.0
        sims = self.matrix @ embedding
        best_idx = int(np.argmax(sims))
        best_id, best_sim = self.employee_ids[best_idx], float(sims[best_idx])
        if best_sim < threshold:
            return None, best_sim
        # Ambiguity guard: the runner-up from a *different* employee must be clearly worse.
        others = [float(s) for i, s in enumerate(sims) if self.employee_ids[i] != best_id]
        if others and best_sim - max(others) < margin:
            return None, best_sim
        return best_id, best_sim
