# WorkSight: AI-Powered Workplace Monitoring & Attendance System

WorkSight is an enterprise-grade workplace monitoring and employee attendance platform engineered to observe office presence, zone occupancy, and camera operations using existing CCTV/IP cameras and modern computer vision.

---

## 1. Verified Hardware Integration

The system has been verified and integrated with the physical **EZVIZ CS-H7c** smart dual-lens camera registered in the workspace:

- **Brand & Model**: EZVIZ CS-H7c (`CS-H7c-R100-8G44WF`)
- **Device Serial**: `BC7652775`
- **Firmware Version**: `V5.3.8 build 250812` (Status: **Online**)
- **Dual-Lens Channels**:
  - **Channel 1**: `Hashnate -WL` (Fixed wide-angle lens for static room boundaries and entrance tracking)
  - **Channel 2**: `Hashnate -PT` (Motorized Pan-Tilt lens for targeted workstation observation)
- **Video Encryption**: Disabled (`isEncrypt: 0`), permitting direct low-latency web playback.
- **Protocols Supported**:
  - **Protocol 2 (HLS .m3u8)**: Direct HTTP Live Streaming played natively via `Hls.js` in modern web browsers without external plugins.
  - **Protocol 1 (`ezopen`)**: Supported via `ezuikit-js`.
  - **Device Capture API**: Direct instantaneous frame capture for Python AI Computer Vision inference.

---

## 2. System Architecture

```text
EZVIZ CS-H7c Camera
        |
        v
Official EZVIZ Open Platform (open.ezvizlife.com)
        |
        v
WorkSight Camera Integration Service (EZVIZProvider Adapter)
        |
        +---> Python FastAPI REST API (Port 5000)
        |         |
        |         +---> PostgreSQL 18 Relational Database (SQLAlchemy ORM)
        |         +---> Next.js 14 Web Dashboard (Port 3000)
        |
        +---> Python AI Face-Recognition Service (FastAPI / OpenCV YuNet + SFace / Port 8000)
                  |  watches the live stream, recognises enrolled employees,
                  +--> reports matches to the backend, which marks attendance automatically
```

---

## 3. Technology Stack

- **Frontend**: Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, Lucide Icons, Recharts, HLS.js
- **Backend API**: Python 3.12+, FastAPI, SQLAlchemy 2.0 (psycopg 3), PyJWT, bcrypt, httpx
- **Database**: PostgreSQL 18
- **AI Computer Vision**: Python 3.12+, FastAPI, OpenCV (YuNet face detector + SFace face recognizer, CPU-only)
- **Deployment**: Docker & Docker Compose

---

## 4. Quick Start & Execution

### Prerequisites
- Node.js 18+ (frontend only)
- PostgreSQL 14+ (tested on local PostgreSQL 18)
- Python 3.12+ (backend API and AI microservice)

### Step 1: Database Setup
1. Ensure PostgreSQL is running on `localhost:5432`.
2. Configure credentials in `backend/.env`:
   ```bash
   DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/worksight?schema=public"
   ```
3. Install backend dependencies, then create the tables and seed default records (safe to re-run):
   ```bash
   cd backend
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   .venv/bin/python -m app.seed
   ```

### Step 2: Start Backend Server
```bash
cd backend
.venv/bin/python -m app
# Server listens on http://localhost:$PORT (default 5000), auto-reloads on code changes
# Interactive API docs: http://localhost:5000/docs
```

> **macOS note:** AirPlay Receiver occupies port 5000. Either disable it (System Settings → General → AirDrop & Handoff) or set `PORT=5001` in `backend/.env` and `NEXT_PUBLIC_API_URL="http://localhost:5001/api"` in `frontend/.env.local`.

### Step 3: Start the AI Face-Recognition Service (automatic attendance)
```bash
cd ai-service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python download_models.py      # one-time, ~39 MB of OpenCV face models
.venv/bin/python src/main.py             # http://localhost:8000
```
`ai-service/.env` needs `BACKEND_API_URL` (e.g. `http://localhost:5000/api`) and `AI_SERVICE_KEY`, which must equal
`AI_SERVICE_KEY` in `backend/.env`. Generate one with `python3 -c "import secrets;print(secrets.token_urlsafe(32))"`.

### Step 4: Start Frontend Dashboard
```bash
cd frontend
npm run dev
# Dashboard launches on http://localhost:3000
```

### Step 5: Launch Web Dashboard
1. Open your browser to: **`http://localhost:3000`**
2. Sign in with the seeded Super Administrator credentials:
   - **Email**: `admin@worksight.io`
   - **Password**: `Admin@123456`

   **Change this password straight away** (key icon next to your name in the sidebar): it is published here.
   Then give everyone their own login in **Users & access** (access levels: Super admin, Admin, HR manager,
   Supervisor, Viewer, Employee; see `docs/WORKSIGHT_API.md` section 7). Each new person gets a temporary
   password and chooses their own at first sign-in. An Employee login sees only their own *My time* page.
