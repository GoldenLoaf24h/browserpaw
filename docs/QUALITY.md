# BrowserPaw Engineering Quality & Verification Contract 🛡️

This document defines the single canonical acceptance contract for BrowserPaw development, quality verification, and artifact delivery. All contributors, automated pipelines, and AI agents must comply with these verifiable gates before claiming any feature, fix, or release as complete.

Prerequisites: Node.js ≥ 22.6, the pinned pnpm version from `package.json`, and Python with pytest installed or `uv` to prepare an isolated pytest environment. An explicit `PYTHON` environment variable selects an interpreter that must already provide pytest. Test failures are never retried using a different interpreter.

---

## 🎯 Verification Command Interface

The verification interface is standardized across the monorepo:

```bash
# 1. Full static & unit quality audit, full build & artifact check
pnpm verify

# 2. Build and stage extension artifacts for deployment
# (pnpm build && extension-artifacts --deploy)
pnpm build:deploy

# 3. Delivery verification: artifact integrity, source fingerprint & target hash parity
# (extension-artifacts --check-deployment)
pnpm verify:delivery
```

---

## 📋 Gate Specifications

### 1. `pnpm verify` — Full Static Quality & Build Check

Executes the complete verification and production build suite across the root `browserpaw` package and the `chrome-mcp-server`, `mcp-chrome-bridge`, and `chrome-mcp-shared` workspaces:

- **Node Script Syntax & Operations**: Linting via `eslint scripts bin --max-warnings=0` plus monorepo workspace linting.
- **Type Checking**: Strict type checking via `tsc` (for `packages/shared` and `app/native-server`) and `vue-tsc` (for `app/chrome-extension`).
- **Unit & Integration Suites**:
  - The full `app/chrome-extension/tests/**/*.test.ts` Vitest suite, including shared schema contracts. The reported file set must match the discovered file set exactly.
  - Native Jest tests for `app/native-server` messaging protocol framing.
  - Simulated E2E tests for CDP event dispatch and fallback ladders.
  - Platform plugin connector tests via pytest.
  - **Skip Policy**: The sole permissible skip is the optional Hermes host environment when unconfigured locally. Any other suite skip or warning is a fail-closed error.
- **Documentation Verification**: `node scripts/validate-docs.mjs` passes with zero broken active links, canonical docs index coverage, valid encoding (no literal newline escapes or illegal control characters), and tag release parity against full git history (CI uses `fetch-depth: 0`).
- **Build & Artifact Integrity**: Production builds of all workspaces, followed by extension manifest, source fingerprint, and full output-file hash checks.

### 2. `pnpm build:deploy` — Build & Deployment Synchronization

Builds the project and copies the extension bundle into the configured unpacked extension directory:

- Formula: `pnpm build && extension-artifacts --deploy`.
- Reads destination from local configuration (`browserpaw.local.json` `extensionSyncDir` or environment variable `BROWSERPAW_EXTENSION_SYNC_DIR`).
- **Configuration Contract**: Standard `pnpm build` skips deployment synchronization by default. When `pnpm build:deploy` or `extension-artifacts --deploy` is explicitly invoked without a configured target directory, the deployment step **fails (exit 1)** rather than silently succeeding.
- Every deployment operation records the source fingerprint and target manifest hash for auditability.

### 3. `pnpm verify:delivery` — Deployment Evidence & Hash Parity

Validates deployed artifact integrity against the build source:

- Formula: `extension-artifacts --check-deployment`.
- Performs complete acceptance checks verifying source fingerprint, bundle integrity, and source-to-target hash parity.
- Confirms that staged files match the fresh build output exactly.

---

## ⚠️ Runtime Evidence vs. Disk State

**Critical Principle**: Staged or copied files on disk do **not** mean Chrome is executing the updated code.

