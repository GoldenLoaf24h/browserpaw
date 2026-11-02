# BrowserPaw Unreleased Changes Ledger 🚧

This document tracks in-progress architectural updates, fixes, and documentation improvements queued for future releases.

## 2026-11-02: BrowserPaw 4.1.2 page-restriction reliability patch

- Chromium native error pages (`chrome-error://chromewebdata/`) are now rejected as non-injectable pages before scripting. If Chrome switches to an error page before the tab URL reflects it, the injection exception is converted to one actionable tool error without writing expected failures to the extension error panel.
- Expected page restrictions now use one shared error type and logger path. Browser internal pages, error pages and cloud-metadata guards do not write `console.error` entries, while unexpected tool failures remain visible for diagnosis.
- Standard, fast, chained and action-preflight observations now share one interaction-scope calculation for modal state, Portal inclusion and scroll-container ownership. Explicit background reads remain possible, but modal and occlusion checks still block background actions.
- Modal scope discovery is now structural rather than site-specific: it follows native dialog/top-layer semantics, ARIA ownership (`aria-controls`, `aria-owns`, `popovertarget`, `commandfor`), composed Shadow DOM ancestry, and visible sibling controls in the same overlay host. Fixed framework selectors remain discovery hints only and cannot grant interaction by themselves. Scroll discovery also pierces Shadow DOM.
- Fast observation supports `isolateModal:true/false` with the same active-modal reporting as standard observation. Options that fast cannot implement, currently `flattenCards` and `virtualizeViewport`, fail closed with `unsupported_fast_options` before an in-page observation instead of returning a successful degraded or empty snapshot.
- A delayed page-creation identity can now be recovered only through explicit `resume({adopt:true})` after the same browser instance, agent ownership, tab, and a concrete document identity are observed. Known pending tabs and tab-less receipts can be explicitly retained by `finish({keepUnknownPages:true,confirm:true})`; neither path closes an unidentified page or claims cleanup.
- Field verification is independent from nearby submit controls. `chrome_fill_index` verifies the field value only; `pressEnter` records an explicit key step, while `submit:true` requires a caller-provided `submitTarget` and rejects the request before field mutation when it is missing. Enter plus an explicit submit click is rejected as a conflicting double submission.
- `chrome_form_pipeline` fills the fields exposed by the current form step and no longer guesses Next/Submit controls or falls back to Enter. It reports `completionScope:"current_step_actions"`, `businessOutcome:"not_verified"` and retains verified fields before a later error. `autoAdvance:true` returns `migration_required`; multi-step work must list explicit click, key and assertion steps in `chrome_batch_actions`.
- Public click, fill, interact, keyboard, batch and form results expose the same execution/verification outcome contract. Dispatch-unknown mutations remain `retry:false`; earlier completed fields and original receipts survive later failures.
- Pre-dispatch actionability now rejects targets fully clipped by an ancestor scroll container, instead of reporting a successful click at coordinates outside the target's visible region.
- Batches validate all submit targets and reject conflicting Enter/submit follow-ups before the first action is dispatched.
- The Jev goal loop reuses the same action-target candidates and outcome states. It may navigate, expand, toggle local views, scroll and fill within an explicit goal, but submit/send/publish/delete actions require caller-listed steps. Model confidence does not replace authorization.
- Skills, schema help, generated tool documentation and release migration notes are updated together. Old scripts that depended on implicit form advancement or Enter-based submission require migration.

The error-page and expected-page-restriction items are recorded in the 4.1.2
release. The remaining interaction-convergence items describe the
already published 4.1.1 behavior and are retained here as the source ledger.

## 2026-11-01: Adaptive viewport and resolution-aware screenshots

- Owned task pages no longer apply a fixed 1440x900 / DPR 1 emulation. BrowserPaw clears stale device metrics, measures the real window's CSS viewport and DPR, and preserves both for task reporting and coordinate mapping. Explicit `resize_page` remains available when a caller intentionally needs a fixed size.
- Model-facing screenshots now fit an aspect-ratio-preserving budget: 1568px long edge and 1.15MP by default, with `maxDimension`, `maxPixels`, `maxWidth`, `highClarity`, and `region` available for task-specific clarity/token tradeoffs. The default JPEG quality is 85.
- `savePng`/`saveToDisk` saves a full physical-pixel lossless PNG through the existing chunked Native path; preview downsampling and inline transport compression never replace the saved file. Screenshot output is restricted to PNG/JPEG, and legacy `format: "webp"` requests map to JPEG.
- Background-tab viewport captures now use a bounded 1.5s warm-up and same-session retry instead of waiting 20s for the first compositor acknowledgement. The retry does not bring the page to the foreground or capture another tab. Model previews are decoded directly into their final vision budget, and black-bar detection samples a 48x48 thumbnail rather than allocating a full-size canvas.
- Canonical skills and every client mirror now describe the actual bounded semantic form path and Jev pause/recovery contract, include screenshot budget controls and full-resolution delivery, and avoid unverified token-compression claims.
- Scale metadata now reports the real image-to-viewport/crop ratio rather than a default 1.0, and grid overlays use the same budget scale. Targeted runtime acceptance still must cover portrait, ultrawide, DPR 1.5/2, saved-file dimensions, and user-facing delivery.
- Installed Agent Skills now run runtime-only diagnostics without assuming a source checkout. Source build and standalone-directory repair remain available only when a checkout marker or explicit `BROWSERPAW_REPO_ROOT` is present.
- Skill synchronization now fails when the entire bundled Native skill directory is missing, instead of skipping that target during `--check`.
- Generated AGENTS indexes no longer hardcode drifting Core/Crawl/Full tool counts.

## 2026-11-01: Bounded semantic interaction and verified goal execution

