"""Seat memory: keep a person's name on their body while they sit at their own desk.

The AI service names a body track while it can match the face, and for a short hand-over when a track breaks.
People who sit with their face turned from the camera, or partly behind someone, lose their name for many minutes,
and every AI restart clears all names. They then show as "away" while they sit at their desk.

Every RUN_EVERY_SEC this names unnamed body tracks from desks (SystemSetting "desks"). A body at a person's desk is
that person, once they have checked in. Desks are set for people who sit with their back to the camera, whose face
is never seen there. Desks also correct an earlier seat name.

Only desks, never "where someone was recognised earlier": on 25 Nov that rule named Jawahar's desk "Afham" (Afham
had been recognised standing next to it), and named strangers on the pan/tilt lens "Musni" while Musni was out.
It leaves a track unnamed when:
  - it was there before the person arrived (check-in),
  - it is a duplicate box of someone else who is face-recognised at that moment,
  - the person was recognised somewhere else on that lens at the same time (so this body is someone else),
  - it fits two desks about equally (neighbouring desks),
  - it was seen fewer than MIN_OBS times.

Names given here are marked identity_verification_status = "SEAT". A later face match replaces them (see the
tracking frame handler).

Desks: {"desks": [{"employeeId": ..., "cameraId": ..., "channelNo": 1, "box": [x1, y1, x2, y2]}]}, the box being
where that person's body is normally seen, in 0-1 fractions of the picture. Use the fixed lens: a pan/tilt lens
moves, and its desk boxes would move with it.
"""

import logging
import statistics
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select

from app.database import SessionLocal, utcnow
from app.models import AttendanceRecord, PersonTrackSession, SystemSetting, TrackObservation

log = logging.getLogger("worksight.seat_memory")

SEAT = "SEAT"  # identity_verification_status of a name given here
RUN_EVERY_SEC = 60
LOOKBACK = timedelta(hours=2)  # unnamed tracks seen this recently are considered on each run
FIRST_RUN_LOOKBACK = timedelta(hours=14)  # after a backend restart, catch up on the whole working day
CONTEXT = timedelta(minutes=10)  # also load this much before the lookback, for the clash checks
MIN_IOU = 0.40  # box overlap that counts as "at the desk"
DUPLICATE_IOU = 0.65  # an unnamed box this close to someone else's named box at the same moment is them
MARGIN = 0.15  # the best-fitting person must fit this much better than the next
MIN_OBS = 3


