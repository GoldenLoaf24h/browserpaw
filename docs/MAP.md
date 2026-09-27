# 🗺️ BrowserPaw Project Map & Documentation Index

Welcome to the **BrowserPaw** Project Map. Whether you are an end-user, an AI agent developer, a prompt engineer, or a core contributor, this document serves as your single source of truth for navigating the architecture, code topology, tools, and documentation.

---

## 🧭 1. Reading Paths by Role

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Choose Your Journey                             │
├──────────────────────┬──────────────────────┬───────────────────────────────┤
│ 👤 End-User          │ 🤖 Agent Developer   │ 🏗️ Core Contributor           │
├──────────────────────┼──────────────────────┼───────────────────────────────┤
│ 1. README.md         │ 1. AGENT_CONFIG_GUIDE│ 1. docs/ARCHITECTURE.md       │
│    (Quick Start)     │ 2. skill/SKILL.md    │ 2. packages/shared/tools.ts   │
│ 2. Load Extension    │ 3. docs/TOOLS.md     │ 3. app/chrome-extension/      │
│ 3. Configure Client  │ 4. Batch Pipeline &  │ 4. app/native-server/         │
│                      │    Delta Strategies  │ 5. Test Suite (Vitest + Node) │
└──────────────────────┴──────────────────────┴───────────────────────────────┘
```

- **I just want my AI to drive my browser**:
  1. Read the **[Quick Start in README.md](../README.md#quick-start-let-ai-do-the-work)** or the **[Chinese Quick Start](../README.zh-CN.md)**.
  2. Download the prebuilt clean extension from **[Releases](https://github.com/GoldenLoaf24h/browserpaw/releases)** and load it in `chrome://extensions`.
  3. Copy your client JSON from **[AGENT_CONFIG_GUIDE.md](../AGENT_CONFIG_GUIDE.md)** into Cursor, Claude, or Codex.
- **I am an AI Agent / Prompt Engineer integrating BrowserPaw**:
  1. Study **[skill/SKILL.md](../skill/SKILL.md)**: Encodes dual-engine workflows (DOM-First vs Visual Fallback), the Escalation Ladder, and recovery patterns.
  2. Consult **[docs/TOOLS.md](./TOOLS.md)**: Auto-generated parameter references for all 50 canonical tools across Core (14), Crawl (12), and Full (50) profiles.
  3. Follow the 6 interaction rules in **[AGENT_CONFIG_GUIDE.md](../AGENT_CONFIG_GUIDE.md)** (especially `includeDelta: true` and `chrome_grep`).
- **I want to contribute or audit the architecture**:
  1. Inspect **[docs/ARCHITECTURE.md](./ARCHITECTURE.md)**: Complete system topology, IPC buffer guards, and sequence diagrams.
  2. Check **[PROJECT.md](../PROJECT.md)**: High-level package notes and quality gates.
  3. Review **[TEST_INFRA.md](../TEST_INFRA.md)**: Comprehensive E2E test infrastructure specification, test tiers, and verification harnesses.

---

## 🗂️ 2. Repository & Monorepo Topology