- Confirmed micro-loop steps check the caller's independent completion assertions before another model decision. This prevents repeated filling when private field values are deliberately absent from model state. Unmet assertions permit progress; verification errors, cancellation and unknown results stop execution, and read-only timeouts retain their status.
- Skill version/hash refusals preserve their pre-dispatch marker through the public service response; attached delivery evidence remains authoritative.
- Deterministic locator success makes no inference request. Supported semantic misses use one bounded, closed-set choice; frame/document identity, candidate coverage and actionability remain code-owned. Changed targets are refused before dispatch, never retried through synthetic input.
- Native mode revisions retain the requested backend separately from effective state. Temporary network/timeout/rate-limit failures pause inference for 30 seconds, then permit the next use of the same backend without replay or background inference. Corrected configuration restores the requested mode; deliberate Off remains off across changes and restarts. The popup reads Native authority. Cancellation, no-match and low confidence do not disable a healthy backend; stale failures cannot disable replacement configurations.
- Goal steps select complete action-target candidates. Unknown delivery stops immediately and retains original receipts; completion requires independent read-only assertions. Guarded actions return a complete post-action observation for the next step instead of collecting a delta summary and immediately scanning again. Independent completion checks are not reused.
- Form matching selects among observed input identities, never a text label or the first input by order. Multi-input pages reserve the bounded inference for input selection instead of spending it on an unrelated page question. Unobserved choice answers stay local: literal choices remain supported, while an unmatched answer returns control rather than uploading potentially sensitive content. Confirmed fields and uncertain click results survive pipeline errors, without trying another button or Enter after uncertain delivery.
- Verbose doctor reads the effective Jev mode from Native and compares the extension mirror; unavailable authority is unconfirmed instead of an enabled cached mode. Optional inference diagnostics retain the actual backend, model, attempts, latency and available token usage through public locator/batch and form responses; unknown usage is not reported as zero.
- Micro-loop model state and action criteria exclude current field values, editor drafts and caller input while execution retains the exact supplied text. Populated editable controls suppress free page text that could echo their values. Missing target guards block model-selected mutations even when an older observation omits structured actions.
- Fast snapshot actions, public refs and execution guards use the same document namespace. Internal cache node numbers cannot be dispatched as public refs. The in-page engine version changes so existing documents receive the corrected mapping on their next operation.
- Real remote evaluation on Jev 1.14.0 passed the initial 24-case gate after one question clarification (11/12 clear targets, 12/12 refusals), but an independent holdout reached only 10/12 clear targets and 12/12 refusals. The missed targets were conservatively refused, not misselected. This does not qualify the backend as stable Chinese semantic automation. Keep unqualified capabilities disabled; local-model accuracy, production UI, real-site comparisons and session continuity require separate acceptance.

## 2026-10-31: Native idle diagnostic must preserve protocol framing

- The ten-minute Jev idle callback wrote a diagnostic with `console.log` into Native stdout. An isolated production-bundle probe reproduced an invalid frame length of 1986349659 from the bytes `[Jev`, between two otherwise valid messages. HTTP keepalive cannot protect a connection whose Native transport is corrupted.
- Route the idle diagnostic to stderr without changing the timer, unload policy or mutation retry behavior. Exercise the production-only timer branch in regression tests; test environments previously skipped it. Full verification, a bundle framing probe and a real long-idle session with unchanged Native process identity are required before acceptance.

## 2026-10-30: Failed benchmark startup remains visible

- Agent startup failures before the first browser call can retain zero backend calls, an explicit startup reason, unknown login and viewport, and their actual Agent cost. They cannot become successful or partially successful samples. Missing authentication remains a failed task outcome rather than making its record disappear from the denominator.
- The launch contract requires absolute trial and Agent-context paths. The G attempt stopped on an ambiguous context path before opening a browser; its original logs and cost remain separate from subsequent cohorts.

## 2026-10-30: Page-source downloads and task cleanup

- Scoped downloads use CDP tab/frame identities and GUIDs. They never infer a source from a browser-wide filename, URL or time window. Numeric Chrome download IDs and suggested filenames are not converted into verified disk paths.
- Descriptive download URLs remove userinfo and fragments and redact every query value before storage or task-ledger persistence; provider-specific signing keys must not depend on a credential-name blacklist. These URLs are diagnostic metadata, not reusable authenticated request URLs.
- `page.download` either installs observation before one guarded click or waits for an already observed GUID. Task-bound and atomic scoped calls reject incompatible extensions before dispatch and verify the returned source. Legacy unscoped filename observation remains explicitly browser-wide.
- Action receipts include download observations. Waiting cancellation removes only that waiter's listeners; it does not cancel browser downloads or another waiter. Active downloads retain their CDP owner, and lost sources or worker-restored unfinished records become unverified.
- Task cleanup reconciles source records and refuses to close an owned page with active or unknown downloads. Explicitly retained and borrowed pages can continue downloading; no completion or file deletion is claimed. This change requires its own full gate, deployment and runtime acceptance; the stopped F cohort is not a completed efficiency evaluation.

## 2026-10-30: Native text replacement and strict selector fill

- Text fill selects existing content and sends the entire replacement through one `Input.insertText` request. Multiline text never dispatches Enter unless explicitly requested; clearing uses native deletion. The native path no longer performs a synthetic reset or appends synthetic input/change events. Chrome may emit multiple trusted events for multiline insertion.
- CSS targets are passed as selectors rather than invalid refs. Unresolved or ambiguous targets stop before mutation instead of falling through to an unchecked setter. Native clearing also verifies its empty postcondition and refuses replay after unconfirmed editing.
- Regressions reproduce duplicate events, selector routing, ambiguity, multiline Enter dispatch and false clear success. Obsolete reset/event helpers and their registry entries are removed. Complete gate and runtime acceptance apply to the new build, independently of previous frozen candidates.

## 2026-10-30: Preserve opaque MCP result data

- HTTP and stdio adapters apply namespace alignment only to generated tool documentation. Page text, URLs, executable recipe fields, original failure receipts, images and structured content retain their original values for both canonical and convenience tool names.
- Regression tests first reproduced text/structured-content disagreement and changed source links in both adapters. Incoming aliases still normalize to the same backend; tool-owned help keeps its requested namespace. Source-only changes require a new full gate and runtime acceptance.

## 2026-10-30: Relevant observations, session close and stylesheet identity

