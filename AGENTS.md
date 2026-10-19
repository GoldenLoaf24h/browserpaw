# browserpaw

**Generated:** 2026-10-15 · **Updated:** 2026-10-15

## Purpose

Root of BrowserPaw — a high-efficiency Chrome browser automation MCP server and AI agent skill monorepo. It enables AI agents (Claude, Cursor, Windsurf, Codex) to operate an everyday Chrome browser with existing logins, cookies, and extensions in background tabs without stealing focus.

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
| `marketplace.json`            | MCP and plugin catalog registry metadata for plugin discovery               |
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
| `plugins/`  | Container directory for platform-specific plugin integrations such as Codex and Hermes....    |
| `prompt/`   | Specialized prompt templates, LLM system instructions, and task prompts used for content a... |
| `releases/` | Distribution archive directory holding prebuilt zip files for the Chrome extension and ski... |
| `research/` | Module directory (see `research/AGENTS.md`)                                                   |
| `scripts/`  | Repository lifecycle, build automation, and documentation generation scripts....              |
| `skill/`    | Canonical AI Agent Skill package for BrowserPaw. Encodes execution ladders, prompt recipes... |
| `skills/`   | Mirror directory housing agent-compatible skill packages structured for external agent too... |
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
