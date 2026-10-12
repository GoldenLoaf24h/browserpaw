# BrowserPaw Web Automation Recipes (Playbooks)

This directory is designed for **caching, persisting, and reusing proven interaction patterns** for complex or frequently visited websites.

## Purpose

When automating repetitive or complex multi-step workflows on specific sites (e.g. internal admin panels, ERP systems, developer consoles, social publishing dashboards), agents do not need to rediscover the DOM from scratch.

By referencing or creating reusable playbooks here, agents and users can:

1. **Save 80%+ Tokens**: Avoid dumping entire DOM trees when critical selectors and interaction sequences are already known.
2. **Execute Instantly**: Directly run high-speed pipeline batches via `browserpaw_batch_actions`.
3. **Bypass Known Gotchas**: Record site-specific modal dismissals, hidden inputs, or timing requirements.

---

## Playbook Structure Template

When creating a new site recipe (e.g. `recipes/my-service.md`), follow this standardized layout:

````markdown
# Site Recipe: <Service Name>

- **Target URL**: https://example.com/dashboard/*
- **Purpose**: Log in, search, or automate specific actions.

### 1. Key Elements & Identifiers

- Search Input: `#search-box` or label "Search"
- Submit Button: `button[type="submit"]` or `[asset N]`

### 2. Fast-Path Pipeline (`browserpaw_batch_actions`)

```json
{
  "actions": [
    { "type": "fill", "selector": "#username", "text": "my-user" },
    { "type": "fill", "selector": "#password", "text": "my-pass" },
    { "type": "click", "selector": "#login-btn" },
    { "type": "assert", "selector": ".user-profile", "condition": "visible" }
  ],
  "includeDelta": true
}
```
````

### 3. Site Gotchas & Workarounds

- _Gotcha_: Has a full-screen cookie consent modal on first visit.
  - _Fix_: Call `browserpaw_dismiss_overlay` (or pass `dismissOverlays: true` to `browserpaw_navigate` / `browserpaw_read_dom`) — no DOM dump needed.
- _Gotcha_: Search input is debounced by 300ms.
  - _Fix_: Settle automatically waits for network quiescence.
