import fs from 'node:fs';
import path from 'node:path';

const GENERATED_DATE = '2026-09-25';

// Directory metadata catalog providing domain-specific intelligence for each directory
const METADATA = {
  '.': {
    title: 'browserpaw',
    purpose: 'Root of BrowserPaw — a high-efficiency Chrome browser automation MCP server and AI agent skill monorepo. It enables AI agents (Claude, Cursor, Windsurf, Codex) to operate an everyday Chrome browser with existing logins, cookies, and extensions in background tabs without stealing focus.',
    keyFiles: [
      { name: 'package.json', desc: 'Monorepo root scripts, dependencies, workspaces, and metadata' },
      { name: 'pnpm-workspace.yaml', desc: 'PNPM workspace definition configuring packages and apps' },
      { name: 'README.md', desc: 'Project overview, quick start, architecture highlights, and setup guide' },
      { name: 'README.zh-CN.md', desc: 'Chinese translation of README with Windows-specific quickstart instructions' },
      { name: 'PROJECT.md', desc: 'Engineering specifications, quality gates, and architecture summaries' },
      { name: 'PROJECT.zh-CN.md', desc: 'Chinese translation of engineering specifications' },
      { name: 'TEST_INFRA.md', desc: 'Comprehensive E2E test infrastructure specification and test matrix' },
      { name: 'AGENT_CONFIG_GUIDE.md', desc: 'Client configuration instructions for Claude, Cursor, and Windsurf' },
      { name: 'AGENT_CONFIG_GUIDE.zh-CN.md', desc: 'Chinese translation of client configuration guide' },
      { name: 'INSTALL.md', desc: 'Installation instructions for the native messaging host and extension' },
      { name: 'PRIVACY.md', desc: 'Privacy notice detailing data locality and local-only processing guarantees' },
      { name: 'RELEASE_NOTES_v3.1.0.md', desc: 'Release notes detailing v3.1.0 features, fixes, and migration notes' },
      { name: 'commitlint.config.cjs', desc: 'Conventional commits enforcement rules for git commit messages' },
      { name: 'eslint.config.js', desc: 'Global ESLint 9 flat configuration across TypeScript and Vue files' },
      { name: 'marketplace.json', desc: 'MCP and plugin catalog registry metadata for plugin discovery' },
      { name: 'pnpm-lock.yaml', desc: 'Pinned dependency tree lockfile' }
    ],
    instructions: [
      'This is a pnpm monorepo. Run commands using pnpm (e.g., pnpm build, pnpm test, pnpm typecheck).',
      'The canonical tool definitions and schemas live in packages/shared/src/tools.ts — keep them synchronized with any extension tool changes.',
      'Always follow conventional commits format enforced by commitlint.',
      'Do not modify generated files in dist/ or .output/ directly.'
    ],
    testing: 'Run `pnpm test` (or `node --experimental-strip-types test/e2e/runner.ts`), `pnpm typecheck`, and `pnpm lint`.',
    patterns: 'Monorepo workspace coordination; SSOT schema synchronization; layered profile filtering.',
    internalDeps: ['packages/shared'],
    externalDeps: ['pnpm', 'typescript', 'eslint', 'prettier', 'husky']
  },

  'app': {
    title: 'app',
    purpose: 'Container directory hosting the two primary executable applications: the Chrome MV3 extension and the Native Messaging Fastify bridge server.',
    keyFiles: [],
    instructions: [
      'Coordinate IPC protocol changes between chrome-extension and native-server simultaneously.',
      'Respect the 1MB Native Messaging buffer ceiling across all IPC boundaries.'
    ],
    testing: 'Test both packages: `pnpm --filter chrome-mcp-server test` and `pnpm --filter mcp-chrome-bridge test`.',
    patterns: 'Native Messaging StdIO framing (4-byte length header + JSON payload).',
    internalDeps: ['packages/shared'],
    externalDeps: ['Node.js >= 18']
  },

  'app/chrome-extension': {
    title: 'chrome-extension',
    purpose: 'Chrome MV3 Extension frontend and background service worker built with WXT framework, Vue 3, and TailwindCSS. Executes in-page DOM indexing, virtual cursor rendering, and 48 tool actions.',
    keyFiles: [
      { name: 'package.json', desc: 'Chrome extension workspace package definition and npm scripts' },
      { name: 'wxt.config.ts', desc: 'WXT build and manifest generation configuration for Manifest V3' },
      { name: 'tsconfig.json', desc: 'TypeScript compiler configuration for the extension package' },
      { name: 'vitest.config.ts', desc: 'Vitest testing configuration with chrome API mock setup' },
      { name: 'tailwind.config.ts', desc: 'TailwindCSS configuration for extension popup styling' },
      { name: 'eslint.config.js', desc: 'Extension-specific ESLint rules' },
      { name: 'env.d.ts', desc: 'WXT and Vite environment type declarations' },
      { name: 'README.md', desc: 'Extension development, build, and loading instructions' }
    ],
    instructions: [
      'Follow MV3 Service Worker lifecycle: state must persist in chrome.storage.session to survive 30s idle termination.',
      'Never perform direct DOM manipulation in background service worker — use inpage-engine.ts or inject-scripts.',
      'Enforce sender permission isolation: verify _sender.id === chrome.runtime.id.'
    ],
    testing: 'Run `pnpm --filter chrome-mcp-server test` (Vitest suite with 49+ test files).',
    patterns: 'WXT entrypoints; closed Shadow DOM overlays for cursor and intervention; isolated-world DOM perception.',
    internalDeps: ['packages/shared', 'app/chrome-extension/common', 'app/chrome-extension/utils'],
    externalDeps: ['wxt', 'vue', 'tailwindcss', 'vitest']
  },

  'app/chrome-extension/_locales': {
    title: '_locales',
    purpose: 'Container directory for internationalization locale message files supporting multi-language extension user interfaces.',
    keyFiles: [],
    instructions: [
      'Ensure message keys match across all language subdirectories when adding new UI strings.'
    ],
    testing: 'Validate JSON syntax in each messages.json file.',
    patterns: 'Chrome extension i18n message bundle schema.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/_locales/de': {
    title: 'de',
    purpose: 'German language localization bundle for the Chrome extension popup and UI prompts.',
    keyFiles: [
      { name: 'messages.json', desc: 'German localization key-value mapping for extension messages' }
    ],
    instructions: ['Maintain German translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/_locales/en': {
    title: 'en',
    purpose: 'Default English language localization bundle defining canonical UI strings and descriptions.',
    keyFiles: [
      { name: 'messages.json', desc: 'Canonical English localization key-value mapping' }
    ],
    instructions: ['Treat as canonical source for all locale key definitions.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/_locales/ja': {
    title: 'ja',
    purpose: 'Japanese language localization bundle for the Chrome extension.',
    keyFiles: [
      { name: 'messages.json', desc: 'Japanese localization key-value mapping for extension messages' }
    ],
    instructions: ['Maintain Japanese translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/_locales/ko': {
    title: 'ko',
    purpose: 'Korean language localization bundle for the Chrome extension.',
    keyFiles: [
      { name: 'messages.json', desc: 'Korean localization key-value mapping for extension messages' }
    ],
    instructions: ['Maintain Korean translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/_locales/zh_CN': {
    title: 'zh_CN',
    purpose: 'Simplified Chinese language localization bundle for the Chrome extension.',
    keyFiles: [
      { name: 'messages.json', desc: 'Simplified Chinese localization key-value mapping for extension messages' }
    ],
    instructions: ['Maintain Simplified Chinese translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/_locales/zh_TW': {
    title: 'zh_TW',
    purpose: 'Traditional Chinese language localization bundle for the Chrome extension.',
    keyFiles: [
      { name: 'messages.json', desc: 'Traditional Chinese localization key-value mapping for extension messages' }
    ],
    instructions: ['Maintain Traditional Chinese translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/common': {
    title: 'common',
    purpose: 'Common constants, TypeScript message types, and tool handler interfaces shared across extension entrypoints and utilities.',
    keyFiles: [
      { name: 'constants.ts', desc: 'Extension-wide operational constants, storage keys, and timeouts' },
      { name: 'message-types.ts', desc: 'Strongly-typed IPC message payload interfaces between background, popup, and content scripts' },
      { name: 'tool-handler.ts', desc: 'Interface contract and execution context for extension tool handlers' }
    ],
    instructions: [
      'Ensure message-types.ts remains strictly typed for all runtime communication payloads.'
    ],
    testing: 'Verified via extension typecheck and unit tests.',
    patterns: 'Strongly typed IPC messages and handler function contracts.',
    internalDeps: ['packages/shared'],
    externalDeps: []
  },

  'app/chrome-extension/entrypoints': {
    title: 'entrypoints',
    purpose: 'WXT framework entrypoints defining background scripts, content scripts, and popup interfaces.',
    keyFiles: [
      { name: 'agent-cursor.content.ts', desc: 'Content script injecting the virtual mouse cursor with spring kinematics and takeover banner into pages' },
      { name: 'inpage-engine.ts', desc: 'Isolated-world DOM perception engine performing tree walking, pruning, and indexed bounding-box projection' }
    ],
    instructions: [
      'agent-cursor.content.ts injects the virtual mouse overlay into pages within a closed Shadow DOM.',
      'inpage-engine.ts executes inside an isolated world for DOM indexing and tree walking.'
    ],
    testing: 'Run Vitest tests in tests/ for agent-cursor and inpage engine.',
    patterns: 'WXT defineContentScript and defineBackground conventions; closed Shadow DOM encapsulation.',
    internalDeps: ['app/chrome-extension/common', 'app/chrome-extension/utils'],
    externalDeps: ['wxt']
  },

  'app/chrome-extension/entrypoints/background': {
    title: 'background',
    purpose: 'Chrome extension Service Worker core handling Native Messaging lifecycle, tool dispatching, keep-alive timers, and watchdogs.',
    keyFiles: [
      { name: 'index.ts', desc: 'Service worker main entry point initializing Native Host, tool router, and message listeners' },
      { name: 'keepalive-manager.ts', desc: 'Keepalive heartbeat preventing premature MV3 service worker termination during operations' },
      { name: 'native-host.ts', desc: 'Native Messaging client managing connection and message parsing with local Node bridge' }
    ],
    instructions: [
      'Keepalive-manager prevents premature MV3 worker termination during long-running tasks.',
      'Native-host manages Stdio IPC connection to the local Node.js bridge.'
    ],
    testing: 'Run Vitest tests in tests/ covering native host and lifecycle.',
    patterns: 'MV3 Service Worker lifecycle management and event-driven tool routing.',
    internalDeps: ['app/chrome-extension/entrypoints/background/tools', 'app/chrome-extension/entrypoints/background/watchdogs'],
    externalDeps: ['chrome-types']
  },

  'app/chrome-extension/entrypoints/background/tools': {
    title: 'tools',
    purpose: 'Base browser tool abstraction and master registry routing tool calls to individual browser tool executors.',
    keyFiles: [
      { name: 'base-browser.ts', desc: 'Abstract base class providing CDP management, tab switching, injection, and error handling' },
      { name: 'index.ts', desc: 'Registry mapping canonical tool names to their corresponding tool class instances' }
    ],
    instructions: [
      'BaseBrowserTool provides common utilities: tab lookup, CDP attachment, script injection, and error formatting.',
      'All tools inherit from BaseBrowserTool and implement execute(params).'
    ],
    testing: 'Run Vitest suite in tests/.',
    patterns: 'Template method pattern via BaseBrowserTool; polymorphic action dispatching.',
    internalDeps: ['packages/shared', 'app/chrome-extension/utils'],
    externalDeps: []
  },

  'app/chrome-extension/entrypoints/background/tools/browser': {
    title: 'browser',
    purpose: 'Comprehensive implementation of all 48 browser tool executors, covering DOM reading, interactive clicks, fills, screenshots, CDP commands, network captures, tab management, and human handoffs.',
    keyFiles: [
      { name: 'agent-cursor.ts', desc: 'Controls virtual blue cursor animation and positioning in the webpage' },
      { name: 'attach-tab.ts', desc: 'Attaches automation focus to an existing or newly created tab' },
      { name: 'batch-actions.ts', desc: 'High-performance atomic pipeline executing multiple actions in one roundtrip' },
      { name: 'bookmark.ts', desc: 'Manages browser bookmarks' },
      { name: 'burst-interact.ts', desc: 'Executes rapid series of clicks or interactions' },
      { name: 'cdp-execute.ts', desc: 'Direct raw Chrome DevTools Protocol execution escape hatch' },
      { name: 'common.ts', desc: 'Shared helper functions for browser tool executors' },
      { name: 'computer.ts', desc: 'Anthropic Computer Use API adapter for mouse and keyboard events' },
      { name: 'console-buffer.ts', desc: 'In-memory ring buffer capturing console messages' },
      { name: 'console.ts', desc: 'Tool returning captured browser console logs' },
      { name: 'dialog.ts', desc: 'Handles JavaScript alert, confirm, and prompt dialogs' },
      { name: 'dismiss-overlay.ts', desc: 'Dismisses overlays, cookie banners, and popups' },
      { name: 'doctor.ts', desc: 'Diagnoses extension runtime health and CDP capabilities' },
      { name: 'dom-indexer.ts', desc: 'Coordinates in-page indexing and generates element candidate numbers' },
      { name: 'download-waiter.ts', desc: 'Waits for file downloads to complete' },
      { name: 'download.ts', desc: 'Triggers and manages browser downloads' },
      { name: 'fast-snapshot.ts', desc: 'High-speed DOM snapshot capture' },
      { name: 'file-upload.ts', desc: 'Automates file input uploads using CDP DOM.setFileInputFiles' },
      { name: 'fill-core.ts', desc: 'Core text input filling logic with event dispatching' },
      { name: 'fill-index.ts', desc: 'Fills inputs identified by numeric index with clear and enter options' },
      { name: 'form-pipeline.ts', desc: 'Multi-field automated form filling pipeline' },
      { name: 'get-dropdown-options.ts', desc: 'Extracts options from HTML select or custom dropdowns' },
      { name: 'get-links.ts', desc: 'Extracts hyperlinks and anchor metadata from page' },
      { name: 'get-markdown.ts', desc: 'Converts visible page content to clean structured Markdown' },
      { name: 'grep.ts', desc: 'Searches page content for text patterns and returns matching element indexes' },
      { name: 'history.ts', desc: 'Inspects browser navigation history' },
      { name: 'human-intervention.ts', desc: 'Displays takeover overlay requesting user to solve CAPTCHA or 2FA' },
      { name: 'in-page-engine.ts', desc: 'Injected script orchestrator' },
      { name: 'index.ts', desc: 'Barrel export for all browser tool modules' },
      { name: 'insert-media.ts', desc: 'Inserts media or mock streams into web pages' },
      { name: 'inspect-media.ts', desc: 'Inspects media elements (video, audio, canvas) on page' },
      { name: 'interact-index.ts', desc: 'Clicks, hovers, or double-clicks elements by numeric index' },
      { name: 'interaction.ts', desc: 'Core interaction primitives' },
      { name: 'intercept-api.ts', desc: 'Intercepts and mocks fetch / XHR network calls' },
      { name: 'javascript.ts', desc: 'Evaluates JavaScript expressions in the target page context' },
      { name: 'keyboard.ts', desc: 'Simulates low-level keyboard strokes, chords, and shortcuts' },
      { name: 'move-tab.ts', desc: 'Moves tabs between positions or windows' },
      { name: 'network-capture-debugger.ts', desc: 'Captures network traffic via CDP Network domain' },
      { name: 'network-capture-web-request.ts', desc: 'Captures network traffic via chrome.webRequest API' },
      { name: 'network-capture.ts', desc: 'Unified network traffic capture tool' },
      { name: 'network-request.ts', desc: 'Sends HTTP requests from the page context' },
      { name: 'performance.ts', desc: 'Measures Core Web Vitals and page performance' },
      { name: 'read-dom.ts', desc: 'Reads indexed DOM representation with compaction and delta support' },
      { name: 'screenshot.ts', desc: 'Captures viewport, full page, or element screenshots via CDP' },
      { name: 'scroll-until-found.ts', desc: 'Auto-scrolls virtualized feeds until target element is located' },
      { name: 'smart-scroll.ts', desc: 'Intelligent smooth scrolling with visual settle detection' },
      { name: 'storage.ts', desc: 'Inspects and modifies localStorage, sessionStorage, and cookies' },
      { name: 'tab-favicon.ts', desc: 'Retrieves or tracks tab favicons' },
      { name: 'tab-group-manager.ts', desc: 'Orchestrates Chrome tab groups and isolates agent tabs' },
      { name: 'tab-group.ts', desc: 'Tool interface for tab group operations' },
      { name: 'tool-docs.ts', desc: 'Provides dynamic tool schema docs and activates tools for session' },
      { name: 'undo-action.ts', desc: 'Reverts the most recent user action where supported' },
      { name: 'unified-locator.ts', desc: 'Polymorphic element resolver (index, css, xpath, text)' },
      { name: 'web-fetcher.ts', desc: 'Fetches web content with automatic navigation settling' },
      { name: 'window.ts', desc: 'Controls window sizing, placement, and state' }
    ],
    instructions: [
      'Tools must return standardized tool results matching packages/shared/src/tools.ts schemas.',
      'Always use SessionTabAffinityManager and OutputSanitizer to prevent leaks and tab collisions.',
      'Respect activeViewportOnly, includeDelta, and compact format flags in perception tools.'
    ],
    testing: 'Individual Vitest test files in tests/ (e.g., read-dom-compact.test.ts, interact-delta.test.ts).',
    patterns: 'Single-responsibility tool executors; fallback chains (DOM -> CDP -> Coordinate); delta computation.',
    internalDeps: ['packages/shared', 'app/chrome-extension/utils', 'app/chrome-extension/common'],
    externalDeps: ['chrome-types']
  },

  'app/chrome-extension/entrypoints/background/watchdogs': {
    title: 'watchdogs',
    purpose: 'Automated background watchdogs monitoring tab crashes, unexpected dialogs, and stuck downloads to prevent agent stalls.',
    keyFiles: [
      { name: 'base-watchdog.ts', desc: 'Abstract base watchdog managing event listeners and cleanup hooks' },
      { name: 'crash-watchdog.ts', desc: 'Monitors chrome.tabs.onRemoved and web navigation errors for tab crashes' },
      { name: 'dialog-watchdog.ts', desc: 'Auto-detects or handles unexpected modal alert/confirm dialogs' },
      { name: 'downloads-watchdog.ts', desc: 'Monitors download progress and prevents hanging on slow downloads' },
      { name: 'index.ts', desc: 'Master watchdog coordinator managing active watchdog instances' }
    ],
    instructions: [
      'Watchdogs must clean up listeners and timers upon tab detachment or completion.',
      'BaseWatchdog coordinates lifecycle registration.'
    ],
    testing: 'Vitest tests covering crash and dialog handling.',
    patterns: 'Observer pattern monitoring Chrome event listeners.',
    internalDeps: ['app/chrome-extension/common'],
    externalDeps: ['chrome-types']
  },

  'app/chrome-extension/entrypoints/popup': {
    title: 'popup',
    purpose: 'Extension popup user interface built with Vue 3, displaying bridge connection status, port configuration, and active sessions.',
    keyFiles: [
      { name: 'App.vue', desc: 'Root Vue 3 component displaying status card, port config, and active tabs' },
      { name: 'main.ts', desc: 'Vue application bootstrap mounting App.vue to the DOM' },
      { name: 'index.html', desc: 'HTML container template for the extension action popup' },
      { name: 'style.css', desc: 'Scoped styling overrides for popup interface' }
    ],
    instructions: [
      'Keep popup lightweight and reactive to storage.session changes.'
    ],
    testing: 'Build verification via `pnpm --filter chrome-mcp-server build`.',
    patterns: 'Vue 3 Composition API with TailwindCSS.',
    internalDeps: ['app/chrome-extension/common'],
    externalDeps: ['vue', 'tailwindcss']
  },

  'app/chrome-extension/entrypoints/styles': {
    title: 'styles',
    purpose: 'CSS stylesheet assets and Tailwind directives for extension entrypoints.',
    keyFiles: [
      { name: 'tailwind.css', desc: 'Tailwind CSS base, components, and utilities directives' }
    ],
    instructions: ['Tailwind directives for utilities and theme styling.'],
    testing: 'Verified during CSS compilation.',
    patterns: 'TailwindCSS utility classes.',
    internalDeps: [],
    externalDeps: ['tailwindcss']
  },

  'app/chrome-extension/inject-scripts': {
    title: 'inject-scripts',
    purpose: 'Vanilla JavaScript helpers dynamically injected into target pages for clicks, fills, keyboard simulation, and network monitoring.',
    keyFiles: [
      { name: 'accessibility-tree-helper.js', desc: 'Extracts accessibility roles, names, and computed states' },
      { name: 'click-helper.js', desc: 'Executes trusted-like click sequences and handles custom elements' },
      { name: 'fill-helper.js', desc: 'Fills form inputs and dispatches input/change events' },
      { name: 'keyboard-helper.js', desc: 'Simulates keydown, keypress, and keyup event streams' },
      { name: 'network-helper.js', desc: 'In-page XHR and fetch hook helper' },
      { name: 'screenshot-helper.js', desc: 'Calculates element bounds for targeted clipping' },
      { name: 'wait-helper.js', desc: 'Waits for DOM elements, network idle, or custom selector conditions' },
      { name: 'web-fetcher-helper.js', desc: 'In-page fetch helper with credential forwarding' }
    ],
    instructions: [
      'These scripts run in the page context. They must remain zero-dependency vanilla JS.',
      'Avoid global namespace pollution; wrap in IIFEs or isolated scopes.'
    ],
    testing: 'Tested via inpage-agent-helpers.test.ts.',
    patterns: 'Self-contained vanilla JS injection scripts.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/public': {
    title: 'public',
    purpose: 'Static public assets for the Chrome extension including icons and imagery.',
    keyFiles: [],
    instructions: ['Static files copied directly to extension build output.'],
    testing: 'Asset presence verification.',
    patterns: 'Standard extension static directory.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/public/icon': {
    title: 'icon',
    purpose: 'Extension PNG icons across standard resolutions (16, 32, 48, 96, 128 px).',
    keyFiles: [
      { name: '16.png', desc: '16x16 icon for browser favicon and extension toolbar' },
      { name: '32.png', desc: '32x32 icon for standard displays' },
      { name: '48.png', desc: '48x48 icon for Chrome extensions management page' },
      { name: '96.png', desc: '96x96 icon for high-DPI displays' },
      { name: '128.png', desc: '128x128 icon for Chrome Web Store and installation' }
    ],
    instructions: ['Ensure standard square PNG formats for Chrome extension manifest.'],
    testing: 'Visual inspection.',
    patterns: 'Manifest icon set.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/public/images': {
    title: 'images',
    purpose: 'Static UI images and graphics used in extension overlays and cursor rendering.',
    keyFiles: [
      { name: 'cursor-chat.png', desc: 'Graphic asset for virtual cursor chat indicator' }
    ],
    instructions: ['Static PNG/SVG assets.'],
    testing: 'Visual verification.',
    patterns: 'Image assets.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/tests': {
    title: 'tests',
    purpose: 'Vitest unit and integration test suite covering all extension tools, DOM perception, delta diffing, and MV3 lifecycle resilience.',
    keyFiles: [
      { name: 'vitest.setup.ts', desc: 'Global Vitest setup mocking chrome.* APIs and CDP events' }
    ],
    instructions: [
      'Mock Chrome APIs using vitest.setup.ts.',
      'Add test cases for edge cases (shadow DOM, iframes, multi-window, modal traps).'
    ],
    testing: 'Run `pnpm test` inside app/chrome-extension/.',
    patterns: 'Vitest with mocked chrome.* global APIs.',
    internalDeps: ['app/chrome-extension'],
    externalDeps: ['vitest']
  },

  'app/chrome-extension/types': {
    title: 'types',
    purpose: 'Ambient TypeScript type definitions for icons and custom extension modules.',
    keyFiles: [
      { name: 'icons.d.ts', desc: 'Type definitions for icon imports' }
    ],
    instructions: ['Provide ambient declarations for assets and non-TS modules.'],
    testing: 'Verified during tsc compilation.',
    patterns: 'TypeScript .d.ts declaration files.',
    internalDeps: [],
    externalDeps: []
  },

  'app/chrome-extension/utils': {
    title: 'utils',
    purpose: 'High-resilience utility classes supporting CDP session management with ref counting, DOM fingerprint delta diffing, coordinate parsing, popup protection, and tab affinity.',
    keyFiles: [
      { name: 'action-history-manager.ts', desc: 'Tracks historical actions for undo and state recovery' },
      { name: 'action-network-capture.ts', desc: 'Captures network requests triggered during specific actions' },
      { name: 'action-watchdog.ts', desc: 'Watchdog tracking action timeouts and hang prevention' },
      { name: 'cdp-session-manager.ts', desc: 'Session-aware CDP retention manager with domain reference counting' },
      { name: 'coordinate-parser.ts', desc: 'Parses polymorphic coordinates ([x, y] or {x, y})' },
      { name: 'delta-helper.ts', desc: 'Computes DOM mutation diffs between snapshots' },
      { name: 'form-semantic-matcher.ts', desc: 'Matches semantic form labels and autocomplete cues to inputs' },
      { name: 'i18n.ts', desc: 'Extension internationalization helper' },
      { name: 'image-utils.ts', desc: 'Image resizing, compression, and base64 format helpers' },
      { name: 'mouse-trajectory.ts', desc: 'Computes smooth spring-physics trajectories for virtual cursor' },
      { name: 'output-sanitizer.ts', desc: 'Sanitizes DOM strings to prevent token bloat and confidential leaks' },
      { name: 'popup-guard.ts', desc: 'Detects and guards against unintended popup dismissals' },
      { name: 'race-cdp.ts', desc: 'Races CDP calls against timeouts to prevent debugger deadlocks' },
      { name: 'restricted-url.ts', desc: 'Validates against restricted chrome:// and file:// URLs' },
      { name: 'safe-post-message.ts', desc: 'Safe cross-frame message dispatching' },
      { name: 'screenshot-context.ts', desc: 'Context manager for offscreen vs surface screenshots' },
      { name: 'screenshot-guard.ts', desc: 'Guards against screenshot collisions and concurrency races' },
      { name: 'screenshot-ring-buffer.ts', desc: 'In-memory ring buffer holding recent screenshot frames' },
      { name: 'session-tab-affinity.ts', desc: 'Binds agent sessions to specific tab groups' },
      { name: 'snapshot-cache-manager.ts', desc: 'Caches DOM tree fingerprints to enable fast delta calculations' },
      { name: 'unified-locator.ts', desc: 'Unified locator engine resolving elements by multiple strategies' },
      { name: 'url-sanitizer.ts', desc: 'Normalizes and sanitizes navigation URLs' },
      { name: 'version-checker.ts', desc: 'Verifies compatibility between extension and bridge versions' }
    ],
    instructions: [
      'cdp-session-manager manages persistent CDP domains (Page, Network) with domain ref counting.',
      'snapshot-cache-manager computes structural delta diffs between DOM states.',
      'session-tab-affinity prevents multi-agent tab collisions.'
    ],
    testing: 'Unit tests in app/chrome-extension/tests/.',
    patterns: 'Singleton managers; domain reference counting; ring buffer screenshot storage.',
    internalDeps: ['packages/shared', 'app/chrome-extension/common'],
    externalDeps: ['chrome-types']
  },

  'app/native-server': {
    title: 'native-server',
    purpose: 'Fastify-based Native Messaging bridge and Model Context Protocol (MCP) server connecting AI agents to Chrome via HTTP/SSE or Stdio IPC.',
    keyFiles: [
      { name: 'package.json', desc: 'Bridge package dependencies, build scripts, and bin links' },
      { name: 'tsconfig.json', desc: 'TypeScript compiler configuration for native server' },
      { name: 'jest.config.js', desc: 'Jest test runner configuration' },
      { name: 'README.md', desc: 'Server architecture and startup documentation' },
      { name: 'install.md', desc: 'Detailed host registration instructions' },
      { name: 'debug.sh', desc: 'Debug shell script for starting the host with inspector' }
    ],
    instructions: [
      'Hosts the Chrome Native Messaging host binary and Fastify server (127.0.0.1:12306).',
      'Provides Stdio MCP transport for Claude Code / Cursor / Windsurf and SSE transport for remote clients.',
      'Enforces token authentication and connection watchdogs to prevent orphaned Node processes.'
    ],
    testing: 'Run `pnpm --filter mcp-chrome-bridge test` (Jest suite).',
    patterns: 'Fastify HTTP/SSE; Native Messaging StdIO framing; MCP SDK integration.',
    internalDeps: ['packages/shared'],
    externalDeps: ['fastify', '@modelcontextprotocol/sdk', 'jest', 'commander']
  },

  'app/native-server/src': {
    title: 'src',
    purpose: 'Core source code for Native Messaging host, CLI commands, file handling, and trace analysis.',
    keyFiles: [
      { name: 'cli.ts', desc: 'CLI router parsing commands (start, register, doctor)' },
      { name: 'file-handler.ts', desc: 'Manages local file uploads and temporary downloads' },
      { name: 'index.ts', desc: 'Primary server bootstrap entry point' },
      { name: 'media-asset-store.ts', desc: 'Stores screenshots and video frames on disk or memory' },
      { name: 'native-messaging-host.ts', desc: 'StdIO Native Messaging host with 1MB chunk guard' },
      { name: 'trace-analyzer.ts', desc: 'Analyzes execution performance and bottlenecks' },
      { name: 'native-messaging-chunking.test.ts', desc: 'Tests for Native Messaging 1MB buffer chunking' }
    ],
    instructions: [
      'native-messaging-host.ts implements standard Chrome Native Messaging IPC with 1MB chunking guards.',
      'cli.ts parses command-line arguments for server, register, and doctor operations.'
    ],
    testing: 'Unit tests in jest.',
    patterns: 'StdIO buffer streaming with length-prefix decoding.',
    internalDeps: ['packages/shared', 'app/native-server/src/jev', 'app/native-server/src/mcp'],
    externalDeps: ['fastify', '@modelcontextprotocol/sdk']
  },

  'app/native-server/src/constant': {
    title: 'constant',
    purpose: 'Server-side configuration constants, port numbers, token file paths, and environment defaults.',
    keyFiles: [
      { name: 'index.ts', desc: 'Default server port (12306), token path, and configuration constants' }
    ],
    instructions: ['Maintain default ports (12306) and token file paths.'],
    testing: 'Verified via server startup tests.',
    patterns: 'Configuration constant exports.',
    internalDeps: [],
    externalDeps: []
  },

  'app/native-server/src/jev': {
    title: 'jev',
    purpose: 'Dual-brain Jev fast decision engine and heuristic evaluator powering autonomous goal pursuit (chrome_act_toward_goal).',
    keyFiles: [
      { name: 'index.ts', desc: 'Module export for Jev decision engines' },
      { name: 'fast-decision-engine.ts', desc: 'In-process rule engine resolving interactive steps in 200-400ms without LLM calls' },
      { name: 'fast-decision-engine.test.ts', desc: 'Unit tests for fast decision engine' },
      { name: 'heuristic-engine.ts', desc: 'Heuristic candidate scorer for DOM elements' },
      { name: 'heuristic-engine.test.ts', desc: 'Unit tests for heuristic scoring' },
      { name: 'jev-client.ts', desc: 'Client connector for external JEV evaluation service' },
      { name: 'jev-client.test.ts', desc: 'Unit tests for Jev client' },
      { name: 'types.ts', desc: 'Type definitions for Jev state, goals, and actions' }
    ],
    instructions: [
      'fast-decision-engine.ts executes rapid in-process heuristics (200-400ms) to resolve interactive steps without LLM roundtrips.',
      'jev-client.ts connects to external JEV evaluators when configured.'
    ],
    testing: 'Run jest tests: `pnpm test fast-decision-engine`.',
    patterns: 'Heuristic evaluation and decision graph traversal.',
    internalDeps: ['packages/shared'],
    externalDeps: []
  },

  'app/native-server/src/mcp': {
    title: 'mcp',
    purpose: 'MCP server implementations supporting Stdio and SSE transports, tool registration, and session management.',
    keyFiles: [
      { name: 'mcp-server-stdio.ts', desc: 'Stdio MCP transport server used by Claude Code and Cursor' },
      { name: 'mcp-server.ts', desc: 'SSE MCP transport server for remote network clients' },
      { name: 'register-tools.ts', desc: 'Registers tool schemas and implements dynamic tool activation' },
      { name: 'register-tools.test.ts', desc: 'Tests for tool registration and schema validation' },
      { name: 'session-manager.ts', desc: 'Tracks active MCP client sessions and tab affinity' },
      { name: 'stdio-config.json', desc: 'Template MCP configuration for client tools' }
    ],
    instructions: [
      'mcp-server-stdio.ts provides the primary stdio transport used by Claude Code and Cursor.',
      'register-tools.ts maps packages/shared/src/tools.ts schemas to MCP tool handlers.',
      'Supports dynamic profile layering and runtime tool exposure via chrome_tool_docs.'
    ],
    testing: 'Run jest tests in register-tools.test.ts.',
    patterns: 'MCP Server protocol handlers; session-affinity mapping.',
    internalDeps: ['packages/shared', 'app/native-server/src/server'],
    externalDeps: ['@modelcontextprotocol/sdk']
  },

  'app/native-server/src/scripts': {
    title: 'scripts',
    purpose: 'Host registration, manifest installation, and diagnostic doctor scripts for Chrome, Edge, and Brave across Windows, macOS, and Linux.',
    keyFiles: [
      { name: 'browser-config.ts', desc: 'OS-specific manifest file paths and registry key definitions' },
      { name: 'build.ts', desc: 'Build automation script bundling native-server' },
      { name: 'constant.ts', desc: 'Constants for registration scripts' },
      { name: 'doctor.ts', desc: 'Diagnostic health check tool verifying manifests, ports, and registry' },
      { name: 'postinstall-guard.js', desc: 'Safety guard preventing postinstall hangs' },
      { name: 'postinstall.ts', desc: 'Npm postinstall hook registering host automatically' },
      { name: 'register-dev.ts', desc: 'Registers development build manifest' },
      { name: 'register.ts', desc: 'Registers production build manifest in browser registry' },
      { name: 'report.ts', desc: 'Generates markdown diagnostic report' },
      { name: 'run_host.bat', desc: 'Windows batch file executing Node host' },
      { name: 'run_host.sh', desc: 'POSIX shell script executing Node host' },
      { name: 'utils.ts', desc: 'Helper functions for registry and file operations' }
    ],
    instructions: [
      'register.ts registers the native messaging host manifest in OS-specific registry/paths.',
      'doctor.ts diagnoses host installation, registry keys, extension IDs, and port availability.'
    ],
    testing: 'Test via `node dist/scripts/doctor.js`.',
    patterns: 'Cross-platform manifest registration (Windows Registry, macOS Application Support, Linux ~/.config).',
    internalDeps: ['packages/shared'],
    externalDeps: []
  },

  'app/native-server/src/server': {
    title: 'server',
    purpose: 'Fastify HTTP server providing REST endpoints, SSE streams, health checks, and token-based authentication.',
    keyFiles: [
      { name: 'index.ts', desc: 'Fastify server initialization, routes, and SSE endpoints' },
      { name: 'server.test.ts', desc: 'Integration tests for HTTP routes and auth' },
      { name: 'token.ts', desc: 'Token generator, file persister, and authentication validator' }
    ],
    instructions: [
      'Enforces token authentication via Authorization: Bearer <token>.',
      'Includes unreferenced hard exit watchdog to prevent zombie Node processes on Windows.'
    ],
    testing: 'Run jest tests in server.test.ts.',
    patterns: 'Fastify routes, SSE streaming, authentication hooks.',
    internalDeps: ['app/native-server/src/constant'],
    externalDeps: ['fastify']
  },

  'app/native-server/src/shims': {
    title: 'shims',
    purpose: 'Type shims for Chrome DevTools Protocol domains and frontend structures.',
    keyFiles: [
      { name: 'devtools.d.ts', desc: 'CDP protocol domain type shims' }
    ],
    instructions: ['TypeScript type definitions for CDP domains.'],
    testing: 'Verified during typecheck.',
    patterns: 'Ambient TypeScript declarations.',
    internalDeps: [],
    externalDeps: []
  },

  'app/native-server/src/types': {
    title: 'types',
    purpose: 'Type definitions for DevTools frontend and internal server protocol structures.',
    keyFiles: [
      { name: 'devtools-frontend.d.ts', desc: 'DevTools frontend interface definitions' }
    ],
    instructions: ['TypeScript interface definitions.'],
    testing: 'Verified during typecheck.',
    patterns: 'Type definitions.',
    internalDeps: [],
    externalDeps: []
  },

  'bin': {
    title: 'bin',
    purpose: 'Executable binary entry points for running BrowserPaw directly from the command line or global npx / npm execution.',
    keyFiles: [
      { name: 'browserpaw.cjs', desc: 'CommonJS CLI wrapper launching the native server or registration commands' }
    ],
    instructions: [
      'Keep browserpaw.cjs lightweight with minimal dependencies to ensure fast CLI startup.',
      'Ensure proper shebang (`#!/usr/bin/env node`) and executable file permissions.'
    ],
    testing: 'Verify execution via `node ./bin/browserpaw.cjs --help` or `node ./bin/browserpaw.cjs doctor`.',
    patterns: 'Command-line argument routing and delegation to app/native-server/dist/cli.js',
    internalDeps: ['app/native-server/dist/cli.js'],
    externalDeps: ['Node.js standard library (child_process, path, fs)']
  },

  'docs': {
    title: 'docs',
    purpose: 'Documentation vault containing technical architecture specifications, tool references, navigation maps, troubleshooting playbooks, and architectural reviews.',
    keyFiles: [
      { name: 'MAP.md', desc: 'Master navigation hub for repository topology, reading paths, and tool radars' },
      { name: 'ARCHITECTURE.md', desc: 'Comprehensive 3-tier architecture, IPC protocols, and design decisions' },
      { name: 'TOOLS.md', desc: 'Auto-generated reference for all 49 canonical tools and arguments' },
      { name: 'TROUBLESHOOTING.md', desc: 'Diagnostic checklists for connection issues, token mismatch, and CDP' },
      { name: 'TROUBLESHOOTING.zh-CN.md', desc: 'Chinese translation of troubleshooting playbook' },
      { name: 'CONTRIBUTING.md', desc: 'Guidelines for contributors covering workflows and PR protocols' },
      { name: 'mcp-cli-config.md', desc: 'MCP configuration snippets for various CLI environments' },
      { name: 'review-notes-boost.md', desc: 'Notes on performance and stability optimization phases' }
    ],
    instructions: [
      'Do not edit docs/TOOLS.md manually; regenerate it using `node scripts/gen-tools-doc.mjs`.',
      'Keep English and Chinese troubleshooting documentation in parity when resolving operational bugs.'
    ],
    testing: 'Verify markdown link validity and table formatting.',
    patterns: 'Bilingual documentation (English canonical, Chinese mirror); clear ASCII diagrams.',
    internalDeps: ['scripts/gen-tools-doc.mjs'],
    externalDeps: ['Markdown / GitHub-flavored markdown']
  },

  'docs/analysis': {
    title: 'analysis',
    purpose: 'Architectural analysis and comparative benchmark studies evaluating BrowserPaw against Playwright, Puppeteer, and browser-use.',
    keyFiles: [
      { name: 'browser-automation-deep-comparison-2026-09-22.md', desc: 'Comprehensive comparative report on browser automation architectures' }
    ],
    instructions: ['Maintains in-depth performance, security, and developer ergonomics analyses.'],
    testing: 'Documentation review.',
    patterns: 'Comparative technical analysis.',
    internalDeps: [],
    externalDeps: []
  },

  'docs/analysis/subagent-reports': {
    title: 'subagent-reports',
    purpose: 'Detailed research reports on JEV ultrafast engine, browser-use architecture, harness integration, and self-analysis.',
    keyFiles: [
      { name: 'appendix-A-jev-ultrafast.md', desc: 'Research report on JEV ultrafast decision engine' },
      { name: 'appendix-B-browser-use.md', desc: 'Architecture analysis of browser-use agent framework' },
      { name: 'appendix-C-browser-harness.md', desc: 'Browser automation test harness comparative review' },
      { name: 'appendix-D-mcp-chrome-self-analysis.md', desc: 'Self-audit and architectural gap analysis' }
    ],
    instructions: ['Archived findings and appendices from deep research runs.'],
    testing: 'Documentation review.',
    patterns: 'Research reports.',
    internalDeps: [],
    externalDeps: []
  },

  'docs/images': {
    title: 'images',
    purpose: 'Image assets, diagrams, and project logo for BrowserPaw documentation.',
    keyFiles: [
      { name: 'logo.png', desc: 'Official project logo graphic' }
    ],
    instructions: ['Contains logo.png and graphic assets.'],
    testing: 'Visual verification.',
    patterns: 'Static media.',
    internalDeps: [],
    externalDeps: []
  },

  'docs/review-2026-09': {
    title: 'review-2026-09',
    purpose: 'Architecture review and dependency graph documentation from the September 2026 audit.',
    keyFiles: [
      { name: 'dependency-graph.md', desc: 'Monorepo dependency graph and cross-package call paths' },
      { name: 'jev-capabilities.md', desc: 'Detailed capability assessment of JEV heuristic engine' }
    ],
    instructions: ['Archived review documentation.'],
    testing: 'Documentation review.',
    patterns: 'Review summaries and graphs.',
    internalDeps: [],
    externalDeps: []
  },

  'docs/review-2026-09/by-module': {
    title: 'by-module',
    purpose: 'Module-by-module audit reports covering extension tools, JEV engine, Native MCP bridge, scripts, and shared utils.',
    keyFiles: [
      { name: 'docs-inventory.md', desc: 'Comprehensive inventory of all documentation assets' },
      { name: 'extension-tools.md', desc: 'Audit of extension tool implementations and schemas' },
      { name: 'jev.md', desc: 'Deep dive into JEV engine logic and test adequacy' },
      { name: 'native-mcp.md', desc: 'Audit of native MCP bridge, stdio transport, and security' },
      { name: 'scripts-install.md', desc: 'Evaluation of installer scripts and registration reliability' },
      { name: 'shared-utils.md', desc: 'Review of shared coordinate, error formatting, and types' }
    ],
    instructions: ['Detailed per-module technical breakdown.'],
    testing: 'Documentation review.',
    patterns: 'Module reviews.',
    internalDeps: [],
    externalDeps: []
  },

  'docs/review-skill-2026-09': {
    title: 'review-skill-2026-09',
    purpose: 'Skill audit, tool contract verification, and core capability assessments from September 2026.',
    keyFiles: [
      { name: 'core-capabilities.md', desc: 'Assessment of core AI agent browser capabilities' },
      { name: 'jev-and-bridge.md', desc: 'Evaluation of JEV decision loop and bridge performance' },
      { name: 'readme-facts.md', desc: 'Fact-checking audit of claims made in README documents' },
      { name: 'skill-audit.md', desc: 'Evaluation of SKILL.md instructions, decision trees, and clarity' },
      { name: 'tool-contracts.md', desc: 'Rigorous contract audit of 49 tools against real code' }
    ],
    instructions: ['Verification records of tool contracts and skill compliance.'],
    testing: 'Documentation review.',
    patterns: 'Audit reports.',
    internalDeps: [],
    externalDeps: []
  },

  'packages': {
    title: 'packages',
    purpose: 'Container directory for shared libraries and common packages across the BrowserPaw monorepo.',
    keyFiles: [],
    instructions: [
      'Code in packages/ must remain environment-agnostic and free of DOM or Node-specific assumptions where possible.',
      'Always build packages/shared before building apps that depend on it.'
    ],
    testing: 'Run `pnpm --filter chrome-mcp-shared build` to verify type generation.',
    patterns: 'Exporting both TypeScript source and compiled definitions.',
    internalDeps: [],
    externalDeps: ['typescript']
  },

  'packages/shared': {
    title: 'shared',
    purpose: 'Single Source of Truth (SSOT) shared package defining canonical tool schemas, profile subsets, coordinate models, and standardized error formatting.',
    keyFiles: [
      { name: 'package.json', desc: 'Shared package configuration and build scripts' },
      { name: 'tsconfig.json', desc: 'TypeScript compiler configuration' }
    ],
    instructions: [
      'This package is imported by both app/chrome-extension and app/native-server.',
      'Keep code strictly platform-agnostic (no DOM or Node.js built-ins in shared types).'
    ],
    testing: 'Run `pnpm --filter chrome-mcp-shared build` to verify compilation.',
    patterns: 'TypeScript schema definitions; profile mapping; Ajv schema compliance.',
    internalDeps: [],
    externalDeps: ['typescript']
  },

  'packages/shared/src': {
    title: 'src',
    purpose: 'Source files for canonical 49 tool schemas, profile definitions (Core 14, Crawl 12, Full 49), coordinate types, error formatting, and version constants.',
    keyFiles: [
      { name: 'constants.ts', desc: 'Shared operational constants and magic numbers' },
      { name: 'coordinate.ts', desc: 'Coordinate model normalization supporting [x,y] and {x,y}' },
      { name: 'error-format.ts', desc: 'Standardized error response formatter with stack control' },
      { name: 'index.ts', desc: 'Barrel export for shared contracts and tools' },
      { name: 'tool-name-resolver.ts', desc: 'Resolves alias tool names to canonical implementations' },
      { name: 'tool-profiles.ts', desc: 'Tool subset definitions for Core (14), Crawl (12), and Full (49) profiles' },
      { name: 'tools.ts', desc: 'Canonical schema definitions for all 49 BrowserPaw tools' },
      { name: 'types.ts', desc: 'Universal coordinate, batch action, and diff payload interfaces' },
      { name: 'version.ts', desc: 'Single source of truth version constant' }
    ],
    instructions: [
      'tools.ts contains all 49 canonical tool schemas — any tool argument change must begin here.',
      'tool-profiles.ts defines the tool subsets for core, crawl, and full profiles.',
      'error-format.ts provides standardized error reporting with stack control.'
    ],
    testing: 'Run typecheck and consumer package tests.',
    patterns: 'Const assertions, JSON Schema compatible types, enum-like string literals.',
    internalDeps: [],
    externalDeps: []
  },

  'plugins': {
    title: 'plugins',
    purpose: 'Container directory for platform-specific plugin integrations such as Codex and Hermes.',
    keyFiles: [],
    instructions: [
      'Maintain compatibility with plugin manifest standards (plugin.yaml, .codex-plugin/plugin.json).',
      'Python bridge scripts must remain compatible with Python 3.9+.'
    ],
    testing: 'Run python tests in plugins/browserpaw/tests/ if Python is available.',
    patterns: 'Plugin manifest wrapping local MCP server connections.',
    internalDeps: ['skill'],
    externalDeps: ['Python 3.9+ (optional test environment)']
  },

  'plugins/browserpaw': {
    title: 'browserpaw',
    purpose: 'Plugin package integrating BrowserPaw with Codex and Hermes AI coding assistants.',
    keyFiles: [
      { name: 'plugin.yaml', desc: 'Plugin configuration manifest for agent platforms' },
      { name: 'core_schemas.json', desc: 'JSON schema definitions for plugin tool interfaces' },
      { name: 'README.md', desc: 'Plugin installation and usage documentation' },
      { name: '__init__.py', desc: 'Python package initialization module' }
    ],
    instructions: [
      'Encapsulates plugin manifests and Python test suites.',
      'Synchronized with root skill updates via scripts/sync-skills.mjs.'
    ],
    testing: 'Run Python test suites in tests/ if Python is configured.',
    patterns: 'Plugin manifest packaging wrapping local MCP server.',
    internalDeps: ['skill'],
    externalDeps: ['Python 3.9+']
  },

  'plugins/browserpaw/skills': {
    title: 'skills',
    purpose: 'Container for plugin-scoped agent skill distributions.',
    keyFiles: [],
    instructions: ['Holds the browserpaw plugin skill package.'],
    testing: 'Verify file synchronization.',
    patterns: 'Container directory.',
    internalDeps: ['skill'],
    externalDeps: []
  },

  'plugins/browserpaw/skills/browserpaw': {
    title: 'browserpaw',
    purpose: 'Plugin-adapted BrowserPaw skill package with browserpaw_ tool prefixes for Codex/Hermes compatibility.',
    keyFiles: [
      { name: 'SKILL.md', desc: 'Plugin-specific skill definition with browserpaw_ tool prefixes' }
    ],
    instructions: [
      'Mirrored automatically by scripts/sync-skills.mjs.',
      'Replaces chrome_ prefixes with browserpaw_ prefixes for plugin environments.'
    ],
    testing: 'Verify sync script output.',
    patterns: 'Prefix-adapted skill documentation.',
    internalDeps: ['skill'],
    externalDeps: []
  },

  'plugins/browserpaw/skills/browserpaw/config': {
    title: 'config',
    purpose: 'Plugin configuration templates, doctor script, and repair utilities.',
    keyFiles: [
      { name: 'doctor.mjs', desc: 'Automated diagnostic connectivity test script' },
      { name: 'mcp-config.json', desc: 'Sample MCP client configuration template' },
      { name: 'repair.bat', desc: 'Windows automated repair batch script' },
      { name: 'repair.ps1', desc: 'PowerShell automated repair script' },
      { name: 'TROUBLESHOOTING.md', desc: 'Plugin troubleshooting guide' },
      { name: 'TROUBLESHOOTING.zh-CN.md', desc: 'Chinese translation of plugin troubleshooting guide' }
    ],
    instructions: ['Mirrored from skill/config.'],
    testing: 'Verify file parity.',
    patterns: 'Configuration templates.',
    internalDeps: ['skill/config'],
    externalDeps: []
  },

  'plugins/browserpaw/skills/browserpaw/recipes': {
    title: 'recipes',
    purpose: 'Automation recipes and task templates for plugin users.',
    keyFiles: [
      { name: 'README.md', desc: 'Recipe catalog and index' },
      { name: 'template.md', desc: 'Workflow template for creating new recipes' }
    ],
    instructions: ['Mirrored from skill/recipes.'],
    testing: 'Verify file parity.',
    patterns: 'Recipe markdown templates.',
    internalDeps: ['skill/recipes'],
    externalDeps: []
  },

  'plugins/browserpaw/skills/browserpaw/references': {
    title: 'references',
    purpose: 'Reference documentation on batch pipelines, JEV dual-brain, tool cheat sheets, and visual fallback for plugin environments.',
    keyFiles: [
      { name: 'batch-pipeline.md', desc: 'Guide to batch action pipelines for zero-roundtrip execution' },
      { name: 'dual-brain-jev.md', desc: 'Architecture guide for high-speed local decision loops' },
      { name: 'tool-cheatsheet.md', desc: 'Quick reference cheatsheet of tools and usage patterns' },
      { name: 'visual-fallback.md', desc: 'Playbook for visual screenshot and coordinate fallbacks' }
    ],
    instructions: ['Mirrored from skill/references.'],
    testing: 'Verify file parity.',
    patterns: 'Technical references.',
    internalDeps: ['skill/references'],
    externalDeps: []
  },

  'plugins/browserpaw/tests': {
    title: 'tests',
    purpose: 'Python integration tests verifying bridge tokens, display integration, and MCP session management for the plugin.',
    keyFiles: [
      { name: 'test_bridge_token.py', desc: 'Verifies token generation and bearer token authentication' },
      { name: 'test_display_integration.py', desc: 'Tests visual overlay and display output compatibility' },
      { name: 'test_mcp_session.py', desc: 'Tests MCP session lifecycle and request forwarding' }
    ],
    instructions: ['Run with pytest in a Python 3.9+ environment.'],
    testing: '`pytest plugins/browserpaw/tests/`',
    patterns: 'Pytest test cases testing MCP client connections.',
    internalDeps: ['plugins/browserpaw'],
    externalDeps: ['pytest', 'requests']
  },

  'prompt': {
    title: 'prompt',
    purpose: 'Specialized prompt templates, LLM system instructions, and task prompts used for content analysis and web modifications.',
    keyFiles: [
      { name: 'content-analize.md', desc: 'Structured prompts for deep webpage and article content analysis' },
      { name: 'excalidraw-prompt.md', desc: 'Instructions for converting DOM or UI structures into Excalidraw diagrams' },
      { name: 'modify-web.md', desc: 'System instructions for guiding DOM manipulation and styling edits' }
    ],
    instructions: [
      'Prompt files should provide clear input/output schemas for the LLM to follow.',
      'Ensure prompt templates are tested across major LLM architectures (Claude, OpenAI, Gemini).'
    ],
    testing: 'Validate prompt clarity and variable interpolation syntax.',
    patterns: 'Markdown-formatted prompt roleplay with XML tags.',
    internalDeps: [],
    externalDeps: []
  },

  'releases': {
    title: 'releases',
    purpose: 'Distribution archive directory holding prebuilt zip files for the Chrome extension and skill packages.',
    keyFiles: [
      { name: 'README.md', desc: 'Release index describing packaged extension versions and installation steps' },
      { name: 'browserpaw-extension-latest.zip', desc: 'Latest prebuilt Chrome extension zip bundle' },
      { name: 'browserpaw-extension-v2.0.0.zip', desc: 'v2.0.0 packaged extension zip archive' },
      { name: 'browserpaw-extension-v3.1.0.zip', desc: 'v3.1.0 packaged extension zip archive' },
      { name: 'browserpaw-skill-latest.zip', desc: 'Latest prebuilt skill bundle' },
      { name: 'browserpaw-skill-v2.0.0.zip', desc: 'v2.0.0 packaged skill bundle' },
      { name: 'browserpaw-skill-v3.1.0.zip', desc: 'v3.1.0 packaged skill bundle' }
    ],
    instructions: [
      'Do not commit large temporary builds here; only tagged release packages are stored here.',
      'Ensure latest zip symlinks/copies point to the current release build.'
    ],
    testing: 'Verify zip archive integrity by unzipping in a clean directory.',
    patterns: 'Prebuilt clean production builds.',
    internalDeps: ['app/chrome-extension'],
    externalDeps: []
  },

  'releases/chrome-extension': {
    title: 'chrome-extension',
    purpose: 'Container directory for Chrome extension zip release distributions.',
    keyFiles: [],
    instructions: ['Holds versioned and latest extension zip packages.'],
    testing: 'Verify zip contents.',
    patterns: 'Release packaging.',
    internalDeps: ['app/chrome-extension'],
    externalDeps: []
  },

  'releases/chrome-extension/latest': {
    title: 'latest',
    purpose: 'Always-current packaged extension zip archive for direct download and installation.',
    keyFiles: [
      { name: 'browserpaw-extension-latest.zip', desc: 'Latest prebuilt Chrome extension zip archive' }
    ],
    instructions: ['Contains the latest browserpaw-extension-latest.zip archive.'],
    testing: 'Unpack test.',
    patterns: 'Release distribution.',
    internalDeps: [],
    externalDeps: []
  },

  'scripts': {
    title: 'scripts',
    purpose: 'Repository lifecycle, build automation, and documentation generation scripts.',
    keyFiles: [
      { name: 'clean.js', desc: 'Cross-platform directory cleaner for dist, build, and node_modules' },
      { name: 'gen-tools-doc.mjs', desc: 'Generator extracting parameter documentation from tools.ts into docs/TOOLS.md' },
      { name: 'generate-agents-docs.mjs', desc: 'Hierarchical AGENTS.md documentation generator for deepinit' },
      { name: 'sync-skills.mjs', desc: 'Synchronizes canonical skill/SKILL.md across all skill mirrors and plugin directories' },
      { name: 'validate-agents-docs.mjs', desc: 'Validator verifying hierarchical AGENTS.md parent links and required sections' }
    ],
    instructions: [
      'Whenever skill/SKILL.md or package tool schemas are updated, run `node scripts/sync-skills.mjs` and `node scripts/gen-tools-doc.mjs`.',
      'Use pure Node.js APIs (node:fs, node:path) to preserve cross-platform compatibility on Windows and POSIX.'
    ],
    testing: 'Test script execution: `node scripts/sync-skills.mjs` and `node scripts/gen-tools-doc.mjs`.',
    patterns: 'ES Modules with `node:` prefix; AST and source extraction for automated docs.',
    internalDeps: ['packages/shared/src/tools.ts', 'skill/SKILL.md'],
    externalDeps: ['node:fs', 'node:path', 'node:crypto']
  },

  'skill': {
    title: 'skill',
    purpose: 'Canonical AI Agent Skill package for BrowserPaw. Encodes execution ladders, prompt recipes, troubleshooting tools, and reference documentation for AI agents.',
    keyFiles: [
      { name: 'SKILL.md', desc: 'Canonical skill definition containing tool escalation ladders and decision trees' }
    ],
    instructions: [
      'This directory is the Single Source of Truth for skills. Never edit skills/browserpaw directly without syncing from here.',
      'After modifying SKILL.md, run `node scripts/sync-skills.mjs` to propagate changes to all mirrors.'
    ],
    testing: 'Verify schema names and tool arguments against packages/shared/src/tools.ts.',
    patterns: 'Tiered execution ladder: Tier 1 Micro-Loop -> Tier 0 Primitives -> Tier 2 Scripting -> Tier 3 Visual -> Tier 4 Human; anti-bot escalation.',
    internalDeps: ['scripts/sync-skills.mjs'],
    externalDeps: ['Claude Code / Agent Skill protocol']
  },

  'skill/config': {
    title: 'config',
    purpose: 'Configuration templates, diagnostic doctor script, and repair batch/PowerShell scripts for the BrowserPaw skill.',
    keyFiles: [
      { name: 'doctor.mjs', desc: 'Automated diagnostic connectivity test script' },
      { name: 'mcp-config.json', desc: 'Sample MCP client configuration template' },
      { name: 'repair.bat', desc: 'Windows automated repair batch script' },
      { name: 'repair.ps1', desc: 'PowerShell automated repair script' },
      { name: 'TROUBLESHOOTING.md', desc: 'Skill troubleshooting guide' },
      { name: 'TROUBLESHOOTING.zh-CN.md', desc: 'Chinese translation of skill troubleshooting guide' }
    ],
    instructions: [
      'doctor.mjs performs automated connectivity checks for MCP and native host.',
      'repair.bat / repair.ps1 restore registry entries and clean stale locks.'
    ],
    testing: 'Run `node skill/config/doctor.mjs`.',
    patterns: 'Cross-platform diagnostic and repair scripts.',
    internalDeps: [],
    externalDeps: ['node:fs', 'node:child_process']
  },

  'skill/recipes': {
    title: 'recipes',
    purpose: 'Pre-engineered workflow recipes providing end-to-end multi-step prompt patterns for common automation goals.',
    keyFiles: [
      { name: 'README.md', desc: 'Catalog of automation recipes' },
      { name: 'template.md', desc: 'Template for constructing new task recipes' }
    ],
    instructions: [
      'Recipes instruct agents on optimal tool sequencing for tasks like web extraction, login handling, and search.'
    ],
    testing: 'Manual evaluation with AI agents.',
    patterns: 'Task-specific procedural playbooks.',
    internalDeps: [],
    externalDeps: []
  },

  'skill/references': {
    title: 'references',
    purpose: 'Deep architectural references covering batch pipelines, dual-brain JEV architecture, tool cheatsheets, and visual fallback strategies.',
    keyFiles: [
      { name: 'batch-pipeline.md', desc: 'Comprehensive guide to chrome_batch_actions zero-roundtrip pipeline' },
      { name: 'dual-brain-jev.md', desc: 'Guide to dual-brain local decision loops and Jev heuristics' },
      { name: 'tool-cheatsheet.md', desc: 'Quick-reference guide for all 49 tools with sample calls' },
      { name: 'visual-fallback.md', desc: 'Guide for visual screenshot and coordinate fallbacks' }
    ],
    instructions: [
      'Consult batch-pipeline.md for constructing zero-roundtrip multi-action arrays.',
      'Consult dual-brain-jev.md for high-speed local decision loops.'
    ],
    testing: 'Documentation integrity checks.',
    patterns: 'Detailed reference specifications.',
    internalDeps: [],
    externalDeps: []
  },

  'skills': {
    title: 'skills',
    purpose: 'Mirror directory housing agent-compatible skill packages structured for external agent tooling and CLI skill discovery.',
    keyFiles: [],
    instructions: [
      'Files here are mirrored from skill/ by scripts/sync-skills.mjs.',
      'Do not make direct manual edits here; modify skill/ and run `pnpm sync-skills` or `node scripts/sync-skills.mjs`.'
    ],
    testing: 'Run `node scripts/sync-skills.mjs` to ensure synchronization.',
    patterns: 'Automated synchronization from canonical source.',
    internalDeps: ['skill'],
    externalDeps: []
  },

  'skills/browserpaw': {
    title: 'browserpaw',
    purpose: 'Mirrored skill directory structured for global user skill installations (~/.omc/skills/ or ~/.claude/skills/).',
    keyFiles: [
      { name: 'SKILL.md', desc: 'Mirrored skill definition file' }
    ],
    instructions: [
      'Mirrored automatically from skill/ by scripts/sync-skills.mjs.',
      'Do not edit manually.'
    ],
    testing: 'Run `node scripts/sync-skills.mjs`.',
    patterns: 'Mirrored skill package.',
    internalDeps: ['skill'],
    externalDeps: []
  },

  'skills/browserpaw/config': {
    title: 'config',
    purpose: 'Mirrored configuration utilities and doctor scripts for global skill installations.',
    keyFiles: [
      { name: 'doctor.mjs', desc: 'Automated diagnostic connectivity test script' },
      { name: 'mcp-config.json', desc: 'Sample MCP client configuration template' },
      { name: 'repair.bat', desc: 'Windows automated repair batch script' },
      { name: 'repair.ps1', desc: 'PowerShell automated repair script' },
      { name: 'TROUBLESHOOTING.md', desc: 'Troubleshooting documentation' },
      { name: 'TROUBLESHOOTING.zh-CN.md', desc: 'Chinese translation of troubleshooting documentation' }
    ],
    instructions: ['Mirrored from skill/config.'],
    testing: 'Verify sync script output.',
    patterns: 'Configuration scripts.',
    internalDeps: ['skill/config'],
    externalDeps: []
  },

  'skills/browserpaw/recipes': {
    title: 'recipes',
    purpose: 'Mirrored automation recipes for global skill installations.',
    keyFiles: [
      { name: 'README.md', desc: 'Recipe index' },
      { name: 'template.md', desc: 'Recipe authoring template' }
    ],
    instructions: ['Mirrored from skill/recipes.'],
    testing: 'Verify sync script output.',
    patterns: 'Task recipes.',
    internalDeps: ['skill/recipes'],
    externalDeps: []
  },

  'skills/browserpaw/references': {
    title: 'references',
    purpose: 'Mirrored technical references for global skill installations.',
    keyFiles: [
      { name: 'batch-pipeline.md', desc: 'Batch action pipeline reference' },
      { name: 'dual-brain-jev.md', desc: 'Dual-brain JEV architecture reference' },
      { name: 'tool-cheatsheet.md', desc: 'Tool quick reference cheatsheet' },
      { name: 'visual-fallback.md', desc: 'Visual fallback reference' }
    ],
    instructions: ['Mirrored from skill/references.'],
    testing: 'Verify sync script output.',
    patterns: 'Reference documentation.',
    internalDeps: ['skill/references'],
    externalDeps: []
  },

  'test': {
    title: 'test',
    purpose: 'Root directory for integration and end-to-end testing suites, mock servers, stress tests, and automated browser verification harnesses.',
    keyFiles: [
      { name: 'BROWSERPAW_MANUAL.md', desc: 'Manual testing checklist and verification guide' },
      { name: 'BROWSERPAW_MANUAL.zh-CN.md', desc: 'Chinese manual testing checklist and verification guide' },
      { name: 'GAUNTLET_PLAYBOOK.md', desc: 'Adversarial edge-case testing gauntlet instructions' },
      { name: 'boost-features.test.ts', desc: 'Integration test suite for boost features and optimizations' },
      { name: 'boost-phase1-phase4.test.ts', desc: 'Phased regression verification tests' },
      { name: 'p0-p1-hardening.test.ts', desc: 'Hardening test suite for critical P0/P1 capabilities' },
      { name: 'visual-drift-optimization.test.ts', desc: 'Visual cursor drift and coordinate alignment tests' },
      { name: 'mcp-client.mjs', desc: 'Stand-alone MCP test client utility' },
      { name: 'mcp-runner.mjs', desc: 'MCP test execution runner' },
      { name: 'run-test.mjs', desc: 'Ad-hoc test runner' },
      { name: 'inspect-shadow.mjs', desc: 'Shadow DOM inspector test script' },
      { name: 'p09-canvas-hit.mjs', desc: 'Canvas element hit-testing script' },
      { name: 'rd.mjs', desc: 'DOM read utility test script' },
      { name: 'test-shadow-by-index.mjs', desc: 'Tests Shadow DOM element selection by index' },
      { name: 'verify-debrief.mjs', desc: 'Debrief verification tester' }
    ],
    instructions: [
      'Do not rely on live Chrome instances for automated CI tests; use mocks provided in test/e2e/mocks/.',
      'Follow the 4-tier testing hierarchy defined in TEST_INFRA.md.'
    ],
    testing: 'Run `node --experimental-strip-types test/e2e/runner.ts` to execute the full E2E suite.',
    patterns: 'Mock MCP server and CDP event emitter mocks; oracle evaluators verifying action outcomes against ground truth.',
    internalDeps: ['packages/shared', 'app/native-server'],
    externalDeps: ['Node.js test runner / TypeScript strip-types']
  },

  'test/complex-html-testing': {
    title: 'complex-html-testing',
    purpose: 'Stand-alone Vite + React application providing 12 interactive DOM challenge pages (Shadow DOM, dynamic iframes, canvas, modals, drag-and-drop, virtualization) for manual and automated agent testing.',
    keyFiles: [
      { name: 'package.json', desc: 'Challenge testbed dependencies and scripts' },
      { name: 'vite.config.ts', desc: 'Vite build configuration for testbed' },
      { name: 'tsconfig.json', desc: 'TypeScript configuration for testbed' },
      { name: 'index.html', desc: 'HTML entry point for React application' },
      { name: 'serve.mjs', desc: 'Static challenge server runner' }
    ],
    instructions: [
      'Run `pnpm dev` inside this directory to start the challenge server on localhost:5173.',
      'Use this app to verify tool perception and action accuracy on complex modern web UIs.'
    ],
    testing: 'Interactive verification via browser.',
    patterns: 'React 18 interactive challenge components with scoreboards.',
    internalDeps: [],
    externalDeps: ['vite', 'react', 'react-dom']
  },

  'test/complex-html-testing/public': {
    title: 'public',
    purpose: 'Static assets for the complex HTML testbed application.',
    keyFiles: [],
    instructions: ['Static image assets.'],
    testing: 'Asset presence check.',
    patterns: 'Static web assets.',
    internalDeps: [],
    externalDeps: []
  },

  'test/complex-html-testing/public/images': {
    title: 'images',
    purpose: 'Challenge images (animals, buildings, vehicles) used in visual matching and canvas challenges.',
    keyFiles: [
      { name: 'hero.jpg', desc: 'Hero background image' },
      { name: 'q-bldg.jpg', desc: 'Building challenge sample image' },
      { name: 'q-car1.jpg', desc: 'Car 1 challenge sample image' },
      { name: 'q-car2.jpg', desc: 'Car 2 challenge sample image' },
      { name: 'q-cat1.jpg', desc: 'Cat 1 challenge sample image' },
      { name: 'q-cat2.jpg', desc: 'Cat 2 challenge sample image' },
      { name: 'q-dog1.jpg', desc: 'Dog 1 challenge sample image' }
    ],
    instructions: ['Images used for visual verification tasks.'],
    testing: 'Visual inspection.',
    patterns: 'JPEG images.',
    internalDeps: [],
    externalDeps: []
  },

  'test/complex-html-testing/src': {
    title: 'src',
    purpose: 'Source code for the React testbed app including router, state store, and challenge containers.',
    keyFiles: [
      { name: 'App.tsx', desc: 'Root component with challenge layout, navigation, and live score' },
      { name: 'main.tsx', desc: 'React entrypoint rendering App into the DOM' },
      { name: 'index.css', desc: 'Global stylesheet with Tailwind utility classes' }
    ],
    instructions: ['Main entry point and challenge view routing.'],
    testing: 'Vite build verification.',
    patterns: 'React components and custom routing.',
    internalDeps: [],
    externalDeps: ['react']
  },

  'test/complex-html-testing/src/challenges': {
    title: 'challenges',
    purpose: '12 distinct challenge modules testing clicks, shadow DOM, forms, timing, scroll, keyboard, drag, modals, visual layout, state updates, CSS grid, and omega integration.',
    keyFiles: [
      { name: 'C01Click.tsx', desc: 'Challenge 01: Click accuracy and event listeners' },
      { name: 'C02Shadow.tsx', desc: 'Challenge 02: Open and closed Shadow DOM traversal' },
      { name: 'C03Form.tsx', desc: 'Challenge 03: Complex form inputs, selects, and textareas' },
      { name: 'C04Timing.tsx', desc: 'Challenge 04: Dynamic timing, debounce, and delayed elements' },
      { name: 'C05Scroll.tsx', desc: 'Challenge 05: Infinite scroll and virtualized feeds' },
      { name: 'C06Keyboard.tsx', desc: 'Challenge 06: Keyboard shortcuts and hotkey combos' },
      { name: 'C07Drag.tsx', desc: 'Challenge 07: HTML5 drag-and-drop actions' },
      { name: 'C08Modal.tsx', desc: 'Challenge 08: Modal dialogs and backdrop traps' },
      { name: 'C09Visual.tsx', desc: 'Challenge 09: Canvas rendering and visual element location' },
      { name: 'C10State.tsx', desc: 'Challenge 10: Asynchronous state updates' },
      { name: 'C11Grid.tsx', desc: 'Challenge 11: Complex CSS Grid and Flexbox alignment' },
      { name: 'C12Omega.tsx', desc: 'Challenge 12: Omega multi-step combined challenge' },
      { name: 'index.ts', desc: 'Barrel export for all 12 challenge components' }
    ],
    instructions: [
      'Each challenge tests a specific browser automation difficulty.'
    ],
    testing: 'Interactive browser verification.',
    patterns: 'Self-scoring React challenge components.',
    internalDeps: [],
    externalDeps: ['react']
  },

  'test/complex-html-testing/src/components': {
    title: 'components',
    purpose: 'Reusable UI primitives (buttons, inputs, cards, shells) for the challenge application.',
    keyFiles: [
      { name: 'Shell.tsx', desc: 'Layout shell providing sidebar and top navigation' },
      { name: 'ui.tsx', desc: 'Button, card, badge, and input UI primitives' }
    ],
    instructions: ['Shared UI building blocks.'],
    testing: 'React rendering.',
    patterns: 'Component library primitives.',
    internalDeps: [],
    externalDeps: ['react']
  },

  'test/complex-html-testing/src/lib': {
    title: 'lib',
    purpose: 'Challenge protocol hooks, router utilities, and testbed session stores.',
    keyFiles: [
      { name: 'router.ts', desc: 'Lightweight hash-based routing utility' },
      { name: 'session.ts', desc: 'Session manager tracking challenge completions' },
      { name: 'store.tsx', desc: 'React context store holding overall score and challenge state' },
      { name: 'useProtocol.ts', desc: 'Hook recording automated agent interaction events' }
    ],
    instructions: ['Protocol tracking for automation test runs.'],
    testing: 'Typecheck and component tests.',
    patterns: 'Custom React hooks and lightweight state store.',
    internalDeps: [],
    externalDeps: []
  },

  'test/complex-html-testing/src/pages': {
    title: 'pages',
    purpose: 'Challenge home page and debrief results dashboard.',
    keyFiles: [
      { name: 'Home.tsx', desc: 'Landing page listing all 12 challenges and difficulty rankings' },
      { name: 'Debrief.tsx', desc: 'Results debrief page showing detailed score summary and logs' }
    ],
    instructions: ['Home overview and debrief evaluation pages.'],
    testing: 'Vite app navigation.',
    patterns: 'Page-level React components.',
    internalDeps: [],
    externalDeps: []
  },

  'test/complex-html-testing/src/utils': {
    title: 'utils',
    purpose: 'Utility functions such as clsx / tailwind-merge class helpers for the challenge app.',
    keyFiles: [
      { name: 'cn.ts', desc: 'Class name merger combining clsx and tailwind-merge' }
    ],
    instructions: ['CSS class concatenation helpers.'],
    testing: 'Verified via build.',
    patterns: 'Utility functions.',
    internalDeps: [],
    externalDeps: []
  },

  'test/e2e': {
    title: 'e2e',
    purpose: 'End-to-End test suite orchestrator and test runner verifying complete client-to-browser automation pipelines.',
    keyFiles: [
      { name: 'runner.ts', desc: 'Master test runner orchestrating Tier 1-4 test execution and result reporting' }
    ],
    instructions: [
      'runner.ts executes test tiers with mock server and CDP harnesses.',
      'Run without a live Chrome instance using `node --experimental-strip-types test/e2e/runner.ts`.'
    ],
    testing: 'Run `pnpm test`.',
    patterns: 'Tiered test runner with reporting.',
    internalDeps: ['test/e2e/fixtures', 'test/e2e/mocks', 'packages/shared'],
    externalDeps: ['node:test', 'node:assert']
  },

  'test/e2e/fixtures': {
    title: 'fixtures',
    purpose: 'Static DOM samples, mock server definitions, oracle evaluators, and standardized tool input fixtures.',
    keyFiles: [
      { name: 'dom-samples.ts', desc: 'Predefined DOM sample trees representing complex webpages' },
      { name: 'mock-server.ts', desc: 'In-memory HTTP mock server simulating web applications' },
      { name: 'oracle-evaluators.ts', desc: 'Ground-truth oracle validators asserting correct action outcomes' },
      { name: 'tool-inputs.ts', desc: 'Standardized tool input payloads for test runs' }
    ],
    instructions: [
      'Provides reproducible DOM structures and mock server responses for E2E tests.'
    ],
    testing: 'Used across tier 1-4 tests.',
    patterns: 'Test fixture factories and ground-truth oracle validators.',
    internalDeps: [],
    externalDeps: []
  },

  'test/e2e/mocks': {
    title: 'mocks',
    purpose: 'High-fidelity mock implementations of CDP protocol, Chrome extension runtime, MCP server, and batch pipelines.',
    keyFiles: [
      { name: 'mock-batch-pipeline.ts', desc: 'Mock executor for chrome_batch_actions pipeline' },
      { name: 'mock-cdp.ts', desc: 'Mock Chrome DevTools Protocol session and event dispatcher' },
      { name: 'mock-dom-engine.ts', desc: 'Mock in-page DOM indexing engine' },
      { name: 'mock-extension.ts', desc: 'Mock Chrome extension runtime message router' },
      { name: 'mock-mcp-server.ts', desc: 'Mock MCP server handling tool call requests' }
    ],
    instructions: [
      'Allows running full E2E test suite hermetically in CI without physical Chrome instances.'
    ],
    testing: 'Used by test runner.',
    patterns: 'In-memory protocol mocks and event emitters.',
    internalDeps: ['packages/shared'],
    externalDeps: []
  },

  'test/e2e/tier1-feature-coverage': {
    title: 'tier1-feature-coverage',
    purpose: 'Tier 1 E2E tests verifying fundamental feature coverage across all 13 core capabilities (concurrency, headers, Stdio, handshake, security, uploads, indexing, pruning, batch pipelines, markdown, build, tests, adversarial).',
    keyFiles: [
      { name: 'f01-multi-client-concurrency.test.ts', desc: 'Verifies concurrent multi-client requests and session isolation' },
      { name: 'f02-http-headers-sent.test.ts', desc: 'Verifies HTTP headers and auth token validation' },
      { name: 'f03-stdio-termination.test.ts', desc: 'Verifies clean Stdio transport shutdown without zombies' },
      { name: 'f04-extension-handshake.test.ts', desc: 'Verifies extension connection handshake and version check' },
      { name: 'f05-tool-security-annotations.test.ts', desc: 'Verifies read-only vs mutating tool security annotations' },
      { name: 'f06-file-upload-protocol.test.ts', desc: 'Verifies CDP file upload protocol integration' },
      { name: 'f07-index-interaction.test.ts', desc: 'Verifies indexed clicks, fills, and hover interactions' },
      { name: 'f08-dom-pruning-visibility.test.ts', desc: 'Verifies DOM tree pruning and viewport-only filtering' },
      { name: 'f09-batch-actions-pipeline.test.ts', desc: 'Verifies batch pipeline atomicity and failure handling' },
      { name: 'f10-markdown-visual-boxes.test.ts', desc: 'Verifies markdown conversion with visual bounding boxes' },
      { name: 'f11-build-typecheck.test.ts', desc: 'Verifies build artifacts and type safety' },
      { name: 'f12-automated-tests.test.ts', desc: 'Automated test suite regression test' },
      { name: 'f13-acceptance-adversarial.test.ts', desc: 'Adversarial acceptance test under high load' }
    ],
    instructions: [
      'All tests in this tier must pass 100% before committing.'
    ],
    testing: 'Included in `pnpm test`.',
    patterns: 'Feature-specific contract tests.',
    internalDeps: ['test/e2e/mocks', 'test/e2e/fixtures'],
    externalDeps: []
  },

  'test/e2e/tier2-boundary-corner': {
    title: 'tier2-boundary-corner',
    purpose: 'Tier 2 E2E tests focusing on boundary conditions, edge cases, buffer limits, malformed inputs, and disconnect handling.',
    keyFiles: [
      { name: 'f01-multi-client-boundary.test.ts', desc: 'Client limit boundaries and connection pool exhaustion' },
      { name: 'f02-http-headers-boundary.test.ts', desc: 'Malformed or oversized headers boundary tests' },
      { name: 'f03-stdio-termination-boundary.test.ts', desc: 'Abrupt process termination and pipe break handling' },
      { name: 'f04-extension-handshake-boundary.test.ts', desc: 'Handshake timeout and version mismatch boundaries' },
      { name: 'f05-tool-annotations-boundary.test.ts', desc: 'Boundary testing of tool schema edge cases' },
      { name: 'f06-file-upload-boundary.test.ts', desc: 'Large file and missing path upload boundaries' },
      { name: 'f07-index-interaction-boundary.test.ts', desc: 'Out-of-range index and detached element boundaries' },
      { name: 'f08-dom-pruning-boundary.test.ts', desc: 'Deeply nested DOM and shadow DOM pruning boundaries' },
      { name: 'f09-batch-actions-boundary.test.ts', desc: 'Max pipeline length and mid-pipeline error boundaries' },
      { name: 'f10-markdown-boxes-boundary.test.ts', desc: 'Empty page and circular DOM markdown boundaries' },
      { name: 'f11-build-typecheck-boundary.test.ts', desc: 'Typecheck edge cases' },
      { name: 'f12-automated-tests-boundary.test.ts', desc: 'Automated test boundary checks' },
      { name: 'f13-acceptance-adversarial-boundary.test.ts', desc: 'Adversarial boundary stress tests' }
    ],
    instructions: [
      'Validates system resilience against pathological inputs and network edge conditions.'
    ],
    testing: 'Included in `pnpm test`.',
    patterns: 'Adversarial input testing and error boundary checks.',
    internalDeps: ['test/e2e/mocks', 'test/e2e/fixtures'],
    externalDeps: []
  },

  'test/e2e/tier3-pairwise-combinations': {
    title: 'tier3-pairwise-combinations',
    purpose: 'Tier 3 E2E tests evaluating combinatorial pairwise interactions between features (e.g. batch actions + network capture + multi-tab affinity).',
    keyFiles: [
      { name: 'cross-feature-combinations.test.ts', desc: 'Evaluates pairwise feature combinations for race conditions and state leakage' }
    ],
    instructions: [
      'Ensures orthogonal features do not introduce race conditions or state pollution when combined.'
    ],
    testing: 'Included in `pnpm test`.',
    patterns: 'Combinatorial matrix testing.',
    internalDeps: ['test/e2e/mocks'],
    externalDeps: []
  },

  'test/e2e/tier4-real-world-scenarios': {
    title: 'tier4-real-world-scenarios',
    purpose: 'Tier 4 E2E tests simulating end-to-end real-world browser automation scenarios (form wizards, shopping checkouts, dashboard navigation).',
    keyFiles: [
      { name: 'application-scenarios.test.ts', desc: 'Simulates complete multi-step real-world automation tasks' }
    ],
    instructions: [
      'Validates multi-step agent workflows from start to finish.'
    ],
    testing: 'Included in `pnpm test`.',
    patterns: 'Scenario-based workflow validation.',
    internalDeps: ['test/e2e/mocks', 'test/e2e/fixtures'],
    externalDeps: []
  },

  'test/manual': {
    title: 'manual',
    purpose: 'Manual live testing scripts and client tools for testing BrowserPaw against real browser instances.',
    keyFiles: [
      { name: 'live-verify-html.mjs', desc: 'Tests live MCP bridge with HTML fixtures' },
      { name: 'live-verify.mjs', desc: 'Tests live MCP bridge connection and tools against active Chrome' },
      { name: 'mcp-http-client.mjs', desc: 'HTTP client for manual MCP endpoint testing' },
      { name: 'reload-extension.mjs', desc: 'Triggers extension reload via management API' },
      { name: 'test-agent-switch.mjs', desc: 'Tests quick switching between agent automation and user input' }
    ],
    instructions: [
      'live-verify.mjs and live-verify-html.mjs test live MCP bridge connections against real Chrome.',
      'test-agent-switch.mjs tests fast switching between automation and manual user control.'
    ],
    testing: 'Run ad-hoc: `node test/manual/live-verify.mjs`.',
    patterns: 'Ad-hoc verification scripts.',
    internalDeps: ['app/native-server'],
    externalDeps: ['Node.js']
  },

  'test/manual/fixtures': {
    title: 'fixtures',
    purpose: 'HTML test files (simple-page.html, multi-frame-page.html) for manual browser verification and cross-frame testing.',
    keyFiles: [
      { name: 'multi-frame-page.html', desc: 'Nested cross-origin iframe test page' },
      { name: 'simple-page.html', desc: 'Simple test page with basic form inputs and buttons' }
    ],
    instructions: ['Load in browser to test iframe penetration and multi-frame scanning.'],
    testing: 'Manual browser inspection.',
    patterns: 'Static HTML fixtures with nested iframes.',
    internalDeps: [],
    externalDeps: []
  }
};

// Scan non-dot directories
function scanDirectories(baseDir) {
  const dirs = [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Strictly skip hidden dirs and build output
    if (entry.name.startsWith('.')) continue;
    if (['node_modules', 'dist', 'build', '.output', '__pycache__', '.wxt', '__mocks__'].includes(entry.name)) continue;

    const fullPath = path.join(baseDir, entry.name);
    const relPath = path.relative('.', fullPath).replace(/\\/g, '/');
    dirs.push(relPath);
    dirs.push(...scanDirectories(fullPath));
  }
  return dirs;
}

const allDirs = ['.', ...scanDirectories('.').sort()];
console.log(`Discovered ${allDirs.length} clean directories for AGENTS.md generation.`);

function generateAgentsMd(dirPath) {
  const isRoot = dirPath === '.';
  const dirName = isRoot ? 'browserpaw' : path.basename(dirPath);
  const meta = METADATA[dirPath] || {
    title: dirName,
    purpose: `Directory for ${dirName} components and modules.`,
    instructions: ['Maintain clean modular code and verify changes.'],
    testing: 'Run applicable package or repository test suite.',
    patterns: 'Standard project coding conventions.',
    internalDeps: [],
    externalDeps: []
  };

  // Inspect physical directory contents
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && e.name !== 'AGENTS.md' && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort();

  const subdirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'dist', 'build', '.output', '__pycache__', '.wxt', '__mocks__'].includes(e.name))
    .map(e => e.name)
    .sort();

  let parentContext = '';
  if (!isRoot) {
    parentContext = `**Parent context:** \`../AGENTS.md\`\n`;
  }

  let content = `# ${meta.title}\n\n`;
  if (parentContext) {
    content += parentContext;
  }
  content += `**Generated:** ${GENERATED_DATE} · **Updated:** ${GENERATED_DATE}\n\n`;
  content += `## Purpose\n${meta.purpose}\n\n`;

  // Key Files
  content += `## Key Files\n`;
  if (files.length === 0) {
    content += `*No direct files in this directory (container directory).*\n\n`;
  } else {
    content += `| File | Description |\n|------|-------------|\n`;
    for (const f of files) {
      const knownFile = meta.keyFiles?.find(kf => kf.name === f);
      const desc = knownFile ? knownFile.desc : `Implementation file for ${f}`;
      content += `| \`${f}\` | ${desc} |\n`;
    }
    content += `\n`;
  }

  // Subdirectories
  content += `## Subdirectories\n`;
  if (subdirs.length === 0) {
    content += `*No subdirectories.*\n\n`;
  } else {
    content += `| Directory | Purpose |\n|-----------|---------|\n`;
    for (const s of subdirs) {
      const childRelPath = (isRoot ? s : `${dirPath}/${s}`).replace(/\\/g, '/');
      const childMeta = METADATA[childRelPath];
      const desc = childMeta ? childMeta.purpose.slice(0, 90).replace(/\n/g, ' ') + '...' : `Module directory (see \`${s}/AGENTS.md\`)`;
      content += `| \`${s}/\` | ${desc} |\n`;
    }
    content += `\n`;
  }

  // For AI Agents
  content += `## For AI Agents\n\n`;
  content += `### Working In This Directory\n`;
  const instructions = meta.instructions && meta.instructions.length > 0
    ? meta.instructions
    : ['Follow existing code conventions and maintain type safety.'];
  for (const inst of instructions) {
    content += `- ${inst}\n`;
  }
  content += `\n`;

  content += `### Testing Requirements\n`;
  content += `${meta.testing || 'Run repository test suite before committing.'}\n\n`;

  content += `### Common Patterns\n`;
  content += `${meta.patterns || 'Standard TypeScript/ESM patterns.'}\n\n`;

  // Dependencies
  content += `## Dependencies\n\n`;
  content += `### Internal\n`;
  if (meta.internalDeps && meta.internalDeps.length > 0) {
    for (const dep of meta.internalDeps) {
      content += `- \`${dep}\`\n`;
    }
  } else {
    content += `*None (leaf or self-contained module).*\n`;
  }
  content += `\n`;

  content += `### External\n`;
  if (meta.externalDeps && meta.externalDeps.length > 0) {
    for (const dep of meta.externalDeps) {
      content += `- \`${dep}\`\n`;
    }
  } else {
    content += `*Standard Node.js / Web Platform APIs.*\n`;
  }
  content += `\n`;

  // Manual Notes
  content += `## Manual Notes\n\nNotes under this heading are written by humans and preserved on regeneration.\n`;

  return content;
}

// Order directories by level (number of slashes)
const sortedDirs = allDirs.sort((a, b) => {
  const depthA = a === '.' ? 0 : a.split('/').length;
  const depthB = b === '.' ? 0 : b.split('/').length;
  if (depthA !== depthB) return depthA - depthB;
  return a.localeCompare(b);
});

console.log(`Generating AGENTS.md across ${sortedDirs.length} directories in hierarchical order...`);

let writtenCount = 0;
for (const dir of sortedDirs) {
  const targetPath = path.join(dir, 'AGENTS.md');
  const markdown = generateAgentsMd(dir);
  fs.writeFileSync(targetPath, markdown, 'utf-8');
  writtenCount++;
}

console.log(`Successfully generated and wrote ${writtenCount} AGENTS.md files.`);
