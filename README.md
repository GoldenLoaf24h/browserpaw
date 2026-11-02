<div align="center">
  <img src="./docs/images/logo.png" width="128" alt="BrowserPaw Logo" />
  <h1>BrowserPaw</h1>
  <p><b>Reliable browser automation inside the Chrome session you already use.</b></p>
  <p>
    <a href="./docs/MAP.md">Project Map</a> ·
    <a href="./docs/TOOLS.md">Tool Reference</a> ·
    <a href="./AGENT_CONFIG_GUIDE.md">Client Config</a> ·
    <a href="./README.zh-CN.md">Chinese (zh-CN)</a> ·
    <a href="./LICENSE">AGPL-3.0 license</a> ·
    <a href="https://github.com/GoldenLoaf24h/browserpaw/releases">Releases</a>
  </p>
</div>

---

## Why BrowserPaw

BrowserPaw runs as a Chrome MV3 extension plus a local Native Messaging bridge. It
uses the browser profile you already have instead of copying profile data or
starting a separate automation browser. MCP clients can inspect pages, act with
bounded tools, and verify results without making a remote service the owner of
your browser session.

The project separates three things that are often mixed together:

- **Static operating guidance** that teaches an agent how to use BrowserPaw.
- **Durable task and page ownership**, so parallel work does not silently take
  over user pages.
- **Verified site skills**, which are learned from successful tasks and reused
  only after independent validation.

---

## ⚡ What is BrowserPaw?

BrowserPaw is a Chrome extension and local MCP server. Its canonical tool names
start with `chrome_*`, while each client may add its own namespace around them.
The default `core` tool profile keeps discovery small; use
`CHROME_MCP_TOOL_PROFILE=full` or `chrome_tool_docs` when a task needs the wider
surface.

Two execution paths are available:

1. **Deterministic tools and pipelines** for indexed actions, forms, keyboard,
   uploads, downloads, screenshots, network work, and assertions.
2. **`chrome_act_toward_goal`** for a bounded local perception-action loop when
   an on-page goal is easier to describe than to decompose into every step.

The persistent `browserpaw repl` exposes the same execution service as small
task, page, locator, skill, and help interfaces for multi-step code workflows.
It is a documented BrowserPaw subset, not a claim of full Playwright
compatibility.

---

## 🎯 Key capabilities

- **Session reuse** – Runs against the profile already open in Chrome; BrowserPaw
  does not copy your browser profile or move credentials into a second browser.
- **Pruned, indexed DOM** – `chrome_read_dom` assigns document-scoped
  references and reports action budgets, frame coverage, omitted regions, and
  truncation. A fast snapshot prioritizes the viewport and interactive targets.
- **Strict, frame-aware actions** – Explicit frame targets stay within that
  frame; ambiguous matches are rejected; nested OOPIF coordinates are projected
  through their actual renderer geometry.
- **Card flattening and viewport virtualization** – `flattenCards` collapses repetitive feed cards into one-line summaries; `virtualizeViewport` folds off-screen list items into count placeholders.
- **Shadow DOM traversal** – Recursively walks open shadow roots; closed shadow hosts are tagged and interacted with at the host level. Accessible names are extracted from icon-only buttons (aria-label, title, SVG titles).
- **Batch and form pipelines** – Run multi-step click/fill/wait/assert/extract
  sequences with one mutation budget and explicit partial or unknown outcomes.
- **Overlay dismissal** – `chrome_dismiss_overlay` closes marketing popups, cookie banners, and modals in one step, without dumping the DOM.
- **Delta observations** – Request DOM changes together with an action instead
  of paying for a separate full snapshot after every step.
- **Native event fidelity** – Clicks and keystrokes are dispatched as trusted CDP events (`isTrusted: true`), so React/Vue/Angular and Shadow DOM handlers fire normally.
- **Action outcomes** – Results distinguish pre-dispatch rejection, dispatched,
  unknown, and verified or unverified postconditions. Unknown mutations are never
  silently replayed.
- **Coordinate fallback** – When DOM indexing fails (canvas, WebGL, unknown
  custom UI), screenshots and `chrome_computer` provide a documented visual path.
