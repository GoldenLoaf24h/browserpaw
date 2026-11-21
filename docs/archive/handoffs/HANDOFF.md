# BrowserPaw Engineering Handoff Document (HANDOFF)

> **Updated**: 2026-09-27
> **Milestone**: Full Test Suite Compliance (12/12 Protocols Sealed, 153/153 E2E Tests, 547 Vitest, 124 Jest Tests 100% Pass)
> **Chinese Version**: [HANDOFF.zh-CN.md](./HANDOFF.zh-CN.md)
> **Scope**: Authoritative engineering handover document for incoming AI agents and human engineers. Adheres strictly to the "Zero Cheating, 100% native CDP/browser-use execution" paradigm.

---

## 1. Core Principles & Engineering Guardrails (Highest Priority ⚠️)

### 1.1 Strictly Prohibited Actions (Full Verification Guaranteed)

- ❌ **No `chrome_javascript` Shortcuts or Backdoors**:
  - **No In-Memory Credential Theft**: Injected scripts must never read `localStorage` / `sessionStorage` to steal auth tokens, OTP codes, or CSRF secrets.
  - **No Artificial Value Forcing**: Never bypass native input lifecycles using `nativeSetter.call(input, val)` or forced `element.click()` in page context to tamper with React 18/19 or Vue 3 internal component state.
- ✅ **100% Pure Native Browser-Use Paradigm**:
  - **Perception**: Obtain clean 1-based indexed trees via `chrome_read_dom` or visual coordinate grids via `chrome_screenshot`.
  - **Action**: Dispatch trusted hardware-level CDP events via `chrome_interact_index` (click, double click, right click, hover, drag), `chrome_fill_index` (physical keystroke input with controlled input fallback), `chrome_batch_actions` (multi-action pipeline), and `chrome_smart_scroll` (container-aware scrolling).
  - **Root Cause Fixes**: When encountering edge cases, always reinforce the extension core (`app/chrome-extension/entrypoints/background/tools/browser/`) rather than hacking test cases or page environments.

---

## 2. Monorepo Architecture & Directory Topology

- **Repository Root**: `D:\workspace\mcp-chrome-master\mcp-chrome-master`
- **Packages**:
  - `packages/shared`: Single source of truth for tool schemas (`TOOL_SCHEMAS`), profiles (`core`: 14, `crawl`: 12, `full`: 50), coordinate types, and formatters.
  - `app/native-server`: Fastify MCP server (HTTP/SSE & Stdio), Jev model manager, and token authentication.
  - `app/chrome-extension`: Chrome MV3 background service worker, in-page DOM indexer, and popup management UI.
- **Standalone Extension Output Directories**:
  - `D:\workspace\browserpaw` (synced automatically via `scripts/sync-extension-dist.mjs`)
  - `D:\workspace\browserpaw` (legacy load folder support)
- **Interactive Verification Gauntlet**:
  - `test/complex-html-testing`: React 19.2 + Vite 7 SPA test lab (`http://127.0.0.1:4173`, entry: `node test/complex-html-testing/serve.mjs`).

---

## 3. Gauntlet Benchmark: 12 Protocols (79/79 Assertions Passed)

