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