- Owned REPL clients terminate only their own MCP session before closing local streams. Concurrent closes share one operation; termination failure or a one-second deadline still closes the local client. Injected clients retain their own shutdown policy. Durable tasks are not cancelled or closed.
- Observation invalidation includes stylesheet object identity and URL. Replacing an adopted sheet with equal rule text triggers a fresh collection; unchanged sibling documents remain reusable. Existing isolated engines are versioned again so surviving documents install the correction.
- Observation budgets prioritize focus, invalid controls, live notices and the focused form or result region. Equal-priority elements retain fair frame rotation, and multiple actions on one element still share one slot. Standard pagination and both fast budget stages use the same ranking.
- Fast collection traverses supported open and closed Shadow roots, including scoped text and live notices. Accessible names resolve references within their own tree in both observation and locator execution; an unrelated light-DOM ID cannot supply a component's name. Sensitive control exclusions remain in force.
- Real named-locator acceptance found an open-only hit check after successful closed-root observation and resolution. The shared fill preflight now uses the existing supported Shadow-root resolver; unrelated occluders remain rejected. The isolated engine version changes so existing documents receive the correction.
- The same acceptance traced open-only assumptions through focus verification. Observation, keyboard ref focus, fill verification, modal focus and post-action summaries now share one deep focus resolver. Native inputs remain semantic focus targets, and summaries omit password/file/hidden values. A wrong field still fails verification; modal guards preserve an existing focus inside a closed component.
- These changes still require their own complete gate and runtime acceptance. The prior runtime reproduced missing closed-shadow focus and a lingering HTTP connection; a caller-side session-termination workaround is not product acceptance. M7 efficiency targets remain unproven.

## 2026-10-30: Accurate method help and document observation reuse

- REPL `help()` returns a compact method index; `help(method)` describes actual positional JS arguments instead of the full MCP envelope. It makes no browser request, rejects wrapped skill definitions before dispatch, and returns independent schema copies.
- Standard and fast collectors reuse one result per unchanged document and matching options. Mutation records, control properties, CSSOM/media state, Shadow roots, focus, layout, viewport, fonts and index identity participate in invalidation. Active animations, opaque or oversized stylesheets, custom CSS states and oversized documents fall back to full collection.
- Cursor rendering is excluded using its actual node in the extension's isolated world, never a page-supplied attribute. Fast metric caches are cleared even on reuse, and engine replacement disconnects old observers. `read_dom` reports per-document reuse only with `includeDetails:true`; partial coverage still cannot imply deletions.
- These changes require a new complete gate and runtime acceptance. Local help token estimates are not M7 end-to-end efficiency results.

## 2026-10-30: Request cancellation through task and skill ownership

- Cancelling an MCP request stops its work without permanently cancelling the durable task. Explicit `task.cancel()` keeps its lifecycle meaning, and transport-principal ownership checks remain intact.
- Task creation forwards request cancellation, retains already confirmed pages and skips later viewport changes. Finish records each confirmed handoff before proceeding, so cancellation preserves partial cleanup and stops later releases or closes.
- Skill steps and independent verification forward the request signal to the same task executor. Cancelled and unknown reads preserve their original delivery state, receipts and non-text content; later steps are not replayed, and failed validation never enables the candidate.
- Targeted regressions cover cross-session refusal, in-flight cancellation, cleanup and independent verification. These development changes still require the full release gate and runtime acceptance; frozen M7 builds are unchanged.

## 2026-10-29: Native delivery state and unidentified page creation

- Native transport failures distinguish a request rejected before sending from a request whose response was lost. Raw MCP and task/skill wrappers retain machine-readable state; uncertain requests do not claim physical delivery or permit automatic replay.
- Task guards and cancellation retain structured refusal states. Task and skill errors preserve original receipts, diagnostic text, and image content instead of reducing them to a stack trace.
- Pending page creation remains unresolved across restart. A known late tab can be adopted only by explicit `resume({adopt:true})` after the same browser instance, agent ownership, and a concrete document identity are all observed; URL alone is never identity. Explicit `finish({keepUnknownPages:true,confirm:true})` can retain either known late tabs or receipts without a `tabId`, and returns warnings and receipts without claiming they were closed. Skill cleanup does not enable this option automatically.
- Budget and pending-creation rejections report blocked delivery without navigating. Invalid navigation responses retain an unidentified creation receipt. Finish and handoff preserve transport failures and attached content; preflight inventory failures do not imply that a cleanup action was sent.
- Hermes task and skill wrappers read the packaged schema snapshot; the existing tool-reference generator refreshes that snapshot from shared schemas. The curated tool set is unchanged.
- These corrections require a new complete verification and runtime acceptance. Prior frozen builds and M7 records do not establish delivery of this change.

## 2026-10-29: Preserve long informational text

- Compact DOM observations retain non-interactive text leaves longer than 80 characters. Long paragraphs and focal post bodies use the existing text budget instead of silently disappearing, including during card flattening.
- Regression checks preserve action controls, enforce bounded text output, and continue excluding hidden, inert, and script content. X thread verification retains its original independent content assertions.

## 2026-10-29: Navigation commits and resource loading

- Task inventory now carries Chrome's sanitized `pendingUrl`, with an explicit `null` when no navigation awaits commit. A committed document loading resources no longer makes a successful evaluation wait ten seconds and return an unknown result.
- A real pending navigation, including a same-URL reload, still waits within the existing deadline and requires explicit document adoption. Older extension inventories retain the conservative loading check; cancellation and unknown outcomes never replay the dispatched action.

## 2026-10-28: Native keyboard delivery and page viewport boundaries

- Parsed keyboard keys and sequences dispatch through native CDP before any synthetic helper. Failed or uncertain delivery is not replayed through another input path; frame targeting and action receipts remain intact.
- Page viewport resizing never falls back to resizing the shared browser window. Timeout results report `unknown/retry:false`; successful results report the integer dimensions sent to CDP.

## 2026-10-28: Dispatch, task recovery, and verified skill programs

- Successful task actions wait for a document commit only when the same browser/tab/document is still explicitly loading. The bounded wait preserves pending identity for explicit adoption; cancellation, timeout, identity loss and failed post-action verification retain the original result and receipt with `unknown/retry:false`, without replaying the action. Ordinary completed actions add no inventory polling.
- Dialog interruptions distinguish pre-dispatch `blocked` from post-dispatch or uncertain `unknown/retry:false`, retaining source identity and receipts. An uncertain mouse release is not repeated.
- Failed page registration uses browser, tab, and document identity for compensating cleanup. Missing identity leaves a pending creation receipt and prevents false cleanup success. Failed cleanup remains recoverable; persistent disk errors explicitly report unpersisted state. Task-scoped calls reject raw CDP, whose targets can bypass page boundaries.
- Automatic skills accept reviewed published programs and the data-configured `dom-extract` template. Unapproved JavaScript and options with side effects are rejected. Activation still requires fresh tasks with different inputs and independent observations.
- M7 records retain known condition mismatches; final viewport calibration cannot erase earlier changes. Product and build comparisons still require sufficient real samples. These fixes do not establish the efficiency targets.

