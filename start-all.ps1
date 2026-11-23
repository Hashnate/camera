# Starts WorkSight. Default: the dashboard runs as a production build (fast page changes).
#   .\start-all.ps1        everyday use (rebuilds the dashboard only if its code changed)
#   .\start-all.ps1 -Dev   development (live reload, but each page compiles on first visit)
param([switch]$Dev)

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "         Starting WorkSight Enterprise System           " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$root = $PSScriptRoot

$backendPy = if (Test-Path "$root\backend\.venv\Scripts\python.exe") { ".\.venv\Scripts\python.exe" } else { "python" }
$aiPy = if (Test-Path "$root\ai-service\.venv\Scripts\python.exe") { ".\.venv\Scripts\python.exe" } else { "python" }
# Phones on the office Wi-Fi must reach the frontend. Windows Firewall allows the standard Node
# install, so prefer it over other copies (e.g. nvm) that the firewall would block.
$node = if (Test-Path "$env:ProgramFiles\nodejs\node.exe") { "$env:ProgramFiles\nodejs\node.exe" } else { "node" }
$next = "node_modules\next\dist\bin\next"

# Production build is reused unless dashboard code changed since it was made.
$buildId = "$root\frontend\.next\BUILD_ID"
$needBuild = $true
if (-not $Dev -and (Test-Path $buildId)) {
    $builtAt = (Get-Item $buildId).LastWriteTime
    $sources = @("$root\frontend\src", "$root\frontend\next.config.mjs", "$root\frontend\tailwind.config.ts", "$root\frontend\package.json")
    $changed = Get-ChildItem $sources -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $builtAt } | Select-Object -First 1
    $needBuild = [bool]$changed
}

Write-Host "`n[1/4] Starting Backend API on port 5000..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; `$host.UI.RawUI.WindowTitle = 'WorkSight Backend (5000)'; Write-Host '--- WorkSight Backend API ---' -ForegroundColor Green; & $backendPy -m uvicorn app.main:app --port 5000 --reload"

Start-Sleep -Seconds 3

Write-Host "[2/4] Starting AI Vision Service on port 8000..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\ai-service'; `$host.UI.RawUI.WindowTitle = 'WorkSight AI Service (8000)'; Write-Host '--- WorkSight AI Service ---' -ForegroundColor Green; & $aiPy src/main.py"

Start-Sleep -Seconds 3

if ($Dev) {
    Write-Host "[3/4] Starting Frontend Dashboard on port 3000 (development mode)..." -ForegroundColor Yellow
    # A dev server overwrites the production build, so make the next normal start rebuild it.
    Remove-Item $buildId -ErrorAction SilentlyContinue
    $frontendCmd = "& '$node' $next dev -p 3000"
} elseif ($needBuild) {
    Write-Host "[3/4] Building and starting Frontend Dashboard on port 3000 (takes a minute)..." -ForegroundColor Yellow
    $frontendCmd = "& '$node' $next build; if (`$LASTEXITCODE -eq 0) { & '$node' $next start -p 3000 } else { Write-Host 'Build failed - see the errors above.' -ForegroundColor Red }"
} else {
    Write-Host "[3/4] Starting Frontend Dashboard on port 3000..." -ForegroundColor Yellow
    $frontendCmd = "& '$node' $next start -p 3000"
}
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; `$host.UI.RawUI.WindowTitle = 'WorkSight Frontend (3000)'; Write-Host '--- WorkSight Frontend ---' -ForegroundColor Green; $frontendCmd"

Write-Host "[4/4] Starting phone HTTPS (QR face enrolment) on port 3443..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; `$host.UI.RawUI.WindowTitle = 'WorkSight Phone HTTPS (3443)'; Write-Host '--- WorkSight Phone HTTPS ---' -ForegroundColor Green; & '$node' scripts\lan-https.mjs"

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "  WorkSight services launched in separate windows!" -ForegroundColor Green
Write-Host "  - Frontend Dashboard: http://localhost:3000" -ForegroundColor Cyan
Write-Host "  - Backend API:        http://127.0.0.1:5000/docs" -ForegroundColor Cyan
Write-Host "  - AI Service Health:  http://127.0.0.1:8000/health" -ForegroundColor Cyan
Write-Host "  - Phone enrolment:    https://<this PC's Wi-Fi IP>:3443 (via QR code)" -ForegroundColor Cyan
Write-Host "========================================================`n" -ForegroundColor Green
