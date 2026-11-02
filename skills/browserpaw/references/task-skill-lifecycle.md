# Task and Skill Lifecycle

Use `chrome_task` and `chrome_skill` for portable MCP workflows. Query `chrome_tool_docs` for the installed version's live contract.

If the host also exposes BrowserPaw's persistent JavaScript facade, the same operations are available as `browser.task.*`, `browser.skills.*`, and `browser.help(name)`.

## Task Ownership

- `chrome_task` action `start` creates a durable task independent of the MCP connection.
- Action `open` creates an owned page; a verified creation receipt is required before treating its identity as known.
- Action `status` exposes pending creations, document identity, downloads, and page ownership.
- Action `takeOver` with `confirm:true` transfers task control to the current authorized client.
- Action `resume` with `adopt:true` adopts a known pending document only after fresh inventory verifies browser, tab, document, and URL.
- A pending receipt with a known tab is never adopted from URL alone: explicit `resume({adopt:true})` requires the same browser instance, an agent-managed tab, and a concrete `documentId`.
- Action `handOff` gives an owned page to the user. Action `finish` with `keep:[tabId]` does the same during finalization.
- Action `finish` with `keepUnknownPages:true,confirm:true` retains unresolved known or tab-less creation receipts without closing them; it never claims cleanup.
- Action `cancel` stops later task work. It does not roll back a mutation already dispatched and does not conceal unknown state.

With the persistent facade, request cancellation uses `mcp.call(name,args,{signal})`. A page creation or handoff confirmed before cancellation remains in the ledger.

## Downloads

- Observe a download GUID and source page before waiting on it.
- Or call `chrome_handle_download` with `taskId` or `tabId` plus `clickTargetIndex`; one invocation installs the source listener and performs one guarded click.
- With the persistent facade, `page.download({clickTargetIndex})` provides the same compound operation.
- Do not run a wait and a separate click concurrently inside one task; the task lock prevents the click from entering.
- Scoped waits never fall back to browser-wide filename matching. A suggested filename is not a verified disk path.
- Cancellation stops the wait, not the browser download. Active or unknown downloads must be retained or handed off rather than misreported as cleaned up.

## Learned Skills

Learned skills are stored under `$BROWSERPAW_HOME/skills`, default `~/.browserpaw/skills`. They are shared by every MCP client connected to the same Native service.

A candidate contains:

- `id`, `name`, `description`
- `source:{type:'agent',urls:[...]}`
- exact `domains`, `keywords`, and `startUrl`
- `inputSchema` and `outputSchema`
- executable `steps:[{tool,args,resultPath?}]`
- independent DOM or GET `verification`
- at least two tests with different inputs

Use `chrome_skill` actions `propose`, `validate`, and `run`, and run only an active verified version. Keep the previous active version until validation succeeds. Disable or roll back on structural mismatch; do not learn a new rule from a temporary network failure.

URL placeholders such as `{{key}}` are percent-encoded. Page code receives JSON-serialized input. Never concatenate user input into JavaScript.

The data-only `dom-extract` program is the preferred fixed read template:

```js
{
  tool: 'chrome_javascript',
  args: {
    program: 'dom-extract',
    config: {
      fields: [
        {name: 'title', selector: 'h1', value: 'text'}
      ]
    }
  },
  resultPath: '/result'
}
```

The result is `{success,fields,sources:{page}}`. A selector matching more than 250 elements fails with `limit_exceeded`; a text or attribute value over 10,000 characters fails with `value_limit_exceeded`. Missing single values are `null`; missing multiple values are `[]`.

Bundled read recipes are:

- `mdn-search`
- `github-releases`
- `npm-compare`
- `x-search-thread`
- `x-visible-thread`

A bundled recipe still starts as a candidate. Validate it before first reuse. X recipes require a usable login environment.

## Result States

Keep action delivery and business completion separate:

- `blocked`, `dispatched:false`: refused before dispatch.
- `dispatched:true`: request was sent; this does not prove a physical UI action.
- `unknown`, `retry:false`: transport or page state cannot prove the result. Observe before another write.
- `verified:false`: completion was not proven.
- `verified:true`: the declared postcondition was observed.

Preserve the original error object, MCP content, images, and action receipt. Never replace a known failure with success.
