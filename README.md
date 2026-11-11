<div align="center">
  <img src="./docs/images/logo.png" width="128" alt="BrowserPaw Logo" />
  <h1>BrowserPaw</h1>
  <p><b>Deterministic, token-disciplined Chrome browser automation inside your active, authenticated profile.</b></p>
  <p>
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases"><img src="https://img.shields.io/badge/release-v4.1.2-blue.svg" alt="Release v4.1.2" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-green.svg" alt="License AGPL-3.0" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22.6.0-brightgreen.svg" alt="Node >= 22.6.0" />
    <img src="https://img.shields.io/badge/chrome-MV3-orange.svg" alt="Chrome MV3" />
    <img src="https://img.shields.io/badge/mcp-2024--11--05-blueviolet.svg" alt="MCP 2024-11-05" />
  </p>
  <p>
    <b><a href="./README.md">English</a></b> | <b><a href="./README.zh-CN.md">Chinese (zh-CN)</a></b>
  </p>
  <p>
    <a href="#-quick-start">Quick Start</a> ·
    <a href="#%EF%B8%8F-system-architecture--execution-pipeline">Architecture</a> ·
    <a href="#%EF%B8%8F-mcp-tool-surface--profiles">Tool Catalog</a> ·
    <a href="./INSTALL.md">Installation Guide</a> ·
    <a href="./docs/TOOLS.md">Schema Reference</a> ·
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases">Releases</a>
  </p>
</div>

---

**BrowserPaw** is a production-grade Chrome MV3 extension, Native Messaging IPC bridge, and local Model Context Protocol (MCP) server that connects AI coding agents directly to your **existing, authenticated Google Chrome browser**.

Unlike naive headless frameworks (Puppeteer, Playwright) that launch blank profiles, trigger bot-detection challenges, and drop logins, BrowserPaw operates in-place inside your active browser session. It pairs a **52-tool deterministic CDP/DOM engine** with an optional **Dual-Brain semantic perception loop** (TypeSafe Jev System One or zero-cost local Heuristics), strict multi-tab session affinity, and token-disciplined observation pipelines.

---

## 🎯 Why BrowserPaw

BrowserPaw is built from the ground up to solve the real architectural failure modes of browser-based AI agents:

- **Live Authenticated Session Reuse (Zero Profile Cloning)**: Operates directly inside your existing Chrome instance via Manifest V3 and Native Messaging IPC. It inherits all active logins, HttpOnly session cookies, enterprise SSO/MFA tokens, and hardware security keys without profile duplication, disk cloning, or anti-bot fingerprint tripping.
- **Session Affinity & Multi-Tab Isolation**: Distinguishes **task-owned background tabs** (`chrome_task`, `background: true`), **borrowed tabs** (`chrome_request_human_intervention`), and **user-active tabs** via an explicit ownership ledger. Parallel agent tasks execute in the background without stealing window focus, interrupting typing, or clobbering active tabs.
- **Token-Disciplined Observation & Off-Context Compute**: Prunes raw DOM trees into 1-based interactive index references (`chrome_read_dom`), supports incremental mutations (`includeDelta`), structural card collapsing (`flattenCards`), and viewport virtualization (`virtualizeViewport`). For complex multi-step workflows, the sandboxed local Node.js REPL (`browserpaw repl`) filters large payloads and network traces through lease-backed local file handles before data ever touches the LLM context window.
- **Fail-Closed Execution & Non-Replayable Dispatch**: Side-effecting actions (`Input.insertText`, mouse click dispatch, form submission) enforce strict verification boundaries. When delivery or network acknowledgement is uncertain, actions return `status: 'unknown'` with `retry: false`, preventing duplicate charges, repeated submissions, or corrupted drafts.
- **Human-in-the-Loop Escalation**: Built-in confirmation trap guards, dialog watchdogs, and `chrome_request_human_intervention` pause automation, dim the viewport, display an explanatory banner, and park the cursor so users can resolve CAPTCHAs, SMS OTPs, or payment authorizations before the agent safely resumes.

---

