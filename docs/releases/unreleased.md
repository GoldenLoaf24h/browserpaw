# BrowserPaw Unreleased Changes Ledger 🚧

This document tracks in-progress architectural updates, fixes, and documentation improvements queued for future releases.

---

## 🎯 Version Invariants & Release Rules

1. **No Untagged Release Claims**: Features in progress must remain recorded here or in draft files. No release may be documented as published without an active git tag.
2. **Current Monorepo Version**: Working version is `4.0.0` across packages.
3. **Pending Validation**: All delivered items must pass the complete verification suite defined in [`docs/QUALITY.md`](../QUALITY.md).

---

## 📋 Queued Changes

### Jev Vision Routing & Autonomous Loop Corrections

- **Local Extension Origin Accepted**: Set `CHROME_EXTENSION_ID` before host registration to include an unpacked build in the manifest's `allowed_origins`. Once Chrome admits that caller, the native bridge derives its ID from the Native Messaging launch arguments for HTTP Origin checks, allowing remote configuration saves and Jev mode switches. Malformed caller-supplied IDs are rejected by format validation.
- **Vision Capability Routed by Upstream, Not by a Switch**: Removed the `visionEnabled` setting and the pinned `jev-1.14.0` vision model. Before any screenshot is captured the engine asks upstream which concrete release answers the configured endpoint and proceeds only when that release supports `box` questions (Jev 1.14+). Resolution is cached per credentials/endpoint/model and refreshed whenever a text query reports a new release, so promoting an alias moves the gate automatically. Responses from superseded configurations cannot populate the current capability cache. Endpoints below the threshold are declined with `vision_model_unsupported` and no image is captured or sent.
- **Bounded Vision Fallback**: Capability probes and image requests receive the remaining execution budget. Screenshot capture returns on budget expiry and ignores late results without issuing a vision request or click.
- **Retired Configuration Keys Stop Round-Tripping**: The remote config loader reads known fields only, so keys removed from the product no longer survive on disk after a save.
- **Model Sees Its Own Results**: The DOM tree handed to the model now includes the current value of filled controls, and the model state carries a bounded slice of visible page text. A fill that previously looked like a no-op no longer loops until the run reports `stuck`.
- **Submit Judgment Replaces Keyword Matching**: Whether a filled field is also submitted is now an explicit model question with a `fill_only` / `submit` / `unclear` answer. Automatic submission requires a valid answer distribution and the execution confidence thresholds; an unclear answer pauses for the caller. An explicit `pressEnter` argument bypasses the model's submit judgment.
- **Session Lifecycle Serialization**: The DeepSeek Harness plugin serializes open/close transitions, so concurrent opens create a single connection and a close issued while opening still tears the connection down. Failed disposal retains the session for retry and prevents a second transport from opening.
- **Plugin Bundle Manifest Compliance**: The plugin package now declares the top-level `dsh.bundle.patch` (`./cordis.patch.yml`) that DeepSeek Harness requires before it treats a package as a profile layer. Without that field the package was reconciled as an ordinary dependency (`dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`), its patch never applied, `apply()` never ran, and neither the `browserpaw` skill nor the `browserpaw_session` tool existed. The manifest also carries the optional `dsh.manifestVersion: 1` and the top-level `engines.dsh` range.
- **Loader-Resolved In-Box Client**: The session tool resolves `@deepseek-ai/dsh-mcp-client` through `ctx.loader.import()` at `open()` time and hands the resulting module namespace to `ctx.plugin()`. Cordis rejects a bare specifier string (`invalid plugin, expect function or object with an "apply" method, received string`), and a top-level static import cannot resolve from a linked plugin that sits outside the harness image.
- **Fail-Loud Session Open**: `open()` now passes `failOnStartupError: true` to the in-box MCP client. The default (`false`) let a failed first connection retry in the background while `apply()` resolved normally, so `browserpaw_session { action: 'open' }` returned `ok: true` with no tool registered and the next call targeted a name that never existed. A bridge that cannot answer now makes `open()` reject with `mcp-client(browserpaw): initial connection or tool synchronization failed`, while `status` keeps reporting `active: false` and a retry still opens a fresh transport.
- **Skill Mirror Tool Naming Restored**: The skill synchronizer no longer applies the Hermes-only `chrome_` to `browserpaw_` rewrite to the DeepSeek Harness skill mirror, so the mirror keeps the canonical `chrome_*` names. DeepSeek Harness registers the injected MCP tools as `mcp__browserpaw__chrome_*`; the mcp-client has no rename capability and passes each raw tool name through unchanged.
- **Tool-Unlock Claim Corrected**: The tool-naming note injected ahead of the skill body no longer advertises `chrome_tool_docs` with `activateForSession: true` as a way to reach tools outside the announced profile. That path widens the server-side list but is invisible to DeepSeek Harness, because the native host does not declare the `tools.listChanged` capability and the in-box client therefore installs no list-changed handler. The note now states the real limit: an unannounced tool stays uncallable until the native host is restarted with `CHROME_MCP_TOOL_PROFILE=full`.
- **Publishable Plugin Package**: The DeepSeek Harness plugin is prepared for distribution as its own npm package (`dsh-browserpaw`), independently versioned from the monorepo. The manifest pins an explicit `files` allowlist — entry module, bundle patch, skill tree and `LICENSE` — and negates the internal `AGENTS.md` notes, which are repository working instructions rather than user documentation. `repository`, `bugs`, `homepage`, `license` and author metadata were added, and the package carries a copy of the repository's AGPL-3.0 text. The in-box client peer is now marked `peerDependenciesMeta.optional`: the declared range still documents the build target, but a required peer made `npm install` resolve a second `@deepseek-ai/dsh-mcp-client` into the profile, which is the duplicate-in-box-package failure described in Discussion #8287. pnpm profiles already disable peer auto-installation, so the marker changes nothing there. Installation through a packed tarball was verified end to end against a real runtime: the copy loads as a profile bundle layer, resolves the in-box client through the loader, registers both the skill and `browserpaw_session`, and `open` injects the `mcp__browserpaw__*` tools.

