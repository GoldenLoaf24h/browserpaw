# Contributing Guide 🤝

Thank you for your interest in contributing to BrowserPaw! This document provides guidelines and information for contributors.

The authoritative acceptance contract is [QUALITY.md](./QUALITY.md). Run `pnpm verify` before delivery; individual test commands below are development checks. Extension delivery additionally requires `pnpm build:deploy`, `pnpm verify:delivery`, and runtime identity confirmation after manual reload.

Document ownership and repository layout are defined in [DOCUMENTATION](./DOCUMENTATION.md). Release preparation follows [RELEASING](./releases/RELEASING.md).

Before editing, read [development boundaries and current release work](./development/DEVELOPMENT.md). Use focused checks while iterating and the complete gate before release. Preserve existing worktree changes; do not clean runtime data or deploy during a documentation-only task.

## 🎯 How to Contribute

We welcome contributions in many forms:

- 🐛 Bug reports and fixes
- ✨ New features and tools
- 📚 Documentation improvements
- 🧪 Tests and performance optimizations
- 🌐 Translations and internationalization
- 💡 Ideas and suggestions

## 🚀 Getting Started

### Prerequisites

- **Node.js 22.6+** and **pnpm** (use the version pinned in `package.json`)
- **Python 3.9+** with `pytest` for the Hermes plugin gate
- **Chrome/Chromium** browser for testing
- **Git** for version control
- **TypeScript** knowledge

### Development Setup

1. **Fork and clone the repository**

```bash
git clone https://github.com/YOUR_USERNAME/browserpaw.git
cd browserpaw
```

2. **Install dependencies**

```bash
pnpm install
```

3. **Start the project**

```bash
pnpm dev
```

4. **Load the extension in Chrome**
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select `app/chrome-extension/.output/chrome-mv3` (generated after running `pnpm build` or `pnpm --filter chrome-mcp-server dev`).

## 🏗️ Project Structure

BrowserPaw adheres to the canonical Repository Layout Specification defined in [`docs/DOCUMENTATION.md`](./DOCUMENTATION.md):

```
browserpaw/
├── app/                      # Primary applications: Chrome MV3 extension & Native Messaging host
│   ├── chrome-extension/     # Chrome extension MV3 (WXT + Vue 3 background SW & tools)
│   └── native-server/        # v5 CLI and loopback Native Messaging host
├── packages/                 # Shared libraries
│   └── shared/               # CLI command registry, browser schemas and shared protocol types
├── test/                     # Cross-package integration suites, E2E runners, and mock servers (kept in-place)
├── scripts/                  # Repository lifecycle, verification, and code generation utilities
├── .artifacts/               # Ephemeral verification outputs, test dumps, delivery reports (excluded from docs)
├── docs/                     # Documentation vault (README hub, QUALITY, DOCUMENTATION, MAP)
│   └── archive/              # Isolated historical records, handoffs, and frozen test notes
├── research/                 # External investigations, spikes, and third-party references (isolated)
└── releases/                 # Local distribution archives (stable zip artifacts: browserpaw-extension.zip)
```

## 🛠️ Development Workflow

### Adding New CLI Commands and Browser Executors

1. **Define the command spec in `packages/shared/src/commands.ts`**:
   Register command names, options, arguments, examples, and search keywords in `COMMAND_SPECS`.

2. **Route the command in `app/native-server/src/command-dispatch.ts`** (and `commands-page.ts` / `commands-debug.ts` when applicable):
   Map the parsed CLI command to a local handler or internal extension execution request, preserving task ownership and receipt contracts.

3. **Implement or reuse the browser executor in `app/chrome-extension/entrypoints/background/tools/browser/`**:
   Extend `BaseBrowserToolExecutor`, implement `execute(args)`, and ensure it is registered in `app/chrome-extension/entrypoints/background/tools/index.ts` (and `packages/shared/src/tools.ts` if an internal extension schema is shared).

4. **Regenerate command documentation and sync skill mirrors**:

   ```bash
   pnpm --filter chrome-mcp-shared build
   pnpm docs:commands
   node scripts/sync-skills.mjs
   ```

5. **Add automated tests**:
   Add focused tests in `app/chrome-extension/tests/`, `app/native-server/src/`, or `scripts/browserpaw-commands.test.mjs`, and verify with `pnpm verify`.

### Core Architecture & Security Guidelines for Contributors

- **Sender Authentication**: Any `chrome.runtime.onMessage` listener must strictly validate `_sender.id === chrome.runtime.id && !_sender.tab` to reject unauthorized messages from web page content scripts or external extensions.
- **DOM XSS Defense**: Never interpolate untrusted strings or user inputs into `innerHTML`. Construct elements using safe DOM APIs (`document.createElement`, `document.createTextNode`, or `textContent`).
- **Cross-Frame Isolation**: Always scope inpage scripts to target frames (`frameIds: [targetFrameId]`) and reindex subframe element numbers to avoid polluting the main frame's WeakRef element map.
- **CDP Domain Lifecycle**: Use `CDPSessionManager.enableDomain` and `disableDomain` for reference-counted domain enablement. Never call raw CDP `*.disable` on core pinned domains (`Page`, `Network`).
- **Debugger Anti-Hang**: Use `detach(tabId, 'timeout-guard')` or `detachDebugger(tabId)` to forcefully detach physical debuggers on unresponsive pages without refcount underflows.
- **MV3 Storage Persistence**: Any background manager state (`affinityMap`, `managedGroups`, `favicons`) must synchronize with `chrome.storage.session` to survive 30-second MV3 service worker dormancy.
- **Non-Disruptive Background Execution**: Never switch the user's active tab or steal window focus (`active: false`, `focused: false`) unless explicitly requested by the user.
- **Safe Tab Closure**: Tools that close tabs must require explicit confirmation (`confirm: true`) or session tab affinity when `tabIds` and `url` are omitted, protecting the user's active tab.
- **Offscreen Screenshots**: Background tabs (`active: false`) must strictly use CDP `Page.captureScreenshot(fromSurface: true)` rather than `chrome.tabs.captureVisibleTab`.
- **Cross-Platform macOS Key Bitmask**: On macOS, Command (Meta) key modifier bitmasks must equal `4` (`mod = 4`).

