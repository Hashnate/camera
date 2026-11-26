"""Desks: someone with a desk counts as in the office whenever a body sits at their desk, once they've checked in.

People who sit with their face turned from the camera, or behind someone, aren't recognised for many minutes, and in
a crowded spot the tracker swaps neighbours' body tracks several times an hour. So a desk doesn't name body tracks:
a track that swaps people would take the name with it (26 Nov: track 60466041 was Jawahar at his desk, then jumped to
Faris and carried Jawahar's name). Instead presence asks, for each moment, whether any body fits the desk
(desk_sightings), whoever the tracker thinks it is.

A body counts for a desk when it overlaps it by MIN_IOU and fits it clearly better (MARGIN) than any neighbour's desk
on that lens.

Desks live in SystemSetting "desks": {"desks": [{"employeeId", "cameraId", "channelNo", "box": [x1, y1, x2, y2]}]},
the box being where that person's body is normally seen, in 0-1 fractions of the picture. A person may have a desk on
each lens. Use lenses that don't move: a pan/tilt lens's desk boxes are wrong once it turns.
"""

import logging
from collections import defaultdict
from datetime import datetime

from sqlalchemy import and_, case, func, literal, or_, select, text

from app.models import PersonTrackSession, SystemSetting, TrackObservation

log = logging.getLogger("worksight.desks")

# identity_verification_status of names the old seat memory gave (until 26 Nov). They still count as presence (they
# include gaps filled by hand on 25 Nov); no new ones are made.
SEAT = "SEAT"
MIN_IOU = 0.40  # box overlap that counts as "at the desk"
MARGIN = 0.15  # the desk must fit this much better than a neighbour's desk on the same lens


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
            log.warning("[desks] ignoring a malformed desk entry: %r", d)
    return out


def _iou(box, d: list[float]):
    """IoU of an observation's box (SQL expressions) with a desk box, as a SQL expression."""
    x1, y1, x2, y2 = box
    inter = func.greatest(0.0, func.least(x2, d[2]) - func.greatest(x1, d[0])) * func.greatest(
        0.0, func.least(y2, d[3]) - func.greatest(y1, d[1])
    )
    union = (x2 - x1) * (y2 - y1) + (d[2] - d[0]) * (d[3] - d[1]) - inter
    return inter / func.nullif(union, 0.0)


def desk_sightings(db, employee_ids: set[str], start: datetime, end: datetime, sample_sec: int) -> list[tuple[str, datetime]]:
    """(employee id, time) for each sample_sec slot in [start, end) in which a body sat at that employee's desk."""
    out: list[tuple[str, datetime]] = []
    for (camera_id, channel_no), entries in load_desks(db).items():
        # The lens's boxes as four numbers, read from JSON once (MATERIALIZED: else each use below re-parses it).
        obs = (
            select(
                TrackObservation.observed_at.label("t"),
                *[TrackObservation.bounding_box[i].as_float().label(f"c{i}") for i in range(4)],
            )
            .join(PersonTrackSession, PersonTrackSession.id == TrackObservation.track_session_id)
            .where(
                PersonTrackSession.camera_id == camera_id,
                PersonTrackSession.channel_no == channel_no,
                TrackObservation.observed_at >= start,
                TrackObservation.observed_at < end,
            )
            .cte(f"desk_obs_{channel_no}")
            .prefix_with("MATERIALIZED")
        )
        box = [obs.c.c0, obs.c.c1, obs.c.c2, obs.c.c3]
        whens = []
        for emp, desk in entries:
            if emp not in employee_ids:
                continue
            mine = _iou(box, desk)
            rivals = [_iou(box, other) for e, other in entries if e != emp]
            whens.append((and_(mine >= MIN_IOU, *[or_(r < MIN_IOU, mine - r >= MARGIN) for r in rivals]), emp))
        if not whens:
            continue
        owner = case(*whens, else_=None).label("owner")
        bucket = func.date_bin(text(f"interval '{int(sample_sec)} seconds'"), obs.c.t, literal(datetime(2000, 1, 1)))
        rows = db.execute(select(owner, func.max(obs.c.t)).group_by(owner, bucket))
        out.extend((emp, t) for emp, t in rows if emp)
    return out
