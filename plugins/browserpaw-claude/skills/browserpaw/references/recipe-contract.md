# Recipes

Run `browserpaw recipe list` to discover local and bundled recipes. Use `recipe run ID KEY=VALUE` with the inputs documented by the recipe.

Save a reviewed JSON file with `browserpaw recipe save FILE` and remove user-authored recipes with `browserpaw recipe rm ID`. Each step uses the arguments from `browserpaw help`.

```json
{
  "id": "read-title",
  "steps": [["text", "css:{{selector}}"]]
}
```

Apply it to the selected task or tab with `browserpaw recipe run read-title selector=h1 --task TASK_ID`. Batch execution stops at the first failure and returns completed step receipts. Keep passwords, tokens, tab IDs, observed refs, and other transient values out of saved recipes.
