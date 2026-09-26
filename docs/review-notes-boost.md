# BrowserPaw Comprehensive Review & Hardening Audit Notes

Date: 2026-09-19
Task: /goal /boost - Comprehensive Deep Audit + High-Value Fixes + JEV Potential Utilization + Documentation Sync

## Progress Tracker

- [x] Test baseline verification (Node:test, Vitest, Jest: 380+ tests passing, Typecheck clean)
- [x] Module 1: JEV Fast Decision Engine & Heuristic Engine (app/native-server/src/jev)
- [x] Module 2: Native Server Host, MCP Registry & Transport (app/native-server/src/{mcp,server,native-messaging-host.ts})
- [x] Module 3: Extension Native Host & Background Orchestration (app/chrome-extension/entrypoints/background/{index,native-host,keepalive-manager})
- [x] Module 4: Perception & DOM Engine (dom-indexer, read-dom, vom, smart-scroll, svg, occlusion)
- [x] Module 5: Interaction & CDP Input Engine (interact-index, computer, burst, batch-actions, form-pipeline)
- [x] Module 6: Screenshot & Visual Pipeline (screenshot, agent-cursor, coordinate conversion)
- [x] Module 7: Network & Diagnostics Engine (network-capture, intercept-api, doctor, performance, storage)
- [x] Module 8: Shared Schemas, Types, Tool Profiles & Error Format (packages/shared)
- [x] Module 9: Skills, Documentation & CLI Configs

## Verified Problem Candidates (Zero False-Positive Verification)

### Candidate 1: P0 - FastDecisionEngine parseOutcome Error Masking & Payload Unwrapping

- **Location**: `app/native-server/src/jev/fast-decision-engine.ts:674`
- **Root Cause**: `parseOutcome` only checked `parsed.error`. Failures returning `{ success: false, reason: "..." }` or `{ success: false, message: "..." }` fell through to `urlChanged:false, mutated:false`. Additionally, stringified JSON errors inside `isError: true` responses were not unpacked into clean messages.
- **Consequence**: Non-error-keyed tool failures masked as successes; raw JSON error strings injected into step outcome.
- **Fix**: Check `parsed.error || parsed.reason || parsed.message || parsed.detail`; unpack JSON strings in `errText`.

### Candidate 2: P1 - HeuristicEngine evaluate Multi-Quoted Attribute Matching

- **Location**: `app/native-server/src/jev/heuristic-engine.ts:141`
- **Root Cause**: `line.match(/"([^"]+)"/)` only captured the first quoted string. In elements like `[2] textbox name="email" placeholder="Enter your email"`, the first quote was `"email"`, so goals matching `"Enter your email"` were missed.
- **Consequence**: Input fields with secondary attributes (e.g. placeholder, value) failed natural language keyword scoring.
- **Fix**: Extract all quoted strings and HTML inner text; match goal bidirectionally across all candidates.

