"""Real-Time Multi-Person Tracking & Doorway Crossing Engine (ByteTrack + Biometric Association).

Implements:
1. Two-Stage ByteTrack Association (IoU overlap + velocity prediction).
2. Track Lifecycle (ACTIVE -> LOST -> RECOVERED / REMOVED) to eliminate Track ID switches.
3. Identity Exclusivity: Prevents assigning the same employee ID to multiple active tracks simultaneously.
4. Overwrite Protection: Prevents an overlapping stray face from hijacking an already-verified track ID.
5. Multi-Frame Identity Hysteresis: Confirms identity across frames before promoting to VERIFIED.
6. Directional Doorway Crossing Detector for LINE_WORK, LINE_LUNCH, and LINE_EXIT.
7. Debounce Window: Prevents boundary oscillation event spam.
"""

import time
import logging
import numpy as np
import cv2
from typing import Dict, List, Optional, Tuple, Set, Any, Union
from identity_latching_engine import IdentityLatchingEngine, IdentityLatchState

log = logging.getLogger("ai.tracking")

# Identity handoff (see ZoneTrackingEngine._hand_off_identities). Clothing similarity is the correlation of
# torso colour histograms; measured on the office cameras: same person 0.88-0.98, different people median 0.31,
# 95th percentile 0.47-0.59.
HANDOFF_WINDOW_SEC = 90.0     # same spot: a lost named person can hand their name on for this long
SPOT_MIN_CORR = 0.60          # ... if the clothing is at least this similar
# No "same clothes" hand-over after longer gaps: shirt colour can't tell people in this office apart well enough
# (25 Nov: different people scored 0.71-0.76, and 5 of 12 such hand-overs in one afternoon kept Musni's name on other
# people for 37 minutes while he was out). A body-ReID model could bring it back as a stronger check.
REID_MARGIN = 0.15            # the best match must beat the next lost person by this much
# A seated person's body track keeps restarting under a new number. When a named person walks off, the person sitting
# next to where they were lost "appears" as a new body and used to inherit their name (25 Nov: Musni away 12:11-12:23,
# shown present). So a new body never inherits a name if another unnamed body was at that spot just before it.
REFORM_WINDOW_SEC = 15.0      # an unnamed body seen at the spot this long before the new one started
REFORM_IOU = 0.40             # ... overlapping it this much: the new body is that person, re-detected
UNNAMED_MEMORY_SEC = HANDOFF_WINDOW_SEC + 30.0
# One person, one body. 25 Nov: Afham's and Musni's names sat on two bodies at once on the pan-tilt lens, because a
# face match the old exclusivity check had refused still reached the latching engine, and names handed on without a
# face weren't counted as taken. A body keeps its name; a new face match can only take it over when it is strong and
# the current holder's face hasn't been seen for a while (then the holder is more likely the wrong body).
TAKEOVER_SIM = 0.60
TAKEOVER_STALE_SEC = 60.0
REID_MIN_SAMPLES = 3          # frames a new body is seen before its clothing is trusted
LOW_ONLY_MAX_SEC = 60.0       # a track kept alive only by weak detections is dropped after this long


def _ccw(A, B, C):
    return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0])


def line_intersect(A, B, C, D) -> bool:
    """Return True if line segments AB and CD intersect."""
    return _ccw(A, C, D) != _ccw(B, C, D) and _ccw(A, B, C) != _ccw(A, B, D)


def crossing_direction(
    p_prev: Tuple[float, float],
    p_curr: Tuple[float, float],
    line_start: Tuple[float, float],
    line_end: Tuple[float, float],
) -> str:
    """Determine crossing direction ('forward' or 'backward') using normal vector."""
    dx = line_end[0] - line_start[0]
    dy = line_end[1] - line_start[1]
    # Normal pointing to the "right" of the line vector
    normal = np.array([-dy, dx])
    norm_len = np.linalg.norm(normal)
    if norm_len > 1e-6:
        normal = normal / norm_len

    movement = np.array([p_curr[0] - p_prev[0], p_curr[1] - p_prev[1]])
    dot = float(np.dot(movement, normal))
    return "forward" if dot >= 0 else "backward"


def compute_iou(box1: np.ndarray, box2: np.ndarray) -> float:
    """Compute Intersection over Union between two [x1, y1, x2, y2] boxes."""
    x1 = max(float(box1[0]), float(box2[0]))
    y1 = max(float(box1[1]), float(box2[1]))
    x2 = min(float(box1[2]), float(box2[2]))
    y2 = min(float(box1[3]), float(box2[3]))

    inter_w = max(0.0, x2 - x1)
    inter_h = max(0.0, y2 - y1)
    inter_area = inter_w * inter_h

    area1 = max(0.0, float(box1[2] - box1[0])) * max(0.0, float(box1[3] - box1[1]))
    area2 = max(0.0, float(box2[2] - box2[0])) * max(0.0, float(box2[3] - box2[1]))
    union_area = area1 + area2 - inter_area

    if union_area <= 1e-6:
        return 0.0
    return inter_area / union_area


class TrackState:
    ACTIVE = "ACTIVE"
    LOST = "LOST"
    REMOVED = "REMOVED"


class IdentityState:
    UNVERIFIED            = "UNVERIFIED"
    CANDIDATE             = "CANDIDATE"
    VERIFIED              = "VERIFIED"
    AMBIGUOUS             = "AMBIGUOUS"
    REJECTED              = "REJECTED"
    # v2.9 extended states (mirrors IdentityLatchState for backward compat)
    IDENTITY_CANDIDATE    = "IDENTITY_CANDIDATE"
    IDENTITY_LATCHED      = "IDENTITY_LATCHED"
    TRACKING_WITHOUT_FACE = "TRACKING_WITHOUT_FACE"
    TRACKING_UNCERTAIN    = "TRACKING_UNCERTAIN"
    REQUIRES_REVERIFICATION = "REQUIRES_REVERIFICATION"


