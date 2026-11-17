# WorkSight v2.0 Database Schema Specification

## 1. Overview
The database uses PostgreSQL 18 with relational integrity, foreign key cascading, and partial unique indexes.

---

## 2. Core v2.0 Entities

### 2.1 `FaceTemplate`
Stores AES-256-GCM encrypted 128-d face embedding vectors.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUIDv4 |
| `employeeId` | `TEXT NOT NULL FK(Employee.id)` | Enrolled employee reference |
| `encryptedEmbedding` | `BYTEA NOT NULL` | 512-byte AES-256-GCM encrypted payload |
| `embeddingIv` | `TEXT NOT NULL` | 24-character hex IV (96 bits) |
| `embeddingTag` | `TEXT NOT NULL` | 32-character hex authentication tag (128 bits) |
| `encryptionKeyId` | `TEXT NOT NULL` | Key version ID (e.g. `v2-master-key-01`) |
| `algorithm` | `TEXT NOT NULL` | `AES-256-GCM` |
| `modelVersion` | `TEXT NOT NULL` | `SFace-2021dec` |
| `qualityScore` | `DOUBLE PRECISION NOT NULL` | Face quality assessment score |
| `sampleCount` | `INTEGER NOT NULL` | Sample counter |
| `status` | `TEXT NOT NULL` | `ACTIVE` or `REVOKED` |
| `enrollmentAuthorizationReference` | `TEXT` | Audit consent record |
| `enrolledById` | `TEXT FK(User.id)` | Administrator ID |
| `createdAt` | `TIMESTAMP(3) NOT NULL` | Enrolled timestamp |
| `revokedAt` | `TIMESTAMP(3)` | Revocation timestamp |

---

### 2.2 `WorkSession`
Represents official authorized attendance work sessions (System B).

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUIDv4 |
| `employeeId` | `TEXT NOT NULL FK(Employee.id)` | Target employee |
| `checkInAt` | `TIMESTAMP(3) NOT NULL` | Authoritative check-in time |
| `checkOutAt` | `TIMESTAMP(3)` | Authoritative check-out time |
| `status` | `TEXT NOT NULL` | `OPEN` or `CLOSED` |
| `createdAt` | `TIMESTAMP(3) NOT NULL` | Creation timestamp |
| `updatedAt` | `TIMESTAMP(3) NOT NULL` | Update timestamp |

**Indexes**:
- `CREATE UNIQUE INDEX "uq_open_work_session_per_employee" ON "WorkSession" ("employeeId") WHERE status = 'OPEN';`

---

### 2.3 `AttendanceEvent`
Immutable audit log of all attendance actions.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUIDv4 |
| `idempotencyKey` | `TEXT UNIQUE NOT NULL` | Client idempotency token |
| `employeeId` | `TEXT NOT NULL FK(Employee.id)` | Target employee |
| `action` | `TEXT NOT NULL` | `CHECK_IN` or `CHECK_OUT` |
| `source` | `TEXT NOT NULL` | `EMPLOYEE` or `ADMIN` |
| `effectiveAt` | `TIMESTAMP(3) NOT NULL` | Effective time of action |
| `recordedAt` | `TIMESTAMP(3) NOT NULL` | Server receipt time |
| `actorUserId` | `TEXT FK(User.id)` | User who triggered action |
| `reason` | `TEXT` | Optional reason/correction note |
| `sessionId` | `TEXT FK(WorkSession.id)` | Linked work session |

---

### 2.4 `PresenceSession`
Tracks real-time presence states (System A).

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUIDv4 |
| `employeeId` | `TEXT NOT NULL FK(Employee.id)` | Target employee |
| `startedAt` | `TIMESTAMP(3) NOT NULL` | Initial verified observation |
| `lastObservedAt` | `TIMESTAMP(3) NOT NULL` | Most recent verified observation |
| `closedAt` | `TIMESTAMP(3)` | Session closure time |
| `currentStatus` | `TEXT NOT NULL` | `OBSERVED_RECENTLY`, `NOT_RECENTLY_OBSERVED`, `SENSOR_UNAVAILABLE` |
| `currentZoneId` | `TEXT FK(OfficeZone.id)` | Office zone ID |
| `lastCameraId` | `TEXT FK(Camera.id)` | Camera source |
| `lastChannelNo` | `INTEGER` | Channel 1 (Wide) or Channel 2 (PT) |
| `lastSimilarity` | `DOUBLE PRECISION` | Match confidence score |
| `createdAt` | `TIMESTAMP(3) NOT NULL` | Ingestion timestamp |
| `updatedAt` | `TIMESTAMP(3) NOT NULL` | State update timestamp |

---

### 2.5 `RecognitionObservation`
Immutable record of camera sightings.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUIDv4 |
| `eventId` | `TEXT UNIQUE NOT NULL` | Globally unique event UUID |
| `employeeId` | `TEXT FK(Employee.id)` | Nullable (null for unknown persons) |
| `cameraId` | `TEXT FK(Camera.id)` | Camera reference |
| `channelNo` | `INTEGER NOT NULL` | Channel number (1 or 2) |
| `zoneId` | `TEXT FK(OfficeZone.id)` | Zone reference |
| `observedAt` | `TIMESTAMP(3) NOT NULL` | Camera timestamp |
| `receivedAt` | `TIMESTAMP(3) NOT NULL` | Ingestion timestamp |
| `similarityScore` | `DOUBLE PRECISION` | SFace cosine similarity score |
| `deduplicationKey` | `TEXT` | Multi-lens deduplication token |
| `isUnknown` | `BOOLEAN NOT NULL` | True if face was unidentified |

---

### 2.6 `AttendanceReview`
Queue for administrator disputes, exceptions, and missing checkouts.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUIDv4 |
| `employeeId` | `TEXT NOT NULL FK(Employee.id)` | Employee reference |
| `sessionId` | `TEXT FK(WorkSession.id)` | Problematic session |
| `issueType` | `TEXT NOT NULL` | `MISSING_CHECKOUT`, `ATTENDANCE_CORRECTION`, `SESSION_CONFLICT` |
| `description` | `TEXT NOT NULL` | Diagnostic description |
| `status` | `TEXT NOT NULL` | `OPEN`, `RESOLVED`, `DISMISSED` |
| `resolvedById` | `TEXT FK(User.id)` | Administrator ID |
| `resolution` | `TEXT` | Resolution note |
| `createdAt` | `TIMESTAMP(3) NOT NULL` | Filing time |
| `resolvedAt` | `TIMESTAMP(3)` | Resolution time |

---

### 2.7 `CameraHealthEvent`
System A camera health tracking.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUIDv4 |
| `cameraId` | `TEXT NOT NULL FK(Camera.id)` | Camera reference |
| `channelNo` | `INTEGER NOT NULL` | Channel 1 or 2 |
| `status` | `TEXT NOT NULL` | `ONLINE`, `DEGRADED`, `OFFLINE` |
| `observedAt` | `TIMESTAMP(3) NOT NULL` | Timestamp |
| `errorCode` | `TEXT` | Diagnostic error |
| `reconnectAttempts`| `INTEGER NOT NULL` | Number of retries |
| `lastFrameAt` | `TIMESTAMP(3)` | Last successful frame |
| `inferenceLatency` | `DOUBLE PRECISION` | Milliseconds |
| `droppedFrames` | `INTEGER NOT NULL` | Dropped count |
