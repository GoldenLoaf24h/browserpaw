# Persistent Node REPL

Following a local build, run inside the repository:

```sh
node bin/browserpaw.cjs repl
```

The published native CLI entrypoint is `mcp-chrome-bridge repl`. The bridge must already be running; the entrypoint reads existing credentials and errors immediately if credentials are missing.

Within the same REPL session, variables and MCP connections persist continuously, supporting top-level await:

Multi-step workflows utilize the single connection's unified `browser === mcp` interface. `browser.help()` enumerates methods and JS signatures without loading full schemas; `await browser.help('locator.fill')` returns positional argument documentation for that specific method. A single object argument describes the object directly; multi-arguments are documented by position; for example, `skills.propose(definition)` no longer requires `{definition: ...}` wrapping. Help queries do not contact the browser or unlock/execute tools. To complete a task explicitly:

```js
await browser.help('locator.fill');
const task = await browser.task.start({ name: 'Read MDN' });
try {
  const page = await task.open('https://developer.mozilla.org/en-US/search?q=AbortController');
  const snapshot = await page.observe({ selector: 'main', format: 'compact' });
  console.log(snapshot.data);
} finally {
  await task.finish();
}
```

`page.frame(frameId)` scopes execution to a specific frame; `locator`, `getByText`, `getByRole`, and `getByLabel` share a common strict locator and action executor. `locator.fill(value)` defaults to replacement, preserves whitespace in input, and uses empty strings for clearing; explicit `{clear:false}` appends text. Supported actions include `click/fill/press/waitFor`; unrecognized methods or parameters are rejected, without claiming full Playwright compatibility. `task.cancel()` stops subsequent actions without rolling back dispatched actions; new connections must explicitly run `browser.task.takeOver(id,{confirm:true})` before resumption.

An AbortSignal passed via `mcp.call(name, args, {signal})` cancels only the immediate request without marking the durable task as cancelled. Pages already confirmed as created or handed back are committed to the ledger, and subsequent actions stop; a new connection can resume after verifying task identity and explicitly taking over. Only explicit `task.cancel()` alters the task lifecycle. Temporary tasks internal to skills attempt safe cleanup in finally blocks, retaining original unknown receipts upon cleanup errors.

Takeover confirmation waits for in-flight calls and ledger persistence for that task; it does not revoke dispatched actions. When a click or keystroke triggers full page navigation, first inspect the task's pending identity, then independently query `mcp.call('get_windows_and_tabs',{})` to cross-verify browserInstanceId, tabId, documentId, and URL. Confirm with `await browser.task.resume(task.id,{adopt:true})` only when matching recorded shifts. The task list represents an accounting ledger, not a replacement for live browser inventory. This method returns a task handle. Unconfirmed documents cannot proceed with further actions or report successful cleanup; `finish` throws and retains ownership, preventing unreleased pages from being falsely claimed as returned. Cancelled tasks cannot be resumed; pages with unresolved identity are retained until confirmed and closed.

Standard and fast observations reuse cached extraction results within the same document, identical parameters, and verifiable state; action delta feedback remains active. Changes in DOM, form controls, Shadow DOM, CSSOM, focus, viewport, or layout invalidate cache; animations, unreadable styles, or queries exceeding probe budgets trigger full extraction. `page.observe({includeDetails:true})` marks whether observations were reused per frame/document; clean default output omits this diagnostic block. It eliminates redundant DOM pruning, without representing zero-cost inspection or proof of business task completion.

When page creation succeeds but identity reading fails, the task retains `pendingCreations` receipts; as long as the page exists, further creation is blocked and cleanup completion cannot be reported. Receipts do not grant authority to close unknown documents. Raw `chrome_cdp_execute` also rejects task scoping: protocol targets can bypass page boundaries, requiring atomic tool invocation with explicit diagnostic targeting.

Unknown page creation outcomes must preserve pending receipts; these must not be silently discarded across reconnections or Native restarts. Late-arriving pages with known `tabId` may only be adopted via `resume({adopt:true})` if the browser reports the same managed instance and returns a verified `documentId`; URL equality alone is insufficient. Receipts without a `tabId` continue blocking new page creation. By default, `finish` returns unverified while receipts still resolve to pages, without claiming completed cleanup. Only when the user explicitly decides to retain all pending pages can `await task.finish({keepUnknownPages:true,confirm:true})` be invoked, preserving warning logs and handover receipts. This does not close those pages or prove they were cleaned up; automated skill teardown never enables this flag.

Pre-dispatch rejections carry `status:'blocked'` and `dispatched:false`; response wait timeouts carry `status:'unknown'` and `retry:false`. `requestDispatched` indicates whether the request entered the transport pipe, not physical execution or business success. Tasks, skills, and atomic MCP paths retain original receipts and content; error details are inspectable via `error.result`. Never infer lack of execution from a stack trace or timeout, and never blindly replay unknown mutations.

Known methods like `help('page.observe')` return bundled schemas locally; tools docs are fetched on-demand only when static schemas are missing, eliminating extra MCP roundtrips during initial exploration.

