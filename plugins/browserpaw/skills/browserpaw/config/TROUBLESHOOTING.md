# BrowserPaw Troubleshooting & Self-Healing Manual

[Chinese Version (zh-CN)](./TROUBLESHOOTING.zh-CN.md)

This manual compiles typical connectivity, state, and permission issues encountered when MCP-capable agents connect to BrowserPaw, detailing root causes and standard recovery workflows.

---

## ⚡ Quick Self-Healing: One-Click Diagnostics

Run the automated diagnostic script from the project root whenever an anomaly occurs:

```bash
# Run read-only health checks
node skill/config/doctor.mjs

# Execute diagnosis and self-repair (creates missing tokens, repairs registry, syncs artifacts)
node skill/config/doctor.mjs --fix
```

Windows users can also double-click [`skill/config/repair.bat`](./repair.bat) or run [`skill/config/repair.ps1`](./repair.ps1).

---

## Frequently Asked Questions (FAQ)

### 1. Client reports `Connection Refused: 127.0.0.1:12306`

- **Symptom**:
  Agent reports: `fetch failed: ECONNREFUSED 127.0.0.1:12306` when initializing connections or executing tools.
- **Root Cause**:
  The local Fastify Native Bridge service is not running. BrowserPaw follows an **on-demand lifecycle**: Chrome automatically spawns the Native Bridge through the Native Messaging Host when Chrome is running and the extension is active.
- **Resolution**:
  1. Open Google Chrome on your desktop;
  2. Confirm BrowserPaw is enabled in `chrome://extensions/` (or loaded from unpacked extension directory);
  3. Click the extension toolbar icon, open the 200px×80px popup, and verify the status indicator is **Green**;
  4. For standalone terminal execution, start the bridge manually:
     ```bash
     node app/native-server/dist/index.js
     ```

---

### 2. Extension popup displays Grey or Yellow ("Service Not Started")

- **Symptom**:
  Clicking the Chrome extension icon shows a grey or yellow indicator, failing to reach the local server.
- **Troubleshooting & Fix**:
  1. **Check Native Messaging Host Registration**:
     Run `node skill/config/doctor.mjs`. If the registry key is missing, execute:
     ```bash
     node app/native-server/dist/scripts/register.js
     ```
  2. **Check Port Conflict**:
     ```powershell
     netstat -ano | findstr :12306
     ```
     Terminate conflicting processes via Task Manager or `taskkill /F /PID <pid>`, then reopen Chrome.

---

### 3. MCP Request Fails with `401 Unauthorized` or Token Mismatch

- **Symptom**:
  MCP client calls fail with `Unauthorized: Missing or invalid token` or `Unauthorized: Invalid bridge token`.
- **Root Cause**:
  Native Bridge requires token authentication to block malicious local web pages or scripts. The client configuration token does not match `~/.chrome-mcp/bridge-token`.
- **Resolution**:
  1. Read the current active token:
     ```powershell
     # Windows PowerShell
     Get-Content "$HOME\.chrome-mcp\bridge-token"
     ```
  2. Update your agent's MCP config headers. Both `x-mcp-token` and `Authorization: Bearer <token>` are supported:
     ```json
     "headers": {
       "x-mcp-token": "<TOKEN>",
       "Authorization": "Bearer <TOKEN>"
     }
     ```

---

### 4. `ACTION REQUIRED: Please call 'browserpaw_read_dom' to refresh`

- **Symptom**:
  Calling `browserpaw_interact_index` or `browserpaw_fill_index` returns:
  `ACTION REQUIRED: Element reference is stale. Please call 'browserpaw_read_dom' to refresh the index tree.`
- **Root Cause**:
  SPA routing, modal animations, or asynchronous DOM mutations re-rendered the target tree. The numeric index (`ref`) is stale.
- **Protocol**:
  **Do NOT blindly retry!** The agent must invoke `browserpaw_read_dom` to obtain fresh 1-based indices, then continue.

---

### 5. High-DPI Displays (125%/150%/200%) Coordinate Alignment

- **Symptom**:
  Visual model clicks miss their target on high-resolution screens.
- **Assurance**:
  BrowserPaw normalizes all screenshots to **1:1 Viewport CSS Coordinates** ($W_{viewport} \times H_{viewport}$) inside `screenshot.ts`.
- **Rule**:
  **Do NOT manually multiply coordinates by DPR!** Measure directly from the screenshot and pass raw CSS values.

---

### 6. Native Dialogs (Alert / Confirm / Prompt) Blocking Execution

- **Symptom**:
  A native `alert()` or `confirm()` halts CDP commands.
- **Handling**:
  BrowserPaw intercepts the dialog and returns `requiresDialogAction: true`. Call `browserpaw_handle_dialog({ action: "accept" })` to dismiss and unfreeze execution.

---

### 7. Explicit Confirmation Required for `browserpaw_close_tabs` (`confirm: true`)

- **Symptom**:
  `browserpaw_close_tabs({})` fails with `No tabIds or url specified. To close the current active tab, pass confirm: true...`.
- **Safety Mechanism**:
  Protects users from accidental tab loss when agents omit target parameters. Pass `confirm: true` only if intentionally closing the active tab, or supply explicit `tabIds` / `sessionId`.

---

### 8. CDP Debugger Detached & Timeout Guards (`timeout-guard detached`)

- **Symptom**:
  `Target closed / not attached / timeout-guard detached`.
- **Mechanism**:
  On slow or unresponsive pages, the `timeout-guard` cleanly detaches (`chrome.debugger.detach`) to protect the Service Worker from deadlocks.
- **Action**:
  Refresh the tab or re-call the tool. The session will automatically re-attach cleanly.

---

### 9. Background Tab Offscreen Screenshots & Privacy Isolation

- **Mechanism**:
  Background tabs strictly use CDP `Page.captureScreenshot` with `fromSurface: true`. Never captures user's foreground display, and eliminates `requestAnimationFrame` freezing deadlocks.

---

### 10. Dynamic Profile Activation Under Stdio and HTTP/SSE

- **Method**:
  In `core` or `crawl` profiles, call:
  ```json
  browserpaw_tool_docs({ "category": "manage", "activateForSession": true })
  ```
  to dynamically expose advanced tools within the active session without restarting the server.

---

### 11. `browserpaw_javascript` Expression Evaluation

- **Feature**:
  Single expressions like `document.title` or `window.location.href` are automatically wrapped in `return (...)`.

---

## Directory & Component Map

| Component                | Source Path                    | Artifact / Runtime Endpoint                             |
| :----------------------- | :----------------------------- | :------------------------------------------------------ |
| **Chrome MV3 Extension** | `app/chrome-extension/`        | `app/chrome-extension/.output/chrome-mv3`               |
| **Native Bridge Server** | `app/native-server/`           | `127.0.0.1:12306` (Token: `~/.chrome-mcp/bridge-token`) |
| **MCP Tool Contract**    | `packages/shared/src/tools.ts` | 48 canonical MCP tool definitions                       |
| **Diagnostics & Repair** | `skill/config/`                | `doctor.mjs`, `mcp-config.json`, `repair.bat`           |
