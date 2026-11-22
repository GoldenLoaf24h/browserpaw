# Security Policy

BrowserPaw is a local-first browser automation bridge consisting of a CLI (`browserpaw`), a local Native Messaging host (`com.browserpaw.nativehost`), a Chrome Manifest V3 extension, and client-specific skill/plugin packages. This policy defines supported versions, vulnerability reporting, and the security boundaries enforced across the codebase (including for pull request security review).

## Supported Versions

Security fixes are maintained on the current v5 release line. Earlier MCP-based releases are retired and do not receive security backports; see the [v4 to v5 migration guide](docs/MIGRATION.md).

| Version           | Status                                 |
| :---------------- | :------------------------------------- |
| `5.0.x`           | Supported                              |
| `4.x` and earlier | Unsupported (retired MCP architecture) |

## Reporting a Vulnerability

Do not report security vulnerabilities, exploit proofs of concept, or leaked credentials in public GitHub issues or pull requests.

- **Preferred channel**: Open a private report through [GitHub Security Advisories](https://github.com/GoldenLoaf24h/browserpaw/security/advisories/new).
- **Include**: Affected version and component (CLI, Native host, Chrome extension, or plugin), OS and Chrome/Chromium version, minimal reproduction steps, the security boundary bypassed, and any suggested fix.
- **Redact secrets**: Never include real session cookies, OAuth tokens, passwords, or your local `$BROWSERPAW_HOME/token` value in reports.

BrowserPaw is maintained on a best-effort basis. Maintainers aim to acknowledge private reports promptly, validate impact against the trust boundaries below, prepare fixes on the supported `5.x` line, and coordinate advisory disclosure once a fixed release is ready.

## Architecture and Trust Model

BrowserPaw executes locally under the current OS user account:

1. **CLI (`app/native-server/`)**: Invoked by the local user or an agent running on the user's machine. Reads `$BROWSERPAW_HOME/host.json` and `$BROWSERPAW_HOME/token` (default `~/.browserpaw/`).
2. **Native Messaging Host & Loopback HTTP Server (`app/native-server/src/server/index.ts`)**: Spawned by Chrome via Native Messaging stdio, binds strictly to `127.0.0.1` (default port `12307`), and authenticates local HTTP requests before forwarding commands to the extension.
3. **Chrome MV3 Extension (`app/chrome-extension/`)**: Executes browser commands inside the user's active Chrome profile and communicates with the Native host over Chrome Native Messaging.

- **Trusted principals**: The local OS user and local processes authorized to read `$BROWSERPAW_HOME/token`.
- **Untrusted inputs**: Web pages, iframes, remote HTTP responses, redirect targets, DNS answers, untrusted DOM/ARIA text (including prompt-injection payloads), browser-originated requests to localhost, other extensions, and caller-supplied file paths or download URLs.
- **Outbound network boundaries**: BrowserPaw includes no analytics or tracking telemetry. Outside explicit user/agent browser commands (`open`, `fetch`, `download`, `upload`), automatic outbound requests are limited to:
  1. **On-demand CLI update check and verified auto-update** in [cli-update.ts](app/native-server/src/cli-update.ts): at most once every 24 hours (with a 10-minute retry backoff on transient failure; disabled by `BROWSERPAW_NO_UPDATE_CHECK=1`), the CLI fetches `https://registry.npmjs.org/browserpaw/latest` with `redirect: 'error'` and a 2.5-second timeout and verifies the package name and canonical GitHub repository URL. Unless `BROWSERPAW_NO_AUTO_UPDATE=1` is set, it then downloads the release `.tgz` tarball (15-second timeout, capped at 50 MiB compressed, 100 MiB extracted, and 4,000 tar entries), verifies the npm SHA-512 integrity digest, and enforces strict tar path-traversal and symlink rejection before staging into `~/.browserpaw/cli-versions/<version>`.
  2. **Extension popup release check**: opening the Chrome extension popup checks `https://api.github.com/repos/GoldenLoaf24h/browserpaw/releases?per_page=20` (cached via sliding TTL and ETag in `chrome.storage.local`) to display an update badge only when a newer published release attaches `browserpaw-extension.zip`.

## Enforced Security Controls

Pull requests touching these surfaces must preserve the following invariants:

### 1. Loopback Bridge Authentication and Local Files

- **Loopback-only binding**: [server/index.ts](app/native-server/src/server/index.ts) binds exclusively to `127.0.0.1` (never `0.0.0.0` or wildcard hosts).
- **Anti-CSRF and DNS-rebinding rejection**: Every HTTP request must match `Host: 127.0.0.1:<port>` and must not include an `Origin` header (`403` otherwise).
- **Constant-time token auth**: All routes except `GET /ping` require `x-browserpaw-token`, verified via `crypto.timingSafeEqual` in [server/token.ts](app/native-server/src/server/token.ts) against the 256-bit hex secret in `$BROWSERPAW_HOME/token`.
- **Request bounds and locking**: Request bodies are capped at 8 MiB; per-context concurrency locks reject overlapping commands on the same page, task, or profile command group.
- **Restrictive permissions and symlink checks**: Token, discovery, lock, ledger, and state files are written atomically (`flag: 'wx'`, mode `0o600`) inside `0o700` directories. [cli-files.cjs](app/native-server/src/cli-files.cjs) enforces `assertNoLinks` to reject symlinks and Windows junctions.

### 2. Native Messaging and Extension Isolation

- **Pinned extension origin**: [cli-setup.ts](app/native-server/src/cli-setup.ts) writes Native Messaging manifests with `allowed_origins` restricted to `chrome-extension://<extensionId>/`, derived from the extension's manifest public key.
- **Framed Native stdout**: The Native Messaging host reserves `stdout` strictly for length-prefixed JSON protocol frames ([stdout-guard.ts](app/native-server/src/stdout-guard.ts)); diagnostics and CLI update notices belong on `stderr` or log files.
- **Extension sender validation**: Background message listeners in [native-host.ts](app/chrome-extension/entrypoints/background/native-host.ts) require `_sender.id === chrome.runtime.id && !_sender.tab` so web pages and external extensions cannot call privileged background handlers.
- **Strict extension CSP**: [wxt.config.ts](app/chrome-extension/wxt.config.ts) enforces `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; style-src 'self'; img-src 'self' data: blob:;` without `'unsafe-inline'`.

### 3. Restricted Pages, Origin Binding, and CDP Guardrails

- **Restricted schemes and metadata blocking**: [restricted-url.ts](app/chrome-extension/utils/restricted-url.ts) blocks browser internal pages (`chrome://`, `edge://`, `devtools://`, `chrome-extension://`, `view-source:`), Chrome/Edge Web Store origins, Chromium error pages, and cloud instance metadata endpoints (`169.254.169.254`, `169.254.169.253`, `100.100.100.200`, `169.254.0.2`, `metadata.google.internal`, `metadata.internal`, `instance-data`, `fd00:ec2::254`). [network-request.ts](app/chrome-extension/entrypoints/background/tools/browser/network-request.ts) also blocks `file:` URLs.
- **Screenshot origin and capture binding**: Coordinate actions derived from screenshots enforce `screenshotOriginViolation` ([screenshot-guard.ts](app/chrome-extension/utils/screenshot-guard.ts)) and explicit `captureId` checks ([screenshot-validity.ts](app/chrome-extension/utils/screenshot-validity.ts)) to fail closed if navigation or domain drift occurs after capture.
- **Document-bound storage access**: `chrome_storage` in [browser-data.ts](app/chrome-extension/entrypoints/background/tools/browser/browser-data.ts) targets a verified `documentId` and re-checks `location.origin` inside the page before reading or modifying storage.
- **Dangerous CDP method denylist**: [cdp-execute.ts](app/chrome-extension/entrypoints/background/tools/browser/cdp-execute.ts) blocks `Browser.close`, `Browser.crash`, and `Browser.crashGpuProcess` and auto-detaches the debugger on timeout.

### 4. File Transfers, SSRF Defense, and Safe Cleanup

- **TCP-time SSRF protection**: Remote file downloads in [file-handler.ts](app/native-server/src/file-handler.ts) validate URLs and enforce `safeLookup` inside custom HTTP/HTTPS agents at TCP connect time (mitigating DNS-rebinding TOCTOU) against private, loopback, link-local, CGNAT, multicast/reserved, cloud metadata, and IPv4-mapped/6to4 IPv6 ranges plus `.localhost`, `.local`, `.internal`, and `.localdomain`. Redirects are handled manually, re-validated per hop, and capped at 5 hops.
- **Sensitive path denial**: Local file verification (`assertNotSensitivePath` in [file-handler.ts](app/native-server/src/file-handler.ts)) blocks resolved and `realpathSync`-canonicalized paths under `.ssh`, `.aws`, `.gnupg`, `.config`, `.chrome-mcp`, `.browserpaw`, and `.env`.
- **Temp directory confinement and size caps**: `readBase64File` and `cleanupFile` only operate strictly inside the isolated temp upload directory. Downloads and base64 uploads are capped at 50 MiB, and base64 Native Messaging pipe reads are capped at 700 KiB.
- **Safe receipt pruning**: [output-retention.ts](app/native-server/src/output-retention.ts) checks `assertNoLinks`, excludes active/paused tasks and directories containing unrecognized files, and never deletes caller-specified `--out` paths.

### 5. Credential Redaction, Scoped Access, and Side-Effect Safety

- **URL and output redaction**: [url-sanitizer.ts](app/chrome-extension/utils/url-sanitizer.ts) scrubs secret query/fragment parameters; [output-sanitizer.ts](app/chrome-extension/utils/output-sanitizer.ts) redacts authorization headers, cookies, Bearer/JWT tokens, sensitive key-value pairs, and opaque base64 blobs; DOM indexing masks password and credit-card field values.
- **Scoped cookie values**: `cookies list` returns cookie metadata only by default; [commands-data.ts](app/native-server/src/commands-data.ts) requires an explicit `--url` or `--domain` scope for `--values`.
- **Saved workflow hygiene**: [browser-skills.ts](app/native-server/src/browser-skills.ts) rejects credential-like keys in stored skill definitions and validates read-only extraction programs.
- **Explicit opt-in for destructive actions**: Time-range `history rm` requires `--since`, `--until`, and `--yes`; non-empty `bookmark rm` requires `--recursive`; `uninstall` preserves user data unless `--purge` is passed.
- **No replay and strict page ownership**: Uncertain dispatches are reported with receipts rather than silently replayed. Task cleanup closes only verified task-owned pages and preserves borrowed and pre-existing user tabs ([browser-tasks.ts](app/native-server/src/browser-tasks.ts)).

## Intentional Capabilities and Out of Scope

The following behaviors are by design and are not security vulnerabilities on their own (though regressions to their guardrails are in scope):

- **Privileged local CLI commands**: `eval`, `cdp`, `fetch`, `cookies`, `storage`, `history`, `bookmark`, `downloads`, and `upload` intentionally grant broad browser control to an authenticated local CLI caller holding `$BROWSERPAW_HOME/token`.
- **Same-OS-user local compromise**: Another process running under the same OS user account already has direct access to Chrome's profile and `$BROWSERPAW_HOME/token`; isolating mutually untrusted processes within the same OS account is outside BrowserPaw's threat model.
- **Public extension key in `wxt.config.ts`**: The RSA key in [wxt.config.ts](app/chrome-extension/wxt.config.ts) is Chrome's public manifest `key` used to keep the unpacked extension ID deterministic for Native Messaging `allowed_origins`; it is not a private key or secret.
- **Agent-level prompt injection defense**: BrowserPaw masks known credential patterns where practical, but web content returned from pages remains untrusted data that calling agents must handle safely.

## Related Documents

- [Privacy Policy](PRIVACY.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Quality Gates](docs/QUALITY.md)
- [Repository Agent & Review Guide](AGENTS.md)
