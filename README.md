<div align="center">
  <img src="./docs/images/logo.png" width="100" alt="BrowserPaw Logo" />
  <h1>BrowserPaw</h1>
  <p><b>Control your everyday Chrome browser from AI agents, without losing logins or focus.</b></p>
  <p>
    <a href="./docs/MAP.md">Project Map</a> ·
    <a href="./docs/TOOLS.md">Tool Reference (50)</a> ·
    <a href="./AGENT_CONFIG_GUIDE.md">Client Config</a> ·
    <a href="./README.zh-CN.md">Chinese (zh-CN)</a> ·
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases">Releases</a>
  </p>
</div>

---

<details>
<summary><b>The Backstory: Why I Built BrowserPaw (Click to expand)</b></summary>

<br/>

Traditional browser automation frameworks and LLM browser-use agents were designed for isolated sandbox testing, not for real daily desktop workflows. Every time I tried to let an AI agent assist me in my real browser, I kept hitting the same six frustrating roadblocks:

1. **Lost Logins, Cookies & Saved Sessions**: Standalone browsers launch from an empty profile. They do not inherit your active Google, GitHub, or enterprise SSO logins, cookies, or extensions. Logging in from scratch constantly triggers 2FA and anti-bot verification challenges.
2. **Windows File-Sharing Locks (`[WinError 32]`)**: Attempting to reuse an active Chrome User Data directory on Windows immediately crashes because Chromium holds exclusive file-sharing locks on open profile databases.
3. **Mandatory Manual Mouse-Click Approvals**: Whenever an agent attempts to control your local browser via raw CDP or remote debugging ports, Chromium frequently forces intrusive confirmation popups and security prompts. You must stop your work, locate the browser window, and physically click with your mouse to grant permission—completely defeating the purpose of unattended, autonomous automation.
4. **Sluggish Execution & Astronomical Token Consumption**: Conventional AI browser agents upload full-page retina screenshots or massive raw DOM trees back to remote frontier LLMs for every single micro-action. Each step suffers a 6–12 second roundtrip latency and burns tens of thousands of tokens, making multi-step automation painfully slow and prohibitively expensive.
5. **Intrusive Debugging Banners & Viewport Jitter**: Standard remote debugging injects a native top notification bar (_'BrowserPaw is debugging this browser'_), shifting the viewport downward by ~36px and causing visual layout jitter and misaligned coordinate clicks.
6. **Foreground Focus Stealing**: Typical automation tools force the browser window into the foreground, hijacking your keyboard and mouse focus while you are attempting to perform other tasks.

Frustrated by these roadblocks, I built BrowserPaw to solve all of these problems at their root. By pairing a Chrome MV3 extension directly with a local Native Messaging bridge, BrowserPaw operates seamlessly inside the Chrome you already use every day—automating workflows quietly in background tabs without losing logins, stealing focus, or demanding repetitive manual approvals.

</details>

---

## ⚡ What is BrowserPaw?

BrowserPaw is a Chrome extension + local MCP server that lets AI agents operate your real browser. It exposes 50 tools across 8 categories (navigation, perception, action, observation, management, diagnostics, network, crawl), with a minimal 14-tool core profile for everyday sessions.

Two execution paths are available:

1. **Deterministic tools** – indexed clicks, fills, batch pipelines, form wizards, screenshots, network capture, etc. The calling agent plans each step.
2. **`chrome_act_toward_goal`** – a local perception-action micro-loop (~200–400ms/step). The native server perceives the page, decides the next action, and acts, without an MCP round-trip per step. It supports local decider models (with GPU acceleration) and TypeSafe Jev System One cloud inference.

---

## 🎯 Key capabilities

- **Session continuity** – Runs inside your existing Chrome. Google, GitHub, and SSO logins are already there; no profile copying, no re-authentication.
- **Pruned, indexed DOM** – `chrome_read_dom` strips non-interactive and occluded nodes and assigns 1-based indices. On 1,000+ node pages this reduces node count by over 85% (test-validated), keeping snapshots small. A fast snapshot mode returns a viewport summary in ≤30 ms and ≤15 KB.
- **Card flattening and viewport virtualization** – `flattenCards` collapses repetitive feed cards into one-line summaries; `virtualizeViewport` folds off-screen list items into count placeholders.
- **Shadow DOM traversal** – Recursively walks open shadow roots; closed shadow hosts are tagged and interacted with at the host level. Accessible names are extracted from icon-only buttons (aria-label, title, SVG titles).
- **Batch pipelines** – `chrome_batch_actions` runs multi-step click/fill/wait/assert/extract sequences in a single MCP round-trip. `chrome_form_pipeline` advances multi-step forms locally.
- **Overlay dismissal** – `chrome_dismiss_overlay` closes marketing popups, cookie banners, and modals in one step, without dumping the DOM.
- **Delta piggybacking** – `includeDelta: true` returns DOM mutations in the same response as an action, removing the need for a follow-up DOM read.
- **Native event fidelity** – Clicks and keystrokes are dispatched as trusted CDP events (`isTrusted: true`), so React/Vue/Angular and Shadow DOM handlers fire normally.
- **Coordinate fallback** – When DOM indexing fails (canvas, WebGL, icon-only UI), a screenshot grid plus `chrome_computer` provides coordinate-based control with 24 px snap-to-edge.
- **Human handoff** – `chrome_request_human_intervention` dims the page, shows a banner, and parks the cursor so the user can complete 2FA or captchas; automation resumes afterward.
- **Tab and window management** – Create, group, move, and close tabs, query history and bookmarks, and capture performance traces, all under the user's existing credentials.

