"""Cameras of any kind: EZVIZ cloud, IP cameras and recorders (RTSP / ONVIF), HTTP snapshot/MJPEG links, USB.

Reading needs a signed-in user; adding, changing, testing and removing cameras needs an admin.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.crypto import encrypt_text
from app.database import get_db, utcnow
from app.errors import ApiError
from app.models import (
    Camera,
    CameraChannel,
    CameraEvent,
    CameraProviderType,
    CameraStatus,
    Office,
    UserRole,
)
from app.providers.ezviz import EZVIZError, ezviz_provider
from app.security import AuthUser, current_user, json_body, require_role
from app.serialize import ser, ser_all, value
from app.services import ai_frames, onvif
from app.services.camera_sources import (
    BRANDS,
    CONNECTION_TYPES,
    adhoc_source,
    brand_url,
    camera_password,
    clean_host,
    mask,
    provider_for,
    source_for,
    split_credentials,
    validate_stream_url,
)

log = logging.getLogger("worksight.cameras")

router = APIRouter(prefix="/api/cameras", tags=["cameras"], dependencies=[Depends(current_user)])

# Who may add, change or remove cameras (Settings page).
ADMIN_ROLES = (UserRole.SUPER_ADMIN, UserRole.OFFICE_ADMIN)
require_admin = require_role(*ADMIN_ROLES)
MAX_CHANNELS = 64


def _ezviz(fn, *args):
    """Call the EZVIZ account; turn its errors into a readable 502 for the dashboard."""
    try:
        return fn(*args)
    except EZVIZError as exc:
        raise ApiError(502, str(exc))
    except Exception as exc:  # network problems etc.
        log.warning("[cameras] EZVIZ call failed: %s", exc)
        raise ApiError(502, f"Could not reach the EZVIZ camera account: {exc}")


def _default_office(db: Session) -> Office:
    office = db.scalar(select(Office).order_by(Office.created_at.asc()).limit(1))
    if not office:
        raise ApiError(400, "No office exists yet. Create the company and office first.")
    return office


def _upsert_channels(db: Session, camera: Camera, channels) -> None:
    """Create or refresh a camera's lenses from EZVIZ. Names changed in Settings are kept."""
    for ch in channels:
        row = db.scalar(
            select(CameraChannel).where(CameraChannel.camera_id == camera.id, CameraChannel.channel_no == ch.channel_no)
        )
        if row is None:
            row = CameraChannel(camera_id=camera.id, channel_no=ch.channel_no, channel_name=ch.channel_name)
            db.add(row)
        row.is_encrypted = ch.is_encrypt == 1
        row.status = ch.status
        row.snapshot_url = ch.pic_url


def _channels(db: Session, camera_id: str) -> list[CameraChannel]:
    return db.scalars(
        select(CameraChannel).where(CameraChannel.camera_id == camera_id).order_by(CameraChannel.channel_no.asc())
    ).all()


def _camera_json(db: Session, camera: Camera) -> dict:
    return ser(
        camera,
        channels=ser_all(_channels(db, camera.id)),
        office=ser(camera.office, only=("id", "name", "address")),
        hasPassword=bool(camera.password_enc),
    )


def _get_or_404(db: Session, camera_id: str) -> Camera:
    camera = db.get(Camera, camera_id)
    if not camera:
        raise ApiError(404, "Camera not found")
    return camera


def _channel_or_404(db: Session, camera: Camera, channel_no: int) -> CameraChannel:
    row = db.scalar(select(CameraChannel).where(CameraChannel.camera_id == camera.id, CameraChannel.channel_no == channel_no))
    if row is None:
        raise ApiError(404, f"Lens {channel_no} not found on this camera")
    return row


def _event(db: Session, camera: Camera, message: str, kind: str = "CONFIGURED") -> None:
    db.add(CameraEvent(camera_id=camera.id, event_type=kind, message=message))


