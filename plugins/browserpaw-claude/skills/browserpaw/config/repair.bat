@echo off
REM ================================================================
REM  BrowserPaw (mcp-chrome) One-Click Healthcheck & Repair
REM ================================================================

cd /d "%~dp0"
echo Running BrowserPaw diagnostic...
node doctor.mjs --fix

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Diagnostic encountered issues.
) else (
    echo.
    echo [SUCCESS] Diagnostic and repair check finished.
)

pause