---

## 🎯 Version Invariants & Release Rules

1. **No Untagged Release Claims**: Features in progress must remain recorded here or in draft files. No release may be documented as published without an active git tag.
2. **Current Monorepo Version**: Working version is `4.1.2` across core packages; the DSH adapter keeps its independent package version.
3. **Pending Validation**: All delivered items must pass the complete verification suite defined in [`docs/QUALITY.md`](../QUALITY.md).

---

## 📋 Queued Changes

- Task takeover waits for the current task call and its bookkeeping before acknowledging the new session. Finish rejects unresolved owned documents instead of recording a handoff the extension has not performed; pending self-navigation must be explicitly adopted before cleanup.
- DOM deltas include checkbox, ARIA and native validation state changes. Fast and standard observations distribute the element budget across frames using unique elements, retaining multiple actions for each selected element.
- Fast observations retain native validation messages, toggle states and the current selected option. Both observation modes use the same compact renderer; table row moves and sort direction changes participate in deltas.
- Screenshot coordinate actions require the exact capture identity and revalidate it before dispatch. Temporary reference markers do not exempt real page elements from DOM mutation tracking; unsupported visual changes remain explicit boundaries.
- The screenshot state probe keeps its constants inside the injected function. A serialized-function regression covers Chrome's lack of module closures, preventing ordinary live captures from silently losing their identity metadata.
- Viewport screenshot fallback preserves the page layout, including scrollbars; helper preparation remains available for full-page and element capture. This avoids invalidating viewport captures with the tool's own preparation stylesheet.
- Evaluation records distinguish summed tool work from elapsed tool intervals, so parallel calls do not invalidate a shorter measured Agent wall time or double-count the time subtracted from it.
- M7's formal 30% token gate now uses Codex-reported cumulative Agent `input_tokens` for same-condition successful pairs, including cached input. It requires actual-input coverage for every wall-time pair and never falls back to cl100k estimates; backend text estimates remain summary diagnostics. Image-bearing input is reported as Agent cumulative input, not text-only.

### Live Search Follow-up

- Editable search inputs with ARIA combobox semantics are verified by their native value, retaining separate verification for custom option widgets.
- A dispatched fill is never repeated because commitment feedback failed or was unavailable, including partial multiline input and replacement fills.
- Sticky header controls keep coordinates inside their own bounds; their containing header is not treated as an external occluder.
- X search distinguishes a visible, explicit empty result for the exact query from loading, authentication and network failures.
- Cursor notes name observed targets without displaying temporary reference numbers or filled values, using existing metadata without another model call.

### Verified Site Reads and Measurement Integrity

- X search waits for SPA content and separates loading timeouts from confirmed login pages.
- Added `x-visible-thread`: exact focal post plus loaded same-author replies with verified parent links, excluding ancestors and unrelated recommendations. Two fresh-task validations and a third-input reuse passed; this is a bounded read, not a full conversation export.
- Required recipe packaging now includes the thread reader. Canonical and installed skills describe the same boundary.
- A real file consumer retained its original bytes for over one hour; task finish released its page, lease and backing file. Native restart remains a separate check.
- Evaluation records preserve unavailable model timing as null and label unattributed wall time separately; neither missing provider usage nor elapsed time is fabricated.

### Product Naming

- Standardized product labels, CLI entry points, DOM markers and installation examples on BrowserPaw / `browserpaw`.
- Removed retired product aliases and environment-variable fallbacks; supported tool namespaces remain `browserpaw_*` and `chrome_*`.
- Added a repository naming regression check to the full verification gate.

### Review Follow-up: Frame Routing and Locator Recovery

- Keyboard selector resolution, ref lookup, focus and key delivery share the requested frame, including CSS and XPath targets.
- Failed child CDP initialization retains the confirmed session for the next discovery attempt; obsolete setup errors cannot poison a reattached tab.
- Batch actionability checks use the locator's resolved target instead of an expired input ref, preserving explicit selector and coordinate fallback.
- Text locator nesting checks walk matched ancestors and cache interaction properties, avoiding pairwise style reads on large ambiguous candidate sets.
- Batch right-click dispatch failures now mark the action failed instead of returning a synthetic-success record.
- Caller-supplied coordinates reject NaN/Infinity at the shared parser boundary; a zero width or zero height box is reported as non-visible.
- Fast snapshots cap one `<select>` at 50 option actions and report the remaining options in `omitted_actions`; standard reads default to 250 unique elements with cursor metadata.

### Durable Tasks, Skill Evolution, and Distribution

- `chrome_task` adds explicit `takeOver` for a new MCP connection, while normal task operations remain bound to their recorded session principal. Finish and task-scoped close use extension-side `tabId + documentId + browserInstanceId + agent ownership` checks and fail before closing if any identity changed.
- Task pages retain the default eight-page budget; over-budget creation is reported and never repaired by automatically closing user or borrowed pages.
- Cancellation now preserves completed or unknown in-flight results and receipts, labels a merely issued request separately from a dispatched action, and never presents an unproven action as successful or replayable.
- The persistent REPL's known-method help is served from its bundled schemas without an extra tool-docs or tools/list round trip; unknown methods still fail before dispatch.
- Cursor banners now prefer the already-observed target name (for example `Clicking button "Submit Form"`), suppress numeric-reference labels, and avoid showing fill values.
- Built-in MDN, GitHub releases, npm comparison and X search candidates are copied into Native `dist/recipes`; missing required recipe data fails the production build. The X candidate does not yet read threads and stays unavailable without successful authenticated validation.
- npm comparison now reads the registry's bounded `/latest` manifest as well as weekly downloads, reports latest version, description, license, repository and engines, and requires independent GET evidence for both packages before activation. This avoids downloading the full version history for every comparison; real activation remains pending until the next runtime reload.
- Skill proposals are bounded to read-oriented page code and GET verification, reject credential-like values and broad empty test assertions, and require two distinct fresh-task observations before activation. Page JavaScript remains trusted agent-authored code rather than an adversarial sandbox.
- The canonical skills, four generated mirrors and the installed Codex plugin skill tree are synchronized by checked, path-bounded scripts.

