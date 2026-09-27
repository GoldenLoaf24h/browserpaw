@echo off
setlocal enabledelayedexpansion

echo ================================================================
echo        BrowserPaw Local Jev Decision Engine Launcher
echo              (Model: Mapika/decider-2b, Port: 8009)
echo ================================================================
echo.

set "MODEL_DIR=%USERPROFILE%\.browserpaw\models\decider-2b"
set "WEIGHTS_FILE=%MODEL_DIR%\model.safetensors"
set "PORT=8009"

if not exist "%WEIGHTS_FILE%" (
    echo [ERROR] Model weights not found at:
    echo         %WEIGHTS_FILE%
    echo.
    echo Please open the BrowserPaw Chrome extension Popup, click "Local",
    echo and download the decider-2b model first.
    echo.
    pause
    exit /b 1
)

echo [OK] Found model weights at: %WEIGHTS_FILE%
set "VENV_PYTHON=%USERPROFILE%\.browserpaw\venv\Scripts\python.exe"
if exist "%VENV_PYTHON%" (
    set "PYTHON_BIN=%VENV_PYTHON%"
    echo [OK] Using dedicated BrowserPaw virtual environment.
) else (
    where python >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] Python was not found. Please install Python 3.11+ and add it to PATH.
        pause
        exit /b 1
    )
    set "PYTHON_BIN=python"
)

echo [INFO] Starting local decider service on port %PORT%...
echo [INFO] Endpoint: http://127.0.0.1:%PORT%/v1/systemone
echo.

set "DECIDER_MODEL=%MODEL_DIR%"
set "DECIDER_DEVICE=cuda"
set "DECIDER_WARMUP=0"
"%PYTHON_BIN%" -m uvicorn decider.serve:app --host 127.0.0.1 --port %PORT%

if %errorlevel% neq 0 (
    echo.
    echo [WARN] Decider service stopped with error code %errorlevel%.
    pause
)

