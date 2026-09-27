# Contributing Guide 🤝

Thank you for your interest in contributing to BrowserPaw! This document provides guidelines and information for contributors.

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

- **Node.js 20+** and **pnpm or npm** (latest version)
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
npm run dev
```

4. **Load the extension in Chrome**
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select `app/chrome-extension/.output/chrome-mv3` (generated after running `pnpm build` or `pnpm --filter chrome-mcp-server dev`).

## 🏗️ Project Structure

```
browserpaw/
├── app/
│   ├── chrome-extension/     # Chrome extension MV3 (WXT + Vue 3)
│   │   ├── entrypoints/      # Background SW, popup, and isolated inpage scripts
│   │   ├── tests/            # Vitest suite for all 50 extension tool executors & utilities
│   │   └── utils/            # CDP session manager, storage managers, ring buffer
│   └── native-server/        # Native messaging Fastify bridge & Stdio MCP host
│       ├── src/mcp/          # MCP protocol implementation (HTTP, SSE, Stdio)
│       └── src/server/       # Fastify server, auth token validator, native messaging pipe
├── packages/
│   └── shared/               # Universal schemas (TOOL_SCHEMAS), profiles (TOOL_CATEGORIES), types
├── scripts/                  # Code & doc generation utilities (gen-tools-doc.mjs)
└── docs/                     # Documentation vault (MAP, ARCHITECTURE, TOOLS, TROUBLESHOOTING)
```

## 🛠️ Development Workflow

### Adding New Tools

1. **Define the tool schema in `packages/shared/src/tools.ts`**:
   Specify parameters, descriptions, and required fields.

2. **Register the tool name in `packages/shared/src/types.ts`** under `TOOL_NAMES.BROWSER`.

3. **Map the tool to a category in `packages/shared/src/tool-profiles.ts`**:
   Add the tool name to `TOOL_CATEGORIES` under one of the 8 canonical categories:
   `navigate`, `perceive`, `act`, `observe`, `manage`, `diagnose`, `network`, or `crawl`.
   If it belongs in the default profiles, include it in `CORE_TOOL_NAMES` or `CRAWL_TOOL_NAMES`.

4. **Implement the tool executor in `app/chrome-extension/entrypoints/background/tools/browser/`**:
   Extend `BaseBrowserToolExecutor` and implement `execute(args)`.

5. **Register the executor in `app/chrome-extension/entrypoints/background/tools/browser/index.ts`** in `toolsMap`.

6. **Regenerate tool documentation**:

   ```bash
   pnpm --filter chrome-mcp-shared build
   node scripts/gen-tools-doc.mjs
   ```

7. **Add automated tests**:
   Add a unit test in `app/chrome-extension/tests/` and verify with `pnpm --filter chrome-mcp-server test` and `pnpm test`.

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
   - Verify MCP protocol compatibility

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
- **MCP client**: Which MCP client you're using (Claude Desktop, etc.)

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

### Testing MCP Protocol

- Use MCP Inspector for protocol debugging
- Test with different MCP clients (Claude Desktop, custom clients)
- Verify tool schemas and responses match MCP specifications

## 📚 Resources

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
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
