# dsh-browserpaw

DeepSeek Harness plugin for [BrowserPaw](https://github.com/GoldenLoaf24h/browserpaw): high-speed dual-brain Chrome automation with native CDP and local MCP bridge.

## Install

```sh
dsh plugin --profile web add dsh-browserpaw
```

The installer reads this package's `dsh.bundle.patch`, so it registers itself as a profile
bundle layer on the way in — no manifest editing, no separate mount line. Restart the host
afterwards; both the `browserpaw` skill and the `browserpaw_session` tool appear once
`apply()` has run.

BrowserPaw itself must be running: the native server listens on `127.0.0.1:12306` and writes
`~/.chrome-mcp/bridge-token`, and the plugin needs both before `open` can connect. Install
BrowserPaw first if `browserpaw_session { action: "open" }` reports a missing bridge token.

## Verification & Official Upstream

- **Audit Date**: 2026-10-15
- **Host Validation Date**: 2026-10-18 (DSH `0.2.1-rc.1`, isolated profile)
- **Official Pinned Upstream**: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) at commit [`571902028a75c64c1d767f4ae5fd099485f0ddf0`](https://github.com/deepseek-ai/deepseek-harness/commit/571902028a75c64c1d767f4ae5fd099485f0ddf0) (master branch, verified 2026-10-15).
- **Declared Peer Dependency**: This plugin declares `@deepseek-ai/dsh-mcp-client >=0.2.0-rc.1` as its peer dependency, marked optional. The range documents the client the plugin was built against; the client itself always comes from the harness image. Marking the peer optional is what keeps an installer from resolving a second copy — npm auto-installs a required peer, and a duplicate in-box `@deepseek-ai/*` package registers the same Cordis symbols twice (see Discussion #8287).
- **Discussion #8287 Reference**: [Discussion #8287](https://github.com/deepseek-ai/deepseek-harness/discussions/8287) ("Duplicate in-box @deepseek-ai/* package in a profile silently breaks every tool call") establishes that in-box `@deepseek-ai/*` packages must be excluded from plugin dependencies to avoid duplicate Cordis symbol registration.
- **Scope Boundary**: This package is a lightweight transport session bridge (`browserpaw_session`) and skill provider. Host-level validation has been completed in an isolated profile; see [Host-Level Validation](#host-level-validation) for the method and its remaining boundary.

## Host-Level Validation

On 2026-10-18 the plugin was exercised end to end against a real DeepSeek Harness `0.2.1-rc.1` runtime launched in an isolated DSH profile whose bundle list contains `dsh-browserpaw` as a linked dependency. That run established:

- The package loads as a profile layer rather than as a plain dependency, so its `cordis.patch.yml` applies and `apply()` executes.
- The `browserpaw` skill registers through the runtime provider.
- The `browserpaw_session` tool registers.
- `action: "open"` connects to the live bridge at `http://127.0.0.1:12306/mcp` and injects the MCP tools; `action: "close"` unloads them.

The native host and `~/.chrome-mcp/bridge-token` were both in place for that run.

**Boundary**: the `desktop` profile is owned exclusively by the Electron host and was not exercised; this validation does not claim readiness under it.

**Tool-profile boundary**: the native host announces only its `core` profile by default (14 tools), while the bundled skill body references the wider canonical set. Calling `chrome_tool_docs` with `activateForSession: true` does widen the server's list, but DeepSeek Harness never observes the change: the host does not declare the `tools.listChanged` capability, so the in-box MCP client installs no list-changed handler and its tool table never refreshes. Tools outside the announced profile therefore stay uncallable until the native host is restarted with `CHROME_MCP_TOOL_PROFILE=full`, which the plugin cannot reach from its own process. The injected tool-naming note states this limit rather than promising an unlock path that does not work.

## Bundle Manifest Declarations

DeepSeek Harness treats a package as a profile bundle layer only when its `package.json` declares a top-level `dsh.bundle` manifest:

- **`dsh.bundle.patch`** — required for a bundle layer. It points at this package's `./cordis.patch.yml`, the loader patch that inserts the `browserpaw-skill` entry. A package without `dsh.bundle` is reconciled as an ordinary dependency: the loader prints `dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`, the patch never applies, `apply()` never runs, and neither the skill nor the `browserpaw_session` tool exists.
- **`dsh.manifestVersion`** — optional, and currently advisory: the loader does not reject a package that omits it. The field records the manifest schema the package was authored against (`1` here).
- **`engines.dsh`** — optional top-level declaration, enforced when present. A declared `engines.dsh` alone decides compatibility; when it is absent, the loader validates every `@deepseek-ai/dsh*` peer range instead. Prerelease versions participate in range matching, so the declared `>=0.2.0-rc.1 <0.3.0-0` admits the tested `0.2.1-rc.1` runtime. The upper bound excludes `0.3.0`: host-level validation covers only up to `0.2.1-rc.1`, so an unbounded range would claim compatibility with a future minor release that was never verified.
- **In-box packages** — `@deepseek-ai/*` packages must not be installed as profile dependencies; see the Discussion #8287 reference above.

## Architecture & Lifecycle

- **MCP Client**: Bridges to local BrowserPaw Native Server (`http://127.0.0.1:12306/mcp`) via `@deepseek-ai/dsh-mcp-client`. The client is resolved at `open()` time through `ctx.loader.import('@deepseek-ai/dsh-mcp-client')`, and the module namespace it returns — which carries `apply` — is what `ctx.plugin()` receives. Cordis rejects a bare specifier string (`invalid plugin, expect function or object with an "apply" method, received string`), and a static import cannot resolve from a linked plugin outside the harness image; bare-specifier-to-module resolution happens in the loader entry tree, not in `ctx.plugin()`. In DeepSeek Harness vendored Cordis (`vendor/cordis/src/registry.ts:331-334`), `ctx.plugin()` returns a thenable wrapped Fork awaiting `fiber.await()`.
- **Skill Injection**: Registers canonical `browserpaw` skill with `source: 'runtime'` into DeepSeek Harness Cordis runtime, satisfying deferred definition validation (`packages/skill/skill/src/index.ts:763`).
- **Tool Registration & Schema**: Exposes `browserpaw_session` tool satisfying 3 verified official boundaries:
  - **S-02**: Declares required text projection callback `output.render` (`packages/core/tools/src/index.ts:1071-1078`).
  - **S-03**: Declares `source: 'runtime'` in `ctx.skills.register()` for deferred definition validation (`packages/skill/skill/src/index.ts:763`).
  - **S-04**: Parameters schema uses standard JSON Schema object root (`type: 'object'`, `properties.action`), preserving status default on `{}`.
- **Tool Naming & Prefix**: Canonical tool names stay `chrome_*` (`chrome_navigate`, `chrome_read_dom`, and the rest). DeepSeek Harness exposes the injected MCP tools under the `mcp__browserpaw__` namespace, so the callable names are `mcp__browserpaw__chrome_*`: the mcp-client has no rename capability and passes each tool's raw name through unchanged. The bundled skill mirror therefore documents the canonical `chrome_*` names.
- **Fail-Loud Startup**: `open()` passes `failOnStartupError: true`. The client defaults it to `false`, which lets a failed first connection retry in the background while `apply()` still resolves; `browserpaw_session { action: 'open' }` would then report success with no tool registered, and the next call would target a name that does not exist. With the flag set, a bridge that cannot answer makes `open()` reject with `mcp-client(browserpaw): initial connection or tool synchronization failed`, and `status` keeps reporting `active: false`.
- **Cleanup**: Bound to Cordis fiber lifecycle via `ctx.effect()`, ensuring disposal without dangling timers or orphaned connections.

## Host Credential Boundaries

Different agent hosts enforce distinct authentication boundaries:

- **DeepSeek Harness (DSH)**: Operates against a local HTTP MCP bridge. The plugin dynamically resolves the local bridge token from `process.env.CHROME_MCP_TOKEN` or `~/.chrome-mcp/bridge-token` and passes `headers: { 'x-mcp-token': token }` to authenticate with the local server.
- **Hermes Agent (PR #136034)**: Operates credential-free via `ctx.call_mcp('browserpaw', ...)`. The plugin does not read environment tokens or local secret files; access control is enforced host-side via `plugins.entries.browserpaw.mcp_allowlist` in `config.yaml`.
