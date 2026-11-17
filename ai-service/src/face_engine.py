"""Face detection (YuNet) + face embeddings (SFace), both from OpenCV's model zoo.

Runs on CPU with only opencv + numpy. Embeddings are 128-d, L2-normalised float vectors;
two faces are the same person when their cosine similarity is above ~0.36 (OpenCV's
reference threshold). We default to a stricter value; see settings.MATCH_THRESHOLD.
"""

import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, List, Tuple, Dict

import cv2
import numpy as np

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
DETECTOR_MODEL = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
RECOGNIZER_MODEL = MODELS_DIR / "face_recognition_sface_2021dec.onnx"


class FaceEngineError(Exception):
    pass


@dataclass
class DetectedFace:
    face_id: str
    box: tuple[int, int, int, int]  # x, y, w, h in pixels
    score: float  # detector confidence
    landmarks: list[tuple[float, float]] = field(default_factory=list)
    quality_score: float = 0.0
    brightness: float = 0.0
    sharpness: float = 0.0
    is_valid: bool = True
    rejection_reason: Optional[str] = None
    embedding: Optional[np.ndarray] = None  # (128,) float32, L2-normalised


class FaceEngine:
    def __init__(self, min_face_size: int = 50, detect_threshold: float = 0.70):
        for p in (DETECTOR_MODEL, RECOGNIZER_MODEL):
            if not p.exists():
                raise FaceEngineError(f"Model file missing: {p}. Run: python download_models.py")
        self.min_face_size = min_face_size
        self._detector = cv2.FaceDetectorYN.create(str(DETECTOR_MODEL), "", (320, 320), detect_threshold, 0.3, 5000)
        self._recognizer = cv2.FaceRecognizerSF.create(str(RECOGNIZER_MODEL), "")
        # OpenCV DNN objects are not thread-safe; the API and the worker share one engine.
        self._lock = threading.Lock()

    def analyze(self, image: np.ndarray, max_side: int = 1280) -> list[DetectedFace]:
        """Detect faces using YuNet, evaluate crop quality, and compute embeddings for valid faces."""
        if image is None or image.size == 0:
            raise FaceEngineError("Empty image")

        scale = 1.0
        h, w = image.shape[:2]
        if max(h, w) > max_side:
            scale = max_side / max(h, w)
            image_scaled = cv2.resize(image, (int(w * scale), int(h * scale)))
            sh, sw = image_scaled.shape[:2]
        else:
            image_scaled = image
            sh, sw = h, w

        with self._lock:
            self._detector.setInputSize((sw, sh))
            _, faces = self._detector.detect(image_scaled)
            results: list[DetectedFace] = []
            if faces is None:
                return results

            gray_full = cv2.cvtColor(image_scaled, cv2.COLOR_BGR2GRAY)

            for idx, row in enumerate(faces):
                face_uid = f"F-{int(time.time() * 1000)}-{idx:02d}-{uuid.uuid4().hex[:4]}"
                x, y, fw, fh = row[:4]
                score = float(row[-1])

                # Extract 5 landmarks (right eye, left eye, nose, right mouth, left mouth)
                landmarks = [
                    (float(row[4] / scale), float(row[5] / scale)),
                    (float(row[6] / scale), float(row[7] / scale)),
                    (float(row[8] / scale), float(row[9] / scale)),
                    (float(row[10] / scale), float(row[11] / scale)),
                    (float(row[12] / scale), float(row[13] / scale)),
                ]

                # Map box back to original coordinates
                orig_box = (
                    int(max(0, x / scale)),
                    int(max(0, y / scale)),
                    int(fw / scale),
                    int(fh / scale),
                )

                # Quality checks on crop in scaled image
                ix = max(0, int(x))
                iy = max(0, int(y))
                iw = min(sw - ix, int(fw))
                ih = min(sh - iy, int(fh))

                if iw <= 10 or ih <= 10:
                    results.append(
                        DetectedFace(
                            face_id=face_uid,
                            box=orig_box,
                            score=score,
                            landmarks=landmarks,
                            is_valid=False,
                            rejection_reason="CROP_OUT_OF_BOUNDS",
                        )
                    )
                    continue

                crop = gray_full[iy : iy + ih, ix : ix + iw]
                mean_lum = float(np.mean(crop))
                lap_var = float(cv2.Laplacian(crop, cv2.CV_64F).var())

                # Normalized quality score (0.0 to 1.0)
                quality_score = round(
                    min(
                        1.0,
                        (min(score, 1.0) * 0.4)
                        + (min(lap_var, 200.0) / 200.0 * 0.3)
                        + (min(max(0, mean_lum - 30), 150.0) / 150.0 * 0.3),
                    ),
                    2,
                )

                # Quality Validation Criteria
                rejection = None
                aspect_ratio = float(fw) / max(1.0, float(fh))
                if min(fw, fh) < self.min_face_size * scale:
                    rejection = "FACE_TOO_SMALL"
                elif score < 0.65:
                    rejection = "LOW_DETECTION_CONFIDENCE"
                elif lap_var < 20.0:
                    rejection = "BLURRY_FACE_CROP"
                elif mean_lum < 30.0:
                    rejection = "UNDEREXPOSED_TOO_DARK"
                elif mean_lum > 245.0:
                    rejection = "OVEREXPOSED_TOO_BRIGHT"
                elif aspect_ratio < 0.50 or aspect_ratio > 1.65:
                    rejection = "ABNORMAL_ASPECT_RATIO"

                if rejection:
                    results.append(
                        DetectedFace(
                            face_id=face_uid,
                            box=orig_box,
                            score=score,
                            landmarks=landmarks,
                            quality_score=quality_score,
                            brightness=round(mean_lum, 1),
                            sharpness=round(lap_var, 1),
                            is_valid=False,
                            rejection_reason=rejection,
                            embedding=None,
                        )
                    )
                    continue

                # Align and extract embedding for valid high-quality face
                aligned = self._recognizer.alignCrop(image_scaled, row)
                feat = self._recognizer.feature(aligned).flatten().astype(np.float32)
                feat /= np.linalg.norm(feat) + 1e-9

                results.append(
                    DetectedFace(
                        face_id=face_uid,
                        box=orig_box,
                        score=score,
                        landmarks=landmarks,
                        quality_score=quality_score,
                        brightness=round(mean_lum, 1),
                        sharpness=round(lap_var, 1),
                        is_valid=True,
                        rejection_reason=None,
                        embedding=feat,
                    )
                )

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

    def validate_face(self, image: np.ndarray, expected_angle: Optional[str] = None) -> dict:
        """Validate face image quality, lighting, blur, and head orientation."""
        if image is None or image.size == 0:
            return {"valid": False, "status": "EMPTY_IMAGE", "message": "Empty or unreadable image"}

        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        mean_lum = float(np.mean(gray))
        lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

        h, w = image.shape[:2]
        with self._lock:
            self._detector.setInputSize((w, h))
            _, raw_faces = self._detector.detect(image)

        if raw_faces is None or len(raw_faces) == 0:
            return {
                "valid": False,
                "status": "NO_FACE_DETECTED",
                "message": "No face detected in frame. Ensure your face is clearly visible.",
                "quality": {"brightness": round(mean_lum, 1), "sharpness": round(lap_var, 1)},
            }

        # Filter faces by size
        valid_faces = [r for r in raw_faces if min(r[2], r[3]) >= self.min_face_size]
        if not valid_faces:
            return {
                "valid": False,
                "status": "FACE_TOO_FAR",
                "message": "Face is too small or too far away. Move closer to the camera.",
                "quality": {"brightness": round(mean_lum, 1), "sharpness": round(lap_var, 1)},
            }

        if len(valid_faces) > 1:
            valid_faces.sort(key=lambda f: f[2] * f[3], reverse=True)
            if valid_faces[1][2] * valid_faces[1][3] > 0.45 * valid_faces[0][2] * valid_faces[0][3]:
                return {
                    "valid": False,
                    "status": "MULTIPLE_FACES",
                    "message": "Multiple faces detected. Frame should contain only the employee.",
                    "quality": {"brightness": round(mean_lum, 1), "sharpness": round(lap_var, 1)},
                }

        best = valid_faces[0]
        score = float(best[14])
        if score < 0.70:
            return {
                "valid": False,
                "status": "LOW_CONFIDENCE",
                "message": f"Low face detection confidence ({score:.2f}). Please ensure direct line of sight.",
                "quality": {"brightness": round(mean_lum, 1), "sharpness": round(lap_var, 1)},
            }

        if lap_var < 35.0:
            return {
                "valid": False,
                "status": "BLURRY",
                "message": "Image is blurry. Please hold steady while capturing.",
                "quality": {"brightness": round(mean_lum, 1), "sharpness": round(lap_var, 1)},
            }

        if mean_lum < 35.0:
            return {
                "valid": False,
                "status": "TOO_DARK",
                "message": "Lighting is too dark. Increase ambient lighting or face a light source.",
                "quality": {"brightness": round(mean_lum, 1), "sharpness": round(lap_var, 1)},
            }

        if mean_lum > 240.0:
            return {
                "valid": False,
                "status": "TOO_BRIGHT",
                "message": "Image is overexposed or washed out by backlight.",
                "quality": {"brightness": round(mean_lum, 1), "sharpness": round(lap_var, 1)},
            }

        # Check head orientation from 5 landmarks
        # landmarks: right eye=(4,5), left eye=(6,7), nose=(8,9), right mouth=(10,11), left mouth=(12,13)
        rx, ry = float(best[4]), float(best[5])
        lx, ly = float(best[6]), float(best[7])
        nx, ny = float(best[8]), float(best[9])
        d_right = abs(nx - rx)
        d_left = abs(lx - nx)
        ratio = d_right / (d_left + 1e-5)

        if ratio < 0.65:
            detected_angle = "LEFT"
        elif ratio > 1.55:
            detected_angle = "RIGHT"
        else:
            detected_angle = "FRONT"

        angle_match = True
        if expected_angle:
            exp = expected_angle.upper()
            if exp in ("FRONT", "LEFT", "RIGHT") and exp != detected_angle:
                # Accept slightly looser angle if confidence is high, but inform user
                angle_match = False

        lighting_eval = "EXCELLENT" if 70 <= mean_lum <= 180 else ("GOOD" if 45 <= mean_lum <= 220 else "SUBOPTIMAL")
        sharpness_eval = "SHARP" if lap_var >= 80 else "ACCEPTABLE"
        quality_score = round(min(1.0, (score * 0.4) + (min(lap_var, 300) / 300 * 0.3) + (min(mean_lum, 180) / 180 * 0.3)), 2)

        return {
            "valid": True,
            "status": "APPROVED" if angle_match else "ANGLE_MISMATCH",
            "message": "Face image passed quality validation" if angle_match else f"Face detected as {detected_angle} instead of {expected_angle}. Please adjust angle.",
            "detectedAngle": detected_angle,
            "angleMatch": angle_match,
            "confidence": round(score, 3),
            "qualityScore": quality_score,
            "lighting": lighting_eval,
            "sharpness": sharpness_eval,
            "box": [int(best[0]), int(best[1]), int(best[2]), int(best[3])],
            "quality": {
                "brightness": round(mean_lum, 1),
                "sharpness": round(lap_var, 1),
            },
        }


