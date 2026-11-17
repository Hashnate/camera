"""WorkSight YOLO Person Detector.

Uses Ultralytics YOLOv8 nano model specifically filtered for COCO class 0 (person).
Provides tight bounding boxes hugging the visible human body, ignoring furniture,
chairs, desks, computers, bags, and background objects.
"""

import logging
from pathlib import Path
from typing import Optional
import numpy as np
from ultralytics import YOLO

log = logging.getLogger("ai.yolo")


class YOLOPersonDetector:
    def __init__(
        self,
        model_path: Optional[str] = None,
        conf_threshold: float = 0.30,
        iou_threshold: float = 0.45,
    ):
        if not model_path:
            model_path = str(Path(__file__).resolve().parent.parent / "models" / "yolov8n.pt")
        self.model_path = model_path
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold

        log.info("Loading YOLO person detector from: %s", self.model_path)
        self.model = YOLO(self.model_path)
        log.info("YOLO person detector loaded successfully.")

    def infer(self, image: np.ndarray) -> np.ndarray:
        """Run YOLO person detection on BGR image.

        Returns:
            np.ndarray of shape (N, 5) with columns [x1, y1, x2, y2, score]
            in original pixel coordinates, or empty (0, 5) if no person detected.
        """
        if image is None or image.size == 0:
            return np.empty((0, 5), dtype=np.float32)

        # classes=[0] filters strictly COCO person class
        results = self.model(
            image,
            classes=[0],
            conf=self.conf_threshold,
            iou=self.iou_threshold,
            verbose=False,
        )[0]

        if results.boxes is None or len(results.boxes) == 0:
            return np.empty((0, 5), dtype=np.float32)

        boxes = results.boxes.xyxy.cpu().numpy()
        scores = results.boxes.conf.cpu().numpy().reshape(-1, 1)
        return np.hstack([boxes, scores]).astype(np.float32)
