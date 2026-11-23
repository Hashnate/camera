@echo off
title WorkSight Launcher
echo ========================================================
echo         Starting WorkSight Enterprise System
echo ========================================================
echo.

set "BACKEND_PY=python"
if exist "%~dp0backend\.venv\Scripts\python.exe" set "BACKEND_PY=%~dp0backend\.venv\Scripts\python.exe"

set "AI_PY=python"
if exist "%~dp0ai-service\.venv\Scripts\python.exe" set "AI_PY=%~dp0ai-service\.venv\Scripts\python.exe"

rem Phones on the office Wi-Fi must reach the frontend. Windows Firewall allows the standard Node
rem install, so prefer it over other copies (e.g. nvm) that the firewall would block.
set "NODE_EXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

echo [1/4] Starting Backend API on port 5000...
start "WorkSight Backend (Port 5000)" cmd /k "cd /d "%~dp0backend" && "%BACKEND_PY%" -m uvicorn app.main:app --port 5000 --reload"

timeout /t 3 /nobreak >nul

echo [2/4] Starting AI Computer Vision Service on port 8000...
start "WorkSight AI Service (Port 8000)" cmd /k "cd /d "%~dp0ai-service" && "%AI_PY%" src/main.py"

timeout /t 3 /nobreak >nul

rem Everyday use builds the dashboard for speed; "start-all.bat dev" gives live reload instead.
if /i "%~1"=="dev" (
  echo [3/4] Starting Next.js Frontend Dashboard on port 3000 ^(development mode^)...
  del "%~dp0frontend\.next\BUILD_ID" >nul 2>&1
  start "WorkSight Frontend (Port 3000)" cmd /k "cd /d "%~dp0frontend" && "%NODE_EXE%" node_modules\next\dist\bin\next dev -p 3000"
) else (
  echo [3/4] Building and starting Next.js Frontend Dashboard on port 3000 ^(takes a minute^)...
  start "WorkSight Frontend (Port 3000)" cmd /k "cd /d "%~dp0frontend" && "%NODE_EXE%" node_modules\next\dist\bin\next build && "%NODE_EXE%" node_modules\next\dist\bin\next start -p 3000"
)

echo [4/4] Starting phone HTTPS (QR face enrolment) on port 3443...
start "WorkSight Phone HTTPS (Port 3443)" cmd /k "cd /d "%~dp0frontend" && "%NODE_EXE%" scripts\lan-https.mjs"

echo.
echo ========================================================
echo   WorkSight is starting up!
echo   - Frontend:    http://localhost:3000
echo   - Backend API: http://127.0.0.1:5000/docs
echo   - AI Service:  http://127.0.0.1:8000/health
echo   - Phone enrolment: https://^<this PC's Wi-Fi IP^>:3443 (via QR code)
echo ========================================================
