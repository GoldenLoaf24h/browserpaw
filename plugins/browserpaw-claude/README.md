# browserpaw — Claude Code Plugin

Claude Code plugin for [BrowserPaw](https://github.com/GoldenLoaf24h/browserpaw): drive your everyday Chrome — with its existing logins, cookies, and extensions — through 50 MCP tools, in background tabs and without stealing focus.

## Verification & Official Upstream

- **Audit Date**: 2026-10-18
- **Verified Claude Code Version**: `2.1.299` (Claude Code desktop, Windows). `claude plugin validate --strict` passes on both this plugin directory and the repository's `.claude-plugin/marketplace.json`.
- **Plugin Specification**: Manifest at `.claude-plugin/plugin.json`, marketplace catalog at `.claude-plugin/marketplace.json`, MCP servers at the plugin root's `.mcp.json`, skills at `skills/<name>/SKILL.md`.
- **Scope Boundary**: The plugin directory, manifest, catalog entry, skill mirror, and MCP server declaration are validated. Live tool execution additionally requires the native messaging host, a running Chrome with the BrowserPaw extension, and the `mcp-chrome-stdio` shim on `PATH` (see [INSTALL.md](../../INSTALL.md)).

## Install

The plugin is published by this repository's own marketplace. From Claude Code:

```text
/plugin marketplace add GoldenLoaf24h/browserpaw
/plugin install browserpaw@browserpaw
```

For a local checkout, point the marketplace at the repository root instead of GitHub:

```text
/plugin marketplace add <ABSOLUTE_PATH_TO_REPO>
/plugin install browserpaw@browserpaw
```

Because the catalog uses a relative-path source, the plugin loads in place from `plugins/browserpaw-claude` and picks up local edits on the next session start or `/reload-plugins`.

## Usage

Invoke the bundled skill to load the full BrowserPaw operating guide:

```text
/browserpaw
```

The skill is namespaced as `/browserpaw:browserpaw`; the bare `/browserpaw` form resolves to the same skill as long as no other command claims that name.

## Components

| Component  | Location                     | Notes                                                                                                                                                                                           |
| :--------- | :--------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill      | `skills/browserpaw/SKILL.md` | Canonical BrowserPaw operating guide. Mirrored verbatim from the repository's `skill/` directory by `scripts/sync-skills.mjs`; edit `skill/` and re-run the sync rather than editing this copy. |
| MCP server | `.mcp.json`                  | Declares the `browserpaw` stdio server.                                                                                                                                                         |

The skill documents the canonical `chrome_*` tool names, which are exactly what the stdio bridge advertises. Claude Code surfaces them as `mcp__plugin_browserpaw_browserpaw__chrome_*`.

## Prerequisites

1. **Native messaging host**: run the registration script described in [INSTALL.md](../../INSTALL.md) so Chrome can launch the bridge.
2. **`mcp-chrome-stdio` on `PATH`**: installed by `npm install -g ./app/native-server` after `pnpm build`. Without it, register the server yourself: `claude mcp add browserpaw -- node <ABSOLUTE_PATH_TO_REPO>/app/native-server/dist/mcp/mcp-server-stdio.js`.
3. **Chrome open with the BrowserPaw extension loaded**: the bridge is only reachable while the browser is running.
   The bundled server sets `CHROME_MCP_TOOL_PROFILE: full`, so all 50 tools the skill documents are visible from the first turn. Remove that `env` entry in `.mcp.json` if you prefer the 14-tool `core` profile.

## License

GNU Affero General Public License v3.0 (AGPL-3.0)
