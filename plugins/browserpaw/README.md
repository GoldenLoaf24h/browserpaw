# BrowserPaw Portable Plugin

This package follows Agent Plugins v1 for ChatGPT and Codex. Install it through the
marketplace entry in `.agents/plugins/marketplace.json`; do not edit client plugin
caches by hand.

Official specification: <https://developers.openai.com/plugins/build/plugins>.

Validated with Codex `0.166.0` in an isolated marketplace installation. The
installed package contains the root `plugin.json`, `mcp.json`, and `skills/`
layout and excludes developer-only `AGENTS.md`, `.codex-plugin`, and
`mcp-skills` compatibility copies.

The stdio MCP server is `mcp-chrome-stdio`. It connects to the locally installed
BrowserPaw Native Host and exposes the canonical `chrome_*` tools.

The client-neutral skill is in `skills/browserpaw/`. Edit only
`skills/browserpaw/` at the repository root, then run
`node scripts/sync-skills.mjs`.

Verified self-learning skills stay in the Native store
`$BROWSERPAW_HOME/skills` (default `~/.browserpaw/skills`). They are shared by
every client connected to the same Native Host and are not copied into this
plugin.
