# CLI & Agent MCP Configuration Guide 🔌

This guide explains how to configure AI Agent CLIs (Claude Desktop, Claude Code, Codex CLI, Cursor, Windsurf, Cline, Roo Code) to connect to BrowserPaw via Model Context Protocol (MCP).

---

## 1. Overview & Connection Architecture

BrowserPaw exposes two primary MCP transport modes:

1. **StdIO Transport (Default for trusted local clients, including multiple agents)**:
   - Spawns the stdio adapter via Node.js; the adapter connects to the separately running Native Messaging Bridge using the local credential file.
   - Automatically reads the local token and connects to the active Chrome extension.
2. **HTTP / SSE Transport (Advanced manual loopback integration)**:
   - Endpoint: `http://127.0.0.1:12306/sse` (or `/mcp`)
   - Requires high-entropy token authentication via HTTP header.

---

## 2. Authentication Token

To protect your local browser session against unauthorized local loopback exploitation, BrowserPaw strictly enforces token authentication:

- **Token Location**: `~/.chrome-mcp/bridge-token` (Windows: `%USERPROFILE%\.chrome-mcp\bridge-token`)
- **Token Lifecycle**: The Native Host is the sole creator of the token (preserving valid 48/64-hex tokens with `wx` exclusive lock; clients and doctor scripts never write or rewrite tokens; environment variable overrides like `CHROME_MCP_TOKEN` are not supported).
- **Reading the Token (manual HTTP integrations only; unnecessary for stdio)**:
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

```toml
[mcp_servers.browserpaw]
command = "node"
# Use absolute paths with forward slashes on all platforms:
args = ["<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js"]
startup_timeout_sec = 60

[mcp_servers.browserpaw.env]
CHROME_MCP_TOOL_PROFILE = "full"
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

### 3.4 Hermes Agent

#### Option A: Direct Stdio Configuration in config.yaml (Default & Recommended)

Configure Hermes with native Stdio transport in `config.yaml` to expose BrowserPaw's current tool surface:

```yaml
mcp_servers:
  browserpaw:
    command: 'node'
    args: ['<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js']
    enabled: true
    env:
      CHROME_MCP_TOOL_PROFILE: full
```

#### Option B: Native Hermes Plugin

The optional `browserpaw_*` wrapper surface is provided by the native Hermes plugin. Install it with explicit allowlist authorization in `config.yaml` (`plugins.entries.browserpaw.mcp_allowlist: ["browserpaw"]`, Hermes `>=0.21.5`, optional `settings.isolate_modal: false`). Leave the plugin disabled only when the full stdio MCP surface is already registered, to avoid duplicate tools:

```bash
hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw-hermes
hermes plugins enable browserpaw
```

#### Option C: Advanced Manual HTTP / SSE Registration

Connect Hermes to the running BrowserPaw HTTP bridge:

```bash
hermes mcp add browserpaw --url http://127.0.0.1:12306/mcp --auth header
```

---

### 3.5 OpenAI Codex Plugin Integration

BrowserPaw provides an official portable ChatGPT/Codex plugin under `plugins/browserpaw/`:

- **Metadata Manifest**: `plugins/browserpaw/plugin.json` follows Agent Plugins v1. Skills are discovered from the fixed `skills/` directory and MCP servers from the fixed root `mcp.json`; the portable manifest intentionally has no `skills` or `mcpServers` fields.
- **Transport & Authentication**: Stdio mode (`node <ABSOLUTE_PATH>/mcp-server-stdio.js`) is the zero-config default. When manually connecting over HTTP (`http://127.0.0.1:12306/mcp` or `/sse`), pass `Authorization: Bearer <token>` using the high-entropy token generated in `~/.chrome-mcp/bridge-token` (with non-bypassable loopback, Host, and Origin guards).

---

## 4. Tool Profiles & Dynamic Session Activation

To reduce the initial schema surface, you can configure `CHROME_MCP_TOOL_PROFILE`:

