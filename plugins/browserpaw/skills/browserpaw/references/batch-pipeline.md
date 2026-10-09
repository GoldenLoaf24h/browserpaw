# Pipelined Automation Reference (`browserpaw_batch_actions` & `browserpaw_form_pipeline`)

This reference documents BrowserPaw's pipelined execution engines for multi-step workflows, atomic assertions, and zero-RTT form filling.

---

## 1. `browserpaw_batch_actions`

Executes sequential browser interactions atomically inside a single MCP turn, eliminating multi-turn network latency.

### Action Types Reference

| Action         | Required Fields                       | Optional Fields                                   | Description                                           |
| :------------- | :------------------------------------ | :------------------------------------------------ | :---------------------------------------------------- |
| `click`        | `index` or `selector` or `coordinate` | `modifiers`, `waitForSettle`, `settleTimeoutMs`   | Physical mouse click (`isTrusted: true`)              |
| `double_click` | `index` or `selector` or `coordinate` | `modifiers`                                       | Double click at target element or coordinate          |
| `right_click`  | `index` or `selector` or `coordinate` | `modifiers`                                       | Context menu click                                    |
| `fill`         | (`index` or `selector`) + `text`      | `clear: true`, `pressEnter: true`, `submit: true` | Clears field, types text, dispatches input and change |
| `hover`        | `index` or `selector` or `coordinate` | -                                                 | Moves pointer over target                             |
| `scroll`       | `direction` + `amount`                | `coordinate`                                      | Scrolls viewport (`up`, `down`, `left`, `right`)      |
| `press_key`    | `key`                                 | -                                                 | Dispatches key press event (e.g. `Enter`, `Tab`)      |
| `wait`         | `durationMs` (or `at`)                | -                                                 | Explicit pause or deadline epoch timestamp in ms      |
| `fill_form`    | `fields` array                        | -                                                 | Batch fills multiple fields sequentially              |
| `assert`       | `selector` or `index` + `condition`   | `expectedText`, `timeoutMs`, `abortOnFailure`     | Validates DOM state mid-pipeline                      |
| `extract`      | `selector` or `index` + `property`    | `variableName`, `attributeName`                   | Extracts data directly to response payload            |

> **Note**: `fill_form` and `scroll` are batch sub-actions only. There are no top-level `browserpaw_fill_form`, `browserpaw_scroll`, or `browserpaw_scroll_to_text` tools — use `browserpaw_form_pipeline`, `browserpaw_smart_scroll`, or `browserpaw_grep` instead.

### Complete Example Pipeline

```json
{
  "tabId": 101,
  "actions": [
    { "type": "fill", "index": 2, "text": "flight from JFK to LHR", "pressEnter": true },
    { "type": "click", "index": 5 },
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

## 2. `browserpaw_form_pipeline`

Dedicated autonomous form filler for multi-step onboarding, surveys, checkout forms, and user profile updates.

```json
{
  "tabId": 101,
  "fields": [
    { "query": "Full Name", "value": "Jane Doe", "type": "text" },
    { "query": "Work Email", "value": "jane@example.com", "type": "text" },
    { "query": "Role", "value": "Developer", "type": "choice" },
    { "query": "Submit Application", "value": "Enter", "type": "enter" }
  ],
  "maxSteps": 20,
  "autoAdvance": true
}
```

- **True Input Commitment**: Verifies native input state triggers framework change events (`React`, `Vue`, `Angular`).
- **Auto-Advance**: When `autoAdvance: true` (default), automatically triggers step advancement (via Enter or clicking Next/Submit button).
- **Auto-Retry on Occlusion**: If a field is momentarily obscured by sticky headers or toasts, automatically scrolls into view and retries.
