# BrowserPaw Unreleased Changes Ledger 🚧

This document tracks in-progress architectural updates, fixes, and documentation improvements queued for future releases.

---

## 🎯 Version Invariants & Release Rules

1. **No Untagged Release Claims**: Features in progress must remain recorded here or in draft files. No release may be documented as published without an active git tag.
2. **Current Monorepo Version**: Working version is `4.0.0` across packages.
3. **Pending Validation**: All delivered items must pass the complete verification suite defined in [`docs/QUALITY.md`](../QUALITY.md).

---

## 📋 Queued Changes

### Native Bridge Credential Security & Stdio Transport Architecture

- **Default Stdio Transport**: Standardized all client configuration templates (Desktop, Editor, Cline, CLI, Hermes) on stdio (`node <ABSOLUTE_PATH>/mcp-server-stdio.js`) as the zero-config default without token or environment credential requirements.
- **Sole Credential Initializer**: Native messaging bridge server is the sole producer of `~/.chrome-mcp/bridge-token`. Uses exclusive file creation (`wx` mode `0o600`), preserves valid existing 48-hex and 64-hex tokens, retries transient empty files asynchronously, and fails explicitly on corruption or permission errors without in-memory ephemeral fallback. Clients and doctor scripts never write, rewrite, or auto-generate tokens.
- **Removed Environment Overrides**: Eliminated reliance on and writeback to `CHROME_MCP_TOKEN`, `BROWSERPAW_MCP_TOKEN`, and `CHROME_MCP_TOKEN_DIR`.
- **Advanced Manual HTTP Transport**: Documented HTTP/SSE endpoints as advanced manual options requiring explicit authentication tokens (`Authorization: Bearer <token>` or `x-mcp-token`), with non-configurable loopback, Host, and Origin security guards.
- **Hermes Integration Architecture**: Hermes defaults to `mcp_servers.browserpaw` in `config.yaml` using stdio (`node` + absolute script path, `enabled: true`) exposing all ~50 standard MCP tools. The optional legacy 16-tool plugin requires Hermes `>=0.21.5` and explicit user authorization via `plugins.entries.browserpaw.mcp_allowlist: ["browserpaw"]` (with optional `settings.isolate_modal` toggle); recommended strategy is to leave the optional plugin disabled to prevent duplicate tool registration.
- **Session & Subagent Isolation**: Each external MCP client session maintains isolated state, while subagents sharing the same profile may share transport connections with background tab isolation and explicit `tabId` targeting.
- **Read-only Credential Diagnostics & Scanner**: Doctor checks file readability and format, then authenticates with the local bridge without displaying or rewriting tokens. Its regression tests use temporary directories and mocked networking. Added automated regression scans preventing hardcoded credentials in source files.
- **Credential Rotation Recovery**: HTTP 401 invalidates the stale stdio connection. Safe reads may reconnect once; mutating calls are never automatically replayed. New connections reread the credential file. Removed hardcoded credentials from benchmark and manual test scripts; scanner fixtures use synthetic credentials.
- **Hermes Skill Scope**: Hermes skill generation uses a dedicated 16-tool template; shared reference and troubleshooting documents identify capabilities available only through standard MCP. The Codex manifest selects a separate full standard MCP skill distribution; DeepSeek keeps its full skill. Forwarded results preserve business errors, structured content, truncation markers, and standalone `MEDIA:` paths.

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
  - Centralized version records for every historical git tag into [`docs/releases/`](./README.md) with `Tagged (history reconstructed from git)` status.
  - Migrated legacy root release notes to [`docs/releases/v3.2.0.md`](./v3.2.0.md), [`docs/releases/v3.2.7.md`](./v3.2.7.md), [`docs/releases/v3.3.0.md`](./v3.3.0.md) (explicitly marked as local draft), and [`docs/releases/v4.0.0.md`](./v4.0.0.md).
  - Eliminated duplicate root release files and added a concise [`CHANGELOG.md`](../../CHANGELOG.md) pointer.
- **Installation & Setup Clarity**: Updated [`INSTALL.md`](../../INSTALL.md) to replace hardcoded local deployment paths with explicit configuration instructions via `browserpaw.local.json` (`extensionSyncDir`) or `BROWSERPAW_EXTENSION_SYNC_DIR`.
- **Automated Docs Governance**: Implemented [`scripts/validate-docs.mjs`](../../scripts/validate-docs.mjs) and its test suite [`scripts/validate-docs.test.mjs`](../../scripts/validate-docs.test.mjs) verifying markdown link validity, illegal control characters, literal newline escapes, active index coverage, package version parity, and tag record completeness.
