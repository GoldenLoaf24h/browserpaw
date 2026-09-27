# AI Agent Configuration & High-Efficiency Interaction Guide

[Chinese Version (zh-CN)](./AGENT_CONFIG_GUIDE.zh-CN.md)

This guide is specifically designed for **AI Agents (Claude Code, Cursor, Windsurf, Hermes, Roo Code, Goose, Codex, Antigravity)** and agent developers. It details how to configure, connect, and drive your local Google Chrome browser with maximum performance, minimal token cost, and physical event fidelity.

---

## 1. System Architecture & Mechanics

`BrowserPaw` is an industrial-grade browser control platform operating over the **Model Context Protocol (MCP)**:

- **Chrome MV3 Extension**: Runs directly inside your everyday Google Chrome. It injects native hardware-level events (`isTrusted: true`) via Chrome DevTools Protocol (CDP) and maintains an isolated, pure-memory WeakRef DOM index tree.
- **Native Bridge Server**: Runs locally on `127.0.0.1:12306` (or a custom port), providing standard MCP JSON-RPC endpoints over Streamable HTTP, Server-Sent Events (SSE), and standard I/O (stdio).
- **Native Messaging Host**: Bridges bidirectional communication between Chrome and Node.js via standard I/O streams with an internal 1000KB buffer truncation defense and session isolation.

---

## 2. One-Time Setup & Deployment

Before connecting your agent client to the MCP server, complete these initial setup steps:

### Step 1: Register Chrome Native Messaging Host

Execute the registration script once to bind the Native Messaging manifest with your browser:

- **Via Repository CLI (Cross-Platform)**:
  ```bash
  node app/native-server/dist/scripts/register-dev.js
  # or from native server directory:
  cd app/native-server && node dist/scripts/register-dev.js
  ```
- **If Globally Installed via npm / npx**:
  ```bash
  node app/native-server/dist/cli.js register
  ```

_The registration script creates the manifest pointing to the host runner and registers it in the OS registry (`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost` on Windows) or Chrome Application Support / NativeMessagingHosts directory on macOS and Linux._

### Step 2: Load Extension in Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable the **Developer mode** toggle in the upper-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the extension build output directory:
   ```
   <repo-root>/app/chrome-extension/.output/chrome-mv3
   ```
5. The BrowserPaw icon will appear in Chrome's extension toolbar.

### Step 3: Verify Ready State

- **Green Status**: Indicates the extension has successfully connected to the Native Messaging Host and the local bridge is operational.
- **Automated Self-Healing**: If the indicator momentarily shows yellow upon launch, the built-in watchdog probes over HTTP and recovers within 2 seconds.

---

## 3. Client MCP Configuration Templates

Copy the configuration snippet matching your agent platform into your MCP configuration file.

### 3.1 Authentication Token & Environment Variables

BrowserPaw enforces local token authentication to prevent unauthorized loopback access:

- **Token File Location**: `~/.chrome-mcp/bridge-token` (on Windows: `C:\Users\<username>\.chrome-mcp\bridge-token`)
- **Environment Variables**:
  - `CHROME_MCP_TOKEN`: Custom auth token string (overrides the generated token file).
  - `CHROME_MCP_TOOL_PROFILE`: Tool exposure profile. Values: `core` (14 tools, default ~11.5k tokens), `crawl` (12 tools, ~5.8k tokens), or `full` (all 50 tools, ~19.5k tokens).
  - `BROWSERPAW_TOOL_PREFIX`: Namespace prefix for tool names (`browserpaw_` or `chrome_`).

> **Note**: In `stdio` transport mode, the Native Server automatically generates or reads this token and completes internal handshakes with Chrome.

---

### 3.2 Claude Desktop / Claude Code

Configuration file: `~/.claude/claude_desktop_config.json` or project-level `mcpServers`:

#### Option A: Streamable HTTP / SSE Mode (Recommended for concurrency)

```json
{
  "mcpServers": {
    "browserpaw": {
      "url": "http://127.0.0.1:12306/sse",
      "headers": {
        "Authorization": "Bearer <TOKEN_FROM_BRIDGE_TOKEN_FILE>"
      }
    }
  }
}
```

#### Option B: Stdio Transport Mode (Agent-managed lifecycle)

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

---