### Frame Routing, Action Receipts, and Ownership

- Recursive flat CDP sessions track confirmed parent/child targets. Indexed click, drag and fill project document-local points through actual frame content quads, including transforms, and reject changed document identities or viewports.
- Click, fill, batch and form execution attach observed popup/dialog/file-chooser receipts. Child dialogs route their response through the originating session. Passive receipts do not enable file chooser interception by themselves.
- Dynamic file uploads use the shared click executor and route the chooser backend node to its confirmed renderer session. Static indexed file upload targets in subframes or shadow DOM mark the element with an ephemeral random attribute, resolve node IDs across confirmed CDP sessions (`DOM.performSearch` with `includeUserAgentShadowDOM: true`), and route commands strictly by target renderer session instead of guessing by frame URL. Unknown click/upload outcomes cannot trigger synthetic replay.
- Native CDP file input dispatches omit redundant synthetic `input` and `change` events. File upload operations no longer log full arguments (preventing Base64 payload leakage) and return explicit receipts stating files are selected into the page while form submission proceeds separately.
- Earlier real tests exposed that immediate temporary-file deletion made selected files unreadable. Selected or uncertain backing files now use persistent consumer leases rather than the old one-hour TTL; only unselected pending files expire by age. Reconnection restores and checks leases before cleanup. Immediate real file reads pass; the more-than-one-hour live retention and recovery check remains separate acceptance.
- Fill submission remains in the shared fill core. An unchanged URL no longer triggers a second submit click, and form click errors abort instead of falling through to Enter.
- Explicit creation and confirmed opener lineage determine tab ownership; grouping a user tab does not authorize closing it. Session lineage persists across worker restarts, with concurrent recovery protected from stale pruning.
- Fast snapshots merge frame results under a shared context budget, expose truncation, and keep per-element text limits distinct from the body budget. Pagination and delta requests use the standard representation where needed.
- The persistent REPL exposes `mcp.notes(url)` for bounded, dated, read-only hostname recipes shipped with Native. Native edit shortcuts use CDP instead of nonexistent Cut/SelectAll content-script messages.
- Source tests, packaged delivery and browser runtime acceptance remain separate checks; background popups may still seize the foreground, and these changes do not establish an overall lead over Ego or Aside.
- Real W3Schools checks exposed two follow-ups: positioned editor shells no longer qualify as modals from size alone, and an existing-tab navigation that remains loading returns its pending destination/status instead of presenting the previous URL as the destination.

### Real Browser Acceptance Follow-Up

- Read-only DOM observations use immediate, independent document injections so a loading child cannot discard readable frames. Coverage includes failure identity and reason; child error pages do not replace the main document.
- Complete diff baselines survive partial observations while current asset routes remain available. Partial delta reads never infer removals, and asset projection failures no longer guess legacy frame offsets.
- Ordinary page JavaScript without `mcp` references skips DOM reference stamping and cleanup. Dispatched root, child and scripting evaluations report unknown/no-retry on missing receipts or transport failure instead of falling through to replay.
- REPL parsing preserves all raw MCP blocks while decoding business JSON separately from category notes. Locator fill replaces by default, accepts empty text and preserves whitespace; failed skills retain their structured business reason.
- Public source URLs with ordinary query parameters remain intact after output sanitization; sensitive parameters and bare credential/query strings keep their existing protection.
- Real task lifecycle checks cover parallel tasks, the eight-page budget, borrowing, handoff, cancellation and explicit cross-connection takeover. Controlled Chrome observations verify 150 input refs and equal five-frame budget allocation. These mechanism checks do not establish Agent timing or token targets.

### DOM Context Follow-Up from Real MDN Pages

- Standard snapshots omit the repeated `pipelineHint` tool tutorial; page observations and actionable refs remain intact, with usage guidance in the skill and tool schema. A measured W3Schools response shrinks from 847 to 555 UTF-8 bytes when that field is removed; this is a structure measurement, not model token usage.
- Explicit subframe JavaScript resolves the actual document MAIN object through confirmed CDP sessions instead of forcing MAIN-world scripting injection. Document changes, ambiguity and exhausted lookup deadlines stop before execution; dispatched commands never fall back to replay. This follow-up has its own gate and runtime checks.
- Fast DOM reads now omit duplicated structured actions and internal guard/page markers by default while retaining visible text, actionable refs, page dimensions, and scroll state. `includeDetails: true` preserves the complete fast payload; the Native decision loop explicitly requests it. Parameter docstrings retire unverified claims of 10-30ms latency, 15KB caps, or 60%/90% compression, defining the Agent contract around real character budgets and delta fallback without overpromising performance or completed business flows.
- Standard DOM reads traverse visible descendants of `display: contents` and zero-size containers instead of dropping their whole subtrees. Hidden descendants remain excluded. Standard snapshots aggregate `selectorMatched` across frames (`results.some(...)`) so that a negative main frame match (`main=false`) cannot mask a positive subframe match (`child=true`). Repeated cross-frame reads reuse successfully initialized document namespaces within the worker rather than reserving another range on every call.
- The follow-up comparison records real failures as well as passing strict-locator and stale-ref checks. The initially failing MDN OOPIF click passed on build `paw-mvj77mk7-2a14a5e1`; the subsequent recursive projection upgrade requires its own runtime acceptance.

### Jev Vision Routing & Autonomous Loop Corrections

