# CLI and persistent REPL

`browserpaw` one-shot commands create and close an independent MCP session. Use `browserpaw repl` for a multi-step task: its `browser.task`, `page`, `locator`, `skills` and `help` facade shares one connection. Exiting releases that connection; it does not roll back actions or implicitly finish durable tasks. Follow [task lifecycle](task-skill-lifecycle.md) for explicit finish, recovery and takeover.

```sh
browserpaw --json chrome_doctor > doctor-result.json
browserpaw --json chrome_screenshot '{"tabId":123}' > screenshot-result.json
browserpaw repl
```

JSON mode preserves MCP `content`, `structuredContent`, `isError`, images and resources. Inspect metadata or use the host's local image viewer rather than pasting base64 into model context. Text mode prints text and warns when non-text content needs JSON mode. Tool/protocol/network errors produce a nonzero exit code; uncertain delivery is never replayed. Session cleanup has a bounded deadline and does not replace the original error.

Use `await browser.help()` and `await browser.help('page.observe')` inside the REPL to discover the supported subset. Do not assume full Playwright compatibility. A new connection requires explicit takeover before resuming another session's task. CLI-first machine session naming, cross-command persistence, and image-file delivery are future work, not capabilities of one-shot aliases.
