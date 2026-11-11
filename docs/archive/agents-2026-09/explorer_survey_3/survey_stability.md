# R1: MCP-Chrome Stability & Protocol Specification Survey

**Author**: explorer_survey_3 (Stability & Protocol Spec Miner)  
**Date**: 2026-09-05  
**Target Repository**: `d:\workspace\mcp-chrome-master\mcp-chrome-master`  
**Reference Sources**:

- Current Codebase: `app/native-server`, `app/chrome-extension`, `packages/shared`
- Reference Engine: `d:\workspace\mcp-chrome-master\browser-use-main\browser-use-main`
- Model Context Protocol (MCP) Official Specification (`@modelcontextprotocol/sdk`)
- Chrome DevTools Protocol (CDP) Documentation & Chrome Extension Manifest V3 Specifications

---

## 1. Executive Summary

This specification document provides an exhaustive root-cause analysis and definitive technical architecture for the six core stability and protocol requirements in Milestone R1:

1. **Multi-client & Multi-session HTTP/SSE Connection Conflicts**: Elimination of singleton MCP server cross-talk and connection killing.
2. **`ERR_HTTP_HEADERS_SENT` Race Conditions**: Harmonizing Fastify lifecycle hijacking and defensive raw Node.js HTTP stream error handling.
3. **stdio Orphan & Zombie Process Leaks**: Sub-second termination detection on parent exit for Windows and POSIX environments.
4. **Chrome Extension Connection Handshake & Status**: Eliminating permanent yellow-light deadlocks with a 3-second self-healing 2-way handshake and active ping/pong loop.
5. **Security Annotation Metadata**: Full compliance with latest MCP specifications (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`) across all 25+ existing and planned tools.
6. **Local File Upload (`input[type="file"]`) & `file://` Navigation**: Dual-mode file upload (DOM direct injection + CDP file-chooser interception) and robust `file://` URL handling with permission diagnostics.

---

## 2. Deep Root-Cause Analysis & Technical Specifications

### 2.1 Multi-Client & Multi-Session HTTP/SSE Connection Conflicts

#### 2.1.1 Code Inspection & File Citations

- **File**: `app/native-server/src/mcp/mcp-server.ts`
  - Lines 4–24:
    ```typescript
    export let mcpServer: Server | null = null;

    export const getMcpServer = () => {
      if (mcpServer) {
        return mcpServer;
      }
      mcpServer = new Server(
        { name: 'ChromeMcpServer', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      setupTools(mcpServer);
      return mcpServer;
    };
    ```
- **File**: `app/native-server/src/server/index.ts`
  - Lines 49–50, 169–193, 214–242:
    ```typescript
    private transportsMap: Map<string, StreamableHTTPServerTransport | SSEServerTransport> = new Map();
    // In GET /sse:
    const transport = new SSEServerTransport('/messages', reply.raw);
    this.transportsMap.set(transport.sessionId, transport);
    const server = getMcpServer();
    await server.connect(transport);
    // In POST /mcp:
    await getMcpServer().connect(transport);
    ```

#### 2.1.2 Root Cause Mechanism

1. **SDK 1:1 Transport Invariant**: In `@modelcontextprotocol/sdk/server/index.js` (and underlying `Protocol`), a `Server` instance maintains an internal single transport pointer: `this._transport = transport`.
2. **Transport Pointer Overwrite**: When Client A (e.g. Claude Code) connects to `/sse`, `mcpServer.connect(transportA)` binds `mcpServer._transport = transportA`. When Client B (e.g. Hermes or another MCP client) connects, `getMcpServer()` returns the exact same singleton instance and executes `mcpServer.connect(transportB)`, silently overwriting `_transport` with `transportB`.
3. **Cross-Talk & Message Black Hole**:
   - When Client A sends a JSON-RPC request to `POST /messages?sessionId=sessionA`, `transportA.handlePostMessage` receives the message and triggers `transportA.onmessage(parsedMessage)`.
   - `mcpServer` processes the tool call or query.
   - When `mcpServer` sends the response via `this.send(response)`, it calls `this._transport.send(response)`.
   - Because `this._transport` now points to `transportB`, **the response is pushed to Client B's SSE stream!**
   - Client A never receives the response and eventually fails with timeout. Client B receives an unrequested response for an unknown request ID and may discard it or log protocol violations.
4. **Cascading Disconnection**: When Client A disconnects, `transportA.onclose` fires. In SDK's `Protocol`, `transport.onclose` sets `this._transport = undefined`. This immediately breaks communication for Client B as well.

#### 2.1.3 Multi-Session Target Architecture

Instead of a single global `mcpServer`, the server must implement a **Multi-Session MCP Manager** pattern:

```
                  +----------------------------------------------+
                  |               Fastify Server                 |
                  +----------------------------------------------+
                                  |                 |
                    GET /sse      |                 | POST /mcp (init)
                                  v                 v
                  +----------------------------------------------+
                  |              McpSessionManager               |
                  |  - sessions: Map<sessionId, McpSessionEntry> |
                  +----------------------------------------------+
                           /                               \
                          v                                 v
          +-------------------------------+ +-------------------------------+
          |       McpSession [Client A]   | |       McpSession [Client B]   |
          |  - sessionId: UUID-A          | |  - sessionId: UUID-B          |
          |  - server: Server (dedicated) | |  - server: Server (dedicated) |
          |  - transport: SSEServerTrans. | |  - transport: StreamableHTTP  |
          |  - lastActive: timestamp      | |  - lastActive: timestamp      |
          +-------------------------------+ +-------------------------------+
                          \                               /
                           v                             v
                  +----------------------------------------------+
                  |             Shared Tool Registry             |
                  |     (Proxies calls to Native Host Bridge)    |
                  +----------------------------------------------+
```

1. **`McpSessionEntry` Interface**:
   ```typescript
   export interface McpSessionEntry {
     sessionId: string;
     server: Server; // Dedicated MCP SDK Server instance per session
     transport: SSEServerTransport | StreamableHTTPServerTransport;
     createdAt: number;
     lastActiveAt: number;
   }
   ```
2. **Session Lifecycle Operations**:
   - `createSession(transport, sessionId)`: Instantiates a new `Server`, binds tools from a shared tool definition factory, calls `server.connect(transport)`, registers session cleanup on `transport.onclose` or socket close.
   - `getSession(sessionId)`: Retrieves existing session entry and updates `lastActiveAt`.
   - `closeSession(sessionId)`: Closes server, closes transport, deletes from map.
   - `pruneStaleSessions(maxIdleMs = 300_000)`: Periodic background sweep for abandoned sessions.
3. **Thread-Safety & Concurrency**: The native host message dispatcher (`NativeMessagingHost`) already multiplexes tool calls using `requestId: uuidv4()`, so downstream Chrome extension calls are inherently concurrent and thread-safe. Only the upstream MCP server transport layer required session isolation.

---

### 2.2 `ERR_HTTP_HEADERS_SENT` Race Conditions

#### 2.2.1 Code Inspection & Failure Paths

- **File**: `app/native-server/src/server/index.ts`
  - Lines 169–193 (GET `/sse`):
    ```typescript
    reply.raw.writeHead(HTTP_STATUS.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    ...
    const server = getMcpServer();
    await server.connect(transport);
    reply.raw.write(':\n\n');
    } catch (error) {
      if (!reply.sent) {
        reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
      }
    }
    ```
  - Lines 196–211 (POST `/messages`):
    ```typescript
    await transport.handlePostMessage(req.raw, reply.raw, req.body);
    } catch (error) {
      if (!reply.sent) {
        reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
      }
    }
    ```
  - Lines 214–253 (POST `/mcp`):
    ```typescript
    await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      if (!reply.sent) {
        reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR });
      }
    }
    ```
  - Lines 256–286 (GET `/mcp`):
    `reply.hijack()` is only called _after_ `await transport.handleRequest(...)`. But for GET `/mcp` (SSE stream), `handleRequest` runs indefinitely until disconnect.
- **File**: `app/native-server/src/server/routes/agent.ts`
  - Lines 970–998 (GET `/agent/stream/:sessionId`):
    Directly writes `reply.raw.writeHead(...)` without invoking `reply.hijack()`, and catches errors with `reply.code(500).send(...)`.

#### 2.2.2 Root Cause Mechanism

1. **Fastify `reply.sent` vs Node `res.headersSent` Disconnect**:
   Fastify sets internal flag `reply.sent = true` when `reply.send()` is executed. When code writes to `reply.raw.writeHead(...)` or when SDK transport writes to `res.writeHead(...)`, Node's native HTTP layer sets `res.headersSent = true`, but Fastify's `reply.sent` remains `false`.
2. **Double Header Emission on Error**:
   If `server.connect(transport)` fails, or client socket terminates abruptly during `handlePostMessage`, control passes to `catch (error)`. The check `if (!reply.sent)` evaluates to `true`. Fastify then attempts `reply.code(500).send(...)`. Node.js detects that headers were already committed to the network socket and throws:
   `Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent to the client`.
3. **Missing or Late `reply.hijack()`**:
   In Fastify, when handling raw Node responses (`reply.raw`), `reply.hijack()` must be called synchronously before any asynchronous operations or transport delegation. Failing to hijack causes Fastify to keep listening to handler completion and potentially attempt to flush default empty responses or headers.

#### 2.2.3 Defensive Lifecycle Specification

1. **Mandatory Immediate Hijacking**:
   In every raw HTTP / SSE route (`/sse`, `/messages`, `/mcp`, `/agent/stream/:sessionId`), call `reply.hijack()` immediately upon entering the handler.
2. **Safe Response Utility**:
   Implement a centralized defensive response helper:
   ```typescript
   export function safeWriteError(
     reply: FastifyReply,
     statusCode: number,
     payload: Record<string, unknown> | string,
   ): void {
     const raw = reply.raw;
     if (raw.writableEnded || raw.destroyed) {
       return;
     }
     if (raw.headersSent) {
       try {
         raw.end();
       } catch {
         // Socket already closed
       }
       return;
     }
     try {
       const body =
         typeof payload === 'string' ? JSON.stringify({ error: payload }) : JSON.stringify(payload);
       raw.writeHead(statusCode, {
         'Content-Type': 'application/json',
         'Content-Length': Buffer.byteLength(body),
       });
       raw.end(body);
     } catch {
       // Ignore network drop
     }
   }
   ```
3. **Client Abort & Socket Teardown Guard**:
   Attach `'close'` and `'error'` listeners to `request.raw.socket` to cleanly suppress write errors when clients abort requests prematurely.

---

### 2.3 stdio Orphan & Zombie Process Leaks

#### 2.3.1 Code Inspection & Process Lifecycle

- **File**: `app/native-server/src/mcp/mcp-server-stdio.ts`
  - Lines 55–74, 117–125:
    ```typescript
    export const ensureMcpClient = async () => {
      ...
      mcpClient = new Client({ name: 'Mcp Chrome Proxy', version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {});
      await mcpClient.connect(transport);
      return mcpClient;
    };
    async function main() {
      const transport = new StdioServerTransport();
      await getStdioMcpServer().connect(transport);
    }
    ```
  - **Absence of Lifecycle Management**: No handler for `process.stdin.on('end')`, `process.stdin.on('close')`, `process.on('SIGTERM')`, or `process.on('SIGINT')`.
- **File**: `app/native-server/src/server/index.ts`
  - Lines 344–358 (`stop()` method):
    `await this.fastify.close()` will hang indefinitely if long-lived SSE connections (`/sse` or `/mcp`) remain open, preventing graceful shutdown.

#### 2.3.2 Root Cause Mechanism

1. **Windows Signal Absence**: On Windows, when a parent process (e.g. Claude Code CLI, Cursor, Windsurf) exits or is killed via Task Manager, no `SIGTERM` or `SIGINT` signal is delivered to child processes.
2. **Event Loop Retention via Active Handles**:
   - When the parent process terminates, the OS closes the IPC pipe, triggering `EOF` on `process.stdin`.
   - However, `@modelcontextprotocol/sdk`'s `StdioServerTransport` does not call `process.exit(0)` on `stdin` close.
   - `mcp-server-stdio.ts` initializes `StreamableHTTPClientTransport` and `Client` to talk to the HTTP native server. The underlying HTTP client connection / agent holds active TCP sockets and timers in the Node.js event loop.
   - Because the event loop is not empty, **Node.js remains running indefinitely as an orphaned background process**.
3. **Fastify `.close()` Deadlock on Native Server**:
   When `NativeMessagingHost` attempts to shut down via `cleanup()` calling `associatedServer.stop()`, Fastify's `.close()` waits for in-flight requests and open keep-alive connections. Because client SSE streams are persistent, `stop()` never resolves.

#### 2.3.3 Sub-Second Clean Exit Specification

1. **Multi-Channel Termination Triggers in `mcp-server-stdio.ts`**:
   - Listen to `process.stdin.on('end')` and `process.stdin.on('close')`.
   - Listen to `process.stdin.on('error')`.
   - Listen to `process.on('SIGINT')`, `process.on('SIGTERM')`, `process.on('SIGHUP')`.
2. **Hard Termination Guard (1-Second Cap)**:
   ```typescript
   function triggerCleanExit(code = 0): void {
     // Force exit if graceful teardown exceeds 800ms
     const forceTimer = setTimeout(() => {
       process.exit(code);
     }, 800);
     forceTimer.unref();

     // Teardown client and transports
     if (mcpClient) {
       try {
         mcpClient.close();
       } catch {}
     }
     process.exit(code);
   }
   ```
3. **Parent Process Liveness Watchdog**:
   Support optional `--parent-pid <pid>` argument or `MCP_PARENT_PID` environment variable:
   ```typescript
   function startParentWatchdog(parentPid: number): void {
     const interval = setInterval(() => {
       try {
         // On Windows and POSIX, kill(pid, 0) checks existence without sending signal
         process.kill(parentPid, 0);
       } catch (err: any) {
         if (err.code === 'ESRCH') {
           // Parent no longer exists
           triggerCleanExit(0);
         }
       }
     }, 1000);
     interval.unref(); // Ensure timer itself doesn't hold event loop open
   }
   ```
4. **Fastify Force-Close in Native Server**:
   In `server.stop()`, immediately iterate and destroy all active sockets and SSE client responses in `transportsMap` and `agentStreamManager` prior to calling `fastify.close()`, guaranteeing `fastify.close()` resolves in < 200ms.

---

### 2.4 Chrome Extension Connection Handshake & Status

#### 2.4.1 Code Inspection & State Breakdown

- **File**: `app/chrome-extension/entrypoints/popup/App.vue`
  - Lines 601–612, 702–716:
    ```typescript
    const getStatusClass = () => {
      if (nativeConnectionStatus.value === 'connected') {
        if (serverStatus.value.isRunning) {
          return 'bg-emerald-500'; // Green: running
        } else {
          return 'bg-yellow-500'; // Yellow: connected, service not started
        }
      } else if (nativeConnectionStatus.value === 'disconnected') {
        return 'bg-red-500';
      }
      return 'bg-gray-500';
    };
    ```
- **File**: `app/chrome-extension/entrypoints/background/native-host.ts`
  - Lines 344, 409–435, 456, 548–552:
    - `nativePort = chrome.runtime.connectNative(HOST_NAME)` returns synchronously.
    - Status query `PING_NATIVE` only checks `nativePort !== null`.
    - Extension sends `{ type: NativeMessageType.START, payload: { port } }`.
    - Server status only transitions to `isRunning = true` if `SERVER_STARTED` message is received.
    - If `ERROR_FROM_NATIVE_HOST` is received, it is simply logged via `console.error`; no status update or retry occurs.

#### 2.4.2 Root Causes of Permanent Yellow Light

1. **The "Fake Connected" Trap of `chrome.runtime.connectNative`**:
   `connectNative` returns a `chrome.runtime.Port` object synchronously before the native OS process is actually started. `nativePort !== null` immediately causes `nativeConnectionStatus = 'connected'`.
2. **The Yellow Light Deadlock**:
   - `nativeConnectionStatus` is `'connected'`, but `serverStatus.isRunning` remains `false`.
   - **Case A (Port `EADDRINUSE`)**: If port 12306 is occupied by an earlier zombie node process, Fastify fails to bind. `NativeMessagingHost` sends `ERROR_FROM_NATIVE_HOST`. The extension ignores this error, never receives `SERVER_STARTED`, and remains yellow permanently.
   - **Case B (Already Running Error)**: If native host was already running on port 12306, it responds with `NativeMessageType.ERROR` ("Server is already running"). The extension background script only listens for `SERVER_STARTED`, ignoring `ERROR`. Result: permanent yellow light.
   - **Case C (Service Worker MV3 Sleep Desync)**: When the Manifest V3 Service Worker wakes up after idle termination, `loadServerStatus()` loads stale storage data, while `connectNative` may fail to establish a clean handshake before popup queries the status.
3. **Lack of Active Health Check**:
   Neither native ping/pong nor HTTP `/ping` verification is executed.

#### 2.4.3 3-Second Self-Healing & Handshake Specification

1. **2-Way Handshake Protocol**:
   ```
   Extension (Background)                           Native Messaging Host
          |                                                   |
          | ---- connectNative(HOST_NAME) ------------------> | (Starts Node process)
          |                                                   |
          | ---- { type: 'HANDSHAKE', port: 12306 } --------> |
          |                                                   |
          | <--- { type: 'HANDSHAKE_ACK',                    | (Fastify ready check)
          |        status: 'ready', port: 12306 } ----------- |
          |                                                   |
          | ==== HTTP GET http://127.0.0.1:12306/ping ======> | (Verification)
          | <=== HTTP 200 { status: 'ok', message: 'pong' } == |
          |                                                   |
          [ Set Status = GREEN (Ready within 1.5s) ]
   ```
2. **Active Liveness Probe (Ping/Pong)**:
   - Extension sends `{ type: 'ping_from_extension', timestamp: Date.now() }` every 2000ms.
   - Native host replies `{ type: 'pong_to_extension', timestamp, serverRunning: true, port }`.
   - If no reply within 1500ms, mark disconnected and trigger instant reconnection.
3. **Automatic Port Fallback on `EADDRINUSE`**:
   If port 12306 fails with `EADDRINUSE`, native host automatically probes `/ping` on port 12306:
   - If existing process is a healthy `mcp-chrome-bridge`, native host adopts the port and returns `HANDSHAKE_ACK`.
   - If occupied by an unrelated process or unresponsive zombie, native host binds to fallback port (12307–12315) and notifies extension with `{ type: 'SERVER_STARTED', payload: { port: fallbackPort } }`.
4. **Fast Reconnect Strategy**:
   Replace 60-second backoff with instant retries at 300ms, 800ms, and 1500ms (guaranteeing self-healing within 3.0 seconds).

---

### 2.5 Security Annotation Metadata

#### 2.5.1 MCP Specification Requirements

Under the Model Context Protocol specification, tools support a top-level `annotations` field conforming to `ToolAnnotations`:

```typescript
export interface ToolAnnotations {
  /** If true, the tool does not modify environment or state (e.g. data retrieval) */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive mutations (e.g. delete data, close tabs) */
  destructiveHint?: boolean;
  /** If true, repeated calls with identical arguments yield identical environment state */
  idempotentHint?: boolean;
  /** If true, tool interacts with external / open-world systems beyond local environment */
  openWorldHint?: boolean;
  /** Human-readable display title */
  title?: string;
}
```

#### 2.5.2 Tool Annotation Mapping Matrix

Below is the definitive security annotation mapping for all 24 existing tools in `chrome-mcp-shared` plus the 4 planned R2 interaction tools:

| #   | Tool Name                                        | `title`                 | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` | Rationale                                                           |
| --- | ------------------------------------------------ | ----------------------- | -------------- | ----------------- | ---------------- | --------------- | ------------------------------------------------------------------- |
| 1   | `get_windows_and_tabs`                           | Get Windows and Tabs    | `true`         | `false`           | `true`           | `false`         | Read-only local browser state inspection                            |
| 2   | `chrome_navigate`                                | Navigate Tab            | `false`        | `false`           | `true`           | `true`          | Modifies tab location; navigates to external web                    |
| 3   | `chrome_screenshot`                              | Capture Screenshot      | `true`         | `false`           | `true`           | `false`         | Visual state capture without DOM modification                       |
| 4   | `chrome_close_tabs`                              | Close Tabs              | `false`        | `true`            | `true`           | `false`         | Destructive action (closes user tabs, destroys session state)       |
| 5   | `chrome_switch_tab`                              | Switch Active Tab       | `false`        | `false`           | `true`           | `false`         | Changes active tab focus; non-destructive                           |
| 6   | `chrome_get_web_content`                         | Extract Page Content    | `true`         | `false`           | `true`           | `true`          | Read-only DOM / markdown text extraction                            |
| 7   | `chrome_click_element`                           | Click Element           | `false`        | `false`           | `false`          | `true`          | Dispatches click events; may trigger mutations/form submissions     |
| 8   | `chrome_fill_or_select`                          | Fill Form or Select     | `false`        | `false`           | `true`           | `false`         | Sets input/select values; idempotent on target fields               |
| 9   | `chrome_keyboard`                                | Send Key Combination    | `false`        | `false`           | `false`          | `false`         | Dispatches arbitrary keystrokes                                     |
| 10  | `chrome_javascript`                              | Execute JavaScript      | `false`        | `true`            | `false`          | `true`          | Arbitrary JS evaluation; can mutate page, storage, or external APIs |
| 11  | `chrome_upload_file`                             | Upload File             | `false`        | `false`           | `true`           | `true`          | Sets file paths on file inputs and dispatches change events         |
| 12  | `chrome_handle_dialog`                           | Handle Dialog           | `false`        | `false`           | `false`          | `false`         | Dismisses/accepts JS alert/confirm/prompt dialogs                   |
| 13  | `chrome_history`                                 | Search History          | `true`         | `false`           | `true`           | `false`         | Reads browser navigation history                                    |
| 14  | `chrome_bookmark_search`                         | Search Bookmarks        | `true`         | `false`           | `true`           | `false`         | Reads browser bookmarks                                             |
| 15  | `chrome_bookmark_add`                            | Add Bookmark            | `false`        | `false`           | `false`          | `false`         | Mutates bookmark tree (duplicate calls create duplicates)           |
| 16  | `chrome_bookmark_delete`                         | Delete Bookmark         | `false`        | `true`            | `true`           | `false`         | Destructive removal of user bookmarks                               |
| 17  | `chrome_network_request`                         | Send Network Request    | `false`        | `false`           | `false`          | `true`          | Arbitrary HTTP requests to external origins                         |
| 18  | `chrome_network_capture`                         | Capture Network Traffic | `true`         | `false`           | `true`           | `false`         | Passive network log inspection                                      |
| 19  | `chrome_console`                                 | Read Console Logs       | `true`         | `false`           | `true`           | `false`         | Passive console output inspection                                   |
| 20  | `performance_start_trace`                        | Start Perf Trace        | `false`        | `false`           | `false`          | `false`         | Modifies profiling state; optional reload                           |
| 21  | `performance_stop_trace`                         | Stop Perf Trace         | `true`         | `false`           | `true`           | `false`         | Finalizes trace data                                                |
| 22  | `performance_analyze_insight`                    | Analyze Trace           | `true`         | `false`           | `true`           | `false`         | Computational analysis of trace file                                |
| 23  | `chrome_computer`                                | Coordinate Action       | `false`        | `true`            | `false`          | `true`          | Mouse click/drag at coordinates; high impact                        |
| 24  | `chrome_gif_recorder`                            | GIF Recorder            | `false`        | `false`           | `false`          | `false`         | Starts/stops visual recording session                               |
| 25  | _(Planned R2)_ `chrome_click_by_index`           | Click by Index          | `false`        | `false`           | `false`          | `true`          | Browser-use element index click                                     |
| 26  | _(Planned R2)_ `chrome_fill_by_index`            | Fill by Index           | `false`        | `false`           | `true`           | `false`         | Browser-use element index form fill                                 |
| 27  | _(Planned R2)_ `chrome_get_interactive_elements` | Get Indexed DOM Tree    | `true`         | `false`           | `true`           | `false`         | Read-only pruned visible DOM tree extraction                        |
| 28  | _(Planned R2)_ `chrome_batch_actions`            | Execute Batch Actions   | `false`        | `false`           | `false`          | `true`          | Composite pipeline of browser interactions                          |

---

### 2.6 Local File Upload (`input[type="file"]`) & `file://` Navigation

#### 2.6.1 File Upload Analysis & Dual-Mode CDP Architecture

- **Current Failure Modes**:
  1. **Hidden File Inputs**: Modern web frameworks (React, Vue, Ant Design, Tailwind, Dropzone) conceal `<input type="file">` using `display: none`, `visibility: hidden`, or zero opacity. When an agent attempts to interact by clicking the visible "Upload File" button, the native OS file picker dialog opens and blocks the browser event loop.
  2. **Selector Inaccuracy**: CSS selectors for hidden file inputs are fragile or dynamically generated.
  3. **Windows Path Normalization**: Passing relative paths or unnormalized Windows backslashes (`\`) can cause CDP `DOM.setFileInputFiles` to reject the payload.
- **Dual-Mode Solution**:
  - **Mode A: Direct CDP Node Assignment (Known Input / Index)**:
    When the selector or browser-use element index identifies an `<input type="file">`:
    1. Resolve absolute file path on native host (verify file exists, non-empty).
    2. Convert Windows slashes to canonical OS format via `path.resolve()`.
    3. Use CDP `DOM.setFileInputFiles` specifying `nodeId` or `backendNodeId`:
       ```typescript
       await cdpSessionManager.sendCommand(tabId, 'DOM.setFileInputFiles', {
         files: [resolvedAbsolutePath],
         nodeId: fileInputNodeId,
       });
       ```
    4. Dispatch both `input` and `change` events with `bubbles: true, composed: true` to trigger React/Vue synthetic event handlers.
  - **Mode B: CDP File Chooser Interception (Visible Button Click)**:
    When uploading via a regular button click:
    1. Attach CDP listener: `await cdpSessionManager.sendCommand(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true })`.
    2. Click the target element (button or dropzone).
    3. Intercept the CDP `Page.fileChooserOpened` event:
       ```typescript
       cdpSessionManager.onEvent(tabId, 'Page.fileChooserOpened', async (params) => {
         const { backendNodeId, mode } = params;
         await cdpSessionManager.sendCommand(tabId, 'DOM.setFileInputFiles', {
           files: [resolvedAbsolutePath],
           backendNodeId,
         });
         await cdpSessionManager.sendCommand(tabId, 'Page.setInterceptFileChooserDialog', {
           enabled: false,
         });
       });
       ```

#### 2.6.2 `file://` Protocol Navigation Specification

- **Current Failure Modes**:
  1. In `app/chrome-extension/entrypoints/background/tools/browser/common.ts` (lines 149–180), `buildUrlPatterns` creates invalid match patterns when `u = new URL('file:///C:/test.html')`:
     - `patterns.add('${u.protocol}//${u.host}${pathWildcard}')` creates `file:///*` and corrupt variants like `https:///*` (since `host` is empty).
  2. In Chrome Extensions Manifest V3, extensions are **strictly prevented** from navigating to `file://` URLs or executing content scripts on `file://` unless the user explicitly toggles **"Allow access to file URLs"** in `chrome://extensions/?id=<extension-id>`.
  3. `chrome.tabs.create({ url: 'file:///...' })` or `chrome.tabs.update` throws a fatal security exception: `Cannot navigate to a file:// URL without user permission`.
- **Target Specification**:
  1. **Protocol Detection & URL Pattern Sanitization**:
     ```typescript
     const isFileUrl = url.startsWith('file://');
     const matchPatterns = isFileUrl ? ['file:///*'] : buildUrlPatterns(url);
     ```
  2. **Permission Pre-Flight Check**:
     Before attempting `file://` navigation, invoke:
     ```typescript
     const isAllowed = await chrome.extension.isAllowedFileSchemeAccess();
     if (!isAllowed) {
       return createErrorResponse(
         `Navigation to 'file://' URLs is blocked by Chrome security policy. ` +
           `Please enable "Allow access to file URLs" for the Chrome MCP extension in ` +
           `chrome://extensions/?id=${chrome.runtime.id} and retry.`,
       );
     }
     ```
  3. **CDP Bypass Navigation**:
     When the CDP debugger is attached, CDP's `Page.navigate({ url })` domain operates at the browser engine level and can navigate to `file://` paths when permitted by local Chrome security flags.
  4. **Native Local File Server Fallback**:
     If file scheme access remains disabled, provide an automated local proxy route on the Native Server (`http://127.0.0.1:12306/local-file?path=<encodedPath>`) to render local HTML/text/markdown files via standard HTTP.

