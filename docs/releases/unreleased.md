# BrowserPaw Unreleased Changes Ledger

This ledger tracks changes queued after the current release baseline.

- All changes through v5.0.1 (including the v5.0.0 CLI transition, on-demand CLI auto-update, 17 built-in read-only recipes, extension security/MV3 hardening, DOM hot-path modularization, and AGPL license alignment) have been consolidated into [v5.0.1](./v5.0.1.md).
- Pre-v5 architectural reviews, retired design notes, and legacy MCP test records are preserved under [docs/archive/](../archive/README.md).

## Queued Post-v5.0.1 Changes

- **Conditional Chrome Extension Releases & Asset-Aware Popup Update Check:** Made `browserpaw-extension.zip` optional in `scripts/release-notes.mjs`, `docs/releases/TEMPLATE.md`, and `docs/releases/RELEASING.md` so releases without extension changes omit the extension archive; updated `checkVersionUpdate` / `checkExtensionVersionUpdate`, the extension popup footer badge, and CLI status/setup release URLs (`LATEST_EXTENSION_VERSION`) to only flag extension updates for published GitHub releases that actually attach `browserpaw-extension.zip`.
