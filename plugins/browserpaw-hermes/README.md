# BrowserPaw Plugin for Hermes Agent

Native Hermes Agent plugin for **BrowserPaw v5.0.1**. It bundles the read-only canonical BrowserPaw Agent Skill (`ctx.register_skill("browserpaw", ...)`) and exposes one unified `browserpaw` tool backed by the local `browserpaw` CLI — with zero MCP configuration, zero bridge tokens, and `MEDIA:<path>` screenshot output formatted for Hermes messaging gateways.

## Architecture & Separation

- **Read-only base skill in Hermes**: Loaded via `ctx.register_skill("browserpaw", SKILL.md)` under the `browserpaw:browserpaw` namespace without writing into `~/.hermes/skills/`.
- **Self-learned workflows in `~/.browserpaw`**: Evolving site skills (`~/.browserpaw/skills/`), saved CLI recipes (`~/.browserpaw/recipes/`), and `~/.browserpaw/learned-index.json` stay in `~/.browserpaw` and are discovered through `browserpaw recipe find` / `browserpaw recipe run`.
- **Single unified CLI tool**: Replaces the 18 v4 MCP wrapper tools with one `browserpaw` tool (`args: string[]`) that invokes the `browserpaw` binary directly (`shell=False`) and returns both `"media": [...]` and `MEDIA:<path>` lines when `browserpaw screenshot` produces local image files (preserve `MEDIA:<path>` verbatim in the final reply for Hermes gateway image delivery).

## Installation

> **Note on npm dependency:** This plugin declares no bundled Node dependencies; install the `browserpaw` npm CLI separately once, then install this Hermes plugin. (Alternatively, see the root [README](../../README.md) Quick Start for global skill + npm installation.)

1. Install the BrowserPaw CLI, register the local Native Messaging host, and load the Chrome extension:

   ```sh
   npm install -g browserpaw@5.0.1
   browserpaw setup --no-skill
   ```

   Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extension directory printed by `setup` (default `~/.browserpaw/extension`).

2. Install and enable the Hermes plugin:

   ```sh
   hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw-hermes
   hermes plugins enable browserpaw
   ```

3. Optional plugin settings in `~/.hermes/config.yaml`:

   ```yaml
   plugins:
     enabled:
       - browserpaw
     entries:
       browserpaw:
         settings:
           cli_path: '' # Optional absolute path if browserpaw is not on PATH
           timeout_seconds: 120
   ```

## Security & Behavioral Disclosures

- **Local CLI execution**: Invokes the local `browserpaw` executable via `subprocess.run(..., shell=False, stdin=subprocess.DEVNULL)` with validated argv tokens; never invokes a shell interpreter, never executes arbitrary binaries outside `browserpaw` (or operator-configured `cli_path`), and sets `BROWSERPAW_NO_AUTO_UPDATE=1` / `BROWSERPAW_NO_UPDATE_CHECK=1` so agent tool calls never download CLI updates.
- **File-safety enforcement**: Model-supplied write paths (`--out` / `--out=`) are checked with Hermes `agent.file_safety.is_write_denied` and confined strictly to `~/.browserpaw/out` (symlinks, traversal, NT/device namespaces, and UNC paths are refused). Model-supplied read paths (`--input`, `--file`, `upload` file operands, `recipe save FILE`, `batch FILE`, plus nested batch and recipe steps) are checked with Hermes `agent.file_safety.raise_if_read_blocked` and credential-store guards. `--skill-dir` is refused.
- **Installer command guard**: Agent calls to host-management subcommands (`setup`, `uninstall`, and `doctor --fix`) are refused; those commands remain user-only. Read-only `doctor` and `status` remain available.
- **Local browser control**: Commands communicate through `browserpaw` and Chrome Native Messaging (`com.browserpaw.nativehost` on loopback port `12307`) with the user's loaded Chrome extension.
- **No credentials or third-party network calls**: The plugin reads no secrets, tokens, or browser profile files and makes no outbound network requests itself.

## Upgrading from v4 (`browserpaw-hermes` 4.x)

v4's 18 `browserpaw_*` MCP wrappers, `mcp_servers.browserpaw`, and `mcp_allowlist` entries are no longer used in v5.0.0. Remove the legacy `mcp_servers.browserpaw` block and `mcp_allowlist` from `~/.hermes/config.yaml`, install `browserpaw@5.0.1` via npm, run `browserpaw setup --no-skill`, reload the v5 Chrome extension, and replace the installed Hermes plugin with:

```sh
hermes plugins install --force --no-enable GoldenLoaf24h/browserpaw/plugins/browserpaw-hermes
hermes plugins enable browserpaw
```

See [docs/MIGRATION.md](../../docs/MIGRATION.md).
