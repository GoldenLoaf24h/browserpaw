#!/bin/bash
# Resolve the absolute directory containing this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/Users/hang/code/tencent/ai/chrome-mcp-server/app/native-server/dist/logs" # Or an alternative directory with confirmed write permissions

# Append timestamp to log filename to prevent overwriting
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WRAPPER_LOG="${LOG_DIR}/native_host_wrapper_${TIMESTAMP}.log"

# Target path to the Node.js entrypoint
NODE_SCRIPT="${SCRIPT_DIR}/index.js"

# Ensure target log directory exists
mkdir -p "${LOG_DIR}"

# Log wrapper invocation metadata
echo "Wrapper script called at $(date)" > "${WRAPPER_LOG}"
echo "SCRIPT_DIR: ${SCRIPT_DIR}" >> "${WRAPPER_LOG}"
echo "LOG_DIR: ${LOG_DIR}" >> "${WRAPPER_LOG}"
echo "NODE_SCRIPT: ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "Initial PATH: ${PATH}" >> "${WRAPPER_LOG}"

# Dynamically locate the Node.js binary
NODE_EXEC=""
# 1. Probe 'which' (inherits launch PATH; Chrome environment PATH may be restricted)
if command -v node &>/dev/null; then
    NODE_EXEC=$(command -v node)
    echo "Found node using 'command -v node': ${NODE_EXEC}" >> "${WRAPPER_LOG}"
fi

# 2. Fall back to standard macOS Node.js installation paths
if [ -z "${NODE_EXEC}" ]; then
    COMMON_NODE_PATHS=(
        "/usr/local/bin/node"            # Homebrew on Intel Macs / direct install
        "/opt/homebrew/bin/node"         # Homebrew on Apple Silicon
        "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node | head -n 1)/bin/node" # NVM (latest installed)
        # Extend with additional environment-specific paths as needed
    )
    for path_to_node in "${COMMON_NODE_PATHS[@]}"; do
        if [ -x "${path_to_node}" ]; then
            NODE_EXEC="${path_to_node}"
            echo "Found node at common path: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            break
        fi
    done
fi

# 3. Terminate with error log if no viable Node.js binary is found
if [ -z "${NODE_EXEC}" ]; then
    echo "ERROR: Node.js executable not found!" >> "${WRAPPER_LOG}"
    echo "Please ensure Node.js is installed and its path is accessible or configured in this script." >> "${WRAPPER_LOG}"
    # Native Host should ideally stay resident to handle incoming frames
    # Without Node.js, the host target script cannot be executed regardless
    # Emitting a valid Native Messaging error payload to extension is preferred if feasible
    # Otherwise fail hard; Chrome will report 'Native Host Exited.'
    exit 1 # Hard exit required; subsequent exec would fail
fi

echo "Using Node executable: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
echo "Node version found by script: $(${NODE_EXEC} -v)" >> "${WRAPPER_LOG}"
echo "Executing: ${NODE_EXEC} ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "PWD: $(pwd)" >> "${WRAPPER_LOG}" # Log PWD for diagnostics

exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${LOG_DIR}/native_host_stderr_${TIMESTAMP}.log"