# BrowserPaw Installation & Onboarding Guide

An authoritative, step-by-step onboarding guide for **AI Agents** (Codex Desktop, Hermes, Claude Code, Cursor, Windsurf, ChatGPT) and human developers to install, configure, and operate BrowserPaw.

> **Star on GitHub**: If BrowserPaw accelerates your automation workflows, please consider starring the project: https://github.com/GoldenLoaf24h/browserpaw

---

## ⚡ Overview & Setup Flow

1. **Install BrowserPaw Chrome Extension**: Load pre-built release package or local build in Developer mode.
2. **Register Native Messaging Host**: One-time OS manifest registration and security token creation.
3. **Connect to Your AI Agent Client**: Configure MCP for Codex, Hermes, Cursor, Claude, Windsurf, or ChatGPT.
4. **Pin Extension & Setup Jev Decision Engine (Recommended)**: Choose Local 2B (zero cloud latency, GPU/CPU adaptive) or Remote Cloud (TypeSafe Jev API / Custom Gateway).
5. **Enable Silent Debugger Mode (Zero-Jitter UX Optimization)**: Optional Chromium flag for seamless automation without the top debugging banner.
6. **Preflight Health Check & Ready for Action**: Run the diagnostic doctor script and start assigning tasks!

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
pnpm build:extension
```

The unpacked extension will be output to: `<repo-root>/app/chrome-extension/.output/chrome-mv3`.

---

### Loading into Chrome / Edge

> **AI Agent Guidance:** You can assist the user by directly opening or navigating to `chrome://extensions/` (or `edge://extensions/` for Microsoft Edge).

1. In Google Chrome, navigate to **`chrome://extensions/`** (or in Microsoft Edge, navigate to **`edge://extensions/`**).
2. Enable **Developer mode** via the toggle switch in the top-right corner.
3. Either:
   - Click the **Load unpacked** button and select the extracted extension folder (or `.output/chrome-mv3`).
   - Or drag and drop the extension folder directly into the `chrome://extensions/` page.
4. Verify that **BrowserPaw** appears in your extensions list with its status enabled.

---

## Step 2: Register Native Messaging Host (One-Time OS Binding)

The Native Messaging Host provides high-speed, secure IPC between Chrome and your local AI Agent clients.

Run the registration script from your repository root (or unpacked native server directory):

```bash
node app/native-server/dist/scripts/register-dev.js
```

_(If working from repository source, ensure `pnpm build:shared && pnpm build:native` has completed)._

**What This Does:**

- **Windows**: Adds registry key `com.chromemcp.nativehost` under `HKCU\Software\Google\Chrome\NativeMessagingHosts`.
- **macOS**: Places the manifest JSON under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
- **Linux**: Places the manifest JSON under `~/.config/google-chrome/NativeMessagingHosts/`.
- **Security Bridge Token**: Automatically creates a high-entropy secret token at `~/.chrome-mcp/bridge-token` (Windows: `%USERPROFILE%\.chrome-mcp\bridge-token`) to secure local WebSocket and HTTP transports against unauthorized loopback access.

---

## Step 3: Connect to Your AI Agent Client

BrowserPaw connects via **Direct Stdio** (best for Codex, Cursor, Claude Desktop) or **HTTP Transport** (for ChatGPT, Hermes remote, etc.). Choose your client configuration below:

### 3.1 Codex Desktop & ChatGPT (Stdio vs. Marketplace Plugin)

You can connect BrowserPaw either via Direct Stdio (recommended for CLI / local developers) or via the Marketplace Plugin UI (recommended for ChatGPT Desktop / Codex Desktop users):

#### Option A: Direct Stdio Configuration (Recommended)

Configuring a **Stdio Server** in Codex's `config.toml` is the cleanest and most robust method:

