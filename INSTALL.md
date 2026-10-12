# BrowserPaw Installation & Onboarding Guide

An authoritative, step-by-step onboarding guide for **AI Agents** (Codex Desktop, Hermes, Claude Code, Cursor, Windsurf, ChatGPT) and human developers to install, configure, and operate BrowserPaw.

> **Star on GitHub**: If BrowserPaw accelerates your automation workflows, please consider starring the project: https://github.com/GoldenLoaf24h/browserpaw

---

## Overview & Setup Flow

1. Install the extension from a release package or build it from source.
2. Register the Native Messaging Host from the repository build.
3. Connect an MCP client using Stdio or HTTP transport.
4. Optionally configure Jev and pin the extension.
5. Optionally enable Chromium's silent debugger flag.
6. Install agent skills if your client supports them.
7. Run the diagnostic script and resolve any reported issues.

## Prerequisites

- **Source installation:** Node.js `>=22.6.0` and pnpm `12.6.0` (the version declared by this repository's `package.json`).
- **Release extension installation:** Google Chrome and a supported Node.js runtime for the native server. The extension ZIP does not include the Native Messaging server or registration script; clone the repository and build it before continuing with Step 2.
- **Local Jev mode:** Python plus the decider runtime dependencies (uvicorn, torch, and transformers) must be installed in the BrowserPaw virtual environment at ~/.browserpaw/venv, or available to the system Python. If they are unavailable, use Remote mode or Off.

Commands below are written for a shell opened at the repository root unless noted otherwise.

---

## Step 1: Install BrowserPaw Chrome Extension

Choose the installation option matching your environment:

### Option A: Pre-built Release (Recommended for Most Users — No Build Required)

1. Download the latest `browserpaw-extension-v*.zip` from **[GitHub Releases](https://github.com/GoldenLoaf24h/browserpaw/releases/latest)**.
2. Extract the ZIP archive into a persistent local folder (e.g., `~/browserpaw-extension` or `D:\browserpaw-extension`).

### Option B: Local Repository Build (For Developers)

If you have cloned this repository locally, build the extension package:

```bash
pnpm install
pnpm build
```

The unpacked extension will be output to: `<repo-root>/app/chrome-extension/.output/chrome-mv3`.

> **Local Development & Deployment Synchronization:**
> The default build output is located at `<repo-root>/app/chrome-extension/.output/chrome-mv3`. To stage the unpacked extension to a custom local directory, configure `extensionSyncDir` in `browserpaw.local.json` or set the `BROWSERPAW_EXTENSION_SYNC_DIR` environment variable and run `pnpm build:deploy`. Standard pnpm build skips deployment synchronization by default. If no target directory is configured, pnpm build:deploy fails with an error rather than silently succeeding.

---

### Loading into Google Chrome

> **AI Agent Guidance:** You can assist the user by opening `chrome://extensions/` in Google Chrome.

1. In Google Chrome, navigate to **`chrome://extensions/`**.
2. Enable **Developer mode** via the toggle switch in the top-right corner.
3. Either:
   - Click the **Load unpacked** button and select the extracted extension folder (for local builds on Windows, either your configured local staging directory or `<repo-root>/app/chrome-extension/.output/chrome-mv3`).
   - Or drag and drop the extension folder directly into the `chrome://extensions/` page.
4. Verify that **BrowserPaw** appears in your extensions list with its status enabled.

---

## Step 2: Register Native Messaging Host (One-Time OS Binding)

The Native Messaging Host provides high-speed, secure IPC between Chrome and your local AI Agent clients.

This step requires a source checkout with the native server built. A prebuilt extension ZIP alone does not include this server. From the repository root, run:

```bash
node app/native-server/dist/scripts/register-dev.js
```

The registration script writes the Native Messaging manifest and browser registration. The bridge token is created exclusively by the Native Messaging server when it starts for the first time (preserving valid 48-hex or 64-hex tokens with exclusive `wx` creation; clients never generate tokens, and environment variable overrides are not supported). The token is stored at `~/.chrome-mcp/bridge-token` (Windows: `%USERPROFILE%\.chrome-mcp\bridge-token`).

**What This Does:**

- **Windows**: Adds registry key `com.chromemcp.nativehost` under `HKCU\Software\Google\Chrome\NativeMessagingHosts`.
- **macOS**: Places the manifest JSON under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
- **Linux**: Places the manifest JSON under `~/.config/google-chrome/NativeMessagingHosts/`.
- **Security Bridge Token**: Created on first server startup and used to authenticate local HTTP and WebSocket connections.

---

## Step 3: Connect to Your AI Agent Client

BrowserPaw connects via **Direct Stdio** (recommended for Codex Desktop, Hermes, Cursor, Claude Desktop, and CLI agents) or optional **HTTP Transport** (for custom authenticated loopback integrations). Choose your client configuration below:

### 3.1 Codex Desktop & ChatGPT (Stdio vs. Marketplace Plugin)

You can connect BrowserPaw either via Direct Stdio (recommended for CLI / local developers) or via the Marketplace Plugin UI (recommended for ChatGPT Desktop / Codex Desktop users):

#### Option A: Direct Stdio Configuration (Recommended)

Configure the Stdio MCP entry in Codex's `config.toml`:

- **Bridge requirement**: The Stdio process forwards MCP requests to the local bridge. Google Chrome must be open with BrowserPaw enabled, and the bridge must be available before calling tools. For Codex Desktop plugin migration, ensure `mcp-chrome-stdio` is available or configure absolute Node + script paths.
- **Direct Environment Injection**: You can set the tool profile and Jev API key in the client configuration without changing global environment variables.

**Configuration File Location:**

- **Windows**: `%USERPROFILE%\.codex\config.toml` (e.g. `C:\Users\<Username>\.codex\config.toml`)
- **macOS / Linux**: `~/.codex/config.toml`

Add the following block to your `config.toml`:

```toml
[mcp_servers.browserpaw]
command = "node"
# Use absolute paths with forward slashes on all platforms:
args = ["<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js"]
startup_timeout_sec = 60

[mcp_servers.browserpaw.env]
# "full" exposes all 50 registered tools (including autonomous micro-loop chrome_act_toward_goal)
# "core" exposes standard CDP tools
CHROME_MCP_TOOL_PROFILE = "full"
# Optional: Inject Jev API key directly here for instant autonomous execution
TYPESAFE_API_KEY = "your-typesafe-api-key-here"
```

#### Option B: ChatGPT / Codex Desktop Marketplace Plugin UI Installation

If installing through the ChatGPT Desktop or Codex Plugin Marketplace:

1. Add the marketplace source or repository URL in your client configuration.
2. Open the application and go to **Settings** > **Plugins** (or open the Plugins panel).
3. In the Plugins view, select the **"Personal"** tab.
4. Locate **BrowserPaw** and click the **"+" (Add / Install)** button to install the plugin.
   For a local repository installation, add the `<repo-root>/plugins/browserpaw` directory as the plugin source.
5. After installing or changing the MCP configuration, start a new task if the client has not refreshed its available tools.

---

### 3.2 Hermes Agent

- **Option A: Direct Stdio Configuration in config.yaml (Default & Recommended)**:

  Configure Hermes with native Stdio transport in your Hermes configuration (`config.yaml`) to expose all ~50 standard MCP tools:

  ```yaml
  mcp_servers:
    browserpaw:
      command: 'node'
      args: ['<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js']
      enabled: true
      env:
        CHROME_MCP_TOOL_PROFILE: full
  ```

- **Option B: Optional Legacy 16-Tool Plugin**:

  If your workflow specifically requires legacy 16-tool names, Hermes provides an optional plugin (`plugins/browserpaw`). It requires Hermes `>=0.21.5` and explicit user authorization in `config.yaml`:

  ```yaml
  plugins:
    entries:
      browserpaw:
        mcp_allowlist: ['browserpaw']
  ```

  You can optionally configure `settings.isolate_modal: false` as needed. To avoid duplicate tool definitions between MCP stdio and the plugin, our recommended migration strategy is to keep the optional plugin disabled unless legacy tool names are specifically required:

  ```bash
  hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw
  # Only enable if legacy 16-tool names are explicitly needed:
  hermes plugins enable browserpaw
  ```

- **Option C: Advanced Manual HTTP Transport**:
  ```bash
  hermes mcp add browserpaw --url http://127.0.0.1:12306/mcp --auth header
  ```
  When prompted for headers, enter: `x-mcp-token: <TOKEN_FROM_~/.chrome-mcp/bridge-token>`.

---

### 3.3 Cursor (`.cursor/mcp.json` or Cursor Settings > MCP)

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "full"
      }
    }
  }
}
```

---

### 3.4 Claude Desktop (`claude_desktop_config.json`)

Config file paths:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "full"
      }
    }
  }
}
```

