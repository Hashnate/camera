# WorkSight v2.0 Deployment & Operations Guide

## 1. Prerequisites
- **Operating System**: Windows / Linux
- **Python**: 3.11+
- **Node.js**: 18+ or 20+
- **Database**: PostgreSQL 18
- **OpenCV Models**: `face_detection_yunet_2023mar.onnx` and `face_recognition_sface_2021dec.onnx` in `ai-service/models/`.

---

## 2. Environment Variables Configuration

### 2.1 Backend (`backend/.env`)
```bash
DATABASE_URL="postgresql://postgres:<password>@localhost:5432/worksight?schema=public"
JWT_SECRET="<your-secure-jwt-secret>"
JWT_EXPIRES_DAYS=7
PORT=5000
FRONTEND_URL="http://localhost:3000"
AI_SERVICE_URL="http://localhost:8000"
AI_SERVICE_KEY="<shared-secret-between-backend-and-ai>"
BIOMETRIC_ENCRYPTION_KEY="<32-byte-hex-or-string-for-aes-256-gcm>"

# EZVIZ Open Platform
EZVIZ_APP_KEY="<your-ezviz-app-key>"
EZVIZ_APP_SECRET="<your-ezviz-app-secret>"
EZVIZ_ACCESS_TOKEN="<your-ezviz-access-token>"
EZVIZ_API_BASE_URL="https://open.ezvizlife.com"
```

### 2.2 AI Service (`ai-service/.env`)
```bash
PORT=8000
BACKEND_API_URL="http://localhost:5000/api"
AI_SERVICE_KEY="<shared-secret-between-backend-and-ai>"
ENABLE_WORKER=true
FRAME_SOURCE="auto"
WATCH_CHANNELS="all"
FRAME_INTERVAL_SEC=0.5
MIN_FACE_SIZE=50
MATCH_THRESHOLD=0.24
MATCH_MARGIN=0.04
CONFIRM_FRAMES=2
CONFIRM_WINDOW_SEC=10
REPORT_COOLDOWN_SEC=60
```

---

## 3. Service Startup Commands

### Start Backend API Server:
```bash
cd backend
python -m uvicorn app.main:app --port 5000
```

### Start AI Face Recognition Service:
```bash
cd ai-service
python src/main.py
```

### Start Frontend Next.js Dashboard:
```bash
cd frontend
npm start
```
