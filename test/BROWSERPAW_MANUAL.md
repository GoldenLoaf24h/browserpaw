# BrowserPaw Integration & Control Manual

[Chinese Version (zh-CN)](./BROWSERPAW_MANUAL.zh-CN.md)

> **Audience**: Developers and agent integrators connecting directly to BrowserPaw via HTTP, SSE, or stdio JSON-RPC.  
> **Default Endpoint**: `http://127.0.0.1:12306/mcp` (Streamable HTTP / SSE).  
> **Protocol**: Model Context Protocol (MCP) `2024-11-05`.

---

## 1. MCP Service Connectivity

### 1.1 Architecture & Pipeline

```text
MCP Client ──POST http://127.0.0.1:12306/mcp (Streamable HTTP)──▶ Native Host (Node.js)
    Native Host ──Native Messaging (4-byte LE length-prefixed frame)──▶ Chrome MV3 Extension
        Extension ──CDP (Hardware Events) / In-page Engine──▶ Target Webpage
```

**Key Source Locations**:

- HTTP Server & Auth: `app/native-server/src/server/index.ts`, `app/native-server/src/server/token.ts`
- MCP Session & Dispatch: `app/native-server/src/mcp/{mcp-server.ts, register-tools.ts, session-manager.ts}`
- Stdio Transport: `app/native-server/src/mcp/mcp-server-stdio.ts`

### 1.2 Endpoints & Protocols

| Method       | Path        | Purpose                                     | Authentication |
| :----------- | :---------- | :------------------------------------------ | :------------- |
| **POST**     | `/mcp`      | Primary Channel: JSON-RPC (Streamable HTTP) | Required       |
| **GET**      | `/mcp`      | SSE Event Stream (Server push events)       | Required       |
| **DELETE**   | `/mcp`      | Session termination and resource cleanup    | Required       |
| **GET**      | `/ping`     | Fast health check                           | None           |
| **GET /sse** | `/sse`      | Legacy SSE transport stream                 | Required       |
| **POST**     | `/messages` | Legacy SSE message receiver                 | Required       |

### 1.3 Authentication

Every HTTP request (except `/ping` and CORS pre-flight `OPTIONS`) requires token authentication via one of three equivalent headers:

1. `Authorization: Bearer <token>` (Recommended standard)
2. `x-mcp-token: <token>`
3. Query parameter: `?token=<token>`

**Token Source**: `~/.chrome-mcp/bridge-token` (on Windows: `%USERPROFILE%\.chrome-mcp\bridge-token`).  
Precedence: Environment variable `CHROME_MCP_TOKEN` > file contents > auto-generated cryptographic token.

### 1.4 Session Handshake Flow

1. **`initialize`**: Send `POST /mcp` without `mcp-session-id` header:
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2024-11-05",
       "capabilities": {},
       "clientInfo": { "name": "custom-agent", "version": "1.0" }
     }
   }
   ```
   The server generates a session UUID and returns it in the response header `mcp-session-id`.
2. **`notifications/initialized`**: Send notification without an `id` field, carrying the `mcp-session-id` header.
3. **Subsequent calls**: All subsequent `tools/list` and `tools/call` requests must pass the `mcp-session-id` header.
4. **Lifecycle**: Sessions idle for 10 minutes are automatically garbage-collected.

### 1.5 Minimal Node.js Client Implementation

```javascript
import fs from 'node:fs';
import os from 'node:os';

const BASE = 'http://127.0.0.1:12306/mcp';
const TOKEN = fs.readFileSync(`${os.userInfo().homedir}/.chrome-mcp/bridge-token`, 'utf8').trim();
let sessionId = null;

function parseSse(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6));
      } catch {}
    }
  }
  return null;
}

async function rpc(method, params) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const rawText = await res.text();
  const msg = parseSse(rawText) ?? JSON.parse(rawText);
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  return msg.result;
}

// 1. Handshake
await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'demo', version: '1.0' },
});
await rpc('notifications/initialized');

// 2. Execute canonical tools
const windows = await rpc('tools/call', { name: 'get_windows_and_tabs', arguments: {} });
console.log('Open tabs:', windows.content[0].text);

const dom = await rpc('tools/call', { name: 'chrome_read_dom', arguments: { viewportOnly: true } });
console.log('DOM snapshot:', dom.content[0].text);
```

---

## 2. Canonical Tool Surface (50 MCP Tools)

BrowserPaw exposes 48 canonical MCP tools organized into 8 functional categories:

1. **Autonomous Micro-Loop (1)**: `chrome_act_toward_goal` (local fast-decision loop at ~200-400ms/step).
2. **Navigation & Tabs (7)**: `chrome_navigate`, `chrome_switch_tab`, `chrome_close_tabs`, `chrome_move_tab`, `get_windows_and_tabs`, `chrome_attach_tab`, `chrome_detach_tab`.
3. **Perception & Content (5)**: `chrome_read_dom`, `chrome_grep`, `chrome_get_markdown`, `chrome_inspect_media`, `chrome_get_dropdown_options`.
4. **Interaction & Forms (13)**: `chrome_interact_index`, `chrome_fill_index`, `chrome_batch_actions`, `chrome_form_pipeline`, `chrome_smart_scroll`, `chrome_keyboard`, `chrome_upload_file`, `chrome_insert_media`, `chrome_interact_index`, `chrome_batch_actions`, `chrome_undo_last_action`, `chrome_computer`, `chrome_handle_dialog`.
5. **Observation & Vision (4)**: `chrome_screenshot`, `chrome_take_screenshot`, `chrome_visual_diff`, `chrome_visual_viewport`.
6. **Data & Tabs (7)**: `chrome_tab_group_create`, `chrome_tab_group_update`, `chrome_tab_group_list`, `chrome_tab_group_ungroup`, `chrome_tab_group_close`, `chrome_history`, `chrome_bookmark_search`.
7. **Diagnostics & Scripting (4)**: `chrome_javascript`, `chrome_tool_docs`, `chrome_doctor`, `chrome_intercept_api`.
8. **Network & Low-Level CDP (7)**: `chrome_network_request`, `chrome_network_capture`, `chrome_cdp_execute`, `chrome_console`, `chrome_storage`, `chrome_request_human_intervention`, `performance_start_trace`.

---

## 3. High-Efficiency Patterns

### 3.1 Pruned 1-Based DOM Indexing (`chrome_read_dom`)

- Extracts a compact numbered tree (`[1]`, `[2]`, `[14]`) stripped of decorative wrappers and invisible elements.
- Returns `treeString` directly to prompt contexts, slashing token usage by 85%+ vs raw HTML.
- Preserves accessibility metadata: `role`, `aria-label`, `placeholder`, `disabled`, and `href`.

### 3.2 Action Delta Piggybacking (`includeDelta: true`)

- Interactive tools (`chrome_interact_index`, `chrome_fill_index`, `chrome_batch_actions`) automatically diff the DOM before and after actions.
- Returns `{ added: [...], modified: [...], removed: [...] }` directly in the action response, eliminating secondary inspection calls.

### 3.3 Visual Grounding with Coordinate Rulers

- For canvas applications, WebGL, or bot-obfuscated sites, call `chrome_screenshot({ grid: true })`.
- Direct 1:1 CSS pixel measurement off the grid ruler eliminates coordinate drift.
