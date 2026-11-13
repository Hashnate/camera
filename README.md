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
        +---> Secure Node.js / Express REST API (Port 5000)
        |         |
        |         +---> PostgreSQL 18 Relational Database (Prisma ORM)
        |         +---> Next.js 14 Web Dashboard (Port 3000)
        |
        +---> Python AI Computer Vision Service (FastAPI / YOLOv8 / Port 8000)
```

---

## 3. Technology Stack

- **Frontend**: Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, Lucide Icons, Recharts, HLS.js
- **Backend API**: Node.js, Express.js, TypeScript, Prisma ORM, JWT Authentication, Cookie Parser
- **Database**: PostgreSQL 18
- **AI Computer Vision**: Python 3.11, FastAPI, Ultralytics YOLOv8, OpenCV
- **Deployment**: Docker & Docker Compose

---

## 4. Quick Start & Execution

### Prerequisites
- Node.js 18+ (tested on Node v22.16.0)
- PostgreSQL 14+ (tested on local PostgreSQL 18)
- Python 3.10+ (for AI microservice)

### Step 1: Database Setup
1. Ensure PostgreSQL is running on `localhost:5432`.
2. Configure credentials in `backend/.env`:
   ```bash
   DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/worksight?schema=public"
   ```
3. Generate Prisma client, push the schema, and seed default records:
   ```bash
   cd backend
   npx prisma generate
   npx prisma db push
   npx tsx prisma/seed.ts
   ```

### Step 2: Start Backend Server
```bash
cd backend
npm run dev
# Server listens on http://localhost:5000
```

### Step 3: Start Frontend Dashboard
```bash
cd frontend
npm run dev
# Dashboard launches on http://localhost:3000
```

### Step 4: Launch Web Dashboard
1. Open your browser to: **`http://localhost:3000`**
2. Sign in with the seeded Super Administrator credentials:
   - **Email**: `admin@worksight.io`
   - **Password**: `Admin@123456`
3. Navigate to **Live Cameras** (`/dashboard/cameras`) to view the live EZVIZ H7c stream with dual-lens switching (Channel 1 Wide Lens vs Channel 2 Pan-Tilt Lens).

---

## 5. Security & Privacy Guarantees

1. **No Hardcoded Secrets**: AppKey, AppSecret, and temporary tokens are strictly retained in backend environment variables and never transmitted to the browser client.
2. **Anonymous Vision Tracking**: The AI engine monitors spatial presence and occupancy counts using ephemeral tracking IDs. No biometric facial recognition or intrusive movement profiling is conducted.
3. **Productivity Separation**: Camera footage and zone occupancy measure physical presence and seating capacity only, ensuring camera detections are never converted into inaccurate automated "productivity scores".

