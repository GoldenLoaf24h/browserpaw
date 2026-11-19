# BrowserPaw

[Simplified Chinese](README.zh-CN.md)

BrowserPaw gives an Agent command-line control of an existing Chrome or Chromium profile. The Agent reads an installed Skill, runs `browserpaw`, and receives concise results or local file references. The extension connects to the local Native Messaging host and performs browser operations.

## Install

Use Node.js 22.6 or later. After the npm release, run either command:

```sh
npx browserpaw@5.0.0 setup
npm install -g browserpaw@5.0.0
browserpaw setup
```

After an npx-only setup, run commands with `npx --yes browserpaw@5.0.0`, such as `npx --yes browserpaw@5.0.0 status`.

For a local candidate, run `npx --yes --package /path/to/browserpaw-5.0.0.tgz browserpaw setup`. Use the installed extension path printed by setup. In `chrome://extensions`, enable Developer mode and choose **Load unpacked**. Setup copies the host outside npm's cache. The Skill installs under `~/.agents/skills/browserpaw` by default. Use `--skill-dir` to choose the Agent's skills root, `--no-skill` to skip the copy, or `--browser chromium` for Chromium.

## Run

```text
browserpaw status
browserpaw help
browserpaw task start research --json
browserpaw open https://example.com --task TASK_ID
browserpaw observe --task TASK_ID
browserpaw text --task TASK_ID
browserpaw screenshot --task TASK_ID --out page.png
browserpaw task finish --task TASK_ID
```

Replace `TASK_ID` with the returned task ID. To operate on an existing page, run `browserpaw tabs` and select it with `--tab ID`. Read [command reference](docs/COMMANDS.md) and the [Agent Skill](skills/browserpaw/SKILL.md) for refs, frames, recipes, and receipts.

Run `browserpaw doctor` for installation checks and `browserpaw doctor --fix` to repair the registered host. `browserpaw uninstall` removes the managed installation and preserves task and recipe data. `--purge` also removes the BrowserPaw data from its installation directory.

See [architecture](docs/ARCHITECTURE.md), [troubleshooting](docs/TROUBLESHOOTING.md), and [release history](docs/releases/README.md).