def _iou(a: list[float], b: list[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _median_box(boxes: list[list[float]]) -> list[float]:
    return [statistics.median(b[i] for b in boxes) for i in range(4)]


@dataclass
class _Track:
    id: str
    lens: tuple[str, int]
    employee_id: Optional[str]
    seat_named: bool
    obs: list[tuple[datetime, list[float]]] = field(default_factory=list)

    def finish(self) -> None:
        self.obs.sort(key=lambda o: o[0])
        self.t0, self.t1 = self.obs[0][0], self.obs[-1][0]
        self.box = _median_box([b for _, b in self.obs])

    def box_during(self, t0: datetime, t1: datetime) -> Optional[list[float]]:
        boxes = [b for t, b in self.obs if t0 <= t <= t1]
        return _median_box(boxes) if boxes else None


def load_desks(db) -> dict[tuple[str, int], list[tuple[str, list[float]]]]:
    """{(camera id, channel): [(employee id, box), ...]} from SystemSetting "desks"."""
    row = db.get(SystemSetting, "desks")
    out: dict[tuple[str, int], list] = defaultdict(list)
    for d in ((row.value or {}).get("desks") or []) if row else []:
        try:
            box = [float(v) for v in d["box"]]
            if len(box) == 4 and box[0] < box[2] and box[1] < box[3]:
                out[(d["cameraId"], int(d["channelNo"]))].append((d["employeeId"], box))
        except (KeyError, TypeError, ValueError):
            log.warning("[seat memory] ignoring a malformed desk entry: %r", d)
    return out


def _best(fit: dict[str, float]) -> Optional[str]:
    """The person who clearly fits best (>= MIN_IOU and MARGIN ahead of the next), else None."""
    ranked = sorted(((v, e) for e, v in fit.items() if v >= MIN_IOU), reverse=True)
    if not ranked or (len(ranked) > 1 and ranked[0][0] - ranked[1][0] < MARGIN):
        return None
    return ranked[0][1]


def assign(db, now: datetime, lookback: timedelta = LOOKBACK) -> dict[str, str]:
    """Work out seat names for recent tracks that are unnamed (or seat-named, which desks may correct):
    {track session id: employee id}, only where that changes the name. Doesn't write."""
    since = now - lookback - CONTEXT
    desks = load_desks(db)
    rows = db.execute(
        select(
            PersonTrackSession.id,
            PersonTrackSession.camera_id,
            PersonTrackSession.channel_no,
            PersonTrackSession.employee_id,
            PersonTrackSession.identity_verification_status,
            TrackObservation.observed_at,
            TrackObservation.bounding_box,
        )
        .join(TrackObservation, TrackObservation.track_session_id == PersonTrackSession.id)
        .where(TrackObservation.observed_at >= since)
    ).all()
    tracks: dict[str, _Track] = {}
    for sid, cam, ch, emp, status, t, box in rows:
        if not box or len(box) != 4:
            continue
        tr = tracks.get(sid) or tracks.setdefault(sid, _Track(sid, (cam, ch), emp, status == SEAT))
        tr.obs.append((t, [float(v) for v in box]))
    for tr in tracks.values():
        tr.finish()

    # Names the AI gave (face match or its own short hand-over); seat names are never evidence for other seat names.
    named_by_lens: dict[tuple, list[_Track]] = defaultdict(list)
    for tr in tracks.values():
        if tr.employee_id and not tr.seat_named:
            named_by_lens[tr.lens].append(tr)

    check_in: dict[tuple[str, str], datetime] = {}
    for rec in db.scalars(select(AttendanceRecord).where(AttendanceRecord.check_in >= since - timedelta(days=1))):
        check_in[(rec.employee_id, rec.date)] = rec.check_in

    out: dict[str, str] = {}
    for c in tracks.values():
        if (c.employee_id and not c.seat_named) or len(c.obs) < MIN_OBS or c.t1 < now - lookback:
            continue
        named = named_by_lens.get(c.lens, [])

        # At someone's desk? Their desk decides (and corrects an earlier seat name).
        desk_fit: dict[str, float] = {}
        for emp_id, box in desks.get(c.lens, []):
            desk_fit[emp_id] = max(desk_fit.get(emp_id, 0.0), _iou(c.box, box))
        emp = _best(desk_fit)
        if emp is None or emp == c.employee_id:
            continue

        arrived = check_in.get((emp, c.t0.date().isoformat()))  # same day key as attendance.record_date()
        if arrived is None or c.t0 < arrived - timedelta(minutes=1):
            continue

        clash = False
        for o in named:
            if o.t1 < c.t0 or o.t0 > c.t1:
                continue
            during = o.box_during(c.t0, c.t1)
            if during is None:
                continue
            overlap = _iou(c.box, during)
            if o.employee_id != emp and overlap >= DUPLICATE_IOU:
                clash = True  # a second box of someone else who is named right there
            elif o.employee_id == emp and not o.seat_named and overlap < MIN_IOU:
                clash = True  # the person was recognised elsewhere on this lens at the same time
            if clash:
                break
        if not clash:
            out[c.id] = emp
    return out


def run_once(lookback: timedelta = LOOKBACK) -> int:
    with SessionLocal() as db:
        names = assign(db, utcnow(), lookback)
        for sid, emp in names.items():
            tr = db.get(PersonTrackSession, sid)
            # skip if the AI named it meanwhile
            if tr is not None and (tr.employee_id is None or tr.identity_verification_status == SEAT):
                tr.employee_id = emp
                tr.identity_verification_status = SEAT
        db.commit()
    return len(names)


def _loop() -> None:
    lookback = FIRST_RUN_LOOKBACK
    while True:
        try:
            n = run_once(lookback)
            if n:
                log.info("[seat memory] named %d body track(s) at their owner's desk", n)
            lookback = LOOKBACK
        except Exception:
            log.exception("[seat memory] run failed")
        time.sleep(RUN_EVERY_SEC)


def start() -> None:
    threading.Thread(target=_loop, daemon=True, name="seat-memory").start()
