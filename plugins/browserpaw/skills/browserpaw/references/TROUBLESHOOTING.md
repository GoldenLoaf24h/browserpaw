# Troubleshooting

- Run `browserpaw doctor` to inspect the installed path, registration, and host connection. Run `browserpaw doctor --fix` to repair a missing registration.
- Load the path printed by setup in `chrome://extensions` and check that the extension shows Connected. Reload after an upgrade if setup reports that it could not request a reload.
- Use the same `BROWSERPAW_HOME` for setup and CLI calls. A second Chrome profile using the same installation can conflict with the listener.
- Use the ref and capture ID from fresh observations. Exit 4 means an action may have reached Chrome. Inspect the page before deciding the next action.
- `browserpaw help COMMAND` lists the supported flags from the current build.
