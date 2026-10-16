# Privacy Policy for BrowserPaw

**Last Updated**: October 8, 2026

BrowserPaw is an open-source browser automation bridge connecting AI agents to Chrome via the Model Context Protocol (MCP). We prioritize transparent, local-first execution while providing clear disclosures for optional cloud and remote capabilities.

---

## 1. Local-First Baseline & Network Boundaries

- **Default Local Execution**: By default, BrowserPaw components communicate locally via JSON-RPC loopback (`127.0.0.1`). CLI listeners default to localhost but support user-configured host bindings.
- **No Tracking Telemetry**: BrowserPaw includes no advertising trackers, analytics packages, or silent background telemetry.
- **External Downloads & Version Checks**: Operating in local inference mode requires downloading public model weights (e.g. from HuggingFace or configured mirrors). Automated extension version checks query public release metadata in the background. Explicit user-directed automation tools (such as `chrome_network_request` and `chrome_navigate`) connect to remote endpoints exclusively as instructed by the user or agent.
- **MCP Client Transmission**: Tool results (including inspected cookies, storage values, and DOM extracts) return directly to the connected MCP client over the active MCP transport. If your MCP caller or AI host is deployed remotely, data returned by these tools will leave your local machine over your MCP transport.

---

## 2. Jev Semantic Decision Engine: Modes & Data Disclosures

BrowserPaw provides a fast semantic micro-loop (Jev System One) for element selection and action guidance. The engine operates in three selectable modes:

| Mode         | Inference Location & Transport                                               | External Data Transmission                                              |
| :----------- | :--------------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| **`off`**    | None (pure local heuristics in the decision engine)                          | Zero inference transmission.                                            |
| **`local`**  | Offline local model (`decider-2b` served locally at `http://127.0.0.1:8009`) | Local loopback only; model weights are downloaded once upon user setup. |
| **`remote`** | Cloud inference via `@typesafe-ai/sdk`                                       | Transmits structured decision state to configured API endpoint.         |

### Remote Mode Activation & Dynamic Precedence

- **Activation Triggers**: Remote inference requires available API credentials and a remote mode selection (persisted/default or per-call); existing credentials can make it available without re-entering key. Credentials may be provided via environment variables (`TYPESAFE_API_KEY`, `JEV_API_KEY`) or stored in `~/.browserpaw/jev-remote.json`.
- **Runtime Overrides**: Tool callers can override the active engine mode on a single-call basis via the `mode` parameter in `chrome_act_toward_goal`.
- **Endpoint Destination**: Requests route to the TypeSafe AI endpoint or an optional user-defined `baseUrl`. Transport security depends on the configured target endpoint (HTTPS is strongly recommended, but custom baseUrl values are not forced to HTTPS by the client).

### Transmitted Payload & Data Exposure Limits

When Remote inference executes, the client transmits a bounded System One state:

1. **Task Goal (`task`)**: The task description or prompt. **Advisory Caution**: Users should avoid including passwords, private tokens, or personal identifiers in task goals.
2. **Page Context (`page`)**: Active tab URL (capped at 200 characters) and title (capped at 120 characters). Query parameters and sensitive tokens in plain text URL parameters remain visible.
3. **Filtered Element Labels (`elements`)**: Up to 250 visible interactive elements from the accessibility tree (120 chars/line; 24,000 chars total budget).
4. **Recent Steps (`history`)**: Up to 5 recent action outcomes.
5. **Modal Text (`pending_modal`)**: Active dialog title or prompt (capped at 120 characters).
6. **Decision Criteria**: Seven structured multiple-choice questions.

### Filtering Scope & Exclusions

