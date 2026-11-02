# Hermes wrapper matrix

Use only these wrapper names. Their schemas are exposed directly by the Hermes plugin.

| Tool                              | Use                              | Key arguments                                                                                                                        |
| --------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `browserpaw_task`                 | Durable task lifecycle           | `action`, `taskId`, `url`, `keep`, `confirm`                                                                                         |
| `browserpaw_skill`                | Verified site-skill lifecycle    | `action`, `url`, `intent`, `id`, `inputs`                                                                                            |
| `browserpaw_navigate`             | Open URL or navigate history     | `url`, `background`, `tabId`                                                                                                         |
| `browserpaw_get_windows_and_tabs` | Inspect existing pages           | no required argument                                                                                                                 |
| `browserpaw_switch_tab`           | Focus a known tab                | `tabId`                                                                                                                              |
| `browserpaw_close_tabs`           | Close explicit tab IDs           | `tabIds`                                                                                                                             |
| `browserpaw_read_dom`             | Observe page structure and refs  | `format`, `selector`, `limit`, `isolateModal`                                                                                        |
| `browserpaw_grep`                 | Find page elements or text       | `query`, `searchType`, `autoScroll`, `tabId`                                                                                         |
| `browserpaw_scroll_until_found`   | Search virtualized content       | `query`, `maxSteps`, `stepPx`, `tabId`                                                                                               |
| `browserpaw_get_markdown`         | Read article or document text    | `fit`, `includeLinks`, `tabId`                                                                                                       |
| `browserpaw_interact_index`       | Click, hover, focus, drag        | `index`, `action`, `frameId`, `end`                                                                                                  |
| `browserpaw_fill_index`           | Fill and verify one field        | `index`, `text`, `clear`, `pressEnter`, `submit`, `submitTarget`, `frameId`                                                          |
| `browserpaw_batch_actions`        | Predictable action pipeline      | `actions`, `tabId`, `settleTimeoutMs`, `includeDelta`                                                                                |
| `browserpaw_smart_scroll`         | Scroll the relevant container    | `direction`, `amount`, `tabId`                                                                                                       |
| `browserpaw_screenshot`           | Capture page or element          | `targetIndex`, `region`, `format`, `quality`, `fullPage`, `tabId`, `maxWidth`, `maxDimension`, `maxPixels`, `highClarity`, `savePng` |
| `browserpaw_inspect_media`        | List page media                  | `index`, `tabId`                                                                                                                     |
| `browserpaw_act_toward_goal`      | Bounded exploratory on-page loop | `goal`, `tabId`, `maxSteps`, `timeoutMs`, `pauseBeforeKeywords`, `verification`                                                      |
| `browserpaw_tool_docs`            | Read the live schema             | `category`, `activateForSession`                                                                                                     |

For a larger workflow, compose these wrappers through Hermes rather than inventing unavailable BrowserPaw methods.
