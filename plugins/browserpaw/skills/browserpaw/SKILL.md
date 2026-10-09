---
name: browserpaw
description: Control and automate the user's active Chrome browser via BrowserPaw MCP. Use when asked to browse the web, open URLs, search on Google/Bing/Baidu, fill out forms, click buttons, inspect or extract DOM/text/markdown, scrape web pages, handle logins/cookies, take screenshots, or automate complex multi-step browser tasks. Operates natively inside Chrome with 1-based numeric DOM indexing, autonomous on-page micro-loops (browserpaw_act_toward_goal), and background tab isolation.
---

# BrowserPaw Browser Control Skill

Operates directly inside the user's active Chrome session via native CDP (`isTrusted: true`), preserving cookies, logins, and extensions. React/Vue/Angular and deep Shadow DOM supported.

> **Tool Prefix**: Canonical tool names use `browserpaw_*` (46), `performance_*` (3), and `browserpaw_get_windows_and_tabs`. In Stdio mode, call canonical names directly; `browserpaw_*` is an HTTP/SSE convenience alias.

---

## 5-Step Quickstart

1. **Discover Tabs**: Call `browserpaw_get_windows_and_tabs` to check existing tabs before opening duplicates.
2. **Open / Focus Target**: Call `browserpaw_navigate { url, background: true }` (or `browserpaw_switch_tab { tabId }`). Use `background: true` to avoid stealing user focus.
3. **Perceive or Automate**:
   - For goal-directed multi-action chains: Call `browserpaw_act_toward_goal { goal: "..." }` when autonomous loop is configured.
   - For explicit inspection: Call `browserpaw_read_dom { format: "compact" }` for 1-based numeric indices or `browserpaw_get_markdown` for clean article text.
4. **Interact Precisely**: Call `browserpaw_interact_index { index, action: "click" }` or `browserpaw_fill_index { index, text, pressEnter: true }`. Never guess CSS selectors when an index is known.
5. **Verify & Clean Up**: Inspect return payload or delta. Close temporary task tabs via `browserpaw_close_tabs { tabIds: [...] }`.

---

## 1. Execution Hierarchy & 6-Tier Routing Ladder

Dual-Brain architecture: Agent acts as **System 2 (Macro Planner)** for multi-page orchestration; local server acts as **System 1 (`browserpaw_act_toward_goal`)** executing on-page perceive-decide-act loops.

|    Tier    | Layer                             | Primary Tools                                                                                  | Operational Purpose                                                                                                                                  |
| :--------: | :-------------------------------- | :--------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier 1** | **Semantic Micro-Loop**           | `browserpaw_act_toward_goal`                                                                       | On-page exploratory action goals: searches, exploratory navigation, and multi-action flows when Jev is enabled.                                      |
| **Tier 0** | **Deterministic Primitives**      | `browserpaw_get_markdown` / `browserpaw_batch_actions` / `browserpaw_interact_index` / `browserpaw_fill_index` | Deterministic 2+ step form pipelines (`batch_actions`), direct text extraction (`get_markdown`), or candidate takeover on escalation.             |
| **Tier 2** | **In-Page Scripting & API**       | `browserpaw_javascript` / `browserpaw_network_request`                                                 | Complex rich-text composers, Shadow DOM inspection, or authenticated in-page fetches.                                                                |
| **Tier 3** | **Visual Fallback (PCIE)**        | `browserpaw_screenshot` / `browserpaw_computer`                                                        | Canvas games, WebGL, unlabeled icon buttons, or anti-bot DOM-obfuscated layouts.                                                                     |
| **Tier 4** | **Human Handoff**                 | `browserpaw_request_human_intervention`                                                            | CAPTCHA, Cloudflare Turnstile, 2FA, or payment confirmation.                                                                                         |
| **Tier 5** | **Raw CDP Escape Hatch**          | `browserpaw_cdp_execute`                                                                           | Direct CDP protocol commands when high-level tools are blocked.                                                                                      |

---

## 2. Tool Selection by Intent

