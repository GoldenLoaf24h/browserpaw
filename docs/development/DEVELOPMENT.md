# BrowserPaw development

Run `pnpm install --frozen-lockfile` and `pnpm verify`. Use `BROWSERPAW_EXTENSION_SYNC_DIR=""` for builds that should stay in the repository. Build and package with `pnpm build` and `npm pack` from the Native package directory.

The shared command registry drives help and generated Markdown. After editing it, run `pnpm build:shared`, `pnpm docs:commands`, and `node scripts/sync-skills.mjs`. Edit the Skill in the canonical directory.

Run `pnpm test:e2e` with `BROWSERPAW_TEST_CHROME` pointing to Chrome for Testing. The fixture uses an isolated Chrome profile, Native state, and fixture pages. On Windows it creates a temporary v5 registration and removes its manifest afterwards. Point `BROWSERPAW_TEST_CLI` at an extracted npm package CLI to verify the packaged runtime. The runtime report records the build ID read from Chrome.

Change shared browser behavior through existing locator, task, or extension executors. Preserve task ownership, document identity, framed Native stdout, and unknown dispatch receipts. Retain source and build evidence until the candidate has been verified.
