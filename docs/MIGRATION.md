# Migrating to BrowserPaw v5.0.0 (For Users and AI Agents)

[Simplified Chinese](MIGRATION.zh-CN.md)

BrowserPaw v5.0.0 replaces the v4.x MCP server, persistent REPL, Jev service, and legacy MCP client wrappers with a single CLI-first package (`browserpaw`), a standard Agent Skill (`~/.agents/skills/browserpaw`), unified v5 client plugins (DeepSeek Harness, Hermes Agent, Claude Code, and ChatGPT/Codex), a Jev-free Chrome MV3 connector extension (`com.browserpaw.nativehost` on loopback port `12307`), and a self-learning workflow directory (`~/.browserpaw`).

Both **human users** and **AI Agents** can follow this guide end to end. To delegate migration to an Agent, instruct it:

```text
Read docs/MIGRATION.md and migrate my local BrowserPaw setup from v4 to v5.0.0.
```

## 1. What Changed from v4.x to v5.0.0

| Area                   | BrowserPaw v4.x (Legacy)                                                                 | BrowserPaw v5.0.0 (Current)                                                                                                                          |
| :--------------------- | :--------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary Entrypoint** | MCP HTTP (`http://127.0.0.1:12306/mcp`), SSE, stdio bridge, or `browserpaw session` REPL | `browserpaw` CLI commands executed directly by the Agent or user                                                                                     |
| **Agent Integration**  | Client MCP tool schemas (`chrome_*` / `mcp__browserpaw__*`) and MCP wrapper plugins      | Quick Start: global Agent Skill (`~/.agents/skills/browserpaw`) + npm CLI; optional v5 plugins for DSH, Hermes, Claude Code, and Codex/ChatGPT       |
| **Native Host & Port** | `com.chromemcp.nativehost` on port `12306`                                               | `com.browserpaw.nativehost` on default loopback port `12307` (`~/.browserpaw/host`)                                                                  |
| **Chrome Extension**   | Legacy MCP switch + Jev configuration popup                                              | Compact v5 popup with connection status, Agent Control, cursor and window settings, and a version update dot. Installed at `~/.browserpaw/extension` |
| **Multi-Step State**   | MCP session state or `browserpaw session create/call/close`                              | Explicit task IDs via `browserpaw task start` and `--task TASK_ID` across CLI calls                                                                  |
| **Learned Workflows**  | `chrome_skill` MCP tool and versioned site notes                                         | `~/.browserpaw` (`skills/`, `recipes/`, `learned-index.json`) via `browserpaw recipe ...` with automatic `SKILL.md` routing sync                     |

## 2. Step-by-Step Migration Checklist (Agent & User Executable)

### Step 1: Remove Legacy v4 MCP and Wrapper Configurations

1. **Remove MCP server entries** named `browserpaw`, `chrome-mcp`, or `mcp-chrome` pointing to `127.0.0.1:12306`, stdio bridges, or legacy `npx` MCP runners from your Agent configuration files:
   - **Codex:** `~/.codex/config.toml` (remove `[mcp_servers.browserpaw]` or `[mcp_servers.chrome-mcp]` blocks)
   - **Claude Code / Claude Desktop:** `~/.claude.json` or `claude_desktop_config.json` (remove `browserpaw` / `chrome-mcp` under `mcpServers`)
   - **Cursor / Windsurf / Other MCP Clients:** remove `browserpaw` / `chrome-mcp` from the client's `mcp.json` or MCP settings
   - **Hermes Agent:** remove `mcp_servers.browserpaw` and `plugins.entries.browserpaw.mcp_allowlist` from `~/.hermes/config.yaml`, then upgrade to the v5 CLI-backed plugin (`plugins/browserpaw-hermes`) or switch to the global Skill.
   - **DeepSeek Harness (`dsh`):** upgrade `dsh-browserpaw` from v4 (MCP `browserpaw_session`) to v5.0.0 (which bundles the `browserpaw` npm CLI and canonical Skill with no `@deepseek-ai/dsh-mcp-client` dependency), or switch to the global Skill.
2. **Remove outdated system prompts or custom instructions** that tell the Agent to call `mcp__browserpaw__*`, `chrome_read_dom`, `chrome_interact_index`, `chrome_tool_docs`, or `browserpaw session ...`.
3. **Stop any lingering v4 processes** listening on port `12306` if present.
4. **Uninstall the legacy v4 global npm package** (`npm uninstall -g mcp-chrome-bridge`) if installed, so an old `browserpaw` shim on `PATH` does not shadow the v5 CLI (`browserpaw --version` should report `5.0.0` after Step 2).

