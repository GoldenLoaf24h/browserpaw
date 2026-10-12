---
name: browserpaw
description: Control and automate the user's active Chrome browser via the BrowserPaw Hermes plugin. Use when asked to browse the web, open URLs, search on Google/Bing/Baidu, fill out forms, click buttons, inspect or extract DOM/text/markdown, scrape web pages, take screenshots, or automate complex multi-step browser tasks. Operates natively inside Chrome with 1-based numeric DOM indexing, autonomous on-page micro-loops (browserpaw_act_toward_goal), and background tab isolation.
---

# BrowserPaw Browser Control Skill (Hermes Plugin)

Operates directly inside the user's active Chrome session via native CDP (`isTrusted: true`), preserving cookies, logins, and extensions.

> **Tool Availability Notice**: Standard BrowserPaw MCP exposes the full 50 toolset (under full profile; stdio defaults to core). The optional Hermes plugin exposes 16 curated wrapper tools (`browserpaw_*`). Other tools are not available in the Hermes plugin; use standard MCP.

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

## 1. Execution Hierarchy & 3-Tier Routing Ladder

Dual-Brain architecture: Agent acts as **System 2 (Macro Planner)** for multi-page orchestration; local server acts as **System 1 (`browserpaw_act_toward_goal`)** executing on-page perceive-decide-act loops.

|    Tier    | Layer                        | Primary Tools                                                                                                  | Operational Purpose                                                                                                                                                          |
| :--------: | :--------------------------- | :------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier 1** | **Semantic Micro-Loop**      | `browserpaw_act_toward_goal`                                                                                   | On-page exploratory action goals: searches, exploratory navigation, and multi-action flows when Jev is enabled.                                                              |
| **Tier 0** | **Deterministic Primitives** | `browserpaw_get_markdown` / `browserpaw_batch_actions` / `browserpaw_interact_index` / `browserpaw_fill_index` | Deterministic 2+ step form pipelines (`browserpaw_batch_actions`), direct text extraction (`browserpaw_get_markdown`), or candidate takeover on escalation.                  |
| **Tier 2** | **Visual & Inspection**      | `browserpaw_screenshot` / `browserpaw_inspect_media`                                                           | Visual inspection, canvas/layout verification, and media extraction. (For raw CDP, in-page JavaScript execution, or synthetic mouse emulation, use standard BrowserPaw MCP). |

---

## 2. Tool Selection by Intent (16 Curated Tools)

| Intent                         | Tool                                                                                  | Strategy & Key Arguments                                                                                                              |
| :----------------------------- | :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------ |
| **Fuzzy on-page action goals** | `browserpaw_act_toward_goal`                                                          | Interactive multi-action on-page goals when Jev is enabled: `{ goal: "Search for laptop and filter by brand Lenovo", maxSteps: 10 }`. |
| Open / back / forward          | `browserpaw_navigate`                                                                 | `{ url }` (`"back"` / `"forward"` for history), `background: true` (default, prevents focus theft).                                   |
| Read article / docs            | `browserpaw_get_markdown`                                                             | Clean structured text, 80%+ cheaper than full DOM; `fit: true` targets main article body.                                             |
| Find button / text             | `browserpaw_grep`                                                                     | Element lookup without full DOM dump; `autoScroll: true` probes virtual feeds. Returned index feeds `browserpaw_interact_index`.      |
| Scroll until element found     | `browserpaw_scroll_until_found`                                                       | `{ query, maxSteps: 10, stepPx: 800 }`. Client-side scroll, settles virtual DOM, centers element, returns live index.                 |
| Perceive page structure        | `browserpaw_read_dom`                                                                 | Auto-isolates active modals; `format: "compact"` (default) prunes DOM overhead; `dismissOverlays: true` dismisses modal overlays.     |
| Single input / search          | `browserpaw_fill_index`                                                               | `{ index, text, clear: true, pressEnter: true }` fills and submits in 1 turn. Preserves linebreaks in rich editors.                   |
| Click / hover element          | `browserpaw_interact_index`                                                           | `{ index, action: "click" }`. `pierceOverlay: true` (default) clicks beneath translucent masks.                                       |
| 2+ predictable steps           | `browserpaw_batch_actions`                                                            | Atomic pipeline (fill + click + wait) in 1 RTT. Default for login and search workflows.                                               |
| Scroll page / container        | `browserpaw_smart_scroll`                                                             | Auto-detects scrollable container; reports remaining scroll distance.                                                                 |
| Inspect media / audio / video  | `browserpaw_inspect_media`                                                            | Inspect page images, audio, video elements, and source streams.                                                                       |
| Page / element screenshot      | `browserpaw_screenshot`                                                               | Capture visual state for layout inspection or verification.                                                                           |
| Tab & window hygiene           | `browserpaw_get_windows_and_tabs` / `browserpaw_switch_tab` / `browserpaw_close_tabs` | Query existing tabs before opening duplicates. Closing requires explicit `tabIds`.                                                    |
| Tool docs & profile query      | `browserpaw_tool_docs`                                                                | Inspect schemas and documentation for available BrowserPaw tools.                                                                     |

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

