# BrowserPaw Installation Guide

A practical setup guide for human users and AI Agents to install, configure, and verify **BrowserPaw v5.0.0**.

> **Upgrading from v4.x?** Read [docs/MIGRATION.md](docs/MIGRATION.md) ([Simplified Chinese](docs/MIGRATION.zh-CN.md)) first to remove retired MCP and REPL configurations before installing v5.

## Architecture Overview

BrowserPaw connects any shell-capable AI Agent to your existing Chrome or Chromium profile through three local parts:

```text
[AI Agent + Base Skill] ──► [browserpaw CLI] ──► [Native Host: com.browserpaw.nativehost (127.0.0.1:12307)]
                                                        │  Chrome Native Messaging
                                                        ▼
                                      [Chrome MV3 Extension (~/.browserpaw/extension)]
```

- **Base Skill**: Instructs the Agent on CLI syntax, task lifecycle, and verification. Lives globally in `~/.agents/skills/browserpaw` (recommended Quick Start), in a project at `./.agents/skills/browserpaw`, or read-only inside an optional client plugin directory.
- **Self-Learned Workflows (`~/.browserpaw`)**: Saved recipes (`recipes/`), verified site skills (`skills/`), and the routing index (`learned-index.json`) always stay in `~/.browserpaw` and never conflict with read-only base skills bundled by client plugins.
- **Windows path equivalents**: Replace `~/.browserpaw` with `%USERPROFILE%\.browserpaw` and `~/.agents/skills/browserpaw` with `%USERPROFILE%\.agents\skills\browserpaw`.

## Choose Your Installation Path

Every setup is different. Pick the path in each row that fits your environment:

| Dimension               | Option A: Recommended Quick Start                                                                              | Option B: Temporary / Project Scope                                                               | Option C: Native Client Plugin                                                          |
| :---------------------- | :------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------- |
| **1. CLI & Host**       | `npm install -g browserpaw@5.0.0` + `browserpaw setup`                                                         | `npx browserpaw@5.0.0 setup` (or `--package ./browserpaw-5.0.0.tgz`)                              | Same npm CLI (bundled automatically by `dsh-browserpaw` in DeepSeek Harness)            |
| **2. Base Skill**       | Global Agent Skill at `~/.agents/skills/browserpaw` (`--skill-scope user`, auto-synced with learned workflows) | Project-local `./.agents/skills/browserpaw` (`--skill-scope project`) or custom `--skill-dir DIR` | Read-only base skill inside the host's plugin directory (`browserpaw setup --no-skill`) |
| **3. Chrome Extension** | Load unpacked from `~/.browserpaw/extension` (printed by `setup`)                                              | Load unpacked from `~/.browserpaw/extension` or `browserpaw-extension.zip`                        | Same unpacked extension from `~/.browserpaw/extension`                                  |
| **4. Browser Target**   | Google Chrome (default)                                                                                        | Chromium (`--browser chromium`)                                                                   | Chrome or Chromium (`--browser chromium`)                                               |

### Protocol for AI Agents Assisting a User

When an AI Agent executes this guide for a user:

1. **Present the choices instead of guessing**: Confirm whether the user wants the recommended Quick Start (global Skill + npm CLI + extension), project-scoped Skill, or a specific client plugin (DeepSeek Harness, Hermes Agent, Claude Code, ChatGPT/Codex).
2. **Guide browser UI steps explicitly**: CLI scripts cannot click **Load unpacked** inside `chrome://extensions`. Complete file installation and Native Host registration first, print the exact extension directory, instruct the user what to click in Chrome, and wait for confirmation.
3. **Verify the live connection**: Run `browserpaw status` and `browserpaw doctor` after the user loads or reloads the extension to confirm the live bridge connection and matching build version.

## Prerequisites

