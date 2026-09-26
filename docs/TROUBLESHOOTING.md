# BrowserPaw Troubleshooting & Self-Healing Guide

[Chinese Version (zh-CN)](./TROUBLESHOOTING.zh-CN.md)

BrowserPaw consists of three locally coordinated tiers:

1. **Chrome Extension (MV3)**: Runs inside your everyday Google Chrome, executing CDP commands and DOM indexing.
2. **Native Messaging Host (Node.js)**: Launched automatically by Chrome via Native Messaging, bridging protocol calls.
3. **MCP Endpoint (127.0.0.1:12306 / Stdio)**: High-speed Fastify MCP server communicating with your AI agent (Cursor, Claude Code, Windsurf, Cline, Codex, Antigravity).

This guide provides definitive diagnostics, root cause explanations, and verified fixes for all known runtime and build issues.

---

## ⚡ Quick Self-Healing: One-Click Diagnostics

Before manual troubleshooting, run the automated diagnostic script from the repository root:

```bash
# Run read-only health checks via doctor script or CLI
node skill/config/doctor.mjs
# or via CLI entry point:
node bin/browserpaw.cjs doctor
# (or if globally installed: npx browserpaw doctor)

# Run automated diagnosis and self-healing (recreates tokens, repairs registry, syncs build artifacts)
node skill/config/doctor.mjs --fix
```

Windows users can also double-click [`skill/config/repair.bat`](../skill/config/repair.bat) or execute [`skill/config/repair.ps1`](../skill/config/repair.ps1).

---

## 1. Connection Refused: `127.0.0.1:12306`

### Symptom

Agent client reports: `fetch failed: ECONNREFUSED 127.0.0.1:12306` or `connect ECONNREFUSED 127.0.0.1:12306`.

### Root Cause

The local Native Bridge service is not currently running. BrowserPaw uses an **on-demand lifecycle**: Chrome automatically starts the Native Messaging Host when Chrome launches and the BrowserPaw extension is active. If Chrome is not open, the bridge does not run.

### Resolution Steps

1. **Launch Google Chrome**: Ensure Chrome is running on your desktop.
2. **Verify Extension State**: Navigate to `chrome://extensions/` and verify BrowserPaw is enabled (or load unpacked from `app/chrome-extension/.output/chrome-mv3`).
3. **Inspect Popup Status**: Click the BrowserPaw extension icon in Chrome's toolbar. The status dot in the 200px×80px panel should turn **Green** ("Connected").
4. **Inspect Port Listening**:
   ```powershell
   netstat -ano | findstr :12306
   ```
5. **Standalone Background Run (Optional)**: If you need to run the bridge independently without waiting for Chrome Native Messaging:
   ```bash
   node app/native-server/dist/index.js
   ```
6. **Windows Zombie Process Cleanup**:
   In older versions, abrupt Chrome terminations could occasionally leave orphan Node processes holding port 12306. BrowserPaw v2.3.8+ includes `closeAllConnections()` and a 1000ms unreferenced watchdog. If an old zombie process still occupies the port:
   ```powershell
   taskkill /F /IM node.exe
   ```

---

## 2. Extension Popup Displays Grey or Yellow ("Service Not Started")

### Symptom

Clicking the BrowserPaw extension icon displays a grey or yellow indicator, warning that the native bridge is unreachable.

### Root Cause & Fixes

1. **Unregistered Native Messaging Host**:
   Chrome cannot find the native messaging manifest in the OS registry. Run:
   ```bash
   node skill/config/doctor.mjs --fix
   # Or manually register:
   node app/native-server/dist/scripts/register.js
   ```
2. **Port Conflict on 12306**:
   Another process is occupying port 12306. Identify the conflicting PID:
   ```powershell
   netstat -ano | findstr :12306
   ```
   Kill the offending process or configure custom ports via `CHROME_MCP_PORT=12307` in your environment.
3. **Agent Control Disabled in Popup**:
   The popup toggle stores `agentControlEnabled` in `chrome.storage.session`. If toggled off, all MCP tool execution is intentionally intercepted. Open the popup and verify the toggle is **Active**.
4. **Extension Reload Requires Host Reconnect**:
   When you reload the extension in `chrome://extensions`, the native messaging pipe breaks. Click the extension popup once or restart Chrome to re-establish the pipe.

---

## 3. HTTP `401 Unauthorized` or Token Validation Failure

### Symptom

MCP client requests fail with `HTTP 401 Unauthorized: Missing or invalid token` or `Unauthorized: Invalid bridge token`.

### Root Cause

To protect your active browser sessions from untrusted local websites or processes, BrowserPaw strictly enforces token authentication. The client configuration must match the token stored in `~/.chrome-mcp/bridge-token`.

### Resolution Steps