```text
mcp-chrome-master/
├── packages/
│   └── shared/                  # 🌟 Single Source of Truth
│       └── src/
│           ├── tools.ts         # All 50 canonical tool schemas, tool names
│           ├── tool-profiles.ts # Profile definitions (Core 14, Crawl 12, Full 50)
│           ├── types.ts         # Universal coordinate, batch item & diff result types
│           └── error-format.ts  # Standardized error reporting with stack control
│
├── app/
│   ├── chrome-extension/        # 🧩 Chrome MV3 Extension (WXT + Vue 3)
│   │   ├── entrypoints/
│   │   │   ├── background/      # Main Service Worker (49 Browser Atomic Tool Executors)
│   │   │   │   └── tools/browser/tab-group-manager.ts # Tab grouping & orphan cleanup
│   │   │   ├── agent-cursor.content.ts # Closed Shadow DOM virtual mouse overlay
│   │   │   ├── inpage-engine.ts # Isolated-world DOM indexing & pruning engine
│   │   │   └── popup/           # Extension popup UI (Agent on/off)
│   │   └── utils/
│   │       ├── cdp-session-manager.ts # Session-aware CDP retention (10-min idle)
│   │       └── snapshot-cache-manager.ts # DOM fingerprint caching & delta diffing
│   │
│   └── native-server/           # 🔌 Fastify Native Messaging Bridge
│       ├── src/index.ts         # Fastify HTTP (127.0.0.1:12306) & Streamable SSE
│       ├── src/native-messaging-host.ts # StdIO IPC with Chrome (1MB buffer ceiling guard)
│       └── src/scripts/         # Auto-installer for Native Messaging manifest
│
├── docs/                        # 📚 Documentation Vault (MAP, TOOLS, ARCHITECTURE)
├── skill/                       # 🧠 AI Agent Skill Package (SKILL.md)
└── test/                        # 🧪 Integration & E2E Verification
```

---

## 📖 3. Complete Documentation Matrix

