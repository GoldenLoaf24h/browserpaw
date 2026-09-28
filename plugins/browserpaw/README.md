# BrowserPaw Plugin for Hermes Agent & AI Agents

Official plugin for **BrowserPaw** — High-efficiency, zero-hallucination Chrome browser control and automation.

## Overview

BrowserPaw transforms your daily Google Chrome browser into an ultra-fast, controllable, readable, and verifiable automation environment for AI agents. With its dual-brain architecture (Jev System 1 heuristic micro-loop + System 2 frontier reasoning), it achieves sub-second page interaction while cutting token consumption by 85%+.

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
2. **Start Native Bridge**: Run the native MCP bridge:
   ```bash
   node app/native-server/dist/index.js
   # or for development:
   pnpm --filter mcp-chrome-bridge dev
   ```
   The server listens on `http://127.0.0.1:12306/mcp` (or custom `BROWSERPAW_MCP_URL`).
3. **Bridge token**: The native server requires a bearer token on every `/mcp` request. The plugin sends it automatically, resolving in order `BROWSERPAW_MCP_TOKEN`, `CHROME_MCP_TOKEN`, then the file `~/.chrome-mcp/bridge-token` the server writes on first start. If tools return an HTTP 401 error, set one of those variables or make sure that file is readable by the Hermes process.
4. **MCP 2024-11-05 Session Handshake**: The plugin automatically implements the MCP 2024-11-05 lifecycle handshake (`initialize` -> `notifications/initialized`), extracts and forwards the `mcp-session-id` HTTP header on all tool calls, and performs automatic session recovery/re-initialization if a session expires or returns HTTP 400/404. Manual session pinning is also supported via `BROWSERPAW_MCP_SESSION_ID` or `CHROME_MCP_SESSION_ID`.

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
| `browserpaw_inspect_media`        | Direct extraction of images/canvas at native resolution                    |
| `browserpaw_grep`                 | Targeted in-memory regex/text search across interactive elements           |
| `browserpaw_get_markdown`         | Clean reader-mode markdown extraction (70% token savings)                  |
| `browserpaw_switch_tab`           | Switch active focus to a specific tab                                      |
| `browserpaw_close_tabs`           | Safe tab closure with session affinity protection                          |
| `browserpaw_get_windows_and_tabs` | Query all open windows, tab groups, and tabs                               |
| `browserpaw_tool_docs`            | Inspect documentation for all 50 BrowserPaw capabilities                   |

## Bundled Skill

This plugin bundles the complete `browserpaw` operator skill, loaded automatically via Hermes's namespaced skill system:

```text
skill_view("browserpaw:browserpaw")
```

## License

GNU Affero General Public License v3.0 (AGPL-3.0)
