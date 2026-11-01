# BrowserPaw Hermes troubleshooting

1. Confirm Chrome has the BrowserPaw extension enabled and its connection indicator is healthy.
2. Confirm the BrowserPaw Native Messaging host registration points to the current installation, then reload the extension from `chrome://extensions`.
3. Check port and token only through BrowserPaw's own diagnostic output. Do not print or copy the bridge token.
4. If the wrapper set is unavailable, confirm the installed plugin is `plugins/browserpaw-hermes` and restart Hermes so its manifest and tool definitions are reloaded.
5. If a browser action reports `unknown`, do not replay it. Inspect the page and task state first.
6. If a page cannot load, challenge, login, or verification is blocking progress, hand control to the user in Chrome. Do not bypass it.
7. If `browserpaw_act_toward_goal` reports that Jev is paused or off, check `browserpaw_tool_docs` for the current result. Native retains the requested Remote/Local preference. Network, timeout and rate-limit failures may resume the same backend after 30 seconds; corrected authentication/configuration restores it immediately. A deliberate Off stays off, and backends never switch automatically.
8. Deterministic locator operations have zero inference; semantic assistance only aids non-exact queries within 1500ms deadline, <=32 candidates, confidence >=0.85, and margin >=0.20 limits. A `none` result is a normal non-match, not a failure.
9. `browserpaw_skill` find only recommends candidates; execution requires a verified version and matching hash.
10. Remote evaluation does not yet establish stable Chinese semantic automation; refused low-confidence matches are not completed work. Unavailable token counts and prices are null, and no broad accuracy or percentage improvements are claimed.

Run `browserpaw_tool_docs` for the live contract before assuming a parameter from a different BrowserPaw client.