1. **Retrieve Active Token**:
   ```powershell
   # Windows PowerShell
   Get-Content "$HOME\.chrome-mcp\bridge-token"
   ```
   ```bash
   # macOS / Linux
   cat ~/.chrome-mcp/bridge-token
   ```
2. **Update Agent Client Configuration**:
   Ensure your MCP client headers contain the exact token. Both `x-mcp-token` and standard `Authorization: Bearer <token>` are supported:
   ```json
   {
     "mcpServers": {
       "browserpaw": {
         "url": "http://127.0.0.1:12306/mcp",
         "headers": {
           "x-mcp-token": "<TOKEN_FROM_BRIDGE_TOKEN_FILE>",
           "Authorization": "Bearer <TOKEN_FROM_BRIDGE_TOKEN_FILE>"
         }
       }
     }
   }
   ```
3. **Auto-Generate Missing Token**:
   If the file does not exist, run `node skill/config/doctor.mjs --fix` to generate a fresh cryptographic token.

---

## 4. Stale Element Indexes: `ACTION REQUIRED: Element reference is stale`

### Symptom

Calling `chrome_interact_index`, `chrome_fill_index`, or `chrome_hover_index` returns:
`ACTION REQUIRED: Element reference is stale. Please call 'chrome_read_dom' to refresh the index tree.`

### Root Cause

Modern Single Page Applications (React, Vue, Next.js) dynamically re-render DOM trees following route changes, modal animations, or API updates. The 1-based index (e.g. `[14]`) previously captured no longer references the active DOM node.

### Standard Agent Protocol

**Do NOT blindly retry the same index!**
The agent must immediately invoke `chrome_read_dom` to obtain fresh 1-based element indices, then resume actions using the new index. Alternatively, use `chrome_batch_actions` which validates element presence before multi-step dispatch.

---

## 5. High-DPI Displays (125%/150%/200%) & Click Coordinate Drift

### Symptom

When using visual clicking tools (`chrome_click_coordinate`), mouse clicks land offset from the visible target on high-resolution or scaled Windows displays.

### Architecture & Assurance

BrowserPaw implements **1:1 Viewport CSS Geometric Normalization** inside `screenshot.ts`. Screenshots are resampled via `OffscreenCanvas` to exact standard CSS viewport dimensions ($W_{viewport} \times H_{viewport}$).

### Important Agent Guideline

**Never manually multiply coordinates by the Device Pixel Ratio (DPR)!**
Always dispatch coordinates directly as measured against the screenshot image. BrowserPaw's internal kinematics engine maps 1:1 CSS coordinates directly to CDP hardware events.

---

## 6. Native Dialog Interception (Alert / Confirm / Prompt)

### Symptom

A web page triggers a synchronous browser `window.alert()`, `window.confirm()`, or `window.prompt()`, causing CDP commands or scripts to hang.

### Self-Healing Flow

BrowserPaw automatically intercepts modal dialogs via `Page.javascriptDialogOpening`. When an action triggers a dialog, it immediately returns:

```json
{
  "requiresDialogAction": true,
  "dialog": {
    "type": "alert",
    "message": "Are you sure you want to proceed?"
  }
}
```

**Resolution**: Call `chrome_handle_dialog({ action: "accept" })` (or `"dismiss"`, with optional `promptText`) to dismiss the modal and unlock subsequent actions.

---

## 7. Accidental Tab Closure Protection (`confirm: true`)

### Symptom

Calling `chrome_close_tabs({})` fails with:
`No tabIds or url specified. To close the current active tab, pass confirm: true or specify tabIds explicitly...`

### Safety Rationale

To prevent autonomous agents from accidentally closing the user's active foreground working tabs due to omitted arguments, closing active tabs requires explicit confirmation.

### Resolution

- To close agent-created tabs, provide explicit `tabIds: [tabId]` or target `url`.
- If working within a bound session, provide `sessionId` to release associated tabs.
- If you genuinely intend to close the user's current foreground tab, explicitly pass `confirm: true`.

---

## 8. CDP Detachment & Timeout Guards (`timeout-guard detached`)

### Symptom

CDP tool execution returns: `Target closed / not attached / timeout-guard detached`.

### Underlying Mechanism

If a target page crashes, navigates abruptly, or CDP commands exceed safety latency thresholds, the low-level `timeout-guard` triggers an immediate physical detachment (`chrome.debugger.detach`) and purges domain reference counters. This prevents Chrome's Service Worker from deadlocking or leaking memory.

### Resolution

Refresh the page or re-invoke the tool. BrowserPaw will automatically re-attach a fresh, clean CDP debugging session.

---

## 9. Background Tab Offscreen Screenshots & Privacy Isolation

### Architecture

For background tabs (`active: false`), BrowserPaw strictly dispatches CDP `Page.captureScreenshot` (`fromSurface: true`). It **strictly forbids** `chrome.tabs.captureVisibleTab`.

