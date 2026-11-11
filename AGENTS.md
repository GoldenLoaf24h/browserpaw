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

- Report to the user in Simplified Chinese; repository documentation is English canonical. Preserve dedicated Chinese mirrors.
- Read applicable ancestor and directory AGENTS files. Local Manual Notes add scope-specific rules; archived task prompts are historical records, not current instructions.
- Use [PROJECT](PROJECT.md) for package responsibilities, [DOCUMENTATION](docs/DOCUMENTATION.md) for layout and document ownership, [QUALITY](docs/QUALITY.md) for evidence and acceptance, [CONTRIBUTING](docs/CONTRIBUTING.md) for workflow, and [RELEASING](docs/releases/RELEASING.md) for publication.
- Start with [current development boundaries](docs/development/DEVELOPMENT.md). State assumptions, inspect callers, and make the smallest complete change. Use pwsh 7 and prefer `rg`.
- Preserve dirty/untracked work, user configuration, login state, learned skills and evidence. Commit, push, tag, publish, deploy or alter production registration only within task authorization.
- Shared schemas own tool contracts. Inspect atomic tools, batch/form paths, task/page, skills and clients before changing a common executor; avoid parallel implementations.
- Never replay uncertain dispatch. Preserve errors and receipts. Distinguish task-owned, borrowed and user pages. Cancellation is not rollback; reconnect is not session continuity.
- Edit canonical skill sources or the Hermes-specific template, then synchronize. Client configuration belongs in its adapter; installed caches and learned skills are not static mirror sources.
- Run focused checks during development and the full acceptance gate before a release or delivery claim. Never hand-edit report fingerprints, statuses, build IDs or hashes to make a gate pass.
- Prepare all artifacts before requesting one necessary manual reload. Confirm the Native path, loaded build identity and changed browser behavior separately from disk-state checks.
- Archive historical task records under `docs/archive/`; put new scratch output under ignored `.artifacts/`. Preserve worktrees, research, versioned frozen builds and failure evidence. Never bypass a policy-rejected deletion.
- Read local paths, PIDs, counts and versions from current records. M7 sampling remains stopped by user decision.
