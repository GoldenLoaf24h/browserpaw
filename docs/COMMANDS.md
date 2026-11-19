# BrowserPaw commands

Run `browserpaw help COMMAND` for help from the installed version.
Page commands take `--tab ID` or `--task ID`. Use `--frame ID` on frame-aware commands.
`--json` emits a single receipt. Use `--` before an argument starting with a dash.

Targets: 12 (observed ref), css:SELECTOR, text:TEXT, role:ROLE[:NAME], label:LABEL, or @X,Y --capture ID. Use --frame ID to select a frame. After navigation or a stale ref, observe again.

| Command | Purpose |
| --- | --- |
| `setup [--browser BROWSER] [--skill-dir DIR] [--no-skill]` | Install the host, extension, and Skill for chrome, chromium, or all. |
| `status` | Show local host and extension connection and build identity. |
| `doctor [--fix]` | Diagnose installation and connection. Use --fix to repair registration. |
| `uninstall [--purge]` | Remove the managed installation. Purge also removes its user data. |
| `help [COMMAND\|TOPIC]` | Show usage and examples without opening Chrome. |
| `tabs` | List windows and tabs with IDs. |
| `open URL [--foreground]` | Open a new tab. With --task, own the new page. |
| `nav URL\|back\|forward\|reload` | Navigate the selected page. |
| `tab focus ID` | Bring the selected tab to the foreground. |
| `tab close ID...` | Close explicitly named tabs. |
| `observe [--scope CSS] [--delta] [--max N]` | Read page structure, frame IDs, and actionable refs. |
| `text [TARGET] [--max-chars N]` | Read Markdown or extract text from a single target. |
| `find PATTERN [--regex] [--scroll]` | Find matching elements in the page. |
| `screenshot [TARGET] [--full] [--out FILE]` | Save an image locally and return its capture ID. |
| `wait [TARGET] [--text TEXT\|--url URL] [--gone] [--timeout MS]` | Wait for a target, page text, or URL condition. |
| `console [--level LEVEL] [--clear]` | Read or clear the selected tab’s console buffer. |
| `network start [--filter PATTERN] [--bodies]` | Start a scoped network recording. |
| `network stop` | Stop recording and return the captured events. |
| `network show` | Read currently captured network events. |
| `click TARGET [--double\|--right] [--capture ID]` | Click the target from the current observation or capture. |
| `fill TARGET TEXT [--append] [--input FILE\|-]` | Replace or append text. Use -- before option-like text. |
| `select TARGET [VALUE...]` | Read available choices or select by value. |
| `hover TARGET [--capture ID]` | Move the pointer to a target. |
| `press KEYS [TARGET]` | Send a key sequence, optionally to a strict target. |
| `scroll [TARGET] [--up\|--down\|--top\|--bottom] [--by PX]` | Scroll the page or a scroll container. |
| `drag FROM TO [--capture ID]` | Drag between two observed refs or capture coordinates. |
| `upload TARGET FILE...` | Choose local files for the specified input. |
| `dialog accept\|dismiss [--id ID] [--text TEXT]` | Handle a dialog from the selected page. |
| `download [TARGET] [--url URL] [--out DIR] [--timeout MS]` | Trigger and wait for a verified download from this page. |
| `eval [CODE] [--file FILE\|-] [--timeout MS]` | Evaluate explicit JavaScript in the selected page. |
| `fetch URL [--method METHOD] [--header KEY:VALUE]... [--body BODY]` | Send an explicit request from the selected page. |
| `cdp METHOD [JSON]` | Call a supported DevTools command in the selected tab. |
| `ask-human MESSAGE [--timeout MS]` | Pause at a page and ask the user to intervene. |
| `task start NAME [--goal TEXT]` | Start a durable task and return its ID. |
| `task list` | List local tasks. |
| `task status [ID]` | Inspect task pages and known and uncertain outcomes. |
| `task finish [--keep ID]... [--keep-unknown]` | Close verified owned pages and preserve borrowed pages. |
| `task cancel` | Stop the task without rolling back dispatched work. |
| `task borrow ID` | Associate an existing user tab with the task. |
| `task release ID` | Hand an owned tab back to the user. |
| `batch FILE\|-` | Run JSON argument arrays in order, stopping at the first failure. |
| `recipe list [--url URL]` | List bundled and saved workflows. |
| `recipe run ID [KEY=VALUE...]` | Run a saved workflow with explicit inputs. |
| `recipe save FILE\|-` | Save a reviewed workflow definition. |
| `recipe rm ID` | Remove a locally saved workflow. |