---

## 3. Authoritative Specification Tables

### Features Discovered

| #   | Category          | Feature                           | Description                                                                   | Inputs                                         | Outputs                                    | Error Behavior                                    | Discovered Via                                                             |
| --- | ----------------- | --------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Multi-Session     | McpSessionManager                 | Per-client session router mapping `sessionId` to dedicated `Server` instances | `transport`, `sessionId: string`               | `McpSessionEntry`                          | Throws `400 Bad Request` if invalid session       | `app/native-server/src/server/index.ts:49-50`                              |
| 2   | Multi-Session     | StreamableHTTP Transport          | Streamable HTTP endpoint for modern MCP clients (Claude Code, Hermes)         | `request.raw`, `reply.raw`, JSON body          | Streamable HTTP Chunked/SSE response       | Returns `500` or safe JSON error                  | `app/native-server/src/server/index.ts:214-286`                            |
| 3   | Multi-Session     | Legacy SSEServerTransport         | SSE transport over `/sse` and `POST /messages`                                | `reply.raw`, `sessionId` query param           | `text/event-stream` & JSON-RPC             | Returns `400 No transport found for sessionId`    | `app/native-server/src/server/index.ts:169-211`                            |
| 4   | Stability         | Safe HTTP Hijack & Write          | Immediate `reply.hijack()` and defensive `res.headersSent` check              | `reply: FastifyReply`, `code: number`, `error` | Raw Node HTTP response or socket end       | Silently drops write if socket destroyed          | `app/native-server/src/server/index.ts:189,207,247`                        |
| 5   | stdio Lifecycle   | Sub-Second Clean Exit             | Event listener on `stdin` end/close and signals with 800ms force exit         | `stdin` stream events, `SIGINT`, `SIGTERM`     | Process exit (`0` or `1`)                  | Forces `process.exit(0)` after 800ms unref timer  | `app/native-server/src/mcp/mcp-server-stdio.ts:117`                        |
| 6   | stdio Lifecycle   | Parent Process Watchdog           | Polling watchdog verifying parent PID liveness via `kill(pid, 0)`             | `parentPid: number`                            | None (background timer)                    | Exits cleanly when parent PID is dead             | `app/native-server/src/mcp/mcp-server-stdio.ts:117`                        |
| 7   | Handshake         | 2-Way Native Handshake            | Two-phase handshake verifying both Native Port and HTTP `/ping`               | `port: number`                                 | `{ type: 'HANDSHAKE_ACK', port }`          | Emits `HANDSHAKE_FAILED`, retries in 500ms        | `app/chrome-extension/entrypoints/background/native-host.ts:344`           |
| 8   | Handshake         | Active 2s Ping/Pong Loop          | Background SW ping to native host with 1.5s timeout                           | `timestamp: number`                            | `{ type: 'pong_to_extension', timestamp }` | Disconnects & self-heals within 3s                | `app/native-server/src/native-messaging-host.ts:130`                       |
| 9   | Handshake         | Dynamic Port Fallback             | Automated port discovery (12306-12315) if `EADDRINUSE` occurs                 | `requestedPort: number`                        | `assignedPort: number`                     | Tries next port or adopts existing bridge         | `app/native-server/src/server/index.ts:331`                                |
| 10  | Security Metadata | MCP Tool Annotations              | Standardized hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`       | None (schema metadata)                         | `ToolAnnotations` object on `Tool`         | Missing annotations cause client approval prompts | `@modelcontextprotocol/sdk/types.js`                                       |
| 11  | File Upload       | CDP File Chooser Interceptor      | Intercepts OS file dialog via `Page.setInterceptFileChooserDialog`            | `tabId: number`, `files: string[]`             | `backendNodeId`, sets files via CDP        | Reverts interception if timeout (15s)             | `app/chrome-extension/entrypoints/background/tools/browser/file-upload.ts` |
| 12  | File Upload       | Path Verification & Normalization | Native host path verification and Windows slash normalization                 | `filePath: string`                             | `{ valid: boolean, resolvedPath: string }` | Returns error if file does not exist or empty     | `app/native-server/src/file-handler.ts:35`                                 |
| 13  | Navigation        | `file://` Scheme Access Check     | Pre-flight validation of `chrome.extension.isAllowedFileSchemeAccess`         | `url: string`                                  | Boolean permission state                   | Returns actionable diagnostic guidance to user    | `app/chrome-extension/entrypoints/background/tools/browser/common.ts:142`  |
| 14  | Navigation        | CDP `Page.navigate` Fallback      | High-privilege CDP navigation for local and restricted URLs                   | `tabId: number`, `url: string`                 | Navigation frame ID                        | Catches net::ERR_ACCESS_DENIED                    | `app/chrome-extension/entrypoints/background/tools/browser/common.ts:41`   |