class Track:
    def __init__(self, track_id: int, bbox: np.ndarray, score: float, now: float):
        self.track_id = track_id
        self.bbox = np.array(bbox[:4], dtype=np.float32)  # [x1, y1, x2, y2]
        self.score = float(score)
        self.created_at = now
        self.started_at = now
        self.last_seen = now
        self.state = TrackState.ACTIVE
        self.lost_since: Optional[float] = None

        # Estimated velocity (pixels/second)
        self.velocity = (0.0, 0.0)

        # 5-State Biometric Identity Management (WorkSight v2.4)
        self.employee_id: Optional[str] = None
        self.employee_name: Optional[str] = None
        self.employee_code: Optional[str] = None
        self.identity_status: str = IdentityState.UNVERIFIED
        self.identity_confidence: float = 0.0
        self.identity_hits: int = 0
        self.candidate_employee_id: Optional[str] = None
        self.candidate_employee_name: Optional[str] = None
        self.candidate_hits: int = 0
        self.conflict_hits: int = 0
        self.verified_at: Optional[float] = None
        self.last_biometric_at: Optional[float] = None
        self.face_id: Optional[str] = None
        self.face_quality: float = 0.0
        # Clothing colour signature (torso HSV histogram, averaged over frames) for re-identification
        self.appearance: Optional[np.ndarray] = None
        self.appearance_n = 0
        # Since when only weak (low-confidence) detections have kept this track alive
        self.low_only_since: Optional[float] = None

        # v2.9 — ILE extended tracking fields
        self.identity_state: str = IdentityLatchState.UNVERIFIED
        self.face_currently_visible: bool = False
        self.tracking_without_face_sec: float = 0.0
        self.last_face_seen_at: Optional[float] = None

        self.current_zone_id: Optional[str] = None
        self.history: List[Tuple[float, float]] = []  # [(cx, cy), ...]
        self.last_crossings: Dict[str, float] = {}  # line_id -> timestamp

        cx = (self.bbox[0] + self.bbox[2]) / 2.0
        cy = (self.bbox[1] + self.bbox[3]) / 2.0
        self.history.append((cx, cy))

    @property
    def center(self) -> Tuple[float, float]:
        return self.history[-1]

    def predict(self, dt: float) -> np.ndarray:
        """Predict bounding box based on velocity."""
        dt = min(dt, 1.0)  # extrapolating a stale speed further only drifts away from where the person was
        dx = self.velocity[0] * dt
        dy = self.velocity[1] * dt
        pred = self.bbox.copy()
        pred[0] += dx
        pred[2] += dx
        pred[1] += dy
        pred[3] += dy
        return pred

    def update(self, bbox: np.ndarray, score: float, now: float):
        dt = max(0.01, now - self.last_seen)
        old_cx = (self.bbox[0] + self.bbox[2]) / 2.0
        old_cy = (self.bbox[1] + self.bbox[3]) / 2.0

        self.bbox = np.array(bbox[:4], dtype=np.float32)
        self.score = float(score)
        self.last_seen = now
        self.state = TrackState.ACTIVE
        self.lost_since = None

        new_cx = (self.bbox[0] + self.bbox[2]) / 2.0
        new_cy = (self.bbox[1] + self.bbox[3]) / 2.0

        # Exponential moving average velocity
        vx = (new_cx - old_cx) / dt
        vy = (new_cy - old_cy) / dt
        self.velocity = (0.7 * self.velocity[0] + 0.3 * vx, 0.7 * self.velocity[1] + 0.3 * vy)

        self.history.append((new_cx, new_cy))
        if len(self.history) > 30:
            self.history.pop(0)

    def mark_lost(self, now: float):
        if self.state != TrackState.LOST:
            self.state = TrackState.LOST
            self.lost_since = now


