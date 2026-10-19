# Plugin Compatibility Specification: Hermes Agent & DeepSeek Harness (DSH)

- **Verification Date**: 2026-10-15
- **Verified Upstream Commits**:
  - Hermes Agent: [`NousResearch/hermes-agent@db44c46208f1b421b4ecb7e56bf9d68b0423906f`](https://github.com/NousResearch/hermes-agent/commit/db44c46208f1b421b4ecb7e56bf9d68b0423906f) (main branch)
  - Hermes Agent PR #136034: BrowserPaw companion reviewed pin [`66a73495`](https://github.com/NousResearch/hermes-agent/pull/136034)
  - DeepSeek Harness: [`deepseek-ai/deepseek-harness@571902028a75c64c1d767f4ae5fd099485f0ddf0`](https://github.com/deepseek-ai/deepseek-harness/commit/571902028a75c64c1d767f4ae5fd099485f0ddf0) (master branch)
  - DeepSeek Harness Discussion: [#8287](https://github.com/deepseek-ai/deepseek-harness/discussions/8287) ("Duplicate in-box @deepseek-ai/* package in a profile silently breaks every tool call")

---

## 1. Hermes Agent Plugin Compatibility

### 1.1. Host Context & `ctx.call_mcp` Specification

From upstream [`hermes_cli/plugins.py:507-536`](https://github.com/NousResearch/hermes-agent/blob/db44c46208f1b421b4ecb7e56bf9d68b0423906f/hermes_cli/plugins.py#L507-L536):

```python
def call_mcp(
    self,
    server: str,
    tool: str,
    arguments: Optional[dict[str, Any]] = None,
    timeout: float = 30,
) -> dict[str, Any]: ...
```

- **Access Control (Allowlist)**: Default-deny. The host verifies `server in self._mcp_allowlist(self.plugin_id)`. The operator grants access via `plugins.entries.<plugin_id>.mcp_allowlist` in `config.yaml`.
- **Timeout Clamping**: Clamped to `[1.0, 600.0]` seconds (default `30.0`s).
- **Payload Truncation**: Character cap `_MCP_RESULT_CHAR_CAP = 65536`. If string length exceeds 65536 characters, truncated to `raw[:65536] + "… [truncated]"` with `{**envelope, "truncated": True}`.
- **Envelope Normalization**: Returns `{"ok": True, "result": ...}` on success, or `{"ok": False, "error": ...}` on failure.
- **Config Access**: Plugins must use `ctx.get_config(key, default=None)`. `ctx.config` does not exist on the plugin context.

### 1.2. PR #136034 Anti-Regression Checklist

- **No Private Secret Scope**: Do not invoke `ctx.secret_scope` (non-existent on official host).
- **No Ambient Credential Harvesting**: Do not read host environment variables or local token files in the Python plugin.
- **Zero Import-Time Side Effects**: Do not alter `sys.stdin`/`sys.stdout` during module import.
- **Tool Name Parity**: Tool names registered via `ctx.register_tool` must match the 16 browser tools referenced in the bundled skill documentation.
- **No Unsafe Companion Endpoints**: Do not expose unauthenticated `/token` or `x-local-trust` bypasses.

---

## 2. DeepSeek Harness (DSH) Plugin Compatibility

### 2.1. Plugin Architecture & Cordis Lifecycle

From upstream `deepseek-ai/deepseek-harness`:

- **Plugin Module Shape**: ES module exporting `name`, `inject = ['skills', 'tools']`, and `async apply(ctx)`.
- **Peer Dependency**: This plugin declares `@deepseek-ai/dsh-mcp-client >=0.2.0-rc.1` as its peer dependency. In-box `@deepseek-ai/*` packages are excluded to avoid duplicate Cordis symbol registration ([Discussion #8287](https://github.com/deepseek-ai/deepseek-harness/discussions/8287)).
- **Bundle Manifest Declarations**: A package is treated as a profile bundle layer only when its `package.json` declares a top-level `dsh.bundle`. `dsh.bundle.patch` (here `./cordis.patch.yml`) is the required field: without it the loader reconciles the package as an ordinary dependency, prints `dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`, never applies the patch, and never runs `apply()`. `dsh.manifestVersion: 1` is optional and currently advisory (the loader does not enforce it), while a top-level `engines.dsh` is enforced when present and then decides compatibility on its own; otherwise the loader validates each `@deepseek-ai/dsh*` peer range. Prerelease versions participate in range matching.
- **Loader-Resolved In-Box Client**: `@deepseek-ai/dsh-mcp-client` is not a package dependency and is not statically imported; the plugin calls `ctx.loader.import('@deepseek-ai/dsh-mcp-client')` at `open()` time and passes the returned module namespace to `ctx.plugin()`. Cordis rejects a bare specifier string with `invalid plugin, expect function or object with an "apply" method, received string`, and a static import cannot resolve from a linked plugin outside the harness image. Bare-specifier-to-module resolution happens in the loader entry tree, not in `ctx.plugin()`.
- **Tool Naming & Prefix**: The canonical BrowserPaw tool names remain `chrome_*`. DeepSeek Harness exposes the injected MCP tools as `mcp__browserpaw__chrome_*`: the mcp-client has no rename capability and passes each raw tool name through unchanged. The bundled skill mirror therefore documents the canonical `chrome_*` names.
- **Plugin Mounting Semantics**:
  - In vendored Cordis ([`vendor/cordis/src/registry.ts:331-334`](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/vendor/cordis/src/registry.ts#L331-L334)), `ctx.plugin()` returns a thenable wrapped Fork awaiting `fiber.await()`.
  - `@deepseek-ai/dsh-mcp-client` awaits `connection.ready` ([`packages/mcp/mcp-client/src/index.ts:199`](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/mcp/mcp-client/src/index.ts#L199)) before the injected tools appear.
- **Lifecycle Cleanup**: Session unmounting calls `await session.fork.dispose()`. Plugin unmount is registered via `ctx.effect()`.
- **Fail-Loud Startup**: `open()` passes `failOnStartupError: true` to the in-box client. The client defaults that option to `false`, which turns a failed first connection into a background retry while `apply()` resolves normally — `open()` then reports success with no tool registered, and the next call targets a name that was never installed. With the flag set, an unreachable bridge makes `open()` reject with `mcp-client(browserpaw): initial connection or tool synchronization failed`, `status` keeps reporting `active: false`, and a retry still opens a fresh transport. Regression coverage: [`scripts/browserpaw-dsh-plugin.test.mjs`](../../scripts/browserpaw-dsh-plugin.test.mjs).
- **Serialized Session Transitions**: Because `ctx.plugin()` cannot be cancelled once it starts, the plugin funnels `open` and `close` through a single promise chain. Concurrent opens therefore create one connection, a close issued while an open is still awaiting tears that connection down instead of being ignored, and unmounting during a pending open disposes the resulting fork rather than leaking it. Regression coverage: [`scripts/browserpaw-dsh-plugin.test.mjs`](../../scripts/browserpaw-dsh-plugin.test.mjs).

### 2.2. Resolved Contract Boundaries (S-02, S-03, S-04)

#### S-02: Required `output.render` Projection

- **Upstream Check**: [`packages/core/tools/src/index.ts:1071-1078`](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/core/tools/src/index.ts#L1071-L1078) requires `typeof output.render === 'function'`, throwing `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }` if absent.
- **Fix**:
  ```javascript
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
  ```

#### S-03: Skill `source` Declaration for Deferred Resolution

- **Upstream Check**: [`packages/skill/skill/src/index.ts:763`](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/skill/skill/src/index.ts#L763) validates definition on `get()`, checking `typeof source === 'string'`.
- **Fix**:
  ```javascript
  ctx.skills.register({
    name: SERVER_NAME,
    source: 'runtime',
    description: '...',
    content: skillContent,
    resourceBase: { kind: 'directory', path: skillDir },
  });
  ```

#### S-04: Standard JSON Schema Object Root for Parameters

- **Upstream Check**: Direct `ctx.tools.register()` bypasses `defineTool` shorthand parsing.
- **Fix**:
  ```javascript
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'close', 'status'], description: 'Session action' },
    },
  }
  ```

---

## 3. Host Credential Boundaries

- **DeepSeek Harness (DSH)**: Operates against a local HTTP bridge. The plugin resolves the local bridge token from `process.env.CHROME_MCP_TOKEN` or `~/.chrome-mcp/bridge-token` and passes `headers: { 'x-mcp-token': token }`.
- **Hermes Agent**: Operates credential-free in plugin code. Access control is enforced host-side via `plugins.entries.browserpaw.mcp_allowlist` in `config.yaml`.

---

## 4. Verification Commands & Scope Limitations

- **Unit Test Command**:
  ```bash
  node --test scripts/browserpaw-dsh-plugin.test.mjs
  ```
- **Scope Limitations**:
  - Static review uses the pinned upstream sources above. The root unit tests use a context test double; they do not establish full host compatibility.
  - An isolated Hermes component test used the real `PluginContext.call_mcp`, `MCPServerTask`, and official Python MCP SDK 2.3.0 against a controlled Streamable HTTP server. A 130.5-second response completed in 130.673 seconds with exactly one upstream tool call. Plugin-manager configuration was a test fixture; the SDK was loaded from a scratch directory, without changing the user's Hermes environment.
  - Installed DSH 0.2.0-rc.2 packages were exercised in an isolated Cordis context for tool registration, skill retrieval, parameter projection, and output rendering. The system-prompt service was a fixture. That run alone did not establish a live browser MCP session.
  - Host-level validation was completed on 2026-10-18 against a real DSH `0.2.1-rc.1` runtime launched in an isolated profile whose bundle list links `dsh-browserpaw`. That run established: the package loads as a profile layer (its `cordis.patch.yml` applies and `apply()` executes), the `browserpaw` skill registers through the runtime provider, the `browserpaw_session` tool registers, `action: "open"` connects to the live bridge at `http://127.0.0.1:12306/mcp` and injects the MCP tools, and `action: "close"` unloads them. The native host and `~/.chrome-mcp/bridge-token` were both in place.
  - **Tool-profile boundary**: the native host announces only its `core` profile by default (14 tools) while the bundled skill body references the wider canonical set. `chrome_tool_docs` with `activateForSession: true` widens the server-side list, but DSH never observes it — the host does not declare the `tools.listChanged` capability, so the in-box client installs no list-changed handler and its tool table never refreshes. Tools outside the announced profile stay uncallable until the native host is restarted with `CHROME_MCP_TOOL_PROFILE=full`, which a plugin cannot reach from its own process. Under `full` the skill body and the registered tool set reconcile completely; under the default `core` profile the difference is a product-side profile choice, not a naming defect.
  - **Remaining boundary**: the `desktop` profile is owned exclusively by the Electron host and was not exercised; this evidence does not claim readiness under it. Local audit evidence is retained under `docs/analysis/audit-2026-10-14/runtime-acceptance/`; that ignored archive is not part of the distributed plugin.