### Code Style Guidelines

- **TypeScript**: Use strict TypeScript with proper typing
- **ESLint**: Follow the configured ESLint rules (`pnpm lint`)
- **Prettier**: Format code with Prettier (`pnpm format`)
- **Naming**: Use descriptive names and follow existing patterns
- **Comments**: Add JSDoc comments for public APIs
- **Error Handling**: Always handle errors gracefully

## 📝 Pull Request Process

1. **Create a feature branch**

```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes**
   - Follow the code style guidelines
   - Add tests for new functionality
   - Update documentation if needed

3. **Test your changes**
   - Ensure all existing tests pass
   - Test the Chrome extension manually
   - Verify the CLI, Native loopback protocol and extension integration
   - **Authentic Evidence Integrity**: Never hand-edit or fabricate `sourceFingerprint`, `buildId`, delivery hashes, or test `status` fields.
   - **Documentation Edit Re-verification**: Documentation changes invalidate prior verification fingerprints; rerun the full gate before a release or delivery claim. Focused documentation checks are sufficient during iteration.
   - **Browser Acceptance vs. Simulated Tests**: Mocked or simulated E2E runs are development checks and do **not** constitute browser acceptance. Real browser verification requires loading into Chrome, performing a manual extension reload in `chrome://extensions`, and confirming matching runtime `buildId` via `browserpaw doctor` (or `browserpaw status`).

4. **Commit your changes**

```bash
git add .
git commit -m "feat: add your feature description"
```

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for adding tests
- `refactor:` for code refactoring

5. **Push and create a Pull Request**

```bash
git push origin feature/your-feature-name
```

## 🐛 Bug Reports

When reporting bugs, please include:

- **Environment**: OS, Chrome version, Node.js version
- **Steps to reproduce**: Clear, step-by-step instructions
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Screenshots/logs**: If applicable
- **Client integration**: The Agent host, plugin or shell integration in use

## 💡 Feature Requests

For feature requests, please provide:

- **Use case**: Why is this feature needed?
- **Proposed solution**: How should it work?
- **Alternatives**: Any alternative solutions considered?
- **Additional context**: Screenshots, examples, etc.

## 🔧 Development Tips

### Debugging Chrome Extension

- Use Chrome DevTools for debugging extension popup and background scripts
- Check `chrome://extensions/` for extension errors
- Use `console.log` statements for debugging
- Monitor the native messaging connection in the background script

### Testing the CLI and Native Protocol

- Use `browserpaw help`, `browserpaw status` and `browserpaw doctor` for offline and live diagnostics
- Test raw browser commands and JSON receipts from a shell
- Verify Native loopback and extension responses through the existing test suites

## 📚 Resources

- [Chrome Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome Extension Development](https://developer.chrome.com/docs/extensions/)
- [WXT Framework Documentation](https://wxt.dev/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## 🤝 Community

- **GitHub Issues**: For bug reports and feature requests
- **GitHub Discussions**: For questions and general discussion
- **Pull Requests**: For code contributions

## 📄 License

By contributing to BrowserPaw, you agree that your contributions will be licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

## 🎯 Contributor Guidelines

### New Contributors

If you're contributing to an open source project for the first time:

1. **Start small**: Look for issues labeled "good first issue"
2. **Read the code**: Familiarize yourself with the project structure and coding style
3. **Ask questions**: Ask questions in GitHub Discussions
4. **Learn the tools**: Get familiar with Git, GitHub, TypeScript, and other tools

### Experienced Contributors

- **Architecture improvements**: Propose system-level improvements
- **Performance optimization**: Identify and fix performance bottlenecks
- **New features**: Design and implement complex new features
- **Mentor newcomers**: Help new contributors get started

### Documentation Contributions

- **API documentation**: Improve tool documentation and examples
- **Tutorials**: Create usage guides and best practices
- **Translations**: Help translate documentation to other languages
- **Video content**: Create demo videos and tutorials

### Testing Contributions

- **Unit tests**: Write tests for new features
- **Integration tests**: Test interactions between components
- **Performance tests**: Benchmark testing and performance regression detection
- **User testing**: Functional testing in real-world scenarios

## 🏆 Contributor Recognition

We value every contribution, no matter how big or small. Contributors will be recognized in the following ways:

- **README acknowledgments**: Contributors listed in the project README
- **Release notes**: Contributors thanked in version release notes
- **Contributor badges**: Contributor badges on GitHub profiles
- **Community recognition**: Special thanks in community discussions

Thank you for considering contributing to BrowserPaw! Your participation makes this project better.
