---
name: browserpaw
description: Control the user's Chrome or Chromium through the BrowserPaw CLI. Use for navigation, DOM inspection, forms, extraction, screenshots, uploads, downloads, and multi-step browser tasks.
---

# BrowserPaw

Run `browserpaw status` to confirm the host and extension are connected. Use `browserpaw help` and `browserpaw help COMMAND` to discover syntax at the installed version. If setup is needed, use [troubleshooting](references/TROUBLESHOOTING.md).

For an npx-only installation, use `npx --yes browserpaw@5.0.0` in place of `browserpaw` throughout.

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

For a deterministic workflow, `batch FILE` accepts JSON arrays of command arguments and stops on the first failure. Use `recipe list` to discover existing workflows and provide fresh explicit inputs to `recipe run`. Use `--json` to read receipts and follow file references for large results.

See [commands](references/commands.md) and [recipes](references/recipe-contract.md).
