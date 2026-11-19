# Documentation and repository ownership

Use [docs/README.md](./README.md) to find documentation. Update an existing owner before introducing another rulebook.

## Rule ownership

| Owner                                       | Responsibility                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Root AGENTS Manual Notes](../AGENTS.md)    | Agent behavior, authorization and scope; local AGENTS supplement only their directory |
| [PROJECT](../PROJECT.md)                    | Package responsibilities and architecture boundaries                                  |
| [QUALITY](./QUALITY.md)                     | Verification commands, evidence integrity, deployment and runtime acceptance          |
| [CONTRIBUTING](./CONTRIBUTING.md)           | Setup, development workflow, review and commit conventions                            |
| This document                               | Repository layout, documentation lifecycle and translations                           |
| [RELEASING](./releases/RELEASING.md)        | Release preparation, template, attachments and publication                            |
| [DEVELOPMENT](./development/DEVELOPMENT.md) | Current work and cross-layer implementation checklists                                |
| [TOOLS](./COMMANDS.md)                      | Generated reference; source contracts live in `packages/shared/src/tools.ts`          |

Task instructions take precedence over repository guidance. Deeper AGENTS files apply within their directory, not to unrelated packages. Historical reports and external checkouts are evidence, not developer instructions. If two active documents conflict, consult the owner above and correct the duplicate.

## Repository layout

| Location                              | Contents and boundary                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `app/chrome-extension/`               | Browser background worker, in-page execution and popup                                           |
| `app/native-server/`                  | Native Messaging bridge, local MCP server and CLI                                                |
| `packages/shared/`                    | Tool schemas, profiles, shared types and protocol helpers                                        |
| `test/`                               | Cross-package integration and simulated E2E; package unit tests stay in their packages           |
| `scripts/` and `bin/`                 | Repository automation and executable entry points; keep callers intact when moving files         |
| `skills/browserpaw/`                  | Canonical client-neutral skill                                                                   |
| `plugins/`                            | Client adapters and generated skill distributions                                                |
| `.agents/plugins/`, `.claude-plugin/` | Marketplace discovery metadata, not disposable agent logs                                        |
| `.agents/ORIGINAL_REQUEST.md`         | Retained test requirement baseline                                                               |
| `docs/`                               | Current user and developer documentation                                                         |
| `docs/releases/`                      | Version records, release process, template and unreleased ledger                                 |
| `docs/archive/`                       | Frozen handoffs, reviews and completed task records                                              |
| `research/`                           | Research notes and external references; not normative documentation                              |
| `releases/`                           | Ignored local packaging output and retained versioned builds; new GitHub assets use stable names |
| `.artifacts/`                         | Ignored scratch output and verification evidence with independent retention needs                |
| `dist/`, `.output/`, `.wxt/`          | Generated build output; regenerate rather than hand-edit                                         |

Do not move working source packages merely to make the tree look cleaner. A move must improve ownership or lifecycle separation and update imports, scripts, documentation links and tests together.

## Active, generated and archived documents

- Active documentation describes current behavior and supported commands. Link new documents from the relevant hub; keep local links valid and exclude links to ephemeral `.artifacts/` paths.
- `docs/COMMANDS.md` comes from `node scripts/gen-tools-doc.mjs`. Static skill mirrors come from `node scripts/sync-skills.mjs`; edit their canonical sources.
- Generated AGENTS files are directory navigation plus package guidance. Put maintained local rules under the exact `## Manual Notes` heading so regeneration preserves them. Use targeted regeneration, such as `node scripts/generate-agents-docs.mjs docs`; a new folder does not need another AGENTS file unless its rules differ.
- Archive completed records with their context and date under the [archive index](./archive/README.md). Preserve content; update active inbound links or leave a deliberate pointer. Historical paths inside frozen records are not current navigation.
- Keep archive index links valid. Do not rewrite old release claims to match today's implementation. The version ledger distinguishes published tags from local drafts.
- Cleanup requires an explicit allowlist: confirm references and ownership before deleting. Preserve research, worktrees, local settings, learned skills, frozen builds and failure evidence. A cache can be regenerated; a unique report cannot.
- See [QUALITY](./QUALITY.md) for the checks required after changes. Documentation edits invalidate old verification fingerprints; they do not justify altering an old report or automatically deploying.

## Language and formatting

English is canonical. Keep existing `*.zh-CN.md` files as complete Chinese mirrors, updating affected sections and links in the same change. Frozen archives retain their original language.

Use one H1, descriptive headings, relative links to repository files, and fenced commands labelled with the actual shell. Keep examples executable and separate expected behavior from measured evidence. Use the repository Prettier configuration on changed active documents only; avoid whole-repository formatting churn.

Development instructions stay outside installable skill/plugin bundles. Client-specific setup belongs in its adapter; `$BROWSERPAW_HOME/skills` is learned runtime data and is never a documentation cleanup target.

## Release records

[RELEASING](./releases/RELEASING.md) and [TEMPLATE](./releases/TEMPLATE.md) are the only release procedure and format. `pnpm release:check` checks new version records; existing historical records remain frozen.

Keep one note per published version under `docs/releases/vX.Y.Z.md`, register it in the [release ledger](./releases/README.md), and use [unreleased.md](./releases/unreleased.md) for in-progress changes. Root [CHANGELOG](../CHANGELOG.md) remains a pointer. A local tag or draft alone does not prove a GitHub release was published.
