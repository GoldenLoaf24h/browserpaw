# Recipes

Learned site skills and saved CLI recipes are stored under `~/.browserpaw` (`~/.browserpaw/skills` and `~/.browserpaw/recipes`) and indexed in `~/.browserpaw/learned-index.json`.

## Discover and Run

1. Match by intent or URL before browsing manually (works even before Chrome connects):
   - `browserpaw recipe find twitter search`
   - `browserpaw recipe find --url https://x.com/search?q=ai`
   - `browserpaw recipe list --all` (includes unvalidated `candidate` skills)
2. Inspect required inputs and example syntax:
   - `browserpaw recipe show x-search-thread`
3. Activate a bundled or newly proposed candidate skill once:
   - `browserpaw recipe validate x-search-thread`
4. Execute directly with typed `KEY=VALUE` inputs (numbers, booleans, and JSON values are coerced from the schema):
   - `browserpaw recipe run x-search-thread query="typescript" limit=5`

## Save a Learned CLI Workflow

Save a reviewed JSON file with `browserpaw recipe save FILE` (or `-` via stdin) and remove or disable it with `browserpaw recipe rm ID`. Each step uses the arguments from `browserpaw help`.

```json
{
  "id": "site-search",
  "name": "Example Site Search",
  "description": "Search Example Docs and extract the main result list",
  "domains": ["example.com"],
  "keywords": ["example", "search", "docs"],
  "inputs": {
    "query": { "type": "string", "required": true, "description": "Search keywords" }
  },
  "steps": [
    ["open", "https://example.com/search?q={{query}}"],
    ["wait", "css:main", "--timeout", "10000"],
    ["text", "css:main"]
  ]
}
```

- Placeholders inside `http(s)://` URLs are URL-encoded automatically; non-URL arguments keep their literal text.
- Standalone recipes containing `open` automatically start and clean up a temporary task when called without `--task` or `--tab`. Pass `--task ID` or `--tab ID` to run inside an existing page context.
- Verified read-only skill definitions (`startUrl`, `inputSchema`, `outputSchema`, `verification`, `tests`) can also be proposed via `browserpaw recipe save FILE` and activated with `browserpaw recipe validate ID`.
- Saving, validating, or removing a workflow automatically refreshes `~/.browserpaw/learned-index.json` and the installed `SKILL.md` routing table so Agents discover and call it without user reminders.
- Keep passwords, tokens, cookies, tab IDs, observed refs, and other transient values out of saved recipes.
