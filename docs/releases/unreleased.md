# BrowserPaw Unreleased Changes Ledger 🚧

This document tracks in-progress architectural updates, fixes, and documentation improvements queued for future releases.

---

## 🎯 Version Invariants & Release Rules

1. **No Untagged Release Claims**: Features in progress must remain recorded here or in draft files. No release may be documented as published without an active git tag.
2. **Current Monorepo Version**: Working version is `4.0.0` across packages.
3. **Pending Validation**: All delivered items must pass the complete verification suite defined in [`docs/QUALITY.md`](../QUALITY.md).

---

## 📋 Queued Changes

### Verification and Extension Delivery

- Added `pnpm verify` as the complete acceptance gate: script syntax and regression tests, zero-warning lint, TypeScript and Vue checks, complete Vitest and Jest file sets, simulated E2E, plugin pytest, documentation checks, production build, and extension artifact checks.
- Verification reports record all 14 required steps and a repository content fingerprint. A new run invalidates old success evidence; source changes during or after verification prevent delivery acceptance.
- Added explicit `pnpm build:deploy` and `pnpm verify:delivery` commands. Deployment requires a configured unpacked extension directory and verifies every generated artifact with SHA-256.
- Production extension builds include `browserpaw-build.json`; verbose `chrome_doctor` exposes the compiled `buildId` for comparison after manual reload.
- Excluded generated engineering Markdown from extension assets. Artifact checks reject packaged documentation, and deployment removes retired files owned by the previous build manifest before verifying the exact target file set.
- CI uses the pinned pnpm version, full Git history, and the same acceptance command on Windows and Linux. Generated verification evidence stays outside version control.
- Consolidated ESLint into the root configuration, including Chrome browser globals and Vue parsing, so workspace checks and commit hooks use the same rules.
- Runtime acceptance remains a separate step: disk deployment is not proof that Chrome has loaded the new code. The optional Hermes host integration test reports a documented skip when that host is unavailable.

### Documentation Governance & Architecture

- **Centralized Documentation Hub**: Established [`docs/README.md`](../README.md) as the single authoritative navigation hub.
- **Repository Map Clarification**: Scoped [`docs/MAP.md`](../MAP.md) strictly to codebase topology and dataflows, pointing to `docs/README.md` as the hub to eliminate duplicate indexes.
- **Single Acceptance Contract**: Authored [`docs/QUALITY.md`](../QUALITY.md) codifying verification interfaces (`pnpm verify`, `pnpm build:deploy`, `pnpm verify:delivery`), deployment checks, and the invariant that staged disk files do not constitute live Chrome execution evidence.
- **Documentation Policy**: Authored [`docs/DOCUMENTATION.md`](../DOCUMENTATION.md) setting rules for doc ownership, active vs. archived partitioning, canonical English and preserved translations, and release notes templates.
- **Release Ledger & Migration**:
  - Centralized version records for all 31 historical git tags into [`docs/releases/`](./README.md) with `Tagged (history reconstructed from git)` status.
  - Migrated legacy root release notes to [`docs/releases/v3.2.0.md`](./v3.2.0.md), [`docs/releases/v3.2.7.md`](./v3.2.7.md), [`docs/releases/v3.3.0.md`](./v3.3.0.md) (explicitly marked as local draft), and [`docs/releases/v4.0.0.md`](./v4.0.0.md) (working draft).
  - Eliminated duplicate root release files and added a concise [`CHANGELOG.md`](../../CHANGELOG.md) pointer.
- **Installation & Setup Clarity**: Updated [`INSTALL.md`](../../INSTALL.md) to replace hardcoded local deployment paths with explicit configuration instructions via `browserpaw.local.json` (`extensionSyncDir`) or `BROWSERPAW_EXTENSION_SYNC_DIR`.
- **Automated Docs Governance**: Implemented [`scripts/validate-docs.mjs`](../../scripts/validate-docs.mjs) and its test suite [`scripts/validate-docs.test.mjs`](../../scripts/validate-docs.test.mjs) verifying markdown link validity, illegal control characters, literal newline escapes, active index coverage, package version parity, and tag record completeness.
