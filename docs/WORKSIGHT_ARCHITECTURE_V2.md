# WorkSight v2.0 Architecture Specification

## 1. Executive Summary & Design Principles

WorkSight v2.0 implements a **production-ready hybrid architecture** segregating employee monitoring into two logically independent systems:

1. **System A — Real-Time Employee Presence**: Observational, camera-driven face recognition evidence. It tracks physical in-office presence with explicit uncertainty states (`OBSERVED_RECENTLY`, `NOT_RECENTLY_OBSERVED`, `SENSOR_UNAVAILABLE`).
2. **System B — Hybrid Employee Attendance**: Authoritative, transactional work sessions (`WorkSession`, `AttendanceEvent`) requiring explicit employee Check-In / Check-Out actions or authorized administrator review.

> **CRITICAL ARCHITECTURAL RULE**: Face recognition evidence from cameras **NEVER** automatically creates an official attendance check-in or check-out. Disappearing from camera view does **not** falsely check an employee out.

---

## 2. System A: Real-Time Employee Presence Pipeline

```mermaid
flowchart TD
    Cam1["Channel 1: Fixed Wide-Angle Lens\n(BC7652775 Ch 1)"] -->|HLS Stream ~2 fps| Worker1["Channel 1 Worker Thread"]
    Cam2["Channel 2: Pan-Tilt Lens\n(BC7652775 Ch 2)"] -->|HLS Stream ~2 fps| Worker2["Channel 2 Worker Thread"]
    
    Worker1 --> Detector["OpenCV YuNet Face Detector\n(Score ≥ 0.85, Min Size 50px)"]
    Worker2 --> Detector
    
    Detector --> Recognizer["OpenCV SFace 128-d Feature Extractor"]
    Recognizer --> Matcher["Cosine Similarity Matcher vs Enrolled Templates\n(Threshold 0.24, Margin 0.04)"]
    
    Matcher --> TemporalCheck{"Temporal Validator\n(2 confirmed matches in 10s)"}
    TemporalCheck -->|Confirmed| Deliver["Observation Event Dispatcher\n(POST /api/internal/presence/observations)"]
    
    Deliver --> BackendIngest["Node/FastAPI Observation Ingestion"]
    BackendIngest --> Dedup["Cross-Channel Deduplication Engine\n(3-second bucket window)"]
    Dedup --> PresenceDB[("PresenceSession & RecognitionObservation\nPostgreSQL 18")]
    PresenceDB --> LiveUI["Real-Time Presence Dashboard"]
```

### Presence Uncertainty State Machine:
- **`OBSERVED_RECENTLY`**: A verified match occurred within the freshness window (120 seconds).
- **`NOT_RECENTLY_OBSERVED`**: No verified match in the last 120 seconds. The employee is in an unmonitored zone, meeting room, or angled away. **Does not imply absence from building.**
- **`SENSOR_UNAVAILABLE`**: Camera feed dropped, stream token expired, or network disrupted.

---

## 3. System B: Hybrid Employee Attendance Architecture

```mermaid
flowchart LR
    Employee["Employee / Browser Console"] -->|Explicit Check-In / Out| AuthAPI["POST /api/attendance/check-in\nPOST /api/attendance/check-out"]
    AuthAPI --> TxManager["Transactional WorkSession Manager"]
    TxManager --> PartialIdx{"Partial Unique Index Guard\n(Only 1 OPEN session per employee)"}
    PartialIdx --> WorkSessionTable[("WorkSession Table\nPostgreSQL")]
    TxManager --> EventTable[("AttendanceEvent (Immutable Audit)\nPostgreSQL")]
    
    ReviewEngine["Missing Checkout & Exception Detector"] -->|Scans sessions > 12h| ReviewTable[("AttendanceReview Queue")]
    AdminUser["Office Administrator"] -->|Resolves Disputes & Corrections| ReviewTable
```

### Key Business Rules:
1. **Single Open Session**: An employee can only have one active `OPEN` work session at any given time, enforced by a partial unique index in PostgreSQL (`uq_open_work_session_per_employee`).
2. **Multiple Daily Sessions**: Employees can log multiple valid work sessions per day (e.g. morning shift, off-site errand, evening shift).
3. **Idempotency**: All check-in and check-out requests accept an `idempotencyKey` to prevent double-submitting during network retries.
4. **Complete Non-Biometric Path**: Employees who decline face recognition have identical access to attendance check-in/out without penalty.