---

### Edge Cases

| #   | Feature              | Input / Scenario                                                                 | Observed / Anticipated Behavior                                                                                              | Proposed Mitigation / Protocol Rule                                                                                         |
| --- | -------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Multi-Session        | Client B connects to `/sse` while Client A is executing a long-running tool call | Singleton `mcpServer` replaces internal `_transport` pointer; Client A's tool result is sent to Client B; Client A times out | Separate `Server` instance per session using `McpSessionManager`                                                            |
| 2   | Multi-Session        | Client A abruptly drops connection without sending DELETE `/mcp`                 | In-memory session and transport stay alive indefinitely, leaking memory                                                      | Add session idle timeout (5 min) and prune stale sessions periodically                                                      |
| 3   | HTTP Responses       | Client disconnects socket right before `reply.raw.writeHead` in `/sse`           | Writing to closed socket throws `ECONNRESET` / `EPIPE`; catch block attempts `reply.send()` -> `ERR_HTTP_HEADERS_SENT`       | Check `raw.destroyed` and wrap in defensive `safeWriteError` helper; call `reply.hijack()` immediately                      |
| 4   | stdio Transport      | Parent process killed with `taskkill /F /PID` on Windows                         | No SIGTERM delivered; Node process remains running in background holding HTTP port/socket                                    | `stdin.on('end')` + `stdin.on('close')` + unref'd watchdog `kill(parentPid, 0)` exiting in <1s                              |
| 5   | Native Host          | Port 12306 occupied by zombie node process                                       | Fastify throws `EADDRINUSE`; native host sends error message; extension ignores it and stays yellow                          | Probe `/ping` on port; if dead or foreign, auto-bind to 12307 and broadcast new port to extension                           |
| 6   | Extension Status     | Extension Service Worker terminates due to MV3 30s idle timeout                  | `nativePort` is garbage-collected; popup opens and sees stale `serverStatus` from storage                                    | On popup open, send `ensureNativeConnected`; background runs 2s ping/pong keepalive to maintain connection                  |
| 7   | File Upload          | `<input type="file">` is `display: none` inside shadow DOM / iframe              | `DOM.querySelector` fails with `nodeId = 0` or throws element not found                                                      | Use `Page.setInterceptFileChooserDialog` and click trigger button, or pierce shadow roots with `Runtime.evaluate`           |
| 8   | File Upload          | Windows path provided with mixed slashes: `C:\temp/image.png`                    | CDP or OS file system rejects path or treats as relative                                                                     | Resolve through `path.resolve(path.normalize(p))` on native side before passing to CDP                                      |
| 9   | `file://` Navigation | User navigates to `file:///D:/test.html` without granting file URL permission    | Chrome extension API throws `Cannot access contents of page`; extension crashes or hangs                                     | Check `chrome.extension.isAllowedFileSchemeAccess()`; if false, return clear instructions pointing to `chrome://extensions` |
| 10  | Fastify Shutdown     | `server.stop()` called while active SSE connections are streaming                | `fastify.close()` waits for connections to terminate, hanging shutdown and creating zombie process                           | Forcibly destroy all active sockets in `transportsMap` and `AgentStreamManager` before calling `fastify.close()`            |

