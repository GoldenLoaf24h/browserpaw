# Browser debugging

Use `browserpaw help debug` to find commands. Select a tab with `--tab ID` or a task page with `--task ID` and keep the same target while inspecting a recording.

## Network and console

```text
browserpaw network start --tab 12 --bodies --filter /api/
browserpaw nav reload --tab 12
browserpaw network list --tab 12 --status 200
browserpaw network show REQUEST_ID --tab 12 --out response.txt
browserpaw network stop --tab 12
browserpaw console --tab 12 --level error,warning --grep checkout
```

Network recording uses webRequest for metadata. `--bodies` uses Chrome's debugger for textual bodies. Capture filters limit the events recorded, while list filters narrow the view. `network clear` clears captured events for the selected page. A response body can be absent when Chrome has not finished loading it, it exceeded the capture limits, or it was binary. Treat captures as local diagnostics.

## Performance, emulation, and PDF

```text
browserpaw perf metrics --tab 12
browserpaw perf trace start --tab 12
browserpaw nav reload --tab 12
browserpaw perf trace stop --tab 12 --out trace.json
browserpaw emulate --viewport 390x844 --mobile --tab 12
browserpaw pdf --tab 12 --out page.pdf
browserpaw emulate reset --tab 12
```

Open an exported trace in Chrome DevTools Performance. Emulation applies to the selected tab and lasts until reset or debugger detach. Use a fresh observation and screenshot after changing geometry. Chrome may show a debugger banner while a capture or emulation is active. If DevTools takes over the target, verify the current state before continuing.

Use `cdp METHOD [JSON]` when a specific Chrome DevTools Protocol command is needed. Use the browser's returned error and the local CLI receipt to distinguish a rejection from an unknown dispatch. Observe the target before deciding how to continue after an unknown outcome.
