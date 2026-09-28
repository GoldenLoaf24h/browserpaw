# 📦 GitHub Release: BrowserPaw v3.2.7

- **Tag:** `v3.2.7`
- **Title:** `BrowserPaw v3.2.7: Chained Snapshot Feedback, Stacking Occlusion Pruning & Zero-Conflict Third-Party Coexistence`
- **Target:** `main`

---

## 🚀 Overview

BrowserPaw **v3.2.7** is a major feature and reliability release that introduces **chained incremental snapshots** (slashing redundant DOM inspection round-trips), **stacking & modal occlusion pruning** (eliminating phantom clicks through dialog backdrops), **zero-conflict third-party download coexistence** (IDM, Aria2, FDM), and **hardened Native Messaging UTF-8 protocol slicing**.

---

## 🪲 What's Changed

### 1. ⚡ Chained Incremental Snapshot (`interact-index.ts`, `fill-index.ts`, `delta-helper.ts`)

- **Single-Turn Perception & Action Fusion**: `chrome_interact_index` and `chrome_fill_index` now capture and return a lightweight `chainedSnapshot` payload by default.
- **Immediate State Feedback**: Automatically surfaces current `activeElement` (tag, ID, role, input value), URL transition status (`urlChanged`), modal detection flags, and up to 10 prioritized DOM changes.
- **50% Turn Reduction**: Eliminates the mandatory secondary `chrome_read_dom` call previously required after every interaction. Supports `includeDelta: false` for backward compatibility.

### 2. 🛡️ Stacking Context & Modal Occlusion Pruning (`dom-indexer.ts`)

- **Viewport Boundary Clipping Fix**: Fixed geometric bug where elements partially intersecting the viewport boundary escaped occlusion checks, restoring precise 9-point sub-pixel grid verification.
- **Dialog & Backdrop Occlusion Filtering**: Recognizes pointer-blocking overlays, semi-transparent masks (opacity ≥ 0.35), and modal dialogs (`[role="dialog"]`, `[aria-modal="true"]`, `.modal-backdrop`), pruning occluded background elements and preventing accidental click-throughs.

### 3. ⚡ Zero-Conflict Download Pipeline & IDM Coexistence

- **Eradicated Global Listener**: Completely removed `chrome.downloads.onDeterminingFilename` and internal filename registry.
- **Third-Party Manager Coexistence**: Eliminates filename determination collisions with external download managers (IDM, Aria2, Free Download Manager).
- **Zero Disk Pollution**: Visual media inspections operate strictly in-memory; download tracking runs non-invasively via `onCreated` and `onChanged` observers.

### 4. 🛡️ Native Tab Signature Validation & Red Error Badge Elimination (`chrome_switch_tab`)

- **Integer Sanitation & Probing**: Sanitizes tab ID parameters and verifies target existence before dispatching Chromium tab switch commands.
- **Console Warning Demotion**: Prevents fatal C++ binding exceptions (`No matching signature`) from triggering red "Error" badges in `chrome://extensions`.

### 5. 🔌 Protocol Hardening & Native Messaging UTF-8 Slicing

- **Safe Byte Slicing (`safe-post-message.ts`)**: Implemented `TextEncoder` UTF-8 byte boundary slicing (850 KB/slice) with surrogate pair protection, preventing Chrome's 1 MB physical message limit from crashing the host pipe.
- **Host Outbound Stream Transparency (`native-messaging-host.ts`)**: Removed premature 1 MB hard-rejection; large payloads stream transparently through chunking with `EPIPE` error guards.
- **Keepalive Ref-Counting (`keepalive-manager.ts`)**: Upgraded to `Map<string, number>` reference counting to eliminate premature Service Worker suspension.

### 6. ⚖️ Legal & Governance Compliance

- **AGPL-3.0 SPDX Standardization**: Upgraded all `package.json` license fields to standard `"AGPL-3.0-or-later"` and aligned root `LICENSE` for automated GitHub `licensee` detection.
- **Upstream Attribution (`NOTICE`)**: Added dedicated `NOTICE` preserving upstream MIT copyright for `mcp-chrome` (hangye).

---

## 📦 Release Assets & Checksums

| Asset                                                                                                                                       | Size   | SHA256 Checksum                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| [**browserpaw-extension-v3.2.7.zip**](https://github.com/GoldenLoaf24h/browserpaw/releases/download/v3.2.7/browserpaw-extension-v3.2.7.zip) | 611 KB | `f7a83f4e8c848db4da4a10e92a350bba5b52bd9c9ca1b350086404e04b94c44b` |
| [**browserpaw-skill-v3.2.7.zip**](https://github.com/GoldenLoaf24h/browserpaw/releases/download/v3.2.7/browserpaw-skill-v3.2.7.zip)         | 36 KB  | `1a0d4e1c6fc4759a880184978a2beb2741afc10cc0828c9af18a7dd91c62cd1c` |
