# BrowserPaw v3.1.0 Release Notes

**Release Date:** September 23, 2026  
**Tag:** `v3.1.0`

---

## 🚀 Overview

BrowserPaw **v3.1.0** represents a major architectural milestone. This release synthesizes the best design principles and engineering patterns from leading browser automation projects (`jev-ultrafast`, `browser-use`, `browser-harness`), implements full Deep Shadow DOM piercing, introduces client-side virtual DOM scroll resolution, hardens input commitment and anti-timeout protocols, expands the tool catalog to **50 canonical tools**, and brings the complete **Hermes 49-Tool Canonical Display & Rich Previews** specification.

---

## 🌟 Key Highlights & Major Additions

### 1. 🎴 Hermes 49-Tool Canonical Display & Rich Card Previews

- **Unified Tool Display Specs (`BROWSERPAW_SPECS`)**: Injected native emoji icons, human-friendly action verbs, and concise input summaries across all canonical tools in `plugins/browserpaw/__init__.py`.
- **Intelligent Rich Previews**: Specialized extractors for interactive DOM trees, keyword grep results, element interactions, screenshot previews, Jev fast-decision loops, and CDP execution.
- **Cross-Platform Parity**: Identical visual structure rendered in Hermes native card widgets and standard MCP web/chat surfaces.

### 2. 🔮 Deep Shadow DOM Piercing & Visual Drift Compensation

- **Closed & Nested Shadow DOM Piercing**: Non-invasive shadow boundary traversal using `chrome.dom.openOrClosedShadowRoot` (dom-indexer), eliminating invasive main-world monkey-patching while giving agents 100% visibility into custom elements, web components, and nested shadow trees.
- **Sub-Pixel Coordinate Calibration**: Automatic viewport scale, device pixel ratio (DPR), and zoom level compensation for visual click and coordinate-based fallback execution.

### 3. 🛡️ Architectural Resilience & Anti-Timeout Protocol (Batches B1–B12)

- **B1. Strict URL Scheme Sanitizer (`url-sanitizer.ts`)**: Rejection of hazardous protocols (`javascript:`, `file:`, `chrome:`) with URL parameter sanitization preventing credential leakage.
- **B2. Correlated Action Network Capture (`action-network-capture.ts`)**: Correlation IDs linking network requests and responses directly to the user/agent action that triggered them.
- **B3. Isolated PostMessage Protocol (`safe-post-message.ts`)**: Cryptographic session tokens and origin-validated communication channels between content scripts and in-page engines.
- **B4. Tab Cleanup Session Affinity (`chrome_close_tabs`)**: Graceful teardown of agent-spawned background tabs without risking closure of user foreground tabs.
- **B5. Fast DOM Snapshot Engine (`fast-snapshot.ts`)**: Lightweight, sub-15ms initial orientation snapshots bypassing heavyweight tree serialization.
- **B6. Smart Scroll-Until-Found (`chrome_scroll_until_found`)**: 50th canonical tool utilizing client-side `requestAnimationFrame` scrolling to locate virtualized DOM items, dynamic feeds, and lazy-loaded components before indexing.
- **B7. Operation Watchdog System (`watchdogs/`)**: Independent observers tracking dialog popups, downloads, and extension health to abort hung CDP or JS evaluations cleanly.
- **B8. In-Page Event Loop & Microtask Draining (`in-page-engine.ts`)**: Enforces DOM and layout settlement after typing and clicking.
- **B9. Unified Element Locator (`unified-locator.ts`)**: Hierarchical element targeting falling back gracefully between CSS selectors, XPath expressions, text patterns, and spatial coordinates.
- **B10. Native Messaging Chunking Protocol (`native-messaging-host.ts`)**: Streamed multi-chunk protocol supporting payloads exceeding 1MB across Chrome Native Messaging boundaries.
- **B11. Jev Fast Decision Engine Refinements (`fast-decision-engine.ts`)**: Tuned confidence thresholds, heuristics, and fallback policies for on-page semantic micro-loops.
- **B12. Multi-Tab Session Snapshot Invalidation (`snapshot-cache-manager.ts`)**: Automatic cache invalidation on page mutations and navigation events ensuring DOM cache coherency.

### 4. 🪲 Core Defect Fixes & Precision Guards

- **Anti-Deadlock Inline Auto-Submit**: Configured `skipLock: true` when `chrome_fill_index` auto-submits a detected submit button, preventing concurrent lock contention.
- **Destructive Guard Precision (`extractTargetVisibleText`)**: Keyword inspection runs against the element's human-visible label/text only—stripping technical attributes (`id`, `class`, `href`) to prevent false positives (e.g. Reddit flair button `#reddit-post-flair-button` no longer falsely triggers destructive `post` keyword).
- **Navigation Race Resolution**: `findTab` now resolves `tab.pendingUrl` during in-flight navigations.
- **Baseline Pre-Interaction Snapshots**: Captures pre-interaction DOM state prior to mutation to ensure exact delta calculation.

### 5. 📚 Skill Architecture & Documentation Modernization

- **Progressive Disclosure Architecture**: Re-architected `SKILL.md` for high information density (~1,800 tokens) with zero fluff, complemented by deep modular references:
  - `tool-cheatsheet.md`: Comprehensive 50-tool parameter and contract guide.
  - `dual-brain-jev.md`: Jev micro-loop mechanics, escalation thresholds, and safety breakpoints.
  - `batch-pipeline.md`: Atomic multi-action sequences, assertions, and inline network capture.
  - `visual-fallback.md`: Coordinate clicking, grid calibration, and vision fallbacks.
- **Automated Synchronization**: Guaranteed byte-for-byte synchronization across all 6 skill mirrors via `scripts/sync-skills.mjs`.

---

## 🧪 Verification & Test Metrics

- **Unit Tests (`chrome-mcp-server`)**: 56 test files, 537/537 tests passed (100%).
- **Bridge Tests (`mcp-chrome-bridge`)**: 6 test suites, 102/102 tests passed (100%).
- **E2E Modern Test Runner**: 4 tiers (F01–F13, boundary cases, pairwise, real-world workflows), 153/153 tests passed (100%).
- **Python Plugin Tests (`plugins/browserpaw`)**: 20/20 tests passed (100%).
- **TypeScript Typecheck (`pnpm typecheck`)**: 0 errors across all workspace packages.
- **BrowserPaw Doctor Diagnostics**: 7/7 checks passed (Node environment, bridge token, bridge server, MCP initialization, extension build, standalone sync, native host registration).

---

## 📦 Release Assets

- `browserpaw-extension-v3.1.0.zip`: Pre-built Chrome Extension (Manifest V3) ready for developer-mode unpacking or distribution.
- `browserpaw-skill-v3.1.0.zip`: Standalone AI Agent skill package with full progressive disclosure references.