| Intent                             | Tool                                                               | Strategy & Key Arguments                                                                                                                                                         |
| :--------------------------------- | :----------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fuzzy on-page action goals**     | `browserpaw_act_toward_goal`                                           | Interactive multi-action on-page goals when Jev is enabled: `{ goal: "Search for laptop and filter by brand Lenovo", maxSteps: 10 }`.                        |
| Open / back / forward              | `browserpaw_navigate`                                                  | `{ url }` (`"back"` / `"forward"` for history), `background: true` (default, prevents focus theft), `autoGroup: true` (default).                                                 |
| Read article / docs                | `browserpaw_get_markdown`                                              | Clean structured text, 80%+ cheaper than full DOM; `fit: true` targets main article body.                                                                                        |
| Find button / text                 | `browserpaw_grep`                                                      | Element lookup without full DOM dump; `autoScroll: true` probes virtual feeds. Returned index feeds `browserpaw_interact_index`.                                                     |
| Scroll until element found         | `browserpaw_scroll_until_found`                                        | `{ query, maxSteps: 10, stepPx: 800 }`. Client-side RAF scroll, settles virtual DOM, centers element, returns live index.                                                        |
| Perceive page structure            | `browserpaw_read_dom`                                                  | Auto-isolates active modals; `format: "compact"` (default) slashes tokens; `activeViewportOnly: true` prunes offscreen nodes; `flattenCards: true` exposes card action triggers. |
| Single input / search              | `browserpaw_fill_index`                                                | `{ index, text, clear: true, pressEnter: true }` fills and submits in 1 turn. Preserves linebreaks in rich editors.                                                              |
| Click / hover element              | `browserpaw_interact_index`                                            | `{ index, action: "click" }`. `pierceOverlay: true` (default) clicks beneath translucent masks. Pass `captureNetwork` to capture triggered API response.                         |
| 2+ predictable steps               | `browserpaw_batch_actions`                                             | Atomic pipeline (fill + click + wait + assert) in 1 RTT. Default for login and search workflows.                                                                                 |
| Multi-step form / wizard           | `browserpaw_form_pipeline`                                             | Autonomous field matching and progression; halts on CAPTCHA or validation errors.                                                                                                |
| Marketing popup / banner           | `browserpaw_dismiss_overlay`                                           | 1-step dismissal for coupon popups, consent banners, and overlays. Avoids manual DOM parsing.                                                                                    |
| Scroll page / container            | `browserpaw_smart_scroll`                                              | Auto-detects scrollable container; reports remaining scroll distance.                                                                                                            |
| Insert image / media               | `browserpaw_insert_media`                                              | Direct File paste/drop for rich-text editors (Draft.js/Lexical/X/Reddit); local files up to 50MB.                                                                                |
| Upload to `<input type=file>`      | `browserpaw_upload_file`                                               | `{ index, filePath }`. For dynamic drop zones, use `browserpaw_insert_media` or `clickTargetIndex`.                                                                                  |
| Canvas / WebGL / icon UI           | `browserpaw_screenshot` + `browserpaw_computer`                            | Visual fallback (PCIE). Requires screenshot calibration with `grid: true`.                                                                                                       |
| Run JS / fetch with cookies        | `browserpaw_javascript` / `browserpaw_network_request`                     | Page context execution with `mcp.*` helpers; authenticated in-page HTTP fetch bypassing CORS.                                                                                    |
| CAPTCHA / 2FA / payment            | `browserpaw_request_human_intervention`                                | Banner and cursor park; automatically resumes when human finishes.                                                                                                               |
| Tab & window hygiene               | `browserpaw_get_windows_and_tabs` / `browserpaw_switch_tab` / `browserpaw_close_tabs` | Query existing tabs before opening duplicates. Closing requires `confirm: true` or explicit `tabIds`.                                                                            |
| Diagnostic self-check              | `browserpaw_doctor`                                                    | Validates port 12306, extension link, token auth, and native host status.                                                                                                        |

---

## 3. On-Page Autonomy: `browserpaw_act_toward_goal`

Execute interactive on-page tasks in a single turn:

```json
{
  "goal": "Type 'wireless keyboard' into the search bar and submit",
  "tabId": 101,
  "maxSteps": 10,
  "pauseBeforeKeywords": ["Post", "Pay", "Submit"]
}
```

### Engine Execution & Fallback

- **With Authorized Jev Configuration**: Uses TypeSafe Jev System One semantic scoring (local model on port 8009 or remote API with valid key).
- **Configuration Boundary**: When disabled in popup (off mode) or misconfigured, the tool is hidden or safely returns a configuration error rather than silently degrading without authorization. When local heuristic scoring is actively engaged as an authorized fallback, execution is strictly bounded (maxSteps <= 5); on ambiguity, halts and returns indexed candidates for direct primitive execution without re-reading the DOM.

### Status Handling

- `done`: Goal achieved; continue macro workflow.
- `paused`: Triggered by `pauseBeforeKeywords`; inspect `pausedBeforeAction` and commit explicitly.
- `escalate`: Ambiguous target or sensitive boundary. **Target candidates already indexed in `currentElements`; pick target `[n]` and call `browserpaw_interact_index` or `browserpaw_fill_index` directly. Do NOT re-invoke `browserpaw_read_dom`**.
- `stuck`: 3 steps without DOM/URL mutation; switch to atomic primitives.
- `blocked`: Bot challenge detected; invoke `browserpaw_request_human_intervention`.
- `max_steps` / `timeout`: Step quota reached; inspect `currentElements` and proceed.