def decode_image(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise FaceEngineError("Could not read image. Upload a JPEG or PNG.")
    return img


@dataclass
class MatchResult:
    employee_id: Optional[str] = None
    employee_name: Optional[str] = None
    similarity: float = 0.0
    runner_up_similarity: float = 0.0
    margin: float = 0.0
    is_ambiguous: bool = False
    is_match: bool = False
    rejection_reason: Optional[str] = None


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

    def match_diagnostic(
        self, embedding: Optional[np.ndarray], threshold: float = 0.46, margin: float = 0.08
    ) -> MatchResult:
        """Evaluate embedding against gallery with top-2 ambiguity rejection."""
        if embedding is None or not len(self):
            return MatchResult(
                employee_id=None,
                employee_name=None,
                similarity=0.0,
                runner_up_similarity=0.0,
                margin=0.0,
                is_ambiguous=False,
                is_match=False,
                rejection_reason="NO_EMBEDDING_OR_EMPTY_GALLERY",
            )

        sims = self.matrix @ embedding

        # Group similarities by distinct employee (take max score per employee)
        emp_sims: Dict[str, float] = {}
        for idx, emp_id in enumerate(self.employee_ids):
            s = float(sims[idx])
            if emp_id not in emp_sims or s > emp_sims[emp_id]:
                emp_sims[emp_id] = s

        if not emp_sims:
            return MatchResult(rejection_reason="NO_VALID_EMPLOYEES")

        # Sort employees by similarity descending
        ranked = sorted(emp_sims.items(), key=lambda x: x[1], reverse=True)
        top_id, top_sim = ranked[0]
        top_name = self.names.get(top_id, "")

        runner_up_sim = ranked[1][1] if len(ranked) > 1 else 0.0
        delta = round(top_sim - runner_up_sim, 4)

        # 1. Check recognition threshold
        if top_sim < threshold:
            return MatchResult(
                employee_id=None,
                employee_name=top_name,
                similarity=round(top_sim, 4),
                runner_up_similarity=round(runner_up_sim, 4),
                margin=delta,
                is_ambiguous=False,
                is_match=False,
                rejection_reason=f"BELOW_THRESHOLD_{top_sim:.3f}_LT_{threshold:.3f}",
            )

        # 2. Check ambiguity threshold (runner-up from different employee must be >= margin lower)
        if len(ranked) > 1 and delta < margin:
            return MatchResult(
                employee_id=None,
                employee_name=top_name,
                similarity=round(top_sim, 4),
                runner_up_similarity=round(runner_up_sim, 4),
                margin=delta,
                is_ambiguous=True,
                is_match=False,
                rejection_reason=f"AMBIGUOUS_MARGIN_{delta:.3f}_LT_{margin:.3f}",
            )

        # 3. Valid definitive match
        return MatchResult(
            employee_id=top_id,
            employee_name=top_name,
            similarity=round(top_sim, 4),
            runner_up_similarity=round(runner_up_sim, 4),
            margin=delta,
            is_ambiguous=False,
            is_match=True,
            rejection_reason=None,
        )

    def match(self, embedding: np.ndarray, threshold: float, margin: float) -> tuple[str | None, float]:
        """Best-matching employee, or None if below threshold or ambiguous."""
        res = self.match_diagnostic(embedding, threshold=threshold, margin=margin)
        return res.employee_id, res.similarity