- **Zero Daemon Management**: Codex automatically starts the bridge on demand and shuts it down when done. No manual background terminal processes needed.
- **Direct Environment Injection**: Inject your Jev API key or tool profile directly in the configuration block without touching global system environment variables.

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
5. **⚠️ Critical Note**: After completing installation (via either Stdio or Plugin), you **MUST start a New Task / Thread**. The AI agent registers and binds MCP tool definitions only when a new task is initialized!

---

### 3.2 Hermes Agent

- **Option A: Native Plugin (Recommended)**:

  ```bash
  hermes plugins install GoldenLoaf24h/browserpaw#plugins/browserpaw
  hermes plugins enable browserpaw
  ```

- **Option B: Direct MCP Server Add (HTTP Transport)**:
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

### 3.4 Claude Desktop & Claude Code (`claude_desktop_config.json`)

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

### 3.6 ChatGPT Desktop / Generic Streamable HTTP MCP

For clients connecting over HTTP SSE transport:

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
- **Fast Semantic Micro-Loop (System 1)**: Powered by the Jev Decision Engine (`chrome_act_toward_goal`), executing high-frequency on-page decisions (~100–300ms/step) directly inside the browser session without wasting expensive external LLM tokens or incurring roundtrip latency.

**Tri-State Decision Mode**:
Click the BrowserPaw icon in your Chrome toolbar to open the popup, and select your preferred mode:

---

### Mode 1: Local Jev (100% Offline, Zero Cloud Cost, Complete Privacy)

1. In the BrowserPaw extension popup, select **Local**.
2. Click **Download Model** to automatically fetch the compact 2B open-weight Jev model (`decider-2b`, ~1.7GB VRAM / FP16) to `~/.browserpaw/models`.
3. **Zero Manual Process Management**: The Native Bridge automatically manages the local decider service on `http://127.0.0.1:8009`. A built-in watchdog monitors activity and automatically unloads model weights after 10 minutes of inactivity, freeing 100% of memory.

> **💡 AI Agent Hardware Check Guide:**
> When setting up for a user, the AI Agent should check their computer specifications:
>
> - **Operating System & Architecture**: Windows / macOS / Linux, x86_64 / arm64.
> - **Inference Acceleration Strategy**:
>   - **Discrete GPU (CUDA on Windows/Linux)**: Uses FP16 acceleration for ultra-fast ~109ms decisions.
>   - **Apple Silicon (macOS M1–M4)**: Uses Metal Performance Shaders (MPS) and MLX unified memory.
>   - **CPU Auto-Fallback**: If no discrete GPU is available, the engine automatically selects multi-threaded CPU execution with zero manual configuration.

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

3. **Using Custom / Self-Hosted Gateways (OpenAI-Compatible)**:
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

If your agent supports skill definitions (Codex, Hermes, Claude Code), copy the bundled skill folder so your agent has full knowledge of all 50 tools, parameter schemas, and the Dual-Brain workflow:

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

**Expected Output:**

```text
================================================================
         BrowserPaw System Healthcheck & Repair
================================================================

[PASS] Node.js Environment: v22.x on win32
[PASS] Bridge Token Found: ...\.chrome-mcp\bridge-token
[PASS] Native Bridge Server is Listening (Port 12306)
[PASS] Token Authentication & MCP Initialize OK
[PASS] Extension Build Found: ...\app\chrome-extension\.output\chrome-mv3
[PASS] Standalone Directory Synced
[PASS] Native Messaging Host Registered in Chrome
[PASS] Jev Decision Model: Configured and Ready
----------------------------------------------------------------
Diagnostic Complete: All Checks Passed.
STATUS: [HEALTHY] All BrowserPaw layers are operating normally!
```

---

## 🎉 You're All Set!

Once the doctor reports `STATUS: [HEALTHY]`:

1. Start a new conversation or task in your AI Agent.
2. Instruct your agent:
   > _"Open Twitter in Chrome, search for Elon Musk's profile, and view his latest tweet."_
3. Watch BrowserPaw navigate, position the kinetic cursor, interact smoothly, and report back results in real time!

For troubleshooting and common edge cases, see **[docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)**.
