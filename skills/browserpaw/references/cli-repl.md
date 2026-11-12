# CLI and persistent REPL

One-shot `browserpaw` commands create and close an independent MCP session. For machine driven multi-step work, use a named session:

```sh
browserpaw --json chrome_doctor > doctor-result.json
browserpaw --json chrome_screenshot '{"tabId":123}' > screenshot-result.json
browserpaw session create research
browserpaw session call research chrome_read_dom '{}'
browserpaw session call research chrome_screenshot '{}' --artifacts ./artifacts/research-shot
browserpaw session close research
browserpaw repl
```

Named sessions store only a local name, MCP session ID, port and timestamps under `$BROWSERPAW_HOME/cli-sessions/` (or `~/.browserpaw/cli-sessions/`). Calls for the same name are serialized with a lock. `session status` sends a `ping` and refreshes the idle window; `session close` explicitly releases the MCP connection. A missing or expired session is reported without reinitializing, taking over a task, or replaying a tool call. Finish or hand off durable tasks before closing the CLI session; closing the connection does not roll back browser actions.

JSON mode preserves MCP `content`, `structuredContent`, `isError`, images and resources. `--artifacts <empty-dir>` additionally writes the complete response to `result.json`, extracts image/resource payloads to `artifacts/`, and prints `manifest.json` with local paths and SHA-256 values. Use a new empty directory per call. Inspect metadata or use the host's local image viewer rather than pasting base64 into model context. Text mode prints text and warns when non-text content needs JSON or artifacts mode. Tool/protocol/network errors produce a nonzero exit code; uncertain delivery is never replayed. Session cleanup has a bounded deadline and does not replace the original error.

Use `await browser.help()` and `await browser.help('page.observe')` inside the REPL to discover the supported subset. Do not assume full Playwright compatibility. A new connection requires explicit takeover before resuming another session's task. Named CLI sessions preserve the connection between commands; they do not change task ownership or grant takeover authority.