`skills.find(url,intent)` returns only verified production skills; `skills.propose(definition)` records candidates; `skills.validate(id)` runs two fresh-task trials with distinct inputs before auto-enabling, leaving previous production versions untouched upon failure. `skills.run(id,inputs)` checks output contracts on each execution, halting without replay on unknown results. X requires an active authenticated session; the existence of a candidate does not imply search or thread export acceptance.

Automated skill JavaScript uses audited program bodies bundled in the release package. DOM extraction on new sites declares `{tool:'chrome_javascript',args:{program:'dom-extract',config:{fields:[{name:'title',selector:'h1',value:'text'}]}},resultPath:'/result'}`; return values include `success`, `fields`, and `sources.page`. Configurations and executable code are validated separately; arbitrary code and disk write options are rejected before task creation. Field contracts and constraints are specified in the canonical skill [recipe contract](../../skills/browserpaw/references/recipe-contract.md).

Candidate for X search is `x-search-thread`; candidate for threads is `x-visible-thread`, taking `{author, postId, limit?}`. It returns only verified focal posts and loaded replies from the same author with verifiable parent links; prior posts, recommended items, and uncertain relations are excluded, without claiming complete tree export. Loading timeouts and authentication failures are reported separately.

The following `mcp.call()` examples provide direct access to atomic tools, maintaining raw result and image compatibility.

> **Creating Owned Tabs**: `chrome_navigate` with default `newWindow: false` may reuse an existing tab with the same URL. The example explicitly sets `newWindow: true, background: true`, requesting an independent window with `focused: false`. This avoids reusing user tabs; full background focus behavior still requires browser runtime verification. The new window's tab ID is found in `opened.data.tabs[0].tabId`, while single-tab returns use `opened.data.tabId`.

```js
const help = await browser.help('page.goto');
help.schema;
const opened = await mcp.call('chrome_navigate', {
  url: 'https://developer.mozilla.org/en-US/',
  newWindow: true,
  background: true,
});
opened.data ?? opened.text;
```

Proceed using the returned tabId. Never guess tabId, and do not assume return structures match full Playwright:

```js
const tabId = opened.data?.tabs?.[0]?.tabId ?? opened.data?.tabId;
const snapshot = await mcp.call('chrome_read_dom', { tabId, format: 'compact' });
snapshot.data ?? snapshot.text;
```

`mcp.call()` preserves MCP `content`, `structuredContent`, and appends unified `text`; `data` prefers structured results or parsed JSON after stripping tool category prompts. Prompts, images, and resources remain in raw `content`. Business errors and protocol errors both throw; code should inspect page state before retrying clicks or submissions.

Tools adapt to the active profile according to schemas returned by `mcp.tools()`. Long sequences prefer `chrome_batch_actions`; in-page extraction can use `chrome_javascript` with `mcp.run`. Node variables persist across page navigation, whereas page JS variables do not.

`await mcp.notes('https://developer.mozilla.org/')` prioritizes production skill summaries, falling back to exact-domain bundled recipes up to 4 KiB. Results indicate source, truncation status, and whether verification dates are missing or older than 90 days. It delivers reference context only; skill execution uses `skills.run`. Personal skills reside in `~/.browserpaw/skills` (governed by `BROWSERPAW_HOME`), bundled recipe sources are in `skills/browserpaw/assets/recipes/`, copied to Native `dist/recipes/` on build.

`.exit` closes the MCP connection only. Explicitly close self-created tabs during cleanup:

```js
await mcp.call('chrome_close_tabs', { tabIds: [tabId] });
```

The REPL executes in a standard Node process with local user permissions. Connections are restricted to loopback HTTP, never sending bridge tokens to remote URLs or fabricating tokens for unconfigured environments.

For downloads, run `await browser.help('page.download')` to inspect the contract. `await page.download({clickTargetIndex: ref})` registers page origin listeners before dispatching a single click via the shared executor; `ref` must originate from the latest observation. In-frame downloads use `page.frame(frameId).download(...)`. Avoid concurrent wait and click calls: tasks execute serially and will block each other.

The returned `download.guid` can be queried via `await page.download({guid})`, without re-clicking. It defaults to waiting for `completed`; explicit `waitForComplete:false` confirms initiation only. `suggestedFilename` is advisory; `verifiedPath:false` indicates disk paths are unproven. It operates with a distinct identity from Chrome numeric download IDs, preventing heuristic association by URL, filename, or timestamp. Origin-scoped mode rejects legacy extension versions, while unscoped atomic calls preserve browser-wide observation semantics.

Cancelled waits, timeouts, or unknown outcomes must never trigger re-execution. Cancelling a wait does not cancel active browser downloads. The task ledger tracks verified download state and timestamps; cleanup re-verifies origins, and in-progress or unknown downloads prevent automated tab closing. Use `handOff` or `finish({keep:[tabId]})` to return tabs to the user; borrowed pages are always retained. Handover does not verify completed downloads, and normal cleanup never deletes downloaded user files. Worker recovery without verification returns unknown status, leaving browser global download behavior undisturbed.
