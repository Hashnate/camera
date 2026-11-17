Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "         Starting WorkSight Enterprise System           " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$root = $PSScriptRoot

Write-Host "`n[1/3] Starting Backend API on port 5000..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; Write-Host '--- WorkSight Backend API ---' -ForegroundColor Green; python -m uvicorn app.main:app --port 5000 --reload"

Start-Sleep -Seconds 3

Write-Host "[2/3] Starting AI Vision Service on port 8000..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\ai-service'; Write-Host '--- WorkSight AI Service ---' -ForegroundColor Green; python src/main.py"

Start-Sleep -Seconds 3

Write-Host "[3/3] Starting Frontend Dashboard on port 3000..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; Write-Host '--- WorkSight Frontend ---' -ForegroundColor Green; npx next dev -p 3000"

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "  WorkSight services launched in separate windows!" -ForegroundColor Green
Write-Host "  - Frontend Dashboard: http://localhost:3000" -ForegroundColor Cyan
Write-Host "  - Backend API:        http://127.0.0.1:5000/docs" -ForegroundColor Cyan
Write-Host "  - AI Service Health:  http://127.0.0.1:8000/health" -ForegroundColor Cyan
Write-Host "========================================================`n" -ForegroundColor Green
