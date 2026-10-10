#!/usr/bin/env bash
set -e

echo "================================================================"
echo "       BrowserPaw Local Jev Decision Engine Launcher"
echo "             (Model: Mapika/decider-2b, Port: 8009)"
echo "================================================================"
echo ""

BP_HOME="${BROWSERPAW_HOME:-${HOME}/.browserpaw}"
MODEL_DIR="${BP_HOME}/models/decider-2b"
WEIGHTS_FILE="${MODEL_DIR}/model.safetensors"
PORT=8009

if [ ! -f "${WEIGHTS_FILE}" ]; then
    echo "[ERROR] Model weights not found at:"
    echo "        ${WEIGHTS_FILE}"
    echo ""
    echo "Please open the BrowserPaw Chrome extension Popup, click 'Local',"
    echo "and download the decider-2b model first."
    exit 1
fi

echo "[OK] Found model weights at: ${WEIGHTS_FILE}"

VENV_PYTHON="${BP_HOME}/venv/bin/python"
if [ -f "${VENV_PYTHON}" ]; then
    PYTHON_CMD="${VENV_PYTHON}"
    echo "[OK] Using dedicated BrowserPaw virtual environment."
elif command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
else
    PYTHON_CMD="python"
fi

DECIDER_REPO_DIR="${BP_HOME}/decider-repo"
if [ -d "${DECIDER_REPO_DIR}" ]; then
    export PYTHONPATH="${DECIDER_REPO_DIR}:${PYTHONPATH:-}"
fi

export DECIDER_MODEL="${MODEL_DIR}"
export DECIDER_WARMUP=0

echo "[INFO] Starting local decider service on port ${PORT}..."
echo "[INFO] Endpoint: http://127.0.0.1:${PORT}/v1/systemone"
echo ""

exec "${PYTHON_CMD}" -m uvicorn decider.serve:app --host 127.0.0.1 --port "${PORT}"
