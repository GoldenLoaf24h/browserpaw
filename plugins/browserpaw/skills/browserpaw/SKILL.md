---
name: browserpaw
description: Control and automate the user's active Chrome browser via BrowserPaw MCP. Use when asked to browse the web, open URLs, search on Google/Bing/Baidu, fill out forms, click buttons, inspect or extract DOM/text/markdown, scrape web pages, handle logins/cookies, take screenshots, or automate complex multi-step browser tasks. Operates natively inside Chrome with 1-based numeric DOM indexing, autonomous on-page micro-loops (chrome_act_toward_goal), and background tab isolation.
---

# BrowserPaw Browser Control Skill

Operates directly inside the user's active Chrome session via native CDP (`isTrusted: true`), preserving cookies, logins, and extensions. React/Vue/Angular and deep Shadow DOM supported.

> **Tool Prefix**: Canonical tool names use `chrome_*` (46), `performance_*` (3), and `get_windows_and_tabs`. In Stdio mode, call canonical names directly; `browserpaw_*` is an HTTP/SSE convenience alias.

---

## 5-Step Quickstart (快速接入流程)

1. **Discover Tabs (查询标签页)**: Call `get_windows_and_tabs` to check existing tabs before opening duplicates.
2. **Open / Focus Target (导航目标)**: Call `chrome_navigate { url, background: true }` (or `chrome_switch_tab { tabId }`). Use `background: true` to avoid stealing user focus.
3. **Perceive or Automate (感知或微循环执行)**:
   - For goal-directed multi-action chains: Call `chrome_act_toward_goal { goal: "..." }` directly (70% of UI tasks).
   - For explicit inspection: Call `chrome_read_dom { format: "compact" }` for 1-based numeric indices or `chrome_get_markdown` for clean article text.
4. **Interact Precisely (精准操作)**: Call `chrome_interact_index { index, action: "click" }` or `chrome_fill_index { index, text, pressEnter: true }`. Never guess CSS selectors when an index is known.
5. **Verify & Clean Up (验证与收尾)**: Inspect return payload or delta. Close temporary task tabs via `chrome_close_tabs { tabIds: [...] }`.

---

## 1. Execution Hierarchy & 6-Tier Routing Ladder

Dual-Brain architecture: Agent acts as **System 2 (Macro Planner)** for multi-page orchestration; local server acts as **System 1 (`chrome_act_toward_goal`)** executing on-page perceive-decide-act loops at 200–400ms/step.

|    Tier    | Layer                             | Primary Tools                                                                                  |  Usage %  | Operational Purpose                                                                                                                                  |
| :--------: | :-------------------------------- | :--------------------------------------------------------------------------------------------- | :-------: | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier 1** | **Semantic Micro-Loop (DEFAULT)** | `chrome_act_toward_goal`                                                                       |  **70%**  | **Primary for on-page action goals**: searches, filters, clicks, form navigation. Delegates multi-action chains in 1 turn.                           |
| **Tier 0** | **Deterministic Primitives**      | `chrome_get_markdown` / `chrome_batch_actions` / `chrome_interact_index` / `chrome_fill_index` |  **20%**  | Text extraction (`get_markdown`), fixed multi-step pipelines (`batch_actions`), or takeover when `chrome_act_toward_goal` escalates with candidates. |
| **Tier 2** | **In-Page Scripting & API**       | `chrome_javascript` / `chrome_network_request`                                                 |  **5%**   | Complex rich-text composers, Shadow DOM inspection, or authenticated in-page fetches.                                                                |
| **Tier 3** | **Visual Fallback (PCIE)**        | `chrome_screenshot` / `chrome_computer`                                                        |  **3%**   | Canvas games, WebGL, unlabeled icon buttons, or anti-bot DOM-obfuscated layouts.                                                                     |
| **Tier 4** | **Human Handoff**                 | `chrome_request_human_intervention`                                                            |  **1%**   | CAPTCHA, Cloudflare Turnstile, 2FA, or payment confirmation.                                                                                         |
| **Tier 5** | **Raw CDP Escape Hatch**          | `chrome_cdp_execute`                                                                           | **<0.1%** | Direct CDP protocol commands when high-level tools are blocked.                                                                                      |

---

## 2. Tool Selection by Intent