- **Tag-Based Input Masking**: The filter only strips elements matching `type="password"`, `type="file"`, or file-upload roles. Plain text labels, page text, and non-password inputs are not masked and may contain sensitive data visible on the page.
- **Image Data & Screenshot Disclosure**:
  - **Default (Text-Only)**: Screenshots are transmitted only when the endpoint's release can answer Jev 1.14 `box` questions. With any other model, Remote Jev calls transmit structured text only; **no screenshots, canvas bitstreams, or page images are transmitted**.
  - **Offline Local Jev (`decider-2b`)**: Runs 100% offline via local loopback (`http://127.0.0.1:8009`). Vision is strictly prohibited in local mode; zero text or image data leaves the local machine.
  - **Capability-Routed Multimodal Vision**: There is no vision switch and no pinned vision model. Before capturing anything, BrowserPaw asks upstream which concrete release answers the configured endpoint and proceeds only if that release supports `box` (Jev 1.14+). Because the check reads the version upstream reports, an alias such as `jev-preview` is followed when upstream promotes it, and a custom or self-hosted model id that this build cannot place is never sent a screenshot. Requires Remote mode with `@typesafe-ai/sdk` `0.7.0`, Node `>=22.6.0`, and `TYPESAFE_API_KEY`. BrowserPaw then captures the active viewport screenshot in PNG or JPEG format (each dimension bounded to `280..1568px`) and transmits it to the configured endpoint for multimodal visual bounding-box localization (`Box`) and target presence, ambiguity, and risk judgments (`Noul`) (post-dispatch task verification remains DOM/text-based).
  - **Click-Only Scope & Single-Action Guard**: Vision fallback is strictly click-only (triggered only on single unambiguous click/tap goals, rejecting `type`/`fill`/`select` and multi-step tasks). Each autonomous run executes at most one visual click, re-reading the DOM on the next step to verify completion rather than blindly reporting done.
  - **Ephemeral Lifecycle & Fail-Closed Guardrails**: Screenshot frames are never persisted to disk (`saveToDisk: false`) and carry unique frame IDs with strict TTL expiration. Target-tab mismatch, navigation drift, document origin shift, viewport dimension drift, or expired frame ID causes immediate fail-closed rejection to prevent coordinate replay.
  - **Visual Data Advisory & Billing**: When vision is enabled, viewport captures include visually rendered page content (such as unmasked text, graphic images, or visual elements visible in the active viewport). Users should keep a text-only model selected when navigating sensitive private records. TypeSafe bills images as ordinary input tokens at the same per-token rate as text with no separate image charge, and `usage.input_tokens` includes them; `estCostUsd` accumulates those tokens at the documented Jev rate ($0.042/1M input tokens) and therefore covers vision requests, but it remains an estimate of input cost only (output tokens are not included).
- **Credentials**: Browser-stored passwords and autofill vaults are never accessed by Jev.

---

## 3. Chrome Permissions Justification

Permissions comply with Chrome Web Store Minimum Permissions requirements:

| Permission                  | Justification                                                                                                                                    |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| **`debugger`**              | Dispatches native trusted CDP input events (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`) across Web Components, Shadow DOM, and Canvas. |
| **`nativeMessaging`**       | Establishes the local JSON-RPC bridge with the Native Messaging Host.                                                                            |
| **`tabs` & `activeTab`**    | Discovers, switches, and manages browser tabs targeted by agent actions.                                                                         |
| **`scripting`**             | Injects in-page DOM perception and coordinate helpers into targeted pages.                                                                       |
| **`storage`**               | Caches local session state and tab affinity within Chrome storage.                                                                               |
| **`downloads`**             | Monitors file downloads initiated by agent automation.                                                                                           |
| **`webRequest`**            | Inspects network headers and API events without debugger lock conflicts.                                                                         |
| **`webNavigation`**         | Coordinates subframe hierarchies and iframe navigation events.                                                                                   |
| **`tabGroups`**             | Isolates agent-created tabs into dedicated, managed tab groups.                                                                                  |
| **`cookies`**               | Inspects session cookies only when explicitly called by tools. Data returns to the connected MCP client.                                         |
| **`bookmarks` & `history`** | Searches local bookmarks or history upon explicit user tool invocation.                                                                          |
| **`<all_urls>`**            | Enables browser automation across arbitrary sites requested by the user.                                                                         |

---

## 4. Data Retention & Source Transparency

- **Transient State**: In-memory DOM trees, coordinate caches, and SoM overlays are volatile and released on tab closure.
- **Access Control**: Local extension-to-host bridge communication requires authentication via `~/.chrome-mcp/bridge-token`.
- **Open Source Auditability**: BrowserPaw is open-source under AGPL-3.0. Inspect full source code and report security disclosures at [https://github.com/GoldenLoaf24h/browserpaw](https://github.com/GoldenLoaf24h/browserpaw).
