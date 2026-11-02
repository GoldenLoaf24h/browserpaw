# Semantic interaction and bounded goals

BrowserPaw uses deterministic locators first. When an enabled decision model can resolve a supported semantic mismatch, the existing tool completes the operation without an extra agent call. TypeSafe Jev is the remote backend; the local decider is a separate model with separate capabilities and evaluation.

## Ordinary interaction

- Unique exact targets execute without inference.
- Non-exact text, labels and named roles may use semantic matching when deterministic lookup finds no target. For example, an email label can match an equivalent label in another language.
- Exact selectors, explicit refs, screenshot coordinates, frame restrictions and actionability checks remain strict. A stale reference is not permission to guess another target.
- The model selects from observed candidates; it cannot generate selectors, coordinates or input values. A response is applied only after target identity and action conditions are checked again.
- Public locator/batch responses retain the semantic backend, model, attempts, latency, cache status and available token usage. Form pipelines report their bounded decisions separately. Unknown usage remains unknown.
- Semantic matching uses at most 32 candidates and one bounded model request. Insufficient coverage, ambiguity or low confidence returns control to the caller. Refine the target instead of repeating an uncertain action.
- Keep target descriptions separate from text to enter. Never put passwords or tokens in locator descriptions.
- Form choice answers are matched locally against observed options. If an answer cannot be matched locally, return control instead of uploading the answer for semantic interpretation.

## Modes and failures

The Native service owns the effective `off`, `local` or `remote` mode. The extension displays that state. A call cannot override global off or switch to another backend.

Native retains the user's requested backend separately from its effective state. Temporary network, timeout and rate-limit failures pause inference for 30 seconds. The next use can resume that same backend; there is no background inference or replay of the failed action. Authentication and configuration errors wait for correction; saving a corrected configuration restores the requested mode. A deliberate Off selection stays off across configuration changes and restarts. Ordinary deterministic tools remain available throughout.

No match, low confidence, changed page identity and user cancellation are valid outcomes, not reasons to disable a healthy model. A late response from an old configuration cannot disable or restore the replacement configuration.

Remote inference sends relevant target descriptions and local page context to the configured endpoint. Keep secrets out of those descriptions. Local execution has a separate model and does not inherit remote accuracy or performance claims.

## Bounded goal execution

`chrome_act_toward_goal` remains available for a short, explicit page goal. Use it when several dependent interactions are necessary; ordinary click/fill calls do not require it.

- `goal`: the bounded objective.
- `tabId`: the intended page; task-bound calls retain task ownership checks.
- `maxSteps`: default 10, maximum 60.
- `timeoutMs`: total deadline, default 90000, maximum 300000.
- `textHint`: exact input supplied by the caller.
- `pressEnter`: authorize one Enter key step after a selected fill. It records the key dispatch, not business submission, and never authorizes an unrelated external write.
- `pauseBeforeKeywords`: additional stopping points.
- `verification`: up to eight independent read-only observations with concrete JSON Schema assertions.

A verification contains `tool` (`chrome_read_dom` or GET `chrome_network_request`), `args`, optional JSON Pointer `resultPath`, and `expect`. Keep the assertion specific enough to establish the requested outcome. Network status, a trusted click or matching goal words alone do not prove business completion.

After a confirmed step, BrowserPaw checks those assertions before asking the model for another action. Passing checks end the loop immediately. An unmet assertion permits progress; a failed read, cancellation or unknown result stops execution.

Without independent verification, a model's completion judgment remains unverified. Inspect the returned evidence before declaring the task complete.

Guarded goal actions supply the next complete page observation. The following step consumes it once; target guards still run before dispatch, and final completion uses a separate read-only check.

The text decision state excludes current field values and caller-provided input. Existing editor content is withheld from control names. When a populated editable control could echo private content into page text, the micro-loop omits that free text from model state and relies on independent completion checks. A model-selected target without an observation guard is refused, including observations from older extensions.

## Stop and recover

`unknown` means an action may already have happened: stop and inspect fresh evidence. Do not repeat the action or restart the entire goal. Cancellation stops future work and does not roll back dispatched actions.

For `blocked`, `paused`, `escalate`, `stuck`, `timeout` or `max_steps`, inspect the reason, original result and receipts. Resolve the missing evidence or permissions before continuing. Navigation still requires the task's normal document-identity and resume procedure.

Semantic assistance does not authorize payments, publishing, deletion or other external writes. Return those decisions to the calling agent under the current task's authorization.

## Skills and measured costs

Skill discovery first filters active skills by domain and deterministic intent evidence. When enabled, semantic ranking may help distinguish remaining candidates; a recommendation does not run or activate a skill. Explicit skill IDs continue through the existing verified skill service.

Learned skills remain in `$BROWSERPAW_HOME/skills` (default `~/.browserpaw/skills`). Independent validation and version checks remain required. Do not save temporary refs, tab/document IDs, coordinates or credentials in reusable skills.

Read actual backend/model, request latency and token usage from diagnostics. Candidate limits and confidence thresholds are execution policy, not a guarantee of correctness. Evaluate relevant cases before making accuracy or speed claims.

The current remote evaluation is not sufficient to qualify stable Chinese semantic automation: an independent Jev 1.14.0 holdout safely refused two clear targets below the execution threshold. Do not lower thresholds or treat these refusals as completed work. Local-model capabilities require their own evaluation.
