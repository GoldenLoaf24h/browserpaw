# browserpaw

**Generated:** 2026-10-31 · **Updated:** 2026-10-31

## Purpose

Root of BrowserPaw, a Chrome browser automation MCP server and Agent Skill monorepo. It connects agents to an existing Chrome session through an extension and local Native bridge. See PROJECT.md for responsibilities and docs/development/DEVELOPMENT.md for current work and limitations.

## Key Files

| File                          | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `AGENT_CONFIG_GUIDE.md`       | Client configuration instructions for Claude, Cursor, and Windsurf          |
| `AGENT_CONFIG_GUIDE.zh-CN.md` | Simplified Chinese translation of the AI agent client configuration guide   |
| `CHANGELOG.md`                | Concise pointer to the centralized release archive in docs/releases/        |
| `CONTRIBUTING.md`             | Implementation file for CONTRIBUTING.md                                     |
| `INSTALL.md`                  | Installation instructions for the native messaging host and extension       |
| `LICENSE`                     | Implementation file for LICENSE                                             |
| `NOTICE`                      | Implementation file for NOTICE                                              |
| `PRIVACY.md`                  | Privacy notice detailing data locality and local-only processing guarantees |
| `PROJECT.md`                  | Engineering specifications, quality gates, and architecture summaries       |
| `PROJECT.zh-CN.md`            | Simplified Chinese translation of the engineering project specification     |
| `README.md`                   | Project overview, quick start, architecture highlights, and setup guide     |
| `README.zh-CN.md`             | Simplified Chinese translation of the repository README                     |
| `TEST_INFRA.md`               | Comprehensive E2E test infrastructure specification and test matrix         |
| `commitlint.config.cjs`       | Conventional commits enforcement rules for git commit messages              |
| `eslint.config.js`            | Global ESLint 9 flat configuration across TypeScript and Vue files          |
| `package.json`                | Monorepo root scripts, dependencies, workspaces, and metadata               |
| `pnpm-lock.yaml`              | Pinned dependency tree lockfile                                             |
| `pnpm-workspace.yaml`         | PNPM workspace definition configuring packages and apps                     |

## Subdirectories

| Directory   | Purpose                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `app/`      | Container directory hosting the two primary executable applications: the Chrome MV3 extens... |
| `bin/`      | Executable binary entry points for running BrowserPaw directly from the command line or gl... |
| `docs/`     | Documentation vault containing technical architecture specifications, tool references, nav... |
| `packages/` | Container directory for shared libraries and common packages across the BrowserPaw monorep... |
| `plugins/`  | Client-specific BrowserPaw distributions for ChatGPT/Codex, Hermes, Claude Code, and DeepS... |
| `prompt/`   | Specialized prompt templates, LLM system instructions, and task prompts used for content a... |
| `releases/` | Distribution archive directory holding prebuilt zip files for the Chrome extension and ski... |
| `research/` | Module directory (see `research/AGENTS.md`)                                                   |
| `samples/`  | Module directory (see `samples/AGENTS.md`)                                                    |
| `scripts/`  | Repository lifecycle, build automation, and documentation generation scripts....              |
| `skills/`   | Canonical agent skills; BrowserPaw lives in skills/browserpaw....                             |
| `test/`     | Root directory for integration and end-to-end testing suites, mock servers, stress tests, ... |

## For AI Agents

### Working In This Directory

- This is a pnpm monorepo. Run commands using pnpm (e.g., pnpm build, pnpm test, pnpm typecheck).
- The canonical tool definitions and schemas live in packages/shared/src/tools.ts — keep them synchronized with any extension tool changes.
- Always follow conventional commits format enforced by commitlint.
- Do not modify generated files in dist/ or .output/ directly.

### Testing Requirements

Official verification gate is `pnpm verify` (static checks, lint, typecheck, tests, build, and doc validation). For deployment, run `pnpm build:deploy` and assert hash parity with `pnpm verify:delivery`. Note: Staged disk files or hot reloads are never valid runtime evidence; manual extension reload in chrome://extensions followed by doctor runtime buildId verification is required.

### Common Patterns

Monorepo workspace coordination; SSOT schema synchronization; layered profile filtering.

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

Notes under this heading are written by humans and preserved on regeneration.

### Development boundaries

- Communicate in Simplified Chinese. Verify facts, callers and acceptance criteria before making the smallest complete change. Use pwsh 7 and prefer `rg`.
- Start with [development boundaries/current work](docs/development/DEVELOPMENT.md) and [PROJECT](PROJECT.md). Generated directory indexes aid navigation; rules belong here, QUALITY and DOCUMENTATION.
- Preserve existing dirty/untracked source, user configuration, login state, learned skills and evidence. Do not commit, tag, push, publish or alter production registration without task authorization.
- Shared schemas own tool contracts. Inspect atomic tools, batch/form paths, task/page, skills and clients before changing a common executor; avoid parallel implementations.
- Never replay uncertain dispatch. Preserve original errors and receipts. Distinguish task-owned, borrowed and user pages. Cancellation is not rollback; reconnect is not session continuity.
- Edit static skill sources or the Hermes-specific template, then synchronize. Keep client configuration in its adapter. Do not hand-edit installation caches or clean learned skills as static data.
- Use focused checks during iteration and complete `pnpm verify` before release. Documentation edits also invalidate prior source fingerprints.
- Deploy only when authorized. Prepare all artifacts before requesting a necessary manual reload, then verify the Native path and loaded buildId.
- Clean only confirmed unused caches and scratch output. Worktrees, research, frozen builds and failure evidence are not bulk cleanup targets. Never bypass a policy-rejected deletion.
- Read local paths, PIDs, counts and current versions from actual records. M7 sampling is stopped by user decision. Verify loaded-runtime identity and session continuity separately from source, build and deployment checks.
