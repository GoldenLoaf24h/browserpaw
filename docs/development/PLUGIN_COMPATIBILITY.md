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
- **Plugin Mounting Semantics**:
  - In vendored Cordis ([`vendor/cordis/src/registry.ts:331-334`](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/vendor/cordis/src/registry.ts#L331-L334)), `ctx.plugin()` returns a thenable wrapped Fork awaiting `fiber.await()`.
  - While `@deepseek-ai/dsh-mcp-client` awaits `connection.ready` ([`packages/mcp/mcp-client/src/index.ts:199`](https://github.com/deepseek-ai/deepseek-harness/blob/571902028a75c64c1d767f4ae5fd099485f0ddf0/packages/mcp/mcp-client/src/index.ts#L199)), full host readiness was not exercised in this verification; requires host-level validation.
- **Lifecycle Cleanup**: Session unmounting calls `await session.fork.dispose()`. Plugin unmount is registered via `ctx.effect()`.
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
  - Installed DSH 0.2.0-rc.2 packages were exercised in an isolated Cordis context for tool registration, skill retrieval, parameter projection, and output rendering. The system-prompt service was a fixture. This does not establish a live browser MCP session or full application readiness.
  - Full application startup, user-profile integration, and DSH live MCP connection readiness still require host-level validation. Local audit evidence is retained under `docs/analysis/audit-2026-10-14/runtime-acceptance/`; that ignored archive is not part of the distributed plugin.