| Document                                                                                          |     Language      |      Primary Audience       | Core Focus & Purpose                                                                | Maintenance Mechanism                          |
| :------------------------------------------------------------------------------------------------ | :---------------: | :-------------------------: | :---------------------------------------------------------------------------------- | :--------------------------------------------- |
| **[README.md](../README.md)**                                                                     |      English      |    All Users / Community    | Project homepage, architectural benefits, quick start, and feature overview         | Maintained manually                            |
| **[README.zh-CN.md](../README.zh-CN.md)**                                                         |      Chinese      |     Chinese Developers      | Complete Chinese homepage, Windows file lock resolutions & quickstart guide         | Kept in sync with README.md                    |
| **[docs/MAP.md](./MAP.md)**                                                                       |      English      |    All Users / AI Agents    | **Master Navigation Hub**: repository topology, reading paths, and capability radar | This document                                  |
| **[docs/TOOLS.md](./TOOLS.md)**                                                                   |      English      |     Agents / Developers     | Parameter dictionary for all 50 canonical tools across profiles                     | Auto-generated via `scripts/gen-tools-doc.mjs` |
| **[docs/ARCHITECTURE.md](./ARCHITECTURE.md)**                                                     |      English      |    Architects / Auditors    | 3-tier architecture topology, Native Messaging protocols, and ADR records           | Updated on architecture changes                |
| **[docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** ([Chinese](./TROUBLESHOOTING.zh-CN.md))       | English / Chinese | Operators / Troubleshooters | Diagnostic checklist for connection errors, tokens, CDP detachment, etc.            | Updated on issue discovery                     |
| **[AGENT_CONFIG_GUIDE.md](../AGENT_CONFIG_GUIDE.md)** ([Chinese](../AGENT_CONFIG_GUIDE.zh-CN.md)) | English / Chinese |     Agents / Developers     | Client configurations (Claude, Cursor, Windsurf) and 6 interaction rules            | Updated on client updates                      |
| **[skill/SKILL.md](../skill/SKILL.md)**                                                           |      English      |          AI Agents          | Machine-executable skill definition: dual-engine routing and recovery ladders       | Synchronized with MCP schemas                  |
| **[PROJECT.md](../PROJECT.md)**                                                                   |      English      |         Maintainers         | Engineering specifications, quality gates, and architecture summaries               | Updated on version releases                    |
| **[TEST_INFRA.md](../TEST_INFRA.md)**                                                             |      English      |     Testers / Auditors      | 4-tier E2E testing architecture, test harness specifications & 153-test matrix      | Updated on test changes                        |

---

## 🛠️ 4. 50 Canonical Tools Capability Radar

BrowserPaw supports **Dynamic Profile Layering**, balancing prompt token consumption for smaller models while providing full low-level control for advanced agents:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                              50 MCP TOOLS                              │
├────────────────────────────────────────────────────────────────────────┤
│ 🟢 CORE (14 Tools) - High-Frequency Semantic & Visual Interaction     │
│   • Navigate (4): navigate, switch_tab, close_tabs, get_windows_and_tabs
│   • Perceive (4): read_dom, get_markdown, inspect_media, grep          │
│   • Act (3): interact_index, fill_index, batch_actions                 │
│   • Observe (2): screenshot, smart_scroll                              │
│   • Discovery (1): chrome_tool_docs                                    │
├────────────────────────────────────────────────────────────────────────┤
│ 🟡 CRAWL (12 Tools) - Lightweight High-Throughput Web Extraction       │
│   • Content: get_markdown, inspect_media, read_dom, grep               │
│   • Navigation & Storage: navigate, smart_scroll, storage...           │
│   • Network & Low-level: cdp_execute, network_request, screenshot...   │
├────────────────────────────────────────────────────────────────────────┤
│ 🟣 FULL (50 Tools) - Comprehensive Low-Level & Enterprise Control      │
│   • Autonomous Micro-Loop: chrome_act_toward_goal (Fast Jev Engine)    │
│   • Advanced CDP: cdp_execute (Target polymorphic routing + Anti-Hang) │
│   • Human-in-the-Loop: request_human_intervention, undo_last_action   │
│   • Network & Console: network_capture, chrome_console, storage...   │
│   • Browser Mgmt: tab_groups, bookmarks, history, download, doctor...  │
└────────────────────────────────────────────────────────────────────────┘
```

> **Dynamic Profile Switching & On-Demand Tool Unlocking**:
> Even in `core` or `crawl` profiles, agents can discover and dynamically expose tools for their session without restarting the server via:
> `chrome_tool_docs({ category: "manage" | "diagnose" | "network" | ..., activateForSession: true })`
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
| **Active Tab Closure Protection**         | Calling `chrome_close_tabs` without target IDs requires explicit `confirm: true` or active `sessionId` affinity                                | Prevents AI agents from inadvertently closing the human user's active foreground working tab due to missing arguments.                       |
| **Platform Key Modifiers**                | macOS Command modifier explicitly aligned to `mod = 4` (`Meta`)                                                                                | Corrects keyboard modifier bitmasks for Select All, Copy, Cut, and Paste on macOS environments.                                              |
| **Auto-Return Expressions**               | Intelligent expression evaluation in `chrome_javascript` automatically wraps non-returning expressions in `return (...)`                       | Streamlines ad-hoc agent calculations and DOM property reads without manual closure boilerplate.                                             |
| **Event-Driven Navigation Waiting**       | `chrome_get_web_content` listens to `chrome.tabs.onUpdated` and `chrome.tabs.onRemoved` lifecycle events                                       | Replaces arbitrary sleep timers with deterministic event-driven readiness, slashing latency and eliminating flakes.                          |
| **Windows Host Watchdog**                 | Fastify `closeAllConnections()` paired with an unreferenced 1000ms hard exit watchdog                                                          | Permanently prevents keep-alive sockets from holding port 12306 or leaving orphan zombie Node processes on Windows.                          |
| **Polymorphic Coordinate Ajv Compliance** | Declarative `oneOf` coordinate schemas without conflicting top-level `type: 'object'` constraints                                              | Guarantees strict JSON Schema / Ajv validation passes for both `[x, y]` array and `{x, y}` object coordinates in Claude and Cursor.          |
| **Background Scroll Circuit-Breaker**     | Detects background tabs in `scroll` and `smart_scroll` to bypass CDP mouse wheel events, falling back to in-page JS scrolling                  | Eliminates 3000ms stalls caused by Chromium pausing compositor frame generation for inactive background tabs.                                |
| **Cross-Frame Script Injection Cache**    | Injection cache key format upgraded to `${files.join(',')}\|${world}\|${frameKey}` in `base-browser.ts`                                        | Eliminates script injection false-hits between parent and child frames, preventing missed subframe script injection.                         |

---

_Need quick help? Check the [Troubleshooting Guide](./TROUBLESHOOTING.md) or open an issue on [GitHub](https://github.com/GoldenLoaf24h/browserpaw/issues)._
