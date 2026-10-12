# BrowserPaw Plugin for Hermes Agent & AI Agents

Official plugin for **BrowserPaw** — High-efficiency, zero-hallucination Chrome browser control and automation.

## Overview

BrowserPaw transforms your daily Google Chrome browser into an ultra-fast, controllable, readable, and verifiable automation environment for AI agents. With its dual-brain architecture (Jev System 1 heuristic micro-loop + System 2 frontier reasoning), it achieves responsive page interaction while achieving >= 85% DOM tree pruning on complex 1000+ node pages without dropping interactive targets.

## Hermes Agent Installation

Install directly into Hermes via the Hermes plugin manager:

```bash
hermes plugins install GoldenLoaf24h/browserpaw --subdir plugins/browserpaw
```

Once added to the official Hermes catalog, you can install with:

```bash
hermes plugins install browserpaw
```

To enable the plugin:

```bash
hermes plugins enable browserpaw
```

## Prerequisites

1. **Load BrowserPaw Extension**: In Chrome, navigate to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `app/chrome-extension/.output/chrome-mv3` directory (or release archive).
2. **MCP Connection Modes**:
   - **Standard Stdio MCP (Default for Hermes)**: Hermes spawns `mcp-chrome-stdio` via its built-in MCP client. The stdio bridge reads the local credential file and connects to the separately installed Native Bridge on loopback port 12306; no token is copied into client or plugin settings.
   - **HTTP/SSE MCP Endpoint**: The native bridge can also listen on `http://127.0.0.1:12306/mcp` when accessed across processes or over the loopback network.
3. **Hermes Plugin Architecture (>=0.21.5)**:
   - Configure the underlying standard MCP server first, after completing [Native Messaging Host installation](../../INSTALL.md):
     ```yaml
     mcp_servers:
       browserpaw:
         command: node
         args: ['<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js']
         enabled: true
         env:
           CHROME_MCP_TOOL_PROFILE: full
     ```
     Use an absolute Node executable path if `node` is unavailable to the client. Leave the optional plugin disabled unless you need its legacy tool names.
   - The plugin delegates all execution through Hermes's native MCP client via `ctx.call_mcp('browserpaw', ...)`.
   - **Zero Plugin Credentials**: The plugin needs no local secret tokens or session environment variables (`BROWSERPAW_MCP_TOKEN`, `BROWSERPAW_MCP_SESSION_ID`). All connection lifecycle, auth, and retries are managed by Hermes's native MCP layer.
   - **Operator Authorization**: Under Hermes's default-deny security model, you must grant the plugin permission to invoke the `browserpaw` MCP server in your `~/.hermes/config.yaml`:
     ```yaml
     plugins:
       enabled:
         - browserpaw
       entries:
         browserpaw:
           mcp_allowlist:
             - browserpaw
           settings:
             isolate_modal: false
     ```
     _If `mcp_allowlist` is omitted, tool calls are blocked with a `PermissionError` before touching the transport._
   - **Modal Isolation (Optional)**: Defaults to `false`. Set `settings.isolate_modal: true` (or `config.isolate_modal: true`) in your plugin entry if you wish to automatically isolate active modal dialogs in `browserpaw_read_dom`.

## Tool Scope: Standard MCP vs Optional Hermes Plugin

BrowserPaw provides two interfaces tailored to agent capabilities:

- **Standard MCP (50 Tool Surface)**: Standard stdio MCP connection defaults to the `core` profile with dynamic runtime unlocking via `chrome_tool_docs({ activateForSession: true })`. To expose the full 50 toolset statically from startup, configure `env: { CHROME_MCP_TOOL_PROFILE: "full" }` in your `mcp_servers.browserpaw` entry.
- **Optional Hermes Plugin (16 Curated Wrappers)**: Curated high-frequency tools prefixed with `browserpaw_*` exposed directly into Hermes's prompt registry.

> **Important**: Any advanced tool not listed among the 16 curated plugin tools below is **not available in the Hermes plugin; use standard MCP** to access the complete toolset.

## Core Provided Tools

| Tool                              | Description                                                                |
| :-------------------------------- | :------------------------------------------------------------------------- |
| `browserpaw_act_toward_goal`      | Autonomous dual-brain micro-loop driven by Jev System 1 heuristics         |
| `browserpaw_navigate`             | Navigate active Chrome tab to a target URL                                 |
| `browserpaw_read_dom`             | Compact AX accessibility DOM tree with 1-based indices                     |
| `browserpaw_interact_index`       | Interact with elements by index (click, hover, focus, clear)               |
| `browserpaw_fill_index`           | High-precision form filling by 1-based index                               |
| `browserpaw_batch_actions`        | Atomic pipeline of actions (click, fill, assert, extract) in one roundtrip |
| `browserpaw_screenshot`           | High-resolution full-page or viewport capture                              |
| `browserpaw_smart_scroll`         | Intelligent overflow-aware scrolling with remaining page calculation       |
| `browserpaw_scroll_until_found`   | Scroll until a requested element is found                                  |
| `browserpaw_inspect_media`        | Direct extraction of images/canvas at native resolution                    |
| `browserpaw_grep`                 | Targeted in-memory regex/text search across interactive elements           |
| `browserpaw_get_markdown`         | Clean reader-mode markdown extraction for distilled article reading        |
| `browserpaw_switch_tab`           | Switch active focus to a specific tab                                      |
| `browserpaw_close_tabs`           | Safe tab closure with session affinity protection                          |
| `browserpaw_get_windows_and_tabs` | Query all open windows, tab groups, and tabs                               |
| `browserpaw_tool_docs`            | Inspect documentation for the wider BrowserPaw tool surface                |

## Bundled Skill

This plugin bundles an operator skill limited to its 16 tools, loaded automatically via Hermes's namespaced skill system. For the full standard MCP surface, install the canonical `skill/` directory instead:

```text
skill_view("browserpaw:browserpaw")
```

The Codex manifest points to the separate `mcp-skills/` distribution, which preserves the full canonical standard MCP skill and its `chrome_*` tool names. Hermes loads the curated `skills/browserpaw/` distribution.

## License

GNU Affero General Public License v3.0 (AGPL-3.0)
