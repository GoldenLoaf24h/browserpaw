# Troubleshooting

- Run `browserpaw doctor` to inspect the installed path, registration, and host connection. Run `browserpaw doctor --fix` to repair a missing registration.
- On first setup, load the path printed by setup in `chrome://extensions`. For an upgrade, download and unpack the matching `browserpaw-extension.zip` from the release. Load the new folder, or reload the extension after replacing the files in the folder Chrome already loads. Confirm the connection and version with `browserpaw status`.
- Use the same `BROWSERPAW_HOME` for setup and CLI calls. A second Chrome profile using the same installation can conflict with the listener.
- Use the ref and capture ID from fresh observations. Exit 4 means an action may have reached Chrome. Inspect the page before deciding the next action.
- `browserpaw help COMMAND` lists the supported flags from the current build.
