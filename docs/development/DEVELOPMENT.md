# BrowserPaw development

Run `pnpm install --frozen-lockfile` and `pnpm verify`. Use `BROWSERPAW_EXTENSION_SYNC_DIR=""` for builds that should stay in the repository. Build and package with `pnpm build` and `npm pack` from the Native package directory.

The shared command registry drives help and generated Markdown. After editing it, run `pnpm build:shared`, `pnpm docs:commands`, and `node scripts/sync-skills.mjs`. Edit the Skill in the canonical directory.

Run `pnpm test:e2e` with `BROWSERPAW_TEST_CHROME` pointing to Chrome for Testing. The fixture uses an isolated Chrome profile, Native state, and fixture pages. On Windows it creates a temporary v5 registration and removes its manifest afterwards. Point `BROWSERPAW_TEST_CLI` at an extracted npm package CLI to verify the packaged runtime. The runtime report records the build ID read from Chrome.

Change shared browser behavior through existing locator, task, or extension executors. Preserve task ownership, document identity, framed Native stdout, and unknown dispatch receipts. Retain source and build evidence until the candidate has been verified.

## Extension Build, Deploy, and Reload Rules

Chrome MV3 extension reloads commonly appear to fail or keep serving old UI (for example showing retired v4/Jev popup chunks after clicking Reload) due to five concrete mechanics in this repository and Chrome MV3:

1. **Build is intentionally separated from deployment (`pnpm verify` and `pnpm build` do not sync `browserpaw.local.json`)**:
   - `pnpm verify` deletes `BROWSERPAW_EXTENSION_SYNC_DIR` from its child environment and writes only inside `app/chrome-extension/.output/chrome-mv3` (and `app/native-server/dist/v5/extension`).
   - `pnpm build` and `pnpm build:extension` run `scripts/sync-extension-dist.mjs`, which reads **only** the `BROWSERPAW_EXTENSION_SYNC_DIR` environment variable and silently skips syncing when it is unset. It does **not** read `browserpaw.local.json`, and it only clears `chunks/` and `assets/` (leaving deleted top-level files behind).
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
