# BrowserPaw Comprehensive Testing & Verification Notes

> **Chinese Version**: [TESTING-NOTES.zh-CN.md](./TESTING-NOTES.zh-CN.md)  
> **Target Release**: BrowserPaw v3.1.0 Production Release  
> **Summary**: Test logs, benchmarking records, and validation checklists across all testing tiers.

> **Archival Notice**: Test execution descriptions between the English and Chinese testing notes in this directory contain historical discrepancies (e.g., Task T3 container execution descriptions). These historical records are retained as-is for archival tracking and must not be treated as verified current system behavior.

---

## 1. Automated Test Suite Metrics & Matrix

| Test Suite | Framework / Tool | Test Files | Total Tests | Pass Rate | Execution Target |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Extension Unit & Integration** | Vitest | 57 suites | 547 tests | **100% PASS** | `pnpm --filter chrome-mcp-server test` |
| **Native Bridge & Jev Engine** | Jest | 7 suites | 124 tests | **100% PASS** | `pnpm --filter mcp-chrome-bridge test` |
| **End-to-End Modernization Suite** | Node Test Runner | 4 tiers | 153 tests | **100% PASS** | `pnpm test` |
| **Python Bridge Token Plugin** | Pytest | 1 suite | 8 tests | **100% PASS** | `plugins/browserpaw/tests/test_bridge_token.py` |
| **TypeScript Monorepo Checking** | TSC | Monorepo | All packages | **0 Errors** | `pnpm typecheck` |
| **Linter Compliance** | ESLint 9 | Monorepo | All packages | **0 Errors** | `pnpm lint` |
| **Total Automated Coverage** | — | — | **832 tests** | **100% GREEN** | Clean continuous verification |

---

## 2. Jev Autonomous Semantic Micro-Loop Verification (`chrome_act_toward_goal`)

### 2.1 Engineering Constraints & Safeguards

- **Native Server Isolation**: Micro-loop runs entirely within the Native Server process (`app/native-server`), chaining perception (`read_dom`), decision (`JevClient` or `HeuristicEngine`), and action dispatch (`callToolInternal`), reducing per-step latency to 200–400ms without MCP round-trip token overhead.
- **3-Tier Execution Ladder**:
  1. *Tier 1 (Off)*: Jev engine is disabled in extension popup; tool is hidden from `tools/list` and intercepted on call with explicit user authorization prompt.
  2. *Tier 2 (Local)*: Privacy-first local decider service on port 8009 with `Mapika/decider-2b` weights, automatic process management, and GPU acceleration.
  3. *Tier 3 (Remote)*: Cloud inference via TypeSafe System One (`TYPESAFE_API_KEY` / `JEV_API_KEY`) with 401 latching, quota management, and heuristic fallback.
- **Circuit Breakers & Escalation**:
  - Automatically escalates to System 2 when confidence falls below threshold (<0.55), when destructive keywords are detected (`pay`, `delete`, `submit`), or when execution stalls for 3 consecutive steps.

### 2.2 Live Benchmark Performance

| Task | Scenario Description | Wall-clock (ms) | Steps | Engine Type | Status & Resolution |
|---|---|---|---|---|---|
| **T1** | Search Navigation: Google search "TypeScript" and open result | 2,062ms | 2 | `jev` | Escalated cleanly to caller LLM after search results loaded |
| **T2** | Form Submission: Fill username "alice" and submit login | 586ms | 2 | `jev` | Completed login form and escalated on personal dashboard |
| **T3** | Dropdown Selection: Select region option "California" | 249ms | 1 | `jev` | Executed single-turn dropdown interaction |
| **T4** | Modal Dismissal: Accept cookie banner and proceed | 518ms | 2 | `jev` | Handled consent modal in 1 step, resumed browsing |
| **T5** | Multi-step Workflow: Search "laptop" and view item | 574ms | 2 | `jev` | Inputted query, selected item, returned candidate DOM |

---

## 3. Core Browser Tools Hardening Records

### 3.1 DOM Perception & Pruning (`chrome_read_dom`)

- **Card Flattening (`flattenCards: true`)**: Collapses complex repetitive feed items into concise single-line entries, preventing prompt token bloat on dense social feeds and e-commerce listings.
- **Fast Snapshot (`fast: true`)**: Traverses visible viewport in a single pass using `TreeWalker` and native `checkVisibility()`, returning structured candidates in $\le 30$ms and $\le 15$KB.
- **Unicode Icon Stripping**: Filters Private Use Area (PUA) glyphs (`[\uE000-\uF8FF]`) to avoid terminal character encoding corruption.

### 3.2 Controlled Input Handling (`chrome_fill_index`)

- **Native Setter Invocation**: Automatically dispatches value mutations via prototype property descriptors for React 16–19 and Vue 3 controlled inputs.
- **Auto-Submit & Key Fallback**: Supports `submit: true` and `pressEnter: true` in single turn, eliminating unnecessary subsequent round-trips.

### 3.3 Visual & Coordinate Precision (`chrome_screenshot`, `chrome_computer`)

- **DPR 1:1 Normalization**: Captures screenshots with exact CSS viewport dimensions using offscreen canvas resampling, eliminating visual offsets on Windows high-DPI scaling (125%, 150%, 200%).
- **Diskless In-Memory Storage**: Screenshots remain in memory by default, avoiding unneeded disk writes.

---

## 4. Verification Commands

```powershell
# Rebuild all packages
pnpm build

# Run monorepo typecheck
pnpm typecheck

# Run extension unit tests
pnpm --filter chrome-mcp-server test

# Run native server tests
pnpm --filter mcp-chrome-bridge test

# Run end-to-end tests
pnpm test
```
