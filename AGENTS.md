# browserpaw

**Generated:** 2026-11-20 · **Updated:** 2026-11-20

## Purpose

Root of BrowserPaw, a v5 Chrome browser automation CLI, Native Messaging host, MV3 extension, and Agent Skill monorepo. It connects agents to an existing Chrome session over an authenticated local loopback bridge (`127.0.0.1`). See [PROJECT.md](PROJECT.md), [SECURITY.md](SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/QUALITY.md](docs/QUALITY.md), and [docs/development/DEVELOPMENT.md](docs/development/DEVELOPMENT.md).

## Key Files

| File                    | Description                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `CHANGELOG.md`          | Concise pointer to the centralized release archive in docs/releases/                   |
| `CONTRIBUTING.md`       | Entry pointer to docs/CONTRIBUTING.md, quality gates, and release workflow             |
| `INSTALL.md`            | Installation and upgrade instructions for the CLI, Native host, extension, and plugins |
| `LICENSE`               | GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)                    |
| `NOTICE`                | Legal notices and third-party software attributions                                    |
| `PRIVACY.md`            | Privacy notice detailing data locality and local-only processing guarantees            |
| `PROJECT.md`            | Engineering specifications, quality gates, and architecture summaries                  |
| `PROJECT.zh-CN.md`      | Simplified Chinese translation of the engineering project specification                |
| `README.md`             | Project overview, quick start, architecture highlights, and setup guide                |
| `README.zh-CN.md`       | Simplified Chinese translation of the repository README                                |
| `SECURITY.md`           | Security policy, trust model, enforced invariants, and vulnerability reporting         |
| `commitlint.config.cjs` | Conventional commits enforcement rules for git commit messages                         |
| `eslint.config.js`      | Global ESLint 9 flat configuration across TypeScript and Vue files                     |
| `package.json`          | Monorepo root scripts, dependencies, workspaces, and metadata                          |
| `pnpm-lock.yaml`        | Pinned dependency tree lockfile                                                        |
| `pnpm-workspace.yaml`   | PNPM workspace definition configuring packages and apps                                |

## Subdirectories

| Directory   | Purpose                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `app/`      | Container directory hosting the two primary executable applications: the Chrome MV3 extens... |
| `docs/`     | Documentation vault containing technical architecture specifications, tool references, nav... |
| `packages/` | Container directory for shared libraries and common packages across the BrowserPaw monorep... |
| `plugins/`  | Client-specific BrowserPaw distributions for ChatGPT/Codex, Hermes, Claude Code, and DeepS... |
| `research/` | Directory without additional generated guidance.                                              |
| `scripts/`  | Repository lifecycle, build automation, and documentation generation scripts....              |
| `skills/`   | Canonical agent skills; BrowserPaw lives in skills/browserpaw....                             |
| `test/`     | Root directory for integration and end-to-end testing suites, mock servers, stress tests, ... |

## For AI Agents

### Working In This Directory

- This is a pnpm monorepo (Node >=22.6, pnpm pinned in package.json). Run workspace tasks with pnpm.
- Use packages/shared/src/commands.ts as the single source of truth for CLI syntax and help; keep Native dispatchers and generated docs/COMMANDS.md (`pnpm docs:commands`) in sync.
- Keep packages/shared/src/tools.ts synchronized with extension tool executors, and edit the canonical skill in skills/browserpaw/ before running `node scripts/sync-skills.mjs`.
- Native v5 builds output to app/native-server/dist/v5. Do not edit generated outputs in dist/, .output/, .wxt/, or machine-written verification reports.
- Follow Conventional Commits enforced by commitlint.

### Testing Requirements

Run focused tests while iterating, and `pnpm verify` + `pnpm release:check` on the final candidate. For live browser E2E, run `pnpm test:e2e` with `BROWSERPAW_TEST_CHROME` pointing to Chrome for Testing. `pnpm verify`, `pnpm build`, and `pnpm build:extension` never deploy outside the repository; authorized local Chrome deployment uses `pnpm build:deploy`, `pnpm verify:delivery`, manual extension reload in `chrome://extensions`, and live `buildId` verification via `browserpaw status` or `browserpaw doctor`.

### Common Patterns

Shared CLI command and tool registry; authenticated loopback Native Messaging host (`com.browserpaw.nativehost`); MV3 extension executors; canonical skill mirror synchronization.

## Dependencies

### Internal

- `packages/shared`

### External

- `pnpm`
- `typescript`
- `eslint`
- `prettier`
- `husky`

## Manual Notes

### Review guidelines

Use these criteria when reviewing pull requests in cloud or local review. Prioritize real security regressions, runtime correctness bugs, and cross-package contract drift over style nitpicks already enforced by ESLint and Prettier.