- **Adaptive viewport and screenshot budget** – Owned pages follow the real
  Chrome window size and device pixel ratio instead of a forced 1440×900 frame.
  Inline screenshots default to an aspect-preserving 1568px/1.15MP JPEG budget
  for OCR and token balance; `savePng` writes a full physical-resolution PNG.
  Screenshot output is PNG/JPEG only, never WebP.
- **Human handoff** – `chrome_request_human_intervention` dims the page, shows a banner, and parks the cursor so the user can complete 2FA or captchas; automation resumes afterward.
- **Task ownership and learning** – Durable tasks track borrowed, newly opened,
  handed-off, and temporary pages. Verified site skills are stored in the Native
  library and shared by every connected client.

---

## 🧠 Interactive micro-loop

```text
┌─ Macro Planner (your reasoning LLM) ───────────────────┐
│  Task decomposition, cross-page strategy, recovery     │
└───────────────────────────┬────────────────────────────┘
                            │ MCP (low frequency)
                            ▼
┌─ Semantic Micro-Loop (Native Server) ──────────────────┐
│  chrome_act_toward_goal:                               │
│  perceive → decide (enabled model) → act → verify   │
│  No MCP round-trip per step                            │
└───────────────────────────┬────────────────────────────┘
                            │ Native Messaging
                            ▼
┌─ Chrome MV3 Extension ─────────────────────────────────┐
│  canonical tools · CDP events · in-page engine         │
└────────────────────────────────────────────────────────┘
```

Routing guideline:

- Fixed action sequence, known indices → deterministic tools (`chrome_batch_actions`, `chrome_form_pipeline`).
- Single-page goal in natural language → `chrome_act_toward_goal`.
- Long-horizon, multi-page, novel, or escalated situations → the calling agent drives.

Ordinary click, fill and named-target tools resolve targets deterministically first. Supported non-exact text, label and named-role misses may use one bounded semantic decision when a model is enabled. Exact selectors, explicit references, coordinates, frame boundaries and actionability remain strict. Input values stay separate from target descriptions.

The optional micro-loop remains bounded (default 10, maximum 60 steps). It selects complete action-target candidates, stops on uncertain delivery, and requires independent read-only verification before reporting completion. Automatic submission is limited to explicitly requested searches on identified search controls. External writes return to the calling agent.

**Model modes:**

- **Off**: No semantic inference or model preload. Deterministic tools remain available; the autonomous micro-loop is hidden from tool discovery and rejects direct execution.
- **Local**: Uses the separately installed local decider. Availability, accuracy and performance are evaluated independently from TypeSafe Jev.
- **Remote**: Uses the configured TypeSafe endpoint and model. Set `TYPESAFE_API_KEY` or configure the Native service through the popup. Candidate descriptions and relevant context go to that endpoint; do not put secrets in locator descriptions.
- **Failures**: BrowserPaw preserves your selected backend. Temporary network, timeout and rate-limit failures pause inference for 30 seconds; the next use can resume the same backend without replaying the failed operation. Authentication/configuration faults require a correction; saving a corrected configuration restores the previously selected mode. A deliberate Off selection stays off, including after restart. The popup follows Native state.
- **Existing remote vision**: Remains experimental and capability-gated before screenshot capture. The concrete release returned by the endpoint determines eligibility; an alias alone does not establish image support. Coordinate freshness and consent checks remain required.

See [semantic interaction and bounded goals](./skills/browserpaw/references/dual-brain-jev.md) for limits, verification, recovery and learned-skill boundaries.

---

## 🚀 Quick start

### 1. Build the bridge and load the extension

```bash
git clone https://github.com/GoldenLoaf24h/browserpaw.git
cd browserpaw
pnpm install
pnpm build
node app/native-server/dist/scripts/register-dev.js
```

Open `chrome://extensions`, enable Developer mode, and load
`app/chrome-extension/.output/chrome-mv3`. A prebuilt extension, release
installation, Windows details, Jev configuration, and troubleshooting are
covered in [INSTALL.md](./INSTALL.md).

### 2. Connect a client