---

### 3.5 Windsurf / Cascade (`~/.codeium/windsurf/mcp_config.json`)

```json
{
  "mcpServers": {
    "browserpaw": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js"],
      "env": {
        "CHROME_MCP_TOOL_PROFILE": "full"
      }
    }
  }
}
```

---

### 3.6 Generic Streamable HTTP MCP

For clients connecting over Streamable HTTP:

```json
{
  "mcpServers": {
    "browserpaw": {
      "url": "http://127.0.0.1:12306/mcp",
      "headers": {
        "x-mcp-token": "<TOKEN_FROM_~/.chrome-mcp/bridge-token>"
      }
    }
  }
}
```

---

## Step 4: Pin Extension & Configure Jev Decision Engine (Recommended)

### 4.1 Pin BrowserPaw to the Chrome Toolbar

Click the puzzle piece icon (Extensions) in Chrome's top toolbar, locate **BrowserPaw**, and click the **Pin** icon. This keeps BrowserPaw visible at all times for quick health inspection, connection monitoring, and instant one-click settings.

---

### 4.2 Why Enable Jev? (Dual-Brain Architecture)

BrowserPaw features an advanced **Hierarchical Dual-Brain Architecture**:

- **Macro Planner (System 2)**: Your host AI Agent (Codex, Claude, Cursor) performs broad reasoning and decomposes complex goals.
- **Fast Semantic Micro-Loop (System 1)**: Powered by the Jev Decision Engine (`chrome_act_toward_goal`), it performs on-page perceive-decide-act steps without a separate MCP request for each internal step. Latency depends on the selected Jev mode, hardware, and page complexity.

