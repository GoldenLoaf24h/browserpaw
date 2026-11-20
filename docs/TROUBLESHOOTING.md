# Troubleshooting

Start with `browserpaw doctor` and the [Installation Guide](../INSTALL.md). Consult the [portable troubleshooting reference](../skills/browserpaw/references/TROUBLESHOOTING.md) for connection and browser-action issues.

## Extension Reload Still Shows Old UI or Does Not Take Effect

1. **Check Chrome's actual loaded directory**: Open `chrome://extensions`, click **Details** on BrowserPaw, and verify the loaded path matches the directory you updated (either `~/.browserpaw/extension` from `browserpaw setup` or `extensionSyncDir` in `browserpaw.local.json`).
2. **Use `pnpm build:deploy` for local development**: `pnpm verify`, `pnpm build`, and `pnpm build:extension` do not read `browserpaw.local.json` and only update `app/chrome-extension/.output/chrome-mv3`. Run `pnpm build:deploy && pnpm verify:delivery` to prune stale files and verify SHA-256 parity.
3. **Verify v5 Native Host registration**: Upgrading from v4 requires registering `com.browserpaw.nativehost` (`browserpaw setup`); v4's `com.chromemcp.nativehost` will not connect to the v5 extension.
4. Close the popup and its DevTools, then click **Reload** in `chrome://extensions`. Refresh any open tabs you use to test content scripts. Compare the build ID from `browserpaw status` with `browserpaw-build.json` in the loaded directory. See the [development rules](development/DEVELOPMENT.md#extension-build-deploy-and-reload-rules).
