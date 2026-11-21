# Privacy Policy for BrowserPaw

**Last Updated**: November 20, 2026

BrowserPaw is an open-source browser automation bridge connecting local AI Agents to Chrome via the `browserpaw` CLI, a local Native Messaging host (`com.browserpaw.nativehost`), and a Chrome Manifest V3 extension. BrowserPaw executes locally and does not collect telemetry or operate cloud inference services.

---

## 1. Local-First Baseline & Network Boundaries

- **Loopback-Only Control Plane**: The Native host binds exclusively to loopback `127.0.0.1` (default port `12307`), validates the `Host` header, rejects browser `Origin` headers, and authenticates CLI requests using the 256-bit secret stored in `$BROWSERPAW_HOME/token` (default `~/.browserpaw/token`, or `%USERPROFILE%\.browserpaw\token` on Windows).
- **No Tracking Telemetry**: BrowserPaw includes no advertising trackers, analytics SDKs, crash-reporting uploads, or silent background telemetry. Built-in Jev/remote model inference from v4 is removed in v5.0.0.
- **Version Update Checks**:
  - **CLI Update Check**: At most once every 24 hours per BrowserPaw home, the CLI queries `https://registry.npmjs.org/browserpaw/latest` (1-second timeout, redirects disabled) to check for a newer stable release. Set `BROWSERPAW_NO_UPDATE_CHECK=1` to disable this check in offline or CI environments.
  - **Extension Update Check**: Opening the extension popup checks `https://api.github.com/repos/GoldenLoaf24h/browserpaw/releases/latest` with sliding TTL and ETag caching (`chrome.storage.local`) so the version badge can link to a newer release.
- **User- and Agent-Directed Requests**: Browser commands (`open`, `nav`, `fetch`, `downloads`, etc.) only contact destinations instructed by the user or calling Agent. Remote file downloads enforce TCP-time SSRF checks (`safeLookup`) against private, loopback, link-local, and cloud metadata IP ranges.
- **Caller & AI Host Boundary**: Command receipts, DOM extracts, screenshots, network captures, and inspected browser data are returned to the local CLI caller (`stdout` or local files under `~/.browserpaw`). If your AI Agent or host transmits its conversation context or tool outputs to an external LLM provider, that outbound transfer is governed by your Agent host's configuration and privacy policy.

---

## 2. Local Data Storage & Redaction Boundaries

BrowserPaw stores operational state locally inside `$BROWSERPAW_HOME` (default `~/.browserpaw` on macOS/Linux, `%USERPROFILE%\.browserpaw` on Windows):

- **Bridge & Runtime State**: `token` (mode `0o600`), `host.json` (loopback port and PID), `tasks.json` (task-owned tab/window ledger), `cli-update.json` (update check timestamp), `extension/` (unpacked extension copy), and `out/` (local receipt files, screenshots, traces, and exports, bounded by local retention rules).
- **Learned Workflows (`skills/`, `recipes/`, `learned-index.json`)**: Site skills and recipes learned locally stay on your disk. Skill validation rejects credential-like keys, and URL sanitization scrubs query/fragment secrets before storage.
- **Secret Redaction & Scoped Data Access**:
  - DOM indexing masks password and payment-card values.
  - Output sanitization redacts authorization headers, cookies, Bearer/JWT tokens, and common secret key-value fields in CLI receipts and logs.
  - `cookies list` returns cookie metadata only by default; reading cookie values requires explicit `--values` together with a `--url` or `--domain` scope.
  - `storage` commands bind to a verified `documentId` and verify `location.origin` inside the active page.
  - File upload/download verification blocks access to sensitive paths (such as `.ssh`, `.aws`, `.gnupg`, `.config`, `.browserpaw`, `.chrome-mcp`, `.env`).

---

## 3. Chrome Permissions Justification

Declared in [wxt.config.ts](app/chrome-extension/wxt.config.ts):

| Permission                  | Justification                                                                                                                                        |
| :-------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`debugger`**              | Dispatches native trusted CDP input events (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`) across Web Components, Shadow DOM, and Canvas.     |
| **`nativeMessaging`**       | Establishes the local Chrome Native Messaging pipe to `com.browserpaw.nativehost`.                                                                   |
| **`tabs` & `activeTab`**    | Discovers, switches, and manages browser tabs targeted by agent actions.                                                                             |
| **`scripting`**             | Injects in-page DOM perception and coordinate helpers into targeted pages.                                                                           |
| **`storage`**               | Persists local popup preferences (`agentCursorMode`, `agentWindowMode`), version cache, and MV3 session state (`agentControlEnabled`, tab affinity). |
| **`downloads`**             | Monitors file downloads initiated by agent automation.                                                                                               |
| **`webRequest`**            | Inspects network headers and API events without debugger lock conflicts.                                                                             |
| **`webNavigation`**         | Coordinates subframe hierarchies and iframe navigation events.                                                                                       |
| **`tabGroups`**             | Isolates agent-created tabs into dedicated, managed tab groups.                                                                                      |
| **`cookies`**               | Inspects or edits scoped cookies only when explicitly invoked via `browserpaw cookies`.                                                              |
| **`bookmarks` & `history`** | Searches or organizes local bookmarks and history upon explicit `browserpaw bookmark` or `browserpaw history` invocation.                            |
| **`alarms`**                | Schedules periodic MV3 service-worker keepalive checks while the Native host connection is active.                                                   |
| **`<all_urls>`**            | Enables browser automation across arbitrary websites requested by the user or Agent.                                                                 |

---

## 4. Data Retention & Source Transparency

- **Transient State**: In-memory DOM trees, coordinate caches, and agent cursor overlays are volatile and released on tab closure.
- **Retention & Uninstall**: Retained artifacts under `~/.browserpaw/out` are pruned automatically for completed tasks (never touching caller-specified `--out` paths). `browserpaw uninstall` removes the host registration and extension copy while keeping learned recipes; `browserpaw uninstall --purge` removes BrowserPaw data inside `~/.browserpaw`.
- **Security & Auditability**: BrowserPaw is open-source under AGPL-3.0. See [SECURITY.md](SECURITY.md) for enforced security boundaries and vulnerability reporting, or inspect the source at [https://github.com/GoldenLoaf24h/browserpaw](https://github.com/GoldenLoaf24h/browserpaw).