**Tri-State Decision Mode**:
Click the BrowserPaw icon in your Chrome toolbar to open the popup, and select your preferred mode:

---

### Mode 1: Local Jev

1. In the BrowserPaw extension popup, select **Local**.
2. Click **Download Model** to download the `decider-2b` weights (approximately 3.8 GB) to the configured model directory.
3. Local inference requires a working Python environment with the decider's runtime dependencies. The bridge manages the local service lifecycle at `http://127.0.0.1:8009` when that environment is available. Resource use and inference speed depend on the model runtime and hardware.

> **💡 AI Agent Hardware Check Guide:**
> When setting up for a user, the AI Agent should check their computer specifications:
>
> - **Operating System & Architecture**: Windows / macOS / Linux, x86_64 / arm64.
> - **Inference Acceleration Strategy**:
>   - **NVIDIA GPU**: CUDA acceleration may be used when the required runtime and compatible hardware are available.
>   - **Apple Silicon**: PyTorch MPS is used where supported by the installed runtime.
>   - **CPU**: CPU inference is available where supported by the configured runtime, with performance depending on the host.

---

### Mode 2: Remote Cloud Jev (TypeSafe System One / Custom Endpoints)

1. In the BrowserPaw extension popup, select **Remote**, then click **Manage**.
2. **Using Official TypeSafe Jev**:
   - Enter your API Key, or configure the environment variable `TYPESAFE_API_KEY` (or `JEV_API_KEY`).
   - **Need an API Key?** If you are not yet registered, the AI Agent can assist by opening:
     👉 [https://typesafe.ai/blog/introducing-system-one-models-and-jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
     _(New accounts receive $5 in free credits)._

   **Setting Environment Variable (Alternative to Popup):**
   - **Windows (PowerShell, persistent for current user):**
     ```powershell
     [Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", "your-key-here", "User")
     $env:TYPESAFE_API_KEY = "your-key-here"
     ```
   - **macOS / Linux:**
     ```bash
     export TYPESAFE_API_KEY="your-key-here"
     echo 'export TYPESAFE_API_KEY="your-key-here"' >> ~/.zshrc
     ```

3. **Using Custom / Self-Hosted Gateways**:
   - In the **Manage** dialog, configure your custom `Base URL` (e.g. `http://localhost:8000/v1` or private gateway) and custom `modelId`.
   - Settings are cleanly persisted to `~/.browserpaw/jev-remote.json`.

---

### Mode 3: Off (Standard CDP Toolset Only)

If you prefer not to use autonomous micro-loops:

- Select **Off** in the popup.
- `chrome_act_toward_goal` is dynamically omitted from the MCP tool registry, while all standard CDP tools (clicking, typing, scrolling, reading DOM) remain fully operational.

---

## Step 5: Silent Debugger Mode (Zero-Jitter UX Optimization)

When Chrome DevTools Protocol (CDP) attaches to a tab, Chromium displays a native warning banner at the top of the viewport:

> _"BrowserPaw is debugging this browser"_

This banner shifts the page viewport downward by ~36px, causing minor visual layout jitter. You can completely eliminate this banner by adding `--silent-debugger-extension-api` to your Chrome shortcut.

**Ask the User:**

> _"Would you like me to configure Chromium Silent Debugger Mode? This adds `--silent-debugger-extension-api` to your Chrome shortcut so automation runs completely invisibly with zero page-height jitter."_

### Windows (Automated PowerShell One-Liner)

Run this command in PowerShell to automatically patch the Desktop Google Chrome shortcut:

```powershell
$wsh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "Google Chrome.lnk"
if (Test-Path $shortcutPath) {
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    if ($shortcut.Arguments -notmatch "--silent-debugger-extension-api") {
        $shortcut.Arguments = "$($shortcut.Arguments) --silent-debugger-extension-api".Trim()
        $shortcut.Save()
        Write-Host "[SUCCESS] Chrome desktop shortcut patched with --silent-debugger-extension-api"
    } else {
        Write-Host "[INFO] Silent debugger flag already present on shortcut."
    }
} else {
    Write-Host "[NOTICE] Desktop shortcut not found at $shortcutPath. You can manually add the flag in Chrome shortcut properties."
}
```

### macOS

Launch Chrome from terminal or create an application wrapper:

```bash
open -a "Google Chrome" --args --silent-debugger-extension-api
```

### Linux

```bash
google-chrome --silent-debugger-extension-api &
```

---

## Step 6: Install Agent Skills (Recommended)

If your agent supports skill definitions (Codex, Hermes, or Claude Code), copy the bundled skill folder so your agent has the tool parameter schemas and workflow guidance:

> **Important**: Always copy the **entire `skill/` directory** including its `references/` subdirectory.

- **Codex Desktop / CLI**:

  ```powershell
  # Windows PowerShell
  $target = "$env:USERPROFILE\.codex\skills\browserpaw"
  if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force }
  Copy-Item -Path "skill\*" -Destination $target -Recurse -Force
  ```

  ```bash
  # macOS / Linux
  mkdir -p ~/.codex/skills/browserpaw
  cp -R skill/* ~/.codex/skills/browserpaw/
  ```

- **Hermes Agent**: Automatically installed when loading the plugin (`skill_view("browserpaw:browserpaw")`).
- **Claude Code**: Copy `skill/` into `.claude/skills/browserpaw/`.

---

## Step 7: System Preflight Health Check

Verify your complete BrowserPaw installation with the built-in diagnostic doctor:

```bash
node skill/config/doctor.mjs
```

---

## You're All Set

Run the diagnostic script and follow its reported checks. Its output varies with the local environment and configured optional features; there is no single expected output for every installation.

1. Start a new conversation or task in your AI Agent.
2. Instruct your agent:
   > _"Open a website in Chrome and report its page title."_
3. Verify the result in Chrome.

For troubleshooting and common edge cases, see **[docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)**.
