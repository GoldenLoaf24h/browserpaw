# BrowserPaw Native Bridge Installation Guide

The native server bridges Chrome Native Messaging (stdio) and AI Agent MCP clients (HTTP/SSE on port 12306 or stdio).

For the complete, step-by-step onboarding guide across the full BrowserPaw stack, see the root **[INSTALL.md](../../INSTALL.md)**.

---

## Quick Setup

### 1. Build Native Bridge

From the repository root:

```bash
pnpm --filter mcp-chrome-bridge build
```

### 2. Register Native Messaging Host

Register the host manifest with Chromium so Chrome can spawn the bridge process:

```bash
cd app/native-server
node dist/scripts/register-dev.js
```

- **Windows**: Writes registry key at HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost.
- **macOS**: Writes manifest to ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json.
- **Linux**: Writes manifest to ~/.config/google-chrome/NativeMessagingHosts/com.chromemcp.nativehost.json.

### 3. Verify Health

Run the built-in diagnostic suite:

```bash
node dist/scripts/doctor.js
```

Or from repository root:

```bash
node skill/config/doctor.mjs
```

### 4. Enable Jev Semantic Engine (Optional but Recommended)

The native bridge on-page autonomy (`chrome_act_toward_goal`) uses Jev, a fast semantic decision model from TypeSafe. Without an API key it falls back to a slower heuristic engine.

1. Get a key: https://typesafe.ai/blog/introducing-system-one-models-and-jev
2. Set the environment variable `TYPESAFE_API_KEY` (or `JEV_API_KEY`) before launching the bridge or your agent client.

> For per-agent setup (ChatGPT / Codex, Hermes, Cursor, etc.) and the full onboarding checklist, see the root **[INSTALL.md](../../INSTALL.md)**.
