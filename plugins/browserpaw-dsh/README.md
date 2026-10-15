# dsh-browserpaw

DeepSeek Harness plugin for [BrowserPaw](https://github.com/GoldenLoaf24h/browserpaw): high-speed dual-brain Chrome automation with native CDP and local MCP bridge.

## Verification & Official Upstream

- **Audit Date**: 2026-10-15
- **Official Pinned Upstream**: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) at commit [`571902028a75c64c1d767f4ae5fd099485f0ddf0`](https://github.com/deepseek-ai/deepseek-harness/commit/571902028a75c64c1d767f4ae5fd099485f0ddf0) (master branch, verified 2026-10-15).
- **Declared Peer Dependency**: This plugin declares `@deepseek-ai/dsh-mcp-client >=0.2.0-rc.1` as its peer dependency.
- **Discussion #8287 Reference**: [Discussion #8287](https://github.com/deepseek-ai/deepseek-harness/discussions/8287) ("Duplicate in-box @deepseek-ai/* package in a profile silently breaks every tool call") establishes that in-box `@deepseek-ai/*` packages must be excluded from plugin dependencies to avoid duplicate Cordis symbol registration.
- **Scope Boundary**: This package is a lightweight transport session bridge (`browserpaw_session`) and skill provider. Full host readiness was not exercised in this verification; requires host-level validation.

## Architecture & Lifecycle

- **MCP Client**: Bridges to local BrowserPaw Native Server (`http://127.0.0.1:12306/mcp`) via `@deepseek-ai/dsh-mcp-client`. In DeepSeek Harness vendored Cordis (`vendor/cordis/src/registry.ts:331-334`), `ctx.plugin()` returns a thenable wrapped Fork awaiting `fiber.await()`.
- **Skill Injection**: Registers canonical `browserpaw` skill with `source: 'runtime'` into DeepSeek Harness Cordis runtime, satisfying deferred definition validation (`packages/skill/skill/src/index.ts:763`).
- **Tool Registration & Schema**: Exposes `browserpaw_session` tool satisfying 3 verified official boundaries:
  - **S-02**: Declares required text projection callback `output.render` (`packages/core/tools/src/index.ts:1071-1078`).
  - **S-03**: Declares `source: 'runtime'` in `ctx.skills.register()` for deferred definition validation (`packages/skill/skill/src/index.ts:763`).
  - **S-04**: Parameters schema uses standard JSON Schema object root (`type: 'object'`, `properties.action`), preserving status default on `{}`.
- **Cleanup**: Bound to Cordis fiber lifecycle via `ctx.effect()`, ensuring disposal without dangling timers or orphaned connections.

## Host Credential Boundaries

Different agent hosts enforce distinct authentication boundaries:

- **DeepSeek Harness (DSH)**: Operates against a local HTTP MCP bridge. The plugin dynamically resolves the local bridge token from `process.env.CHROME_MCP_TOKEN` or `~/.chrome-mcp/bridge-token` and passes `headers: { 'x-mcp-token': token }` to authenticate with the local server.
- **Hermes Agent (PR #136034)**: Operates credential-free via `ctx.call_mcp('browserpaw', ...)`. The plugin does not read environment tokens or local secret files; access control is enforced host-side via `plugins.entries.browserpaw.mcp_allowlist` in `config.yaml`.