- **Local Extension Origin Accepted**: Set `CHROME_EXTENSION_ID` before host registration to include an unpacked build in the manifest's `allowed_origins`. Once Chrome admits that caller, the native bridge derives its ID from the Native Messaging launch arguments for HTTP Origin checks, allowing remote configuration saves and Jev mode switches. Malformed caller-supplied IDs are rejected by format validation.
- **Vision Capability Routed by Upstream, Not by a Switch**: Removed the `visionEnabled` setting and the pinned `jev-1.14.0` vision model. Before any screenshot is captured the engine asks upstream which concrete release answers the configured endpoint and proceeds only when that release supports `box` questions (Jev 1.14+). Resolution is cached per credentials/endpoint/model and refreshed whenever a text query reports a new release, so promoting an alias moves the gate automatically. Responses from superseded configurations cannot populate the current capability cache. Endpoints below the threshold are declined with `vision_model_unsupported` and no image is captured or sent.
- **Bounded Vision Fallback**: Capability probes and image requests receive the remaining execution budget. Screenshot capture returns on budget expiry and ignores late results without issuing a vision request or click.
- **Retired Configuration Keys Stop Round-Tripping**: The remote config loader reads known fields only, so keys removed from the product no longer survive on disk after a save.
- **Model Sees Its Own Results**: The DOM tree handed to the model now includes the current value of filled controls, and the model state carries a bounded slice of visible page text. A fill that previously looked like a no-op no longer loops until the run reports `stuck`.
- **Explicit Fill and Submit Boundary**: A fill verifies the field value only. `pressEnter` dispatches one caller-authorized key step, and `submit:true` requires an explicit `submitTarget`; neither result claims business submission. The former model-based submit judgment and implicit Enter/Next fallback are retired.
- **Deterministic Locators & Semantic Assistance Boundary**: Deterministic locators (exact text, CSS/XPath selector, explicit reference ID, frame targeting) execute with zero model inference. Semantic matching assists only non-exact visible text, accessible labels, or named ARIA roles when deterministic lookup finds no candidate.
- **Native Authoritative Mode & Retained Preference**: Native owns the effective mode and the user's requested backend. Temporary failures retain that preference during a persisted 30-second pause; subsequent use can resume the same backend. Configuration/authentication faults wait for correction. Deliberate user Off remains off, and neither reopening the popup nor a caller's mode argument can override it. Backends do not switch automatically.
- **Semantic Guardrails & Decision Thresholds**: Semantic candidate evaluation enforces a 1500ms remaining deadline cap, a maximum of 32 candidates, minimum confidence >= 0.85, and a minimum margin >= 0.20 over the runner-up. Exceeding candidate limits or failing confidence/margin criteria returns `ambiguous` or `unavailable` without executing speculative actions.
- **Outcome Classification & No Auto-Failover**: A decision of `none` represents a normal non-match outcome rather than a transport or model failure, and does not disable the engine or trigger backend failover. The system does not automatically switch backends.
- **Development Status & Cost Disclosure**: The Jev integration has deterministic regressions and limited real remote-model evaluation, with the independent holdout shortfall recorded above. Available input/output token usage is preserved; unavailable counts and unknown endpoint prices are reported as `null`. Model tests do not establish production readiness or percentage performance improvements.
- **Skill Discovery & Execution Contract**: `chrome_skill` find uses semantic ranking strictly as a recommendation mechanism; it never automatically executes or activates skills. Skill execution (`run`) requires a verified version and immutable definition hash.
- **Session Lifecycle Serialization**: The DeepSeek Harness plugin serializes open/close transitions, so concurrent opens create a single connection and a close issued while opening still tears the connection down. Failed disposal retains the session for retry and prevents a second transport from opening.
- **Plugin Bundle Manifest Compliance**: The plugin package now declares the top-level `dsh.bundle.patch` (`./cordis.patch.yml`) that DeepSeek Harness requires before it treats a package as a profile layer. Without that field the package was reconciled as an ordinary dependency (`dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer`), its patch never applied, `apply()` never ran, and neither the `browserpaw` skill nor the `browserpaw_session` tool existed. The manifest also carries the optional `dsh.manifestVersion: 1` and the top-level `engines.dsh` range.
- **Loader-Resolved In-Box Client**: The session tool resolves `@deepseek-ai/dsh-mcp-client` through `ctx.loader.import()` at `open()` time and hands the resulting module namespace to `ctx.plugin()`. Cordis rejects a bare specifier string (`invalid plugin, expect function or object with an "apply" method, received string`), and a top-level static import cannot resolve from a linked plugin that sits outside the harness image.
- **Fail-Loud Session Open**: `open()` now passes `failOnStartupError: true` to the in-box MCP client. The default (`false`) let a failed first connection retry in the background while `apply()` resolved normally, so `browserpaw_session { action: 'open' }` returned `ok: true` with no tool registered and the next call targeted a name that never existed. A bridge that cannot answer now makes `open()` reject with `mcp-client(browserpaw): initial connection or tool synchronization failed`, while `status` keeps reporting `active: false` and a retry still opens a fresh transport.
- **Skill Mirror Tool Naming Restored**: The skill synchronizer no longer applies the Hermes-only `chrome_` to `browserpaw_` rewrite to the DeepSeek Harness skill mirror, so the mirror keeps the canonical `chrome_*` names. DeepSeek Harness registers the injected MCP tools as `mcp__browserpaw__chrome_*`; the mcp-client has no rename capability and passes each raw tool name through unchanged.
- **Dynamic Tool Lists**: BrowserPaw now advertises `tools.listChanged` and forwards the upstream notification through both the HTTP and stdio bridges. `chrome_tool_docs` can activate a category for clients that implement the standard refresh; clients without it should start with `CHROME_MCP_TOOL_PROFILE=full`.
- **Publishable Plugin Package**: The DeepSeek Harness plugin is prepared for distribution as its own npm package (`dsh-browserpaw`), independently versioned from the monorepo. The manifest pins an explicit `files` allowlist — entry module, bundle patch, skill tree and `LICENSE` — and negates the internal `AGENTS.md` notes, which are repository working instructions rather than user documentation. `repository`, `bugs`, `homepage`, `license` and author metadata were added, and the package carries a copy of the repository's AGPL-3.0 text. The in-box client peer is now marked `peerDependenciesMeta.optional`: the declared range still documents the build target, but a required peer made `npm install` resolve a second `@deepseek-ai/dsh-mcp-client` into the profile, which is the duplicate-in-box-package failure described in Discussion #8287. pnpm profiles already disable peer auto-installation, so the marker changes nothing there. Installation through a packed tarball was verified end to end against a real runtime: the copy loads as a profile bundle layer, resolves the in-box client through the loader, registers both the skill and `browserpaw_session`, and `open` injects the `mcp__browserpaw__*` tools.

### Reference Namespace, Strict Execution & Interactive REPL

