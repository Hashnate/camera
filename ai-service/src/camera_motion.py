"""Estimate how the camera itself moved between two frames (pan / tilt / zoom of a PTZ lens).

Keypoints are matched on the background only (person boxes are masked out) and a similarity transform
(shift + rotation + scale) is fitted with RANSAC. Returns a 2x3 matrix in full-resolution pixels mapping the
previous frame to the current one, or None when the camera didn't move (or the estimate isn't reliable).
"""

from typing import Optional

import cv2
import numpy as np

WORK_WIDTH = 960       # analyse a downscaled copy
MIN_INLIERS = 25       # matched background points that must agree
MIN_SHIFT_PX = 6.0     # smaller movements are sensor noise / compression jitter, ignored


class CameraMotionEstimator:
    def __init__(self) -> None:
        self._orb = cv2.ORB_create(1200)
        self._bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        self._prev = None  # (keypoints, descriptors)

    def estimate(self, frame: np.ndarray, person_boxes) -> Optional[np.ndarray]:
        h, w = frame.shape[:2]
        s = WORK_WIDTH / float(w)
        gray = cv2.cvtColor(cv2.resize(frame, (WORK_WIDTH, max(1, int(h * s)))), cv2.COLOR_BGR2GRAY)
        mask = np.full(gray.shape, 255, np.uint8)
        for b in person_boxes:  # people move on their own: only the background tells how the camera moved
            x1, y1, x2, y2 = (int(round(float(v) * s)) for v in b[:4])
            mask[max(0, y1) : max(0, y2), max(0, x1) : max(0, x2)] = 0
        kp, des = self._orb.detectAndCompute(gray, mask)
        prev, self._prev = self._prev, (kp, des)
        if prev is None or des is None or prev[1] is None or len(kp) < MIN_INLIERS:
            return None
        matches = self._bf.match(prev[1], des)
        if len(matches) < MIN_INLIERS:
            return None
        src = np.float32([prev[0][m.queryIdx].pt for m in matches])
        dst = np.float32([kp[m.trainIdx].pt for m in matches])
        M, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
        if M is None or inliers is None or int(inliers.sum()) < MIN_INLIERS:
            return None
        M = M.astype(np.float32)
        M[:, 2] /= s  # translation back to full-resolution pixels (rotation/scale are resolution-free)
        zoom = float(np.hypot(M[0, 0], M[1, 0]))
        if float(np.hypot(M[0, 2], M[1, 2])) < MIN_SHIFT_PX and abs(zoom - 1.0) < 0.01:
            return None
        return M
