# BrowserPaw for Claude Code

Official BrowserPaw plugin for **Claude Code** (**v5.0.0**). It bundles the read-only canonical BrowserPaw Agent Skill (`skills/browserpaw/`) and a lightweight `SessionStart` hook (`hooks/hooks.json` -> `scripts/session-start.mjs`) that checks local `browserpaw` CLI availability and injects active learned workflows from `~/.browserpaw/learned-index.json` into session context.

## Packaging Capabilities & Boundaries

- **Read-only base skill + dynamic learned routing**: Because Claude Code caches marketplace plugins as read-only version directories, `skills/browserpaw/` stays untouched while self-learned workflows evolve inside `~/.browserpaw`. The `SessionStart` hook bridges the two automatically at session start.
- **No top-level `bin/` directory**: Omitted intentionally so the marketplace remains compatible with `claude.ai` and Cowork organization sync (which reject plugins containing top-level `bin/`).
- **Platform support**: **Claude Code** and **Cowork** run the `SessionStart` hook and can execute the local `browserpaw` CLI (requiring Node.js `>= 22.6.0`, the BrowserPaw CLI, and the Chrome extension). **`claude.ai` Chat** loads the skill instructions only and does not run hooks or the local BrowserPaw CLI.
- **Local behavior and data**: On `SessionStart` (10s timeout), `scripts/session-start.mjs` inspects `PATH`, `CLAUDE_PLUGIN_ROOT`, and `CLAUDE_PLUGIN_DATA` for the `browserpaw` executable and reads `~/.browserpaw/learned-index.json` (up to 64 KiB, symlink-protected) to inject active workflow summaries as session `additionalContext`. The hook makes no outbound network requests and reads no browser cookies, credentials, or session tokens.
- **npm dependency note**: Claude Code's automatic Node.js dependency cache install requires a published npm registry package pinned in `package-lock.json` or `npm-shrinkwrap.json` (registry-only, frozen lockfile, `--ignore-scripts`). Until `browserpaw@5.0.0` is published on npm—and for local marketplace installs loaded in place—install the CLI directly via npm below.

## Installation

> **Quick Start alternative:** For cross-agent setups, the recommended default in the root [README](../../README.md) is global skill + npm (`npm install -g browserpaw@5.0.0 && browserpaw setup`) plus loading the Chrome extension.

1. Install the BrowserPaw CLI, register the Native Messaging host, and load the Chrome extension:

   ```sh
   npm install -g browserpaw@5.0.0
   browserpaw setup --no-skill
   ```

   Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extension directory printed by `setup` (default `~/.browserpaw/extension`).

2. Add the marketplace and install the plugin in Claude Code:

   ```sh
   claude plugin marketplace add GoldenLoaf24h/browserpaw
   claude plugin install browserpaw@browserpaw
   ```

3. Start a new Claude Code session (or run `/reload-plugins`) and verify with `browserpaw status`.

## Upgrading from v4

Remove any legacy v4 `browserpaw` / `chrome-mcp` entries under `mcpServers` in `~/.claude.json`, install `browserpaw@5.0.0`, run `browserpaw setup --no-skill`, reload the v5 Chrome extension, and run `claude plugin update browserpaw@browserpaw`. See [docs/MIGRATION.md](../../docs/MIGRATION.md).
