# BrowserPaw Setup & Onboarding Guide

This document is the authoritative onboarding guide for **AI Agents** (ChatGPT / Codex, Hermes, Claude Code, Cursor, Windsurf, and other MCP-capable clients) and human developers setting up BrowserPaw.

> **Enjoying BrowserPaw?** If this project saves you time, please consider giving it a star on GitHub — it helps the project grow and keeps improvements coming: https://github.com/GoldenLoaf24h/browserpaw

---

## 0. Prerequisites & System Preflight

Before beginning installation, verify the following system requirements:

- **Node.js**: Version >= 20.0.0 (`node -v`).
- **Package Manager**: `pnpm` recommended. If not installed, run:
  ```bash
  npm install -g pnpm
  ```
- **Supported Browser**: Google Chrome (recommended), Microsoft Edge, Brave, or Opera.

---

## Step 1: Workspace & Build

Choose the installation route matching your current environment:

### Route A: Already Inside Workspace Root

If this repository is already cloned into your current working directory:

```bash
pnpm install
pnpm build
```

### Route B: Fresh Clone from Scratch

If starting from an empty workspace:

```bash
git clone https://github.com/GoldenLoaf24h/browserpaw.git
cd browserpaw
pnpm install
pnpm build
```

### Route C: Zero-Compile Prebuilt Release

