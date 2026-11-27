"""Headcount check: a desk can't keep someone "in" when the room holds fewer people than that.

Desks (app.services.desks) count anyone sitting at a person's desk. A stray detection there (someone walking past,
a chair, part of the person in front) can then keep a person "in" while they are out: on 26 Nov a detection every
2-4 minutes at Faris's desk carried him through lunch. So each minute, the lens that sees the whole room counts the
bodies in it. If it sees fewer bodies than there are people with evidence in that minute, people whose only
evidence is a desk are dropped for that minute, weakest desk evidence first, until the numbers match.

Solid desk evidence is never dropped: a body that fit the desk for most of the minute (SOLID_FRAMES) is the person
sitting there, whatever the count says. On 27 Nov the count (2 bodies) was lower than the claims because a late face
match had put Muhfees's name on Jawahar's own body and a colleague seen only on lens 2 was hidden on lens 1, and the
check dropped Jawahar, who sat at his desk in every frame from 8:43 to 9:02. Flicker (a stray box every few minutes,
part of the person in front) stays below SOLID_FRAMES, so that is still what gets dropped.

The check only removes desk evidence: it never adds presence and never overrides a face or a body the AI named.
Extra bodies (visitors, staff who aren't enrolled, one person detected as two boxes) make the count high, so it
errs toward changing nothing. It can't say who is missing, only how many, which is why it only acts on desks.

Configured in SystemSetting "headcount": {"cameraId", "channelNo", "minArea"}: the lens that sees the whole room
(a fixed one) and the smallest box area, as a fraction of the picture, that counts as a person. No setting: off.
"""

import logging
import math
from collections import defaultdict
from datetime import datetime

from sqlalchemy import func, literal, select, text

from app.models import PersonTrackSession, SystemSetting, TrackObservation

log = logging.getLogger("worksight.headcount")

WINDOW_SEC = 5  # bodies are counted per 5-s window (distinct tracks), then the minute takes the median window
DEFAULT_MIN_AREA = 0.004
# Desk frames in a minute that make the desk evidence solid: about two-thirds of the minute at the AI's current
# rate on the room lens (~18 frames a minute per body). Raise it if that rate goes up.
SOLID_FRAMES = 12


def minute(t: datetime) -> datetime:
    return t.replace(second=0, microsecond=0)


def config(db) -> dict | None:
    row = db.get(SystemSetting, "headcount")
    v = (row.value or {}) if row else {}
    if not v.get("cameraId") or v.get("channelNo") is None:
        return None
    return v


def room_counts(db, cfg: dict, start: datetime, end: datetime) -> dict[datetime, float]:
    """{minute: median number of bodies the room lens saw in that minute's 5-s windows}."""
    b = [TrackObservation.bounding_box[i].as_float() for i in range(4)]
    area = (b[2] - b[0]) * (b[3] - b[1])
    w5 = func.date_bin(text(f"interval '{WINDOW_SEC} seconds'"), TrackObservation.observed_at, literal(datetime(2000, 1, 1)))
    windows = (
        select(w5.label("w5"), func.count(func.distinct(PersonTrackSession.track_id)).label("n"))
        .join(PersonTrackSession, PersonTrackSession.id == TrackObservation.track_session_id)
        .where(
            PersonTrackSession.camera_id == cfg["cameraId"],
            PersonTrackSession.channel_no == int(cfg["channelNo"]),
            TrackObservation.observed_at >= start,
            TrackObservation.observed_at < end,
            area >= float(cfg.get("minArea") or DEFAULT_MIN_AREA),
        )
        .group_by(w5)
        .subquery()
    )
    m = func.date_bin(text("interval '60 seconds'"), windows.c.w5, literal(datetime(2000, 1, 1)))
    rows = db.execute(select(m, func.percentile_cont(0.5).within_group(windows.c.n.asc())).group_by(m))
    return {t: float(n) for t, n in rows}


def drop_unseen(
    db, desk_rows: list[tuple[str, datetime, int]], strong: set[tuple[str, datetime]], start: datetime, end: datetime
) -> list[tuple[str, datetime]]:
    """Desk sightings (employee, time, frames) the room count supports, as (employee, time).

    strong: (employee, minute) pairs with a face sighting or a named body, which always stand.
    """
    cfg = config(db) if desk_rows else None
    if not cfg:
        return [(e, t) for e, t, _ in desk_rows]
    counts = room_counts(db, cfg, start, end)

    desk_by_min: dict[datetime, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for e, t, n in desk_rows:
        desk_by_min[minute(t)][e] += n
    strong_by_min: dict[datetime, set[str]] = defaultdict(set)
    for e, m in strong:
        strong_by_min[m].add(e)

    drop: set[tuple[str, datetime]] = set()
    for m, deskers in desk_by_min.items():
        room = counts.get(m)
        if room is None:  # the room lens saw nothing countable this minute (e.g. the desk is on another lens)
            continue
        claimed = strong_by_min[m] | set(deskers)
        excess = len(claimed) - math.ceil(room)
        if excess <= 0:
            continue
        weakest = sorted((n, e) for e, n in deskers.items() if e not in strong_by_min[m] and n < SOLID_FRAMES)
        for _, e in weakest[:excess]:
            drop.add((e, m))
    if drop:
        log.debug("[headcount] dropped %d desk-minutes the room count doesn't support", len(drop))
    return [(e, t) for e, t, _ in desk_rows if (e, minute(t)) not in drop]