- **Action Preflight**: Click, batch and fill paths check live disabled/inert/readonly state and wait for bounded geometry stability. Background timer sampling is reported separately from animation frames; observation and assertion paths remain readable for disabled controls.
- **Out-of-Process Frame Coordinates**: Resolve child targets omitted from the parent FrameTree through actual frame-owner relationships and an exact document probe, scroll the verified owner and read current geometry. Unknown ownership fails without guessed coordinates or detaching another client's session.
- **Debugger Session Adoption**: Recover extension-owned sessions using a bounded read-only command instead of treating a target's `extensionId` as the attached client's identity. Conflicting clients remain untouched and mutations are not replayed.
- **Explicit New Window Isolation**: `newWindow: true` always creates a separate background window, even when a matching page already exists, so a caller can avoid reusing the user's page.
- **Document Index Namespace (Stable Reference Isolation)**: Replaced ad-hoc frame re-indexing (`inPageReindexFrame`) with persistent document-level namespace reservation (`reserveIndexNamespaces`) backed by Chrome `documentId`. Index counters persist to storage and reserve distinct integer blocks (`2^24`) before publishing, preventing reference reuse across service worker restarts. Disconnected elements invalidate upon query rather than heuristically mapping to newer DOM nodes.
- **Strict Locator Resolution**: Enforces strict unique matching across CSS, XPath, text, and ARIA roles for single-frame and cross-frame queries. Multiple matching visible candidates immediately reject with explicit diagnostics rather than silently picking the first element or falling back to the main frame.
- **Single-Pass CDP Action Delivery**: Dispatched physical CDP mouse and keyboard events no longer fall back to synthesizing simulated DOM clicks when probe confirmation is absent, preventing unintended duplicate form submissions and button toggling. Distinctly separates `isTrusted` hardware dispatch from `deliveryVerified` probe checks.
- **Persistent Node REPL**: Introduced an interactive Node REPL (`browserpaw repl` / `mcp-chrome-bridge repl`) that preserves local variables, evaluation context, and top-level await across multiple tool calls over a persistent loopback MCP client. Supports live schema queries via `mcp.tools()`, direct execution via `mcp.call()`, and clean connection termination without leaking credentials or orphan browser tabs.
- **Single Canonical Skill Source**: Consolidated the client-neutral skill into `skills/browserpaw/`, retiring the legacy `skill/` duplicate tree. ChatGPT/Codex, Claude Code, and DSH mirrors are generated from that source; the Hermes package keeps its dedicated wrapper skill template because it exposes a different tool surface. CI checks parity, drift, orphan files, and client-specific leakage.
- **Reference Consumers and Upload Integrity**: Upload, settle, undo and media consumers validate connected nodes from the isolated reference map instead of trusting page attributes. Upload fallback requires real bytes and cannot replay after CDP has set the file. Batch occlusion checks use the resolved frame; asset screenshots reject missing frame routes. Targeted regressions pass; complete verification and runtime deployment remain separate delivery checks.

### Browser Tool Corrections

- **Output Redaction**: Preserve unpadded Base64 redaction when `/` is its only structural marker, and keep acronym tokens such as `XSRF` intact when identifying sensitive structured keys.
- **Evaluation-Local JavaScript Helpers**: CDP and scripting evaluations keep their `mcp` reference local instead of overwriting page-owned `__mcp` globals. Overlapping evaluations retain the temporary `:has-text` patch until its last holder finishes.
- **Navigation Undo**: Navigation records remain undoable after their own main-frame commit; document-epoch rejection continues to protect element-bound fill records.
- **Overlay Error Propagation**: A confirmed physical dismissal failure sets the standard MCP `isError` flag as well as the result's `success: false` field.
- **Console Buffer Stop Mode**: `chrome_console` accepts `mode: "stop"` to release a tab's persistent buffer. The stop path waits for an in-flight start, releases only the domain claims it acquired, and is idempotent.
- **Tab-Scoped Network Listeners**: `chrome_network_capture` registers one `webRequest` listener set per captured tab behind a `tabId` filter and removes exactly that set when the tab stops, closes, or restarts, so unrelated tabs' traffic is no longer delivered to the extension and multiple captures can be stopped independently.
- **Single-Pass Shape Inference**: Visual shape inference caches nodes within one snapshot instead of rescanning each candidate's subtree, preserving traversal depth, precedence, and index output.

### Claude Code Plugin Distribution

- **Plugin Package**: Added `plugins/browserpaw-claude`, a Claude Code plugin bundling the canonical operating skill (`/browserpaw:browserpaw`, also reachable as bare `/browserpaw`) and a `.mcp.json` stdio server running `mcp-chrome-stdio`. It is deliberately separate from the Hermes native package, whose declared `browserpaw_*` wrapper skill would contradict the canonical `chrome_*` names on stdio.
- **Marketplace Catalogs**: ChatGPT/Codex uses `.agents/plugins/marketplace.json`; Claude Code uses `.claude-plugin/marketplace.json`. A duplicate repository-root `marketplace.json` was removed. Claude Code `2.1.309` passes strict validation for both the catalog and plugin directory.
- **Skill Mirror**: `scripts/sync-skills.mjs` generates the Claude Code mirror from `skills/browserpaw/` verbatim, with no prefix rewriting and no Hermes scope banner. `scripts/browserpaw-claude-plugin.test.mjs` pins manifest/catalog agreement, the stdio entry, the command name, and byte parity.
- **Documentation**: Installation steps added to `AGENT_CONFIG_GUIDE.md`, `INSTALL.md`, and `README.md`; the Claude Code host contract is recorded in `docs/development/PLUGIN_COMPATIBILITY.md`.

### Native Bridge Credential Security & Stdio Transport Architecture

