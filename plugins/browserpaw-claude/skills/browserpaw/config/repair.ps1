# ================================================================
#  BrowserPaw (mcp-chrome) One-Click Healthcheck & Repair (PowerShell)
# ================================================================

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "Running BrowserPaw System Healthcheck with auto-fix..." -ForegroundColor Cyan
node doctor.mjs --fix

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[SUCCESS] Healthcheck & repair complete!" -ForegroundColor Green
} else {
    Write-Host "`n[WARNING] Some checks reported issues. Check the log above." -ForegroundColor Yellow
}