If you prefer not to build from source, download the pre-compiled packages directly from [GitHub Releases](https://github.com/GoldenLoaf24h/browserpaw/releases/latest):

- Extension: `browserpaw-extension-v*.zip` (unzip to a persistent local folder).
- Skill: `browserpaw-skill-v*.zip`.

---

## Step 2: Register Native Messaging Host (One-Time OS Binding)

Register BrowserPaw's Native Messaging manifest with your local operating system:

```bash
cd app/native-server
node dist/scripts/register-dev.js
```

**What this does:**

- **Windows**: Registers `com.chromemcp.nativehost` in the Registry under `HKCU\Software\Google\Chrome\NativeMessagingHosts`.
- **macOS**: Places the manifest JSON under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
- **Linux**: Places the manifest JSON under `~/.config/google-chrome/NativeMessagingHosts/`.
- **Security Token**: Automatically generates a high-entropy authentication token at `~/.chrome-mcp/bridge-token` (Windows: `%USERPROFILE%\.chrome-mcp\bridge-token`).

---

## Step 3: Load the Extension into Chrome / Edge

Prompt the user with the following clear instruction:

1. Open `chrome://extensions` (or `edge://extensions`) in your browser.
2. Enable **Developer mode** via the toggle in the top-right corner.
3. Click **Load unpacked** (or drag & drop the folder into the window) and select:
   ```text
   <repo-root>/app/chrome-extension/.output/chrome-mv3
   ```
   _(Or the extracted folder if using prebuilt release)_.
4. Confirm that **BrowserPaw** appears in your extensions list with status enabled.

---

## Step 4: Silent Debugger Mode (Zero-Jitter UX Optimization)

Chrome displays a native top notification bar (_"BrowserPaw is debugging this browser"_) whenever CDP is active. This can cause minor page height jitter during automation.

Ask the user:

> _"Would you like me to enable Chromium Silent Debugger Mode? This adds `--silent-debugger-extension-api` to your Chrome shortcut to permanently hide the top debugging bar for zero page jitter."_

If the user agrees:

### Windows (Automated PowerShell Script)

Run this script to locate and append the flag to the user's Desktop Chrome shortcut:

```powershell
$wsh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "Google Chrome.lnk"
if (Test-Path $shortcutPath) {
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    if ($shortcut.Arguments -notmatch "--silent-debugger-extension-api") {
        $shortcut.Arguments = "$($shortcut.Arguments) --silent-debugger-extension-api".Trim()
        $shortcut.Save()
        Write-Host "Chrome shortcut updated with --silent-debugger-extension-api"
    } else {
        Write-Host "Silent debugger flag already present on shortcut."
    }
} else {
    Write-Host "Chrome desktop shortcut not found at $shortcutPath"
}
```

### macOS

Launch Chrome from terminal or update the application launch args:

```bash
open -a "Google Chrome" --args --silent-debugger-extension-api
```

---

## Step 5: Enable Jev Semantic Engine (Recommended for Speed)

BrowserPaw's on-page autonomy (`chrome_act_toward_goal`) runs on **Jev**, a fast semantic decision model from TypeSafe. Without an API key it still works, but falls back to the slower heuristic engine with reduced step budgets — page interactions feel noticeably less snappy (roughly 2-5x slower per decision step).

To unlock full-speed Jev:

1. Get a free API key: register at https://typesafe.ai/blog/introducing-system-one-models-and-jev
2. Set the environment variable before starting your agent / the native bridge:

**Windows (PowerShell, persistent for current user):**

```powershell
[Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", "your-key-here", "User")
$env:TYPESAFE_API_KEY = "your-key-here"   # makes it available in the current session immediately
```

**macOS / Linux (bash/zsh):**

```bash
export TYPESAFE_API_KEY="your-key-here"
# To persist, add the line above to ~/.bashrc or ~/.zshrc
```

3. Restart your agent client (or the native bridge if running standalone) so it picks up the variable.

> No key, or invalid key? BrowserPaw automatically degrades to the deterministic heuristic engine — nothing breaks, decisions are just slower and more conservative.

---

## Step 6: Connect to Your AI Agent (Plugin vs. Manual MCP)

BrowserPaw supports two connection modes:

- **Mode A (Recommended): Zero-Config Plugin**: If your agent platform (Codex Desktop, Hermes) supports native plugins, install the plugin once and tools are auto-discovered without touching JSON/TOML files.
- **Mode B: Manual MCP Server**: For Cursor, Claude Desktop, Windsurf, or custom agent setups.

---

### Mode A: Zero-Config Plugin (Codex Desktop & Hermes)

#### 1. Hermes Agent (Native Plugin)

```bash
hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw
hermes plugins enable browserpaw
```

#### 2. Codex Desktop App (Marketplace Plugin)

If installing via the Codex Plugin Marketplace:

1. Add the BrowserPaw plugin via the Codex Marketplace or by adding this repository URL.
2. **Note on Backend**: The plugin mode expects the local server or stdio bridge to be accessible. For the most robust, zero-maintenance setup where Codex automatically manages the server lifecycle, the **Direct Stdio Configuration** (detailed in Section 6.1 below) is strongly recommended.
3. **Critical: Start a New Thread / Task**: Codex injects MCP tool declarations only when a new task initializes. Always start a fresh conversation after setup.

---

### Mode B: Direct MCP Server Configuration (Recommended for Codex, Cursor, Claude)

Add BrowserPaw to your agent client's MCP configuration:

Config file locations by operating system:

- **Windows**: `%APPDATA%\\<Client>\\<config>.json`
- **macOS**: `~/Library/Application Support/<Client>/<config>.json`
- **Linux**: `~/.config/<Client>/<config>.json`

---

### 6.1 Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

### 6.2 Claude Desktop & Claude Code (`claude_desktop_config.json`)

Config path: Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

### 6.3 Windsurf / Cascade (`~/.codeium/windsurf/mcp_config.json`)

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

### 6.1 Codex Desktop & CLI (Best Practice / Recommended)

For Codex, configuring a **Stdio Server** directly in `config.toml` is the **best and most reliable method**.

**Why Stdio is best for Codex:**

- **Zero Maintenance**: Codex automatically launches the bridge on demand and tears it down when finished. You never need to manually start a background server process in a separate terminal.
- **Automatic Token Auth**: The stdio bridge manages internal Fastify tokens and WebSocket sessions seamlessly.
- **Direct Environment Injection**: You can supply your Jev `TYPESAFE_API_KEY` right in the config block without messing with Windows/macOS global system environment variables or restarting your computer.

**Configuration File Location:**

- **Windows**: `%USERPROFILE%\.codex\config.toml` (e.g. `C:\Users\<YourUsername>\.codex\config.toml`)
- **macOS / Linux**: `~/.codex/config.toml`

Add the following block to your `config.toml`:

```toml
[mcp_servers.browserpaw]
command = "node"
# Windows: use forward slashes or escaped backslashes (e.g., "D:/workspace/browserpaw/app/native-server/dist/mcp/mcp-server-stdio.js")
# macOS/Linux: use absolute path (e.g., "/Users/<username>/workspace/browserpaw/app/native-server/dist/mcp/mcp-server-stdio.js")
args = ["<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js"]
startup_timeout_sec = 60

[mcp_servers.browserpaw.env]
# "full" exposes all 50 registered tools (including autonomous micro-loop chrome_act_toward_goal)
CHROME_MCP_TOOL_PROFILE = "full"
# Optional: Inject your Jev API key directly here for instant ultra-fast 200ms autonomy
TYPESAFE_API_KEY = "your-typesafe-api-key-here"
```

> **Critical**: After saving `config.toml`, you **must start a New Task / Thread** in Codex Desktop. Codex only loads and registers MCP tools at the moment a task initializes!

---

### 6.2 Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

### 6.3 Claude Desktop & Claude Code (`claude_desktop_config.json`)

Config path: Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

### 6.4 Windsurf / Cascade (`~/.codeium/windsurf/mcp_config.json`)

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<repo-root>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

### 6.5 ChatGPT Desktop App (HTTP Transport)

For clients supporting HTTP Streamable MCP with custom headers:

```json
{
  "mcpServers": {
    "browserpaw": {
      "url": "http://127.0.0.1:12306/mcp",
      "headers": {
        "x-mcp-token": "PASTE_TOKEN_FROM_~/.chrome-mcp/bridge-token"
      }
    }
  }
}
```

### 6.5 Hermes Agent

#### Option A: Native Plugin (Recommended — installs core tools + skill together)

```bash
hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw
hermes plugins enable browserpaw
```

#### Option B: MCP Server Add (HTTP transport — works on Windows / macOS / Linux identically)

```bash
hermes mcp add browserpaw --url http://127.0.0.1:12306/mcp --auth header

When prompted for headers, enter `x-mcp-token: <TOKEN_FROM_~/.chrome-mcp/bridge-token>`.
```

---

## Step 7: Install the Agent Skill

If your agent supports skill definitions, install the bundled BrowserPaw operator skill.

> **Important**: Always copy the **entire `skill/` directory** including its `references/` subdirectory (containing `tool-cheatsheet.md`, `dual-brain-jev.md`, etc.). Do not copy just `SKILL.md` alone, as the agent relies on the references to look up parameter details for all 50 tools.

- **Codex Desktop / CLI**:
  Copy the full `skill/` directory contents to `%USERPROFILE%\.codex\skills\browserpaw\` (macOS/Linux: `~/.codex/skills/browserpaw/`).

  _Windows PowerShell Quick Command:_

  ```powershell
  $target = "$env:USERPROFILE\.codex\skills\browserpaw"
  if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force }
  Copy-Item -Path "skill\*" -Destination $target -Recurse -Force
  ```

  _macOS / Linux Command:_

  ```bash
  mkdir -p ~/.codex/skills/browserpaw
  cp -R skill/* ~/.codex/skills/browserpaw/
  ```

- **Hermes Agent**: Installed automatically when loading the plugin (`skill_view("browserpaw:browserpaw")`).
- **Claude Code**: Copy the `skill/` folder to `.claude/skills/browserpaw/`.
- **Any other MCP-capable agent**: Copy the `skill/` folder into that client's designated skills directory.

---

## Step 8: System Verification & Health Check

Verify that all BrowserPaw components are functioning with the built-in doctor:

```bash
node skill/config/doctor.mjs
```

**Expected Output:**

```text
[PASS] Node.js Environment: v22.x on win32
[PASS] Bridge Token Found: C:\Users\<user>\.chrome-mcp\bridge-token
[PASS] Native Bridge Server is Listening (Port 12306)
[PASS] Token Authentication & MCP Initialize OK
[PASS] Extension Build Found: D:\workspace\...
[PASS] Standalone Directory Synced: D:\workspace\browserpaw
[PASS] Native Messaging Host Registered in Chrome
----------------------------------------------------------------
Diagnostic Complete: 7 Passed, 0 Failed.
STATUS: [HEALTHY] All BrowserPaw layers are operating normally!
```

If any check fails, consult **[docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)** for instant self-healing remedies.

---

## Support the Project

If BrowserPaw has been useful in your workflow, a GitHub star is the fastest way to support continued development:
https://github.com/GoldenLoaf24h/browserpaw