| Client             | Supported integration                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| Generic MCP client | Stdio `mcp-chrome-stdio`, or authenticated loopback HTTP                           |
| ChatGPT/Codex      | Portable plugin in `plugins/browserpaw` through `.agents/plugins/marketplace.json` |
| Hermes Agent       | Native plugin in `plugins/browserpaw-hermes`                                       |
| Claude Code        | Plugin marketplace in `.claude-plugin/marketplace.json`                            |
| DeepSeek Harness   | Cordis bundle in `plugins/browserpaw-dsh`                                          |

Every client ultimately talks to the same local BrowserPaw Native service and
therefore shares tasks, page ownership, and verified site skills.

### 3. Install the operating skill

For an ordinary Agent Skills client, install the packaged, client-neutral skill:

```bash
browserpaw skill install
```

The default destination is `~/.agents/skills/browserpaw`. `--target` names a
different skills root, so the final directory is always
`<target>/browserpaw`. `--force` only replaces an existing BrowserPaw install
that carries its ownership marker.

### 4. Verify

```bash
browserpaw doctor
node skills/browserpaw/scripts/doctor.mjs
```

### Claude Code plugin

BrowserPaw also ships a Claude Code plugin that bundles the operating skill and
the stdio MCP server. With Chrome and the extension already running:

```text
/plugin marketplace add GoldenLoaf24h/browserpaw
/plugin install browserpaw@browserpaw
```

Choose user, project or local scope in the `/plugin` panel. The tools appear as
`mcp__plugin_browserpaw_browserpaw__chrome_*`; `/browserpaw` loads the operating
guide. The plugin runs `mcp-chrome-stdio` from `PATH`, so install the bridge
globally if the shim is missing:

```bash
npm install -g ./app/native-server
```

