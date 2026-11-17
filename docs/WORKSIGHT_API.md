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
