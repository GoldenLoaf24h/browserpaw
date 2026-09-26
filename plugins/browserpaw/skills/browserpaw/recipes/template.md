# Recipe Template (DIY Custom Playbook)

- **Target Site**: [Site Name]
- **Target URL Pattern**: `https://*.example.com/*`
- **Author**: User / Agent DIY
- **Last Verified**: YYYY-MM-DD

---

## 1. Fast Identification

- Key container or unique header identifier: `.main-app`

## 2. Recommended Action Pipeline

```json
{
  "tabId": 123,
  "actions": [
    { "type": "fill", "selector": "#query", "text": "target_query" },
    { "type": "click", "selector": "#search_submit" }
  ]
}
```

## 3. Known Caveats

- Detail any anti-bot timing, hidden widgets, or required wait times here.
