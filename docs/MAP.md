# 🗺️ BrowserPaw Architecture and Code Map

This map provides architecture and codebase references. Single Source of Truth authority: [QUALITY.md](./QUALITY.md) owns verification and acceptance gates; [DOCUMENTATION.md](./DOCUMENTATION.md) owns lifecycle and directory layout; [README.md](./README.md) is the documentation hub; [CONTRIBUTING.md](./CONTRIBUTING.md) owns contributor workflows; [releases/](./releases/README.md) manages release notes (governed by `docs/releases/RELEASING.md` and `TEMPLATE.md`).

---

## 🧭 1. Reading Paths by Role

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Choose Your Journey                             │
├──────────────────────┬──────────────────────┬───────────────────────────────┤
│ 👤 End-User          │ 🤖 Agent Developer   │ 🏗️ Core Contributor           │
├──────────────────────┼──────────────────────┼───────────────────────────────┤
│ 1. README.md         │ 1. AGENT_CONFIG_GUIDE│ 1. docs/ARCHITECTURE.md       │
│    (Quick Start)     │ 2. skills/browserpaw/SKILL.md    │ 2. packages/shared/src/tools.ts   │
│ 2. Load Extension    │ 3. docs/TOOLS.md     │ 3. app/chrome-extension/      │
│ 3. Configure Client  │ 4. Batch Pipeline &  │ 4. app/native-server/         │
│                      │    Delta Strategies  │ 5. Test Suite (Vitest + Node) │
└──────────────────────┴──────────────────────┴───────────────────────────────┘
```

- **I just want my AI to drive my browser**:
  1. Read the **[Quick Start in README.md](../README.md#-quick-start)** or the **[Chinese Quick Start](../README.zh-CN.md)**.
  2. Download the prebuilt clean extension from **[Releases](https://github.com/GoldenLoaf24h/browserpaw/releases)** and load it in `chrome://extensions`.
  3. Copy your client JSON from **[AGENT_CONFIG_GUIDE.md](../AGENT_CONFIG_GUIDE.md)** into Cursor, Claude, or Codex.
- **I am an AI Agent / Prompt Engineer integrating BrowserPaw**:
  1. Read **[skills/browserpaw/SKILL.md](../skills/browserpaw/SKILL.md)** and load only the relevant files under `references/` for progressive disclosure.
  2. Consult **[docs/TOOLS.md](./TOOLS.md)** for generated parameter references; use `chrome_tool_docs` for the live runtime list.
  3. Install the same canonical skill with `browserpaw skill install` for ordinary Agent Skills clients, or use the official ChatGPT/Codex, Hermes, Claude Code, or DSH package documented in **[PLUGIN_COMPATIBILITY.md](./development/PLUGIN_COMPATIBILITY.md)**.
- **I want to contribute or audit the architecture**:
  1. Inspect **[docs/ARCHITECTURE.md](./ARCHITECTURE.md)**: Complete system topology, IPC buffer guards, and sequence diagrams.
  2. Check **[PROJECT.md](../PROJECT.md)**: High-level package notes and quality gates.
  3. Review **[TEST_INFRA.md](../TEST_INFRA.md)**: Comprehensive E2E test infrastructure specification, test tiers, and verification harnesses.

---

## 🗂️ 2. Repository & Monorepo Topology

BrowserPaw adheres to the canonical Repository Layout Specification defined in [`docs/DOCUMENTATION.md`](./DOCUMENTATION.md):

```text
mcp-chrome-master/
├── app/                         # 🚀 Primary executable applications
│   ├── chrome-extension/        # 🧩 Chrome MV3 Extension (WXT + Vue 3)
│   │   ├── entrypoints/         # Service worker, isolated inpage scripts & popup
│   │   └── utils/               # CDP session manager & snapshot cache
│   └── native-server/           # 🔌 Fastify Native Messaging Bridge & Stdio MCP host
├── packages/
│   └── shared/                  # 🌟 Schema SSOT (tools.ts, tool-profiles.ts, types.ts)
├── test/                        # 🧪 Cross-package integration suites & E2E runners (kept in-place)
├── scripts/                     # ⚙️ Purpose-driven lifecycle, build, and verification scripts
├── .artifacts/                  # 🗑️ Ephemeral test dumps & delivery reports (git-ignored)
├── docs/                        # 📚 Canonical documentation vault
│   └── archive/                 # 📦 Isolated historical records (handoffs, audits, tests)
├── research/                    # 🔬 External investigations & third-party spikes (isolated)
├── releases/                    # 📦 Local distribution archives (stable zip files)
├── skills/browserpaw/           # 🧠 Client-neutral Agent Skill
└── plugins/                     # 🔌 Client-specific distribution wrappers
```

