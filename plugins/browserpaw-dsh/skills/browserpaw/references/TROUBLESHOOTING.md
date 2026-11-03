# BrowserPaw Troubleshooting

Run the generic diagnostics from the installed skill root when the bridge is unhealthy:

```powershell
node scripts/doctor.mjs
```

`--fix` is available only in a BrowserPaw source checkout or when `BROWSERPAW_REPO_ROOT`
points to one. Installed skills check the live Native/MCP runtime instead of source build files.

## Common Causes

- Chrome is closed, the BrowserPaw extension is not loaded, or the Native Host is not registered.
- Port `12306` is occupied by another process; check the configured loopback port.
- The bridge token is missing or unreadable; never copy it into prompts or skill files.
- A tab or frame navigated after observation; refresh the page and obtain new refs.
- A strict locator matched more than one element; provide a more specific selector, role, label, or frame.
- A screenshot coordinate is stale; capture a fresh screenshot and use its returned capture identity.
- `screenshot_page_unstable` means bounded read-only recaptures still saw DOM changes. Wait for the relevant view to settle before capturing again; no coordinate-valid image was returned.
- DOM `coverage.status: "incomplete"` preserves readable main content while identifying unreadable or unverified frames. Scope any extraction claim to the observed frames; missing main-frame content is an error and cannot be replaced by a child frame.
- A dialog, download, popup, or upload has multiple sources; select an explicit source before proceeding.
- Chrome is showing its native error page (`chrome-error://chromewebdata/`); content scripts cannot run there. Reload or navigate to a working page and obtain fresh refs. This is an expected page restriction, not a bridge failure.
- Jev semantic assistance can be temporarily paused after a network, timeout or rate-limit failure. The saved user preference remains Remote or Local, and the same backend may resume after 30 seconds on the next use. Authentication or configuration faults wait for correction; saving corrected settings restores the requested mode. A deliberate Off choice remains off.
- A semantic query returned `none` or `ambiguous`: `none` indicates no candidate satisfied the criteria (a valid business outcome, not a failure), while confidence < 0.85, top margin < 0.20, candidate count > 32, or a timeout beyond 1500ms halts execution safely without guessing.
- Deterministic locator failed: deterministic matching requires zero inference; ensure exact text, selectors, or refs are current rather than relying on semantic guessing.
- Skill execution failure: `chrome_skill` find only recommends candidates; `run` requires a matching verified version and immutable definition hash.

## Recovery Order

1. Run `chrome_doctor` and preserve its diagnostic output.
2. Reconnect the extension by opening its normal connection control.
3. Observe the exact tab and document again before retrying a read.
4. For an unknown mutation, observe the current state instead of replaying the request.
5. For CAPTCHA, 2FA, payment, or a login wall, hand control to the user.
6. Temporary network, timeout and rate-limit failures pause the selected backend for 30 seconds; the next use can resume it. Authentication/configuration faults wait for correction; saving a corrected configuration restores the requested mode. A deliberate Off selection stays off across restarts. Backends never change automatically. Real-model evaluation is bounded; unknown prices remain null.

## Component Paths

- Diagnostic scripts: `../scripts/`
- Static recipes: `../assets/recipes/`
- Learned skills: `$BROWSERPAW_HOME/skills` (default `~/.browserpaw/skills`)
