# CLI & Agent MCP Configuration Guide 🔌

This guide explains how to configure AI Agent CLIs (Claude Desktop, Claude Code, Codex CLI, Cursor, Windsurf, Cline, Roo Code) to connect to BrowserPaw via Model Context Protocol (MCP).

---

## 1. Overview & Connection Architecture

BrowserPaw exposes two primary MCP transport modes:

1. **HTTP / SSE Transport (Recommended for high-concurrency & multi-client)**:
   - Endpoint: `http://127.0.0.1:12306/sse` (or `/mcp`)
   - Requires high-entropy token authentication via HTTP header.
2. **StdIO Transport (Direct process pipe)**:
   - Spawns the native bridge process directly via Node.js stdio pipe.
   - Automatically reads the local token and connects to the active Chrome extension.

---

## 2. Authentication Token

To protect your local browser session against unauthorized local loopback exploitation, BrowserPaw strictly enforces token authentication:

- **Token Location**: `~/.chrome-mcp/bridge-token` (Windows: `%USERPROFILE%\.chrome-mcp\bridge-token`)
- **Custom Token**: Set the `CHROME_MCP_TOKEN` environment variable prior to starting the service.
- **Reading the Token**:
  ```bash
  # Windows PowerShell
  Get-Content "$HOME\.chrome-mcp\bridge-token"

  # macOS / Linux
  cat ~/.chrome-mcp/bridge-token
  ```

---

## 3. Client Configuration Templates

### 3.1 Claude Desktop / Claude Code

File: `~/.claude/claude_desktop_config.json`

#### Option A: HTTP / SSE Mode (Recommended)

```json
{
  "mcpServers": {
    "browserpaw": {
      "url": "http://127.0.0.1:12306/sse",
      "headers": {
        "Authorization": "Bearer <TOKEN_FROM_~/.chrome-mcp/bridge-token>"
      }
    }
  }
}
```

#### Option B: Stdio Pipe Mode

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "full"
      }
    }
  }
}
```

---

### 3.2 Codex CLI

File: `~/.codex/config.toml`

```json
{
  "mcpServers": {
    "browserpaw": {
      "url": "http://127.0.0.1:12306/sse",
      "headers": {
        "x-mcp-token": "<TOKEN_FROM_~/.chrome-mcp/bridge-token>"
      }
    }
  }
}
```

---

### 3.3 Cursor

File: `.cursor/mcp.json` or Cursor Settings -> Features -> MCP Servers:

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

---

### 3.5 Hermes Agent

#### Option A: Native Hermes Plugin (Recommended)

Install directly from terminal into your active Hermes environment:

```bash
hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw
hermes plugins enable browserpaw
```

#### Option B: HTTP / SSE MCP Server Registration

Connect Hermes to the running BrowserPaw HTTP bridge:

```bash
hermes mcp add browserpaw --url http://127.0.0.1:12306/mcp --auth header
```

---

## 4. Tool Profiles & Dynamic Session Activation

To optimize token consumption, you can configure `CHROME_MCP_TOOL_PROFILE`:

| Profile              | Tool Count | Token Overhead | Best For                                                           |
| :------------------- | :--------- | :------------- | :----------------------------------------------------------------- |
| **`core`** (default) | 14         | ~5.8k tokens   | Daily semantic navigation, 1-based clicks, form fills, screenshots |
| **`crawl`**          | 12         | ~4.8k tokens   | High-throughput content extraction, markdown, links                |
| **`full`**           | 50         | ~16.5k tokens  | Full low-level CDP access, diagnostics, tab groups, and storage    |

### Dynamic Tool Activation Without Restart

Even when running in `core` or `crawl` profiles, agents can dynamically expose hidden tool categories during runtime without restarting the server:

```json
// Call chrome_tool_docs
{
  "category": "manage",
  "activateForSession": true
}
```

Supported categories: `navigate`, `perceive`, `act`, `observe`, `manage`, `diagnose`, `network`, `crawl`. Supported in both **HTTP/SSE** and **Stdio** transports.

---

## 5. Verifying Connection

Once connected, your agent will have access to high-precision browser automation tools:

- `chrome_read_dom`: Retrieve 1-based pruned DOM index tree (85%+ token savings).
- `chrome_interact_index`: Dispatch native click, hover, or drag (`isTrusted: true`).
- `chrome_fill_index`: Fill form inputs with automatic old text clearing.
- `chrome_batch_actions`: Pipeline multiple actions, assertions, and extractions with zero roundtrip latency.
- `chrome_grep`: Millisecond regex/text query across nested iframes with index remapping.
- `chrome_screenshot`: Capture viewport with optional 1:1 CSS coordinate grid overlay or offscreen background tab isolation.
- `chrome_close_tabs`: Safe tab closure with active-tab confirmation protection (`confirm: true`).
- `chrome_javascript`: Execute JavaScript with top-level await and automatic single-expression `return (...)`.

---

## 6. Environment Variables

| Variable                            | Description                                                | Default                            |
| :---------------------------------- | :--------------------------------------------------------- | :--------------------------------- |
| `CHROME_MCP_HOST`                   | Bind address for Fastify server                            | `127.0.0.1`                        |
| `CHROME_MCP_PORT` / `MCP_HTTP_PORT` | HTTP/SSE port for MCP server                               | `12306`                            |
| `CHROME_MCP_TOKEN`                  | Overrides the token stored in `~/.chrome-mcp/bridge-token` | Auto-generated high-entropy string |
| `CHROME_MCP_TOOL_PROFILE`           | Tool profile level (`core`, `crawl`, `full`)               | `core`                             |
| `CHROME_MCP_NODE_PATH`              | Override Node.js executable path for native host           | Auto-detected                      |
