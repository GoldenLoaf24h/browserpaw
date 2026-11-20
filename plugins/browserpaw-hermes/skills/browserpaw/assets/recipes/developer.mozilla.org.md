# Site Recipe: MDN Web Docs

- **Target Hostname**: developer.mozilla.org
- **Author**: BrowserPaw Team
- **Last Verified**: 2026-10-22

> **Notice**: The hints below are observational guidance based on verified behaviors. Always confirm current layout and live accessibility trees in-session.

## 1. Key Layout & Tree Traversal Hints

- **Main Content Container**: The `<main id="content">` element typically applies `display: contents` in modern MDN stylesheets. Do not prune or clip the subtree based solely on bounding box or zero-dimension checks on the `<main>` root, or child content will be lost.
- **Dynamic Examples & Repeated Hrefs**: Interactive code example blocks and reference lists often include multiple links sharing identical `href` targets. Distinguish interactive anchors via live node references (`ref` / numeric DOM indexes) rather than guessing by URL alone.
- **Stale Ref Invalidation**: A new document or a replaced DOM node invalidates its previous reference. Ordinary updates retain references while the same node survives; refresh the snapshot when a reference expires.
- **Interactive Embeds (OOPIF)**: Interactive editor demos and live running snippets are embedded inside cross-origin/OOPIF `<iframe>` sandboxes (`iframe.interactive`). Interacting with buttons or inputs within the preview requires switching or targeting the specific child frame context.
- **No Hardcoded Indexes or IDs**: Never hardcode runtime element indexes, internal frame IDs, or targetIDs; inspect the live accessibility map before executing action pipelines.