## 🏗️ System Architecture & Execution Pipeline

BrowserPaw enforces a decoupled 4-tier communication topology that keeps browser credentials inside Chrome, isolates execution state in a local Node process, and communicates with AI clients over standard MCP protocols:

```text
┌────────────────────────────────────────────────────────────────────────┐
│  Tier 1: AI Clients & Adapter Plugins                                  │
│  Codex Desktop · Claude Code · Hermes Agent · DeepSeek Harness · Cursor│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ JSON-RPC (Stdio / HTTP 127.0.0.1:12306)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Tier 2: Local Native Server (Node.js Process · app/native-server)     │
│  ├── MCP Protocol Router & Lease-Backed File Artifact Store            │
│  ├── Persistent REPL Runtime (VM context · browser.* facade)           │
│  ├── Durable Task & Page Ownership Ledger (chrome_task)                │
│  ├── Verified Site Skill Engine & Library (chrome_skill)               │
│  ├── Dual-Brain Decision Engine (TypeSafe Jev System One / Heuristic)  │
│  └── Native Messaging Host (Stdio 32-bit length-prefixed framing)      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Chrome Native Messaging IPC (<= 1MB)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Tier 3: Chrome MV3 Extension (Blink / V8 · app/chrome-extension)      │
│  ├── Service Worker Event Router & Session Switch Guard                │
│  ├── Session Affinity Ledger (Task Background / Borrowed / User Tabs)  │
│  ├── CDP Session Manager (chrome.debugger · Domain RefCount & Guard)   │
│  └── Action Watchdogs & Dialog Interceptors (Dialog / Download / Trap) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ chrome.scripting / chrome.debugger (CDP)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Tier 4: In-Page Execution & Target Contexts (Target Web Pages)        │
│  ├── Isolated-World DOM Indexer (1-based interactive elements)         │
│  ├── Frame-by-Frame DOM Aggregator (allFrames · Shadow DOM traversal)  │
│  ├── Synchronized Agent Cursor Visual Feedback Overlay                 │
│  └── Trusted CDP Input Pipeline (Input.dispatchMouseEvent / KeyEvent)  │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. Multi-Frame Observation & Resilient DOM Indexing

`chrome_read_dom` traverses the page's render tree inside an isolated execution world, assigning sequential 1-based numeric indices (`[1]`, `[2]`) and bounding boxes to interactive elements.

- **Shadow DOM Traversal**: Open shadow roots (`mode: 'open'`) are traversed recursively, uncovering nested Web Components and custom elements. Closed shadow roots are explicitly disclosed as out-of-scope and handled at the host element level. Accessible names are extracted from icon-only buttons via `aria-label`, `title`, and child SVG `<title>`.
- **Frame-Isolated Execution**: Cross-origin iframes (OOPIF) and nested frames are queried independently via `allFrames`. If a child iframe fails due to security policies or a crashed renderer, main-frame (`frame 0`) observation remains intact with `coverage.status: 'incomplete'`, preventing total snapshot failure.
- **Layout Mutation Guard**: During viewport screenshot capture and element targeting, `domRevision` counters powered by `MutationObserver` detect concurrent DOM churn and verify visual layout stability.

### 2. Hybrid Input Dispatch & Visual Cursor Coordination

BrowserPaw resolves targets through a deterministic ladder: 1-based element `index` (or CSS `selector` / viewport `coordinates`) → geometry verification → visual cursor feedback → trusted CDP event dispatch.

- **Visual Cursor Synchronization**: The extension injects `agent-cursor.content.ts`, animating an on-screen agent pointer toward target coordinates with realistic bezier movement and click ripples, keeping human operators visually informed.
- **Trusted Native Input**: Clicks and keystrokes are emitted via `chrome.debugger` as trusted CDP events (`Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent`) with `isTrusted: true`, ensuring framework event listeners (React 18 synthetic events, Vue, Angular) fire normally.
- **Non-Replayable Safety**: Once an action passes the dispatch boundary, ambiguous returns yield `status: 'unknown'` with `retry: false` rather than blind re-execution.
- **Step-Scoped Form Pipeline**: `chrome_form_pipeline` populates exposed fields within the active form step (supporting bounded `autoAdvance` across verified steps), while requiring explicit actions for unexposed steps or final submission.

### 3. Dual-Brain Decision Engine (`Jev System One` + `Heuristic Fallback`)

When tasks require autonomous single-page execution (`chrome_act_toward_goal`), BrowserPaw employs a dual-brain architecture:

1. **Deterministic Locator Matching**: Explicit CSS selectors, indexed references, exact labels, and text searches execute first without model overhead.
2. **TypeSafe Jev System One**: When `TYPESAFE_API_KEY` (or `JEV_API_KEY`) is configured, BrowserPaw routes ambiguous targets to TypeSafe Jev (`jev-1.14` / `jev-1.13`). It computes `Noul` typed probability assessments (`target_exists >= 0.85`, `target_ambiguous < 0.5`, `destructive < 0.5` gating, `stuck >= 0.85`) and multimodal `Box` viewport coordinate grounding. Viewport boxes undergo strict frame TTL, device pixel ratio (DPR), URL, and scroll-offset validation, failing closed upon detected drift.
3. **Zero-Key Heuristic Engine**: When no API key is provided or transient network faults occur, BrowserPaw falls back to its local zero-cost Heuristic Engine (`heuristic-engine.ts`), matching role, tag, ARIA attributes, and semantic keywords locally without losing configuration.
4. **Perceptual Boundaries**: Perceptive signatures track URL changes, document titles, progress bars, and alert banners. Raw `<canvas>` / WebGL canvas pixels and closed shadow roots require explicit coordinate or visual tools.

### 4. Local Persistent REPL (`browserpaw repl`) & Lease-Backed Artifact Delivery

The persistent Node.js REPL (`browserpaw repl`) provides a lightweight `browser.*` facade (`task`, `page`, `locator`, `skill`, `help`) within an isolated VM context. Agents can chain queries and transformations locally, keeping intermediate DOM trees, heavy network payloads, and full-resolution screenshot binaries on local disk via lease-backed file handles (`~/.browserpaw/leases/`). Clients receive lightweight references instead of overflowing MCP stdio buffers.

---

## 🚀 Quick Start

Choose the path that best matches your workflow:

### Option A: Pre-built Extension Release + Local Native Host

1. Download `browserpaw-extension.zip` (and optional `browserpaw-skill.zip`) from [GitHub Releases](https://github.com/GoldenLoaf24h/browserpaw/releases/latest) and extract `browserpaw-extension.zip` to a permanent directory (do not delete or move this folder after loading).
2. Open Google Chrome, navigate to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extracted folder.
3. Build the local Native Messaging bridge in your repository checkout and register your unpacked Extension ID:
   ```bash
   pnpm install && pnpm build
   CHROME_EXTENSION_ID=<your-32-char-extension-id> node app/native-server/dist/scripts/register-dev.js
   ```

### Option B: Full Build from Source

Build both the Chrome MV3 extension (`app/chrome-extension/.output/chrome-mv3`) and the local Native Messaging bridge from the monorepo:

```bash
git clone https://github.com/GoldenLoaf24h/browserpaw.git
cd browserpaw
pnpm install
pnpm build
```

Load `app/chrome-extension/.output/chrome-mv3` in `chrome://extensions`, copy its 32-character Extension ID, and run `node app/native-server/dist/scripts/register-dev.js` with `CHROME_EXTENSION_ID` set.