| Profile              | Best For                                                                                                     |
| :------------------- | :----------------------------------------------------------------------------------------------------------- |
| **`core`** (default) | Nine tools: task/skill, navigation, tab inventory/selection, DOM reading, indexed clicks/fills and discovery |
| **`crawl`**          | High-throughput content extraction, markdown and links                                                       |
| **`full`**           | Full low-level CDP access, diagnostics, tab groups and storage                                               |

The current canonical surface includes extension-executed tools plus the native-server task, skill, and on-page autonomy tools. Exact profile counts and schema footprints are generated from the shared schemas rather than duplicated in this guide.

### Exact Tool Discovery Without Restart

`chrome_tool_docs({})` returns a short category index. `{category:"manage"}` lists names and purposes without activation. `{names:["chrome_close_tabs"]}` returns complete schemas without activation.

Select tools explicitly using `chrome_tool_docs({names:["chrome_close_tabs"],activateForSession:true})`. This **replaces** temporary extensions; `{names:[],activateForSession:true}` restores the current profile. Category activation returns a migration error. Invalid names cannot partially change the list. HTTP and stdio share the same rules and only effective changes notify `tools/listChanged`.

Known hidden tools remain directly callable without expanding the list. Use explicit `full` for clients without list refresh support. Jev configuration, authentication and task ownership still apply.

### CLI Results and Persistent Tasks

`browserpaw --json chrome_screenshot '{"tabId":123}'` preserves complete MCP content, structured results and errors; redirect it to a file instead of printing image base64 into agent context. Plain text mode remains available. Protocol, HTTP and parsing errors exit nonzero; session cleanup is bounded and does not replace the original error.

Each one-shot CLI call creates a separate session. Continue multi-step tasks in the existing [persistent REPL](../skills/browserpaw/references/cli-repl.md); do not automatically take over another session's task. Persistent CLI sessions and image-file delivery remain future migration requirements.

---

## 5. Verifying Connection

Once connected, your agent will have access to high-precision browser automation tools:

- `chrome_read_dom`: Retrieve a pruned DOM tree with document-scoped references and explicit coverage.
- `chrome_interact_index`: Dispatch native click, hover, or drag (`isTrusted: true`).
- `chrome_fill_index`: Fill form inputs with automatic old text clearing.
- `chrome_batch_actions`: Pipeline multiple actions, assertions, and extractions within one MCP call.
- `chrome_grep`: Regex/text query across nested frames with reference remapping.
- `chrome_screenshot`: Capture viewport with optional 1:1 CSS coordinate grid overlay or offscreen background tab isolation.
- `chrome_close_tabs`: Safe tab closure with active-tab confirmation protection (`confirm: true`).
- `chrome_javascript`: Execute JavaScript with top-level await and automatic single-expression `return (...)`.

---

## 6. Environment Variables

| Variable                            | Description                                                                                                                                              | Default            |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------- |
| `CHROME_MCP_HOST`                   | Bind address for Fastify server                                                                                                                          | `127.0.0.1`        |
| `CHROME_MCP_PORT` / `MCP_HTTP_PORT` | HTTP/SSE port for MCP server (Priority: `CHROME_MCP_PORT` > `MCP_HTTP_PORT` > 12306; bounded 1-65535)                                                    | `12306`            |
| `CHROME_MCP_TOKEN`                  | Deprecated / Ignored (Native Host is sole producer of `~/.chrome-mcp/bridge-token`)                                                                      | None (no override) |
| `BROWSERPAW_EXTENSION_SYNC_DIR`     | Opt-in target directory for extension artifact sync; disabled by default; strictly guarded against repo root, ancestors, drive roots, and home directory | None (disabled)    |
| `CHROME_MCP_TOOL_PROFILE`           | Tool profile level (`core`, `crawl`, `full`)                                                                                                             | `core`             |
| `CHROME_MCP_NODE_PATH`              | Override Node.js executable path for native host                                                                                                         | Auto-detected      |