### Candidate 3: P1 - InterceptApiTool matchesPattern Path-Only Globs

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/intercept-api.ts:68`
- **Root Cause**: Blind anchoring `^${escaped}$` required the target URL to start with the pattern. Path globs like `/api/*/items` failed to match `https://example.com/api/v1/items` because of missing protocol in the pattern.
- **Consequence**: Path-style API intercepts failed and timed out unless users explicitly wrapped both ends in asterisks (`*...*`).
- **Fix**: Check full anchor only if protocol or leading `*` exists; use regex substring search and sequential segment fallback otherwise. Expose `matchesPattern` method on `InterceptApiTool`.

### Candidate 4: P2 - TabFaviconManager Async Favicon Retention

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/tab-favicon.ts:95, 117`
- **Root Cause**: Initial tab creation often has `favIconUrl: undefined`, storing `null` into `originalFavicons`. When `chrome.tabs.onUpdated` fired with the real `favIconUrl`, `!originalFavicons.has(tabId)` was false, permanently locking in `null`.
- **Consequence**: Newly opened tabs had their original favicon destroyed and replaced with null upon restoration.
- **Fix**: If stored favicon is null, update it when `onUpdated` provides a real `favIconUrl`.

### Candidate 5: P2 - DoctorTool String Port Parsing

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/doctor.ts:31`
- **Root Cause**: Checked `typeof candidatePort === 'number'`, rejecting string ports from storage (e.g. `"12306"`).
- **Consequence**: Configuration stored as string resulted in fallback to default port.
- **Fix**: Parse candidatePort with `Number()` and check integer bounds (1-65535).

### Candidate 6: P2 - NetworkRequestTool Session Affinity

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/network-request.ts:9`
- **Root Cause**: Missing `sessionId`/`sessionContext` binding.
- **Consequence**: Dispatched requests in user's foreground tab instead of agent's background session tab.
- **Fix**: Added `sessionId`/`sessionContext` to schema and implementation, using `resolveAffinityTab`.

### Candidate 7: P2 - JEV Choice Grounding in buildQuestions

- **Location**: `app/native-server/src/jev/jev-client.ts:133`
- **Root Cause**: Bare index keys with `null` criteria provided no semantic anchor; `none` option had `null` description.
- **Consequence**: Model had to resolve indices purely through state text without semantic grounding.
- **Fix**: Populated element tag/role/summary for indices and explicit description for `none`.

### Candidate 8: P1 - FastDecisionEngine JEV Stuck Loop Recognition

- **Location**: `app/native-server/src/jev/fast-decision-engine.ts:235`
- **Root Cause**: Required both `answers.stuck.noul >= 0.85` AND `heuristicEngine.isStuck(history)`. Oscillating loops (A-B-A-B) prevented heuristic stuck check from passing, neutralizing JEV's semantic stuck detection.
- **Consequence**: Agent got trapped in cyclic loops until `maxSteps` exhausted.
- **Fix**: Trigger `stuck` if JEV confidence >= 0.85 OR heuristic engine detects 3 consecutive no-ops.

### Candidate 9: P0 - InterceptApiTool matchesPattern False Positive Glob Matches

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/intercept-api.ts:68`
- **Root Cause**: Unconditional fallback to sequential segment substring search (`clean.split('*')`) when `new RegExp(...).test(targetUrl)` returned false. Suffix-mutated endpoints (e.g. `items-not-matching` against `*/api/*/items`) erroneously matched as true.
- **Consequence**: Serious false-positive API sniffs on different endpoints.
- **Fix**: Replaced broken fallback with robust URL path-boundary regex anchoring (`(?=[/?#]|$)`), strictly matching path endpoints and queries without false positives.

### Candidate 10: P1 - TabFaviconManager Self-Poisoning from Injected Agent Favicon

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/tab-favicon.ts:94, 122`
- **Root Cause**: When the extension injects `AGENT_FAVICON_DATA_URL`, Chrome triggers `chrome.tabs.onUpdated` with the new data URL. Because `originalFavicons.get(tabId)` was initially null, the manager recorded the agent's glowing SVG data URL as the original site favicon.
- **Consequence**: Restoring the favicon at task end restored the agent indicator permanently.
- **Fix**: Explicitly filtered out `AGENT_FAVICON_DATA_URL` and `cursor-halo` SVG data URLs in both `onUpdated` and `setAgentFavicon`.

### Candidate 11: P2 - JEV Client Element Index Deduplication & Chinese Single Quotes

- **Location**: `app/native-server/src/jev/jev-client.ts:105, 222`
- **Root Cause**: `extractElementIndices` did not deduplicate index keys, causing `validateChoice` probability length mismatch on malformed DOM states. Also `extractTextPayload` omitted Chinese single quotes (`‘...’`).
- **Consequence**: Validation escalation failures on duplicate DOM elements; inability to extract text inside Chinese single quotes.
- **Fix**: Deduplicated indices in `extractElementIndices` and added `‘` / `’` to payload extraction regex.

### Candidate 12: P0 - Active Tab Protection Guard (Silent Background Operation)

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/tab-group-manager.ts:182` & `index.ts:130`
- **Root Cause**: When navigating with a tab ID that belongs to the user's active, foreground, unmanaged tab, `chrome.tabs.update` overwrote the user's active browsing session.
- **Consequence**: Automation violently disrupted user's active browsing experience.
- **Fix**: If target tab is active and not part of an agent-managed group, refuse in-place overwrite and spawn an isolated background tab (`active: false`, `focused: false`).

### Candidate 13: P0 - De-patching Known Domains to Universal W3C URL Brand Extraction

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/tab-group-manager.ts:10-40`
- **Root Cause**: Hardcoded `KNOWN_DOMAINS` dictionary (e.g. `jd.com -> 京东`). Any site not in dictionary defaulted to static `"Agent"` title.
- **Consequence**: Site-specific hack with poor generalization.
- **Fix**: Deleted `KNOWN_DOMAINS`. Implemented universal host normalization (`extractBrandFromUrl()`) with negative-lookaround hyphen preservation (`cleanPageTitle()`) and dynamic task intent naming with `chrome.storage.session` persistence.

### Candidate 14: P1 - Form Semantic Matcher Substring Bleed

- **Location**: `app/chrome-extension/utils/form-semantic-matcher.ts:88-145`
- **Root Cause**: Raw `cand.includes(query)` matching caused short queries to erroneously match longer field names (`phone` matched `no` via `phone number`, `female` matched `male`, `electricity` matched `city`).
- **Consequence**: Disastrous cross-field form misfills.
- **Fix**: Refactored into two-phase matching: Phase 1a exact matching, Phase 1b strict `\b` token-boundary matching.

### Candidate 15: P1 - Auto-Submit Enter Fallback CDP Detach Race

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/fill-core.ts:70-95`
- **Root Cause**: Dispatching physical CDP Enter key when autocomplete dropdown intercepted Enter was executed outside `cdpSessionManager.withSession()`.
- **Consequence**: Asynchronous debugger detach threw unhandled "Debugger is not attached" error.
- **Fix**: Wrapped physical Enter dispatch strictly within `withSession(tabId, ...)`.

### Candidate 16: P1 - W3C Composite Card Flattening & PUA Icon Glyph Stripping

- **Location**: `app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts:350-540` & `read-dom.ts:18-60`
- **Root Cause**: Modern SPA cards (e-commerce, feeds, search) exploded into 8-15 fragmented DOM leaf nodes per item. PUA icon glyphs (`\uE000-\uF8FF`) crashed Windows GBK terminal consoles.
- **Consequence**: Context overflow, 800+ lines of DOM noise, and Python process crashing with `UnicodeEncodeError`.
- **Fix**: Implemented W3C standard composite card flattening for `article`, `[role="article"]`, `[role="listitem"]` with form container safety guards, and stripped PUA unicode glyphs.
