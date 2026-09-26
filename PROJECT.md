# BrowserPaw Project Specifications & Notes

[Chinese Version (zh-CN)](./PROJECT.zh-CN.md)

## Positioning & Core Philosophy

BrowserPaw is a high-performance Model Context Protocol (MCP) server engineered for AI agents to control the user's real Chrome browser. Unlike headless automation runtimes (Playwright, Puppeteer, Selenium), BrowserPaw operates directly within the user's everyday Google Chrome instance—preserving existing login sessions, cookies, and extension ecosystems. It exposes browser capabilities as 50 schema-validated canonical MCP tools (49 extension/browser tools + 1 native loop tool) via Chrome Native Messaging and the Chrome DevTools Protocol (CDP).

## Monorepo Architecture (pnpm)

1. **`packages/shared`** (`chrome-mcp-shared`):
   - **Single Source of Truth**: Houses all 50 canonical MCP tool schemas (`TOOL_SCHEMAS`), tool profiles (`core`: 14, `crawl`: 12, `full`: 50), the `UnifiedLocatorOptions` coordinate contract, and standardized error formatters.
2. **`app/native-server`** (`mcp-chrome-bridge`):
   - **Fastify Native Host**: Manages dual MCP transports (Stdio and HTTP/SSE on `127.0.0.1:12306`), `McpSessionManager` (isolated per-session server instances with 10-minute idle eviction), `bridge-token` authentication, autonomous semantic micro-loop execution (`chrome_act_toward_goal`), and Chromium performance trace analyzers.
3. **`app/chrome-extension`** (`chrome-mcp-server`):
   - **WXT + Vue 3 Manifest V3 Extension**: Background Service Worker housing 49 browser tool executors and CDP session management. Features a 1:1 spring-kinematics virtual cursor overlay, automatic colored tab grouping with zero-residue cleanup, and tab favicon illumination. The `inpage-engine` executes isolated-world 1-based DOM pruning and indexing.

## Key Architectural Principles

- **Tool Surface Strict Parity**: The runtime `toolsMap` is strictly derived from `TOOL_SCHEMAS`. Internal helper executors cannot be invoked directly without explicit schema declaration (guaranteed by tool surface parity test suites).
- **Profile Layering & Dynamic Discovery**: Features 3 primary profiles (`core`: 14, `crawl`: 12, `full`: 50) across 8 tool categories (`navigate`, `perceive`, `act`, `observe`, `manage`, `diagnose`, `network`, `crawl`). Hidden tools can be inspected via `chrome_tool_docs` and dynamically activated on-demand (`activateForSession: true`) across both HTTP and Stdio without process restarts.
- **Autonomous DOM Diff Piggybacking**: Interactive tools (`chrome_interact_index`, `chrome_fill_index`, `chrome_batch_actions`) support `includeDelta: true`, returning local element mutations directly in the action response to eliminate 50% of round-trip inspection overhead.
- **Targeted Grep Optimization**: `chrome_grep` supports multi-frame hierarchical remapping and matches against text, `placeholder`, `aria-label`, and `value`. It provides three distinct search modes (interactive elements, full DOM, and plain text), eliminating wasteful multi-thousand-token full DOM dumps.
- **Closed-Loop Action Pipelines**: `chrome_batch_actions` chains discrete clicks, fills, waits, assertions (`assert`), and field extractions (`extract`) within a single network round-trip, supporting cross-origin iframe coordinate translation.
- **Human-in-the-Loop & Undo Safety**: Combines raw CDP penetration (`chrome_cdp_execute`) with safe native DOM frosted-glass takeover banners (`chrome_request_human_intervention`, completely immune to DOM XSS) and a 5-step circular stack undo mechanism (`chrome_undo_last_action`).
- **MV3 Session State Persistence**: `SessionTabAffinityManager`, `TabGroupManager`, and `TabFaviconManager` persist state in `chrome.storage.session` to withstand 30-second Chrome Service Worker idle termination and restarts.
- **CDP Domain Reference Counting**: `CDPSessionManager` tracks domain-level references (`enableDomain` / `disableDomain`), keeping core domains active while low-level timeout guards trigger physical detachment (`chrome.debugger.detach`) to prevent deadlocks.
- **Security & Privilege Boundaries**: `chrome.runtime.onMessage` strictly rejects messages originating from webpage content scripts (`_sender.tab`) or external extensions, blocking unauthorized tool dispatch.
- **Diskless Visual Pipeline**: Screenshot data remains entirely in-memory. Inactive background tabs strictly dispatch offscreen CDP `Page.captureScreenshot(fromSurface: true)`, preventing foreground screen leaks and `requestAnimationFrame` freezing deadlocks.
- **Human Kinematics & Platform Alignment**: Dispatches native CDP `Input` events (`isTrusted: true`), configurable `dwellMs` press duration, macOS Command key alignment (`mod = 4`), and explicit confirmation protection (`confirm: true`) for `chrome_close_tabs`.