---

## 4. Verification & Testing Strategy

To independently verify all R1 stability requirements, the following test suite must be executed:

1. **Concurrent Multi-Client Load Test**:
   - Launch native HTTP server on port 12306.
   - Run a test script initiating 5 concurrent clients (3 via Streamable HTTP `/mcp`, 2 via SSE `/sse`).
   - Concurrently fire `tools/list` and `tools/call` across all 5 clients.
   - **Pass Criteria**: All 5 clients receive their respective responses with matching JSON-RPC request IDs; zero `ERR_HTTP_HEADERS_SENT` exceptions logged.
2. **stdio Orphan Termination Benchmark**:
   - Spawn `node dist/mcp/mcp-server-stdio.js` from a child process harness.
   - Close child process stdin pipe.
   - Measure elapsed time until process exits.
   - **Pass Criteria**: Process exits with code 0 in `< 1000ms`; no residual process visible in `tasklist` / `ps`.
3. **Chrome Extension Self-Healing Verification**:
   - Connect extension to native host (confirm green light).
   - Kill native host process. Status must transition to red.
   - Restart native host or trigger reconnect.
   - **Pass Criteria**: Extension reconnects and transitions to green in `< 3.0s`.
4. **Tool Annotation Schema Validation**:
   - Query `tools/list` via MCP protocol.
   - Validate that every tool object contains an `annotations` field with boolean `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.
5. **Local File Upload & `file://` Test**:
   - Test `chrome_upload_file` against both a standard file input and a hidden input with button trigger.
   - Test `chrome_navigate` with a valid `file:///` URL and verify diagnostic guidance when permissions are absent.
