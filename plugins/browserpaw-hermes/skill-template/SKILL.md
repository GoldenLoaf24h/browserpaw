---
name: browserpaw
description: Control the user's active Chrome through the BrowserPaw Hermes plugin. Use for navigation, DOM inspection, forms, extraction, screenshots, media inspection, and durable multi-page tasks.
---

# BrowserPaw for Hermes

This plugin exposes a curated native wrapper set. Use only the `browserpaw_*` tools listed below; methods outside this set are unavailable here.

## Workflow

1. Inspect existing pages with `browserpaw_get_windows_and_tabs`. Reuse a suitable page or open one in the background with `browserpaw_navigate`.
2. For durable work, call `browserpaw_task` with `start`, then `open`. Keep the returned task ID and finish it in `finally` with `browserpaw_task`.
3. Before rediscovering a site, call `browserpaw_skill` with `find`. Run only a matching verified skill with new inputs. There is no permission to skip live result verification.
4. Observe with `browserpaw_read_dom`, `browserpaw_grep`, or `browserpaw_scroll_until_found`. Act only on refs from the current observation.
5. Use `browserpaw_fill_index` for one input and `browserpaw_batch_actions` for predictable multi-step flows. Verify the business result after acting.
6. Close only task-owned temporary pages with explicit tab IDs and task identity.

## Wrapper Set

- Task and learning: `browserpaw_task`, `browserpaw_skill`
- Navigation and tabs: `browserpaw_navigate`, `browserpaw_get_windows_and_tabs`, `browserpaw_switch_tab`, `browserpaw_close_tabs`
- Observation and extraction: `browserpaw_read_dom`, `browserpaw_grep`, `browserpaw_scroll_until_found`, `browserpaw_get_markdown`
- Actions: `browserpaw_interact_index`, `browserpaw_fill_index`, `browserpaw_batch_actions`, `browserpaw_smart_scroll`
- Visual and media: `browserpaw_screenshot`, `browserpaw_inspect_media`
- Optional on-page autonomy: `browserpaw_act_toward_goal`
- Contract lookup: `browserpaw_tool_docs`

See [tool matrix](references/tool-matrix.md) for key arguments and [troubleshooting](references/troubleshooting.md) for plugin diagnostics.

## Safety Rules

- Refs are positive integers and expire after navigation or node replacement. Never invent an index.
- A strict ambiguity error requires a more specific target; do not pick the first match.
- Unknown or timed-out mutations are `retry:false`. Observe before any new action.
- Never treat a trusted event, login-wall change, or HTTP response as proof of task completion.
- CAPTCHA, Cloudflare challenge, 2FA, payment, and login walls require the human user.
- Do not close user pages. Durable tasks survive a disconnected Hermes session.

## Recovery

- Stale ref: observe the current document again.
- Dynamic feed: use `browserpaw_scroll_until_found` or `browserpaw_grep` before manual scrolling.
- Modal or overlay: isolate it through `browserpaw_read_dom`; take over from the returned candidates.
- Ambiguous on-page goal: use the `currentElements` attached to `browserpaw_act_toward_goal`, then call an indexed wrapper without another DOM read.
- Plugin connection failure: follow [troubleshooting](references/troubleshooting.md).
