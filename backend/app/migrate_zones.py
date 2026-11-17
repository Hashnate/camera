"""Migration script for WorkSight Zone Tracking & Doorway Crossing tables."""

from app.database import Base, engine, SessionLocal
from app.models import Camera, CameraZoneConfiguration, DoorCrossingLine
import app.models

CAM_ID = "887cdce1-b07c-4048-8991-60b818b33225"

DEFAULT_ZONES = [
    {
        "zoneId": "WORK_ROOM",
        "zoneName": "Working Room (Desk Cluster)",
        "polygon": [
            [0.13, 0.63], [0.27, 0.63], [0.39, 0.63], [0.49, 0.57],
            [0.74, 0.57], [0.83, 0.88], [0.36, 1.0], [0.13, 0.83]
        ]
    },
    {
        "zoneId": "PASSAGE",
        "zoneName": "Shared Passage & Central Walkway",
        "polygon": [
            [0.26, 0.67], [0.38, 0.69], [0.49, 0.57], [0.78, 0.60],
            [0.96, 0.97], [0.78, 1.0], [0.47, 1.0], [0.34, 0.79]
        ]
    },
    {
        "zoneId": "LUNCH_ROOM",
        "zoneName": "Lunch Room Doorway Area",
        "polygon": [
            [0.24, 0.38], [0.38, 0.39], [0.39, 0.69], [0.25, 0.67]
        ]
    },
    {
        "zoneId": "MAIN_EXIT",
        "zoneName": "Outside Exit & Suite Aisle",
        "polygon": [
            [0.75, 0.70], [1.0, 0.85], [1.0, 1.0], [0.75, 1.0]
        ]
    },
]

DEFAULT_LINES = [
    {
        "lineId": "LINE_LUNCH",
        "lineName": "Lunch Room Doorway (Left Blue Wall)",
        "start": [0.370, 0.606],
        "end": [0.266, 0.593],
        "directionMapping": {
            "forward": {"event": "LUNCH_ROOM_ENTERED", "from": "PASSAGE", "to": "LUNCH_ROOM"},
            "backward": {"event": "LUNCH_ROOM_EXITED", "from": "LUNCH_ROOM", "to": "PASSAGE"}
        }
    },
    {
        "lineId": "LINE_WORK",
        "lineName": "Working Room Entrance (Aisle Boundary)",
        "start": [0.391, 0.722],
        "end": [0.740, 0.667],
        "directionMapping": {
            "forward": {"event": "WORK_ROOM_ENTERED", "from": "PASSAGE", "to": "WORK_ROOM"},
            "backward": {"event": "WORK_ROOM_EXITED", "from": "WORK_ROOM", "to": "PASSAGE"}
        }
    },
    {
        "lineId": "LINE_EXIT",
        "lineName": "Outside Exit Doorway (Right Corridor)",
        "start": [0.771, 0.787],
        "end": [0.979, 0.944],
        "directionMapping": {
            "forward": {"event": "OFFICE_ENTRY_OBSERVED", "from": "MAIN_EXIT", "to": "PASSAGE"},
            "backward": {"event": "OFFICE_EXIT_OBSERVED", "from": "PASSAGE", "to": "MAIN_EXIT"}
        }
    }
]

def migrate():
    print("1. Creating tracking and zone tables...")
    Base.metadata.create_all(engine)
    print("Tables created.")

    print("2. Seeding default zone and line configuration for Channel 1...")
    with SessionLocal() as db:
        cam = db.query(Camera).filter(Camera.id == CAM_ID).first()
        if not cam:
            cam = db.query(Camera).first()
        if not cam:
            print("No camera found in database to associate zones with.")
            return

        for z in DEFAULT_ZONES:
            existing = db.query(CameraZoneConfiguration).filter(
                CameraZoneConfiguration.camera_id == cam.id,
                CameraZoneConfiguration.channel_no == 1,
                CameraZoneConfiguration.zone_id == z["zoneId"]
            ).first()
            if not existing:
                db.add(CameraZoneConfiguration(
                    camera_id=cam.id,
                    channel_no=1,
                    zone_id=z["zoneId"],
                    zone_name=z["zoneName"],
                    normalized_polygon=z["polygon"],
                    enabled=True,
                    configuration_version=1
                ))

        for l in DEFAULT_LINES:
            existing_line = db.query(DoorCrossingLine).filter(
                DoorCrossingLine.camera_id == cam.id,
                DoorCrossingLine.channel_no == 1,
                DoorCrossingLine.line_id == l["lineId"]
            ).first()
            if existing_line:
                existing_line.normalized_start_point = l["start"]
                existing_line.normalized_end_point = l["end"]
                existing_line.direction_mapping = l["directionMapping"]
            else:
                db.add(DoorCrossingLine(
                    camera_id=cam.id,
                    channel_no=1,
                    line_id=l["lineId"],
                    line_name=l["lineName"],
                    normalized_start_point=l["start"],
                    normalized_end_point=l["end"],
                    direction_mapping=l["directionMapping"],
                    enabled=True
                ))

        db.commit()
    print("Migration and default calibration seeding complete!")

if __name__ == "__main__":
    migrate()
