# BrowserPaw Native Messaging Bridge & MCP Server 🔌

This package (`mcp-chrome-bridge`) is the Node.js native bridge and Model Context Protocol (MCP) server for **BrowserPaw**. It connects AI Agent clients (Claude Desktop, Claude Code, Cursor, Windsurf, Codex) to the Chrome MV3 Extension via Chrome Native Messaging and CDP.

---

## 🏗️ Architecture Overview

```
app/native-server/
├── src/
│   ├── index.ts                # Entrypoint: spins up Fastify HTTP/SSE or delegates to CLI
│   ├── cli.ts                  # Command-line interface (starts stdio or daemon)
│   ├── constant/               # Configuration defaults (Port 12306, timeouts, limits)
│   ├── mcp/
│   │   ├── mcp-server.ts       # HTTP/SSE MCP implementation with McpSessionManager
│   │   ├── mcp-server-stdio.ts # Stdio transport MCP server with dynamic profile store
│   │   └── trace-parser.ts     # DevTools performance trace ingestion
│   ├── native-host.ts          # Chrome Native Messaging stdio pipe with 1000KB buffer guard
│   ├── scripts/                # Browser auto-detection and native manifest installers
│   └── server/
│       ├── routes/             # Fastify route handlers (/sse, /mcp, /ping, /agent-control)
│       └── server.test.ts      # Jest integration & security tests
└── dist/                       # Compiled commonjs and esm outputs + shell wrappers
```

---

## 🚀 Transports & Protocol Support

### 1. HTTP / SSE Transport (Port 12306)

Provides high-concurrency Streamable HTTP and Server-Sent Events (SSE) interfaces:

- **SSE Endpoint**: `http://127.0.0.1:12306/sse`
- **JSON-RPC Endpoint**: `http://127.0.0.1:12306/mcp`
- **Health Check**: `http://127.0.0.1:12306/ping`
- **Authentication**: High-entropy 256-bit token located at `~/.chrome-mcp/bridge-token`. Sent via:
  - Header `Authorization: Bearer <token>`
  - Header `x-mcp-token: <token>`

### 2. Stdio Transport

Runs directly over standard I/O for clients managing child processes (e.g. Cursor, Claude Desktop):

```bash
node app/native-server/dist/mcp/mcp-server-stdio.js
# or via root CLI
node bin/browserpaw.cjs
```

---

## 🎯 Tool Profiles & Dynamic Activation

Configure the starting tool profile with the `CHROME_MCP_TOOL_PROFILE` environment variable:

- **`core`** (default): 14 ultra-lean semantic navigation and DOM interaction tools (~11.5k tokens, cutting prompt tokens by >40% and eliminating decision paralysis).
- **`full`**: All 50 tools exposed (~19.5k tokens).
- **`crawl`**: 12 lightweight web scraping and content extraction tools (~5.8k tokens).

### Auto-Unlock on Call & Dynamic Activation

When running in `core` profile, you do not need to restart the server when an extended tool is needed:

1. **Auto-Unlock on Call**: Calling any unexposed tool (e.g., `chrome_history`, `chrome_javascript`) automatically unlocks its entire category, emits a standard `notifications/tools/list_changed` event, and executes immediately without blocking.
2. **Manual Tool Docs & Activation**:

```json
chrome_tool_docs({ "category": "diagnose", "activateForSession": true })
```

Supported across both **Fastify HTTP/SSE** and **Stdio** (`mcp-server-stdio.ts`).

---

## 🛡️ Security Guarantees

1. **Token Authentication (P0)**:
   All incoming HTTP and SSE connections require a valid token matching `~/.chrome-mcp/bridge-token`. Rejects unauthorized local loopback access, DNS rebinding, and cross-site requests.
2. **1000KB Physical Native Messaging Buffer Ceiling & Transparent Chunking**:
   Chrome crashes if a Native Messaging payload exceeds 1MB. The host enforces a 1000KB pre-send validation ceiling paired with transparent bi-directional chunking and reassembly (950KB chunk threshold / 850KB slice size).
3. **SSRF & Private IP Protection**:
   `assertSafeUrl` and `safeLookup` reject loopback, RFC1918, CGNAT, and link-local destinations on external network requests.
4. **Path Traversal Defenses**:
   File handlers reject directory traversal attempts outside designated temporary folders.

---

## 🔧 Installation & Registration

Register the native host with Chrome:

```bash
# From native server package directory:
node dist/scripts/register-dev.js

# Or from repository root:
node app/native-server/dist/scripts/register-dev.js
# (or pnpm --filter mcp-chrome-bridge register:dev)
```

Manifest registration targets:

- **Windows**: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost`
- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/`

---

## 🧪 Testing

```bash
pnpm --filter mcp-chrome-bridge test
```

- **Test Suites**: 1 passed (100%)
- **Tests**: 30 passed (100% Jest)
