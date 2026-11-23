# WorkSight v2.0 API Specification

## 1. Authentication & Security
- Public APIs require `Authorization: Bearer <JWT_TOKEN>`.
- Internal service-to-service endpoints require `X-Service-Key: <AI_SERVICE_KEY>`.

---

## 2. System B: Hybrid Attendance Endpoints

### 2.1 `POST /api/attendance/check-in`
Executes explicit transactional employee check-in.
- **Headers**: `Authorization: Bearer <token>`
- **Request Body**:
  ```json
  {
    "employeeId": "uuid-optional",
    "idempotencyKey": "unique-client-key-optional",
    "reason": "optional note"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "message": "Successfully checked in Vaithulla Mohamed Muhni",
    "data": {
      "session": { "id": "...", "status": "OPEN", "checkInAt": "..." },
      "event": { "id": "...", "action": "CHECK_IN", "source": "EMPLOYEE" }
    }
  }
  ```
- **Error Codes**: `409 Conflict` (if open session already exists), `404 Not Found`.

### 2.2 `POST /api/attendance/check-out`
Executes explicit transactional employee check-out.
- **Request Body**:
  ```json
  {
    "employeeId": "uuid-optional",
    "idempotencyKey": "unique-client-key-optional"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "message": "Successfully checked out Vaithulla Mohamed Muhni",
    "data": {
      "session": { "id": "...", "status": "CLOSED", "checkOutAt": "..." }
    }
  }
  ```
- **Error Codes**: `404 Not Found` (if no open work session).

### 2.3 `GET /api/attendance/me/today`
Returns the active work session and today's status for the authenticated user.

### 2.4 `GET /api/attendance/reviews`
Administrator attendance exception review queue (`SUPER_ADMIN`, `OFFICE_ADMIN`, `HR_MANAGER`).

### 2.5 `POST /api/attendance/reviews/:id/resolve`
Resolves an attendance exception review.

---

## 3. System A: Real-Time Presence Endpoints

### 3.1 `GET /api/presence/overview`
Returns real-time physical presence snapshots for all active employees with uncertainty states:
```json
{
  "success": true,
  "data": [
    {
      "employeeId": "730f61a5-009c-4462-826c-3f2591b0d8d1",
      "fullName": "Vaithulla Mohamed Muhni",
      "status": "OBSERVED_RECENTLY",
      "lastObservedAt": "2026-11-16T06:35:20.796Z",
      "lastChannelNo": 2,
      "lastSimilarity": 0.487
    }
  ]
}
```

### 3.2 `GET /api/presence/observations`
Lists recent camera observations (including anonymized unknown-person counts).

### 3.3 `POST /api/internal/presence/observations`
Authenticated internal endpoint for the Python AI service to deliver camera observation evidence:
- **Headers**: `X-Service-Key: <AI_SERVICE_KEY>`
- **Request Body**:
  ```json
  {
    "eventId": "uuid-v4",
    "employeeId": "uuid or null",
    "cameraId": "uuid or null",
    "channelNo": 1,
    "similarityScore": 0.487,
    "observedAt": "2026-11-16T06:35:20.796Z",
    "isUnknown": false
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "data": {
      "observationId": "...",
      "presenceStatus": "OBSERVED_RECENTLY"
    }
  }
  ```

---

## 4. Biometric Face Template Endpoints

### 4.1 `POST /api/faces/:employeeId`
Enrolls face sample, encrypts 128-d embedding using AES-256-GCM, stores in `FaceTemplate`.

### 4.2 `DELETE /api/faces/:employeeId`
Revocation endpoint: permanently deletes biometric templates from PostgreSQL and invalidates AI cache.

### 4.3 `GET /api/internal/face-gallery`
Internal endpoint for AI service: decrypts active `FaceTemplate` records into memory for live matching.

### 4.4 Phone self-enrolment (QR code)
HR shows a QR code; the employee scans it with their phone, takes three selfies (front, left, right), gives consent and submits. No app or login on the phone.

Admin (JWT, `SUPER_ADMIN` / `OFFICE_ADMIN` / `HR_MANAGER`):
- `POST /api/faces/:employeeId/mobile-session`: issues a one-time link. Returns `token` (shown once; only its SHA-256 hash is stored), `expiresAt`, `lanIp` and `publicBaseUrl`. Any older live link for that employee is cancelled.
- `GET /api/faces/mobile-sessions/:sessionId`: status for the desktop dialog to poll: `PENDING` → `OPENED` → `COMPLETED` (or `EXPIRED` / `CANCELLED`).
- `DELETE /api/faces/mobile-sessions/:sessionId`: cancels the link.