### Status Handling

- `done`: Goal achieved; continue macro workflow.
- `paused`: Triggered by `pauseBeforeKeywords`; inspect state and commit explicitly.
- `escalate`: Ambiguous target or sensitive boundary. **Target candidates already indexed in `currentElements`; pick target `[n]` and call `browserpaw_interact_index` or `browserpaw_fill_index` directly. Do NOT re-invoke `browserpaw_read_dom`**.
- `stuck`: 3 steps without DOM/URL mutation; switch to atomic primitives (`browserpaw_interact_index`, `browserpaw_fill_index`, `browserpaw_batch_actions`).
- `blocked`: Challenge or authentication barrier detected; prompt user to complete verification in Chrome.
- `max_steps` / `timeout`: Step quota reached; inspect `currentElements` and proceed.

---

## 4. Operational Invariants

0. **Unified Action Routing Ladder**:
   - **Deterministic 2+ step actions**: Use `browserpaw_batch_actions` directly to execute the atomic pipeline in a single round-trip.
   - **Fuzzy exploratory goals**: Dispatch `browserpaw_act_toward_goal` when on-page semantic exploration is needed.
   - **Escalation & Takeover**: When `browserpaw_act_toward_goal` returns `escalate` or `paused`, immediately inspect attached `currentElements` candidates and take over with `browserpaw_interact_index` or `browserpaw_fill_index` without re-reading the DOM.
1. **Avoid Step-by-Step Polling**: Avoid manual `browserpaw_read_dom` -> single-click round-trip loops when a batch pipeline or autonomous goal can express the flow.
2. **Numeric 1-Based Indices**: Target elements strictly by `[n]` index from `browserpaw_read_dom`, `browserpaw_grep`, or `currentElements`. Do not guess CSS selectors.
3. **Zero-RTT Escalation Takeover**: When `browserpaw_act_toward_goal` escalates or pauses, consume attached `currentElements` immediately.
4. **Background Tab Discipline**: Open tabs with `background: true` to avoid stealing user OS focus.
5. **Destructive Close Guard**: `browserpaw_close_tabs` requires explicit `tabIds` to protect user tabs.
6. **Single-Turn Submission**: Use `pressEnter: true` on `browserpaw_fill_index` for search boxes and single-field forms.
7. **Overlay Handling**: Pass `pierceOverlay: true` on `browserpaw_interact_index`, or set `dismissOverlays: true` in `browserpaw_read_dom`.

---

## 5. Failure Recovery Protocols

- **Virtualized Feeds / Infinite Scroll**: Invoke `browserpaw_scroll_until_found { query, maxSteps: 10 }` or `browserpaw_grep { query, autoScroll: true }` instead of manual multi-turn scrolling.
- **Modal Occlusion**: `browserpaw_read_dom` auto-isolates modals. If collapsed unexpectedly, pass `isolateModal: false`.
- **Overlay Interference**: Pass `pierceOverlay: true` on `browserpaw_interact_index` or `dismissOverlays: true` on `browserpaw_read_dom`.
- **High-RTT Form Chains**: Consolidate into `browserpaw_batch_actions` with `waitForSettle: true`.
- **Anti-Bot / 2FA / CAPTCHA**: Prompt human user to complete verification in the browser window, then resume.
- **Standard MCP Full Capabilities**: For raw CDP access, in-page JavaScript evaluation, file upload automation, or OS-level mouse control, configure standard BrowserPaw MCP (50 tools).

---

## 6. References (Consult On Demand)

> **Notice**: Reference documents describe the full capabilities of standard BrowserPaw MCP. The optional Hermes plugin is restricted to the 16 curated tools listed above.

- `references/dual-brain-jev.md` — Micro-loop architecture, heuristic fallback, and takeover protocols.
- `references/tool-cheatsheet.md` — Complete contracts and parameter tables for all 50 registered tools.
- `references/batch-pipeline.md` — Multi-action batch grammar and assertions.
- `references/visual-fallback.md` — Screenshot calibration and visual inspection.
- `config/TROUBLESHOOTING.md` — Port conflicts, token auth, and native host repair.
