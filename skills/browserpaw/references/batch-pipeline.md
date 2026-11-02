# Pipelined Automation Reference (`chrome_batch_actions` & `chrome_form_pipeline`)

This reference documents BrowserPaw's pipelined execution engines for multi-step workflows and mid-pipeline assertions. One tool call reduces round trips; it does not eliminate model or browser execution time.

---

## 1. `chrome_batch_actions`

Executes sequential browser interactions inside one MCP call. It stops on failed or unknown outcomes instead of replaying a mutation.

### Action Types Reference

| Action         | Required Fields                       | Optional Fields                                   | Description                                           |
| :------------- | :------------------------------------ | :------------------------------------------------ | :---------------------------------------------------- |
| `click`        | `index` or `selector` or `coordinate` | `modifiers`, `waitForSettle`, `settleTimeoutMs`   | Physical mouse click (`isTrusted: true`)              |
| `double_click` | `index` or `selector` or `coordinate` | `modifiers`                                       | Double click at target element or coordinate          |
| `right_click`  | `index` or `selector` or `coordinate` | `modifiers`                                       | Context menu click                                    |
| `fill`         | (`index` or `selector`) + `text`      | `clear: true`, `submit: true`, `submitTarget`     | Fills and verifies the field only; submission is a separate explicit step unless a valid `submitTarget` is supplied |
| `hover`        | `index` or `selector` or `coordinate` | -                                                 | Moves pointer over target                             |
| `scroll`       | `direction` + `amount`                | `coordinate`                                      | Scrolls viewport (`up`, `down`, `left`, `right`)      |
| `press_key`    | `key`                                 | -                                                 | Dispatches key press event (e.g. `Enter`, `Tab`)      |
| `wait`         | `durationMs` (or `at`)                | -                                                 | Explicit pause or deadline epoch timestamp in ms      |
| `fill_form`    | `fields` array                        | -                                                 | Batch fills multiple fields sequentially              |
| `assert`       | `selector` or `index` + `condition`   | `expectedText`, `timeoutMs`, `abortOnFailure`     | Validates DOM state mid-pipeline                      |
| `extract`      | `selector` or `index` + `property`    | `variableName`, `attributeName`                   | Extracts data directly to response payload            |

> **Note**: `fill_form` and `scroll` are batch sub-actions only. There are no top-level `chrome_fill_form`, `chrome_scroll`, or `chrome_scroll_to_text` tools — use `chrome_form_pipeline`, `chrome_smart_scroll`, or `chrome_grep` instead.

### Complete Example Pipeline

```json
{
  "tabId": 101,
  "actions": [
    { "type": "fill", "index": 2, "text": "flight from JFK to LHR" },
    { "type": "press_key", "key": "Enter" },
    {
      "type": "assert",
      "selector": ".results-container",
      "condition": "visible",
      "timeoutMs": 5000,
      "abortOnFailure": true
    },
    {
      "type": "extract",
      "selector": ".flight-price-lowest",
      "property": "text",
      "variableName": "lowestPrice"
    }
  ],
  "includeDelta": true,
  "captureNetwork": {
    "urlPattern": "*/api/flights*",
    "method": "GET"
  }
}
```

### Assert Conditions

- `visible`: Target element is present in DOM and rendered (`offsetParent !== null`).
- `not_visible`: Target element is absent or hidden.
- `contains`: Text content or value contains `expectedText` (case-insensitive substring).
- `not_contains`: Text does not contain `expectedText`.
- `equals`: Text content or value strictly equals `expectedText`.
- `matches`: Text content or value matches regular expression `expectedText`.
- `enabled`: Target element is not disabled.
- `disabled`: Target element has `disabled` attribute or state.
- `valid`: Target form input passes HTML5 constraint validation.
- `invalid`: Target form input fails HTML5 constraint validation.
- `checked`: Checkbox or radio button is checked.
- `unchecked`: Checkbox or radio button is unchecked.

### Inline Network Capture (`captureNetwork`)

Pass an object configuration to capture matching HTTP requests and responses triggered during batch execution:

```json
"captureNetwork": {
  "urlPattern": "*/api/order*",
  "method": "POST",
  "timeoutMs": 5000,
  "statusCodes": [200, 201]
}
```

Returns matching request headers, response headers, HTTP status, and parsed JSON payload directly under `networkEvents`, eliminating extra turns.

---

## 2. `chrome_form_pipeline`

`chrome_form_pipeline` fills fields on the currently exposed form step. It does not guess a Next/Submit button and does not automatically advance after filling.

```json
{
  "tabId": 101,
  "fields": [
    { "query": "Full Name", "value": "Jane Doe", "type": "text" },
    { "query": "Work Email", "value": "jane@example.com", "type": "text" },
    { "query": "Role", "value": "Developer", "type": "choice" }
  ],
  "maxSteps": 20
}
```

- **Scoped effects**: Text fields are verified by reading back their values. A `choice` or `enter` action records a known dispatch, not a business result. No form, order or external write is marked accepted.
- **No implicit advancement**: A later step must be listed explicitly in `chrome_batch_actions`, for example a search `press_key`, a Next click, or a named submit target authorized by the user.
- **Explicit field actions**: `type:"choice"` clicks the named visible option; `type:"enter"` dispatches Enter as its own requested key action. Neither proves business completion.
- **Migration**: `autoAdvance:true` is retired and returns `migration_required` before changing a field.
- **Bounded recovery**: Ambiguous targets, unknown delivery and validation failures stop with completed fields and the original receipt. Do not retry an uncertain mutation.
- **Progress fields**: `completionScope:"current_step_actions"` and `businessOutcome:"not_verified"` distinguish completed local steps from later wizard or server work.

## 3. Safe Submission Patterns

**Draft: stop before Send/Post.** Fill the field, verify its value and return the current draft state. Do not include a guessed Send/Post click or Enter fallback.

```json
{
  "actions": [
    { "type": "fill", "index": 12, "text": "Draft text" },
    { "type": "assert", "index": 12, "condition": "equals", "expectedText": "Draft text" }
  ]
}
```

**Search: submit only when requested.** Use a separate key or an explicitly resolved search button, then verify the results independently.

```json
{
  "actions": [
    { "type": "fill", "index": 4, "text": "BrowserPaw" },
    { "type": "press_key", "key": "Enter" },
    { "type": "assert", "selector": "[data-testid=results]", "condition": "visible" }
  ]
}
```

**Unknown result: stop and inspect.** A response with `execution.status:"unknown"` means the mutation may already have happened. Do not append another click, press Enter, or rerun the pipeline. Read fresh evidence or hand the task back to the caller.
