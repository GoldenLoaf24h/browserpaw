# jev Capabilities Inventory (Phase 1 Output)

## What is jev

TypeSafe System One's flagship fast decision model: inputs natural language + structured state, outputs typed judgments with probabilities (choice/noul/score), does not generate text. Integrated in this repository via @typesafe-ai/sdk 0.6.0, powering the act_toward_goal semantic micro-loop.

## Current Capabilities (Code Truth)

1. chrome_act_toward_goal / fast_decision tool (register-tools.ts invokes FastDecisionEngine.run): Each step executes Perception (read_dom compact viewport tree) -> 7 parallel System One questions (action/click_target/type_target/select_target/goal_done/stuck/destructive) -> Execution (click/type/select/scroll/back/wait) -> Record. jev performs 1 query per step; select action invokes scoreOptions a second time (score primitive, >10 options heuristic shortlist first).
2. Dual-engine hierarchy: jev (when TYPESAFE_API_KEY is present) -> runtime fallback (401 latch / 429 / network error) switches to HeuristicEngine (zero-dependency scoring, maxSteps capped to 5, confidence < 0.3 or destructive keywords escalate).
3. Guardrails: 14 destructive keywords (bilingual Chinese/English); pauseBeforeKeywords word boundary matching (Latin words prevent postal_code from falsely matching post); three-stage text payload extraction (goal quotes/textHint/keyword tail); invalid_key session-level latch.
4. Parameter boundaries: maxSteps 1..60 (heuristic mode forced <= 5); timeoutMs 1..300s; confidenceThreshold default 0.55; state budget 250 lines / 120 chars / 24k chars, sensitive elements (password/file) pruned, history last 5 items.
5. Output: status (done/escalate/stuck/blocked/max_steps/timeout/paused), step trajectory, finalPage, jevUsage (calls/inputTokens/estCostUsd = input tokens * 0.042 / 1M), MCP progress notification (progressToken).

## Integration Architecture

- native-server/src/jev/ five files: types.ts (contract), jev-client.ts (TypeSafeClient wrapper + buildState/buildQuestions/validateChoice/scoreOptions), fast-decision-engine.ts (main loop 882 lines), heuristic-engine.ts (fallback 275 lines).
- LLM invocation points overview (rg evidence): Remote inference is initiated exclusively at two locations in jev-client.ts (systemOne and scoreOptions); heuristic-engine is purely local. The remaining 48 tools contain zero LLM calls—all LLM decisions are concentrated in the act_toward_goal family.

## Master Preliminary Observations (For Phase 2/3 Deep-Dive, Non-Conclusive)

a) N-step loop performs full chrome_read_dom each step (activeViewportOnly+limit250). Although snapshotCacheManager exists, engine does not utilize deltaOnly—N steps = N full DOM pruning roundtrips, which serves as the primary source of micro-loop latency.
b) invalid_key latch is a module-level global variable; once latched, any subsequent jev call in the same process remains permanently invalid until process restarts—no reset entry point (resetInvalidKeyLatch exists but lacks callers, requiring verification in Phase 2).
c) scoreOptions relies on object reference equality options.indexOf(bestOption); candidateOptions is a new array after map/slice with element references preserved, safe in the short term; originalIndex lookup logic after shortlist truncation needs verification.
d) validateChoice checks sum=1±0.02, winning must be max prob—whether this conforms with SDK actual return structures requires verification against SDK types.
e) estCostUsd hardcodes 0.042 / 1M input tokens.
