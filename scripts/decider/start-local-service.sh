#!/usr/bin/env bash
set -e

echo "================================================================"
echo "       BrowserPaw Local Jev Decision Engine Launcher"
echo "             (Model: Mapika/decider-2b, Port: 8009)"
echo "================================================================"
echo ""

MODEL_DIR="${HOME}/.browserpaw/models/decider-2b"
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
echo "[INFO] Starting local decider service on port ${PORT}..."
echo "[INFO] Endpoint: http://127.0.0.1:${PORT}/v1/systemone"
echo ""

if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
else
    PYTHON_CMD="python"
fi

${PYTHON_CMD} -m decider.serve --model "${MODEL_DIR}" --port "${PORT}" --compile
