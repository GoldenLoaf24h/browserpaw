# BrowserPaw Portable Plugin (ChatGPT / Codex / Agent Plugins v1)

Portable Agent Plugins v1.0.0 package for **ChatGPT**, **Codex**, and Agent Plugins hosts that provide local shell execution alongside Chrome or Chromium.

## Packaging Capabilities & Boundaries

- **Base Skill only (by OpenAI spec)**: OpenAI's universal ChatGPT and Codex Plugin Directory does not auto-install npm runtime dependencies (npm marketplace sources download without lifecycle scripts and without `bin/` `PATH` injection), and public directory listings cannot bundle lifecycle hooks. Keeping this package pure (`plugin.json` + `assets/` icons + canonical `skills/browserpaw/`) satisfies the Agent Plugins v1.0.0 schema and Codex interface requirements.
- **Zero conflict with self-learned workflows**: The read-only base skill lives inside this plugin package, while evolving site skills and CLI recipes live under `~/.browserpaw` and are discovered via `browserpaw recipe find` / `browserpaw recipe run`.

## Installation

> **Quick Start alternative:** The recommended default in the root [README](../../README.md) is global skill + npm (`npm install -g browserpaw@5.0.1 && browserpaw setup`) plus loading the Chrome extension, which also auto-syncs learned workflows into `~/.agents/skills/browserpaw/SKILL.md`.

1. Install the BrowserPaw CLI, register the Native Messaging host, and load the Chrome extension:

   ```sh
   npm install -g browserpaw@5.0.1
   browserpaw setup --no-skill
   ```

   Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extension directory printed by `setup` (default `~/.browserpaw/extension`).

2. Add this repository as a Codex plugin marketplace and install the plugin (or pass a local checkout path via `.agents/plugins/marketplace.json` for local development):

   ```sh
   codex plugin marketplace add GoldenLoaf24h/browserpaw
   codex plugin add browserpaw@browserpaw
   ```

   To refresh an existing marketplace checkout later, run `codex plugin marketplace upgrade browserpaw`. Verify the live browser bridge with `browserpaw status`.

## Upgrading from v4

Remove any legacy `[mcp_servers.browserpaw]` or `[mcp_servers.chrome-mcp]` blocks from `~/.codex/config.toml`, install `browserpaw@5.0.1`, run `browserpaw setup --no-skill`, and load the v5 Chrome extension. See [docs/MIGRATION.md](../../docs/MIGRATION.md).

Open [the bundled skill](skills/browserpaw/SKILL.md) for the complete Agent workflow.
