# Dual-Brain Semantic Micro-Loop Reference (`chrome_act_toward_goal`)

This reference documents BrowserPaw's Fast/System 1 local autonomous loop powered by TypeSafe Jev with built-in heuristic fallback.

---

## 1. System Architecture

```
┌─ System 2: Macro Planner (Remote LLM) ──────────────────┐
│  High-level goal decomposition, multi-page strategy,    │
│  reasoning, creative text generation, macro supervision │
└────────────────────────────┬────────────────────────────┘
                             │  chrome_act_toward_goal { goal: "..." }
                             ▼
┌─ System 1: Semantic Micro-Loop (Local Native Server) ──┐
│  Perceive compact DOM → Decide via Jev / Heuristic     │
│  → Dispatch CDP action → Verify outcome (200-400ms/step)│
└────────────────────────────┬────────────────────────────┘
                             │  Returns: status ("done" | "escalate" | ...)
                             ▼
```

- **Speed**: Local IPC execution cuts per-step latency from 3–6s down to 200–400ms.
- **Cost**: Eliminates repetitive multi-turn remote LLM calls for deterministic micro-steps.
- **Privacy**: Only a compact DOM budget (≤250 lines, sensitive password/file fields scrubbed) is evaluated.

---

## 2. Parameter Contract

```json
{
  "goal": "Click on 'Electronics', then select 'Smartphones'",
  "tabId": 101,
  "maxSteps": 10,
  "timeoutMs": 90000,
  "confidenceThreshold": 0.55,
  "textHint": "Optional text to type if not clearly quoted in goal",
  "pauseBeforeKeywords": ["Post", "Submit", "Pay"],
  "pressEnter": true,
  "mode": "local"
}
```

- `goal`: Natural language goal or objective on the active page (required).
- `tabId`: Target tab ID (optional, defaults to active tab).
- `maxSteps`: Default 10. Maximum 60 in Jev mode; forced ≤5 in Heuristic mode.
- `timeoutMs`: Default 90,000ms (90s); hard cap 300,000ms (5 minutes).
- `confidenceThreshold`: Default 0.55. Actions below this threshold trigger instant escalation.
- `textHint`: Explicit text to enter when typing if not clearly quoted in the goal string.
- `pauseBeforeKeywords`: Array of keyword strings (e.g. `["Post", "Submit", "Pay"]`). Halts execution with `status: "paused"` and `pausedBeforeAction` before dispatching an action against matching elements.
- `pressEnter`: Automatically press Enter key after typing actions (optional, boolean, default `false`).
- `mode`: Jev engine execution mode (`"off"` | `"local"` | `"remote"`). Defaults to active mode configured in extension popup or environment.

---

## 3. Three-Tier Jev Architecture & Degradation Ladder

### Engine Modes

1. **Tier 1 (Off)**:
   - Jev semantic execution is disabled by the user in the extension popup.
   - `chrome_act_toward_goal` is dynamically hidden from `tools/list` across all connected MCP sessions.
   - Direct execution attempts are intercepted with an explicit user authorization requirement.

2. **Tier 2 (Local)**:
   - Zero-cloud-latency, privacy-first local decider service running on port 8009 (`http://127.0.0.1:8009/v1/systemone`).
   - Powered by `Mapika/decider-2b` weights stored locally in `~/.browserpaw/models/decider-2b`.
   - Features automatic hot-loading, persistent background process management, and CUDA GPU acceleration with CPU fallback.
   - If local weights are missing or service cannot be reached, cleanly falls back to heuristic engine with `fallbackReason: "local_service_offline"`.

3. **Tier 3 (Remote)**:
   - Cloud TypeSafe Jev System One model requiring `TYPESAFE_API_KEY` (or `JEV_API_KEY`).
   - Supports custom `baseUrl` and `modelId` persisted in `~/.browserpaw/jev-remote.json`.
   - On 401 unauthenticated, latches key invalidation for 5 minutes and falls back to heuristic engine.

### Heuristic Rule Fallback

- Zero-dependency string tokenization, role weighting, and bigram matching.
- Activates automatically when no API key or local model is available, or when service is offline.
- Bounded execution: `maxSteps` is automatically capped at $\le 5$ in heuristic mode.

### Macro Escalation to Caller LLM

- When confidence drops below threshold or ambiguity/stuck state is reached, immediately returns control to the primary LLM with structured diagnostic context and fresh indexed candidate elements (`currentElements`).

---

## 4. Response Contract

