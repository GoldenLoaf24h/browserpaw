# BrowserPaw Chrome Extension (MV3) 🧩

This package contains the Google Chrome Manifest V3 extension for **BrowserPaw** (`chrome-mcp-server`), built with [WXT](https://wxt.dev/) and Vue 3. It runs directly inside the user's everyday Chrome browser, executing automation commands via the Chrome DevTools Protocol (CDP) and isolated-world content scripts.

---

## 🏗️ Architecture & Core Components

```
app/chrome-extension/
├── entrypoints/
│   ├── background/             # MV3 Service Worker & 48 Tool Executors
│   │   ├── native-host.ts      # Native Messaging pipe listener & sender authentication guard
│   │   ├── index.ts            # Extension initialization, keepalive, and error reporting
│   │   └── tools/browser/      # Executors for all 48 BrowserPaw extension tools (49 total with Native loop)
│   ├── agent-cursor.content.ts # Closed Shadow DOM virtual mouse overlay with spring physics
│   ├── inpage-engine.ts        # Isolated-world DOM indexing, 1-based indexing, WeakRef mapping
│   └── popup/                  # Extension popup UI (agent toggle and connection monitor)
├── utils/
│   ├── cdp-session-manager.ts  # CDP session pooling, domain ref-counting & anti-hang detachment
│   ├── session-tab-affinity.ts # Multi-turn tab binding backed by chrome.storage.session
│   ├── tab-group-manager.ts    # Agent tab grouping and orphan cleanup backed by storage.session
│   ├── tab-favicon.ts          # Agent glowing favicon state backed by storage.session
│   ├── screenshot-ring-buffer.ts # In-memory bounded ring buffer (cap: 1) for zero-disk screenshots
│   └── action-watchdog.ts      # MutationObserver & network in-flight settle detectors
└── tests/                      # 44 Vitest test suites (336 tests, 100% pass)
```

---

## 🛡️ Security & Lifecycle Hardening Guarantees

1. **Strict Sender Authentication**:
   `chrome.runtime.onMessage` in `native-host.ts` verifies `_sender.id === chrome.runtime.id` and immediately rejects any message with `_sender.tab`. Content scripts in untrusted web pages cannot invoke background tools or read security tokens.

2. **DOM XSS Defense**:
   All dynamic UI overlays (`agent-cursor.content.ts`, human intervention banner) use safe DOM creation APIs (`document.createElement`, `document.createTextNode`, `textContent`) within a closed Shadow DOM, completely eliminating `innerHTML` injection vulnerabilities.

3. **Cross-Frame Message & Index Isolation**:
   In-page indexing scripts execute in isolated worlds. Subframes are queried using `frameIds: [targetFrameId]` with index remapping (`inPageReindexFrame`), preventing element index collisions and WeakRef map pollution across frames.

4. **CDP Domain-Level Reference Counting**:
   `CDPSessionManager` tracks domain enablement references (`enableDomain` / `disableDomain`). Core domains (`Page`, `Network`) remain permanently enabled while the session is active, preventing background dialog and settle monitors from breaking.

5. **Anti-Hang Force Detachment**:
   `detach(tabId, 'timeout-guard')` and `detachDebugger(tabId)` forcefully detach the physical debugger (`chrome.debugger.detach`) and clean up sessions and domain reference counts, preventing debugger deadlocks on hung pages.

6. **MV3 Session Storage Persistence**:
   `SessionTabAffinityManager`, `TabGroupManager`, and `TabFaviconManager` synchronize their state with `chrome.storage.session`. When Chrome terminates the background service worker after 30 seconds of inactivity, states are rehydrated on wakeup.

7. **Zero-Leak Offscreen Background Capture**:
   Screenshots of inactive tabs (`active: false`) strictly use CDP `Page.captureScreenshot(fromSurface: true)`. Chrome's `captureVisibleTab` is never used for background tabs, preventing visual leaks of the user's active window and eliminating `requestAnimationFrame` freezes.

8. **Active Tab Close Protection**:
   `chrome_close_tabs` requires explicit `confirm: true` or session tab affinity (`sessionId`) when closing tabs without explicit `tabIds` or `url`, preventing accidental closure of the user's active window.

---

## 🚀 Building & Loading

### Development

```bash
# Start development watcher
pnpm --filter chrome-mcp-server dev
```

### Production Build

```bash
# Build production bundle
pnpm --filter chrome-mcp-server build
```

The output bundle is generated at:

```
app/chrome-extension/.output/chrome-mv3
```

### Loading in Chrome

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `app/chrome-extension/.output/chrome-mv3` folder.

---

## 🧪 Testing

The extension test suite runs via Vitest with mocked Chrome MV3 and CDP environments:

```bash
pnpm --filter chrome-mcp-server test
```

- **Test Files**: 26 passed (100%)
- **Test Count**: 139 passed (100%)