class BytePersonTracker:
    """ByteTrack-style two-stage multi-object tracker with track recovery."""

    def __init__(
        self,
        max_lost_sec: float = 6.0,
        iou_threshold: float = 0.20,
        high_threshold: float = 0.30,
        low_threshold: float = 0.10,
    ):
        self.max_lost_sec = max_lost_sec
        self.iou_threshold = iou_threshold
        self.high_threshold = high_threshold
        self.low_threshold = low_threshold
        # Unique per run (track numbers are stored, and a restarted service must not reuse an earlier run's numbers).
        self.next_track_id = 101 + (int(time.time()) % 1_000_000) * 100
        self.tracks: Dict[int, Track] = {}

    def apply_camera_motion(self, M: np.ndarray) -> None:
        """The lens itself moved (pan / tilt / zoom): move every track the same way before matching, so a camera
        movement isn't mistaken for every person jumping (which would break all tracks at once)."""
        A, t = M[:, :2], M[:, 2]
        for tr in self.tracks.values():
            corners = np.array([[tr.bbox[0], tr.bbox[1]], [tr.bbox[2], tr.bbox[3]]], dtype=np.float32) @ A.T + t
            tr.bbox = np.array([corners[0, 0], corners[0, 1], corners[1, 0], corners[1, 1]], dtype=np.float32)
            if tr.history:
                tr.history = [tuple(v) for v in (np.array(tr.history, dtype=np.float32) @ A.T + t).tolist()]

    def _effective_max_lost(self, tr: Track) -> float:
        """Stationary (seated) employees get a longer lost window than moving ones."""
        speed = (tr.velocity[0] ** 2 + tr.velocity[1] ** 2) ** 0.5
        if speed < 2.0:  # px/s — essentially stationary
            return max(self.max_lost_sec, 20.0)   # 20 s grace for seated employees (e.g. moving a chair)
        return self.max_lost_sec

    def update(self, detections: List[np.ndarray], now: float) -> Tuple[List[Track], List[Track]]:
        """Returns (active_tracks, removed_tracks)."""
        removed_tracks: List[Track] = []

        # 1. Purge expired lost tracks (velocity-aware timeout)
        to_del = []
        for tid, tr in self.tracks.items():
            if (tr.state == TrackState.LOST and tr.lost_since and now - tr.lost_since > self._effective_max_lost(tr)) or (
                tr.low_only_since is not None and now - tr.low_only_since > LOW_ONLY_MAX_SEC
            ):
                tr.state = TrackState.REMOVED
                removed_tracks.append(tr)
                to_del.append(tid)
        for tid in to_del:
            del self.tracks[tid]

        if detections is None or len(detections) == 0:
            # Mark all active tracks as lost
            for tr in self.tracks.values():
                if tr.state == TrackState.ACTIVE:
                    tr.mark_lost(now)
            active = [t for t in self.tracks.values() if t.state == TrackState.ACTIVE]
            return active, removed_tracks

        # 2. Separate detections by score
        high_dets = []
        low_dets = []
        for d in detections:
            score = float(d[4]) if len(d) > 4 else 0.8
            if score >= self.high_threshold:
                high_dets.append(d)
            elif score >= self.low_threshold:
                low_dets.append(d)

        active_tracks = list(self.tracks.values())
        matched_tracks: Set[int] = set()
        matched_high_dets: Set[int] = set()

        # 3. Stage 1: Associate with high-confidence detections via IoU
        if high_dets and active_tracks:
            iou_matrix = np.zeros((len(active_tracks), len(high_dets)), dtype=np.float32)
            for t_idx, tr in enumerate(active_tracks):
                dt = max(0.0, now - tr.last_seen)
                pred_box = tr.predict(dt)
                for d_idx, det in enumerate(high_dets):
                    iou_matrix[t_idx, d_idx] = compute_iou(pred_box, det[:4])

            # Greedy matching on highest IoU pairs
            flat_indices = np.argsort(-iou_matrix.ravel())
            for idx in flat_indices:
                t_idx = idx // len(high_dets)
                d_idx = idx % len(high_dets)
                iou_val = iou_matrix[t_idx, d_idx]
                if iou_val < self.iou_threshold:
                    break
                tr = active_tracks[t_idx]
                if tr.track_id in matched_tracks or d_idx in matched_high_dets:
                    continue
                tr.update(high_dets[d_idx][:4], float(high_dets[d_idx][4]), now)
                tr.low_only_since = None
                matched_tracks.add(tr.track_id)
                matched_high_dets.add(d_idx)

        # 4. Stage 2: Associate remaining tracks with low-confidence detections or nearest centroid
        unmatched_tracks = [t for t in active_tracks if t.track_id not in matched_tracks]
        all_remain_dets = low_dets + [high_dets[i] for i in range(len(high_dets)) if i not in matched_high_dets]
        matched_remain_dets: Set[int] = set()

        if unmatched_tracks and all_remain_dets:
            for tr in unmatched_tracks:
                dt = max(0.0, now - tr.last_seen)
                pred_box = tr.predict(dt)
                tc = ((pred_box[0] + pred_box[2]) / 2.0, (pred_box[1] + pred_box[3]) / 2.0)
                # At a few frames per second a person can move well over 220 px between frames: scale with body size.
                max_dist = max(220.0, 1.5 * float(pred_box[2] - pred_box[0]))
                best_det_idx = None
                best_cost = 9999.0

                for d_idx, det in enumerate(all_remain_dets):
                    if d_idx in matched_remain_dets:
                        continue
                    iou_val = compute_iou(pred_box, det[:4])
                    if d_idx < len(low_dets):
                        # Weak detection (partly hidden person, or maybe a coat on a chair): only keeps alive a
                        # track it clearly overlaps, never one nearby.
                        if iou_val >= 0.30 and 1.0 - iou_val < best_cost:
                            best_cost = 1.0 - iou_val
                            best_det_idx = d_idx
                        continue
                    dc = ((det[0] + det[2]) / 2.0, (det[1] + det[3]) / 2.0)
                    dist = np.hypot(tc[0] - dc[0], tc[1] - dc[1])

                    # Prefer high IoU or reasonable centroid distance
                    if iou_val >= 0.20:
                        cost = 1.0 - iou_val
                    elif dist <= max_dist:
                        cost = dist / max_dist + 1.0
                    else:
                        continue

                    if cost < best_cost:
                        best_cost = cost
                        best_det_idx = d_idx

                if best_det_idx is not None:
                    det = all_remain_dets[best_det_idx]
                    tr.update(det[:4], float(det[4]), now)
                    if float(det[4]) >= self.high_threshold:
                        tr.low_only_since = None
                    elif tr.low_only_since is None:
                        tr.low_only_since = now
                    matched_tracks.add(tr.track_id)
                    matched_remain_dets.add(best_det_idx)

        # 5. Unmatched active tracks become LOST
        for tr in active_tracks:
            if tr.track_id not in matched_tracks:
                tr.mark_lost(now)

        # High detections matched in stage 2 belong to an existing track: they must not also start a new one.
        n_low = len(low_dets)
        remain_high_idx = [i for i in range(len(high_dets)) if i not in matched_high_dets]
        for r_idx in matched_remain_dets:
            if r_idx >= n_low:
                matched_high_dets.add(remain_high_idx[r_idx - n_low])

        # 6. Unmatched high-confidence detections initialize new tracks
        for d_idx, det in enumerate(high_dets):
            if d_idx not in matched_high_dets:
                tid = self.next_track_id
                self.next_track_id += 1
                new_track = Track(tid, det[:4], float(det[4]), now)
                self.tracks[tid] = new_track

        live_tracks = [t for t in self.tracks.values() if t.state == TrackState.ACTIVE]
        return live_tracks, removed_tracks


