# Privacy Policy for BrowserPaw

**Last Updated**: September 12, 2026

BrowserPaw ("we", "our", or "the extension") is an open-source browser automation bridge designed for AI agents via the Model Context Protocol (MCP). We are committed to protecting user privacy and ensuring full transparency regarding data handling.

---

## 1. Zero Data Collection & Local-Only Architecture

- **No Remote Transmission**: BrowserPaw does **not** collect, track, store, or transmit your personal data, browsing history, form inputs, or credentials to any remote server or third-party cloud.
- **Local Loopback Communication**: All communication occurs strictly within your local machine between the Chrome Extension and the local Native Messaging host on `127.0.0.1` (localhost).
- **No Analytics / Telemetry**: The extension contains no tracking scripts, advertising libraries, or telemetry SDKs.

---

## 2. Permissions Justification (Chrome Web Store Compliance)

In accordance with the Chrome Web Store Minimum Permissions policy, each requested permission is strictly required for local developer automation:

| Permission                  | Purpose & Justification                                                                                                                                                                                                           |
| :-------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`debugger`**              | Required to dispatch native CDP input events (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`) to accurately interact with modern Web Components, Shadow DOM, and Canvas elements, and to measure page performance metrics. |
| **`nativeMessaging`**       | Required to establish a secure local JSON-RPC bridge with the local Node.js Native Host on the user's machine.                                                                                                                    |
| **`tabs` & `activeTab`**    | Required to discover, navigate, switch, or close tabs exclusively upon explicit AI Agent commands initiated by the user.                                                                                                          |
| **`scripting`**             | Required to inject local semantic DOM indexer scripts into the active tab to extract accessible element trees for AI agents.                                                                                                      |
| **`storage`**               | Used exclusively to cache local session state (such as tab group affinity) inside Chrome's local storage.                                                                                                                         |
| **`downloads`**             | Used exclusively to monitor or manage active file downloads initiated by the AI Agent.                                                                                                                                            |
| **`webRequest`**            | Used for lightweight network traffic monitoring and request inspection without debugger conflict.                                                                                                                                 |
| **`webNavigation`**         | Required to accurately resolve nested iframe structures and subframe URLs for multi-frame DOM coordination.                                                                                                                       |
| **`tabGroups`**             | Used to organize AI Agent-spawned tabs into dedicated colored tab groups and cleanly destroy them without orphan residue.                                                                                                         |
| **`cookies`**               | Accessed only when the user's AI Agent explicitly requests inspecting session state for authenticated workflows. Data never leaves localhost.                                                                                     |
| **`bookmarks` & `history`** | Accessed only upon explicit user instruction to search local bookmarks or browsing history.                                                                                                                                       |
| **`<all_urls>`**            | Required to allow the user's AI Agent to automate web tasks across arbitrary user-specified websites.                                                                                                                             |

---

## 3. Data Retention and Security

- **Session Isolation**: All DOM index snapshots and temporary interaction caches are volatile and destroyed when tabs are closed.
- **Token Protection**: Communication between the extension and the local bridge requires token authentication matching `~/.chrome-mcp/bridge-token`.

---

## 4. Open Source Transparency

BrowserPaw is open-source software distributed under the GNU Affero General Public License v3.0 (AGPL-3.0). The complete source code is publicly auditable at:  
[https://github.com/GoldenLoaf24h/browserpaw](https://github.com/GoldenLoaf24h/browserpaw)

---

## 5. Contact & Inquiries

For questions, security disclosures, or concerns regarding this policy, please open an issue on GitHub:  
[https://github.com/GoldenLoaf24h/browserpaw/issues](https://github.com/GoldenLoaf24h/browserpaw/issues)