### Connect Your AI Agent

| Client                | Integration Method                                           | Configuration Reference                                                               |
| :-------------------- | :----------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| **Codex Desktop**     | Direct Stdio or Portable Plugin                              | [INSTALL.md §3.1](./INSTALL.md#31-codex-desktop--chatgpt-stdio-vs-marketplace-plugin) |
| **Claude Code**       | Marketplace Plugin (`/plugin install browserpaw@browserpaw`) | [INSTALL.md §3.5](./INSTALL.md#35-claude-code-browserpaw-marketplace-plugin)          |
| **Hermes Agent**      | Native Plugin (`plugins/browserpaw-hermes`)                  | [INSTALL.md §3.2](./INSTALL.md#32-hermes-agent)                                       |
| **DeepSeek Harness**  | Cordis Plugin (`plugins/browserpaw-dsh`)                     | [INSTALL.md §3.8](./INSTALL.md#38-deepseek-harness-plugin-package-not-an-mcp-entry)   |
| **Cursor / Windsurf** | Stdio MCP (`mcp-chrome-stdio`)                               | [INSTALL.md §3.3](./INSTALL.md#33-cursor-cursormcpjson-or-cursor-settings--mcp)       |
| **Generic MCP**       | Loopback HTTP SSE (`http://127.0.0.1:12306`)                 | [INSTALL.md §3.7](./INSTALL.md#37-generic-streamable-http-mcp)                        |

### Health Check Preflight

```bash
browserpaw doctor
```

_For detailed OS-specific setup, silent debugger mode, and troubleshooting, consult **[INSTALL.md](./INSTALL.md)**._

---

## 🛠️ MCP Tool Surface & Profiles

BrowserPaw exposes **52 canonical tools** (49 extension-executed tools + 3 native-server tools: `chrome_task`, `chrome_skill`, `chrome_act_toward_goal`). To reduce token footprint and eliminate model decision paralysis, tools are grouped into three dynamic profiles:

| Profile                | Tool Count |               Schema Footprint                | Intended Use Case                                                                                       |
| :--------------------- | :--------: | :-------------------------------------------: | :------------------------------------------------------------------------------------------------------ |
| **`core`** _(default)_ |   **9**    |           At most 26 KiB UTF-8 JSON           | Task, skill, navigation, tab inventory/selection, DOM reading, indexed interaction/fill, tool discovery |
| **`crawl`**            |   **12**   |           Read & extraction subset            | High-throughput web extraction, markdown conversion, media inspection, storage, and network queries     |
| **`full`**             |   **52**   | See generated [tool reference](docs/TOOLS.md) | Complete canonical surface; Jev availability still depends on configuration                             |

Use `chrome_tool_docs({category:"manage"})` to inspect names, then `{names:["chrome_close_tabs"],activateForSession:true}` to replace temporary extensions. `{names:[],activateForSession:true}` restores the base profile. Direct calls to known hidden tools do not expand the list. Clients without list refresh support can explicitly select `full`.

### Tool Catalog by Functional Category

| Category                     | Count | Tools Included                                                                                                                                                                                                                                                                                                         |
| :--------------------------- | :---: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session & Diagnostics**    |   4   | `chrome_doctor`, `chrome_tool_docs`, `chrome_undo_last_action`, `chrome_javascript`                                                                                                                                                                                                                                    |
| **Task & Page Lifecycle**    |  10   | `chrome_task`, `chrome_skill`, `chrome_act_toward_goal`, `chrome_navigate`, `chrome_switch_tab`, `chrome_close_tabs`, `chrome_move_tab`, `chrome_attach_tab`, `chrome_detach_tab`, `get_windows_and_tabs`                                                                                                              |
| **Observation & Extraction** |   8   | `chrome_read_dom`, `chrome_get_markdown`, `chrome_grep`, `chrome_inspect_media`, `chrome_get_dropdown_options`, `chrome_screenshot`, `chrome_smart_scroll`, `chrome_scroll_until_found`                                                                                                                                |
| **Interaction & Pipelines**  |  13   | `chrome_interact_index`, `chrome_fill_index`, `chrome_keyboard`, `chrome_upload_file`, `chrome_insert_media`, `chrome_batch_actions`, `chrome_form_pipeline`, `chrome_dismiss_overlay`, `chrome_handle_dialog`, `chrome_handle_download`, `chrome_computer`, `chrome_cdp_execute`, `chrome_request_human_intervention` |
| **Tab Groups & Bookmarks**   |   9   | `chrome_tab_group_create`, `chrome_tab_group_update`, `chrome_tab_group_list`, `chrome_tab_group_ungroup`, `chrome_tab_group_close`, `chrome_history`, `chrome_bookmark_search`, `chrome_bookmark_add`, `chrome_bookmark_delete`                                                                                       |
| **Network & Performance**    |   8   | `chrome_network_request`, `chrome_network_capture`, `chrome_intercept_api`, `chrome_console`, `chrome_storage`, `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`                                                                                                                     |

_For exact argument types, schemas, and return formats, see **[docs/TOOLS.md](./docs/TOOLS.md)**._

---

## 📚 Documentation Map

| Document                                                       | Purpose                                                                        |
| :------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| **[INSTALL.md](./INSTALL.md)**                                 | Step-by-step setup for all OS platforms, clients, and silent debugger flags    |
| **[PROJECT.md](./PROJECT.md)**                                 | Core project architecture, subsystem ownership, and maintenance boundaries     |
| **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**             | Technical topology, protocol framing, and design Architecture Decision Records |
| **[docs/TOOLS.md](./docs/TOOLS.md)**                           | Complete parameter schemas and examples for all 52 canonical tools             |
| **[docs/QUALITY.md](./docs/QUALITY.md)**                       | Quality gates, test tiers, and reliability benchmarks                          |
| **[docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)**             | Development workflow, commit guidelines, and pull request procedures           |
| **[docs/DOCUMENTATION.md](./docs/DOCUMENTATION.md)**           | Documentation governance standards, validation scripts, and style rules        |
| **[docs/releases/RELEASING.md](./docs/releases/RELEASING.md)** | Release engineering lifecycle, tagging criteria, and artifact checklists       |

---

## 🛡️ Verification & Release Status

Run the following commands to verify project health:

```bash
# Run complete static quality checks and documentation governance
pnpm verify

# Audit release notes and version tag alignment
pnpm release:check

# Diagnose local Chrome extension and Native bridge connectivity
browserpaw doctor
```

**Release Status (v4.1.2)**: BrowserPaw 4.1.2 is the latest published reliability release. It establishes interaction-scope parity across DOM observation paths, explicit delayed-page recovery, fast-observation fail-closed semantics, unified expected-page restriction handling, and error-page injection recovery. The Native idle protocol recovery was validated on an unchanged connection for over 11 minutes. Bounded empirical evidence governs all claims; unproven performance marketing claims are strictly excluded. Real Jev 1.14 holdout evaluations safely refuse low-confidence targets; deterministic tools remain the recommended default. See [docs/releases/v4.1.2.md](./docs/releases/v4.1.2.md) and [docs/development/DEVELOPMENT.md](./docs/development/DEVELOPMENT.md).

---

## 📄 Legal & License

BrowserPaw is licensed under the **[AGPL-3.0-or-later License](./LICENSE)** (GNU Affero General Public License v3.0 or later).

### ⚖️ Open Source & SaaS Copyleft (Section 13)

Under Section 13 of the AGPLv3, any modifications, forks, or derivative works—including those hosted remotely as a network service, cloud gateway, or SaaS platform interacting with users over a computer network—**must make their complete corresponding source code freely available under the same AGPL-3.0 license**.

### 🛡️ Disclaimer of Warranties & Limitation of Liability

This software is provided _"as is"_, without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, account suspensions, data loss, or other liability arising from or in connection with the software or automation workflows.

### 🌐 Compliance with Third-Party Terms

Users are solely responsible for ensuring that automated browser workflows comply with all applicable laws, regulations, and third-party website Terms of Service (ToS) or `robots.txt` policies.

### 🏷️ Trademarks & Non-Affiliation

_Google Chrome_ is a trademark of Google LLC. _Microsoft Edge_ is a trademark of Microsoft Corporation. _OpenAI_ and _ChatGPT_ are trademarks of OpenAI, Inc. _TypeSafe_ is a trademark of TypeSafe, Inc. BrowserPaw is an independent open-source project and is not sponsored, endorsed, or affiliated with any of these entities. Third-party software attributions and licenses are documented in [NOTICE](./NOTICE).