```json
{
  "status": "done",
  "engine": "jev",
  "engineSwitched": false,
  "fallbackReason": null,
  "summary": "Clicked 'Electronics' and selected 'Smartphones'",
  "steps": [
    {
      "action": "click",
      "target": { "index": 4, "text": "Electronics", "role": "button" },
      "confidence": 0.92,
      "outcome": { "mutated": true, "urlChanged": false, "visualDiff": 0.12 }
    }
  ],
  "finalPage": { "url": "https://example.com/shop", "title": "Shop" },
  "currentElements": ["[1] input: Search", "[2] button: Cart (0)", "[4] button: Electronics"],
  "pausedBeforeAction": null,
  "jevUsage": { "calls": 2, "inputTokens": 840, "estCostUsd": 0.000035 }
}
```

### Possible Statuses

- `"done"`: Goal successfully achieved (`goal_done >= 0.85` or heuristic coverage $\ge 0.80$).
- `"paused"`: Safety breakpoint hit before executing an action matching `pauseBeforeKeywords`. Caller inspects `pausedBeforeAction` and `currentElements` without action execution.
- `"escalate"`: Low confidence, destructive action detected, or ambiguous decision. Caller LLM should resume with standard Tier 0 tools.
- `"stuck"`: 3 consecutive steps without DOM mutation, URL change, or visual change.
- `"blocked"`: Anti-bot challenge or captcha detected.
- `"max_steps"`: Reached `maxSteps` limit before completing goal.
- `"timeout"`: Execution time exceeded `timeoutMs`.

---

## 5. Escalation Guard Rules

The micro-loop evaluates guard conditions in strict priority order:

1. **Safety Breakpoint Guard (`pauseBeforeKeywords`)**: Evaluated _before_ destructive guard. If the proposed element matches any keyword in `pauseBeforeKeywords`, execution immediately halts with `status: "paused"`, populating `pausedBeforeAction` and fresh `currentElements` while leaving page state untouched.
2. **Low Confidence**: `action confidence < 0.55` or `target confidence < 0.45`.
3. **Destructive Guard**: Detects actions matching protected keywords (`pay`, `delete`, `purchase`, `buy`, `submit`, `confirm`) or Jev `destructive >= 0.50`. The keyword match runs against the element's **human-visible text/label only** — never its `id`, `class`, or `href`. This prevents kebab-case false positives (e.g. the Reddit "Add tags" button with `id="#reddit-post-flair-button"` is NOT treated as destructive; only a button whose visible text actually says "Post"/"Submit" is).
4. **Stuck Circuit-Breaker**: 3 consecutive unchanged steps ($mutated=false$, $urlChanged=false$, $visualDiff \le 0.01$).
5. **Ambiguous Input**: Typing required but text payload cannot be determined.

---

## 6. Macro Supervisor Recovery Protocol

When `chrome_act_toward_goal` yields with `status === "paused"`, `"escalate"`, `"stuck"`, or `"max_steps"`, the Macro Planner (System 2) resumes control using the following protocol:

1. **Handling Safety Breakpoint Pauses (`status === "paused"`)**:
   - Inspect `pausedBeforeAction` (e.g. `{ action: "click", target: { index: 12, text: "Post" } }`) and review draft content in `currentElements`.
   - If draft/form state is verified and ready to commit, dispatch `chrome_interact_index { index: pausedBeforeAction.target.index }` (or prompt human user for final approval).
   - Zero DOM re-read required: target indices are fresh and guaranteed valid.

2. **Zero-Read Element Re-Use**:
   - The escalation response includes `currentElements`, an array of 1-based indexed element strings (e.g. `"[4] button: 'Confirm Purchase'"`).
   - The Macro Planner can select the target index directly from this array without executing an extra `chrome_read_dom` call.

3. **Handling Sensitive / Destructive Actions**:
   - If escalated due to `destructive >= 0.50` or protected keywords (`pay`, `delete`, `purchase`, `buy`, `submit`, `confirm`), the Macro Planner evaluates user intent and authorization before dispatching `chrome_interact_index { index: N }`.

4. **Fallback to Tier 0 Primitives**:
   - For single clicks or selections: `chrome_interact_index { index: N, includeDelta: true }`.
   - For single text entries: `chrome_fill_index { index: N, text: "...", pressEnter: true }`.
   - For media injection: `chrome_insert_media { index: N, filePath: "..." }`.
   - For multi-step sequences: `chrome_batch_actions { actions: [...] }` (_see `batch-pipeline.md`_).

5. **Handling CAPTCHA / Bot Blocks**:
   - When `status === "blocked"`, immediately invoke `chrome_request_human_intervention { reason: "..." }` to yield control to the human user.
