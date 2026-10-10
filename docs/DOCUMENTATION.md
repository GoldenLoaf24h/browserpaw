# BrowserPaw Documentation Governance & Architecture 📚

This document defines the governance rules, directory ownership, lifecycle boundaries, language policies, and versioning standards for all BrowserPaw documentation.

---

## 🏛️ 1. Documentation System Architecture

BrowserPaw maintains a centralized, single-source documentation model centered around the Documentation Hub at [`docs/README.md`](./README.md).

```text
mcp-chrome-master/
├── README.md                      # Primary repository entry point (English canonical)
├── README.zh-CN.md                # Chinese translation mirror
├── INSTALL.md                     # Direct installation & setup guide
├── PROJECT.md                     # Engineering overview & package index
├── PROJECT.zh-CN.md               # Chinese translation mirror
├── TEST_INFRA.md                  # Test infrastructure specification
├── CHANGELOG.md                   # Concise pointer to version release notes
├── docs/
│   ├── README.md                  # 🌟 Single documentation hub and global navigation index
│   ├── QUALITY.md                 # Single engineering verification and quality gate contract
│   ├── DOCUMENTATION.md           # This document: governance, ownership, lifecycle & standards
│   ├── ARCHITECTURE.md            # Technical architecture and CDP engine specification
│   ├── MAP.md                     # Repository symbol mapping, dataflows & code topology
│   ├── TOOLS.md                   # Auto-generated 50 canonical tool schemas and profiles
│   ├── TROUBLESHOOTING.md         # Operational diagnostic guide
│   ├── TROUBLESHOOTING.zh-CN.md   # Chinese translation mirror
│   ├── CONTRIBUTING.md            # Contributor workflows and pull request protocols
│   ├── mcp-cli-config.md          # Multi-client configuration snippets
│   ├── releases/                  # Per-version release records & unreleased ledger
│   │   ├── README.md              # Version ledger index (known releases & unreleased)
│   │   ├── unreleased.md          # In-flight changes and upcoming milestone tracker
│   │   └── v*.md                  # Individual release records mapped to git tags
│   └── archive/                   # Isolated historical archives (handoffs, audits, tests)
```

---

## 📂 2. Active vs. Archived Boundaries

To prevent cognitive drift and ensure agents always read current contracts, documentation is strictly partitioned:

1. **Active Documentation** (`docs/*.md`, root `*.md`):
   - Represents the current, authoritative state of code, tools, APIs, and workflows.
   - Must have 100% valid relative markdown links.
   - Automatically verified by `node scripts/validate-docs.mjs`.
   - Never references ephemeral execution logs or temporary report dumps (`.artifacts/...`).

2. **Archived Documentation** (`docs/archive/**`, `research/**`):
   - Preserves historical records, refactoring phase handoffs, point-in-time security audits, and deprecated exploratory benchmarks.
   - Isolated from active navigation paths to avoid conflicting guidance.
   - Archive index links must remain valid, but internal historical drafts are not subject to forward-evolution changes.

---

## 🌐 3. Language & Translation Policy

1. **Canonical Language**: English (`*.md`) is the primary canonical source of truth for all technical documentation, schemas, and API contracts.
2. **Translation Mirroring**: Chinese translations (`*.zh-CN.md`) are maintained as synchronized mirrors for key entry points (`README`, `PROJECT`, `TROUBLESHOOTING`, `AGENT_CONFIG_GUIDE`).
3. **No Forcible Deletion**: Existing Chinese documentation must be preserved and updated alongside English canonical changes. Translators should match technical accuracy rather than invent diverged guidance.

---

## 🏷️ 4. Release Notes & Version Record Protocol

1. **Per-Version File Invariant**: Every released local git tag must have a corresponding record in `docs/releases/<version>.md` (e.g. `docs/releases/v3.2.7.md`).
2. **Drafts & Unreleased Changes**:
   - Working in-progress versions without git tags (such as v4.0.0) must be recorded as unreleased or working versions, and must never claim to be released tags.
   - Local drafts (such as v3.3.0) must explicitly state their status as local unreleased drafts.
   - Future incremental features are logged in [`docs/releases/unreleased.md`](./releases/unreleased.md).
3. **Root CHANGELOG**: Root [`CHANGELOG.md`](../CHANGELOG.md) remains a concise reference directing readers to `docs/releases/README.md`, rather than duplicating release notes across multiple locations.
4. **No Untagged Releases**: Releases must never be claimed or documented as published without an existing git tag or explicit release action.

---

## 📝 5. Release Note Template

When preparing a new release record under `docs/releases/`, follow this structure:

```markdown
# BrowserPaw Release vX.Y.Z 🚀

- **Release Date**: YYYY-MM-DD
- **Git Commit**: <short-hash>
- **Git Tag**: `vX.Y.Z`
- **Status**: Released | Working Draft

## Summary

Brief high-level overview of the release milestone and its primary focus.

## Key Highlights & Features

- Detailed description of major features added.

## Bug Fixes & Hardening

- Bulleted list of resolved issues and architectural hardening.

## Verification & Compatibility

- Supported environments, verified MCP client matrix, and test outcomes.
```