| Protocol | Assertions | Status | Implementation & Physical CDP Vector |
| :--- | :---: | :---: | :--- |
| **P01 CLICK VECTOR** | 8/8 | **PASS** | Physical hover chain piercing 0ms `:hover` boundaries, right-click context primitives, sub-pixel moving target tracking. |
| **P02 SHADOW REALM** | 7/7 | **PASS** | Recursive open/closed Shadow DOM traversal, multi-layer iframe hierarchy synthesis and click routing. |
| **P03 FORM HYDRA** | 10/10 | **PASS** | React 18/19 controlled component value commitment, hover-revealed 30s TOTP tokens, scroll-to-activate terms checkboxes, continuous canvas drawing, HTML5 drag-and-drop. |
| **P04 TEMPORAL GATE** | 6/6 | **PASS** | 5s countdown lock handling, transient toast interception, native alert/confirm/prompt dialog automation. |
| **P05 SCROLL ABYSS** | 6/6 | **PASS** | Nested scroll container resolution, sticky overlay avoidance, infinite list incremental loading to #048, sentinel 1.5s lazy-load triggers. |
| **P06 KEYBIND MATRIX** | 6/6 | **PASS** | CDP modifier key combos (`Ctrl+K` command palettes), keyboard focus navigation, cross-field clipboard paste, CJK input validation. |
| **P07 DRAG VECTOR** | 6/6 | **PASS** | HTML5 drag-and-drop reordering (A→Z double reorder), pointer drag-to-target, slider precision placement to 50, resize handle stretching. |
| **P08 DIALOG STACK** | 5/5 | **PASS** | High z-index privacy wall filtering, multi-level portal modal stacks, focus trap Tab loop submission, phrase confirmation locks. |
| **P09 PERCEPTION TRAP** | 7/7 | **PASS** | Visual vehicle classification, 0.02 opacity ghost button detection, pseudo-element decoy evasion, oscillating canvas pulse tracking, SVG path coordinate targeting. |
| **P10 PERSISTENCE** | 5/5 | **PASS** | Browser history backward/forward navigation, checkpoint state stabilization, browser refresh (F5) with session recovery. |
| **P11 DATA GRID** | 5/5 | **PASS** | 200-row virtual list filtering, double-click inline cell editing, custom right-click context menus, table header sorting. |
| **P12 OMEGA SEQUENCE** | 8/8 | **PASS** | Comprehensive end-to-end sequence: Privacy wall removal → TOTP hover submit → Closed Root piercing → 100% Slider → Native Prompt → Dynamic canvas pulse 3-click → Dropdown selection → `Ctrl+Enter` commit. |

---

## 4. Key Architectural Mechanisms

1. **Smart Container-Aware Scrolling (`smart-scroll.ts`)**:
   - Automatically inspects the DOM hierarchy using `document.elementFromPoint(x, y)` to locate scrollable parent containers (`overflow: auto|scroll`) when window-level scrolling cannot consume the delta.
2. **CDP Session Domain Tracking (`cdp-session-manager.ts`)**:
   - Manages domain-level reference counting (`enableDomain` / `disableDomain`) across attached debugging sessions to prevent unexpected detachment and deadlocks.
3. **Pure DOM Pruning & Fast Snapshot (`dom-indexer.ts`)**:
   - Generates compact, 1-based numeric indexed trees with `window.__pawFast` caching, filtering invisible/occluded elements and reducing token payloads by $>85\%$.
4. **Autonomous Semantic Micro-Loop (`chrome_act_toward_goal`)**:
   - Executes local perception-action loops within the native server with 3-tier mode switching (`off`, `local`, `remote`), eliminating MCP round-trip latency on single-page tasks.

---

## 5. Verification Quality Gates

```powershell
# 1. Global TypeScript typecheck across all monorepo packages (0 errors)
pnpm typecheck

# 2. Chrome Extension Vitest Suite (547/547 tests pass)
pnpm --filter chrome-mcp-server test

# 3. Native Server Jest Suite (124/124 tests pass)
pnpm --filter mcp-chrome-bridge test

# 4. End-to-End Modernization Suite (153/153 tests pass)
pnpm test
```

---

## 6. Build & Operational Commands

### 6.1 Compile Extension & Sync to Standalone Folders

```powershell
# 1. Build Chrome extension and auto-sync dist outputs
pnpm --filter chrome-mcp-server build && node scripts/sync-extension-dist.mjs

# 2. Trigger extension reload (if testing live)
node test/manual/reload-extension.mjs
```

### 6.2 Launch Complex HTML Test Lab

```powershell
node test/complex-html-testing/serve.mjs
```
