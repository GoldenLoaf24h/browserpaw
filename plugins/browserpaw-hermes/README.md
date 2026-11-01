# BrowserPaw Plugin for Hermes Agent

Native Hermes plugin for **BrowserPaw**. It registers a curated `browserpaw_*` wrapper set backed by the local BrowserPaw MCP bridge.

Validated against Hermes Agent `0.22.5`: `hermes plugins validate` passes and
the host reports the declared wrappers with no hooks or registration leaks.

## Overview

BrowserPaw operates the user's existing Chrome session through its Chrome extension and local Native Messaging bridge. This package follows Hermes's native plugin layout: `plugin.yaml`, `__init__.py`, a curated tool registry, and a Hermes-specific `SKILL.md`.

## Hermes Agent Installation

Install directly into Hermes via the Hermes plugin manager:

```bash
hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw-hermes
```

Official plugin documentation: <https://hermes-agent.nousresearch.com/docs/developer-guide/plugins>.

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
     Use an absolute Node executable path if `node` is unavailable to the client.
   - Install and enable this plugin only after the `browserpaw` MCP server is connected. The plugin is the Hermes-native `browserpaw_*` adapter, not a standalone BrowserPaw installation.
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

## Tool Scope

BrowserPaw has one shared execution service and separate client adapters:

- **Hermes**: curated native wrappers prefixed with `browserpaw_*`, exposed directly in Hermes's prompt registry.
- **ChatGPT/Codex, Claude Code, DSH, and ordinary Agent Skills clients**: use the client-neutral `chrome_*` MCP contract from the same BrowserPaw Native service.

Only the wrappers listed below are available in this Hermes plugin.

## Core Provided Tools

| Tool                              | Description                                                                |
| :-------------------------------- | :------------------------------------------------------------------------- |
| `browserpaw_task`                 | Durable multi-page task and owned/borrowed page lifecycle                  |
| `browserpaw_skill`                | Find, validate, run, and manage independently verified site skills         |
| `browserpaw_act_toward_goal`      | Bounded semantic micro-loop with escalation to the calling agent           |
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

### Task and Skill Examples

```json
{"action": "start", "name": "Compare laptop prices"}
{"action": "open", "taskId": "<taskId>", "url": "https://example.com/laptops"}
{"action": "finish", "taskId": "<taskId>", "keep": []}
```

```json
{"action": "find", "url": "https://example.com/products", "intent": "extract product prices"}
{"action": "run", "id": "example-products", "inputs": {"query": "laptop"}}
```

## Bundled Skill

The package bundles a Hermes-specific operator skill limited to the wrappers it provides. It is not a copy of the portable Agent Skill and does not claim unavailable tools.

```text
skill_view("browserpaw:browserpaw")
```

## License

GNU Affero General Public License v3.0 (AGPL-3.0)