Public (token is the only credential; the frontend proxies these, so phones only talk to port 3000):
- `GET /api/public/enroll/:token`: employee first name, expiry. Marks the link `OPENED`.
- `POST /api/public/enroll/:token/validate`: multipart `image`, `expected_angle`. Quality / angle check.
- `POST /api/public/enroll/:token/submit`: multipart `front`, `left`, `right`, `consent=true`. Enrols all three angles (`FaceEnrollment.source = "MOBILE"`) and burns the link. A second submit returns `410`.

Settings (`backend/.env`): `MOBILE_ENROLL_TTL_MIN` (default 15), `MOBILE_ENROLL_BASE_URL` (optional, e.g. an HTTPS domain or tunnel, or `https://{lan_ip}:3443` for the office HTTPS front door in `frontend/scripts/lan-https.mjs`; by default the QR code uses this PC's Wi-Fi IP over plain http). Frontend: `BACKEND_INTERNAL_URL` (default `http://127.0.0.1:5000`) is where the Next server forwards `/api/public/enroll/*`.

---

## 5. Office Time (inside-office time from camera sightings)

Shown on the dashboard's **Office Time** page. Built from `RecognitionEvent` sightings (at most one per employee per *Ignore repeat sightings within*, default 60 s) linked to each day's `AttendanceRecord`. Sightings closer together than `gapMin` form one "inside" session; a longer gap is an away period (stepped outside, or out of camera view).

- `inside` = first → last sighting − away periods + *Time credited per stay* (default 1 min)
- `away` = sum of away periods (last sighting before the gap → first sighting after it)

All three endpoints need a JWT. `gapMin` is optional (1–120); without it the system setting **Settings > Attendance > Count someone as away after** is used (default 2).

### 5.1 `GET /api/work-hours/daily?date=YYYY-MM-DD&gapMin=2`
Every active employee for one day (absent employees included): `state` (`IN_OFFICE` / `LEFT` / `ABSENT`), `isLate`, `firstSeen`, `lastSeen`, `insideSeconds`, `awaySeconds`, `sightings`, `sessions[]` and `awayPeriods[]` (`start`, `end`, `seconds`).

### 5.2 `GET /api/work-hours/summary?startDate=&endDate=&gapMin=`
Every active employee × every day in the range (max 92 days): per day `present`, `isLate`, `firstSeen`, `lastSeen`, `insideMinutes`, `awayMinutes`, `timesAway`; plus totals.

### 5.3 `GET /api/work-hours/:employeeId/sightings?date=`
The raw sighting log for one employee and day: `seenAt`, `action`, `similarity`, `cameraName`, `channelNo`.

---

## 6. Settings (configured from the dashboard)

Everything an admin sets up lives on the dashboard's **Settings** page and is stored in the `SystemSetting` table, so a new office needs no file editing. Values not saved there fall back to built-in defaults (for the EZVIZ account and QR link: the old `backend/.env` values, so existing installs keep working). The AI service polls the recognition settings and the camera list every 30 s and applies them without a restart.

Still in `.env` (needed before the database is reachable, or secrets shared between services): `DATABASE_URL`, `JWT_SECRET`, `AI_SERVICE_KEY`, `BIOMETRIC_ENCRYPTION_KEY`, ports and service addresses.

Reading needs a JWT; changing needs the `SUPER_ADMIN` or `OFFICE_ADMIN` role.

### 6.1 `GET /api/settings`
`{ canEdit, data: { ezviz, recognition, attendance, enrollment } }`. Each section: `values` (effective), `defaults`, `customised` (keys saved from the dashboard). Secrets are never returned: `appSecret` is `""` with `appSecretSet: true|false`.

| Section | Keys |
|---|---|
| `ezviz` | `appKey`, `appSecret` (encrypted at rest with AES-256-GCM), `apiBaseUrl` |
| `recognition` | `matchThreshold` 0.30–0.80, `matchMargin` 0–0.30, `smallFaceEyePx` 0–200, `smallFaceMatchThreshold` 0.30–0.90, `confirmFrames` 1–10, `confirmWindowSec` 2–60, `reportCooldownSec` 10–600, `minFaceSize` 20–300, `frameSource` `auto`/`hls`/`snapshot` |
| `attendance` | `awayAfterMin` 1–120, `sightingCreditMin` 0–15, `autoCheckoutGapMin` 1–240, `recognitionDedupSec` 0–600 |
| `enrollment` | `mobileBaseUrl` (`{lan_ip}` = this PC's Wi-Fi address), `mobileLinkTtlMin` 5–120, `maxFaceSamples` 3–10 |

### 6.2 `PUT /api/settings/:section`
Body: only the keys to change. `null` puts a key back to its default. For `appSecret`, an empty value keeps the saved one and `"appSecretClear": true` removes it. Unknown keys or out-of-range values → `400`.

### 6.3 `POST /api/settings/ezviz/test`
Checks an App Key / Secret without saving (empty fields use the saved values): `{ ok, message, deviceCount }`.

### 6.4 Cameras (any kind)

`Camera.connectionType` says how WorkSight reaches it:

| Type | What | How video is read |
|---|---|---|
| `EZVIZ` | Camera on the EZVIZ cloud account | EZVIZ HLS links + snapshots (needs Settings > EZVIZ account) |
| `RTSP` | Any IP camera or recorder (NVR/DVR) | RTSP over TCP by the AI service; address from a brand template, from ONVIF, or typed in |
| `HTTP` | Snapshot (JPEG), MJPEG or HLS (`.m3u8`) link | Polled once a second (snapshots) or streamed |
| `USB` | Camera plugged into the PC running the AI service | `usb:0`, `usb:1`, … (DirectShow on Windows) |

Stream addresses are stored **without** credentials (`CameraChannel.streamUrl`); the username is on the camera and the password is stored encrypted (`Camera.passwordEnc`, never returned by any endpoint; responses carry `hasPassword`). Credentials typed into an address are moved out of it.

Brand templates (`GET /api/cameras/brands`): Hikvision (`/Streaming/Channels/{c}01`), Dahua (`/cam/realmonitor?channel={c}&subtype=0`), Uniview (`/unicast/c{c}/s0/live`), Reolink (`/h264Preview_{cc}_main`), TP-Link Tapo/VIGI (`/stream1`), Axis (`/axis-media/media.amp?camera={c}`), EZVIZ on the local network (`/h264/ch{c}/main/av_stream`, user `admin`, password = verification code on the label), or "Other brand" (type the address).

- `GET /api/cameras/scan` — ONVIF WS-Discovery on every network adapter (~4 s): `[{host, port, deviceUrl, name, hardware, manufacturer, isRecorder, cameraId, sameModelAs}]`.
- `POST /api/cameras/onvif` `{host, port, username, password, deviceUrl?}` — signs in (WS-Security digest following the camera's clock, HTTP digest fallback) and returns `{device: {Manufacturer, Model, FirmwareVersion, SerialNumber}, lenses: [{channelNo, channelName, streamUrl, width, height, encoding}]}` (highest-resolution profile per video input).
- `POST /api/cameras/test` `{connectionType, brand?, host?, port?, username?, password?, streamUrl?, channelNo?, cameraId?}` — opens the stream once through the AI service: `{ok, message, width, height, image (data: URL)}`. For RTSP failures the message says why (can't reach the IP/port, login refused, no stream at that path, not an RTSP device). With `cameraId`, blank fields use the saved camera's values.
- `POST /api/cameras` — EZVIZ: `{serialNumber}`. Others: `{connectionType, brand, host, port, username, password, channelCount | channels: [{channelNo?, channelName?, streamUrl}], name, location, serialNumber?, model?, firmware?}`. `409` if the camera or stream is already added. Every lens starts with face recognition on.
- `PATCH /api/cameras/:id` `{name?, location?, isEnabled?, host?, port?, username?, password?, passwordClear?, channels?: [{channelNo, channelName?, recognitionEnabled?, streamUrl?}], addChannels?: [{streamUrl?, channelName?}], removeChannels?: [channelNo]}`. A new IP/port moves every lens; with a brand template, `addChannels: [{}]` builds the next channel's address. A turned-off camera keeps its rooms and history but is not watched.
- `GET /api/cameras/:id/preview?channel=` — `image/jpeg` of a lens now (the AI service's live frame, or a stream kept open ~30 s for repeated previews). The Live Cameras page polls it about once a second for non-EZVIZ cameras. `GET /api/cameras/:id/snapshot` returns it as a `data:` URL for non-EZVIZ cameras (used by Office Zones).
- `DELETE /api/cameras/:id` — removes the camera with its lenses, rooms, door lines and room-tracking history; attendance and sightings are kept.
- `POST /api/cameras/sync-ezviz` — refreshes status, firmware and lenses of EZVIZ cameras already added (never adds or renames).

### 6.5 `GET /api/internal/runtime-config` (service key)
`{ recognition: {...} }` for the AI service. `GET /api/internal/cameras` returns switched-on cameras of every type; each lens has `recognitionEnabled` and `source: {type: ezviz|rtsp|http|usb, url (with credentials), key}`. The AI service reconnects a lens when its `key` changes. AI-service endpoints used by the backend: `POST /grab-frame {source, key?}` and `GET /preview/:cameraId/:channelNo` (both need the service key).

---

## 7. Users, sign-in and access levels

Every signed-in request is checked in `app.security.current_user` against one table, `app/permissions.py` (`ACCESS_RULES`): the endpoint's required permission must be in the person's role. **An endpoint with no rule is refused**, so new endpoints must be added to the table. Endpoints that don't sign users in are outside it: `/api/auth/login`, `/api/health`, `/api/public/enroll/*` (one-time token) and `/api/internal/*` + `POST /api/analytics/events` (AI service key).

| Access level (`role`) | Own time | All reports | Live cameras | Employees & corrections | Cameras & settings | Users |
|---|---|---|---|---|---|---|
| Super admin (`SUPER_ADMIN`) | yes | yes | yes | yes | yes | yes |
| Admin (`OFFICE_ADMIN`) | yes | yes | yes | yes | yes | yes, except Super-admin accounts |
| HR manager (`HR_MANAGER`) | yes | yes | yes | yes | – | – |
| Supervisor (`SUPERVISOR`) | yes | yes | yes | – | – | – |
| Viewer (`VIEWER`) | yes | yes | – | – | – | – |
| Employee (`EMPLOYEE`) | yes | – | – | – | – | – |

Permission names: `self.view`, `reports.view`, `cameras.live` (live video, previews, snapshots), `people.manage` (employees, face enrolment and photos, attendance/break/tracking corrections), `setup.manage` (cameras, rooms, settings), `users.manage`. A refused call returns `403` with a readable `message`.

**Accounts.** Each person signs in with their own email and password (bcrypt). New accounts and admin resets get a one-time temporary password; until the person chooses their own, every call except `/api/auth/me`, `/api/auth/change-password` and `/api/auth/logout` returns `403 {code: "PASSWORD_CHANGE_REQUIRED"}`. Five wrong passwords lock the account for 15 minutes (`429`). Tokens carry a version: changing or resetting a password, disabling the account or changing its access level signs the person out everywhere. An unknown email and a wrong password get the same answer. A login can be linked to one employee record (`User.employeeId`, required for `EMPLOYEE`), which gives it "My time".

### 7.1 Own account
- `POST /api/auth/login` `{email, password}` → `{token, user}`; `user` = `{id, email, fullName, role, roleLabel, permissions[], mustChangePassword, employee, company}`.
- `GET /api/auth/me` → `{user}` (same shape).
- `POST /api/auth/change-password` `{currentPassword, newPassword}` → new `{token, user}`. At least 8 characters, letters and numbers, not the email, not the current one.
- `GET /api/me/office-time?date=&days=14` → the linked employee's day (`day`, same shape as a row of `/api/work-hours/daily`) and recent days (`history`, `summary`). `404 {code: "NO_EMPLOYEE_LINK"}` if the login isn't linked.
- `POST /api/attendance/check-in|check-out` checks in the linked employee; `employeeId` of someone else needs `people.manage`.

### 7.2 Users & access (`users.manage`)
- `GET /api/users` — accounts with `roleLabel, isActive, isLocked, mustChangePassword, lastLoginAt, employee, isYou, canEdit`.
- `GET /api/users/roles` — access levels with `label, description, permissions, assignable`.
- `POST /api/users` `{fullName, email, role, employeeId?}` → `{data, temporaryPassword}` (shown once).
- `PATCH /api/users/:id` `{fullName?, email?, role?, employeeId?, isActive?, unlock?}`.
- `POST /api/users/:id/reset-password` → `{data, temporaryPassword}`.
- `DELETE /api/users/:id` — removes the login; the employee record and attendance stay.
- `GET /api/users/activity` — recent account changes (from `AuditLog`).

Rules: nobody can change their own access level, disable or delete themselves; only a Super admin can create, change, reset or delete a Super admin; the last active Super admin can't be demoted, disabled or deleted; one login per employee.