### Step 2: Install BrowserPaw v5.0.0 CLI, Host, and Agent Skill

Run the recommended Quick Start (requires Node.js 22.6 or later):

```sh
# Option A (Recommended Quick Start): Global npm install + global Agent Skill + extension unpack
npm install -g browserpaw@5.0.0
browserpaw setup

# Option B: Direct setup with npx (no global install)
npx browserpaw@5.0.0 setup

# Option C: From a local release tarball
npx --yes --package /path/to/browserpaw-5.0.0.tgz browserpaw setup
```

**Skill Scope Options during `setup`:**

- **Default user scope (`--skill-scope user`):** installs the Agent Skill to `~/.agents/skills/browserpaw` so all projects and compatible Agents discover it automatically.
- **Project scope (`--skill-scope project`):** installs the Agent Skill into the current workspace at `./.agents/skills/browserpaw`.
- **Custom directory (`--skill-dir DIR`):** installs the Agent Skill to `DIR/browserpaw`.
- **Skip Skill copy (`--no-skill`):** installs only the Native host and unpacked extension under `~/.browserpaw`.
- **Browser registration:** `--browser chromium` registers Chromium only, while `--browser all` registers both Chrome and Chromium.

#### Optional: Upgrade or Install a v5 Client Plugin

If you prefer a host-managed plugin (read-only base skill inside the host's plugin directory, while self-learned workflows remain in `~/.browserpaw`), run `browserpaw setup --no-skill` and install the v5 plugin for your client:

- **DeepSeek Harness (bundles npm CLI + base Skill):** `dsh plugin --profile web add dsh-browserpaw` then `browserpaw setup --no-skill`
- **Hermes Agent (base Skill + unified `browserpaw` CLI tool + `MEDIA:` screenshots):** `hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw-hermes && hermes plugins enable browserpaw`
- **Claude Code (base Skill + `SessionStart` hook for CLI check & `~/.browserpaw` routing):** `claude plugin marketplace add GoldenLoaf24h/browserpaw && claude plugin install browserpaw@browserpaw`
- **ChatGPT / Codex (Portable Agent Plugins v1 base Skill):** `codex plugin marketplace add GoldenLoaf24h/browserpaw && codex plugin add browserpaw@browserpaw`

See [INSTALL.md](../INSTALL.md) and [Plugin Compatibility](development/PLUGIN_COMPATIBILITY.md) for details.

### Step 3: Load or Reload the v5 Chrome Extension (User Browser Step)

The first `browserpaw setup` prepares the v5 extension at `~/.browserpaw/extension` (on Windows, `%USERPROFILE%\.browserpaw\extension`). Load it manually when migrating from v4:

1. Open `chrome://extensions` in Chrome (or `chromium://extensions` in Chromium).
2. Enable **Developer mode** in the top-right corner.
3. Remove or disable any old v4 BrowserPaw / Chrome MCP extension loaded from an older repository or release folder.
4. Click **Load unpacked** and select the `~/.browserpaw/extension` path printed by `browserpaw setup` (or click **Reload** on the existing card if it already points to `~/.browserpaw/extension`).

For later v5 updates, follow [Upgrade an existing v5 installation](../INSTALL.md#upgrade-an-existing-v5-installation). Setup refreshes the host and managed base Skills. Download, unpack, and load the matching Chrome ZIP manually.

The v5 browser data commands use the extension's `history`, `bookmarks` and `cookies` permissions. Review these permissions when Chrome prompts during the installation or reload. After loading, run `browserpaw status --json` and compare the reported build ID with `browserpaw-build.json` in the selected directory.

### Step 4: Verify Connection and Learned Workflow Routing

Run the verification commands:

```sh
browserpaw status
browserpaw doctor
```

- `browserpaw status` should report `"connected": true` and extension version `5.0.0`.
- If registration is missing or stale, run `browserpaw doctor --fix`.
- Check available learned workflows and recipes with:

```sh
browserpaw recipe list --all
browserpaw recipe find search
```

- Any bundled or newly proposed `candidate` skill in `~/.browserpaw` can be verified and activated once against a live Chrome session with `browserpaw recipe validate ID`. Validating or saving a workflow automatically refreshes the routing table in your installed `SKILL.md`.

## 3. Command Migration Reference (v4 MCP / REPL to v5 CLI)

Use this mapping when updating Agent skills, automation scripts, or manual workflows from v4 to v5:

| v4.x MCP Tool or REPL Command                       | v5.0.0 CLI Equivalent                                                                  | Notes                                                                                |
| :-------------------------------------------------- | :------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| `chrome_task` / `browserpaw session create`         | `browserpaw task start NAME --json`                                                    | Returns a `taskId`; pass `--task TASK_ID` on subsequent commands                     |
| `browserpaw session close`                          | `browserpaw task finish --task TASK_ID`                                                | Completes the task and cleans up task-owned temporary state                          |
| `chrome_navigate`                                   | `browserpaw open URL [--task TASK_ID]` / `browserpaw nav back\|forward\|reload`        | Also returns `matchedRecipes` hints when the URL matches a learned workflow          |
| `get_windows_and_tabs`                              | `browserpaw tabs`                                                                      | Lists open browser tabs and their tab IDs                                            |
| `chrome_switch_tab` / `chrome_close_tabs`           | `browserpaw tab focus TAB_ID` / `browserpaw tab close TAB_ID...`                       | Use `browserpaw task borrow TAB_ID --task TASK_ID` to bind an existing tab to a task |
| `chrome_read_dom` / `chrome_get_web_content`        | `browserpaw observe [--task TASK_ID]` / `browserpaw text` / `browserpaw find QUERY`    | `observe` returns interactive refs (`r1`, `r2`, ...) and frame coverage              |
| `chrome_interact_index` / `chrome_click_element`    | `browserpaw click TARGET` / `browserpaw hover TARGET` / `browserpaw press KEY`         | `TARGET` can be an observed ref, CSS selector, text, role, or label locator          |
| `chrome_computer` (coordinates / drag / scroll)     | `browserpaw click @X,Y --capture ID` / `browserpaw drag SRC DST` / `browserpaw scroll` | Coordinate clicks require `--capture ID` from a fresh `screenshot` on the same tab   |
| `chrome_fill_index` / `chrome_fill_or_select`       | `browserpaw fill TARGET -- VALUE` / `browserpaw select TARGET VALUE`                   | Use `--input FILE` for large or multiline text payloads                              |
| `chrome_upload_file`                                | `browserpaw upload TARGET FILE...`                                                     | Uploads one or more local files to a file input target                               |
| `chrome_screenshot`                                 | `browserpaw screenshot --out FILE.png [--task TASK_ID]`                                | Writes image to disk and returns a capture ID for `@X,Y` actions                     |
| `chrome_network_capture` / `chrome_console`         | `browserpaw network ...` / `browserpaw console`                                        | Scoped network inspection and console reading                                        |
| `chrome_javascript` / `chrome_fetch` / `chrome_cdp` | `browserpaw eval` / `browserpaw fetch` / `browserpaw cdp`                              | Explicit page-context evaluation, fetch, and supported CDP calls                     |
| `chrome_handle_dialog` / `chrome_ask_human`         | `browserpaw dialog` / `browserpaw ask-human`                                           | Handles JS dialogs or pauses for human completion of auth/challenges                 |
| `chrome_download`                                   | `browserpaw download REF` / `browserpaw download --url URL --out DIR`                  | Returns verified download file receipt and provenance                                |
| `chrome_skill`                                      | `browserpaw recipe list\|find\|show\|run\|save\|validate\|rm`                          | Stores and routes learned workflows under `~/.browserpaw`                            |
| `chrome_tool_docs`                                  | `browserpaw help` / `browserpaw help COMMAND`                                          | Offline command discovery built into the installed CLI                               |

Use `browserpaw window list` for window IDs and `browserpaw select TARGET` to read available choices. The earlier v5 candidate spellings `tabs --windows` and `select TARGET --list` remain accepted for existing scripts. Pass an ID from `network list` (`requests[].id`) to `network show ID`.

Run `browserpaw help data` for history, bookmarks, downloads, storage and cookies. Run `browserpaw help debug` for network, console, performance, emulation, PDF and CDP. See [Commands](COMMANDS.md), the [Agent Skill](../skills/browserpaw/SKILL.md), and [Troubleshooting](TROUBLESHOOTING.md) for full details.
