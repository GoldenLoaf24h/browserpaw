# BrowserPaw Bundle for DeepSeek Harness (`dsh-browserpaw`)

DeepSeek Harness (`dsh`) Cordis bundle for **BrowserPaw v5.0.0**. One install brings in both the `browserpaw` npm CLI package (`dependencies.browserpaw`) and the read-only canonical `browserpaw` Agent Skill inside the DeepSeek Harness profile directory.

## Why This Layout Works Cleanly

- **Read-only base skill in DSH**: `skills/browserpaw/` is bundled in this plugin and registered on `ctx.skills` with `source: 'runtime'` and `resourceBase`. The Agent does not need to edit or overwrite the base skill.
- **Evolving self-learned workflows in `~/.browserpaw`**: Learned site skills (`~/.browserpaw/skills/`), saved CLI recipes (`~/.browserpaw/recipes/`), and `~/.browserpaw/learned-index.json` remain under `~/.browserpaw`. At load time, `dsh-browserpaw` reads `learned-index.json` (read-only) so active learned workflows appear directly in the skill context with zero file conflict.
- **CLI-first (v5)**: No MCP server, no `@deepseek-ai/dsh-mcp-client` dependency, and no separate tool-schema bloat.

## Installation

> **Quick Start alternative:** For cross-agent setups, the recommended default in the root [README](../../README.md) is global skill + npm (`npm install -g browserpaw@5.0.0 && browserpaw setup`) plus loading the Chrome extension. Use `dsh-browserpaw` when you want a self-contained DeepSeek Harness profile plugin.

1. Install the bundle into your DeepSeek Harness profile (requires `pnpm` and Node.js `>= 22.6.0`):

   ```sh
   # From npm (after v5.0.0 publication)
   dsh plugin --profile web add dsh-browserpaw

   # Or from a local checkout
   dsh plugin --profile web add /absolute/path/to/plugins/browserpaw-dsh
   ```

2. Initialize the local Native Messaging host and extension directory using the profile's bundled CLI (pass `--no-skill` to keep the base skill exclusively inside DSH):

   ```sh
   dsh plugin --profile web exec browserpaw setup --no-skill
   ```

   Running through `dsh plugin --profile web exec` uses the v5 `browserpaw` binary installed inside the DSH profile instead of any stale global `PATH` binary. The registered skill also prints the exact bundled `node "<path>"` entry point.

3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extension directory printed by `setup` (default `~/.browserpaw/extension`).

4. Restart the DSH profile so the new bundle activates, then verify with `dsh plugin --profile web exec browserpaw status`. Newly saved recipes are discoverable immediately via `recipe find` and appear in the plugin's static skill table after restarting the DSH profile.

## Bundle Manifest Declarations

- **`dsh.bundle.patch`** points to `./cordis.patch.yml`, inserting `browserpaw-skill` as a profile bundle layer.
- **`dependencies.browserpaw`** pins `^5.0.0` so DSH installs the `browserpaw` npm CLI alongside the plugin.
- **`engines.dsh`** declares `>=0.2.0-rc.1 <0.3.0-0` (no in-box `@deepseek-ai/*` package is listed in `dependencies`, avoiding duplicate Cordis symbol registration).

## Upgrading from v4 (`dsh-browserpaw` 4.x)

v4's `browserpaw_session` MCP bridge tool and `@deepseek-ai/dsh-mcp-client` integration are retired in v5.0.0. Upgrade `dsh-browserpaw` to `5.0.0`, remove any legacy `127.0.0.1:12306` MCP settings, run `browserpaw setup --no-skill`, and load the v5 Chrome extension. See [docs/MIGRATION.md](../../docs/MIGRATION.md).