| Intent                             | Tool                                                               | Strategy & Key Arguments                                                                                                                                                         |
| :--------------------------------- | :----------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **On-page action goals (DEFAULT)** | `chrome_act_toward_goal`                                           | **Primary for interactive on-page chains**: `{ goal: "Search for laptop and filter by brand Lenovo", maxSteps: 10 }`. Local execution in 200–400ms/step.                         |
| Open / back / forward              | `chrome_navigate`                                                  | `{ url }` (`"back"` / `"forward"` for history), `background: true` (default, prevents focus theft), `autoGroup: true` (default).                                                 |
| Read article / docs                | `chrome_get_markdown`                                              | Clean structured text, 80%+ cheaper than full DOM; `fit: true` targets main article body.                                                                                        |
| Find button / text                 | `chrome_grep`                                                      | Element lookup without full DOM dump; `autoScroll: true` probes virtual feeds. Returned index feeds `chrome_interact_index`.                                                     |
| Scroll until element found         | `chrome_scroll_until_found`                                        | `{ query, maxSteps: 10, stepPx: 800 }`. Client-side RAF scroll, settles virtual DOM, centers element, returns live index.                                                        |
| Perceive page structure            | `chrome_read_dom`                                                  | Auto-isolates active modals; `format: "compact"` (default) slashes tokens; `activeViewportOnly: true` prunes offscreen nodes; `flattenCards: true` exposes card action triggers. |
| Single input / search              | `chrome_fill_index`                                                | `{ index, text, clear: true, pressEnter: true }` fills and submits in 1 turn. Preserves linebreaks in rich editors.                                                              |
| Click / hover element              | `chrome_interact_index`                                            | `{ index, action: "click" }`. `pierceOverlay: true` (default) clicks beneath translucent masks. Pass `captureNetwork` to capture triggered API response.                         |
| 2+ predictable steps               | `chrome_batch_actions`                                             | Atomic pipeline (fill + click + wait + assert) in 1 RTT. Default for login and search workflows.                                                                                 |
| Multi-step form / wizard           | `chrome_form_pipeline`                                             | Autonomous field matching and progression; halts on CAPTCHA or validation errors.                                                                                                |
| Marketing popup / banner           | `chrome_dismiss_overlay`                                           | 1-step dismissal for coupon popups, consent banners, and overlays. Avoids manual DOM parsing.                                                                                    |
| Scroll page / container            | `chrome_smart_scroll`                                              | Auto-detects scrollable container; reports remaining scroll distance.                                                                                                            |
| Insert image / media               | `chrome_insert_media`                                              | Direct File paste/drop for rich-text editors (Draft.js/Lexical/X/Reddit); local files up to 50MB.                                                                                |
| Upload to `<input type=file>`      | `chrome_upload_file`                                               | `{ index, filePath }`. For dynamic drop zones, use `chrome_insert_media` or `clickTargetIndex`.                                                                                  |
| Canvas / WebGL / icon UI           | `chrome_screenshot` + `chrome_computer`                            | Visual fallback (PCIE). Requires screenshot calibration with `grid: true`.                                                                                                       |
| Run JS / fetch with cookies        | `chrome_javascript` / `chrome_network_request`                     | Page context execution with `mcp.*` helpers; authenticated in-page HTTP fetch bypassing CORS.                                                                                    |
| CAPTCHA / 2FA / payment            | `chrome_request_human_intervention`                                | Banner and cursor park; automatically resumes when human finishes.                                                                                                               |
| Tab & window hygiene               | `get_windows_and_tabs` / `chrome_switch_tab` / `chrome_close_tabs` | Query existing tabs before opening duplicates. Closing requires `confirm: true` or explicit `tabIds`.                                                                            |
| Diagnostic self-check              | `chrome_doctor`                                                    | Validates port 12306, extension link, token auth, and native host status.                                                                                                        |

---

## 3. On-Page Autonomy: `chrome_act_toward_goal`

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

- **With API Key (`TYPESAFE_API_KEY` or `JEV_API_KEY`)**: Uses TypeSafe Jev semantic scoring at 200–400ms/step.
- **Without API Key**: Automatically degrades to local deterministic **Heuristic Rule Engine**. When ambiguous, halts safely and returns indexed candidate elements for direct execution via `chrome_interact_index` or `chrome_fill_index` without re-reading the DOM.

### Status Handling