1. **Security and trust boundaries ([SECURITY.md](SECURITY.md))**:
   - Loopback HTTP (`app/native-server/src/server/index.ts`, `token.ts`): must bind strictly to `127.0.0.1`, require `Host: 127.0.0.1:<port>`, reject requests carrying an `Origin` header, validate `x-browserpaw-token` in constant time, enforce request size limits and context locking, write sensitive files atomically with `0o600`/`0o700` permissions, and reject symlinks/junctions via `assertNoLinks`.
   - Native Messaging & extension isolation: keep `allowed_origins` pinned to the extension ID, keep Native host `stdout` strictly length-prefixed JSON (route logs and CLI update notices to `stderr` or log files), enforce `_sender.id === chrome.runtime.id && !_sender.tab` on extension message handlers, and keep `extension_pages` CSP free of `'unsafe-inline'`.
   - Page, CDP, and origin guards: enforce `isRestrictedChromeUrl` / `assertTabInjectable` / `isCloudMetadataUrl` before script injection, navigation, or browser `fetch`; enforce `screenshotOriginViolation` and explicit `captureId` checks for screenshot-derived coordinates; preserve `documentId` + `location.origin` checks in `chrome_storage`; preserve the dangerous CDP denylist (`Browser.close`, `Browser.crash`, `Browser.crashGpuProcess`).
   - File, SSRF, and redaction guards: preserve TCP-time `safeLookup` SSRF checks and per-hop manual redirect validation, `assertNotSensitivePath` (including `realpathSync` resolution), temp-directory confinement, 50 MiB / 700 KiB size caps, safe `pruneOutput` boundaries, URL/output secret redaction (`scrubUrl`, `output-sanitizer`, sensitive field masking), scoped `cookies list --values`, and explicit opt-in flags (`--yes`, `--recursive`, `--purge`) for destructive operations.
2. **Execution, concurrency, and MV3 correctness**:
   - Never silently replay uncertain dispatches; preserve original error codes and action receipts.
   - Cancellation is not rollback. Task cleanup (`task finish`) must close only verified task-owned pages and must preserve borrowed and pre-existing user tabs.
   - Reuse existing browser execution paths for locators, input, task ownership, and file delivery instead of introducing parallel implementations.
   - `chrome.scripting.executeScript({ func })` serializes functions without surrounding module scope: flag inline functions that depend on outer closures, imports, or transpiled helpers (such as spread helpers) that break inside the target page; use the in-page engine for shared helpers.
   - MV3 service worker state cannot rely solely on process memory across idle suspension.
3. **Cross-package SSOT and documentation sync**:
   - CLI command changes in `packages/shared/src/commands.ts` must keep Native dispatchers, offline help, tests, and generated `docs/COMMANDS.md` (`pnpm docs:commands`) in sync.
   - Tool schema changes in `packages/shared/src/tools.ts` must match extension executors.
   - Skill edits belong in `skills/browserpaw/` and must keep plugin mirrors synchronized (`node scripts/sync-skills.mjs --check`).
   - Version bumps must stay aligned across all workspace and plugin manifests checked by `scripts/validate-docs.mjs`.
   - Canonical documentation must stay in English (CI fails if Chinese text appears in active English `.md` files), existing `*.zh-CN.md` mirrors must be updated in the same PR, local links must resolve, and user-facing changes must be recorded in `docs/releases/unreleased.md` or the target release note (`pnpm release:check`).
4. **Build, deploy, and evidence integrity**:
   - `pnpm verify`, `pnpm build`, and `pnpm build:extension` must stay strictly non-deploying even when `BROWSERPAW_EXTENSION_SYNC_DIR` or `browserpaw.local.json` is set.
   - Flag hand-edited generated build outputs (`dist/`, `.output/`, `.wxt/`) or fabricated verification fingerprints, `buildId` values, or artifact hashes.
   - Keep CLI update notices on `stderr` and deduplicated per release.
5. **Review scope and false-positive boundaries**:
   - Do not flag intentional authenticated local-CLI features (`eval`, `cdp`, `fetch`, `cookies`, `storage`, `upload`) or the public Chrome MV3 manifest `key` in `app/chrome-extension/wxt.config.ts` as vulnerabilities on their own; review their guardrails as defined in [SECURITY.md](SECURITY.md).
   - Do not request edits to frozen historical records under `docs/archive/` or non-normative notes/checkouts under `research/` unless the PR intentionally modifies active code there.
   - Subdirectory `AGENTS.md` files supplement only their own directory; if an older nested file conflicts with v5 code or root documentation, follow the current source and root guidance.

### Operational rules

- Report to the user and write PR review feedback in Simplified Chinese. Keep repository code, commits, and canonical documentation in English, and preserve dedicated `*.zh-CN.md` mirrors.
- Read applicable scoped `AGENTS.md` files and preserve explicit user instructions.
- Preserve dirty/untracked work, browser login state, user task data, prior release evidence, and existing installations. Keep disposable test output in `.artifacts/`.
- Restrict deployment (`pnpm build:deploy` + `pnpm verify:delivery`), Native Host registration changes (`com.browserpaw.nativehost`), pushes, tags, and publication to explicitly authorized scope.
- Keep release assets and verification evidence tied to the same source revision and loaded build ID. Before claiming an extension or popup change is live in Chrome, verify the loaded folder in `chrome://extensions`, close open popups and DevTools before reload, and match the live `buildId` from `browserpaw status` or `browserpaw doctor` with `browserpaw-build.json` in that folder.