### 3.3 Cursor Configuration

In `.cursor/mcp.json` or Settings -> Features -> MCP Servers -> Add New MCP Server:

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

---

### 3.4 Windsurf / Cascade Configuration

Configuration file: `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

---

## 4. Agent Interaction Rules & Best Practices

To minimize prompt token consumption, maximize responsiveness, and prevent click failures, agents **must adhere to these 6 core interaction rules**:

### Rule 1: DOM-First with 1-Based Numeric Indexing

- **Primary Path (90% of Interactions)**:
  1. Call `chrome_read_dom`. The output is a pruned accessibility tree stripped of invisible nodes and decorative wrappers, where every interactive element has a clean 1-based numeric index (e.g. `[1]`, `[2]`, `[5]`).
  2. Dispatch actions directly using the numeric index:
     - Click: `chrome_interact_index({ index: 5 })`
     - Type: `chrome_fill_index({ index: 2, text: "my-query" })`
- **Anti-Patterns to Avoid**:
  - Never guess long fragile CSS selectors (e.g. `div.app-container > section:nth-child(3)...`) or brittle absolute XPaths.
  - Never assume host DOM nodes have `data-mcp-idx` attributes.

### Rule 2: Single-Round Action Pipelining (Zero-RTT Submission)

- **For queries, form submissions, logins, and sequential flows**:
  - **Avoid the 3-Turn Ping-Pong**: Do not split simple workflows into Turn 1 `read_dom` -> Turn 2 `fill_index` -> Turn 3 `interact_index`. This introduces 2 redundant model round-trips and 10+ seconds of unnecessary latency.
  - **The 1-Turn Fast-Path Pattern**:
    1. **Search inputs / Single field queries**: Call `chrome_fill_index({ index: 15, text: "query", pressEnter: true })` to type, press Enter, and settle mutations in a single round-trip.
    2. **Input field with submit button**: Identify both elements from `chrome_read_dom`, then dispatch `chrome_batch_actions` in one round-trip:
       ```json
       {
         "actions": [
           { "type": "fill", "index": 15, "text": "my-query", "clear": true },
           { "type": "click", "index": 18 }
         ],
         "waitForSettle": true
       }
       ```
    3. **Multi-field forms**: Chain fills and submissions in `chrome_batch_actions` or use `chrome_form_pipeline`:
       ```json
       {
         "actions": [
           { "type": "fill", "index": 1, "text": "username@example.com", "clear": true },
           { "type": "fill", "index": 2, "text": "SuperSecretPassword123!", "clear": true },
           { "type": "click", "index": 3 },
           { "type": "wait", "durationMs": 500 }
         ],
         "waitForSettle": true
       }
       ```

### Rule 3: Visual Fallback & Coordinate Grid Rulers

- **When to invoke Visual Fallback (10% of Interactions)**:
  1. Pure HTML5 Canvas, WebGL, dynamic charts, or bot-obfuscated DOM trees.
  2. Icon-only buttons lacking ARIA labels or readable text nodes.
- **Visual Grounding Best Practices**:
  1. Call `chrome_screenshot({ grid: true })`:
     - Renders a semi-transparent high-contrast coordinate grid ruler over the viewport (with X/Y axis labels).
     - Agents read physical CSS pixel coordinates directly off the ruler, eliminating model coordinate drift hallucinations.
  2. Call `chrome_interact_index` with measured coordinates:
     ```json
     {
       "coordinate": { "x": 640, "y": 380 }
     }
     ```

### Rule 4: Autonomous Delta Piggybacking (Saves 50% RTT)

- Always specify `includeDelta: true` when calling `chrome_interact_index`, `chrome_fill_index`, or `chrome_batch_actions`.
- The extension captures DOM changes during the action's settle window and returns `delta: { added, modified, removed }` directly in the action response. You do not need to call `chrome_read_dom` again just to verify that a dropdown opened or a banner appeared.

### Rule 5: Targeted Lightweight Grep (`chrome_grep`)

- For large or infinite-scrolling pages with $>500$ nodes, avoid dumping the entire DOM tree. Call `chrome_grep({ query: "Login" })` to locate element indices in sub-milliseconds while slashing token consumption by 90%+.
- Supports multi-frame iframe penetration (hierarchically remapping child frame indices) and searches across element text, roles, `placeholder`, `aria-label`, and `value`.

### Rule 6: Adaptive Action Settle & Stale Index Self-Healing

- **Adaptive Settle (`waitForSettle: true`)**:
  - The internal watchdog monitors DOM MutationObservers and in-flight network requests. For idle pages, actions return in 50ms; for pages undergoing network fetch, the watchdog smoothly waits for completion.
- **Stale Index Self-Healing**:
  - When SPA navigation or async re-rendering invalidates an index, the tool returns a clear diagnostic instruction:
    `ACTION REQUIRED: Please call 'chrome_read_dom' to refresh the index tree before re-attempting interaction`
  - Never blindly retry the same stale index. Re-invoke `chrome_read_dom` to refresh indices, then continue.

---

## 5. Canonical Tool Quick Reference

| Tool Name                           | Key Parameters                               | Function & Description                                                  | Recommended Scenario                     |
| :---------------------------------- | :------------------------------------------- | :---------------------------------------------------------------------- | :--------------------------------------- |
| `chrome_read_dom`                   | `viewportOnly: true`                         | Pruned 1-based numbered accessibility tree; 85%+ token savings          | **First step on any new page**           |
| `chrome_interact_index`             | `index` or `coordinate: {x,y}`               | Hardware-level click, hover, double-click, or drag                      | Button clicks, link navigation           |
| `chrome_fill_index`                 | `index`, `text`, `clear: true`, `pressEnter` | Native physical typing, value clearance, and Enter key submission       | Single-field query and submission        |
| `chrome_batch_actions`              | `actions: [...]`, `waitForSettle: true`      | Sequential multi-step execution of clicks, fills, waits, and assertions | **Multi-field forms & complex flows**    |
| `chrome_screenshot`                 | `grid: true`, `targetIndex`, `format`        | In-memory base64 screenshot with optional coordinate grid ruler         | Canvas, complex captchas, non-DOM UI     |
| `chrome_upload_file`                | `index` or `clickTargetIndex`, `filePath`    | Uploads local files via OS path injection into file inputs              | File uploads, profile pictures           |
| `chrome_get_markdown`               | `includeLinks: true`                         | Clean, beautifully formatted markdown extraction                        | Article reading, page summarization      |
| `chrome_grep`                       | `query`, `searchType`                        | Sub-millisecond regex/text scan across frames and attributes            | Finding elements in large documents      |
| `chrome_inspect_media`              | `index` or `selector`                        | Extracts raw high-resolution image Data URLs or crops                   | Captchas, charts, raw product photos     |
| `chrome_request_human_intervention` | `reason`, `timeoutMs`                        | Mounts frosted-glass takeover banner, yielding control to user          | 2FA, slider captchas, sensitive payments |
| `chrome_undo_last_action`           | none                                         | Rolls back the most recent navigation or form fill step                 | Fast error recovery                      |
| `chrome_close_tabs`                 | `tabIds`, `url`, `confirm`                   | Closes tabs; requires `confirm: true` to close active foreground tab    | Tab cleanup, closing task pages          |
| `chrome_javascript`                 | `code`, `tabId`                              | Evaluates JavaScript with top-level await and auto-return expressions   | Ad-hoc calculations, DOM inspection      |
| `chrome_tool_docs`                  | `category`, `activateForSession`             | Dynamic discovery and on-demand session activation of tool categories   | Profile mode tool expansion              |

---

## 6. Diagnostic Checklist

1. **Connection Refused (`ECONNREFUSED 127.0.0.1:12306`)**:
   - Ensure Google Chrome is running with the BrowserPaw extension enabled.
   - Run `curl http://127.0.0.1:12306/ping` in terminal. A response of `{"status":"ok","message":"pong"}` confirms the service is listening.
2. **401 Unauthorized**:
   - Verify your client config includes `Authorization: Bearer <token>` matching `~/.chrome-mcp/bridge-token`.
3. **Extension Displays Yellow Warning**:
   - Check that `run_host.bat` (Windows) or `run_host.sh` has registered the manifest. Click "Reconnect" in the popup.
4. **Large File Uploads**:
   - Always supply local absolute file paths (e.g. `D:/docs/sample.pdf`). Do not convert files into multi-megabyte base64 strings across the Native Messaging pipe.