- `done`: Goal achieved; continue macro workflow.
- `paused`: Triggered by `pauseBeforeKeywords`; inspect `pausedBeforeAction` and commit explicitly.
- `escalate`: Ambiguous target or sensitive boundary. **Target candidates already indexed in `currentElements`; pick target `[n]` and call `chrome_interact_index` or `chrome_fill_index` directly. Do NOT re-invoke `chrome_read_dom`**.
- `stuck`: 3 steps without DOM/URL mutation; switch to atomic primitives.
- `blocked`: Bot challenge detected; invoke `chrome_request_human_intervention`.
- `max_steps` / `timeout`: Step quota reached; inspect `currentElements` and proceed.

---

## 4. Operational Invariants

0. **Jev Availability Default**: As long as chrome_act_toward_goal is available in the tool list, it represents the core autonomous decision engine. You must unconditionally prioritize dispatching multi-step browser interactions through Jev. It is strictly forbidden to prematurely fall back to manual single-step tool stacks (read_dom → interact_index) out of defensive or lazy tendencies. Only upon encountering definitive Jev call failures or a returned "escalate" state with insufficient candidate confidence, may you confidently initiate deterministic primitive tools.
1. **Semantic Micro-Loop First**: For interactive workflows, call `chrome_act_toward_goal` first. Avoid manual `chrome_read_dom` → `chrome_interact_index` turn loops.
2. **Numeric 1-Based Indices**: Target elements strictly by `[n]` index from `chrome_read_dom`, `chrome_grep`, or `currentElements`. Do not guess CSS selectors. For rich-text editors (Reddit, X), target `[composer]` directly with `chrome_fill_index`.
3. **Zero-RTT Escalation Takeover**: When `chrome_act_toward_goal` escalates or pauses, consume attached `currentElements` immediately. Do not waste a turn on `chrome_read_dom`.
4. **Dialog Isolation**: Native `alert`/`confirm`/`prompt` freezes page execution; resolve via `chrome_handle_dialog { action: "accept"|"dismiss" }` in an isolated call. Never auto-accept blindly.
5. **Background Tab Discipline**: Open tabs with `background: true` to avoid stealing user OS focus.
6. **Destructive Close Guard**: `chrome_close_tabs` requires `confirm: true` or explicit `tabIds` / `sessionId` to protect user tabs.
7. **Single-Turn Submission**: Use `pressEnter: true` on `chrome_fill_index` for search boxes and single-field forms.
8. **Piggybacked Deltas**: Pass `includeDelta: true` on interact/fill/batch calls to receive DOM mutations in the same response, eliminating follow-up `chrome_read_dom` calls.
9. **Dynamic Profile Unlock**: If a required tool is hidden under active profile, unlock on-demand via `chrome_tool_docs { category, activateForSession: true }`.
10. **Parameter Constraints**: `index` must be numeric; screenshots use `grid: true` for coordinate alignment; `chrome_javascript` requires `code`; file uploads require `index` or `clickTargetIndex`.

---

## 5. Failure Recovery Protocols

- **Virtualized Feeds / Infinite Scroll**: Invoke `chrome_scroll_until_found { query, maxSteps: 10 }` or `chrome_grep { query, autoScroll: true }` instead of manual multi-turn scrolling.
- **Modal Occlusion**: `chrome_read_dom` auto-isolates modals. If collapsed unexpectedly, pass `isolateModal: false` or specify `selector`.
- **Overlay Interference**: Dispatch `chrome_dismiss_overlay`, or pass `pierceOverlay: true` on `chrome_interact_index`.
- **High-RTT Form Chains**: Consolidate into `chrome_batch_actions` with `waitForSettle: true`.
- **Complex Multi-Step Forms**: Switch to `chrome_form_pipeline` with semantic matching.
- **Anti-Bot / 2FA / CAPTCHA**: Dispatch `chrome_request_human_intervention { reason }` and wait.
- **Persistent Failures**: Dispatch `chrome_cdp_execute` as low-level escape hatch; run `chrome_doctor` if bridge connectivity is broken.

---

## 6. References (Consult On Demand)

- `references/dual-brain-jev.md` — Micro-loop architecture, heuristic fallback, destructive guard, and takeover protocols.
- `references/tool-cheatsheet.md` — Complete contracts and parameter tables for all 50 registered tools.
- `references/batch-pipeline.md` — Multi-action batch grammar, assertions, network capture, and form pipelines.
- `references/visual-fallback.md` — Screenshot grid calibration, DPR scaling, and `chrome_computer` coordinates.
- `config/TROUBLESHOOTING.md` — Port conflicts, token auth, and native host repair.
