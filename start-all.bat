@echo off
title WorkSight Launcher
echo ========================================================
echo         Starting WorkSight Enterprise System
echo ========================================================
echo.

echo [1/3] Starting Backend API on port 5000...
start "WorkSight Backend (Port 5000)" cmd /k "cd /d "%~dp0backend" && python -m uvicorn app.main:app --port 5000 --reload"

timeout /t 3 /nobreak >nul

echo [2/3] Starting AI Computer Vision Service on port 8000...
start "WorkSight AI Service (Port 8000)" cmd /k "cd /d "%~dp0ai-service" && python src/main.py"

timeout /t 3 /nobreak >nul

echo [3/3] Starting Next.js Frontend Dashboard on port 3000...
start "WorkSight Frontend (Port 3000)" cmd /k "cd /d "%~dp0frontend" && npx next dev -p 3000"

echo.
echo ========================================================
echo   WorkSight is starting up!
echo   - Frontend:    http://localhost:3000
echo   - Backend API: http://127.0.0.1:5000/docs
echo   - AI Service:  http://127.0.0.1:8000/health
echo ========================================================
