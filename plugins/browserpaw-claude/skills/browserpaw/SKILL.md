---
name: browserpaw
description: Control and automate the user's active Chrome browser through BrowserPaw. Use for navigation, search, forms, DOM inspection, extraction, screenshots, downloads, or multi-step browser workflows while preserving the user's sessions and tabs.
---

# BrowserPaw

BrowserPaw operates the user's Chrome session through MCP. Prefer task-owned pages, observed element references, strict locators, frame-qualified actions, and explicit business verification.

The default MCP profile exposes nine tools. Use `chrome_tool_docs` without arguments for categories, `{category:"observe"}` for names, and `{names:["chrome_screenshot"]}` for complete schemas. Add `activateForSession:true` with names to replace temporary visible tools; empty names resets them. Direct hidden-tool calls never expand the list.

Some clients namespace MCP tool names. Use the names exposed by the current runtime; `chrome_*` is the backend contract. Query the live contract with `chrome_tool_docs` instead of assuming another version's parameters.

## Core Workflow

1. For multi-step work, start a durable task and open a task-owned page:

   ```json
   {"action":"start","name":"Research documentation","goal":"Find and verify the requested source"}
   ```

   Keep the returned task ID, then call `chrome_task` with `action:"open"`, that `taskId`, and the URL. Task pages default to a budget of eight. Reaching it stops further creation; BrowserPaw never closes user pages to make room.

2. Before rediscovering a site, search verified local knowledge:

   ```json
   {"action":"find","url":"https://example.com","intent":"read the current release"}
   ```

   Run only the selected verified version with new inputs. No match means normal exploration. Static site notes are hints, not permission to skip live verification.

3. Observe before acting. Use refs returned by the current observation or strict CSS/role/text/label locators. Keep explicit frame targets. On stale refs, navigate, node replacement, or ambiguity, observe again instead of guessing.

4. For predictable multi-step work, prefer batch actions. For exploratory on-page work, use `chrome_act_toward_goal` when its runtime configuration is available. Use screenshots and computer actions only when DOM interaction is insufficient.

5. Verify the business result. A trusted event, HTTP 200, unchanged URL, or selected file is not by itself task completion. For unknown mutation results, observe or hand off; never replay the whole workflow.

6. Finish in `finally`:

   ```json
   {"action":"finish","taskId":"<taskId>"}
   ```

   Borrowed pages remain user-owned. Hand off explicit owned pages with `chrome_task` action `handOff`, or finish with `keep:[tabId]`. Cancellation stops later actions but does not roll back dispatched work.

If the current host exposes BrowserPaw's persistent JavaScript facade, the equivalent `browser.task`, `browser.skills`, and `browser.help` methods are documented in the lifecycle reference. MCP actions remain authoritative.

## Task And Skill Learning

Read [Task and skill lifecycle](references/task-skill-lifecycle.md) before using `chrome_task`, `chrome_skill`, downloads, candidate definitions, or recovery flows.

Personal learned skills live under `$BROWSERPAW_HOME/skills` (default `~/.browserpaw/skills`). Static bundled recipes live in `assets/recipes/` and are distributed into the Native runtime. Never persist credentials, cookies, tab/document IDs, temporary refs, coordinates, or user input in a learned skill.

## Browser Rules

- Refs are positive integers, not necessarily sequential. Navigation or node replacement expires them.
- Prefer background pages and preserve existing tabs unless the user explicitly asks to change them.
- Use strict locators when refs are unavailable; ambiguity is an error, not permission to choose the first match.
- Check actionability before dispatch. Disabled, hidden, unstable, persistent-motion, or covered targets should be rejected with a machine-readable reason.
- Observation scope is part of action safety. A modal, popover or Portal can make background text readable while still blocking background actions; re-observe or target the active scope instead of bypassing the check.
- Native text fill sends multiline text as one input operation and verifies the field, not a business submission. `pressEnter` is an explicit key step; `submit:true` requires a caller-provided `submitTarget`. Never combine both in one fill.
- For drafts and external writes, fill and inspect without sending unless the user explicitly authorizes the final action. A disabled button, highlighted button or changed page text is not proof that the business action completed.
- `clear:false` appends; the default replaces. Preserve whitespace and allow an empty string to clear.
- Dialog, popup, file chooser, and download events belong to their source tab/document/session. Require an explicit scoped target when more than one is possible.
- Do not use a browser-wide filename or URL match to claim a task download. Record and wait on a GUID plus source observation, or use one guarded trigger call.
- CAPTCHA, Cloudflare challenge, 2FA, payment confirmation, and login walls require human intervention unless the user explicitly completes that step.
- Unknown or timed-out writes are `retry:false`; inspect before deciding whether a new action is safe.

## Quick Reference

- Existing tabs: `get_windows_and_tabs`
- Navigate: `chrome_navigate` with `background:true`
- Compact observation: `chrome_read_dom`
- Article text: `chrome_get_markdown`
- Search page elements: `chrome_grep` or `chrome_scroll_until_found`
- Deterministic pipeline: `chrome_batch_actions`
- Strict candidate takeover: `chrome_interact_index` or `chrome_fill_index`
- Authenticated page API: `chrome_network_request` (verified GET where supported)
- Visual fallback: `chrome_screenshot` then `chrome_computer`
- Diagnostics: `chrome_doctor`

## CLI And Persistent Sessions

One-shot `browserpaw` commands open separate MCP sessions. Use `browserpaw repl` for multi-step task continuity; never automatically take over a task from another connection. `browserpaw --json <tool_name> '<json_args>'` preserves the complete result. Redirect image or resource payloads to a file rather than printing base64 into model context. See [CLI and REPL](references/cli-repl.md). CLI-first usage will become the recommendation only after persistent machine-oriented sessions and media delivery are verified.

## References

- [Tool cheat sheet](references/tool-cheatsheet.md)
- [Task and skill lifecycle](references/task-skill-lifecycle.md)
- [Recipe contract](references/recipe-contract.md)
- [Batch pipelines](references/batch-pipeline.md)
- [Interactive micro-loop](references/dual-brain-jev.md)
- [Visual fallback](references/visual-fallback.md)
- [Troubleshooting](references/TROUBLESHOOTING.md)
- [Troubleshooting (Chinese)](references/TROUBLESHOOTING.zh-CN.md)
