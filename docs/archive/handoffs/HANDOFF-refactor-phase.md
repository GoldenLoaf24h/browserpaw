# BrowserPaw Architectural Modernization & Refactor Handoff

> **Chinese Version**: [HANDOFF-refactor-phase.zh-CN.md](./HANDOFF-refactor-phase.zh-CN.md)
> **Status**: Completed, Sealed, and Verified Across All Tiers

## 1. Background & Technical Evolution

BrowserPaw is an industrial-grade modernization and architectural refactoring of the open-source `mcp-chrome` ecosystem. The legacy extension used simple content script injections for browser interactions, which suffered from severe reliability failures, race conditions, token exhaustion, and lack of fidelity on modern single-page applications (SPAs), cross-origin iframes, and Shadow DOM components.

This architectural phase combines the best design patterns of **`browser-use`** (high-compression DOM tree pruning with 1-based monotonic numeric indexing) and **`Midscene.js`** (visual coordinate grids, localized ROI viewport expansion, and native CDP file chooser interception), while hardening security, session isolation, and IPC boundaries:

```text
┌────────────────────────────────────────────────────────┐
│                      AI Agent                          │
│         (Claude Code / Cursor / Windsurf / etc.)        │
└──────────────────────────┬─────────────────────────────┘
                           │ JSON-RPC (HTTP / SSE / stdio)
                           ▼
┌────────────────────────────────────────────────────────┐
│              Fastify Native Bridge (12306)             │
│  - Per-Session Server Isolation (No cross-talk)        │
│  - Bearer Token Authentication (Blocks unauthorized)   │
│  - TOCTOU DNS Rebinding Protection                     │
└──────────────────────────┬─────────────────────────────┘
                           │ Chrome Native Messaging
                           │ (Bidirectional 1000KB buffer cap)
                           ▼
┌────────────────────────────────────────────────────────┐
│               Chrome MV3 Extension (Background)        │
│  - SessionTabAffinityManager (Tab-session affinity)    │
│  - CDPSessionManager (Auto-reconnect & domain refcount)│
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
      [Primary: DOM-First (90%)]   [Fallback: Visual Grid (10%)]
               │                          │
               ▼                          ▼
┌─────────────────────────┐┌─────────────────────────────┐
│  DOM Pruning & Indexing ││  chrome_screenshot Visual   │
│  - Pure in-memory WeakRef││  - Dynamic coordinate grid │
│  - Zero DOM attribute leak││  - ROI zoomed crop inspection│
│  - Multi-frame & Shadow ││  - Pixel coordinate mapping │
│  - Token compression >85%││  - Drift-free normalization │
└──────────────┬──────────┘└──────────────┬──────────────┘
               │                          │
               └────────────┬─────────────┘
                            ▼
┌────────────────────────────────────────────────────────┐
│                   CDP Native Hardware Execution        │
│  - Input.dispatchMouseEvent (isTrusted: true clicks)   │
│  - Input.dispatchKeyEvent (OS-level key events)        │
│  - Input.insertText (Physical input for React/Vue)     │
│  - Page.setInterceptFileChooserDialog (File uploads)   │
│  - Action Settle Watchdog (Network + 50ms settle)      │
└────────────────────────────────────────────────────────┘
```

---

## 2. Core Architecture & Technical Highlights

### 2.1 Dual-Engine Perception & Execution (DOM-First + Visual Fallback)

1. **DOM-First Path (`chrome_read_dom` + `chrome_interact_index` / `chrome_fill_index` / `chrome_batch_actions`)**:
   - **Pure In-Memory Index Tree**: Nodes are tracked in memory without mutating the page DOM with custom attributes, avoiding detection and anti-scraping traps.
   - **Shadow DOM & Cross-Origin Iframes**: Traverses open and closed shadow roots and nested iframes with automatic coordinate space remapping.
   - **Controlled Inputs**: Bypasses React 16–19 and Vue 3 input masking via prototype property descriptors followed by synthetic event firing.

2. **Visual Fallback Path (`chrome_screenshot` + `chrome_computer`)**:
   - **DPR 1:1 Normalization**: Resamples screenshot buffers using `OffscreenCanvas` to match CSS viewport dimensions, eliminating visual coordinate drift on Windows high-DPI scaling (125%, 150%, 200%).
   - **Coordinate Resolution**: Universal multimodal coordinate support (normalized 0–1.0, per-mille 0–1000, pixel coordinates) with 24px snap-to-edge centering.

### 2.2 IPC & Native Messaging Hardening

- **1000KB Native Messaging Buffer Cap**: Automatically fragments payloads larger than 800KB into multi-part chunks with sliding-window reassembly, preventing native messaging stream crashes.
- **Process Memory Guard**: Implements LRU capacity limits on chunk buffers to eliminate memory leaks during long-running sessions.

### 2.3 Verification & Quality Assurance

- All test suites run locally without external service dependencies.
- Monorepo packages pass strict linting, typechecking, unit tests, and end-to-end integration matrices.