### Benefits

1. **Zero Privacy Leakage**: Prevents capturing the user's active personal screen while an agent operates in the background.
2. **Deadlock Elimination**: Background tabs suspended by Chrome's `requestAnimationFrame` power-saving mechanisms capture cleanly without hanging.

---

## 10. Dynamic Profile Activation Under Stdio and HTTP/SSE

### Use Case

When running in restricted profiles (`core` 14 tools or `crawl` 12 tools), an agent can dynamically request access to advanced tools (e.g. `manage`, `diagnose`, `network`) without restarting the server process.

### Method

Invoke:

```json
chrome_tool_docs({ "category": "manage", "activateForSession": true })
```

The requested tools immediately become callable within the current session across both Stdio and HTTP/SSE transports.

---

## 11. `chrome_javascript` Expression Execution

### Convenience Feature

When evaluating JavaScript expressions via `chrome_javascript`, you do not need to wrap code in `(function(){ return ... })()`. Single expressions such as `document.title`, `window.location.href`, or concise evaluations are automatically wrapped in `return (...)`. For multi-line statements, include standard `return` statements.

---

## 12. Error Code & Diagnostic Reference Table

| Error Signature                                            | Root Cause                                                                 | Verified Action                                                           |
| :--------------------------------------------------------- | :------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| `Cannot access a chrome:// URL`                            | Chrome security restricts extensions from debugging internal system pages. | Navigate to a standard `http://`, `https://`, or `file://` URL.           |
| `executeScript timeout ... renderer not acking`            | Renderer process unresponsive or blocked by native modal dialog.           | Call `chrome_handle_dialog` or refresh target tab.                        |
| `CDP_DISPATCH_TIMEOUT`                                     | Background tab execution timed out under heavy system throttling.          | Retry action or briefly switch tab to foreground.                         |
| `Security check failed: Domain changed`                    | Navigation occurred between screenshot capture and coordinate action.      | Call `chrome_read_dom` or `chrome_take_screenshot` to re-align state.     |
| `Tool X is not exposed under the ... profile`              | Tool is hidden under active profile (`core`/`crawl`).                      | Call `chrome_tool_docs({ category: "<cat>", activateForSession: true })`. |
| `Tool X is not a BrowserPaw tool`                          | Non-existent tool name requested.                                          | Consult `tools/list` (49 canonical tools available).                      |
| `captureScreenshot returned empty data for background tab` | Background tab was closed or discarded by Chrome memory saver.             | Re-open or navigate to target URL.                                        |
| `Failed to ... index [X] in cross-origin frame`            | Child iframe was unmounted or restricted by sandbox permissions.           | Inspect frame status using `chrome_read_dom({ filter: "interactive" })`.  |
| `Message sender rejected / unauthenticated content script` | Security guard blocked unauthorized message sender (`_sender.tab`).        | Ensure requests originate from authentic native bridge channels.          |

---

## 13. Monorepo Build Troubleshooting

### Clean Build Sequence

If you encounter TypeScript errors (`TS7016`, missing declarations) when building from source:

```bash
# 1. Install dependencies
pnpm install

# 2. Shared types MUST be built first
pnpm --filter chrome-mcp-shared build

# 3. Build full monorepo
pnpm build
```

### Component Build Shortcuts

- **Extension only**: `pnpm --filter @browserpaw/extension build` (output: `app/chrome-extension/.output/chrome-mv3`)
- **Native Bridge only**: `pnpm --filter @browserpaw/native-server build`

---

## 14. Log Locations & Diagnostics

- **Chrome Extension Service Worker**:
  Open `chrome://extensions/` → Click **Service Worker** inspect link under BrowserPaw → Inspect console messages prefixed with `[NativeHost]` or `[Screenshot Tool]`.
- **Native Server Logs**:
  Output directly to the process `stdout`/`stderr` or your terminal console.
- **Trace Files**:
  Performance traces recorded via `chrome_performance_start` default to the OS temporary directory (`os.tmpdir()`), unless `saveToDownloads: true` is explicitly requested.

---

## 15. Component & File Directory Map

| Component                | Source Code Path               | Production Artifact / Endpoint                          |
| :----------------------- | :----------------------------- | :------------------------------------------------------ |
| **Chrome MV3 Extension** | `app/chrome-extension/`        | `app/chrome-extension/.output/chrome-mv3`               |
| **Native Bridge Server** | `app/native-server/`           | `127.0.0.1:12306` (Token: `~/.chrome-mcp/bridge-token`) |
| **Shared Tool Schemas**  | `packages/shared/src/tools.ts` | 49 canonical MCP tool definitions                       |
| **Diagnostics & Repair** | `skill/config/`                | `doctor.mjs`, `mcp-config.json`, `repair.bat`           |