---

## 🧠 Dual-brain execution

```text
┌─ Macro Planner (your reasoning LLM) ───────────────────┐
│  Task decomposition, cross-page strategy, recovery     │
└───────────────────────────┬────────────────────────────┘
                            │ MCP (low frequency)
                            ▼
┌─ Semantic Micro-Loop (Native Server) ──────────────────┐
│  chrome_act_toward_goal:                               │
│  perceive → decide (Jev or heuristic) → act → verify   │
│  No MCP round-trip per step                            │
└───────────────────────────┬────────────────────────────┘
                            │ Native Messaging
                            ▼
┌─ Chrome MV3 Extension ─────────────────────────────────┐
│  49 browser tools · CDP events · in-page engine        │
└────────────────────────────────────────────────────────┘
```

Routing guideline:

- Fixed action sequence, known indices → deterministic tools (`chrome_batch_actions`, `chrome_form_pipeline`).
- Single-page goal in natural language → `chrome_act_toward_goal`.
- Long-horizon, multi-page, novel, or escalated situations → the calling agent drives.

The micro-loop is bounded: at most 60 steps in Jev mode (default 10), truncated to 5 steps in heuristic fallback. It intercepts 14 destructive action keywords (pay, delete, submit, etc.) and escalates ambiguous or low-confidence decisions back to the calling agent with candidate elements.

**Autonomous Jev Modes & Smart Gating:**

- **Off**: Disabled by the user in the extension popup. `chrome_act_toward_goal` is automatically hidden from `tools/list`; if invoked directly, it is rejected and prompts for user authorization.
- **Local**: Runs an offline, privacy-first decider model (`decider-2b`) locally on port 8009 with NVIDIA GPU acceleration (CUDA RTX) or CPU fallback. Hot-loads automatically on first use.
- **Remote**: Uses TypeSafe Jev System One cloud inference. Set `TYPESAFE_API_KEY` (or configure via popup) with optional custom `Base URL` and custom fine-tuned `modelId`. Failing configurations return actionable diagnostic logs instead of silent heuristic fallback.

---

## 🚀 Quick start

### Option 1: Install with an AI agent (Recommended)

Paste this to your agent:

> "Set up BrowserPaw: https://github.com/GoldenLoaf24h/browserpaw. Read INSTALL.md and follow the steps."

Your agent will compile the project and register the OS native host automatically. Then simply open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `app/chrome-extension/.output/chrome-mv3`.

### Option 2: Prebuilt release (No build required)

