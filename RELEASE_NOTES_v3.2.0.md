# 📦 GitHub Release: BrowserPaw v3.2.0

> **重要更名通知 / Notice**: **BrowserClaw 正式改名为 BrowserPaw** (BrowserClaw has officially been renamed to **BrowserPaw**). All tool names, schemas, skills, and documentation are now unified under the BrowserPaw namespace with backward-compatible aliases preserved.

- **Tag:** `v3.2.0`
- **Title:** `BrowserPaw v3.2.0: Physics Kinetic Cursor, Momentum Scrolling & Lockstep Lifecycle Binding`
- **Target:** `main`

---

## 🚀 Overview

BrowserPaw **v3.2.0** delivers a major upgrade focused on **physics-based kinetic animations**, **zero-teleportation virtual cursor continuity**, **lockstep execution synchronization**, **hardware-adaptive autonomous intelligence (Dual-Brain Jev Engine)**, and **leak-free tab group lifecycle management**.

Key highlights of this release:
1. Eliminates cursor snapping and integer scroll drift with fluid spring kinematics and momentum scrolling.
2. Introduces a dynamic typewriter action tooltip with accent caret and viewport collision flipping.
3. Upgrades auto-mode human takeover to track true user interactions (including trackpad/wheel scrolls) without intrusive interference.
4. Firmly locks the execution lifecycle between visual perception, CDP hardware events, and MCP tool responses.
5. Embeds a hardware-adaptive, resident local Jev Decider engine with CUDA/MPS acceleration and CPU fallback.
6. Eliminates tab group residue and fixes Combobox text input handling across rich web apps.

All **842 automated monorepo tests** (561 Vitest, 128 Jest, 153 E2E) pass with 100% compliance, zero TypeScript compilation errors, and zero ESLint warnings.

---

## 🌟 Key Highlights & Major Additions

### 1. 🎯 Zero-Teleportation Cursor Physics
- **Cross-Domain Navigation Coordinate Relay**: Virtual cursor positions are tracked globally across origin boundaries by the background service worker (`lastTabCursorPositions`). When navigating across domains, the destination content script seamlessly picks up `fromX` and `fromY`, gliding in smoothly rather than snapping.
- **Dynamic Pre-Click Glide**: When click actions are dispatched while the cursor is still in motion, the engine glides smoothly to target coordinates before releasing the ripple.
- **Visual Continuity on Movement**: All movements strictly execute natural bezier arc trajectories instead of instant frame-jumping.

### 2. 🪄 Action Tooltip & Typewriter Animation
- **Refined Capsule Aesthetics**: Aligned with modern system UI standards—dark charcoal rounded rectangle (`rgba(24, 24, 27, 0.94)`) with drop shadow.
- **Dynamic Typewriter Reveal**: Action notes (e.g. `--note "Scrolling down timeline"`) render character-by-character at ~20ms/char with a blinking accent cursor (`.codex-agent-caret`).
- **Collision-Aware Flipping**: Centered below pointer tip; automatically flips above cursor when approaching the bottom viewport boundary.

### 3. 🌊 Momentum Scrolling & Delta Precision (`chrome_smart_scroll`)
- **Momentum Deceleration Curve**: Replaced rigid fixed steps with an adaptive 10–14 step decelerating curve spanning 180–260ms.
- **Zero Rounding Drift**: Replaced lossy integer rounding with continuous floating-point accumulation, guaranteeing exact pixel travel matching the requested delta.

### 4. 🧠 Intelligent Auto-Mode Human Takeover
- **Sensory Perception**: Detects authentic user interactions (`e.isTrusted`) across `mousemove` (with >18px filtering), `mousedown`, `keydown`, and `wheel` trackpad/mouse scroll events.
- **Graceful Deferral**: Automatically yields to human activity, deferring agent actions by 80ms to avoid intrusive cursor interference.

### 5. 🔒 Lockstep Lifecycle Synchronization (Animation <-> Action <-> Response)
- **Multi-Click Lockstep**: Double and triple clicks bind individual CDP `mousePressed` events to distinct visual click ripples with natural press duration.
- **Concentric Multi-Ripple Cloning**: Dynamically spawns independent ripple DOM instances (`cloneNode(true)`) with individual lifecycles.
- **Arrival Guard**: Unified arrival timeout ensuring CDP events never fire before visual cursor arrival.

