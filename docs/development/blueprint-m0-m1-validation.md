# Blueprint M0/M1 Active Verification Record

Date: 2026-10-27

This document records only targeted validations actively executed within the current workspace and does not imply that updated release packages have been deployed.

## M1: Deadline and Action Safety

### Implemented

- `fill-core.ts` accepts optional `deadlineAt`; preserves legacy calling behavior when deadline is omitted.
- `performPhysicalFill` checks remaining budget before critical mutations and propagates remaining timeout to `executeInPage`, `raceCdp`, nested `interactIndexTool.execute`, and `dispatchNativeSelectAll`.
- Deadlines expiring during an already dispatched mutation are handled as unknown rather than treating cancellation as rollback; deadlines expiring before a mutation abort subsequent submit.
- `handleAutoSubmit` re-checks deadline prior to button waiting, click, Enter fallback, and synthetic fallback.
- `form-pipeline.ts` re-checks deadline after slow fill returns; when expired, skips button locating/clicking and aborts proceeding to next field.
- `BatchActionItem` and `FillFormField` updated with `frameId` typing.

### Targeted Results

- `tests/fill-deadline-and-form-stop.test.ts`: 4/4 passed. Covers realistic `form-pipeline -> performPhysicalFill -> handleAutoSubmit` chain, controlled slow fill, future deadline nested interact, and unknown dispatch scenarios.
- 6 fill/batch/frame related test files: 66/66 passed.
- 7 keyboard/form/interact related test files: 110/110 passed.
- `pnpm exec vue-tsc --noEmit`: passed.
- Target files ESLint: passed.

## M0: Multi-Client Skill and Plugin Distribution

### Implemented

- `skills/browserpaw/` is the single client-neutral Agent Skill, structured into `references/`, `scripts/`, and `assets/recipes/`.
- Five release surfaces remain decoupled: ChatGPT/Codex portable plugin, Hermes native plugin, Claude Code plugin, DSH bundle, and the skill copy within the Native npm package.
- `scripts/sync-skills.mjs` generates client skill mirrors and guards against drift, orphans, illegal file types, symlinks/junctions, canonical client term leaks, and broken references.
- `browserpaw skill install` installs canonical skills from the Native package; defaults to `~/.agents/skills/browserpaw`, supports explicit `--target`, and rejects unflagged existing directories, path escapes, and symlinks/junctions.
- ChatGPT/Codex uses root `plugin.json`, `mcp.json`, `skills/`, and `.agents/plugins/marketplace.json`; legacy `.codex-plugin/` and `mcp-skills/` compatibility copies are removed.
- Hermes uses standalone `plugins/browserpaw-hermes/`; declarative wrapper delegates via `ctx.call_mcp('browserpaw', ...)`, reading no credentials and managing no independent connection.
- Claude Code uses `.claude-plugin/plugin.json`, `.mcp.json`, and root `.claude-plugin/marketplace.json`.
- DSH uses `dsh.bundle.patch`, `cordis.patch.yml`, and isolated Cordis runtime adaptations.
- Self-learning skills remain managed by Native in `$BROWSERPAW_HOME/skills`; static skills, bundled recipes, and dynamic learning libraries remain isolated without cross-copying.

### Targeted Results

- `node scripts/sync-skills.mjs --check`: passed.
- portable/Claude/DSH/sync contract tests: 34/34 passed.
- Hermes `pytest plugins/browserpaw-hermes/tests -q`: 40 passed.
- `hermes plugins validate plugins/browserpaw-hermes` and host registration check: passed.
- Claude Code `2.1.309` plugin and marketplace strict validation: passed.
- ChatGPT/Codex `0.166.0` isolated marketplace installation: passed.
- DSH `0.2.1-rc.3` packaging, isolated installation, and `--dump-config`: passed.
- Native skill installer default path, custom path, `--force` protection, junction rejection, and file hash checks: passed.

## Unverified / Pending Execution

- Targeted results in this document do not substitute for a full release gate for a new build; definitive status relies on subsequent complete verification records and deployment checks.
- New builds require reloading, runtime buildId confirmation, and live session acceptance.