def min_cost_bipartite_matching(cost_matrix: np.ndarray, max_cost: float = 1.0) -> List[Tuple[int, int]]:
    """Solve minimum cost 1-to-1 bipartite assignment with strict cost threshold gating.

    Ensures every row is matched to at most one column and vice-versa, minimizing total cost.
    """
    if cost_matrix.size == 0:
        return []
    n_rows, n_cols = cost_matrix.shape
    matches: List[Tuple[int, int]] = []
    used_rows: Set[int] = set()
    used_cols: Set[int] = set()

    flat_indices = np.argsort(cost_matrix.ravel())
    for idx in flat_indices:
        r = int(idx // n_cols)
        c = int(idx % n_cols)
        cost = float(cost_matrix[r, c])
        if cost >= max_cost:
            break
        if r not in used_rows and c not in used_cols:
            matches.append((r, c))
            used_rows.add(r)
            used_cols.add(c)
            if len(used_rows) == n_rows or len(used_cols) == n_cols:
                break
    return matches


class ZoneTrackingEngine:
    def __init__(self, width: int = 1920, height: int = 1080):
        self.width = width
        self.height = height
        self.tracker = BytePersonTracker(max_lost_sec=6.0, iou_threshold=0.20)
        self.zones: List[dict] = []
        self.lines: List[dict] = []
        self.latest_diagnostics: List[dict] = []
        # v2.9 — Identity Latching Engine
        self.ile = IdentityLatchingEngine()
        # Named people whose body track was lost: employee_id -> {bbox, last_seen, name, code, appearance}
        self.recently_lost: Dict[str, dict] = {}
        # Unnamed bodies recently seen: track_id -> (last seen, bbox). See REFORM_WINDOW_SEC.
        self.recent_unnamed: Dict[int, Tuple[float, np.ndarray]] = {}
        self.appearance_enabled = False  # set once frames are passed to evaluate()
        # "Same spot" hand-over only makes sense when the picture stays still: off for pan-tilt lenses (set by the
        # worker from the lens name) and for HANDOFF_WINDOW_SEC after any detected camera movement.
        self.handoff_enabled = True
        self.last_camera_motion_at = float("-inf")
        # track_id -> (employee_id, since when that track has had this name): who holds a name first keeps it.
        self.named_since: Dict[int, Tuple[str, float]] = {}

    # ------------------------------------------------------------- clothing signature

    @staticmethod
    def _torso_signature(frame: np.ndarray, bbox: np.ndarray) -> Optional[np.ndarray]:
        """Colour histogram of the torso (shirt), which stays the same all day and tells most people apart."""
        h_img, w_img = frame.shape[:2]
        x1, y1, x2, y2 = (int(round(float(v))) for v in bbox[:4])
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w_img, x2), min(h_img, y2)
        w, h = x2 - x1, y2 - y1
        if w < 16 or h < 32:
            return None
        crop = frame[y1 + int(0.20 * h) : y1 + int(0.65 * h), x1 + int(0.15 * w) : x2 - int(0.15 * w)]
        if crop.size == 0:
            return None
        hist = cv2.calcHist([cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)], [0, 1, 2], None, [12, 6, 4], [0, 180, 0, 256, 0, 256])
        cv2.normalize(hist, hist, 1.0, 0, cv2.NORM_L1)
        return hist.flatten().astype(np.float32)

    def _update_appearance(self, tracks: List[Track], frame: np.ndarray, now: float) -> None:
        for tr in tracks:
            if tr.last_seen != now:
                continue  # not matched to a detection in this frame
            if any(o is not tr and compute_iou(tr.bbox, o.bbox) > 0.25 for o in tracks):
                continue  # overlapping someone: the crop would mix two people's clothes
            sig = self._torso_signature(frame, tr.bbox)
            if sig is None:
                continue
            tr.appearance = sig if tr.appearance is None else (0.8 * tr.appearance + 0.2 * sig).astype(np.float32)
            tr.appearance_n += 1

    @staticmethod
    def _clothing_similarity(a: Optional[np.ndarray], b: Optional[np.ndarray]) -> Optional[float]:
        if a is None or b is None:
            return None
        return float(cv2.compareHist(a, b, cv2.HISTCMP_CORREL))

    # ------------------------------------------------------------- identity handoff

    def _remember_lost(self, tr: Track) -> None:
        self.recently_lost[tr.employee_id] = {
            "bbox": tr.bbox.copy(),
            "last_seen": tr.last_seen,
            "name": tr.employee_name,
            "code": getattr(tr, "employee_code", None),
            "appearance": None if tr.appearance is None else tr.appearance.copy(),
        }

    def _hand_off_identities(self, active_tracks: List[Track], removed_tracks: List[Track], now: float) -> None:
        """Give a new, unnamed body track the name of a recently lost person when it is clearly them, so office time
        doesn't depend on catching the face again: on the same lens, it appeared where a named person was lost within
        HANDOFF_WINDOW_SEC ("same spot"), in similar clothes.

        Only when one lost person clearly fits (REID_MARGIN ahead of any other), they are not on another live track,
        the body appeared after they were lost, and no other unnamed body was at that spot just before it appeared
        (then it's that person re-detected, not the lost one). A real face match still overrides the inherited name.
        """
        for rt in removed_tracks:
            if rt.employee_id:
                self._remember_lost(rt)
        # Named tracks that are lost but not yet removed can hand off straight away.
        lost_named = {t.employee_id: t for t in self.tracker.tracks.values() if t.state == TrackState.LOST and t.employee_id}
        for t in lost_named.values():
            self._remember_lost(t)
        on_track = {t.employee_id for t in active_tracks if t.employee_id}
        for emp in [e for e, v in self.recently_lost.items() if e in on_track or now - v["last_seen"] > HANDOFF_WINDOW_SEC]:
            del self.recently_lost[emp]
        if not self.recently_lost:
            return
        if not self.handoff_enabled or now - self.last_camera_motion_at <= HANDOFF_WINDOW_SEC:
            return  # the lens moves: "the same place in the picture" isn't the same place in the room

        for tr in active_tracks:
            if tr.employee_id:
                continue
            if self.appearance_enabled and tr.appearance_n < REID_MIN_SAMPLES:
                continue  # wait a moment so the clothing can be checked
            if any(
                tid != tr.track_id
                and tr.started_at - REFORM_WINDOW_SEC <= seen <= tr.started_at + 1.0
                and compute_iou(box, tr.bbox) >= REFORM_IOU
                for tid, (seen, box) in self.recent_unnamed.items()
            ):
                continue  # someone unnamed was sitting right here: this "new" body is them, re-detected
            cx, cy = (tr.bbox[0] + tr.bbox[2]) / 2.0, (tr.bbox[1] + tr.bbox[3]) / 2.0
            cands: List[Tuple[float, str, str]] = []
            for emp, lost in self.recently_lost.items():
                if tr.started_at < lost["last_seen"] - 2.0:
                    continue  # this body was already there while the person was still tracked: someone else
                lb = lost["bbox"]
                lx, ly = (lb[0] + lb[2]) / 2.0, (lb[1] + lb[3]) / 2.0
                near = np.hypot(cx - lx, cy - ly) <= 1.2 * max(float(lb[2] - lb[0]), float(tr.bbox[2] - tr.bbox[0]))
                age = now - lost["last_seen"]
                corr = self._clothing_similarity(tr.appearance, lost["appearance"])
                if near and age <= HANDOFF_WINDOW_SEC and (corr is None or corr >= SPOT_MIN_CORR):
                    cands.append((corr if corr is not None else SPOT_MIN_CORR, emp, "same spot"))
            if not cands:
                continue
            cands.sort(reverse=True)
            if len(cands) > 1 and cands[0][0] - cands[1][0] < REID_MARGIN:
                continue  # two lost people fit about equally: wait for a face
            score, emp, why = cands[0]
            lost = self.recently_lost.pop(emp)
            tr.employee_id, tr.employee_name, tr.employee_code = emp, lost["name"], lost["code"]
            tr.identity_status = IdentityState.TRACKING_WITHOUT_FACE
            old = lost_named.get(emp)
            if old is not None and old.track_id in self.tracker.tracks:
                # The old lost track must not come back as a second copy of this person.
                old.state = TrackState.REMOVED
                del self.tracker.tracks[old.track_id]
                self.ile.mark_track_removed(old.track_id, now)
                removed_tracks.append(old)
            log.info(
                "Identity handoff (%s, clothing %s, after %.0fs): track %s continues %s",
                why, f"{score:.2f}" if self.appearance_enabled else "n/a", now - lost["last_seen"], tr.track_id, lost["name"] or emp,
            )

    # ------------------------------------------------------------- one person, one body

    @staticmethod
    def _last_face_at(tr: Track) -> float:
        times = [t for t in (tr.last_face_seen_at, tr.last_biometric_at) if t is not None]
        return max(times) if times else float("-inf")

    def _strip_name(self, tr: Track, now: float, why: str) -> None:
        log.info("Name check: track %s loses %s (%s)", tr.track_id, tr.employee_name or tr.employee_id, why)
        tr.employee_id = tr.employee_name = tr.employee_code = None
        tr.identity_status = IdentityState.UNVERIFIED
        tr.identity_confidence = 0.0
        tr.identity_hits = 0
        tr.candidate_employee_id = tr.candidate_employee_name = None
        tr.candidate_hits = 0
        tr.conflict_hits = 0
        tr.verified_at = None
        self.ile.release_track(tr.track_id, now)
        self.named_since.pop(tr.track_id, None)

    def _one_body_per_name(self, active_tracks: List[Track], now: float) -> None:
        """Safety net after all naming steps: if a name ended up on two bodies, the one that had it first keeps it."""
        holders: Dict[str, List[Track]] = {}
        for tr in active_tracks:
            if tr.employee_id:
                holders.setdefault(tr.employee_id, []).append(tr)
        for emp, trs in holders.items():
            if len(trs) < 2:
                continue

            def since(t: Track) -> float:
                held = self.named_since.get(t.track_id)
                return held[1] if held and held[0] == emp else now

            keep = min(trs, key=lambda t: (since(t), -t.identity_confidence))
            for tr in trs:
                if tr is not keep:
                    self._strip_name(tr, now, f"already on track {keep.track_id}")
        for tr in active_tracks:
            held = self.named_since.get(tr.track_id)
            if not tr.employee_id:
                self.named_since.pop(tr.track_id, None)
            elif held is None or held[0] != tr.employee_id:
                self.named_since[tr.track_id] = (tr.employee_id, now)
        for tid in [k for k in self.named_since if k not in self.tracker.tracks]:
            del self.named_since[tid]

    def set_config(self, zones: List[dict], lines: List[dict]):
        self.zones = zones
        self.lines = lines

    def check_zone(self, cx: float, cy: float) -> Optional[str]:
        """Determine which configured polygon zone contains the point (cx, cy)."""
        for z in self.zones:
            if not z.get("enabled", True):
                continue
            poly = z.get("normalizedPolygon", [])
            if len(poly) < 3:
                continue
            pts = np.array(
                [[float(p[0]) * self.width, float(p[1]) * self.height] for p in poly],
                dtype=np.int32,
            )
            if cv2.pointPolygonTest(pts, (cx, cy), False) >= 0:
                return z.get("zoneId")
        return None

    def evaluate(
        self,
        detections: List[np.ndarray],
        face_matches: List[Any],
        now: float,
        return_diagnostics: bool = False,
        frame: Optional[np.ndarray] = None,
        camera_motion: Optional[np.ndarray] = None,
    ) -> Any:
        """Process person detections, execute 1-to-1 anatomical face association,
        apply 5-state identity protection, and check doorway line crossings.

        face_matches can be:
        - List of (face_box_xywh, employee_id, employee_name, similarity)
        - List of (face_box_xywh, employee_id, employee_name, similarity, face_id, quality_dict)
        - List of DetectedFace objects (with .box, .embedding, etc.)
        """
        # Remember where unnamed bodies were as of the last frame (names from its face matches included).
        for tr in self.tracker.tracks.values():
            if tr.state == TrackState.ACTIVE and not tr.employee_id:
                self.recent_unnamed[tr.track_id] = (tr.last_seen, tr.bbox.copy())
        for tid in [k for k, (seen, _) in self.recent_unnamed.items() if now - seen > UNNAMED_MEMORY_SEC]:
            del self.recent_unnamed[tid]

        if camera_motion is not None:
            self.last_camera_motion_at = now
            self.tracker.apply_camera_motion(camera_motion)
            A, t = camera_motion[:, :2], camera_motion[:, 2]

            def moved(b: np.ndarray) -> np.ndarray:
                c = np.array([[b[0], b[1]], [b[2], b[3]]], dtype=np.float32) @ A.T + t
                return np.array([c[0, 0], c[0, 1], c[1, 0], c[1, 1]], dtype=np.float32)

            for lost in self.recently_lost.values():
                lost["bbox"] = moved(lost["bbox"])
            for tid, (seen, box) in list(self.recent_unnamed.items()):
                self.recent_unnamed[tid] = (seen, moved(box))
        active_tracks, removed_tracks = self.tracker.update(detections, now)
        events: List[dict] = []
        diagnostics: List[dict] = []

        # Notify ILE of removed tracks
        for rt in removed_tracks:
            self.ile.mark_track_removed(rt.track_id, now)
            self.named_since.pop(rt.track_id, None)

        if frame is not None:
            self.appearance_enabled = True
            self._update_appearance(active_tracks, frame, now)
        self._hand_off_identities(active_tracks, removed_tracks, now)

        # -------------------------------------------------------------
        # 1. Parse Input Faces into Standardized Format
        # -------------------------------------------------------------
        parsed_faces = []
        for f_idx, item in enumerate(face_matches):
            if isinstance(item, tuple) or isinstance(item, list):
                fbox = item[0]
                emp_id = item[1] if len(item) > 1 else None
                emp_name = item[2] if len(item) > 2 else ""
                sim = float(item[3]) if len(item) > 3 else 0.0
                fid = item[4] if len(item) > 4 else f"F-{int(now*1000)}-{f_idx}"
                qinfo = item[5] if len(item) > 5 and isinstance(item[5], dict) else {}
                parsed_faces.append({
                    "box": fbox,
                    "employee_id": emp_id,
                    "employee_name": emp_name,
                    "similarity": sim,
                    "face_id": fid,
                    "quality": qinfo,
                    "quality_score": float(qinfo.get("qualityScore", 0.90)),
                })
            elif hasattr(item, "box"):
                parsed_faces.append({
                    "box": item.box,
                    "employee_id": getattr(item, "employee_id", None),
                    "employee_name": getattr(item, "employee_name", ""),
                    "similarity": getattr(item, "similarity", 0.0),
                    "face_id": getattr(item, "face_id", f"F-{int(now*1000)}-{f_idx}"),
                    "quality": getattr(item, "quality", {}),
                    "quality_score": getattr(item, "quality_score", 0.90),
                })

        # -------------------------------------------------------------
        # 2. Optimal 1-to-1 Anatomical Face-to-Person Association
        # -------------------------------------------------------------
        # Who holds which name right now (Exclusivity Guard): every named live body counts, also names carried
        # without a face (hand-over, latching), not only freshly VERIFIED ones.
        active_identity_map: Dict[str, int] = {t.employee_id: t.track_id for t in active_tracks if t.employee_id}
        tracks_by_id: Dict[int, Track] = {t.track_id: t for t in active_tracks}

        if parsed_faces and active_tracks:
            cost_matrix = np.full((len(parsed_faces), len(active_tracks)), 9999.0, dtype=np.float32)

            for f_idx, pf in enumerate(parsed_faces):
                fx, fy, fw, fh = pf["box"]
                fcx = fx + fw / 2.0
                fcy = fy + fh / 2.0
                f_area = max(1.0, float(fw * fh))

                for t_idx, tr in enumerate(active_tracks):
                    bx1, by1, bx2, by2 = tr.bbox
                    bw = max(1.0, float(bx2 - bx1))
                    bh = max(1.0, float(by2 - by1))
                    b_area = bw * bh

                    # Anatomical Head Region Gating: Face must lie in top 42% of person body
                    head_x1 = bx1 - 0.12 * bw
                    head_x2 = bx2 + 0.12 * bw
                    head_y1 = by1 - 0.08 * bh
                    head_y2 = by1 + 0.42 * bh

                    if not (head_x1 <= fcx <= head_x2 and head_y1 <= fcy <= head_y2):
                        continue

                    # Proportion check: Face area vs body area
                    area_ratio = f_area / b_area
                    if area_ratio < 0.012 or area_ratio > 0.45:
                        continue

                    # Normalized anatomical displacement
                    expected_head_x = (bx1 + bx2) / 2.0
                    expected_head_y = by1 + 0.16 * bh
                    norm_dx = abs(fcx - expected_head_x) / bw
                    norm_dy = abs(fcy - expected_head_y) / bh

                    # Head box intersection
                    ix1 = max(fx, head_x1)
                    iy1 = max(fy, head_y1)
                    ix2 = min(fx + fw, head_x2)
                    iy2 = min(fy + fh, head_y2)
                    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
                    overlap = inter / f_area

                    cost = 2.5 * norm_dx + 1.8 * norm_dy - 1.0 * overlap
                    cost_matrix[f_idx, t_idx] = float(cost)

            # Global 1-to-1 optimal assignment
            assignments = min_cost_bipartite_matching(cost_matrix, max_cost=0.95)

            matched_faces = set()
            for f_idx, t_idx in assignments:
                pf = parsed_faces[f_idx]
                tr = active_tracks[t_idx]
                matched_faces.add(f_idx)

                emp_id = pf["employee_id"]
                emp_name = pf["employee_name"]
                sim = pf["similarity"]
                fid = pf["face_id"]
                qscore = pf["quality_score"]

                tr.face_id = fid
                tr.face_quality = qscore

                diag_entry = {
                    "faceId": fid,
                    "trackId": tr.track_id,
                    "matchedEmployeeId": emp_id,
                    "matchedEmployeeName": emp_name,
                    "similarityScore": sim,
                    "faceQuality": qscore,
                    "associationCost": round(float(cost_matrix[f_idx, t_idx]), 3),
                    "timestamp": now,
                }

                if not emp_id:
                    # Unidentified face
                    if tr.identity_status != IdentityState.VERIFIED:
                        tr.identity_status = IdentityState.UNVERIFIED
                    diag_entry["recognitionState"] = tr.identity_status
                    diagnostics.append(diag_entry)
                    continue

                # -------------------------------------------------------------
                # 3. 5-State Identity Protection & Exclusivity Engine
                # -------------------------------------------------------------
                # RULE 1: ACTIVE EXCLUSIVITY
                # If another currently live track holds VERIFIED for this employee,
                # do not duplicate identity onto this track!
                existing_tid = active_identity_map.get(emp_id)
                if existing_tid is not None and existing_tid != tr.track_id:
                    holder = tracks_by_id.get(existing_tid)
                    if holder is not None and sim >= TAKEOVER_SIM and now - self._last_face_at(holder) >= TAKEOVER_STALE_SEC:
                        # Strong, fresh face here; the holder's face hasn't been seen for a while: likely the wrong body.
                        self._strip_name(holder, now, f"strong face match {sim:.2f} on track {tr.track_id}")
                        del active_identity_map[emp_id]
                    else:
                        if tr.identity_status != IdentityState.VERIFIED:
                            tr.identity_status = IdentityState.AMBIGUOUS
                        diag_entry["recognitionState"] = IdentityState.AMBIGUOUS
                        diag_entry["note"] = f"Suppressed: {emp_id} already active on Track {existing_tid}"
                        diag_entry["suppressed"] = True  # not passed on to the latching engine either
                        diagnostics.append(diag_entry)
                        continue

                # RULE 2: OVERWRITE PROTECTION
                # If track is already VERIFIED to employee A, do not overwrite on single conflict!
                if tr.identity_status == IdentityState.VERIFIED and tr.employee_id != emp_id:
                    tr.conflict_hits += 1
                    if tr.conflict_hits < 5:
                        diag_entry["recognitionState"] = IdentityState.VERIFIED
                        diag_entry["note"] = f"Protected: Preserved {tr.employee_id}, conflict count {tr.conflict_hits}/5"
                        diagnostics.append(diag_entry)
                        continue
                    else:
                        # 5 consecutive conflicting frames -> requires revalidation!
                        tr.identity_status = IdentityState.AMBIGUOUS
                        tr.employee_id = None
                        tr.employee_name = None
                        diag_entry["recognitionState"] = IdentityState.AMBIGUOUS
                        diag_entry["note"] = "Revalidation required due to persistent conflicting biometric evidence"
                        diagnostics.append(diag_entry)
                        continue

                # RULE 3: MULTI-FRAME CONSENSUS (Promotion to VERIFIED)
                if tr.identity_status == IdentityState.VERIFIED:
                    if tr.employee_id == emp_id:
                        tr.identity_hits += 1
                        tr.identity_confidence = max(tr.identity_confidence, sim)
                        tr.last_biometric_at = now
                        tr.conflict_hits = 0
                        diag_entry["recognitionState"] = IdentityState.VERIFIED
                        diagnostics.append(diag_entry)
                else:
                    # Current status is UNVERIFIED, CANDIDATE, or AMBIGUOUS
                    if sim >= 0.45:
                        if tr.candidate_employee_id == emp_id:
                            tr.candidate_hits += 1
                            # Verified on 2 frames, or 1 frame with high confidence & quality
                            if tr.candidate_hits >= 2 or (sim >= 0.55 and qscore >= 0.85):
                                tr.employee_id = emp_id
                                tr.employee_name = emp_name
                                tr.identity_status = IdentityState.VERIFIED
                                tr.identity_confidence = sim
                                tr.identity_hits = 2
                                tr.verified_at = now
                                tr.last_biometric_at = now
                                active_identity_map[emp_id] = tr.track_id
                                diag_entry["recognitionState"] = IdentityState.VERIFIED
                            else:
                                tr.identity_status = IdentityState.CANDIDATE
                                diag_entry["recognitionState"] = IdentityState.CANDIDATE
                        else:
                            tr.candidate_employee_id = emp_id
                            tr.candidate_employee_name = emp_name
                            tr.candidate_hits = 1
                            if sim >= 0.55 and qscore >= 0.85:
                                tr.employee_id = emp_id
                                tr.employee_name = emp_name
                                tr.identity_status = IdentityState.VERIFIED
                                tr.identity_confidence = sim
                                tr.identity_hits = 1
                                tr.verified_at = now
                                tr.last_biometric_at = now
                                active_identity_map[emp_id] = tr.track_id
                                diag_entry["recognitionState"] = IdentityState.VERIFIED
                            else:
                                tr.identity_status = IdentityState.CANDIDATE
                                diag_entry["recognitionState"] = IdentityState.CANDIDATE
                    else:
                        tr.identity_status = IdentityState.UNVERIFIED
                        diag_entry["recognitionState"] = IdentityState.UNVERIFIED

                    diagnostics.append(diag_entry)

        # -------------------------------------------------------------
        # 4. ILE — Update identity state machine for every active track
        # -------------------------------------------------------------
        # Build a map of track_id → face_match for tracks that got a face this frame
        track_face_map: Dict[int, Optional[dict]] = {tr.track_id: None for tr in active_tracks}
        for d_entry in diagnostics:
            tid = d_entry.get("trackId")
            if d_entry.get("suppressed"):
                continue  # refused above: that name is on another body, so don't let the latching engine use it
            if tid is not None:
                matched_emp_id = d_entry.get("matchedEmployeeId")
                if matched_emp_id:
                    track_face_map[tid] = {
                        "employee_id":   matched_emp_id,
                        "employee_name": d_entry.get("matchedEmployeeName", ""),
                        "employee_code": None,
                        "similarity":    d_entry.get("similarityScore", 0.0),
                        "quality_score": d_entry.get("faceQuality", 0.0),
                    }

        # Check path-crossing (IoU > 0.35 between two active tracks)
        for i, tr_a in enumerate(active_tracks):
            for tr_b in active_tracks[i+1:]:
                iou = compute_iou(tr_a.bbox, tr_b.bbox)
                if iou > 0.35:
                    self.ile.notify_path_crossing(tr_a.track_id, tr_b.track_id, now)

        for tr in active_tracks:
            ile_rec = self.ile.process_track_frame(
                track_id=tr.track_id,
                now=now,
                face_match=track_face_map.get(tr.track_id),
                track_state_active=True,
            )
            # Sync ILE result back onto the Track object
            tr.identity_state           = ile_rec.state
            tr.face_currently_visible   = ile_rec.face_currently_visible
            tr.tracking_without_face_sec = ile_rec.tracking_without_face_sec
            tr.last_face_seen_at        = ile_rec.last_face_seen_at

            # If ILE has a latched employee and legacy system doesn't, sync up
            if ile_rec.employee_id and not tr.employee_id:
                tr.employee_id   = ile_rec.employee_id
                tr.employee_name = ile_rec.employee_name
                tr.employee_code = ile_rec.employee_code
            # Promote legacy identity_status to new state naming
            if ile_rec.state == IdentityLatchState.IDENTITY_LATCHED:
                tr.identity_status = IdentityState.VERIFIED
            elif ile_rec.state == IdentityLatchState.TRACKING_WITHOUT_FACE:
                tr.identity_status = IdentityState.TRACKING_WITHOUT_FACE
            elif ile_rec.state == IdentityLatchState.TRACKING_UNCERTAIN:
                tr.identity_status = IdentityState.TRACKING_UNCERTAIN
            elif ile_rec.state == IdentityLatchState.REQUIRES_REVERIFICATION:
                tr.identity_status = IdentityState.REQUIRES_REVERIFICATION

        self._one_body_per_name(active_tracks, now)

        # -------------------------------------------------------------
        # 5. Zone Containment & Doorway Crossing Detection
        # -------------------------------------------------------------
        for tr in active_tracks:
            cx, cy = tr.center
            current_z = self.check_zone(cx, cy)
            if current_z:
                tr.current_zone_id = current_z

            if len(tr.history) < 2:
                continue

            p_prev = tr.history[-2]
            p_curr = tr.history[-1]

            # Check each doorway crossing line
            for line_cfg in self.lines:
                if not line_cfg.get("enabled", True):
                    continue

                line_id = line_cfg.get("lineId")
                # Debounce: avoid duplicate crossing events within 5 seconds for same track
                if now - tr.last_crossings.get(line_id, 0) < 5.0:
                    continue

                sp = line_cfg.get("normalizedStartPoint", [0, 0])
                ep = line_cfg.get("normalizedEndPoint", [1, 1])
                l_start = (sp[0] * self.width, sp[1] * self.height)
                l_end = (ep[0] * self.width, ep[1] * self.height)

                if line_intersect(p_prev, p_curr, l_start, l_end):
                    direction = crossing_direction(p_prev, p_curr, l_start, l_end)
                    mapping = line_cfg.get("directionMapping", {}).get(direction, {})
                    event_type = mapping.get("event")
                    from_z = mapping.get("from", "PASSAGE")
                    to_z = mapping.get("to", "UNKNOWN")

                    if event_type:
                        tr.last_crossings[line_id] = now
                        tr.current_zone_id = to_z
                        events.append(
                            {
                                "trackId": tr.track_id,
                                "employeeId": tr.employee_id,
                                "employeeName": tr.employee_name,
                                "crossingLineId": line_id,
                                "eventType": event_type,
                                "fromZoneId": from_z,
                                "toZoneId": to_z,
                                "identityStatus": tr.identity_status,
                                "observedAt": now,
                                "boundingBox": [
                                    round(
                                        float(v) / (self.width if i % 2 == 0 else self.height), 4
                                    )
                                    for i, v in enumerate(tr.bbox)
                                ],
                            }
                        )

        self.latest_diagnostics = diagnostics
        if return_diagnostics:
            return active_tracks, removed_tracks, events, diagnostics
        return active_tracks, removed_tracks, events