---

## 4. Operational Invariants

0. **Unified Action Routing Ladder**:
   - **Deterministic 2+ step actions**: When actions are predictable ahead of time (e.g. login form fill + submit, sequential multi-field data entry, standard checkout forms), use `browserpaw_batch_actions` directly to execute the atomic pipeline in a single round-trip.
   - **Fuzzy exploratory goals**: When goals are multi-step and require on-page semantic exploration, dispatch `browserpaw_act_toward_goal` if Jev is authorized and configured. Do not assume automatic unconfigured fallback when off or misconfigured.
   - **Escalation & Takeover**: When `browserpaw_act_toward_goal` returns `escalate` or `paused`, immediately inspect attached `currentElements` candidates and take over with `browserpaw_interact_index` or `browserpaw_fill_index` without re-reading the DOM.
   - **Sensitive boundaries**: Always halt and dispatch `browserpaw_request_human_intervention` on CAPTCHA, 2FA, Cloudflare Turnstile, or payment authorizations.
1. **Avoid Step-by-Step Polling**: Avoid manual `browserpaw_read_dom` → single-click round-trip loops when a batch pipeline or autonomous goal can express the flow.
2. **Numeric 1-Based Indices**: Target elements strictly by `[n]` index from `browserpaw_read_dom`, `browserpaw_grep`, or `currentElements`. Do not guess CSS selectors. For rich-text editors (Reddit, X), target `[composer]` directly with `browserpaw_fill_index`.
3. **Zero-RTT Escalation Takeover**: When `browserpaw_act_toward_goal` escalates or pauses, consume attached `currentElements` immediately. Do not waste a turn on `browserpaw_read_dom`.
4. **Dialog Isolation**: Native `alert`/`confirm`/`prompt` freezes page execution; resolve via `browserpaw_handle_dialog { action: "accept"|"dismiss" }` in an isolated call. Never auto-accept blindly.
5. **Background Tab Discipline**: Open tabs with `background: true` to avoid stealing user OS focus.
6. **Destructive Close Guard**: `browserpaw_close_tabs` requires `confirm: true` or explicit `tabIds` / `sessionId` to protect user tabs.
7. **Single-Turn Submission**: Use `pressEnter: true` on `browserpaw_fill_index` for search boxes and single-field forms.
8. **Piggybacked Deltas**: Pass `includeDelta: true` on interact/fill/batch calls to receive DOM mutations in the same response, eliminating follow-up `browserpaw_read_dom` calls.
9. **Dynamic Profile Unlock & Prompt Optimization**: Tool profiles (`core`, `crawl`, `full`) optimize prompt context and token consumption for model selection; they do not function as a security ACL boundary. If a required tool is omitted under the active profile view, query or activate the category on-demand via `browserpaw_tool_docs { category, activateForSession: true }`.
10. **Parameter Constraints**: `index` must be numeric; screenshots use `grid: true` for coordinate alignment; `browserpaw_javascript` requires `code`; file uploads require `index` or `clickTargetIndex`.

---

## 5. Failure Recovery Protocols

- **Virtualized Feeds / Infinite Scroll**: Invoke `browserpaw_scroll_until_found { query, maxSteps: 10 }` or `browserpaw_grep { query, autoScroll: true }` instead of manual multi-turn scrolling.
- **Modal Occlusion**: `browserpaw_read_dom` auto-isolates modals. If collapsed unexpectedly, pass `isolateModal: false` or specify `selector`.
- **Overlay Interference**: Dispatch `browserpaw_dismiss_overlay`, or pass `pierceOverlay: true` on `browserpaw_interact_index`.
- **High-RTT Form Chains**: Consolidate into `browserpaw_batch_actions` with `waitForSettle: true`.
- **Complex Multi-Step Forms**: Switch to `browserpaw_form_pipeline` with semantic matching.
- **Anti-Bot / 2FA / CAPTCHA**: Dispatch `browserpaw_request_human_intervention { reason }` and wait.
- **Persistent Failures**: Dispatch `browserpaw_cdp_execute` as low-level escape hatch; run `browserpaw_doctor` if bridge connectivity is broken.

---

## 6. References (Consult On Demand)

- `references/dual-brain-jev.md` — Micro-loop architecture, heuristic fallback, destructive guard, and takeover protocols.
- `references/tool-cheatsheet.md` — Complete contracts and parameter tables for all 50 registered tools.
- `references/batch-pipeline.md` — Multi-action batch grammar, assertions, network capture, and form pipelines.
- `references/visual-fallback.md` — Screenshot grid calibration, DPR scaling, and `browserpaw_computer` coordinates.
- `config/TROUBLESHOOTING.md` — Port conflicts, token auth, and native host repair.