def _text(body: dict, key: str, limit: int = 200) -> Optional[str]:
    v = body.get(key)
    return str(v).strip()[:limit] or None if v is not None else None


# ---------------------------------------------------------------- listing


@router.get("")
def list_cameras(db: Session = Depends(get_db)):
    cameras = db.scalars(select(Camera).order_by(Camera.created_at.desc())).all()
    data = [_camera_json(db, c) for c in cameras]
    return {"success": True, "count": len(data), "data": data}


@router.get("/brands")
def brands():
    """Brands with a known stream address (for the "IP camera" form)."""
    return {
        "success": True,
        "data": [
            {"id": b.id, "label": b.label, "port": b.port, "username": b.username, "multiChannel": b.multi_channel,
             "needsUrl": b.main is None, "hint": b.hint}
            for b in BRANDS.values()
        ],
    }


# ---------------------------------------------------------------- finding cameras


@router.get("/discover", dependencies=[Depends(require_admin)])
def discover(db: Session = Depends(get_db)):
    """Cameras on the EZVIZ account, and whether each one is already added to WorkSight."""
    devices = _ezviz(ezviz_provider.get_device_list, 0, 50)
    try:
        channels = ezviz_provider.get_all_channels()
    except Exception as exc:
        log.warning("[discover] could not list channels: %s", exc)
        channels = {}
    added = {c.serial_number.upper(): c.id for c in db.scalars(select(Camera)).all()}
    data = [
        {
            "serialNumber": d.device_serial,
            "name": d.device_name or f"EZVIZ {d.device_type}",
            "model": d.device_type,
            "firmware": d.device_version,
            "online": d.status == 1,
            "channels": [
                {"channelNo": ch.channel_no, "channelName": ch.channel_name, "online": ch.status == 1}
                for ch in channels.get(d.device_serial.upper(), [])
            ],
            "cameraId": added.get(d.device_serial.upper()),
        }
        for d in devices
    ]
    return {"success": True, "count": len(data), "data": data}


@router.get("/scan", dependencies=[Depends(require_admin)])
def scan_network(db: Session = Depends(get_db)):
    """IP cameras and recorders on the office network that answer ONVIF discovery."""
    found = onvif.discover(timeout=4.0)
    cams = db.scalars(select(Camera)).all()
    added = {(c.host or "").lower(): c.id for c in cams if c.host}
    # A camera added through the EZVIZ cloud has no IP here; flag the same model so it isn't added twice.
    cloud_models = {(c.model or "").upper(): c.name for c in cams if c.connection_type == "EZVIZ" and c.model}
    for d in found:
        d["cameraId"] = added.get(d["host"].lower())
        d["sameModelAs"] = cloud_models.get((d.get("hardware") or "").upper())
    return {"success": True, "count": len(found), "data": found}


@router.post("/onvif", dependencies=[Depends(require_admin)])
def onvif_streams(body: dict = Depends(json_body)):
    """Sign in to an ONVIF camera and read its device information and stream addresses."""
    host = clean_host(str(body.get("host") or ""))
    device_url = _text(body, "deviceUrl", 300)
    if device_url and urlsplit(device_url).hostname != host:
        device_url = None  # only talk to the host the admin chose
    try:
        port = int(body.get("port") or 80)
    except (TypeError, ValueError):
        raise ApiError(400, "Port must be a number")
    try:
        result = onvif.read_streams(host, port, str(body.get("username") or ""), str(body.get("password") or ""), device_url)
    except onvif.OnvifError as exc:
        raise ApiError(400, str(exc))
    return {"success": True, "data": result}


# ---------------------------------------------------------------- testing (before or after saving)