### 6. ⚡ Hardware-Adaptive Resident Local Jev Engine
- **Daemon Lifecycle**: In local mode, BrowserPaw native server manages and health-checks the local decider daemon.
- **Hardware Acceleration with Fallback**: Automatically detects and leverages dedicated GPU acceleration (CUDA on Windows/Linux, MPS on macOS) while cleanly falling back to CPU when no discrete accelerator is available.
- **Idle Offload Watchdog**: Automatic 10-minute idle watchdog unloads models to release system memory and VRAM when inactive.

---

## 🪲 Bug Fixes & Architectural Hardening

- **Fastify Local Token Authentication Guard**: Hardened `server/index.ts` preHandler hook to reject unauthorized header bypasses, ensuring all tool calls require valid Bridge Token authentication.
- **Searchbox Combobox Input Fix**: Resolved issue in `fill-core.ts` where search inputs with `role="combobox"` were erroneously handled as select widgets; standard text typing is now guaranteed.
- **Cursor State Continuity**: Fixed cursor snapping caused by premature position deletion during tab navigation loading states.
- **DOM Selector Escaping**: Applied `CSS.escape` to element index selectors in `action-watchdog.ts` to prevent syntax crashes on complex node attributes.
- **In-Page Engine Slot Isolation**: Eliminated concurrent slot eviction race conditions in single-turn in-page executions.
- **Media Asset Garbage Collection**: Attached periodic unref'd timer to `mediaAssetStore` to prevent long-running buffer accumulation.

---

## 🧪 Verification Matrix

| Test Suite | Framework | Target / Scope | Result |
| :--- | :---: | :--- | :---: |
| **Extension Unit & Integration** | Vitest | 57 files, DOM indexer, form pipeline, agent cursor | **561/561 PASS (100%)** |
| **Native Bridge & Jev Engine** | Jest | 7 suites, Stdio/HTTP dispatch, Jev model manager | **128/128 PASS (100%)** |
| **E2E Modernization Suite** | Node Test Runner | 4 tiers (Feature coverage, boundaries, workflows) | **153/153 PASS (100%)** |
| **TypeScript Typecheck** | `tsc --noEmit` | Full Monorepo workspace packages | **0 Errors (PASS)** |
| **ESLint Compliance** | ESLint 9 | Monorepo root, shared packages, extension | **0 Errors (PASS)** |
| **Total Automated Tests** | — | — | **842 / 842 PASS (100%)** |

---

## 📦 What's Changed (Commit Log)

- `feat(core)`: rename BrowserClaw to BrowserPaw across codebase and monorepo
- `feat(cursor)`: zero-teleportation cross-navigation coordinate relay and glide-on-click mechanics
- `feat(cursor)`: dynamic typewriter action tooltip with accent caret and dynamic viewport flip
- `feat(scroll)`: 10–14 step momentum deceleration with zero rounding drift
- `feat(cursor)`: upgraded auto mode with wheel event takeover and graceful yielding
- `feat(sync)`: lockstep lifecycle synchronization across animations, CDP events, and MCP responses
- `feat(jev)`: resident local Jev Decider daemon with hardware auto-detection and idle memory release
- `fix(fill)`: resolve searchbox combobox false-positive widget interception in `fill-core.ts`
- `fix(auth)`: harden Fastify local loopback authentication against header-only bypass
- `fix(watchdog)`: add CSS.escape to element selectors and initial settle grace period
- `release`: bump all monorepo package versions to v3.2.0

---

## 🚀 Quick Installation (Zero-Compile, Ready-to-Use)

### 1. Chrome Extension Installation (Direct Download)
1. Download **`browserpaw-extension-v3.2.0.zip`** from the **Assets** section below.
2. Unzip the downloaded file to a local directory (e.g. `C:\\browserpaw-extension` or `~/browserpaw-extension`).
3. Open Google Chrome (or Edge/Brave/Chromium), navigate to `chrome://extensions/`.
4. Turn on the **Developer mode** toggle in the top-right corner.
5. Click **Load unpacked** (加载已解压的扩展程序) in the top-left toolbar, and select the unzipped directory containing `manifest.json`.
   *(If updating from an existing installation, simply replace the folder contents and click the Reload button on the extension card)*.

### 2. Connect Your AI Agent / MCP Client
Add BrowserPaw to your MCP client configuration (Claude Desktop, Cursor, Windsurf, Codex, etc.):

**Streamable HTTP (Recommended)**:
```json
{
  "mcpServers": {
    "browserpaw": {
      "url": "http://127.0.0.1:12306/mcp"
    }
  }
}
```

Whenever Google Chrome is open with the BrowserPaw extension enabled, the MCP server on port 12306 will be available automatically.

---

### 🛠️ Developer Source Build (Optional)
If building directly from Git source:
```bash
pnpm install
pnpm build
```