- **W3C Semantic Perception & Card Flattening**: `chrome_read_dom` natively supports W3C composite card flattening (`flattenCards: true`), folding complex `article`, `[role="article"]`, `[role="listitem"]` containers into atomic entities while stripping PUA Unicode icon glyphs (`[\uE000-\uF8FF]`) to prevent terminal encoding crashes.
- **Token-Boundary Form Semantic Matcher**: Form fields are resolved using discrete two-phase exact and token-boundary semantic analysis, eliminating false-positive substring bleeding (e.g. `phone` vs `no`, `male` vs `female`).
- **Universal Zero-Drift Tab Grouping**: Domain-agnostic title cleansing preserves English hyphenated words (`COVID-19`, `Wi-Fi`) via lookaround regex while properly organizing tabs without domain dictionaries.

- **Atomic Fast DOM Snapshot & Perception Pipeline**: `chrome_read_dom` natively supports ultrafast atomic snapshots (`fast: true`), single-pass `TreeWalker` traversal with native `checkVisibility` and `window.__pawFast` WeakMap caching. Payload budget is bounded to $\le 250$ actions and $\le 6000$ characters, cutting scan latency to 10~30ms.
- **Controlled Component Native Value Setter**: Bypasses React 16–19 and Vue 3 controlled input interception by invoking prototype descriptors directly followed by standard synthetic `input` and `change` event sequences.
- **Pre-CDP 1ms Occlusion Circuit Breaker**: Pre-validates click targeting via in-page microtask hit testing with up to 3 layers of `pointer-events: none` piercing, failing fast with `{ "error": "target_occluded", "retry": true }`.
- **rAF & ARIA Combobox Smart Micro-Wait**: Eliminates blind sleeps with 2-frame `requestAnimationFrame` ($\approx 32$ms) convergence and dedicated option-discovery watchdogs for autocomplete comboboxes ($\le 200$ms).
- **HTML5 DataTransfer Upload Fallback**: Gracefully falls back to browser-native `DataTransfer` file synthesis across Shadow DOM boundaries when CDP debugger attachment is unavailable.

## Quality Gates & Verification Matrix

- **Chrome Extension Vitest**: 463 unit tests passing 100% across 51 suites (including F1-M3 pipeline, tab closing, javascript execution, grep, delta diffs, batch assertions, media extraction, deep shadow DOM piercing, visual drift compensation, card flattening, token boundary matching, and undo).
- **Native Server Jest**: 94 unit and integration tests passing 100% across 5 suites (including Jev fast-decision engine, heuristic scoring, client resilience, update notifier, and session managers).
- **End-to-End Suite**: 153 four-tier E2E tests passing 100% (`node --experimental-strip-types test/e2e/runner.ts`).
- **Plugin Integration**: 8 Pytest cases passing 100% (`plugins/browserpaw/tests/test_bridge_token.py`).
- **TypeScript Checking**: 0 errors across all monorepo packages (`pnpm typecheck`).
- **Total Automated Test Volume**: 710 / 710 tests passing (100% green).
