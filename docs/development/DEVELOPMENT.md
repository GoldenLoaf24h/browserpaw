# BrowserPaw Development Boundaries

Start here before changing behavior. [PROJECT.md](../../PROJECT.md) maps responsibilities; [QUALITY.md](../QUALITY.md) owns acceptance; [DOCUMENTATION.md](../DOCUMENTATION.md) owns documentation. Runtime method help and shared schemas resolve parameter questions.

## Current release work

The latest published tag is 4.1.2. It adds interaction-scope parity across standard/fast/chained observation, explicit delayed page recovery, fast-observation fail-closed behavior, and unified expected-page restriction handling. Its complete local gate, deployment verification, loaded-runtime probe, Linux/Windows CI and release assets are recorded in the release archive.

Release asset filenames are version-independent: `browserpaw-extension.zip` and `browserpaw-skill.zip`. The release tag carries the version identity; do not add version numbers to future asset filenames.

The reproduced ten-minute Native idle failure was caused by a diagnostic written to framed stdout. It was fixed by moving that diagnostic to stderr, passed the complete gate, and retained the same Native process and original MCP connection through a real 665-second idle test. Preserve the original failures and keep diagnostics off Native stdout.

Current work integrates bounded Jev judgments into the shared locator, task and skill execution paths. Deterministic targeting stays first, transient model failures pause inference while retaining the user's backend choice, and unknown browser dispatch is never replayed. `chrome_form_pipeline` fills only the exposed step; later Next/Submit/Enter actions must be listed explicitly. Source checks, real-model evaluation and loaded-runtime acceptance remain separate gates; implementation tests do not establish model accuracy or production readiness.

The 320-run M7 comparison is stopped by user decision. Preserve its frozen plans, historical results and costs; do not restart it as a routine gate or claim its population efficiency targets passed. Hermes end-user verification belongs to the user. Physical window testing was waived, not passed.

Machine-local evidence is outside the repository under the workspace `.ego-research/`: `v4.1.0-delivery.json`, `v4.1.0-keepalive-live.json`, `v4.1.0-keepalive-live-2.json` and `v4.1.0-keepalive-process-audit.json`, `native-idle-fix-delivery.md` and `native-idle-live-stderr-fix-20261031.json`. These paths describe existing local evidence, not portable package dependencies. Read current records before relying on this dated status.

## Change boundaries

| Responsibility           | Authoritative source                                          | Required consumers to inspect                                                       |
| ------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Tool contract            | `packages/shared/src/tools.ts`, types and profiles            | Native dispatch, extension executor, wrappers, method help and generated tools docs |
| Browser behavior         | Extension shared locators, input, CDP and observation helpers | Atomic tools, batch/form paths, task/page facade and receipts                       |
| Task and skill lifecycle | Native task, skill and service modules                        | MCP, CLI/REPL, persistence, cancellation and cleanup                                |
| Static Agent Skill       | `skills/browserpaw`                                           | Plugin mirrors and Native packaged skill; regenerate with sync script               |
| Client integration       | Each plugin's official manifest and adapter                   | Its package contents, contract tests and current official host documentation        |

- Fix the shared cause once. Search callers before editing; do not introduce another execution engine, fallback ladder or learning store.
- Separate owned task pages, borrowed pages and user pages. Reconnect does not authorize taking over or closing an unrelated page.
- Keep frame/document identity checks. Dispatch acknowledgement, trusted input and a download event are not business completion.
- Unknown delivery stops the workflow. Cancellation stops future work and does not roll back dispatched work.
- Preserve raw page content, receipts and non-text MCP content; namespace adaptation belongs to tool-owned help.
- Native Host stdout is a binary framed protocol channel, including delayed callbacks and imported services. Send diagnostics to stderr; CLI/REPL output has a separate contract.
- Keep credentials with their current owner. Do not print, copy into evidence, or persist cookies, tokens, temporary refs or user secrets in skills.
- Prefer existing code, platform APIs and installed dependencies. Add only interfaces with a real caller, failure behavior, tests and distribution.

## Verification and deployment

1. Define the observable defect or success condition. For a bug, demonstrate failure before fixing it.
2. Run focused tests while iterating. Documentation-only changes need documentation, link and generation checks; a generator change also needs its own regression and lint.
3. Before a release or delivery claim, run the complete `pnpm verify` and `git diff --check`. Source changes invalidate the old gate fingerprint, including documentation changes.
4. Push the exact release commit and wait for GitHub Actions `CI` to pass on both Linux and Windows. The remote run is mandatory release evidence; local success does not prove a clean-environment build. Tags must not be treated as released while the matching run is failed or pending.
5. Deploy only when requested. After both local and remote gates pass, deploy the existing output with `node scripts/extension-artifacts.mjs --deploy` and run `pnpm verify:delivery`; avoid a redundant rebuild that changes build identity.
6. Confirm the actual Native process path and loaded extension buildId. Where automated extension-management access is prohibited, ask for one manual reload after all artifacts are ready.
7. Verify changed behavior in self-created pages and clean up only those resources. Record build, inputs, result, cleanup and limitations. A long-session fix needs an actual long-session test.

Client plugin validation, installed package contents, runtime connection and real business execution are separate checks. Counts come from schemas and reports. Bytes, tokenizer estimates and cumulative Agent usage must keep their original units. One cold/reuse pair cannot establish a general speedup.

## Workspace and cleanup

| Location                                                                    | Treatment                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Source, tests, fixtures, canonical skills and manifests                     | Keep; untracked does not mean disposable                                                  |
| `dist/`, `.output/`, `.wxt/`                                                | Generated; rebuild through scripts, never hand-edit; preserve active Native/build outputs |
| `.artifacts/verification/`                                                  | Keep the latest gate and evidence needed to explain a failed or delivered build           |
| Test caches, bytecode, root scratch logs                                    | Remove when identified and unused; record significant cleanup                             |
| `.claude/`, `.agents/`, linked worktrees and local deployment configuration | Inspect ownership; never delete wholesale as cache                                        |
| External research, frozen benchmark builds and raw failures                 | Preserve for reproducibility; no bulk purge under a generic cleanup request               |
| `$BROWSERPAW_HOME/skills` and live task/file ledgers                        | User runtime data, outside static skill synchronization and repository cleanup            |

Use pwsh 7 and exact resolved paths. Reject symlink/junction cleanup targets and avoid traversing them. Never bypass a deletion rejected by policy. Do not commit, tag, push, publish, change Native registration or reload Chrome without task authorization.

## Documentation maintenance

- Put enforceable cross-cutting rules in root `AGENTS.md` Manual Notes; generated per-directory files remain navigation aids.
- The generator preserves Manual Notes. Regenerate only changed directories; do not rewrite the entire tree for a small edit.
- Keep README focused on installation and supported capabilities, PROJECT on ownership, QUALITY on gates, and this document on development boundaries/current handoff.
- Keep historical comparison and milestone ledgers as dated evidence. Do not duplicate their chronology into current instructions or relabel old builds as current results.
- Edit canonical skills and the Hermes-specific template at their source, then synchronize. Never hand-edit client installation caches.