1. **Reload Acceptance**: Reload the production extension manually for acceptance. Development hot reload alone does not prove which background worker or content scripts are running.
2. **Runtime Verification Protocol**:
   - Step 1: Run `pnpm build:deploy` to sync fresh artifacts to the profile directory.
   - Step 2: Manually reload the unpacked extension in `chrome://extensions`.
   - Step 3: Run `chrome_doctor` with verbose output to retrieve the active in-memory `buildId`.
   - Step 4: Compare the doctor runtime `buildId` with the build artifact's `buildId`.
3. **Prohibited Claims**:
   - Never claim a fix or feature is live solely because `pnpm build`, `build:deploy`, or disk-file updates succeeded.
   - Hot-reload must never be claimed as acceptance evidence. Only the manual reload + matching doctor `buildId` constitutes valid runtime proof.

---

## 📊 Verification Evidence & Artifact Standards

- **Artifacts Location**: Diagnostic dumps, execution logs, and delivery reports are generated under `.artifacts/verification/...`.
- **Ephemeral Status**: Files in `.artifacts/` are generated verification outputs, **not canonical source documentation**. They must never be indexed as active documentation entries in `docs/README.md`.
- **Evaluation Criteria**: Verification criteria use unified quality invariants (such as 100% test pass rate, 0 broken active links, source/target hash parity) rather than hardcoded transient metrics.
- **Classification of Assertions**:
  - **Mock / Simulated**: Verifies isolated component logic, deterministic edge cases, and protocol codecs without external dependencies.
  - **Live / Integration**: Asserts real Chrome CDP connectivity, native messaging IPC pipes, and authentic memory states.

---

## 🚫 Negative Behaviors (Strictly Prohibited)

1. **Never substitute disk presence for runtime verification**: Files on disk are never proof of live Chrome in-memory execution.
2. **Never claim delivery without explicit deployment check**: `verify:delivery` must pass.
3. **Never break doc links or version records**: Active documentation links must resolve to real files, and package version numbers must align with release documentation.

---

## Jev Decision Engine Performance & Vision Acceptance Benchmark

BrowserPaw specifies a deterministic benchmark suite (`scripts/benchmark-jev-vision.mjs`) to rigorously evaluate the Jev Decision Engine across text-only and multimodal vision capabilities without regression.

### 1. Controlled Comparison Groups

The benchmark enforces three pinned comparison groups:

1. **`baseline-1.13-text`**: Model pinned to `jev-1.13.0`, `visionEnabled: false`. Evaluates standard text-only baseline performance.
2. **`candidate-1.14-text`**: Model pinned to `jev-1.14.0`, `visionEnabled: false`. Evaluates text-only candidate performance and prompt compatibility.
3. **`candidate-1.14-vision`**: Model pinned to `jev-1.14.0`, `visionEnabled: true`. Evaluates multimodal visual grounding (`Box` + `Noul`) with active viewport screenshot capture.

### 2. Deterministic Local Fixtures

All benchmark scenarios run against deterministic local HTML fixtures served by an ephemeral HTTP loopback server (zero external web dependencies):

- **`search-preview`**: Text input and live filtering preview. Intentionally avoids destructive submit buttons to verify pure input perception without tripping safety pause keywords.
- **`icon-toolbar`**: Three icon-only action buttons rendered as distinct SVG glyphs without text labels or accessibility names. Verifies visual grounding on non-textual UI elements.
- **`canvas-interactive`**: HTML5 `<canvas>` rendering interactive rectangular buttons without child DOM elements. Verifies coordinate targeting on canvas controls.
- **`missing-target`**: Negative guard evaluation. Directs the agent to click a nonexistent target using a non-destructive goal (`Click on the blue calendar icon`); asserts zero triggered events (`__eventsCount === 0`) and graceful escalation without false positives from destructive keyword filters.

### 3. Execution Contracts & Evidence Standards