---

## 📖 3. Complete Documentation Matrix

| Document                                                                                          |     Language      |      Primary Audience       | Core Focus & Purpose                                                                | Maintenance Mechanism                          |
| :------------------------------------------------------------------------------------------------ | :---------------: | :-------------------------: | :---------------------------------------------------------------------------------- | :--------------------------------------------- |
| **[README.md](../README.md)**                                                                     |      English      |    All Users / Community    | Project homepage, architectural benefits, quick start, and feature overview         | Maintained manually                            |
| **[README.zh-CN.md](../README.zh-CN.md)**                                                         |      Chinese      |     Chinese Developers      | Complete Chinese homepage, Windows file lock resolutions & quickstart guide         | Kept in sync with README.md                    |
| **[docs/MAP.md](./MAP.md)**                                                                       |      English      |    All Users / AI Agents    | **Master Navigation Hub**: repository topology, reading paths, and capability radar | This document                                  |
| **[docs/TOOLS.md](./TOOLS.md)**                                                                   |      English      |     Agents / Developers     | Parameter dictionary for the canonical tools across profiles                        | Auto-generated via `scripts/gen-tools-doc.mjs` |
| **[docs/ARCHITECTURE.md](./ARCHITECTURE.md)**                                                     |      English      |    Architects / Auditors    | 3-tier architecture topology, Native Messaging protocols, and ADR records           | Updated on architecture changes                |
| **[docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** ([Chinese](./TROUBLESHOOTING.zh-CN.md))       | English / Chinese | Operators / Troubleshooters | Diagnostic checklist for connection errors, tokens, CDP detachment, etc.            | Updated on issue discovery                     |
| **[AGENT_CONFIG_GUIDE.md](../AGENT_CONFIG_GUIDE.md)** ([Chinese](../AGENT_CONFIG_GUIDE.zh-CN.md)) | English / Chinese |     Agents / Developers     | Client configurations (Claude, Cursor, Windsurf) and 6 interaction rules            | Updated on client updates                      |
| **[skills/browserpaw/SKILL.md](../skills/browserpaw/SKILL.md)**                                   |      English      |          AI Agents          | Client-neutral entry point with on-demand references, scripts, and recipes          | Synchronized into client packages              |
| **[docs/development/PLUGIN_COMPATIBILITY.md](./development/PLUGIN_COMPATIBILITY.md)**             |      English      |     Client Integrators      | Official-format contracts for ChatGPT/Codex, Hermes, Claude Code, and DSH           | Updated with host and package validation       |
| **[PROJECT.md](../PROJECT.md)**                                                                   |      English      |         Maintainers         | Engineering specifications, quality gates, and architecture summaries               | Updated on version releases                    |
| **[TEST_INFRA.md](../TEST_INFRA.md)**                                                             |      English      |     Testers / Auditors      | E2E test architecture, harness specifications, and real-site evidence rules         | Updated on test changes                        |

---

## 🛠️ 4. Canonical Tools Capability Radar

BrowserPaw supports **Dynamic Profile Layering**, balancing prompt token consumption for smaller models while providing full low-level control for advanced agents:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          BROWSERPAW MCP TOOLS                          │
├────────────────────────────────────────────────────────────────────────┤
│ 🟢 CORE - High-Frequency Semantic & Visual Interaction                │
│   • Navigation and safe tab selection                                 │
│   • Task and skill lifecycle; DOM reading                            │
│   • Index-based interaction and fill                                 │
│   • Nine tools by default; extra tools selected explicitly           │
│   • Discovery (1): chrome_tool_docs                                    │
├────────────────────────────────────────────────────────────────────────┤
│ 🟡 CRAWL - Lightweight High-Throughput Web Extraction                  │
│   • Content: get_markdown, inspect_media, read_dom, grep               │
│   • Navigation & Storage: navigate, smart_scroll, storage...           │
│   • Network & Low-level: cdp_execute, network_request, screenshot...   │
├────────────────────────────────────────────────────────────────────────┤
│ 🟣 FULL - Comprehensive Low-Level & Enterprise Control                 │
│   • Autonomous Micro-Loop: chrome_act_toward_goal (Fast Jev Engine)    │
│   • Advanced CDP: cdp_execute (Target polymorphic routing + Anti-Hang) │
│   • Human-in-the-Loop: request_human_intervention, undo_last_action   │
│   • Network & Console: network_capture, chrome_console, storage...   │
│   • Browser Mgmt: tab_groups, bookmarks, history, download, doctor...  │
└────────────────────────────────────────────────────────────────────────┘
```

> **Dynamic Profile Switching & On-Demand Tool Unlocking**:
> Even in `core` or `crawl` profiles, agents can discover and select exact additional tools for their session without restarting the server via:
> Inspect `{category:"manage"}`, then use `chrome_tool_docs({names:["chrome_close_tabs"],activateForSession:true})` to replace temporary extensions; an empty names array resets them.
> Supported categories: `navigate`, `perceive`, `act`, `observe`, `manage`, `diagnose`, `network`, `crawl`.
> Both **Fastify HTTP/SSE** and **Stdio transport** (`mcp-server-stdio.ts`) support dynamic tool exposure.

---

## ⚡ 5. Core Execution Pipelines

### 5.1 DOM-First Physical Click Pipeline (`chrome_interact_index`)

```text
AI Agent                Native Server             Chrome SW             Page (Isolated World)
   │                         │                        │                          │
   │── tools/call (index: 5)─▶│                        │                          │
   │   includeDelta: true    │── Native Messaging ───▶│                          │
   │                         │   (1000KB Guard)       │── animateAgentCursor ───▶│ (Virtual blue cursor
   │                         │                        │   (Spring kinematics)    │  flies smoothly)
   │                         │                        │                          │
   │                         │                        │── CDP dispatchMouseEvent▶│ (Native isTrusted=true)
   │                         │                        │                          │
   │                         │                        │── Settle & Snapshot ────▶│ (DOM Mutation Check)
   │                         │                        │                          │
   │                         │                        │◀── diffWithPrevious ─────│ (Compute local diff)
   │◀── Result + Delta ──────│◀── Native Response ────│                          │
   │    [+ added 3 nodes]    │                        │                          │
```

### 5.2 Human-in-the-Loop Takeover Pipeline for Captchas & 2FA (`chrome_request_human_intervention`)

```text
AI Agent                            BrowserPaw Extension                     User (Human)
   │                                          │                                     │
   │── request_human_intervention ───────────▶│                                     │
   │   "Please solve slider captcha"          │── Mount Frosted Glass Top Banner ──▶│ (Screen dims softly)
   │                                          │   (Park cursor at top-right)        │
   │                                          │                                     │
   │                                          │                                     │ 🖱️ Solves captcha
   │                                          │◀── Clicks [Continue] / Presses Enter│
   │                                          │── Fade-out & Unmount Overlay ───────│
   │◀── { resolved: true, action: "resumed" }─│                                     │
   │                                          │                                     │
   │── (Continues Next Automation Step) ─────▶│                                     │
```

---

## 🛡️ 6. Hardened Security & MV3 Lifecycle Architecture

| Architectural Dimension                   | Implementation Mechanism                                                                                                                       | Resolved Vulnerability & Pain Point                                                                                                          |
| :---------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sender Permission Isolation**           | `chrome.runtime.onMessage` strictly validates `_sender.id === chrome.runtime.id` and rejects `_sender.tab`                                     | Prevents untrusted webpage content scripts or external extensions from forging messages to steal tokens or execute privileged tools.         |
| **DOM XSS Defense**                       | `agent-cursor.content.ts` constructs banner nodes purely via native DOM APIs (`createElement` / `createTextNode`)                              | Eliminates DOM XSS vectors caused by string concatenation or `innerHTML` interpolation of user-supplied `reason` strings.                    |
| **Cross-Frame Context Isolation**         | Single-frame execution context (`frameIds: [targetFrameId]`) paired with isolated symbol-keyed WeakRef index mappings                          | Prevents cross-frame message pollution and eliminates index tree corruption between parent and nested iframes.                               |
| **Multi-Frame Grep & Scanning**           | Full-frame scanning in `chrome_grep` with read-only index projection, matching across text, `placeholder`, `aria-label`, and `value`           | Penetrates nested and cross-origin iframe boundaries without causing indexing side effects or tree mutations.                                |
| **CDP Domain Reference Counting**         | Domain-level reference counting (`enableDomain` / `disableDomain`) in `CDPSessionManager`, keeping core domains (`Page`, `Network`) persistent | Resolves race conditions where concurrent or pipelined tools prematurely disable domains required by downstream listeners.                   |
| **Debugger Anti-Hang Detachment**         | Low-level `timeout-guard` and `detachDebugger` trigger immediate physical detach (`chrome.debugger.detach`) and clean up domain references     | Prevents debugger session freezes and reference counter underflow when pages crash or stop responding.                                       |
| **Background Tab Offscreen Screenshots**  | Background tabs (`active: false`) strictly use CDP `Page.captureScreenshot(fromSurface: true)`                                                 | Prevents screen leakage of the user's active personal window and eliminates background tab hangs caused by `requestAnimationFrame` freezing. |
| **MV3 Session Persistence**               | `SessionTabAffinityManager`, `TabGroupManager`, and `TabFaviconManager` persist state in `chrome.storage.session`                              | Resilient against Chrome MV3 30-second Service Worker idle terminations, restoring full state upon wake-up.                                  |
| **Strict Tab Lineage Handover**           | Auto-affinity handover requires confirmed lineage via `openerTabId` or `webNavigation.onCreatedNavigationTarget`                               | Eliminates session hijacking from unrelated user new tabs; noopener links supported via verified navigationtarget evidence.                  |
| **Active Tab Closure Protection**         | Calling `chrome_close_tabs` without target IDs requires explicit `confirm: true` or active `sessionId` affinity                                | Prevents AI agents from inadvertently closing the human user's active foreground working tab due to missing arguments.                       |
| **Platform Key Modifiers**                | macOS Command modifier explicitly aligned to `mod = 4` (`Meta`)                                                                                | Corrects keyboard modifier bitmasks for Select All, Copy, Cut, and Paste on macOS environments.                                              |
| **Auto-Return Expressions**               | Intelligent expression evaluation in `chrome_javascript` automatically wraps non-returning expressions in `return (...)`                       | Streamlines ad-hoc agent calculations and DOM property reads without manual closure boilerplate.                                             |
| **Event-Driven Navigation Waiting**       | `chrome_navigate` and `chrome_read_dom` listen to `chrome.tabs.onUpdated` and settle events                                                    | Replaces arbitrary sleep timers with deterministic event-driven readiness, slashing latency and eliminating flakes.                          |
| **Windows Host Watchdog**                 | Fastify `closeAllConnections()` paired with an unreferenced 1000ms hard exit watchdog                                                          | Permanently prevents keep-alive sockets from holding port 12306 or leaving orphan zombie Node processes on Windows.                          |
| **Polymorphic Coordinate Ajv Compliance** | Declarative `oneOf` coordinate schemas without conflicting top-level `type: 'object'` constraints                                              | Guarantees strict JSON Schema / Ajv validation passes for both `[x, y]` array and `{x, y}` object coordinates in Claude and Cursor.          |
| **Background Scroll Circuit-Breaker**     | Detects background tabs in `scroll` and `smart_scroll` to bypass CDP mouse wheel events, falling back to in-page JS scrolling                  | Eliminates 3000ms stalls caused by Chromium pausing compositor frame generation for inactive background tabs.                                |
| **Cross-Frame Script Injection Cache**    | Injection cache key format upgraded to `${files.join(',')}\|${world}\|${frameKey}` in `base-browser.ts`                                        | Eliminates script injection false-hits between parent and child frames, preventing missed subframe script injection.                         |

---

_Need quick help? Check the [Troubleshooting Guide](./TROUBLESHOOTING.md) or open an issue on [GitHub](https://github.com/GoldenLoaf24h/browserpaw/issues)._
