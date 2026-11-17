# WorkSight Repository & Environment Audit (Phase 0)

**Date**: 2026-11-16  
**Auditor**: Principal Software Architect & QA Lead  
**Scope**: WorkSight v2.0 Platform (Frontend, Backend, AI Computer Vision Service, EZVIZ Dual-Lens Camera, PostgreSQL Database)

---

## 1. Verified Existing Repository Components

### 1.1 Backend (`backend/`)
- **Runtime & Framework**: Python 3.11 + FastAPI + Uvicorn (Port 5000)
- **Database & ORM**: PostgreSQL 18 (`worksight` database on port 5432) accessed via SQLAlchemy 2.0 with connection pooling.
- **Table Schema Convention**: PascalCase table names (`User`, `Employee`, `AttendanceRecord`, `FaceEnrollment`, `RecognitionEvent`) originally established to maintain parity with Prisma migrations.
- **Authentication**: JWT token verification (`backend/app/security.py`) supporting `SUPER_ADMIN`, `OFFICE_ADMIN`, `HR_MANAGER`, `SUPERVISOR`, `VIEWER`.
- **Existing Endpoints**:
  - `/api/auth/login`, `/api/auth/me`
  - `/api/employees` (CRUD, listing, detail)
  - `/api/cameras` (listing, streams, snapshots via EZVIZ Open Platform)
  - `/api/attendance` (today's records, historical summaries, manual check-in)
  - `/api/faces` (enrollment, webcam captures)
  - `/api/internal` (AI service communication authenticated via `X-Service-Key`)

### 1.2 Frontend (`frontend/`)
- **Runtime & Framework**: Next.js 14 App Router, React 18, TypeScript, Tailwind CSS (Port 3000)
- **Video Playback**: `hls.js` video streaming player for both EZVIZ lenses (`Ch 1: Wide Lens` and `Ch 2: Pan-Tilt`).
- **Core Pages**:
  - Overview (`/dashboard`)
  - Live Cameras (`/dashboard/cameras`)
  - Employees (`/dashboard/employees`)
  - Attendance Ledger (`/dashboard/attendance`)
  - Work Hours / Presence Timeline (`/dashboard/work-hours`)
  - Analytics (`/dashboard/analytics`)

### 1.3 AI Computer Vision Service (`ai-service/`)
- **Runtime & Framework**: Python 3.11 + FastAPI (Port 8000) + OpenCV DNN
- **Models**:
  - Face Detection: OpenCV YuNet (`face_detection_yunet_2023mar.onnx`, 232 KB, BSD-3 License)
  - Face Recognition: OpenCV SFace (`face_recognition_sface_2021dec.onnx`, 38.6 MB, BSD-3 License)
- **Hardware Streaming**: Multi-threaded ChannelWorker pulling live HLS video feeds from EZVIZ CS-H7c Channel 1 and Channel 2 independently at ~2 fps.

### 1.4 Hardware Environment
- **Camera**: EZVIZ CS-H7c Dual-Lens Smart Camera (`CS-H7c-R100-8G44WF`, Serial `BC7652775`)
- **Channel 1**: Fixed wide-angle lens (`Hashnate -WL`)
- **Channel 2**: Motorized pan-tilt lens (`Hashnate -PT`)
- **EZVIZ Open Platform**: Verified live via `https://open.ezvizlife.com/api/lapp/live/address/get` (HTTP 200 OK).

---

## 2. Identified Gaps & Architectural Conflicts

### 2.1 Critical Business Rule Conflict (Resolved in v2.0)
- **Conflict**: The previous prototype allowed the AI service to directly trigger `apply_recognition()` which automatically created an `AttendanceRecord` (check-in / check-out).
- **Master Rule**: **Face recognition must NEVER automatically create an official check-in or checkout.** Camera observations are supporting evidence for physical presence, while official attendance requires explicit employee actions or authorized administrator review.
- **Solution**: Segregate into **System A (Real-Time Employee Presence)** and **System B (Hybrid Employee Attendance)**.

### 2.2 Biometric Security & Encryption Gap
- **Gap**: `FaceEnrollment` stored 128-d raw float vectors in `REAL[]` columns without encryption.
- **Requirement**: Implement `FaceTemplate` using **AES-256-GCM** authenticated encryption with unique initialization vectors (IV) and authentication tags per template, plus key isolation and revocation workflows.

### 2.3 Attendance Session & Exception Management Gap
- **Gap**: The previous schema lacked multi-session daily support, idempotent check-in/out protection, partial unique indexing for active sessions, and an exception/review pipeline (`AttendanceReview`).
- **Requirement**: Implement `WorkSession`, `AttendanceEvent`, and `AttendanceReview`.

### 2.4 Presence State Engine Gap
- **Gap**: Missing uncertainty-aware state machine (`OBSERVED_RECENTLY`, `NOT_RECENTLY_OBSERVED`, `SENSOR_UNAVAILABLE`).
- **Requirement**: Implement `PresenceSession`, `RecognitionObservation`, and `CameraHealthEvent`.

---

## 3. Compatibility & Migration Decisions
1. **Preserve Existing Database Schema**: Add the new v2.0 tables (`FaceTemplate`, `RecognitionObservation`, `PresenceSession`, `AttendanceEvent`, `WorkSession`, `AttendanceReview`, `CameraHealthEvent`) alongside existing tables to prevent breaking historical records.
2. **Backend**: Implement the full suite of v2.0 APIs in the Python FastAPI backend, maintaining parity with all TypeScript/Pydantic schemas and ensuring clean, transaction-safe operations.
3. **Frontend**: Add explicit Check-In / Check-Out controls, Attendance Review queues, and decouple the Real-Time Presence view from official paid hours.
