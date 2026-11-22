---
name: browserpaw
description: Control the user's Chrome or Chromium through the BrowserPaw CLI and run learned site workflows stored in ~/.browserpaw. Use automatically for live web tasks, logged-in sites, site searches, navigation, DOM inspection, forms, extraction, screenshots, uploads, and downloads.
---

# BrowserPaw

Run `browserpaw status` to confirm the host and extension are connected. Use `browserpaw search KEYWORD` to find a command offline and `browserpaw help COMMAND` to check its syntax. If setup is needed, use [troubleshooting](references/TROUBLESHOOTING.md).

For browser history, bookmarks, or site storage, use `browserpaw help data` and [browser data](references/browser-data.md). For network, performance, or CDP work, use `browserpaw help debug` and [debugging](references/debugging.md).

When invoked on demand, the CLI checks npm every 24 hours, installs verified updates under `~/.browserpaw/cli-versions/`, and refreshes the host, bundled recipes, and managed Skills (`BROWSERPAW_NO_AUTO_UPDATE=1` / `BROWSERPAW_NO_UPDATE_CHECK=1` opt out). If auto-update is disabled and stderr reports an update, mention it once after finishing the task before running `browserpaw setup`. Same-major CLI updates (`5.0.x` with extension `>= 5.0.0`) stay compatible without requiring an extension reload; `browserpaw status` reports `extensionUpdateAvailable` or incompatibility for manual updates in `chrome://extensions`. Update plugin-bundled Skills via their Agent's plugin manager.

For an npx-only installation, use `npx --yes browserpaw@5.0.0` in place of `browserpaw` throughout.

## Learned Workflows & Auto-Routing (`~/.browserpaw`)

Before manually browsing a site, check any synced `Learned Workflows` table or run `browserpaw recipe find <query> --url <url>` / `browserpaw recipe list` (offline against `~/.browserpaw`). Trusted bundled read-only skills appear by default with status `bundled` (no `--all` needed); unvalidated custom or proposed candidates require `recipe list --all` and `browserpaw recipe validate ID`. When a recipe matches, inspect inputs with `browserpaw recipe show ID` if needed and run `browserpaw recipe run ID key=value...` directly.

First `browserpaw recipe run ID ...` on a `bundled` skill auto-validates and activates it; newer bundled revisions auto-upgrade with rollback on validation failure, preserving user-created, disabled, and pinned skills. For custom or repaired candidates (`recipe list --all`), run `browserpaw recipe validate ID` once with Chrome connected. Only verified read-only workflows auto-activate; write-capable candidates remain manual.

When you solve a repeatable site workflow that has no learned entry yet (such as a site search or structured page reader), save it into `~/.browserpaw` with `browserpaw recipe save FILE` including `id`, `name`, `description`, `domains`, `keywords`, `inputs`, and `steps` (or propose a verified read-only skill). Saving creates a candidate, which remains discoverable through `recipe list --all` but does not enter automatic routing until validation. Repair one failing step with `browserpaw recipe patch ID --step INDEX -- ARGS...`; the candidate revision is written separately, so a failed repair or validation preserves the active workflow. A failed recipe returns `failedStepIndex`, `failedStep`, `completedSteps`, and a bounded page summary when a temporary task remains available. Never store passwords, cookies, tokens, tab IDs, or observed refs in saved recipes.

## Interactive Browser Tasks

```text
browserpaw task start research --json
browserpaw open https://example.com --task TASK_ID
browserpaw observe --task TASK_ID --json
browserpaw click REF --task TASK_ID
browserpaw observe --task TASK_ID
browserpaw task finish --task TASK_ID
```

Use the returned task ID throughout. A task owns pages it opens and preserves borrowed pages. To work on a specific existing page, choose its ID from `browserpaw tabs`, then use `--tab ID` or `task borrow ID --task TASK_ID`. Use `task release` to hand back a page.

Use current observed refs or strict CSS, text, role, and label targets. When a frame ID is known, pass `--frame ID` to a frame-aware action. Observe again after navigation, DOM replacement, or an ambiguous target. For multiline input, use `fill TARGET --input FILE` or pass the literal string after `--`.

Read screenshots with the local image viewer using the returned file path. For coordinates, use `click @X,Y --capture ID` from the current screenshot and the same tab. Use a fresh capture after geometry or page changes.

Use `download REF` for a page-triggered download receipt. Use `download --url URL --out DIR` when the file URL is known and a verified local file path is needed.

Check page state before completing the task. Verify the business effect after a write. Use `ask-human` for browser challenges, authentication prompts, or user confirmation. Use `task status` and a fresh observation after exit 4, which indicates an unknown outcome. Cancellation stops later work and keeps effects already dispatched.

If a task records a pending document after navigation, inspect `task status` and `observe --tab ID`. After verifying the page, run `task resume --task TASK_ID --adopt`, then observe again under the task or finish it. Resume does not replay the previous action.

For a one-off deterministic sequence, `batch FILE` accepts JSON arrays of command arguments and stops on the first failure. Use `--json` to read receipts and follow file references for large results.
See [commands](references/commands.md) and [recipes](references/recipe-contract.md).