- **Default Stdio Transport**: Standardized all client configuration templates (Desktop, Editor, Cline, CLI, Hermes) on stdio (`node <ABSOLUTE_PATH>/mcp-server-stdio.js`) as the zero-config default without token or environment credential requirements.
- **Sole Credential Initializer**: Native messaging bridge server is the sole producer of `~/.chrome-mcp/bridge-token`. Uses exclusive file creation (`wx` mode `0o600`), preserves valid existing 48-hex and 64-hex tokens, retries transient empty files asynchronously, and fails explicitly on corruption or permission errors without in-memory ephemeral fallback. Clients and doctor scripts never write, rewrite, or auto-generate tokens.
- **Removed Environment Overrides**: Eliminated reliance on and writeback to `CHROME_MCP_TOKEN`, `BROWSERPAW_MCP_TOKEN`, and `CHROME_MCP_TOKEN_DIR`.
- **Advanced Manual HTTP Transport**: Documented HTTP/SSE endpoints as advanced manual options requiring explicit authentication tokens (`Authorization: Bearer <token>` or `x-mcp-token`), with non-configurable loopback, Host, and Origin security guards.
- **Hermes Integration Architecture**: Hermes defaults to `mcp_servers.browserpaw` in `config.yaml` using stdio (`node` + absolute script path, `enabled: true`) exposing the standard MCP tool surface. The optional native wrapper plugin requires Hermes `>=0.21.5` and explicit user authorization via `plugins.entries.browserpaw.mcp_allowlist: ["browserpaw"]` (with optional `settings.isolate_modal` toggle). Use either the raw MCP surface or the wrapper plugin as the primary tool surface to avoid duplicate registration.
- **Session & Subagent Isolation**: Each external MCP client session maintains isolated state, while subagents sharing the same profile may share transport connections with background tab isolation and explicit `tabId` targeting.
- **Read-only Credential Diagnostics & Scanner**: Doctor checks file readability and format, then authenticates with the local bridge without displaying or rewriting tokens. Its regression tests use temporary directories and mocked networking. Added automated regression scans preventing hardcoded credentials in source files.
- **Credential Rotation Recovery**: HTTP 401 invalidates the stale stdio connection. Safe reads may reconnect once; mutating calls are never automatically replayed. New connections reread the credential file. Removed hardcoded credentials from benchmark and manual test scripts; scanner fixtures use synthetic credentials.
- **Hermes Skill Scope**: Hermes skill generation uses a dedicated template that documents only its declared `browserpaw_*` wrappers. The ChatGPT/Codex, Claude Code, and DSH packages use the standard MCP skill distribution. Forwarded results preserve business errors, structured content, truncation markers, and standalone `MEDIA:` paths.

### Verification and Extension Delivery

- Added `pnpm verify` as the complete acceptance gate: script syntax and regression tests, zero-warning lint, TypeScript and Vue checks, complete Vitest and Jest file sets, simulated E2E, plugin pytest, documentation checks, production build, and extension artifact checks.
- Verification reports record all 14 required steps and a repository content fingerprint. A new run invalidates old success evidence; source changes during or after verification prevent delivery acceptance.
- Added explicit `pnpm build:deploy` and `pnpm verify:delivery` commands. Deployment requires a configured unpacked extension directory and verifies every generated artifact with SHA-256.
- Production extension builds include `browserpaw-build.json`; verbose `chrome_doctor` exposes the compiled `buildId` for comparison after manual reload.
- Excluded generated engineering Markdown from extension assets. Artifact checks reject packaged documentation, and deployment removes retired files owned by the previous build manifest before verifying the exact target file set. The former extension directory was manually removed by the user and is no longer queued for cleanup, while `test/complex-html-testing` remains retained due to automated approval policy restrictions.
- CI uses the pinned pnpm version, full Git history, and the same acceptance command on Windows and Linux. Generated verification evidence stays outside version control.
- Consolidated ESLint into the root configuration, including Chrome browser globals and Vue parsing, so workspace checks and commit hooks use the same rules.
- Runtime acceptance remains a separate step: disk deployment is not proof that Chrome has loaded the new code. The optional Hermes host integration test reports a documented skip when that host is unavailable.

### Documentation Governance & Architecture

- **Centralized Documentation Hub**: Established [`docs/README.md`](../README.md) as the single authoritative navigation hub.
- **Repository Map Clarification**: Scoped [`docs/MAP.md`](../MAP.md) strictly to codebase topology and dataflows, pointing to `docs/README.md` as the hub to eliminate duplicate indexes.
- **Single Acceptance Contract**: Authored [`docs/QUALITY.md`](../QUALITY.md) codifying verification interfaces (`pnpm verify`, `pnpm build:deploy`, `pnpm verify:delivery`), deployment checks, and the invariant that staged disk files do not constitute live Chrome execution evidence.
- **Documentation Policy**: Authored [`docs/DOCUMENTATION.md`](../DOCUMENTATION.md) setting rules for doc ownership, active vs. archived partitioning, canonical English and preserved translations, and release notes templates.
- **Release Ledger & Migration**:
  - Centralized version records for every historical git tag into [`docs/releases/`](./README.md) with `Tagged (history reconstructed from git)` status.
  - Migrated legacy root release notes to [`docs/releases/v3.2.0.md`](./v3.2.0.md), [`docs/releases/v3.2.7.md`](./v3.2.7.md), [`docs/releases/v3.3.0.md`](./v3.3.0.md) (explicitly marked as local draft), and [`docs/releases/v4.0.0.md`](./v4.0.0.md).
  - Eliminated duplicate root release files and added a concise [`CHANGELOG.md`](../../CHANGELOG.md) pointer.
- **Installation & Setup Clarity**: Updated [`INSTALL.md`](../../INSTALL.md) to replace hardcoded local deployment paths with explicit configuration instructions via `browserpaw.local.json` (`extensionSyncDir`) or `BROWSERPAW_EXTENSION_SYNC_DIR`.
- **Automated Docs Governance**: Implemented [`scripts/validate-docs.mjs`](../../scripts/validate-docs.mjs) and its test suite [`scripts/validate-docs.test.mjs`](../../scripts/validate-docs.test.mjs) verifying markdown link validity, illegal control characters, literal newline escapes, active index coverage, package version parity, and tag record completeness.

## 2026-10-31: Review follow-up fixes

- Source-scoped downloads wait for MV3 session restoration within the existing cancellation and timeout budget before checking availability or looking up a GUID. Cached terminal GUIDs do not attach a debugger.
- Task download ledgers keep newer progress and unknown states when an older action receipt arrives.
- Skill synchronization includes an existing Native distribution, and bundled recipe loading supports source execution and retries failed initialization without replaying browser actions.
- Hermes skill argument tables match the shared schemas; documentation checks cover both client-neutral and Hermes tables. Claude icon guidance and the quick-start link are current.

## 2026-10-31: Persistent REPL session keepalive

- The REPL MCP client sends a bounded keepalive ping every four minutes while the interactive session is open. This keeps a long model-thinking pause from crossing the server's ten-minute idle cleanup and losing the only owned MCP session.
- The keepalive timer is unref'd and cleared when the owned client closes; injected clients and unrelated MCP sessions are unchanged. A failed ping remains a session failure and never replays a browser mutation.
- A targeted regression covers the ping cadence and stop behavior. A complete gate and runtime acceptance are still required before this change is delivered.
