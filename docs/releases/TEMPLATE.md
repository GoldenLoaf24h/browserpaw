# BrowserPaw v<VERSION>

- **Tag:** v<VERSION>
- **Target:** main
- **Date:** <YYYY-MM-DD>

## Overview

> ⚠️ **Upgrading from BrowserPaw v4.x? (For Users and AI Agents):** BrowserPaw v5 replaces the v4.x MCP server (`127.0.0.1:12306/mcp`), persistent REPL, and `chrome_*` MCP wrappers with the `browserpaw` CLI and standard Agent Skill. Before using v<VERSION>, read the [Migration Guide](../MIGRATION.md) ([Simplified Chinese](../MIGRATION.zh-CN.md)) or ask your AI Agent to read `docs/MIGRATION.md` (or `docs/MIGRATION.zh-CN.md`) and migrate your configuration automatically.

<Factual description of what is delivered in this version, why it was made, and who is affected.>

## Changes

### <Functional Area 1>

- <Concrete change description with technical rationale.>

### <Functional Area 2>

- <Concrete change description with technical rationale.>

## Upgrade & Compatibility

- **Breaking Changes:** <None, or list of breaking changes and affected APIs.>
- **Migration Guide:** <Explicit, actionable migration instructions.>
- **Compatibility Boundaries:** <Supported Chrome/Chromium versions, OS platforms, and client adapters.>

## Verification Scope

- **Verification Gate:** <Actual command and outcome; do not prefill a passing claim.>
- **Automated Tests:** <Total tests passed, suite breakdown, and any permitted skips.>
- **CI Status:** Linux & Windows GitHub Actions run links: <URL>
- **Loaded Runtime Checks:** <Explicit description of live manual/runtime verification on loaded extension/native host.>
- **Boundaries & Exclusions:** <Explicit statement of what was NOT tested or verified in this release.>

## Release Assets

Release assets (verify their SHA-256 values against the uploaded files before publication):

| Asset Name | Description |
| :--- | :--- |
| `browserpaw-extension.zip` | Chrome MV3 extension bundle |
| `browserpaw-skill.zip` | Canonical agent skill bundle |

## Diff & Commits

- **Full Changelog:** https://github.com/GoldenLoaf24h/browserpaw/compare/v<PREVIOUS_VERSION>...v<VERSION>
