# BrowserPaw

BrowserPaw connects an Agent Skill and CLI to Chrome over a local Native Messaging host. See [development](docs/development/DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md), and [quality gates](docs/QUALITY.md).

## Working in this repository

- Use the shared command registry for command syntax and help. Keep the Native dispatcher and generated command reference in sync.
- Reuse the existing browser execution path for changes to locators, input, task ownership, and file delivery.
- Run focused tests while changing code and `pnpm verify` on the final candidate.
- Use `BROWSERPAW_EXTENSION_SYNC_DIR=""` for a non-deploy build. Native v5 builds use `app/native-server/dist/v5`.
- Edit the canonical skill and regenerate its mirrors. Do not edit generated build outputs or machine-written evidence.
- Preserve local changes, browser login state, user task data, and existing installations. Restrict deployment, registration changes, pushes, tags and publication to the authorized scope.
- Keep Native stdout framed. Report uncertain dispatch without replay. Cleanup acts on verified task-owned pages and preserves borrowed tabs.

## Manual Notes

- Report to the user in Simplified Chinese. Keep repository documentation English canonical and preserve dedicated Chinese mirrors.
- Read applicable scoped AGENTS files and preserve relevant user instructions.
- Keep release assets and verification evidence tied to the same source revision and loaded build ID.
- Preserve prior release evidence and user configuration. Keep disposable test output in `.artifacts`.
- M7 sampling remains stopped by user decision.