- **Node.js `>= 22.6.0`** (`node -v`)
- **Google Chrome** or **Chromium** on desktop
- Optional: `pnpm` (`12.6.0`) if building from source (note: CLI installation via `dsh plugin --profile ...` requires `pnpm` on `PATH`; DeepSeek Harness Desktop's built-in plugin manager manages installs separately)

## Path 1: Quick Start — Global Skill + npm + Chrome Extension (Recommended)

This single setup works out of the box across Codex, Claude Code, Cursor, Windsurf, DeepSeek Harness, and any Agent that reads standard `~/.agents/skills/`. For **Hermes Agent**, either add `~/.agents/skills` under `skills.external_dirs` in `~/.hermes/config.yaml` or install the native Hermes plugin below (`browserpaw:browserpaw`).

### 1. Install the CLI and run setup

```sh
npm install -g browserpaw@5.0.0
browserpaw setup
```

> **Note on npm availability:** The `npm install -g browserpaw@5.0.0` and `npx browserpaw@5.0.0` commands apply once `5.0.0` is published to npm. For a pre-release tarball or local build, use `npx --yes --package /path/to/browserpaw-5.0.0.tgz browserpaw setup`.

Alternative without global install (after npm publication) or from a local release tarball:

```sh
# npx without global install (prefix later commands with `npx --yes browserpaw@5.0.0`)
npx browserpaw@5.0.0 setup

# Local candidate tarball
npx --yes --package /path/to/browserpaw-5.0.0.tgz browserpaw setup
```

Useful `setup` flags:

- `--skill-scope user` (default): installs the base Skill to `~/.agents/skills/browserpaw`.
- `--skill-scope project`: installs to `./.agents/skills/browserpaw` in the current workspace.
- `--skill-dir DIR`: installs to `DIR/browserpaw`.
- `--no-skill`: skips copying the Skill (use this when a client plugin already provides the base Skill).
- `--browser chromium`: registers Native Messaging for Chromium instead of Google Chrome.

Managed base Skill copies are refreshed automatically by `browserpaw setup`; no force flag is required.

### 2. Load the unpacked Chrome extension

On first setup, `browserpaw setup` installs the host outside npm's cache, registers `com.browserpaw.nativehost`, and prepares the bundled MV3 extension at `~/.browserpaw/extension` (printed in setup output on Windows, macOS, and Linux).

1. Open `chrome://extensions` in Google Chrome (or `chromium://extensions` in Chromium).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `~/.browserpaw/extension` directory printed by `setup`.
4. Click the BrowserPaw toolbar icon to confirm the popup shows **Connected** and **Agent Control** enabled.

Chrome can prompt for the history, bookmarks, and cookies permissions used by the browser data commands. Review them when loading the unpacked extension.

### 3. Verify the live bridge

```sh
browserpaw status
browserpaw doctor
```

`browserpaw status` should report `"connected": true` with extension version `5.0.0`. If the host registration needs repair, run `browserpaw doctor --fix`.

### Upgrade an existing v5 installation

The CLI checks npm's stable `latest` tag at most once every 24 hours per BrowserPaw home. Each newer version is announced once on stderr, including when the command uses `--json`. `BROWSERPAW_NO_UPDATE_CHECK=1` disables the check for offline use and CI.

1. Finish any active browser work. For a global install, run `npm install -g browserpaw@latest` followed by `browserpaw setup`. For npx, run `npx browserpaw@latest setup` and use that version for later commands. Use the same package manager or plugin that installed your CLI.
2. Setup refreshes the Native Host and the base Skills it manages in their existing locations, then regenerates learned routing from `~/.browserpaw`. For a Skill shipped inside a client plugin, run setup with `--no-skill` and update the client plugin through its manager.
3. **Extension updates remain manual**: download `browserpaw-extension.zip` from the [GitHub release](https://github.com/GoldenLoaf24h/browserpaw/releases) matching `browserpaw --version`. Unpack it and select the folder containing `manifest.json` with **Load unpacked** in `chrome://extensions` (or `chromium://extensions`) after disabling the old copy. If you overwrite the files in the folder Chrome already loads, click **Reload** on its existing card. This browser step reconnects the upgraded Native Host.
4. Run `browserpaw status --json`. For build verification, compare `data.extension.buildId` with `browserpaw-build.json` in the folder loaded by Chrome.

## Path 2: Official Client Plugins (Unified v5 Integration)

If you prefer native plugin-manager installation inside a specific Agent host, all four plugins ship the exact same canonical `skills/browserpaw/` base skill while leaving `~/.browserpaw` free for self-learned workflows.

| Client Host                  | Plugin Directory                                                 | What the Plugin Delivers                                                                                           | npm CLI Handling                                                                                                  |
| :--------------------------- | :--------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| **DeepSeek Harness (`dsh`)** | [plugins/browserpaw-dsh](plugins/browserpaw-dsh/README.md)       | Cordis bundle (`dsh-browserpaw`): read-only `browserpaw` skill + `~/.browserpaw` learned-workflow table            | **Bundled** via `dependencies.browserpaw` on `dsh plugin --profile <name> add`                                    |
| **Hermes Agent**             | [plugins/browserpaw-hermes](plugins/browserpaw-hermes/README.md) | Native plugin: read-only `browserpaw:browserpaw` skill + single `browserpaw` CLI tool + `MEDIA:` screenshot output | Install `browserpaw` separately via npm (this plugin declares no bundled Node dependencies)                       |
| **Claude Code**              | [plugins/browserpaw-claude](plugins/browserpaw-claude/README.md) | Marketplace plugin: read-only `browserpaw` skill + `SessionStart` hook for CLI check & `~/.browserpaw` routing     | Install `browserpaw` separately via npm (see [PLUGIN_COMPATIBILITY.md](docs/development/PLUGIN_COMPATIBILITY.md)) |
| **ChatGPT / Codex**          | [plugins/browserpaw](plugins/browserpaw/README.md)               | Portable Agent Plugins v1.0.0 package: read-only `browserpaw` skill + icons (no hooks)                             | Install `browserpaw` separately via npm (OpenAI plugins do not run npm install scripts)                           |

### DeepSeek Harness

```sh
# From npm (after publication) or a local checkout path (requires pnpm on PATH)
dsh plugin --profile web add dsh-browserpaw

# Register host and unpack extension using the profile's bundled CLI
dsh plugin --profile web exec browserpaw setup --no-skill
```

Load the printed `~/.browserpaw/extension` folder in `chrome://extensions`, restart the DSH profile, and run `dsh plugin --profile web exec browserpaw status`.

### Hermes Agent

```sh
npm install -g browserpaw@5.0.0
browserpaw setup --no-skill
hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw-hermes
hermes plugins enable browserpaw
```

If upgrading over an existing `browserpaw` v4 plugin install, pass `--force --no-enable` before enabling (`hermes plugins install --force --no-enable GoldenLoaf24h/browserpaw/plugins/browserpaw-hermes && hermes plugins enable browserpaw`). Load `~/.browserpaw/extension` in `chrome://extensions` and verify with `browserpaw status`. No `mcp_servers` or `mcp_allowlist` configuration is required in v5.

### Claude Code

```sh
npm install -g browserpaw@5.0.0
browserpaw setup --no-skill
claude plugin marketplace add GoldenLoaf24h/browserpaw
claude plugin install browserpaw@browserpaw
```

Load `~/.browserpaw/extension` in `chrome://extensions`, start a new Claude Code session (or run `/reload-plugins`), and verify with `browserpaw status`.

### ChatGPT / Codex (Portable Agent Plugins v1)

```sh
npm install -g browserpaw@5.0.0
browserpaw setup --no-skill
codex plugin marketplace add GoldenLoaf24h/browserpaw
codex plugin add browserpaw@browserpaw
```

Load `~/.browserpaw/extension` in `chrome://extensions`, and verify with `browserpaw status` (to refresh an existing marketplace checkout later, run `codex plugin marketplace upgrade browserpaw`).

## Path 3: Build from Source (Contributors)

```sh
pnpm install
pnpm build
pnpm --filter browserpaw pack --pack-destination .artifacts
npx --yes --package .artifacts/browserpaw-5.0.0.tgz browserpaw setup
```

See [docs/development/DEVELOPMENT.md](docs/development/DEVELOPMENT.md) and [docs/QUALITY.md](docs/QUALITY.md) for local verification gates and deployment checks.

## Uninstall

```sh
browserpaw uninstall
```

By default, `browserpaw uninstall` removes the managed host registration and unpacked extension while preserving learned workflows under `~/.browserpaw`. Pass `--purge` to delete BrowserPaw data inside `~/.browserpaw` as well.

## Troubleshooting & Policies

- **Check live bridge and build identity**: Run `browserpaw status --json` and `browserpaw doctor`. Verify `data.extension.buildId` matches `browserpaw-build.json` in the folder Chrome loaded (if not, reload or re-select the unpacked folder).
- **Repair Native Messaging registration**: Run `browserpaw doctor --fix`. If migrating from v4, confirm Chrome is not running a stale v4 unpacked extension tied to `com.chromemcp.nativehost` (port `12306`) instead of v5 `com.browserpaw.nativehost` (port `12307`).
- **Further help & policies**: [Troubleshooting Guide](docs/TROUBLESHOOTING.md) · [Migration Guide](docs/MIGRATION.md) · [Security Policy](SECURITY.md) · [Privacy Policy](PRIVACY.md)