def _resolve_test_source(body: dict, db: Session) -> tuple[dict, str]:
    """Build a source from unsaved details (or a saved camera + optional changes). Returns (source, display url)."""
    kind = str(body.get("connectionType") or "").upper()
    saved: Optional[Camera] = db.get(Camera, body["cameraId"]) if body.get("cameraId") else None
    if saved is not None and not kind:
        kind = saved.connection_type
    if kind not in ("RTSP", "HTTP", "USB"):
        raise ApiError(400, "connectionType must be RTSP, HTTP or USB")
    channel_no = int(body.get("channelNo") or 1)

    url = _text(body, "streamUrl", 1000)
    username = _text(body, "username")
    password = body.get("password") or None
    if url:
        url, u, p = split_credentials(url)
        username, password = username or u, password or p
    elif kind == "RTSP" and body.get("brand") and body.get("brand") != "custom":
        url = brand_url(str(body["brand"]), clean_host(str(body.get("host") or "")), body.get("port"), channel_no)
    elif saved is not None:
        url = _channel_or_404(db, saved, channel_no).stream_url
    if not url:
        raise ApiError(400, "Enter the camera address")
    url = validate_stream_url(kind, url)
    if saved is not None:  # testing a saved camera: blank fields mean "use what is saved"
        username = username if username is not None else saved.username
        password = password if password is not None else camera_password(saved)
    return adhoc_source(kind, url, username, password), url


