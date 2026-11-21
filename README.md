# BrowserPaw

[Simplified Chinese](README.zh-CN.md)

BrowserPaw gives any shell-capable AI Agent fast, deterministic command-line control of your everyday desktop Chrome or Chromium profile—reusing your active logins, cookies, and extensions without starting a separate headless browser or bloating Agent context with dozens of MCP schemas.

The Agent reads the BrowserPaw Agent Skill, runs compact `browserpaw` CLI commands over an authenticated local loopback bridge (`com.browserpaw.nativehost`), and receives concise JSON/text receipts or local file paths for screenshots, traces, and exports.

> **Upgrading from v4.x?** BrowserPaw v5.0.0 replaces the v4 MCP server, REPL, and Jev service with the unified `browserpaw` CLI, standard Agent Skill, and v5 client plugins. Read the [Migration Guide](docs/MIGRATION.md) ([Simplified Chinese](docs/MIGRATION.zh-CN.md)), or ask your Agent to read `docs/MIGRATION.md` and migrate your configuration.

## Quick Start (Recommended: Global Skill + npm + Extension)

Requires **Node.js 22.6+** and desktop Chrome or Chromium on Windows, macOS, or Linux. Install the CLI globally, run `setup` to register the Native Messaging host and install the global Agent Skill (`~/.agents/skills/browserpaw`, Windows `%USERPROFILE%\.agents\skills\browserpaw`), then load the unpacked extension in Chrome or Chromium:

```sh
npm install -g browserpaw@5.0.0
browserpaw setup
```

> **Note on npm availability:** `npm install -g browserpaw@5.0.0` and `npx browserpaw@5.0.0` apply once `5.0.0` is published to npm. For a pre-release local tarball, use `npx --yes --package /path/to/browserpaw-5.0.0.tgz browserpaw setup`.

Open `chrome://extensions` (or `chromium://extensions`), enable **Developer mode**, click **Load unpacked**, and select the extension directory printed by `setup` (default `~/.browserpaw/extension`, Windows `%USERPROFILE%\.browserpaw\extension`), then verify with `browserpaw status`.