- **Zero Fabricated Data**: Default runs perform local fixture and environment self-checks without generating synthetic benchmark scores or writing fake result files.
- **Authentic Metrics & Real Page Outcomes**: Benchmark metrics record real runtime observations:
  - Task completion verified against actual in-page state changes (DOM input values, click counters, canvas state flags) rather than trusting `result.status === 'done'`.
  - Successful dispatch does **not** blindly report `done`.
  - Measured latency percentiles: p50, p95, min, max, and avg.
  - Step counts, failure reasons, and authentic telemetry (`jevUsage.visionCalls`).
- **Smoke Nature of the 4 Mixed Fixtures**: The 4 mixed fixtures constitute a functional smoke verification suite across perception pathways (DOM text input, unlabelled icon button, canvas coordinate, missing negative guard); sample size N=4 means p95 latency is indicative smoke data, not a statistical benchmark or performance speedup promise.
- **Click-Only Fallback & Escalation**: Visual fallback initial release only handles single, unambiguous click/tap targets; it rejects `type`, `fill`, `select`, and multi-step compound goals; complex goals escalate safely. When the text model picks `type` or `select`, vision fallback is never triggered.
- **Single Visual Click Limit & Post-Dispatch Verification**: At most one visual click per run (`visualClickExecuted`). The subsequent step re-reads the DOM: if the text model confirms `goal_done`, it completes; if the DOM has 0 elements or any additional action is attempted, the engine immediately escalates before acting again.
- **Tab & Session Isolation with Bounded Cleanup**: Real benchmark runs open dedicated temporary background tabs via `chrome_navigate` (`{ background: true }`), establish an MCP session (`initialize`), and track created tabs in a `Set`. A `finally` block attempts `chrome_close_tabs` for only newly created tabs and `DELETE /mcp`; deletion has a five-second deadline and reports failed or stalled cleanup. Failed tab closures remain tracked for a final retry. User tabs are never included in cleanup. Arbitrary sleeps are eliminated.
- **In-Memory Configuration Spying**: Group settings (`modelId`, `visionEnabled`) are injected into the running process by wrapping `jevModelManager` getters only. User disk configuration (`~/.browserpaw/jev-remote.json`) is never modified, preserving API keys and base URLs.
- **Runtime & SDK Constraints**: Multimodal vision requires Node.js `>=22.6.0`, `@typesafe-ai/sdk` `0.7.0` (pinned), pinned model `jev-1.14.0`, and operates strictly in Remote mode with explicit `visionEnabled: true`. Viewport screenshots are constrained to `280..1568px` on every side in PNG/JPEG format.
- **Box & Noul Guardrails**: Because TypeSafe `Box` returns coordinates regardless of object presence, BrowserPaw enforces strict `Noul` presence (`target_exists >= 0.85`), ambiguity (`target_ambiguous < 0.5`), and destructive action gates before dispatching clicks.
- **Strict Freshness Validation & Fail-Closed Policy**: Ephemeral screenshot contexts enforce strict TTL. Any drift in tab affinity, URL, document origin, scroll offset, viewport dimensions, or expired frame ID triggers immediate fail-closed rejection without dispatching clicks.
- **Canvas Perception Boundary Disclosure**: Perceptive signatures compare URL, title, question/progress markers, alerts, and active inputs, but do not compare pixels or the complete layout; canvas/video redraws and changes outside those fields can escape detection. Canvas fixture evaluation relies on internal canvas state (`__canvasState`), never claiming DOM perceptual detection of raw canvas pixel updates.
- **Suspended Frame Regression**: Screenshot tests simulate animation-frame and optional recapture acknowledgements that never resolve. Both active and background capture must complete the single black-bar retry without waiting for the CDP command timeout; background retries do not request animation frames. A stalled optional recapture retains the initial image and reports `cdpCaptureWarning`.
- **Nominal Pricing Disclaimer**: TypeSafe multimodal vision image pricing is unconfirmed. Existing telemetry `estCostUsd` is strictly a nominal text-token estimate ($0.042/1M tokens) and must not be treated as actual vision billing.
