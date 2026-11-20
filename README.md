# BrowserPaw

[Simplified Chinese](README.zh-CN.md)

BrowserPaw gives any shell-capable AI Agent command-line control of your existing Chrome or Chromium profile—reusing your logins, cookies, and extensions. The Agent reads the BrowserPaw Agent Skill, executes `browserpaw` CLI commands, and receives compact receipts or local file references.

> **Upgrading from v4.x?** BrowserPaw v5.0.0 replaces the v4 MCP server, REPL, and Jev service with the unified `browserpaw` CLI, standard Agent Skill, and v5 client plugins. Read the [Migration Guide](docs/MIGRATION.md) ([Simplified Chinese](docs/MIGRATION.zh-CN.md)), or ask your Agent to read `docs/MIGRATION.md` and migrate your configuration.

## Quick Start (Recommended: Global Skill + npm + Extension)

Requires **Node.js 22.6+** and desktop Chrome or Chromium. Install the CLI globally, run `setup` to register the Native Messaging host and install the global Agent Skill (`~/.agents/skills/browserpaw`), then load the unpacked extension in Chrome:

```sh
npm install -g browserpaw@5.0.0
browserpaw setup
```

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extension directory printed by `setup` (default `~/.browserpaw/extension`).

- **Alternative install options:** Run `npx browserpaw@5.0.0 setup` without global install (prefix later calls with `npx --yes browserpaw@5.0.0`), or install a local candidate with `npx --yes --package /path/to/browserpaw-5.0.0.tgz browserpaw setup`.
- **Skill scope & browser flags:** `--skill-scope user` (default `~/.agents/skills/browserpaw`), `--skill-scope project` (`./.agents/skills/browserpaw`), `--skill-dir DIR`, `--no-skill`, and `--browser chromium`.
- See the full multi-path [Installation Guide](INSTALL.md) for human and Agent-assisted onboarding.
- Each new CLI version is announced once. Use the new CLI to refresh its managed base Skill and Native Host, then update the Chrome extension manually. [Upgrade guide](INSTALL.md#upgrade-an-existing-v5-installation)

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

```text
browserpaw status
browserpaw help
browserpaw task start research --json
browserpaw open https://example.com --task TASK_ID
browserpaw observe --task TASK_ID
browserpaw text --task TASK_ID
browserpaw screenshot --task TASK_ID --out page.png
browserpaw task finish --task TASK_ID
```

Replace `TASK_ID` with the returned task ID. To operate on an existing page, run `browserpaw tabs` and select it with `--tab ID`. Read [command reference](docs/COMMANDS.md) and the [Agent Skill](skills/browserpaw/SKILL.md) for refs, frames, recipes, and receipts.

Self-learned site skills and saved CLI recipes live under `~/.browserpaw` (`skills/`, `recipes/`, and `learned-index.json`). Run `browserpaw recipe find <query>` or `browserpaw recipe list --all` to discover workflows, `browserpaw recipe validate ID` to activate a candidate skill, `browserpaw recipe run ID key=value` to call one directly, and `browserpaw recipe save FILE` to teach a new workflow. Saving or validating automatically refreshes the installed Skill routing table so Agents route to learned workflows without extra reminders.

Run `browserpaw doctor` for installation checks and `browserpaw doctor --fix` to repair the registered host. `browserpaw uninstall` removes the managed installation and preserves task and recipe data. `--purge` also removes the BrowserPaw data from its installation directory.

See [installation guide](INSTALL.md), [architecture](docs/ARCHITECTURE.md), [troubleshooting](docs/TROUBLESHOOTING.md), [plugin compatibility](docs/development/PLUGIN_COMPATIBILITY.md), and [release history](docs/releases/README.md).