| Install Option                             | Best For                                                                    | Command                                               |
| :----------------------------------------- | :-------------------------------------------------------------------------- | :---------------------------------------------------- |
| **Global Skill + npm CLI** _(Recommended)_ | Everyday use across Codex, Claude Code, Cursor, Windsurf, and DSH           | `npm install -g browserpaw@5.0.0 && browserpaw setup` |
| **`npx` / Tarball / Project Skill**        | No global install or workspace-scoped Skill (`./.agents/skills/browserpaw`) | `npx browserpaw@5.0.0 setup --skill-scope project`    |
| **Native Client Plugin**                   | Host-native marketplace/plugin install (read-only base Skill + npm CLI)     | See [Client Plugins](#client-plugins) below           |

- **Setup flags:** `--skill-scope user` (default), `--skill-scope project`, `--skill-dir DIR`, `--no-skill`, and `--browser chromium`.
- See the full multi-path [Installation Guide](INSTALL.md) for human and Agent-assisted onboarding.
- **Upgrades:** Each newer CLI version is announced once on `stderr`. Upgrade the CLI and re-run `browserpaw setup` to refresh the Native Host and managed base Skill; Chrome MV3 extension updates remain manual in `chrome://extensions`. See the [Upgrade guide](INSTALL.md#upgrade-an-existing-v5-installation).

## Client Plugins

All four official client plugins stay synchronized with the canonical `skills/browserpaw/` base skill and v5 CLI. Read-only base skills live inside each host's plugin directory, while evolving self-learned site workflows live separately under `~/.browserpaw` with zero conflict.

| Client               | Package                                                          | Included Capabilities                                                                                | Install                                                                                                                                                              |
| :------------------- | :--------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DeepSeek Harness** | [plugins/browserpaw-dsh](plugins/browserpaw-dsh/README.md)       | Bundles `browserpaw` npm package + read-only base skill + `~/.browserpaw` learned-workflow table     | `dsh plugin --profile web add dsh-browserpaw` then `dsh plugin --profile web exec browserpaw setup --no-skill`                                                       |
| **Hermes Agent**     | [plugins/browserpaw-hermes](plugins/browserpaw-hermes/README.md) | Read-only `browserpaw:browserpaw` skill + unified `browserpaw` CLI tool + `MEDIA:` screenshot output | `npm i -g browserpaw@5.0.0 && browserpaw setup --no-skill` + `hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw-hermes`                             |
| **Claude Code**      | [plugins/browserpaw-claude](plugins/browserpaw-claude/README.md) | Read-only base skill + `SessionStart` hook (CLI check + `~/.browserpaw` learned-workflow context)    | `npm i -g browserpaw@5.0.0 && browserpaw setup --no-skill` + `claude plugin marketplace add GoldenLoaf24h/browserpaw && claude plugin install browserpaw@browserpaw` |
| **ChatGPT / Codex**  | [plugins/browserpaw](plugins/browserpaw/README.md)               | Portable Agent Plugins v1.0.0 base skill + icons (no hooks)                                          | `npm i -g browserpaw@5.0.0 && browserpaw setup --no-skill` + `codex plugin marketplace add GoldenLoaf24h/browserpaw && codex plugin add browserpaw@browserpaw`       |

See [Plugin Compatibility & Spec Boundaries](docs/development/PLUGIN_COMPATIBILITY.md) for why npm auto-installation and hooks differ across host specifications.

## Run

Use `browserpaw help data` for history, bookmarks, downloads, storage and cookies. Use `browserpaw help debug` for network capture, console, performance, device emulation, PDF and CDP.

```text
browserpaw status
browserpaw help
browserpaw search "network"
browserpaw task start research --json
browserpaw open https://example.com --task TASK_ID
browserpaw observe --task TASK_ID
browserpaw text --task TASK_ID
browserpaw screenshot --task TASK_ID --out page.png
browserpaw task finish --task TASK_ID
```

Replace `TASK_ID` with the returned task ID. To operate on an existing page, run `browserpaw tabs` and select it with `--tab ID`. Read [command reference](docs/COMMANDS.md) and the [Agent Skill](skills/browserpaw/SKILL.md) for refs, frames, recipes, and receipts.

Self-learned site skills and saved CLI recipes live under `~/.browserpaw` (`skills/`, `recipes/`, and `learned-index.json`). Run `browserpaw recipe find <query>` or `browserpaw recipe list --all` to discover workflows, `browserpaw recipe save FILE` to create a candidate, `browserpaw recipe patch ID --step INDEX -- ARGS...` to repair one step, and `browserpaw recipe validate ID key=value` to verify a read-only candidate before activation. `browserpaw recipe run ID key=value` executes a workflow directly. Candidates remain outside automatic routing, and successful activation refreshes the installed Skill routing table.

## Troubleshooting & Maintenance

- **Verify bridge & build match**: Run `browserpaw status` (or `browserpaw status --json`) and `browserpaw doctor`. Compare `data.extension.buildId` with `browserpaw-build.json` inside Chrome's loaded extension folder.
- **Repair host registration**: Run `browserpaw doctor --fix` to re-register `com.browserpaw.nativehost`. If upgrading from v4, confirm Chrome is not pointing to the retired v4 `com.chromemcp.nativehost` (port `12306`) or an old unpacked extension copy.
- **Uninstall cleanly**: `browserpaw uninstall` removes the managed host registration and extension copy while preserving learned workflows under `~/.browserpaw`; pass `--purge` to remove BrowserPaw data there as well.

## Security, Privacy & Documentation

- [Security Policy](SECURITY.md) — supported versions, loopback auth, SSRF/path guards, and vulnerability reporting
- [Privacy Policy](PRIVACY.md) — local-first boundaries, update checks, and Chrome permissions
- [Installation Guide](INSTALL.md) · [Migration Guide](docs/MIGRATION.md) · [Architecture](docs/ARCHITECTURE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Plugin Compatibility](docs/development/PLUGIN_COMPATIBILITY.md) · [Release History](docs/releases/README.md)