See [INSTALL.md](./INSTALL.md#35-claude-code-browserpaw-marketplace-plugin) for
shell installation, local checkouts and troubleshooting.

---

## 🛠️ Tool surface

The canonical `chrome_*` tools cover task/page ownership, navigation, DOM
observation, strict indexed actions, batch and form pipelines, keyboard, uploads,
downloads, dialogs, screenshots, visual fallback, network capture, storage,
history, bookmarks, performance traces, and bridge health. The live `core`
profile avoids announcing the entire surface to every session.

Use [docs/TOOLS.md](./docs/TOOLS.md) for generated schemas or call
`chrome_tool_docs` for the exact version in the running Native service. Client
prefixes differ: DSH exposes `mcp__browserpaw__chrome_*`, Claude Code exposes
`mcp__plugin_browserpaw_browserpaw__chrome_*`, and Hermes intentionally exposes a
curated `browserpaw_*` wrapper set.

---

## 🧩 Skills, references, and recipes

BrowserPaw keeps reusable knowledge in three separate layers:

| Layer                  | Location                                                            | Purpose                                                                                                 |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Canonical Agent Skill  | `skills/browserpaw/`                                                | Client-neutral operating instructions, `references/`, diagnostics, and packaged site recipes            |
| Installed static skill | `<skills-root>/browserpaw/` (default `~/.agents/skills/browserpaw`) | Read-only copy installed from the Native package                                                        |
| Learned Native skills  | `$BROWSERPAW_HOME/skills` (default `~/.browserpaw/skills`)          | Parameterized site skills learned from successful tasks and enabled only after independent verification |

The canonical skill is distributed to the ChatGPT/Codex, Claude Code, and DSH
plugins unchanged. Hermes uses its own skill template because its public tool
surface consists of `browserpaw_*` wrappers rather than the full
`chrome_*`/MCP namespace. Learned skills are never copied into client plugin
directories; every client reads them through the shared Native service.

The `references/` files contain durable operational knowledge such as tool
selection, action outcomes, visual fallback, task and skill lifecycle, and
troubleshooting. They must not contain temporary element references, tab,
document, or session IDs, coordinates, credentials, cookies, or user input.
Packaged recipes under `assets/recipes/` are copied into the Native distribution
and remain read-only site guidance.

---

## 🏗️ Architecture

```text
AI Client (any MCP-capable agent)
         │  MCP over Stdio (recommended zero-config) or HTTP/SSE on 127.0.0.1:12306
         ▼
Native Messaging Bridge (Fastify + Stdio Host)
         ├── Fast Decision Engine (Jev micro-loop)
         └── Passthrough for extension-executed canonical tools
         │  Chrome Native Messaging
         ▼
Chrome MV3 Extension (Service Worker)
         ├── In-Page Engine (1-based DOM indexing)
         ├── CDP Session Manager
         └── Agent Cursor Overlay
```

For details, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## 📚 Documentation

- [Project Map](./docs/MAP.md) – Navigation hub and reading paths.
- [Tool Reference](./docs/TOOLS.md) – Schemas for all canonical tools.
- [Install & Onboard](./INSTALL.md) – Step-by-step setup including Jev key.
- [Agent Integration](./AGENT_CONFIG_GUIDE.md) – MCP client configuration.
- [Plugin Compatibility](./docs/development/PLUGIN_COMPATIBILITY.md) – Official package formats and per-client boundaries.
- [Architecture](./docs/ARCHITECTURE.md) – Design and decisions.
- [Troubleshooting](./docs/TROUBLESHOOTING.md) – Connection and execution issues.

---

## 💡 Acknowledgments

- [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) – MV3 extension and Native Messaging bridge foundation.
- [browser-use/browser-use](https://github.com/browser-use/browser-use) – DOM-first indexing principles.
- [BrowserOS](https://github.com/browseros-ai/BrowserOS) – DOM diffing and element grep patterns.
- [TypeSafe](https://docs.typesafe.ai) – Jev System One fast-decision models.

---

## 📄 Legal & License

This project is licensed under the **[AGPL-3.0 license](./LICENSE)** (GNU Affero General Public License v3.0 or later).

### ⚖️ Open Source & SaaS Copyleft (Section 13)

Under the terms of AGPLv3, any modifications, forks, or derivative works—including those hosted remotely as a network service, cloud gateway, or SaaS platform interacting with users over a computer network—**must make their complete corresponding source code freely available under the same AGPL-3.0 license**.

### 🛡️ Disclaimer of Warranties & Limitation of Liability

This software is provided _"as is"_, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the authors or copyright holders be liable for any claim, damages, account suspensions, data loss, or other liability arising from, out of, or in connection with the software or the use or other dealings in the software.

### 🌐 Compliance with Third-Party Terms

Users are solely responsible for ensuring that their automated browser workflows comply with all applicable local laws, regulations, and the Terms of Service (ToS) or `robots.txt` policies of any third-party websites or services accessed.

### 🏷️ Trademarks & Non-Affiliation

_Google Chrome_ is a trademark of Google LLC. _Microsoft Edge_ is a trademark of Microsoft Corporation. _OpenAI_ and _ChatGPT_ are trademarks of OpenAI, Inc. _TypeSafe_ is a trademark of TypeSafe, Inc. BrowserPaw is an independent open-source project and is not sponsored, endorsed, or affiliated with any of these entities. Third-party software attributions and licenses are documented in [NOTICE](./NOTICE).

## 🛡️ Verification & Quality

Development acceptance gates, build/deployment verification, and runtime identity standards are defined in [**`docs/QUALITY.md`**](./docs/QUALITY.md).
Run `pnpm verify` to execute full static quality and build audits.

Version 4.1.2 is the latest published reliability release. It converges observation scope,
explicit interaction outcomes and form-step boundaries so that deterministic
tools, batch execution, REPL and Jev return the same facts. Its complete gate,
real-browser acceptance, production deployment, Linux/Windows CI and release
assets are recorded. The 4.1.2 release also adds explicit delayed-page
recovery, fast-observation fail-closed behavior, unified expected-page
restriction handling and error-page injection recovery. See the
[4.1.2 release record](./docs/releases/v4.1.2.md) and
[current development work](./docs/development/DEVELOPMENT.md).
The reproduced Native idle protocol failure in 4.1.0 was repaired and verified
on an unchanged connection for more than eleven minutes; that bounded evidence
is not a guarantee for every long-running workload.
The 320-run M7 comparison has stopped; its historical evidence remains available.
The planned 95% task success and 20%/30%/50% efficiency thresholds are unproven.
Report performance only from matched, versioned runs.

The Jev interaction integration is not yet runtime-qualified. Real Jev 1.14.0
evaluation safely refused two clear targets in an independent Chinese-language
holdout, below the acceptance target. Deterministic tools remain the default; do
not lower confidence thresholds or infer production accuracy from unit tests.
See the [development ledger](./docs/releases/unreleased.md).
