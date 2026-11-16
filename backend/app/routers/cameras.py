import logging

from fastapi import APIRouter, Depends
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import (
    Camera,
    CameraChannel,
    CameraEvent,
    CameraProviderType,
    CameraStatus,
    Office,
)
from app.providers.ezviz import ezviz_provider
from app.security import current_user
from app.serialize import ser, ser_all, value

log = logging.getLogger("worksight.cameras")

router = APIRouter(prefix="/api/cameras", tags=["cameras"], dependencies=[Depends(current_user)])


def _channels(db: Session, camera_id: str) -> list[CameraChannel]:
    return db.scalars(
        select(CameraChannel).where(CameraChannel.camera_id == camera_id).order_by(CameraChannel.channel_no.asc())
    ).all()


def _get_or_404(db: Session, camera_id: str) -> Camera:
    camera = db.get(Camera, camera_id)
    if not camera:
        raise ApiError(404, "Camera not found")
    return camera


@router.get("")
def list_cameras(db: Session = Depends(get_db)):
    cameras = db.scalars(select(Camera).order_by(Camera.created_at.desc())).all()
    data = [
        ser(
            c,
            channels=ser_all(_channels(db, c.id)),
            office=ser(c.office, only=("id", "name", "address")),
        )
        for c in cameras
    ]
    return {"success": True, "count": len(data), "data": data}


@router.post("/sync-ezviz")
def sync_ezviz(db: Session = Depends(get_db)):
    """Synchronize camera list and status from the EZVIZ Open Platform."""
    devices = ezviz_provider.get_device_list(0, 50)

    office = db.scalar(select(Office).limit(1))
    if not office:
        raise ApiError(400, "No office found. Please create an office first.")

    synced = []
    for dev in devices:
        is_online = dev.status == 1
        camera = db.scalar(select(Camera).where(Camera.serial_number == dev.device_serial))
        if camera is None:
            camera = Camera(
                office_id=office.id,
                serial_number=dev.device_serial,
                provider=CameraProviderType.EZVIZ,
                location="Office Main Hall",
            )
            db.add(camera)
        camera.name = dev.device_name or f"EZVIZ {dev.device_type}"
        camera.model = dev.device_type
        camera.status = CameraStatus.ONLINE if is_online else CameraStatus.OFFLINE
        camera.firmware_ver = dev.device_version
        if is_online:
            camera.last_online_at = utcnow()
        db.flush()

        # Channels, e.g. 1 = wide lens, 2 = pan-tilt.
        try:
            for ch in ezviz_provider.get_camera_channels(dev.device_serial):
                channel = db.scalar(
                    select(CameraChannel).where(
                        CameraChannel.camera_id == camera.id, CameraChannel.channel_no == ch.channel_no
                    )
                )
                if channel is None:
                    channel = CameraChannel(camera_id=camera.id, channel_no=ch.channel_no)
                    db.add(channel)
                channel.channel_name = ch.channel_name
                channel.is_encrypted = ch.is_encrypt == 1
                channel.status = ch.status
                channel.snapshot_url = ch.pic_url
            db.flush()
        except Exception as exc:
            log.warning("[SyncEZVIZ] Could not sync channels for %s: %s", dev.device_serial, exc)

        synced.append(camera)

    db.commit()
    return {
        "success": True,
        "message": f"Successfully synchronized {len(synced)} device(s) with EZVIZ Open Platform",
        "data": ser_all(synced),
    }


@router.get("/{camera_id}")
def get_camera(camera_id: str, db: Session = Depends(get_db)):
    camera = _get_or_404(db, camera_id)
    events = db.scalars(
        select(CameraEvent)
        .where(CameraEvent.camera_id == camera.id)
        .order_by(CameraEvent.timestamp.desc())
        .limit(10)
    ).all()
    return {
        "success": True,
        "data": ser(
            camera, channels=ser_all(_channels(db, camera.id)), office=ser(camera.office), events=ser_all(events)
        ),
    }


@router.get("/{camera_id}/status")
def camera_status(camera_id: str, db: Session = Depends(get_db)):
    camera = _get_or_404(db, camera_id)
    is_online, raw_status = ezviz_provider.get_connection_status(camera.serial_number)
    new_status = CameraStatus.ONLINE if is_online else CameraStatus.OFFLINE
    last_online_before = camera.last_online_at

    if camera.status != new_status:
        camera.status = new_status
        if is_online:
            camera.last_online_at = utcnow()
        db.add(
            CameraEvent(
                camera_id=camera.id,
                event_type="CONNECTED" if is_online else "DISCONNECTED",
                message=f"Camera status transitioned to {new_status.value} (raw: {raw_status})",
            )
        )
        db.commit()

    return {
        "success": True,
        "data": {
            "id": camera.id,
            "serialNumber": camera.serial_number,
            "isOnline": is_online,
            "status": new_status.value,
            # Value from before this check, as the original API returned.
            "lastOnlineAt": value(last_online_before),
        },
    }


@router.api_route("/{camera_id}/stream", methods=["GET", "POST"])
def stream_url(camera_id: str, channel: int = 1, protocol: int = 2, db: Session = Depends(get_db)):
    """Authorized live stream URL from EZVIZ. protocol 2 = HLS (default), 1 = ezopen."""
    camera = _get_or_404(db, camera_id)
    if camera.provider != CameraProviderType.EZVIZ:
        raise ApiError(
            400,
            f"Provider {camera.provider.value} live streaming is not currently supported. Only EZVIZ is integrated.",
        )

    try:
        result = ezviz_provider.get_stream_url(camera.serial_number, channel, protocol)
    except Exception as exc:
        log.error("[getStreamUrl] Error: %s", exc)
        raise ApiError(502, f"EZVIZ stream error: {exc}")

    values = {}
    if protocol == 2:
        values["hls_url"] = result.url
    elif protocol == 1:
        values["ezopen_url"] = result.url
    if values:
        db.execute(
            update(CameraChannel)
            .where(CameraChannel.camera_id == camera.id, CameraChannel.channel_no == channel)
            .values(**values, updated_at=utcnow())
        )
        db.commit()

    return {
        "success": True,
        "data": {
            "cameraId": camera.id,
            "serialNumber": camera.serial_number,
            "channelNo": channel,
            "protocol": protocol,
            "streamUrl": result.url,
            "expireTime": result.expire_time,
        },
    }


@router.get("/{camera_id}/snapshot")
def snapshot(camera_id: str, channel: int = 1, db: Session = Depends(get_db)):
    camera = _get_or_404(db, camera_id)
    try:
        snap = ezviz_provider.capture_snapshot(camera.serial_number, channel)
    except Exception as exc:
        raise ApiError(502, str(exc))

    db.execute(
        update(CameraChannel)
        .where(CameraChannel.camera_id == camera.id, CameraChannel.channel_no == channel)
        .values(snapshot_url=snap.pic_url, updated_at=utcnow())
    )
    db.commit()
    return {"success": True, "data": {"picUrl": snap.pic_url, "timestamp": snap.timestamp, "channelNo": channel}}