1. Download the latest `browserpaw-extension-v*.zip` and `browserpaw-skill-v*.zip` from [Releases](https://github.com/GoldenLoaf24h/browserpaw/releases/latest).
2. Unzip the extension to a local persistent directory, open `chrome://extensions`, enable Developer mode, and click **Load unpacked**.
3. Register the native host once: run `node dist/scripts/register-dev.js` inside the server directory.
4. Copy the full `skill/` directory (including its `references/` folder) into your agent's skills directory (Codex: `~/.codex/skills/browserpaw/`).

### Option 3: Build from source

```bash
git clone https://github.com/GoldenLoaf24h/browserpaw.git
cd browserpaw && pnpm install && pnpm build
cd app/native-server && node dist/scripts/register-dev.js
```

Then load `app/chrome-extension/.output/chrome-mv3` into `chrome://extensions`.

### Verification

Verify that all components are functioning with the built-in diagnostic suite:

```bash
node skill/config/doctor.mjs
```

Full onboarding (Codex Stdio setup, Cursor, Claude Desktop, Hermes, Jev API key) is in **[INSTALL.md](./INSTALL.md)**.

---

## 🛠️ Tool catalog

All 50 tools are grouped below. For machine-readable schemas and parameter details, see [docs/TOOLS.md](./docs/TOOLS.md).

### Autonomous execution (1)

- **`chrome_act_toward_goal`** – Local perception-action loop toward a natural-language goal. Jev inference with heuristic fallback; escalates on ambiguity or destructive actions.

### Navigation & tabs (7)

- **`chrome_navigate`** – Open URL, refresh, history back/forward, background tabs.
- **`chrome_switch_tab`** – Switch active tab or bind session affinity.
- **`chrome_close_tabs`** – Close tabs by id, URL, or session (requires confirm for active tab).
- **`chrome_move_tab`** – Reposition tabs or move across windows.
- **`get_windows_and_tabs`** – List windows and tabs with state.
- **`chrome_attach_tab` / `chrome_detach_tab`** – Attach or detach the CDP debugger.

### Perception & extraction (7)

- **`chrome_read_dom`** – Indexed, pruned DOM tree with shadow DOM traversal and fast snapshot mode.
- **`chrome_scroll_until_found`** – Client-side auto-scroll to find target text/element, settles virtual DOM, centers element, and returns live index.
- **`chrome_grep`** – Regex or text search returning element indices without a full DOM dump.
- **`chrome_get_markdown`** – Clean Markdown extraction for reading tasks.
- **`chrome_inspect_media`** – Extract image or canvas data; super-resolves small captchas.
- **`chrome_get_dropdown_options`** – List select/combobox options.
- **`chrome_console`** – Capture console logs and errors.

### Action & pipeline (15)

- **`chrome_interact_index`** – Trusted click, hover, double-click, drag by 1-based index.
- **`chrome_fill_index`** – Trusted text input with clear, submit, and multiline support.
- **`chrome_batch_actions`** – Multi-step pipeline (click/fill/wait/assert/extract) in one round-trip.
- **`chrome_form_pipeline`** – Autonomous multi-step form filling.
- **`chrome_smart_scroll`** – Scroll page or inner containers with progress reporting.
- **`chrome_keyboard`** – Raw key presses and shortcuts.
- **`chrome_upload_file`** – Native file-input upload.
- **`chrome_insert_media`** – Paste/drop a real File into rich-text editors.
- **`chrome_handle_dialog`** – Accept or dismiss native alert/confirm/prompt.
- **`chrome_handle_download`** – Wait for and locate downloads.
- **`chrome_computer`** – Coordinate-level mouse/keyboard control (visual fallback).
- **`chrome_request_human_intervention`** – Yield to the user for captcha/2FA.
- **`chrome_undo_last_action`** – Roll back the last mutation.
- **`chrome_dismiss_overlay`** – Close popups, modals, and cookie banners.
- **`chrome_javascript`** – Evaluate JavaScript in the page context.

### Observation & diagnostics (3)

- **`chrome_screenshot`** – Viewport, element, or full-page capture with optional coordinate grid.
- **`chrome_cdp_execute`** – Raw CDP escape hatch.
- **`chrome_tool_docs`** – Query tool schemas and activate hidden profiles.

### Management (10)

- **`chrome_tab_group_create`** / **`chrome_tab_group_update`** / **`chrome_tab_group_list`** / **`chrome_tab_group_ungroup`** / **`chrome_tab_group_close`** – Tab group lifecycle.
- **`chrome_history`** – Search browsing history.
- **`chrome_bookmark_search`** / **`chrome_bookmark_add`** / **`chrome_bookmark_delete`** – Bookmark operations.
- **`chrome_storage`** – Read and manipulate cookies, localStorage, and sessionStorage.

### Network (3)

- **`chrome_intercept_api`** – Capture backend JSON responses matching a URL pattern.
- **`chrome_network_capture`** – Record network traffic.
- **`chrome_network_request`** – Authenticated HTTP requests through the browser session.

### Performance & health (4)

- **`performance_start_trace`** / **`performance_stop_trace`** / **`performance_analyze_insight`** – Record and analyze performance traces.
- **`chrome_doctor`** – Check port, extension link, token, and native host health.

---

## 🏗️ Architecture

```text
AI Client (any MCP-capable agent)
         │  MCP over HTTP/SSE on 127.0.0.1:12306, or stdio
         ▼
Native Messaging Bridge (Fastify + Stdio Host)
         ├── Fast Decision Engine (Jev micro-loop)
         └── Passthrough for 49 deterministic tools (50 tools total)
         │  Chrome Native Messaging
         ▼
Chrome MV3 Extension (Service Worker)
         ├── In-Page Engine (1-based DOM indexing)
         ├── CDP Session Manager
         └── Agent Cursor Overlay
```

For details, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## 📚 Documentation

- [Project Map](./docs/MAP.md) – Navigation hub and reading paths.
- [Tool Reference](./docs/TOOLS.md) – Schemas for all 50 tools.
- [Install & Onboard](./INSTALL.md) – Step-by-step setup including Jev key.
- [Agent Integration](./AGENT_CONFIG_GUIDE.md) – MCP client configuration.
- [Architecture](./docs/ARCHITECTURE.md) – Design and decisions.
- [Troubleshooting](./docs/TROUBLESHOOTING.md) – Connection and execution issues.

---

## 💡 Acknowledgments

- [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) – MV3 extension and Native Messaging bridge foundation.
- [browser-use/browser-use](https://github.com/browser-use/browser-use) – DOM-first indexing principles.
- [BrowserOS](https://github.com/browseros-ai/BrowserOS) – DOM diffing and element grep patterns.
- [TypeSafe](https://docs.typesafe.ai) – Jev System One fast-decision models.

---

## 📄 License

[AGPL-3.0](./LICENSE). Modifications and SaaS deployments must remain open-source.

---

BrowserPaw is an independent Chrome extension and MCP automation project. It is not affiliated with the standalone `browserpaw` package on npm.
