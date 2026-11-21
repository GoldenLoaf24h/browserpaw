# BrowserPaw development

Run `pnpm install --frozen-lockfile` and `pnpm verify`. Builds stay in the repository. Build and package with `pnpm build` and `npm pack` from the Native package directory.

The shared command registry drives help and generated Markdown. After editing it, run `pnpm build:shared`, `pnpm docs:commands`, and `node scripts/sync-skills.mjs`. Edit the Skill in the canonical directory.

Run `pnpm test:e2e` with `BROWSERPAW_TEST_CHROME` pointing to Chrome for Testing. The fixture uses an isolated Chrome profile, Native state, and fixture pages. On Windows it uses a unique host name and port in its browser and CLI test copies, then removes its manifest and registration key. Point `BROWSERPAW_TEST_CLI` at an extracted npm package CLI to verify the packaged runtime. The runtime report records the build ID read from Chrome.

The fixture checks tab and dedicated-window creation and cleanup. Retain its report and receipts under `.artifacts/`. Tests that create a temporary browser profile, task ledger or package installation own its teardown.

The extension build ID is derived from extension and shared build inputs, the manifest key and build mode. A Markdown edit can change the full verification fingerprint while the loaded extension build ID stays the same. When checking a ZIP, use the artifact hashes in `browserpaw-build.json` as well as the build ID. Build timestamps can differ between runs.

The CLI prunes managed receipts in `~/.browserpaw/out` after artifact delivery. It removes eligible receipts older than seven days and keeps up to 200 eligible recent receipts, with a ten-minute grace period for concurrent output. The current command, active or paused tasks, and directories containing unrecognized entries are excluded. Explicit `--out` files belong to the caller.

Add commands to the shared registry, route them through the Native dispatcher, and reuse the existing extension executor where it fits. Add an example to offline help and a focused test for the behavior. Regenerate the command reference and skill mirrors with `pnpm docs:commands` and `node scripts/sync-skills.mjs`.

Chrome serializes `scripting.executeScript({ func })` without its surrounding module. Keep inline functions self-contained and check the built extension when changing them. For example, object spread can introduce a build helper that is absent on the page after serialization. Use the existing in-page engine for functions that need imports or shared helpers.

Change shared browser behavior through existing locator, task, or extension executors. Preserve task ownership, document identity, framed Native stdout, and unknown dispatch receipts. Retain source and build evidence until the candidate has been verified.

## Extension Build, Deploy, and Reload Rules

Chrome MV3 extension reloads commonly appear to fail or keep serving old UI (for example showing retired v4/Jev popup chunks after clicking Reload) due to five concrete mechanics in this repository and Chrome MV3:

1. **Build is intentionally separated from deployment (`pnpm verify` and `pnpm build` do not sync `browserpaw.local.json`)**:
   - `pnpm verify`, `pnpm build`, and `pnpm build:extension` build locally. They do not deploy when an extension target is configured.
   - To sync a build into Chrome's loaded unpacked folder (configured via `browserpaw.local.json` `extensionSyncDir` or `BROWSERPAW_EXTENSION_SYNC_DIR`), always run `pnpm build:deploy` followed by `pnpm verify:delivery`. `--deploy` prunes obsolete files tracked in the prior `browserpaw-build.json`, copies the new build, and checks SHA-256 hashes; `--check-deployment` enforces exact file-set and hash parity.
2. **Split load paths across development and CLI setup**:
   - Three directories can exist simultaneously: `app/chrome-extension/.output/chrome-mv3` (repo build output), the local sync target in `browserpaw.local.json`, and `~/.browserpaw/extension` (populated by `browserpaw setup`).
   - Before reloading, confirm the exact directory shown under `chrome://extensions` (Details) or Chrome's `Preferences` / `Secure Preferences` matches the target you just deployed to, and never keep two unpacked copies of BrowserPaw enabled in the same Chrome profile.
3. **v4 vs. v5 Native Host identity mismatch**:
   - v4 registered `com.chromemcp.nativehost` (port `12306`), whereas v5 registers `com.browserpaw.nativehost` (port `12307`). A v5 extension without its registered host shows **Offline**.
4. **Upgrades use a manual browser step**:
   - Setup refreshes the Native Host and base Skills. It prepares the bundled extension on first installation. For later releases, users download and unpack the matching ZIP, then load or reload it in Chrome. Close open popups and DevTools before reloading, and refresh existing test tabs when verifying updated content scripts.
5. **Mandatory live `buildId` verification**:
   - Disk copy logs and clicking Reload are never sufficient acceptance evidence. Always follow the full reload loop:
     1. For local development, deploy to the actual loaded folder using `pnpm build:deploy && pnpm verify:delivery`. For a released build, use the extension ZIP for the matching CLI version.
     2. Close any open BrowserPaw popup window and extension DevTools.
     3. Click **Reload** in `chrome://extensions` (or remove the stale entry and **Load unpacked** if switching directories), and refresh existing test tabs if testing content scripts.
     4. Reopen the popup and confirm that its version has no hover tooltip unless an update dot is shown. Use `browserpaw status` or `browserpaw doctor` to read the build ID and compare it with `browserpaw-build.json` in Chrome's loaded directory.