### Browser Tool Corrections

- **Output Redaction**: Preserve unpadded Base64 redaction when `/` is its only structural marker, and keep acronym tokens such as `XSRF` intact when identifying sensitive structured keys.
- **Evaluation-Local JavaScript Helpers**: CDP and scripting evaluations keep their `mcp` reference local instead of overwriting page-owned `__mcp` globals. Overlapping evaluations retain the temporary `:has-text` patch until its last holder finishes.
- **Navigation Undo**: Navigation records remain undoable after their own main-frame commit; document-epoch rejection continues to protect element-bound fill records.
- **Overlay Error Propagation**: A confirmed physical dismissal failure sets the standard MCP `isError` flag as well as the result's `success: false` field.
- **Console Buffer Stop Mode**: `chrome_console` accepts `mode: "stop"` to release a tab's persistent buffer. The stop path waits for an in-flight start, releases only the domain claims it acquired, and is idempotent.
- **Tab-Scoped Network Listeners**: `chrome_network_capture` registers one `webRequest` listener set per captured tab behind a `tabId` filter and removes exactly that set when the tab stops, closes, or restarts, so unrelated tabs' traffic is no longer delivered to the extension and multiple captures can be stopped independently.
- **Single-Pass Shape Inference**: Visual shape inference caches nodes within one snapshot instead of rescanning each candidate's subtree, preserving traversal depth, precedence, and index output.

### Claude Code Plugin Distribution

- **Plugin Package**: Added `plugins/browserpaw-claude`, a Claude Code plugin bundling the canonical operating skill (`/browserpaw:browserpaw`, also reachable as bare `/browserpaw`) and a `.mcp.json` stdio server running `mcp-chrome-stdio`. It is deliberately separate from the Hermes/Codex package, whose `skills` manifest key appends a 16-tool `browserpaw_*` skill that would contradict the canonical `chrome_*` names on stdio.
- **Marketplace Catalog**: Added the repository-root `.claude-plugin/marketplace.json` alongside the existing Codex-format `marketplace.json`; the two formats are read independently by their respective hosts. `claude plugin validate --strict` passes for both the catalog and the plugin directory.
- **Skill Mirror**: `scripts/sync-skills.mjs` gained a fifth target that copies `skill/` verbatim, with no prefix rewriting and no Hermes scope banner. `scripts/browserpaw-claude-plugin.test.mjs` pins manifest/catalog agreement, the stdio entry, the command name, and byte parity.
- **Documentation**: Installation steps added to `AGENT_CONFIG_GUIDE.md`, `INSTALL.md`, and `README.md`; the Claude Code host contract is recorded in `docs/development/PLUGIN_COMPATIBILITY.md`.

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
