# BrowserPaw Engineering Quality & Verification Contract 🛡️

This document defines the single canonical acceptance contract for BrowserPaw development, quality verification, and artifact delivery. All contributors, automated pipelines, and AI agents must comply with these verifiable gates before claiming any feature, fix, or release as complete.

Single Source of Truth: This contract owns engineering verification, quality gates, test tier definitions, and evidence integrity rules. Contributor workflows belong in [`docs/CONTRIBUTING.md`](./CONTRIBUTING.md); documentation lifecycle in [`docs/DOCUMENTATION.md`](./DOCUMENTATION.md); release management in [`docs/releases/`](./releases/README.md).

Prerequisites: Node.js ≥ 22.6, the pinned pnpm version from `package.json`, and Python with pytest installed or `uv` to prepare an isolated pytest environment. An explicit `PYTHON` environment variable selects an interpreter that must already provide pytest. Test failures are never retried using a different interpreter.

## Development checks versus release acceptance

During iteration, run the affected tests and contract checks. Documentation-only work normally requires link/governance validation, relevant generator tests and `git diff --check`; it does not require deployment or browser reload. A complete `pnpm verify` is mandatory before claiming a release or current-source delivery. Any later source or documentation edit invalidates that report's fingerprint.

After a complete passing gate, push the exact source commit and require the GitHub Actions `CI` workflow for that commit and tag to pass on both `ubuntu-latest` and `windows-latest`. A local `pnpm verify` result alone is not release evidence because clean CI environments can expose hidden ambient-state dependencies. Do not call a commit, tag or release publishable while its remote build is failing or still running.

After the remote gate passes, deploy its existing output with `node scripts/extension-artifacts.mjs --deploy`, then run `pnpm verify:delivery`. The destination must be explicitly configured. Use `pnpm build:deploy` when a build is actually needed; avoid rebuilding merely to copy an already verified output. Do not deploy as a side effect of documentation maintenance.

Release assets use stable filenames across versions: `browserpaw-extension.zip` and `browserpaw-skill.zip`. The release tag and embedded manifest carry version identity; do not put a version number in asset filenames.

For session-lifetime acceptance, record the Native PID/start time, client identity, keepalive results and a final call on the same connection after the idle threshold. A Native restart invalidates continuity even when automatic reconnect produces a healthy doctor. Preserve the failure and diagnose it before claiming the lifetime issue is fixed.

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
  - Root script regression tests for every `scripts/*.test.{mjs,cjs}` file via `node --test`.
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
- **Authentic Evidence Integrity**: Verification evidence fields (`sourceFingerprint`, `buildId`, target delivery hashes, and test `status`) must be emitted directly by automated verification runs. Handcrafting, manual editing, or fabricating evidence is strictly prohibited.
- **Documentation Edit Invalidation**: Documentation edits invalidate the repository verification fingerprint. Run focused documentation checks during iteration and a fresh `pnpm verify` before claiming full acceptance of the final tree. Documentation edits alone do not imply changed extension bytes or require deployment.
- **Classification of Assertions**:
  - **Mock / Simulated**: Verifies isolated component logic, deterministic edge cases, and protocol codecs without external dependencies. **Simulated E2E runs are component checks and do NOT constitute browser acceptance.**
  - **Live / Real Browser Acceptance**: Asserts authentic Chrome CDP connectivity, Native messaging IPC pipes, physical extension load, manual reload in `chrome://extensions`, and runtime `buildId` parity via `chrome_doctor`.

---

## 🚫 Negative Behaviors (Strictly Prohibited)

1. **Never substitute disk presence for runtime verification**: Files on disk are never proof of live Chrome in-memory execution.
2. **Never claim simulated E2E as browser acceptance**: Mocked or headless test passes cannot substitute for real Chrome runtime loading and doctor `buildId` parity.
3. **Never fabricate or hand-edit verification evidence**: Modifying `sourceFingerprint`, `status`, or delivery hashes by hand is a critical violation of verification integrity.
4. **Never claim delivery without explicit deployment check**: `pnpm verify:delivery` must pass with 100% hash parity.
5. **Never break doc links or version records**: Active documentation links must resolve to real files, and package version numbers must align with release documentation.

---

## 🔬 Benchmark & Perception Quality Standards

Automated benchmarks (such as `scripts/benchmark-jev-vision.mjs`) and perceptual models must comply with universal quality standards:

1. **Zero Fabricated Outcomes**: Benchmark metrics must record real runtime observations. Task completion must be asserted against authentic DOM/in-page state mutations rather than trusting superficial status flags (e.g. `result.status === 'done'`).
2. **Fail-Closed & Safe Escalation**: Visual fallbacks and model-assisted actions must handle unambiguous, non-destructive targets only; ambiguous, multi-step, or destructive targets must escalate safely. Strict TTL and perceptual freshness checks must reject stale screenshot frames.
3. **Tab & Session Isolation**: Benchmark runs must operate in dedicated, temporary background tabs and guarantee deterministic cleanup via bounded `finally` handlers. User tabs and ambient sessions must never be closed or modified.
4. **Non-Invasive Configuration**: Benchmark and test harnesses must inject capabilities via in-memory spies and wrappers only; user disk configuration (such as API keys in `~/.browserpaw/`) must never be modified or overwritten.

---

## Historical benchmark detail

The [2026-11-05 benchmark contract snapshot](./archive/testing/quality-benchmarks-2026-11-05.md) preserves the former model comparison groups, fixture definitions, regression cases and accounting assumptions. It is historical context, not a current model/version, pricing or acceptance claim. Consult `scripts/benchmark-jev-vision.mjs` and its regression tests for current implementation.