3. Open **Settings → Cameras → Add a camera** (`/dashboard/settings`) and pick how it connects:
   - *Find on this network*: most IP cameras and recorders (ONVIF); just sign in with the camera's login.
   - *IP camera or recorder*: Hikvision, Dahua, Uniview, Reolink, TP-Link, Axis, EZVIZ (local), or any RTSP address.
   - *EZVIZ cloud account*: enter the App Key / App Secret under *EZVIZ account* first.
   - *USB or built-in camera*, or a *picture or stream link* (JPEG snapshot, MJPEG, HLS).

   **Test connection** shows a picture before you save. Recognition starts within 30 seconds; no file editing or
   restart needed. Each RTSP/USB lens is decoded continuously by the AI service, so plan CPU for the number of lenses.
4. Navigate to **Live Cameras** (`/dashboard/cameras`) to view the live stream of each lens.

---

## 5. Automatic Attendance (Face Recognition)

**How it works**
1. **Enrol (opt-in):** on *Employees → Enrol face*, HR uploads a photo or captures one with the webcam and confirms the
   employee's consent. The AI service turns it into a 128-number face template; the photo is discarded immediately.
   2–3 samples per person (different lighting / glasses) improve accuracy (max 5).
2. **Watch:** the AI worker reads each camera channel's live HLS stream (~2 frames/s). If the stream fails it falls
   back to EZVIZ snapshots (every 4 s) and retries the stream after 5 minutes. With nobody enrolled it stays idle and
   pulls no video.
3. **Recognise:** a face counts as an employee only when similarity ≥ `MATCH_THRESHOLD` (0.45), it beats every other
   employee by `MATCH_MARGIN`, and it is matched in `CONFIRM_FRAMES` (2) frames within 10 s.
4. **Mark attendance:** first sighting of the day → **check-in** (late if after schedule start + grace). Any sighting at
   least `AUTO_CHECKOUT_MIN_GAP_MIN` (30) minutes later → **check-out = last time seen**, with worked minutes and an
   early-departure flag. Every match is logged in `RecognitionEvent` and shown live on the Attendance page.

Manual check-in/out keeps working alongside it; the ledger shows whether each record came from the camera or was manual.

**Testing without the camera:** set `SOURCE_OVERRIDE` in `ai-service/.env` to `webcam:0`, a video file, or a folder of
images, and the worker reads from there instead (attributed to the first camera).

**Tuning:** everything is on the dashboard's **Settings** page (admins only) and applies within 30 seconds:
which lenses recognise faces, match scores (including the stricter score for distant faces), frames needed to
confirm, video source, away/check-out timing and the phone QR link. The matching `.env` values are only defaults
used until something is saved there. See `docs/WORKSIGHT_API.md` section 6.

**Limitations:** no liveness / anti-spoofing check (a printed photo of an enrolled employee could be recognised), so
treat camera attendance as convenience, not as a security control. Accuracy drops with masks, strong backlight, and
faces smaller than ~60 px (people far from the lens). Mount or aim a lens at the entrance at roughly face height.

### Office time (time inside the office)
*Office Time* in the sidebar shows, per employee, how long they were actually inside: while they are in view the AI
service reports them about once a minute, sightings closer together than *Settings → Attendance → Count someone as
away after* (default 2 minutes) are joined into one stay, and longer gaps count as **away** (lunch, errands, gone home). The daily view shows who is in the office now,
first-in / last-seen, time inside vs. their schedule, time away and a timeline of each stay; the weekly/monthly view
totals hours per employee and exports CSV. Manual check-ins (no camera sightings) are shown as first-in → check-out.
For accurate figures a lens must see people **at their desks** (e.g. the H7c pan-tilt lens on the work area), not
only at the door: if the camera only watches the entrance, people are counted as away while sitting outside its view.

**EZVIZ credentials:** set them in *Settings → EZVIZ account* (stored encrypted; *Test connection* checks them).
The backend renews the EZVIZ access token automatically. If they are wrong it can only use `EZVIZ_ACCESS_TOKEN` until that expires, after which live video,
snapshots and automatic attendance stop (the Attendance page shows the EZVIZ error). Live-stream links are requested
with a 2-hour lifetime (`EZVIZ_STREAM_EXPIRE_SEC`).

## 6. Security & Privacy Guarantees

1. **No Hardcoded Secrets**: AppKey, AppSecret, and temporary tokens are strictly retained in backend environment variables and never transmitted to the browser client.
2. **Opt-in Face Recognition Only**: Face recognition is used solely to mark attendance, and only for employees who are enrolled with recorded consent (timestamp and the admin who recorded it). Only numeric face templates are stored, never photos or video frames; frames are analysed in memory and discarded. Revoking consent (*Employees → Enrol face → Revoke*) permanently deletes the employee's face data. People who are not enrolled are never identified. Biometric data is regulated in many places (e.g. GDPR, Illinois BIPA): confirm your legal basis, notices and retention policy before going live.
3. **Service Isolation**: The backend and AI service authenticate each other with a shared `AI_SERVICE_KEY`; the browser never receives it, and face templates are never sent to the browser.
4. **Productivity Separation**: Camera footage and zone occupancy measure physical presence and seating capacity only, ensuring camera detections are never converted into inaccurate automated "productivity scores".

