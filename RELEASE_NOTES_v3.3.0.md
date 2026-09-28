# 📦 GitHub Release Draft: BrowserPaw v3.3.0 (Work in Progress)

- **Tag:** `v3.3.0`
- **Title:** `BrowserPaw v3.3.0: Clean Third-Party Download Coexistence, Strict Tab Signature Guards & Hardened Open-Source Compliance`
- **Target:** `main`

---

## 🚀 Overview

BrowserPaw **v3.3.0** is an ongoing stability and coexistence release. It resolves critical third-party extension compatibility conflicts, hardens Chromium tab API invocations against signature mismatches, standardizes open-source legal and attribution frameworks, and enriches agent onboarding documentation.

---

## 🎨 Brand & Visual Identity Refresh

### 1. 🐾 Brand-New High-Resolution Extension & Documentation Icon

- **Vector-Faithful Multi-Resolution Rasterization**: Replaced all extension action icons across 16x16, 32x32, 48x48, 96x96, and 128x128 with the newly designed BrowserPaw visual identity using high-precision Lanczos anti-aliasing resampling.
- **Repository Branding**: Updated `docs/images/logo.png` (256x256 high-def) to align the documentation presentation with the official Chrome extension UI.

## 🪲 Bug Fixes & Architectural Hardening

### 1. 🛡️ Native Tab Signature Validation & Extension Error Elimination (`chrome_switch_tab`)

- **Root Cause Fixed**: Previously, if an agent invoked `chrome_switch_tab` without passing a valid integer `tabId` (such as `undefined`, `{}`, or numeric string formats from LLM tool outputs), the raw value was passed directly into `chrome.tabs.get(tabId)` and `chrome.tabs.update(tabId)`. This triggered a fatal Chrome C++ binding exception:
  `TypeError: Error in invocation of tabs.get(integer tabId, optional function callback): No matching signature.`
  The resulting `console.error` caused Chrome's `chrome://extensions` management console to display a red "Error" badge.
- **Remediation**:
  - Added strict integer sanitization and auto-parsing for string integers (e.g. `"512"` safely converted to `512`).
  - Added pre-activation existence probing to gracefully return a structured error message if the target tab was closed by the user.
  - Normalized error logging from `console.error` to `console.warn` so expected parameter mismatches do not pollute Chrome's extension health panel.

### 2. ⚡ Zero-Conflict Download Pipeline & IDM Coexistence

- **Root Cause Fixed**: A legacy global listener on `chrome.downloads.onDeterminingFilename` was registered during background initialization. Because Chrome enforces exclusive precedence on filename determination, having this listener active caused severe collision errors with dedicated download managers (such as Internet Download Manager - IDM), triggering:
  _"This extension cannot name the download file '' because another extension (browserpaw) has already named it ''"_.
- **Remediation**:
  - Completely eradicated `pendingScreenshotFilenames` and the invasive `chrome.downloads.onDeterminingFilename` listener.
  - Reaffirmed BrowserPaw's **Zero Disk Pollution** standard: visual media inspections and screenshots operate entirely in-memory or save to isolated temporary directories via Native Messaging.
  - Download observation tools (`waitForDownload`) now operate in a purely non-invasive, read-only mode using `onCreated` and `onChanged`, coexisting seamlessly with IDM, Aria2, and FDM.

---

## ⚖️ Legal & Governance Hardening

- **Standardized AGPL-3.0 License Recognition**: Refactored root `LICENSE` to start directly with the authoritative FSF GNU Affero GPL v3 text so that GitHub's `licensee` detector automatically badges the repository with **`AGPL-3.0 license`**.
- **Formal Upstream Attribution (`NOTICE`)**: Dedicated `NOTICE` file created containing the full upstream MIT license, copyright notices, and disclaimer for `mcp-chrome` (hangye).
- **Modern SPDX Identifiers**: Upgraded `package.json` license fields across root and all workspace packages from deprecated `"AGPL-3.0"` to standard `"AGPL-3.0-or-later"`.
- **SaaS Copyleft & Liability Clauses**: Added explicit references in `README.md` to AGPLv3 Section 13 (Remote Network Interaction source availability requirements), automated workflow compliance disclaimers, and non-affiliation trademark notices.

---

## 📚 Documentation & Onboarding Enhancements

- **The Backstory in README**: Replaced generic background prose with a compelling, structured 6-point breakdown of real-world browser automation pain points (lost logins, Windows file locks, intrusive CDP click confirmations, astronomical token consumption, debugging banners, and focus stealing).
- **Interactive Onboarding in INSTALL.md**:
  - Step-by-step guidance for ChatGPT Desktop / Codex Desktop users installing via the Marketplace "Personal" tab.
  - Automated PowerShell script to patch Chrome desktop shortcuts with `--silent-debugger-extension-api` for zero-jitter headless execution.
  - Agent-led hardware preflight recommendations for local Jev 2B acceleration (Discrete GPU CUDA/MPS vs. multi-threaded CPU fallback).

---

_(Additional features and fixes in progress...)_