@router.post("/test", dependencies=[Depends(require_admin)])
def test_connection(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    """Open the stream once and return a picture, so the admin sees it works before saving."""
    source, url = _resolve_test_source(body, db)
    try:
        jpeg, width, height = ai_frames.grab(source)
    except ApiError as exc:
        return {"success": True, "data": {"ok": False, "message": exc.message, "streamUrl": mask(url)}}
    return {
        "success": True,
        "data": {
            "ok": True,
            "message": f"Connected. Picture size {width} × {height}.",
            "width": width,
            "height": height,
            "image": ai_frames.data_url(jpeg),
            "streamUrl": url,
        },
    }


# ---------------------------------------------------------------- adding


def _lenses_from_body(kind: str, body: dict) -> tuple[list[dict], Optional[str], Optional[str]]:
    """Lenses for a non-EZVIZ camera: [{channelNo, channelName, streamUrl}], plus credentials found in addresses."""
    brand = str(body.get("brand") or "custom")
    found_user = found_pass = None
    lenses: list[dict] = []
    if kind == "RTSP" and brand != "custom" and not body.get("channels"):
        host = clean_host(str(body.get("host") or ""))
        try:
            count = int(body.get("channelCount") or 1)
        except (TypeError, ValueError):
            raise ApiError(400, "channelCount must be a number")
        if not 1 <= count <= MAX_CHANNELS:
            raise ApiError(400, f"Between 1 and {MAX_CHANNELS} channels")
        if not BRANDS[brand].multi_channel:
            count = 1
        for c in range(1, count + 1):
            lenses.append({
                "channelNo": c,
                "channelName": "Main view" if count == 1 else f"Channel {c}",
                "streamUrl": brand_url(brand, host, body.get("port"), c),
            })
        return lenses, None, None

    items = body.get("channels") or []
    if not isinstance(items, list) or not items:
        raise ApiError(400, "Add at least one stream address")
    if len(items) > MAX_CHANNELS:
        raise ApiError(400, f"At most {MAX_CHANNELS} lenses per camera")
    for i, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ApiError(400, "channels must be a list of objects")
        url, u, p = split_credentials(str(item.get("streamUrl") or "").strip())
        found_user, found_pass = found_user or u, found_pass or p
        lenses.append({
            "channelNo": int(item.get("channelNo") or i),
            "channelName": (str(item.get("channelName") or "").strip()[:60]) or ("Main view" if len(items) == 1 else f"Lens {i}"),
            "streamUrl": validate_stream_url(kind, url),
        })
    if len({ln["channelNo"] for ln in lenses}) != len(lenses):
        raise ApiError(400, "Each lens needs its own number")
    return lenses, found_user, found_pass


def _add_ezviz(body: dict, user: AuthUser, db: Session) -> Camera:
    serial = str(body.get("serialNumber") or "").strip().upper()
    if not serial:
        raise ApiError(400, "serialNumber is required")
    if db.scalar(select(Camera).where(func.upper(Camera.serial_number) == serial)):
        raise ApiError(409, "This camera is already added")
    devices = _ezviz(ezviz_provider.get_device_list, 0, 50)
    dev = next((d for d in devices if (d.device_serial or "").upper() == serial), None)
    if dev is None:
        raise ApiError(404, f"No camera with serial {serial} on the EZVIZ account. Add it to the account in the EZVIZ app first.")
    online = dev.status == 1
    camera = Camera(
        office_id=_default_office(db).id,
        name=_text(body, "name", 100) or dev.device_name or f"EZVIZ {dev.device_type}",
        model=dev.device_type or "EZVIZ",
        serial_number=dev.device_serial,
        provider=CameraProviderType.EZVIZ,
        connection_type="EZVIZ",
        location=_text(body, "location", 100),
        status=CameraStatus.ONLINE if online else CameraStatus.OFFLINE,
        firmware_ver=dev.device_version,
        last_online_at=utcnow() if online else None,
    )
    db.add(camera)
    db.flush()
    try:
        lenses = ezviz_provider.get_camera_channels(dev.device_serial)
    except Exception as exc:
        log.warning("[add_camera] could not list channels for %s: %s", serial, exc)
        lenses = []
    if lenses:
        _upsert_channels(db, camera, lenses)
    else:
        db.add(CameraChannel(camera_id=camera.id, channel_no=1, channel_name="Channel 1"))
    return camera


def _add_other(kind: str, body: dict, user: AuthUser, db: Session) -> Camera:
    brand = str(body.get("brand") or ("custom" if kind == "RTSP" else "")) or None
    if kind == "RTSP" and brand not in BRANDS:
        raise ApiError(400, "Unknown brand")
    lenses, url_user, url_pass = _lenses_from_body(kind, body)

    # The same stream must not be added twice.
    urls = [ln["streamUrl"] for ln in lenses]
    dup = db.scalar(select(CameraChannel).where(CameraChannel.stream_url.in_(urls)))
    if dup is not None:
        raise ApiError(409, f"That stream is already added (camera: {db.get(Camera, dup.camera_id).name})")

    serial = _text(body, "serialNumber", 100)
    if serial and db.scalar(select(Camera).where(func.upper(Camera.serial_number) == serial.upper())):
        raise ApiError(409, "This camera is already added")
    host = urlsplit(urls[0]).hostname if kind != "USB" else None
    username = _text(body, "username") or url_user
    password = body.get("password") or url_pass
    try:
        port = int(body["port"]) if body.get("port") else (urlsplit(urls[0]).port if kind != "USB" else None)
    except (TypeError, ValueError):
        raise ApiError(400, "Port must be a number")
    default_name = {"USB": "USB camera", "HTTP": "IP camera"}.get(kind) or (
        BRANDS[brand].label.split(" (")[0] + " camera" if brand and brand != "custom" else "IP camera"
    )
    camera = Camera(
        office_id=_default_office(db).id,
        name=_text(body, "name", 100) or (f"{default_name} ({host})" if host else default_name),
        model=_text(body, "model", 100) or (BRANDS[brand].label.split(" (")[0] if brand in BRANDS and brand != "custom" else default_name),
        serial_number=serial or f"{kind}-{uuid.uuid4().hex[:10].upper()}",
        provider=CameraProviderType(provider_for(brand)),
        connection_type=kind,
        brand=brand,
        host=host,
        port=port,
        username=username,
        password_enc=encrypt_text(password) if password else None,
        location=_text(body, "location", 100),
        firmware_ver=_text(body, "firmware", 100),
        status=CameraStatus.ONLINE if body.get("tested") else CameraStatus.OFFLINE,
        last_online_at=utcnow() if body.get("tested") else None,
    )
    db.add(camera)
    db.flush()
    for ln in lenses:
        db.add(CameraChannel(camera_id=camera.id, channel_no=ln["channelNo"], channel_name=ln["channelName"], stream_url=ln["streamUrl"]))
    return camera


@router.post("")
def add_camera(body: dict = Depends(json_body), user: AuthUser = Depends(require_admin), db: Session = Depends(get_db)):
    """Add a camera. EZVIZ: {serialNumber}. Others: {connectionType, brand, host, port, username, password,
    channelCount | channels[{streamUrl, channelName}], name, location}. Every lens starts with recognition on."""
    kind = str(body.get("connectionType") or "EZVIZ").upper()
    if kind not in CONNECTION_TYPES:
        raise ApiError(400, f"connectionType must be one of {', '.join(CONNECTION_TYPES)}")
    camera = _add_ezviz(body, user, db) if kind == "EZVIZ" else _add_other(kind, body, user, db)
    _event(db, camera, f"Added in Settings by {user.full_name}")
    db.commit()
    return {"success": True, "data": _camera_json(db, camera)}


@router.post("/sync-ezviz", dependencies=[Depends(require_admin)])
def sync_ezviz(db: Session = Depends(get_db)):
    """Refresh status, firmware and lenses of the EZVIZ cameras already added. New cameras are added from Settings
    (POST /api/cameras), so a camera someone removed is not brought back."""
    devices = _ezviz(ezviz_provider.get_device_list, 0, 50)
    try:
        channels = ezviz_provider.get_all_channels()
    except Exception as exc:
        log.warning("[SyncEZVIZ] Could not list channels: %s", exc)
        channels = {}

    synced = []
    for dev in devices:
        is_online = dev.status == 1
        camera = db.scalar(
            select(Camera).where(func.upper(Camera.serial_number) == dev.device_serial.upper(), Camera.connection_type == "EZVIZ")
        )
        if camera is None:
            continue
        camera.model = dev.device_type or camera.model or "EZVIZ"
        camera.status = CameraStatus.ONLINE if is_online else CameraStatus.OFFLINE
        camera.firmware_ver = dev.device_version
        if is_online:
            camera.last_online_at = utcnow()
        db.flush()
        _upsert_channels(db, camera, channels.get(dev.device_serial.upper(), []))
        synced.append(camera)

    db.commit()
    return {
        "success": True,
        "message": f"Refreshed {len(synced)} camera(s) from the EZVIZ account",
        "data": ser_all(synced),
    }


# ---------------------------------------------------------------- changing / removing


@router.patch("/{camera_id}")
def update_camera(
    camera_id: str,
    body: dict = Depends(json_body),
    user: AuthUser = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Rename, move, switch on/off, change the login or address (non-EZVIZ), rename lenses, choose which run
    recognition, add or remove lenses (recorders)."""
    camera = _get_or_404(db, camera_id)
    changes = []
    if "name" in body:
        name = str(body.get("name") or "").strip()
        if not name:
            raise ApiError(400, "Camera name cannot be empty")
        camera.name = name[:100]
        changes.append("name")
    if "location" in body:
        camera.location = str(body.get("location") or "").strip()[:100] or None
        changes.append("location")
    if "isEnabled" in body:
        if not isinstance(body["isEnabled"], bool):
            raise ApiError(400, "isEnabled must be true or false")
        camera.is_enabled = body["isEnabled"]
        changes.append("turned on" if camera.is_enabled else "turned off")

    other = camera.connection_type != "EZVIZ"
    if other and "username" in body:
        camera.username = _text(body, "username")
        changes.append("login")
    if other and body.get("password"):
        camera.password_enc = encrypt_text(str(body["password"]))
        changes.append("password")
    if other and body.get("passwordClear"):
        camera.password_enc = None
        changes.append("password removed")
    if other and camera.connection_type != "USB" and ("host" in body or "port" in body):
        new_host = clean_host(str(body.get("host") or camera.host or ""))
        try:
            new_port = int(body["port"]) if body.get("port") else camera.port
        except (TypeError, ValueError):
            raise ApiError(400, "Port must be a number")
        for row in _channels(db, camera.id):  # move every lens to the new address
            if row.stream_url:
                parts = urlsplit(row.stream_url)
                netloc = new_host + (f":{new_port or parts.port}" if (new_port or parts.port) else "")
                row.stream_url = parts._replace(netloc=netloc).geturl()
        camera.host, camera.port = new_host, new_port
        changes.append("address")

    for item in body.get("channels") or []:
        if not isinstance(item, dict):
            raise ApiError(400, "channels must be a list of objects")
        row = _channel_or_404(db, camera, int(item.get("channelNo") or 0))
        if "channelName" in item:
            label = str(item.get("channelName") or "").strip()
            if not label:
                raise ApiError(400, "Lens name cannot be empty")
            row.channel_name = label[:60]
        if "recognitionEnabled" in item:
            if not isinstance(item["recognitionEnabled"], bool):
                raise ApiError(400, "recognitionEnabled must be true or false")
            row.recognition_enabled = item["recognitionEnabled"]
        if other and item.get("streamUrl"):
            url, u, p = split_credentials(str(item["streamUrl"]).strip())
            row.stream_url = validate_stream_url(camera.connection_type, url)
            if u and not camera.username:
                camera.username = u
            if p and not camera.password_enc:
                camera.password_enc = encrypt_text(p)
        changes.append(f"lens {row.channel_no}")

    if other:
        for item in body.get("addChannels") or []:
            existing = {r.channel_no for r in _channels(db, camera.id)}
            if len(existing) >= MAX_CHANNELS:
                raise ApiError(400, f"At most {MAX_CHANNELS} lenses per camera")
            no = int(item.get("channelNo") or (max(existing, default=0) + 1))
            if no in existing:
                raise ApiError(409, f"Lens {no} already exists")
            if item.get("streamUrl"):
                url = validate_stream_url(camera.connection_type, split_credentials(str(item["streamUrl"]).strip())[0])
            elif camera.brand in BRANDS and camera.brand != "custom" and camera.host:
                url = brand_url(camera.brand, camera.host, camera.port, no)
            else:
                raise ApiError(400, "Enter the stream address for the new lens")
            db.add(CameraChannel(camera_id=camera.id, channel_no=no, channel_name=(str(item.get("channelName") or "").strip()[:60] or f"Channel {no}"), stream_url=url))
            changes.append(f"lens {no} added")
        for no in body.get("removeChannels") or []:
            row = _channel_or_404(db, camera, int(no))
            if len(_channels(db, camera.id)) <= 1:
                raise ApiError(400, "A camera needs at least one lens")
            db.delete(row)
            db.flush()
            changes.append(f"lens {no} removed")

    if changes:
        _event(db, camera, f"Settings changed by {user.full_name}: {', '.join(changes)}")
    db.commit()
    return {"success": True, "data": _camera_json(db, camera)}


@router.delete("/{camera_id}", dependencies=[Depends(require_admin)])
def remove_camera(camera_id: str, db: Session = Depends(get_db)):
    """Remove a camera from WorkSight. Its rooms, door lines and tracking history are deleted with it."""
    camera = _get_or_404(db, camera_id)
    db.execute(delete(Camera).where(Camera.id == camera.id))
    db.commit()
    return {"success": True, "message": "Camera removed"}


# ---------------------------------------------------------------- one camera


@router.get("/{camera_id}")
def get_camera(camera_id: str, db: Session = Depends(get_db)):
    camera = _get_or_404(db, camera_id)
    events = db.scalars(
        select(CameraEvent)
        .where(CameraEvent.camera_id == camera.id)
        .order_by(CameraEvent.timestamp.desc())
        .limit(10)
    ).all()
    return {"success": True, "data": {**_camera_json(db, camera), "office": ser(camera.office), "events": ser_all(events)}}


def _mark(db: Session, camera: Camera, online: bool, detail: str = "") -> None:
    new = CameraStatus.ONLINE if online else CameraStatus.OFFLINE
    if online:
        camera.last_online_at = utcnow()
    if camera.status != new:
        camera.status = new
        _event(db, camera, f"Camera is {'reachable' if online else 'not reachable'}{': ' + detail if detail else ''}",
               "CONNECTED" if online else "DISCONNECTED")
    db.commit()


def _frame(db: Session, camera: Camera, channel: int) -> bytes:
    """A current JPEG of one lens, from the AI service's live feed or by opening the stream once."""
    jpeg = ai_frames.latest(camera.id, channel)
    if jpeg:
        return jpeg
    if camera.connection_type == "EZVIZ":
        snap = _ezviz(ezviz_provider.capture_snapshot, camera.serial_number, channel)
        try:
            return httpx.get(snap.pic_url, timeout=15).content
        except httpx.HTTPError as exc:
            raise ApiError(502, f"Could not download the EZVIZ snapshot ({exc.__class__.__name__})")
    row = _channel_or_404(db, camera, channel)
    try:
        spec = source_for(camera, row)
        jpeg, _, _ = ai_frames.grab(spec, key=f"{camera.id}:{channel}:{spec['key']}")
    except ApiError as exc:
        if exc.status_code != 503:
            _mark(db, camera, False, exc.message)
        raise
    _mark(db, camera, True)
    return jpeg


@router.get("/{camera_id}/preview")
def preview(camera_id: str, channel: int = 1, db: Session = Depends(get_db)):
    """Current picture of a lens as image/jpeg (live view for cameras the browser can't play directly)."""
    camera = _get_or_404(db, camera_id)
    return Response(_frame(db, camera, channel), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/{camera_id}/status")
def camera_status(camera_id: str, db: Session = Depends(get_db)):
    camera = _get_or_404(db, camera_id)
    last_online_before = camera.last_online_at
    if camera.connection_type == "EZVIZ":
        is_online, raw_status = _ezviz(ezviz_provider.get_connection_status, camera.serial_number)
        _mark(db, camera, is_online, f"EZVIZ status {raw_status}")
    else:
        try:
            _frame(db, camera, (_channels(db, camera.id) or [CameraChannel(channel_no=1)])[0].channel_no)
            is_online = True
        except ApiError:
            is_online = False
    return {
        "success": True,
        "data": {
            "id": camera.id,
            "serialNumber": camera.serial_number,
            "isOnline": is_online,
            "status": camera.status.value,
            # Value from before this check, as the original API returned.
            "lastOnlineAt": value(last_online_before),
        },
    }


@router.api_route("/{camera_id}/stream", methods=["GET", "POST"])
def stream_url(camera_id: str, channel: int = 1, protocol: int = 2, db: Session = Depends(get_db)):
    """Authorized live stream URL from EZVIZ. protocol 2 = HLS (default), 1 = ezopen.
    Other cameras are viewed through /preview (browsers can't play RTSP)."""
    camera = _get_or_404(db, camera_id)
    if camera.connection_type != "EZVIZ":
        raise ApiError(400, "This camera is shown through its live preview, not an EZVIZ stream link.")

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
    """A still picture of a lens: an EZVIZ cloud link, or (other cameras) an inline image."""
    camera = _get_or_404(db, camera_id)
    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if camera.connection_type != "EZVIZ":
        return {"success": True, "data": {"picUrl": ai_frames.data_url(_frame(db, camera, channel)), "timestamp": ts, "channelNo": channel}}
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
