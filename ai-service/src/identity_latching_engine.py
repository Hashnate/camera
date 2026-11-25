"""WorkSight v2.9 — Identity Latching Engine (ILE).

Implements an 8-state identity state machine that:
1. Latches a verified employee UUID to a ByteTrack person track.
2. Preserves the identity when the employee's face becomes invisible.
3. Protects against identity hijacking by stray faces.
4. Enforces one-to-one employee ↔ track exclusivity per camera context.

States
------
UNVERIFIED            No face seen yet, or low-quality face.
IDENTITY_CANDIDATE    1 biometric hit above threshold, awaiting confirmation.
IDENTITY_LATCHED      2+ hits confirmed, employee UUID attached to track.
TRACKING_WITHOUT_FACE Face not visible in current frame, identity preserved.
TRACKING_UNCERTAIN    Path-crossing or IoU-conflict detected, identity suspect.
REQUIRES_REVERIFICATION  5 consecutive conflicting face frames broke the latch.
LOST                  Track lost by ByteTracker, waiting for recovery.
REMOVED               Track permanently gone.
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

log = logging.getLogger("ai.identity_latching")


# ---------------------------------------------------------------------------
# State constants
# ---------------------------------------------------------------------------

class IdentityLatchState:
    UNVERIFIED            = "UNVERIFIED"
    IDENTITY_CANDIDATE    = "IDENTITY_CANDIDATE"
    IDENTITY_LATCHED      = "IDENTITY_LATCHED"
    TRACKING_WITHOUT_FACE = "TRACKING_WITHOUT_FACE"
    TRACKING_UNCERTAIN    = "TRACKING_UNCERTAIN"
    REQUIRES_REVERIFICATION = "REQUIRES_REVERIFICATION"
    LOST                  = "LOST"
    REMOVED               = "REMOVED"


# ---------------------------------------------------------------------------
# Thresholds (tune these for your camera without touching other files)
# ---------------------------------------------------------------------------

CANDIDATE_SIM_THRESHOLD   = 0.46   # Min similarity for a candidate hit
CANDIDATE_QUALITY_MIN     = 0.55   # Min face-quality score
LATCH_REQUIRED_HITS       = 2      # Hits needed to latch (within LATCH_WINDOW_SEC)
LATCH_WINDOW_SEC          = 10.0   # Window in which hits are counted
FAST_LATCH_SIM            = 0.60   # Single-frame latch if sim ≥ this AND quality ≥ FAST_LATCH_QUALITY
FAST_LATCH_QUALITY        = 0.85
CONFLICT_THRESHOLD        = 5      # Consecutive conflicting frames before reverification
UNCERTAINTY_ITERS         = 30     # Frames without face before TRACKING_UNCERTAIN
FACE_VISIBLE_GRACE_FRAMES = 4      # Frames face must be absent before switching to TWF state
REVERIFICATION_TIMEOUT    = 20.0   # Seconds in REQUIRES_REVERIFICATION before downgrade to UNVERIFIED


# ---------------------------------------------------------------------------
# Per-track identity record
# ---------------------------------------------------------------------------

@dataclass
class IdentityRecord:
    """All identity state for one person track."""

    track_id: int

    # Latched identity
    employee_id:   Optional[str] = None
    employee_name: Optional[str] = None
    employee_code: Optional[str] = None
    identity_confidence: float   = 0.0
    verified_at:   Optional[float] = None
    last_face_seen_at: Optional[float] = None

    # Candidate accumulation
    candidate_employee_id:   Optional[str] = None
    candidate_employee_name: Optional[str] = None
    candidate_employee_code: Optional[str] = None
    candidate_hits: int = 0
    candidate_window_hits: List[float] = field(default_factory=list)  # timestamps

    # State machine
    state: str = IdentityLatchState.UNVERIFIED
    conflict_hits: int = 0
    frames_without_face: int = 0
    reverification_started_at: Optional[float] = None

    # Diagnostic
    face_currently_visible: bool = False
    tracking_without_face_sec: float = 0.0
    last_state_change: float = field(default_factory=time.time)

    def transition(self, new_state: str, now: float):
        if self.state != new_state:
            log.debug(
                "[ILE] Track #%d: %s → %s (emp=%s)",
                self.track_id, self.state, new_state, self.employee_id or "?"
            )
            self.state = new_state
            self.last_state_change = now


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class IdentityLatchingEngine:
    """
    Manages IdentityRecord objects for all active tracks.

    Call process_track_frame() once per track per detection cycle.
    Call mark_track_lost() / mark_track_removed() on lifecycle events.
    """

    def __init__(self):
        # track_id → IdentityRecord
        self._records: Dict[int, IdentityRecord] = {}
        # employee_id → track_id  (exclusivity map — one UUID per track)
        self._active_latches: Dict[str, int] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_or_create(self, track_id: int) -> IdentityRecord:
        if track_id not in self._records:
            self._records[track_id] = IdentityRecord(track_id=track_id)
        return self._records[track_id]

    def process_track_frame(
        self,
        track_id: int,
        now: float,
        face_match: Optional[Dict],          # None if no face visible for this track
        track_state_active: bool = True,
    ) -> IdentityRecord:
        """
        Update identity state for one track in this frame.

        Parameters
        ----------
        track_id        : ByteTrack track ID
        now             : current unix timestamp
        face_match      : dict with keys employee_id, employee_name, employee_code,
                          similarity, quality_score  — OR None if no face seen
        track_state_active : False when ByteTracker marks this track as LOST
        """
        rec = self.get_or_create(track_id)

        # --- Handle ByteTrack LOST ---
        if not track_state_active:
            if rec.state not in (IdentityLatchState.LOST, IdentityLatchState.REMOVED):
                rec.transition(IdentityLatchState.LOST, now)
            return rec

        # Recover from LOST if track is active again
        if rec.state == IdentityLatchState.LOST:
            # Restore previous latched state if still fresh
            if rec.employee_id and rec.verified_at and (now - rec.verified_at < 30.0):
                rec.transition(IdentityLatchState.TRACKING_WITHOUT_FACE, now)
            else:
                rec.transition(IdentityLatchState.UNVERIFIED, now)

        # --- REQUIRES_REVERIFICATION timeout ---
        if rec.state == IdentityLatchState.REQUIRES_REVERIFICATION:
            if rec.reverification_started_at and (now - rec.reverification_started_at > REVERIFICATION_TIMEOUT):
                self._clear_latch(rec)
                rec.transition(IdentityLatchState.UNVERIFIED, now)

        # --- Face visible or not? ---
        face_visible = face_match is not None
        rec.face_currently_visible = face_visible

        if face_visible:
            rec.last_face_seen_at = now
            rec.frames_without_face = 0
            rec.tracking_without_face_sec = 0.0
            self._handle_face_visible(rec, face_match, now)
        else:
            rec.frames_without_face += 1
            if rec.last_face_seen_at:
                rec.tracking_without_face_sec = round(now - rec.last_face_seen_at, 1)
            self._handle_no_face(rec, now)

        return rec

    def mark_track_removed(self, track_id: int, now: float):
        """Call when ByteTracker permanently removes a track."""
        if track_id in self._records:
            rec = self._records[track_id]
            if rec.employee_id and self._active_latches.get(rec.employee_id) == track_id:
                del self._active_latches[rec.employee_id]
            rec.transition(IdentityLatchState.REMOVED, now)

    def release_track(self, track_id: int, now: float):
        """Take the name off a track that stays alive (the same person can't be on two bodies at once)."""
        rec = self._records.get(track_id)
        if rec is None:
            return
        self._clear_latch(rec)
        rec.candidate_employee_id = rec.candidate_employee_name = rec.candidate_employee_code = None
        rec.candidate_hits = 0
        rec.candidate_window_hits = []
        rec.conflict_hits = 0
        rec.transition(IdentityLatchState.UNVERIFIED, now)

    def notify_path_crossing(self, track_id_a: int, track_id_b: int, now: float):
        """Call when two tracks' bounding boxes overlap significantly (IoU > 0.3)."""
        for tid in (track_id_a, track_id_b):
            if tid in self._records:
                rec = self._records[tid]
                if rec.state == IdentityLatchState.IDENTITY_LATCHED:
                    rec.transition(IdentityLatchState.TRACKING_UNCERTAIN, now)
                elif rec.state == IdentityLatchState.TRACKING_WITHOUT_FACE:
                    rec.transition(IdentityLatchState.TRACKING_UNCERTAIN, now)

    def get_active_latches(self) -> Dict[str, int]:
        """Return {employee_id: track_id} for all currently latched employees."""
        return dict(self._active_latches)

    def all_records(self) -> Dict[int, IdentityRecord]:
        return self._records

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _handle_face_visible(self, rec: IdentityRecord, face_match: Dict, now: float):
        emp_id   = face_match.get("employee_id")
        emp_name = face_match.get("employee_name", "")
        emp_code = face_match.get("employee_code")
        sim      = float(face_match.get("similarity", 0.0))
        quality  = float(face_match.get("quality_score", 0.0))

        # Reset conflict counter when no match (unidentified face)
        if not emp_id:
            if rec.state in (
                IdentityLatchState.IDENTITY_LATCHED,
                IdentityLatchState.TRACKING_WITHOUT_FACE,
                IdentityLatchState.TRACKING_UNCERTAIN,
            ):
                # Unidentified face in frame — not a conflict, just back to TWF state if latched
                if rec.state == IdentityLatchState.TRACKING_UNCERTAIN:
                    rec.transition(IdentityLatchState.TRACKING_WITHOUT_FACE, now)
            return

        # --- CONFLICT CHECK (latched to different employee) ---
        if rec.employee_id and emp_id != rec.employee_id:
            rec.conflict_hits += 1
            log.debug(
                "[ILE] Track #%d: conflict hit %d/5 (latched=%s, challenger=%s, sim=%.3f)",
                rec.track_id, rec.conflict_hits, rec.employee_id, emp_id, sim
            )
            if rec.conflict_hits >= CONFLICT_THRESHOLD:
                # Enough evidence to break the latch
                self._clear_latch(rec)
                rec.conflict_hits = 0
                rec.reverification_started_at = now
                rec.transition(IdentityLatchState.REQUIRES_REVERIFICATION, now)
            return  # Do not promote challenger yet

        # Reset conflict counter on matching face
        if emp_id == rec.employee_id:
            rec.conflict_hits = 0

        # Minimum quality gate
        if quality < CANDIDATE_QUALITY_MIN or sim < CANDIDATE_SIM_THRESHOLD:
            return

        # --- ALREADY LATCHED to this employee ---
        if rec.state == IdentityLatchState.IDENTITY_LATCHED and rec.employee_id == emp_id:
            rec.identity_confidence = max(rec.identity_confidence, sim)
            rec.last_face_seen_at = now
            return

        # --- RECOVERY: face seen again after TWF/UNCERTAIN ---
        if rec.state in (
            IdentityLatchState.TRACKING_WITHOUT_FACE,
            IdentityLatchState.TRACKING_UNCERTAIN,
            IdentityLatchState.REQUIRES_REVERIFICATION,
        ) and rec.employee_id == emp_id:
            rec.identity_confidence = max(rec.identity_confidence, sim)
            rec.conflict_hits = 0
            rec.reverification_started_at = None
            rec.transition(IdentityLatchState.IDENTITY_LATCHED, now)
            self._active_latches[emp_id] = rec.track_id
            return

        # --- EXCLUSIVITY: reject if another track already has this employee latched ---
        existing_track = self._active_latches.get(emp_id)
        if existing_track and existing_track != rec.track_id:
            log.debug(
                "[ILE] Track #%d: exclusivity block — %s already latched to Track #%d",
                rec.track_id, emp_id, existing_track
            )
            return

        # --- FAST LATCH: single high-confidence frame ---
        if sim >= FAST_LATCH_SIM and quality >= FAST_LATCH_QUALITY:
            self._do_latch(rec, emp_id, emp_name, emp_code, sim, now)
            return

        # --- CANDIDATE ACCUMULATION ---
        if rec.candidate_employee_id == emp_id:
            # Prune hits outside window
            rec.candidate_window_hits = [t for t in rec.candidate_window_hits if now - t <= LATCH_WINDOW_SEC]
            rec.candidate_window_hits.append(now)
            rec.candidate_hits += 1

            if len(rec.candidate_window_hits) >= LATCH_REQUIRED_HITS:
                self._do_latch(rec, emp_id, emp_name, emp_code, sim, now)
            else:
                rec.transition(IdentityLatchState.IDENTITY_CANDIDATE, now)
        else:
            # New candidate — reset
            rec.candidate_employee_id   = emp_id
            rec.candidate_employee_name = emp_name
            rec.candidate_employee_code = emp_code
            rec.candidate_hits          = 1
            rec.candidate_window_hits   = [now]
            rec.transition(IdentityLatchState.IDENTITY_CANDIDATE, now)

    def _handle_no_face(self, rec: IdentityRecord, now: float):
        """Face not detected in this track's region this frame."""
        if rec.state == IdentityLatchState.IDENTITY_LATCHED:
            if rec.frames_without_face >= FACE_VISIBLE_GRACE_FRAMES:
                rec.transition(IdentityLatchState.TRACKING_WITHOUT_FACE, now)
        elif rec.state == IdentityLatchState.TRACKING_UNCERTAIN:
            # Remains uncertain until path crossing resolves
            pass
        elif rec.state == IdentityLatchState.TRACKING_WITHOUT_FACE:
            # Count frames; optionally escalate to UNCERTAIN after long absence
            if rec.frames_without_face > UNCERTAINTY_ITERS * 5:  # ~150 frames
                rec.transition(IdentityLatchState.TRACKING_UNCERTAIN, now)

    def _do_latch(
        self,
        rec: IdentityRecord,
        emp_id: str,
        emp_name: str,
        emp_code: Optional[str],
        sim: float,
        now: float,
    ):
        # Release any previous latch
        if rec.employee_id and rec.employee_id != emp_id:
            self._clear_latch(rec)

        rec.employee_id         = emp_id
        rec.employee_name       = emp_name
        rec.employee_code       = emp_code
        rec.identity_confidence = sim
        rec.verified_at         = now
        rec.last_face_seen_at   = now
        rec.candidate_hits      = 0
        rec.candidate_window_hits = []
        rec.conflict_hits       = 0

        self._active_latches[emp_id] = rec.track_id
        rec.transition(IdentityLatchState.IDENTITY_LATCHED, now)

        log.info(
            "[ILE] ✅ LATCHED Track #%d → %s (%s) sim=%.3f",
            rec.track_id, emp_name, emp_id, sim
        )

    def _clear_latch(self, rec: IdentityRecord):
        if rec.employee_id and self._active_latches.get(rec.employee_id) == rec.track_id:
            del self._active_latches[rec.employee_id]
        rec.employee_id         = None
        rec.employee_name       = None
        rec.employee_code       = None
        rec.identity_confidence = 0.0
        rec.verified_at         = None
