import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const GENERATED_DATE = new Date().toLocaleDateString('en-CA');

// Only committed files are documented; local scratch output (logs, zips, ignored config) must not
// leak into the generated Key Files tables.
const trackedFiles = new Set(
  execSync('git ls-files -z --cached --others --exclude-standard')
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, '/')),
);

// Directory metadata catalog providing domain-specific intelligence for each directory
const METADATA = {
  '.': {
    title: 'browserpaw',
    purpose:
      'Root of BrowserPaw, a v5 Chrome browser automation CLI, Native Messaging host, MV3 extension, and Agent Skill monorepo. It connects agents to an existing Chrome session over an authenticated local loopback bridge (`127.0.0.1`). See [PROJECT.md](PROJECT.md), [SECURITY.md](SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/QUALITY.md](docs/QUALITY.md), and [docs/development/DEVELOPMENT.md](docs/development/DEVELOPMENT.md).',
    keyFiles: [
      {
        name: 'package.json',
        desc: 'Monorepo root scripts, dependencies, workspaces, and metadata',
      },
      {
        name: 'pnpm-workspace.yaml',
        desc: 'PNPM workspace definition configuring packages and apps',
      },
      {
        name: 'README.md',
        desc: 'Project overview, quick start, architecture highlights, and setup guide',
      },
      { name: 'README.zh-CN.md', desc: 'Simplified Chinese translation of the repository README' },
      {
        name: 'PROJECT.md',
        desc: 'Engineering specifications, quality gates, and architecture summaries',
      },
      {
        name: 'PROJECT.zh-CN.md',
        desc: 'Simplified Chinese translation of the engineering project specification',
      },
      {
        name: 'CONTRIBUTING.md',
        desc: 'Entry pointer to docs/CONTRIBUTING.md, quality gates, and release workflow',
      },
      {
        name: 'INSTALL.md',
        desc: 'Installation and upgrade instructions for the CLI, Native host, extension, and plugins',
      },
      {
        name: 'SECURITY.md',
        desc: 'Security policy, trust model, enforced invariants, and vulnerability reporting',
      },
      {
        name: 'PRIVACY.md',
        desc: 'Privacy notice detailing data locality and local-only processing guarantees',
      },
      {
        name: 'CHANGELOG.md',
        desc: 'Concise pointer to the centralized release archive in docs/releases/',
      },
      {
        name: 'LICENSE',
        desc: 'GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)',
      },
      {
        name: 'NOTICE',
        desc: 'Legal notices and third-party software attributions',
      },
      {
        name: 'commitlint.config.cjs',
        desc: 'Conventional commits enforcement rules for git commit messages',
      },
      {
        name: 'eslint.config.js',
        desc: 'Global ESLint 9 flat configuration across TypeScript and Vue files',
      },
      { name: 'pnpm-lock.yaml', desc: 'Pinned dependency tree lockfile' },
    ],
    instructions: [
      'This is a pnpm monorepo (Node >=22.6, pnpm pinned in package.json). Run workspace tasks with pnpm.',
      'Use packages/shared/src/commands.ts as the single source of truth for CLI syntax and help; keep Native dispatchers and generated docs/COMMANDS.md (`pnpm docs:commands`) in sync.',
      'Keep packages/shared/src/tools.ts synchronized with extension tool executors, and edit the canonical skill in skills/browserpaw/ before running `node scripts/sync-skills.mjs`.',
      'Native v5 builds output to app/native-server/dist/v5. Do not edit generated outputs in dist/, .output/, .wxt/, or machine-written verification reports.',
      'Follow Conventional Commits enforced by commitlint.',
    ],
    testing:
      'Run focused tests while iterating, and `pnpm verify` + `pnpm release:check` on the final candidate. For live browser E2E, run `pnpm test:e2e` with `BROWSERPAW_TEST_CHROME` pointing to Chrome for Testing. `pnpm verify`, `pnpm build`, and `pnpm build:extension` never deploy outside the repository; authorized local Chrome deployment uses `pnpm build:deploy`, `pnpm verify:delivery`, manual extension reload in `chrome://extensions`, and live `buildId` verification via `browserpaw status` or `browserpaw doctor`.',
    patterns:
      'Shared CLI command and tool registry; authenticated loopback Native Messaging host (`com.browserpaw.nativehost`); MV3 extension executors; canonical skill mirror synchronization.',
    internalDeps: ['packages/shared'],
    externalDeps: ['pnpm', 'typescript', 'eslint', 'prettier', 'husky'],
  },

  app: {
    title: 'app',
    purpose:
      'Container directory hosting the two primary executable applications: the Chrome MV3 extension connector and the Native Messaging CLI/host bridge.',
    keyFiles: [],
    instructions: [
      'Coordinate IPC protocol changes between chrome-extension and native-server simultaneously.',
      'Respect the 1MB Native Messaging ceiling across all IPC boundaries: Chrome caps Host-to-Extension messages at 1MB, and the native host defensively mirrors that same 1MB limit on stdin/stdout.',
    ],
    testing:
      'Test both packages: `pnpm --filter chrome-mcp-server test` and `pnpm --filter browserpaw test`.',
    patterns: 'Native Messaging StdIO framing (4-byte length header + JSON payload).',
    internalDeps: ['packages/shared'],
    externalDeps: ['Node.js >= 22.6'],
  },

  'app/chrome-extension': {
    title: 'chrome-extension',
    purpose:
      'Chrome MV3 Extension frontend and background service worker built with WXT framework, Vue 3, and TailwindCSS. Executes in-page DOM indexing, virtual cursor rendering, and browser tool executors.',
    keyFiles: [
      {
        name: 'package.json',
        desc: 'Chrome extension workspace package definition and npm scripts',
      },
      {
        name: 'wxt.config.ts',
        desc: 'WXT build and manifest generation configuration for Manifest V3',
      },
      {
        name: 'tsconfig.json',
        desc: 'TypeScript compiler configuration for the extension package',
      },
      { name: 'vitest.config.ts', desc: 'Vitest testing configuration with chrome API mock setup' },
      { name: 'tailwind.config.ts', desc: 'TailwindCSS configuration for extension popup styling' },
      { name: 'eslint.config.js', desc: 'Extension-specific ESLint rules' },
      { name: 'env.d.ts', desc: 'WXT and Vite environment type declarations' },
      { name: 'README.md', desc: 'Extension development, build, and loading instructions' },
    ],
    instructions: [
      'Follow MV3 Service Worker lifecycle: state must persist in chrome.storage.session to survive 30s idle termination.',
      'Never perform direct DOM manipulation in background service worker — use inpage-engine.ts or inject-scripts.',
      'Enforce sender permission isolation: verify _sender.id === chrome.runtime.id.',
    ],
    testing: 'Run `pnpm --filter chrome-mcp-server test` (Vitest suite).',
    patterns:
      'WXT entrypoints; closed Shadow DOM overlays for cursor and intervention; isolated-world DOM perception.',
    internalDeps: ['packages/shared', 'app/chrome-extension/common', 'app/chrome-extension/utils'],
    externalDeps: ['wxt', 'vue', 'tailwindcss', 'vitest'],
  },

  'app/chrome-extension/_locales': {
    title: '_locales',
    purpose:
      'Container directory for internationalization locale message files supporting multi-language extension user interfaces.',
    keyFiles: [],
    instructions: [
      'Ensure message keys match across all language subdirectories when adding new UI strings.',
    ],
    testing: 'Validate JSON syntax in each messages.json file.',
    patterns: 'Chrome extension i18n message bundle schema.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/_locales/de': {
    title: 'de',
    purpose: 'German language localization bundle for the Chrome extension popup and UI prompts.',
    keyFiles: [
      {
        name: 'messages.json',
        desc: 'German localization key-value mapping for extension messages',
      },
    ],
    instructions: ['Maintain German translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/_locales/en': {
    title: 'en',
    purpose:
      'Default English language localization bundle defining canonical UI strings and descriptions.',
    keyFiles: [{ name: 'messages.json', desc: 'Canonical English localization key-value mapping' }],
    instructions: ['Treat as canonical source for all locale key definitions.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/_locales/ja': {
    title: 'ja',
    purpose: 'Japanese language localization bundle for the Chrome extension.',
    keyFiles: [
      {
        name: 'messages.json',
        desc: 'Japanese localization key-value mapping for extension messages',
      },
    ],
    instructions: ['Maintain Japanese translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/_locales/ko': {
    title: 'ko',
    purpose: 'Korean language localization bundle for the Chrome extension.',
    keyFiles: [
      {
        name: 'messages.json',
        desc: 'Korean localization key-value mapping for extension messages',
      },
    ],
    instructions: ['Maintain Korean translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/_locales/zh_CN': {
    title: 'zh_CN',
    purpose: 'Simplified Chinese language localization bundle for the Chrome extension.',
    keyFiles: [
      {
        name: 'messages.json',
        desc: 'Simplified Chinese localization key-value mapping for extension messages',
      },
    ],
    instructions: ['Maintain Simplified Chinese translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/_locales/zh_TW': {
    title: 'zh_TW',
    purpose: 'Traditional Chinese language localization bundle for the Chrome extension.',
    keyFiles: [
      {
        name: 'messages.json',
        desc: 'Traditional Chinese localization key-value mapping for extension messages',
      },
    ],
    instructions: ['Maintain Traditional Chinese translations aligned with en/messages.json keys.'],
    testing: 'Validate JSON formatting.',
    patterns: 'Chrome i18n JSON dictionary.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/common': {
    title: 'common',
    purpose:
      'Common constants, TypeScript message types, and tool handler interfaces shared across extension entrypoints and utilities.',
    keyFiles: [
      {
        name: 'constants.ts',
        desc: 'Extension-wide operational constants, storage keys, and timeouts',
      },
      {
        name: 'message-types.ts',
        desc: 'Strongly-typed IPC message payload interfaces between background, popup, and content scripts',
      },
      {
        name: 'tool-handler.ts',
        desc: 'Interface contract and execution context for extension tool handlers',
      },
    ],
    instructions: [
      'Ensure message-types.ts remains strictly typed for all runtime communication payloads.',
    ],
    testing: 'Verified via extension typecheck and unit tests.',
    patterns: 'Strongly typed IPC messages and handler function contracts.',
    internalDeps: ['packages/shared'],
    externalDeps: [],
  },

  'app/chrome-extension/entrypoints': {
    title: 'entrypoints',
    purpose:
      'WXT framework entrypoints defining background scripts, content scripts, and popup interfaces.',
    keyFiles: [
      {
        name: 'agent-cursor.content.ts',
        desc: 'Content script injecting the virtual mouse cursor with spring kinematics and takeover banner into pages',
      },
      {
        name: 'inpage-engine.ts',
        desc: 'Isolated-world DOM perception engine performing tree walking, pruning, and indexed bounding-box projection',
      },
    ],
    instructions: [
      'agent-cursor.content.ts injects the virtual mouse overlay into pages within a closed Shadow DOM.',
      'inpage-engine.ts executes inside an isolated world for DOM indexing and tree walking.',
    ],
    testing: 'Run Vitest tests in tests/ for agent-cursor and inpage engine.',
    patterns:
      'WXT defineContentScript and defineBackground conventions; closed Shadow DOM encapsulation.',
    internalDeps: ['app/chrome-extension/common', 'app/chrome-extension/utils'],
    externalDeps: ['wxt'],
  },

  'app/chrome-extension/entrypoints/background': {
    title: 'background',
    purpose:
      'Chrome extension Service Worker core handling Native Messaging lifecycle, tool dispatching, keep-alive timers, and watchdogs.',
    keyFiles: [
      {
        name: 'index.ts',
        desc: 'Service worker main entry point initializing Native Host, tool router, and message listeners',
      },
      {
        name: 'keepalive-manager.ts',
        desc: 'Keepalive heartbeat preventing premature MV3 service worker termination during operations',
      },
      {
        name: 'native-host.ts',
        desc: 'Native Messaging client managing connection and message parsing with local Node bridge',
      },
    ],
    instructions: [
      'Keepalive-manager prevents premature MV3 worker termination during long-running tasks.',
      'Native-host manages Chrome Native Messaging IPC connection to the local Node.js host.',
    ],
    testing: 'Run Vitest tests in tests/ covering native host and lifecycle.',
    patterns: 'MV3 Service Worker lifecycle management and event-driven tool routing.',
    internalDeps: [
      'app/chrome-extension/entrypoints/background/tools',
      'app/chrome-extension/entrypoints/background/watchdogs',
    ],
    externalDeps: ['chrome-types'],
  },

  'app/chrome-extension/entrypoints/background/tools': {
    title: 'tools',
    purpose:
      'Base browser tool abstraction and master registry routing tool calls to individual browser tool executors.',
    keyFiles: [
      {
        name: 'base-browser.ts',
        desc: 'Abstract base class providing CDP management, tab switching, injection, and error handling',
      },
      {
        name: 'index.ts',
        desc: 'Registry mapping canonical tool names to their corresponding tool class instances',
      },
    ],
    instructions: [
      'BaseBrowserTool provides common utilities: tab lookup, CDP attachment, script injection, and error formatting.',
      'All tools inherit from BaseBrowserTool and implement execute(params).',
    ],
    testing: 'Run Vitest suite in tests/.',
    patterns: 'Template method pattern via BaseBrowserTool; polymorphic action dispatching.',
    internalDeps: ['packages/shared', 'app/chrome-extension/utils'],
    externalDeps: [],
  },

  'app/chrome-extension/entrypoints/background/tools/browser': {
    title: 'browser',
    purpose:
      'Comprehensive implementation of the browser tool executors, covering DOM reading, interactive clicks, fills, screenshots, CDP commands, network captures, tab management, and human handoffs.',
    keyFiles: [
      {
        name: 'agent-cursor.ts',
        desc: 'Controls virtual blue cursor animation and positioning in the webpage',
      },
      {
        name: 'attach-tab.ts',
        desc: 'Attaches automation focus to an existing or newly created tab',
      },
      {
        name: 'batch-actions.ts',
        desc: 'High-performance atomic pipeline executing multiple actions in one roundtrip',
      },
      { name: 'bookmark.ts', desc: 'Manages browser bookmarks' },
      {
        name: 'cdp-execute.ts',
        desc: 'Direct raw Chrome DevTools Protocol execution escape hatch',
      },
      { name: 'common.ts', desc: 'Shared helper functions for browser tool executors' },
      { name: 'console-buffer.ts', desc: 'In-memory ring buffer capturing console messages' },
      { name: 'console.ts', desc: 'Tool returning captured browser console logs' },
      { name: 'dialog.ts', desc: 'Handles JavaScript alert, confirm, and prompt dialogs' },
      { name: 'dismiss-overlay.ts', desc: 'Dismisses overlays, cookie banners, and popups' },
      { name: 'doctor.ts', desc: 'Diagnoses extension runtime health and CDP capabilities' },
      {
        name: 'dom-indexer.ts',
        desc: 'Coordinates in-page indexing and generates element candidate numbers',
      },
      { name: 'download-waiter.ts', desc: 'Waits for file downloads to complete' },
      { name: 'download.ts', desc: 'Triggers and manages browser downloads' },
      { name: 'fast-snapshot.ts', desc: 'High-speed DOM snapshot capture' },
      {
        name: 'file-upload.ts',
        desc: 'Automates file input uploads using CDP DOM.setFileInputFiles',
      },
      { name: 'fill-core.ts', desc: 'Core text input filling logic with event dispatching' },
      {
        name: 'fill-index.ts',
        desc: 'Fills inputs identified by numeric index with clear and enter options',
      },
      {
        name: 'get-dropdown-options.ts',
        desc: 'Extracts options from HTML select or custom dropdowns',
      },
      {
        name: 'get-markdown.ts',
        desc: 'Converts visible page content to clean structured Markdown',
      },
      {
        name: 'grep.ts',
        desc: 'Searches page content for text patterns and returns matching element indexes',
      },
      { name: 'history.ts', desc: 'Inspects browser navigation history' },
      {
        name: 'human-intervention.ts',
        desc: 'Displays takeover overlay requesting user to solve CAPTCHA or 2FA',
      },
      { name: 'in-page-engine.ts', desc: 'Injected script orchestrator' },
      { name: 'index.ts', desc: 'Barrel export for all browser tool modules' },
      { name: 'inspect-media.ts', desc: 'Inspects media elements (video, audio, canvas) on page' },
      {
        name: 'interact-index.ts',
        desc: 'Clicks, hovers, or double-clicks elements by numeric index',
      },
      { name: 'interaction.ts', desc: 'Core interaction primitives' },
      {
        name: 'javascript.ts',
        desc: 'Evaluates JavaScript expressions in the target page context',
      },
      { name: 'keyboard.ts', desc: 'Simulates low-level keyboard strokes, chords, and shortcuts' },
      { name: 'move-tab.ts', desc: 'Moves tabs between positions or windows' },
      {
        name: 'network-capture-debugger.ts',
        desc: 'Captures network traffic via CDP Network domain',
      },
      {
        name: 'network-capture-web-request.ts',
        desc: 'Captures network traffic via chrome.webRequest API',
      },
      { name: 'network-capture.ts', desc: 'Unified network traffic capture tool' },
      { name: 'network-request.ts', desc: 'Sends HTTP requests from the page context' },
      { name: 'performance.ts', desc: 'Measures Core Web Vitals and page performance' },
      {
        name: 'read-dom.ts',
        desc: 'Reads indexed DOM representation with compaction and delta support',
      },
      {
        name: 'screenshot.ts',
        desc: 'Captures viewport, full page, or element screenshots via CDP',
      },
      {
        name: 'scroll-until-found.ts',
        desc: 'Auto-scrolls virtualized feeds until target element is located',
      },
      {
        name: 'smart-scroll.ts',
        desc: 'Intelligent smooth scrolling with visual settle detection',
      },
      {
        name: 'storage.ts',
        desc: 'Inspects and modifies localStorage, sessionStorage, and cookies',
      },
      { name: 'tab-favicon.ts', desc: 'Retrieves or tracks tab favicons' },
      {
        name: 'tab-group-manager.ts',
        desc: 'Orchestrates Chrome tab groups and isolates agent tabs',
      },
      { name: 'tab-group.ts', desc: 'Tool interface for tab group operations' },
      {
        name: 'tool-docs.ts',
        desc: 'Provides dynamic tool schema docs and activates tools for session',
      },
      {
        name: 'unified-locator.ts',
        desc: 'Polymorphic element resolver (index, css, xpath, text)',
      },
      { name: 'window.ts', desc: 'Controls window sizing, placement, and state' },
    ],
    instructions: [
      'Tools must return standardized tool results matching packages/shared/src/tools.ts schemas.',
      'Always use SessionTabAffinityManager and OutputSanitizer to prevent leaks and tab collisions.',
      'Respect activeViewportOnly, includeDelta, and compact format flags in perception tools.',
    ],
    testing:
      'Individual Vitest test files in tests/ (e.g., read-dom-compact.test.ts, interact-delta.test.ts).',
    patterns:
      'Single-responsibility tool executors; fallback chains (DOM -> CDP -> Coordinate); delta computation.',
    internalDeps: ['packages/shared', 'app/chrome-extension/utils', 'app/chrome-extension/common'],
    externalDeps: ['chrome-types'],
  },

  'app/chrome-extension/entrypoints/background/watchdogs': {
    title: 'watchdogs',
    purpose:
      'Automated background watchdogs monitoring tab crashes, unexpected dialogs, and stuck downloads to prevent agent stalls.',
    keyFiles: [
      {
        name: 'base-watchdog.ts',
        desc: 'Abstract base watchdog managing event listeners and cleanup hooks',
      },
      {
        name: 'crash-watchdog.ts',
        desc: 'Monitors chrome.tabs.onRemoved and web navigation errors for tab crashes',
      },
      {
        name: 'dialog-watchdog.ts',
        desc: 'Auto-detects or handles unexpected modal alert/confirm dialogs',
      },
      {
        name: 'downloads-watchdog.ts',
        desc: 'Monitors download progress and prevents hanging on slow downloads',
      },
      { name: 'index.ts', desc: 'Master watchdog coordinator managing active watchdog instances' },
    ],
    instructions: [
      'Watchdogs must clean up listeners and timers upon tab detachment or completion.',
      'BaseWatchdog coordinates lifecycle registration.',
    ],
    testing: 'Vitest tests covering crash and dialog handling.',
    patterns: 'Observer pattern monitoring Chrome event listeners.',
    internalDeps: ['app/chrome-extension/common'],
    externalDeps: ['chrome-types'],
  },

  'app/chrome-extension/entrypoints/popup': {
    title: 'popup',
    purpose:
      'Extension popup user interface built with Vue 3, displaying bridge connection status, port configuration, and active sessions.',
    keyFiles: [
      {
        name: 'App.vue',
        desc: 'Root Vue 3 component displaying status card, port config, and active tabs',
      },
      { name: 'main.ts', desc: 'Vue application bootstrap mounting App.vue to the DOM' },
      { name: 'index.html', desc: 'HTML container template for the extension action popup' },
      { name: 'style.css', desc: 'Scoped styling overrides for popup interface' },
    ],
    instructions: ['Keep popup lightweight and reactive to storage.session changes.'],
    testing: 'Build verification via `pnpm --filter chrome-mcp-server build`.',
    patterns: 'Vue 3 Composition API with TailwindCSS.',
    internalDeps: ['app/chrome-extension/common'],
    externalDeps: ['vue', 'tailwindcss'],
  },

  'app/chrome-extension/entrypoints/styles': {
    title: 'styles',
    purpose: 'CSS stylesheet assets and Tailwind directives for extension entrypoints.',
    keyFiles: [
      { name: 'tailwind.css', desc: 'Tailwind CSS base, components, and utilities directives' },
    ],
    instructions: ['Tailwind directives for utilities and theme styling.'],
    testing: 'Verified during CSS compilation.',
    patterns: 'TailwindCSS utility classes.',
    internalDeps: [],
    externalDeps: ['tailwindcss'],
  },

  'app/chrome-extension/inject-scripts': {
    title: 'inject-scripts',
    purpose:
      'Vanilla JavaScript helpers dynamically injected into target pages for clicks, fills, keyboard simulation, and network monitoring.',
    keyFiles: [
      {
        name: 'accessibility-tree-helper.js',
        desc: 'Extracts accessibility roles, names, and computed states',
      },
      { name: 'keyboard-helper.js', desc: 'Simulates keydown, keypress, and keyup event streams' },
      { name: 'network-helper.js', desc: 'In-page XHR and fetch hook helper' },
      { name: 'screenshot-helper.js', desc: 'Calculates element bounds for targeted clipping' },
    ],
    instructions: [
      'These scripts run in the page context. They must remain zero-dependency vanilla JS.',
      'Avoid global namespace pollution; wrap in IIFEs or isolated scopes.',
    ],
    testing: 'Tested via inpage-agent-helpers.test.ts.',
    patterns: 'Self-contained vanilla JS injection scripts.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/public': {
    title: 'public',
    purpose: 'Static public assets for the Chrome extension including icons and imagery.',
    keyFiles: [],
    instructions: ['Static files copied directly to extension build output.'],
    testing: 'Asset presence verification.',
    patterns: 'Standard extension static directory.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/public/icon': {
    title: 'icon',
    purpose: 'Extension PNG icons across standard resolutions (16, 32, 48, 96, 128 px).',
    keyFiles: [
      { name: '16.png', desc: '16x16 icon for browser favicon and extension toolbar' },
      { name: '32.png', desc: '32x32 icon for standard displays' },
      { name: '48.png', desc: '48x48 icon for Chrome extensions management page' },
      { name: '96.png', desc: '96x96 icon for high-DPI displays' },
      { name: '128.png', desc: '128x128 icon for Chrome Web Store and installation' },
    ],
    instructions: ['Ensure standard square PNG formats for Chrome extension manifest.'],
    testing: 'Visual inspection.',
    patterns: 'Manifest icon set.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/public/images': {
    title: 'images',
    purpose: 'Static UI images and graphics used in extension overlays and cursor rendering.',
    keyFiles: [
      { name: 'cursor-chat.png', desc: 'Graphic asset for virtual cursor chat indicator' },
    ],
    instructions: ['Static PNG/SVG assets.'],
    testing: 'Visual verification.',
    patterns: 'Image assets.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/tests': {
    title: 'tests',
    purpose:
      'Vitest unit and integration test suite covering all extension tools, DOM perception, delta diffing, and MV3 lifecycle resilience.',
    keyFiles: [
      { name: 'vitest.setup.ts', desc: 'Global Vitest setup mocking chrome.* APIs and CDP events' },
    ],
    instructions: [
      'Mock Chrome APIs using vitest.setup.ts.',
      'Add test cases for edge cases (shadow DOM, iframes, multi-window, modal traps).',
    ],
    testing: 'Run `pnpm test` inside app/chrome-extension/.',
    patterns: 'Vitest with mocked chrome.* global APIs.',
    internalDeps: ['app/chrome-extension'],
    externalDeps: ['vitest'],
  },

  'app/chrome-extension/types': {
    title: 'types',
    purpose: 'Ambient TypeScript type definitions for icons and custom extension modules.',
    keyFiles: [{ name: 'icons.d.ts', desc: 'Type definitions for icon imports' }],
    instructions: ['Provide ambient declarations for assets and non-TS modules.'],
    testing: 'Verified during tsc compilation.',
    patterns: 'TypeScript .d.ts declaration files.',
    internalDeps: [],
    externalDeps: [],
  },

  'app/chrome-extension/utils': {
    title: 'utils',
    purpose:
      'High-resilience utility classes supporting CDP session management with ref counting, DOM fingerprint delta diffing, coordinate parsing, popup protection, and tab affinity.',
    keyFiles: [
      {
        name: 'action-network-capture.ts',
        desc: 'Captures network requests triggered during specific actions',
      },
      { name: 'action-watchdog.ts', desc: 'Watchdog tracking action timeouts and hang prevention' },
      {
        name: 'cdp-session-manager.ts',
        desc: 'Session-aware CDP retention manager with domain reference counting',
      },
      { name: 'coordinate-parser.ts', desc: 'Parses polymorphic coordinates ([x, y] or {x, y})' },
      { name: 'delta-helper.ts', desc: 'Computes DOM mutation diffs between snapshots' },
      { name: 'image-utils.ts', desc: 'Image resizing, compression, and base64 format helpers' },
      {
        name: 'mouse-trajectory.ts',
        desc: 'Computes smooth spring-physics trajectories for virtual cursor',
      },
      {
        name: 'output-sanitizer.ts',
        desc: 'Sanitizes DOM strings to prevent token bloat and confidential leaks',
      },
      { name: 'popup-guard.ts', desc: 'Detects and guards against unintended popup dismissals' },
      {
        name: 'race-cdp.ts',
        desc: 'Races CDP calls against timeouts to prevent debugger deadlocks',
      },
      {
        name: 'restricted-url.ts',
        desc: 'Validates against restricted chrome:// and file:// URLs',
      },
      { name: 'safe-post-message.ts', desc: 'Safe cross-frame message dispatching' },
      {
        name: 'screenshot-context.ts',
        desc: 'Context manager for offscreen vs surface screenshots',
      },
      {
        name: 'screenshot-guard.ts',
        desc: 'Guards against screenshot collisions and concurrency races',
      },
      {
        name: 'screenshot-ring-buffer.ts',
        desc: 'In-memory ring buffer holding recent screenshot frames',
      },
      { name: 'session-tab-affinity.ts', desc: 'Binds agent sessions to specific tab groups' },
      {
        name: 'snapshot-cache-manager.ts',
        desc: 'Caches DOM tree fingerprints to enable fast delta calculations',
      },
      {
        name: 'unified-locator.ts',
        desc: 'Unified locator engine resolving elements by multiple strategies',
      },
      { name: 'url-sanitizer.ts', desc: 'Normalizes and sanitizes navigation URLs' },
      {
        name: 'version-checker.ts',
        desc: 'Verifies compatibility between extension and bridge versions',
      },
    ],
    instructions: [
      'cdp-session-manager manages persistent CDP domains (Page, Network) with domain ref counting.',
      'snapshot-cache-manager computes structural delta diffs between DOM states.',
      'session-tab-affinity prevents multi-agent tab collisions.',
    ],
    testing: 'Unit tests in app/chrome-extension/tests/.',
    patterns: 'Singleton managers; domain reference counting; ring buffer screenshot storage.',
    internalDeps: ['packages/shared', 'app/chrome-extension/common'],
    externalDeps: ['chrome-types'],
  },

  'app/native-server': {
    title: 'native-server',
    purpose:
      'BrowserPaw CLI (`browserpaw`), Native Messaging host (`com.browserpaw.nativehost`), and authenticated loopback HTTP command bridge.',
    keyFiles: [
      {
        name: 'package.json',
        desc: 'BrowserPaw npm package metadata, build scripts, and CLI bin entry',
      },
      { name: 'tsconfig.json', desc: 'TypeScript compiler configuration for native-server' },
      { name: 'jest.config.js', desc: 'Jest test runner configuration' },
      { name: 'README.md', desc: 'BrowserPaw npm package overview and CLI usage' },
      { name: 'install.md', desc: 'Pointer to the BrowserPaw installation guide' },
    ],
    instructions: [
      'Hosts the Chrome Native Messaging host (`dist/v5/host.cjs`) and loopback command server (`127.0.0.1:12307`).',
      'Provides the `browserpaw` CLI (`dist/v5/cli.cjs`) with setup, task management, batching, and learned recipes.',
      'Enforces bearer token authentication and process watchdogs to prevent orphaned Node processes.',
    ],
    testing: 'Run `pnpm --filter browserpaw test` (Jest suite).',
    patterns:
      'Native Messaging StdIO framing; Node HTTP loopback server; file-backed task and recipe state.',
    internalDeps: ['packages/shared'],
    externalDeps: ['ajv', 'node-fetch', 'tsup', 'jest'],
  },

  'app/native-server/src': {
    title: 'src',
    purpose:
      'Core source code for the `browserpaw` CLI, command dispatch, task ownership/ledger, learned recipes, Native Messaging host, and file handling.',
    keyFiles: [
      {
        name: 'cli.ts',
        desc: 'CLI entrypoint parsing BrowserPaw commands, flags, and offline help/search',
      },
      {
        name: 'cli-setup.ts',
        desc: 'Host registration, extension extraction, and Skill installation/sync',
      },
      {
        name: 'command-dispatch.ts',
        desc: 'Routes parsed CLI commands to browser and local handlers',
      },
      {
        name: 'browser-tasks.ts',
        desc: 'Task lifecycle manager coordinating ledger, ownership, and compensation',
      },
      {
        name: 'learned-recipes.ts',
        desc: 'Learned workflow indexing, intent/URL matching, validation, and execution',
      },
      { name: 'file-handler.ts', desc: 'Manages local file uploads and temporary downloads' },
      { name: 'index.ts', desc: 'Primary Native Messaging host bootstrap entry point' },
      {
        name: 'native-messaging-host.ts',
        desc: 'StdIO Native Messaging host with 1MB chunk guard',
      },
    ],
    instructions: [
      'native-messaging-host.ts implements standard Chrome Native Messaging IPC with 1MB chunking guards.',
      'cli.ts parses command-line arguments using shared definitions from packages/shared/src/commands.ts.',
    ],
    testing: 'Unit tests in jest.',
    patterns:
      'StdIO length-prefix IPC; file-locked atomic state writes; single-source command registry.',
    internalDeps: [
      'packages/shared',
      'app/native-server/src/server',
      'app/native-server/src/constant',
    ],
    externalDeps: ['ajv', 'node-fetch'],
  },

  'app/native-server/src/constant': {
    title: 'constant',
    purpose:
      'Server-side configuration constants, port numbers, token file paths, and environment defaults.',
    keyFiles: [
      {
        name: 'index.ts',
        desc: 'Default server port resolution (`DEFAULT_SERVER_PORT`, 12307) and request timeouts',
      },
    ],
    instructions: [
      'Maintain default port (`DEFAULT_SERVER_PORT`, 12307) and BROWSERPAW_PORT validation.',
    ],
    testing: 'Verified via server startup tests.',
    patterns: 'Configuration constant exports.',
    internalDeps: ['packages/shared'],
    externalDeps: [],
  },

  'app/native-server/src/scripts': {
    title: 'scripts',
    purpose:
      'Cross-platform Chrome/Chromium Native Messaging host config paths, tsup v5 build pipeline, and host wrapper scripts.',
    keyFiles: [
      {
        name: 'browser-config.ts',
        desc: 'OS-specific manifest file paths and registry key definitions',
      },
      {
        name: 'build.ts',
        desc: 'Bundles v5 CLI, host, assets, extension, recipes, and skill into dist/v5',
      },
      { name: 'build.test.ts', desc: 'Tests verifying dist/v5 build layout and bundled assets' },
      { name: 'constant.ts', desc: 'Constants for host registration' },
      { name: 'run_host.bat', desc: 'Windows batch file executing Node host' },
      { name: 'run_host.sh', desc: 'POSIX shell script executing Node host' },
    ],
    instructions: [
      'build.ts bundles cli.cjs and host.cjs into dist/v5 and copies extension, recipes, and skill payloads.',
      'browser-config.ts defines Native Messaging manifest locations for Chrome and Chromium across OSes.',
    ],
    testing: 'Run `pnpm --filter browserpaw test -- src/scripts/build.test.ts`.',
    patterns:
      'Cross-platform manifest registration (Windows Registry, macOS Application Support, Linux ~/.config).',
    internalDeps: ['packages/shared'],
    externalDeps: [],
  },

  'app/native-server/src/server': {
    title: 'server',
    purpose:
      'Authenticated loopback HTTP command server (`node:http`) handling `/v1/status`, `/v1/run`, `/v1/cancel`, and `/v1/restart`.',
    keyFiles: [
      {
        name: 'index.ts',
        desc: 'Loopback HTTP server initialization, Host/Origin guards, and `/v1/*` routes',
      },
      {
        name: 'command-server.test.ts',
        desc: 'Integration tests for HTTP routes, auth, and cancellation',
      },
      {
        name: 'token.test.ts',
        desc: 'Unit tests for exclusive token initialization and timing-safe checks',
      },
      { name: 'token.ts', desc: 'Token generator, file persister, and authentication validator' },
    ],
    instructions: [
      'Enforces bearer token authentication (`$BROWSERPAW_HOME/token`), loopback Host checks, and rejects browser Origin headers.',
      'Writes discovery metadata (`host.json`) atomically and enforces an 8 MiB request body cap.',
    ],
    testing: 'Run jest tests in command-server.test.ts and token.test.ts.',
    patterns: 'Native node:http server, timing-safe bearer auth, exclusive token file creation.',
    internalDeps: ['app/native-server/src/constant', 'packages/shared'],
    externalDeps: ['Node.js node:http'],
  },

  docs: {
    title: 'docs',
    purpose:
      'Documentation vault containing technical architecture specifications, tool references, navigation maps, troubleshooting playbooks, and architectural guides.',
    keyFiles: [
      {
        name: 'README.md',
        desc: 'Central documentation hub, reading paths, and documentation index',
      },
      {
        name: 'MAP.md',
        desc: 'Master navigation hub for repository topology, reading paths, and tool radars',
      },
      {
        name: 'ARCHITECTURE.md',
        desc: 'Comprehensive 3-tier architecture, IPC protocols, and design decisions',
      },
      { name: 'COMMANDS.md', desc: 'Auto-generated reference for CLI commands and arguments' },
      {
        name: 'MIGRATION.md',
        desc: 'v4 to v5 migration guide (English and Simplified Chinese mirror)',
      },
      {
        name: 'TROUBLESHOOTING.md',
        desc: 'Diagnostic checklists for connection issues, token mismatch, and CDP',
      },
      {
        name: 'TROUBLESHOOTING.zh-CN.md',
        desc: 'Simplified Chinese translation of the diagnostics and self-healing playbook',
      },
      {
        name: 'CONTRIBUTING.md',
        desc: 'Guidelines for contributors covering workflows and PR protocols',
      },
    ],
    instructions: [
      'Do not edit docs/COMMANDS.md manually; regenerate it using `pnpm docs:commands`.',
      'English remains canonical; every `*.zh-CN.md` file is a full Simplified Chinese translation kept in sync with its English source.',
    ],
    testing: 'Verify markdown link validity and table formatting.',
    patterns:
      'English canonical documentation with parallel Simplified Chinese translations; clear ASCII diagrams.',
    internalDeps: ['scripts/gen-commands-doc.mjs'],
    externalDeps: ['Markdown / GitHub-flavored markdown'],
  },

  'docs/images': {
    title: 'images',
    purpose: 'Image assets, diagrams, and project logo for BrowserPaw documentation.',
    keyFiles: [{ name: 'logo.png', desc: 'Official project logo graphic' }],
    instructions: ['Contains logo.png and graphic assets.'],
    testing: 'Visual verification.',
    patterns: 'Static media.',
    internalDeps: [],
    externalDeps: [],
  },

  'docs/archive': {
    title: 'archive',
    purpose:
      'Historical archive repository holding past release notes, refactoring handoff memos, audit reviews, and testing logs.',
    keyFiles: [],
    instructions: ['Read-only historical reference files.'],
    testing: 'Documentation review.',
    patterns: 'Archived documentation.',
    internalDeps: [],
    externalDeps: [],
  },

  'docs/archive/releases': {
    title: 'archive-releases',
    purpose: 'Historical release notes for earlier major and minor versions (e.g. v3.1.0).',
    keyFiles: [{ name: 'RELEASE_NOTES_v3.1.0.md', desc: 'Release notes for version 3.1.0' }],
    instructions: ['Read-only historical release notes.'],
    testing: 'Documentation review.',
    patterns: 'Release records.',
    internalDeps: [],
    externalDeps: [],
  },

  'docs/archive/handoffs': {
    title: 'archive-handoffs',
    purpose:
      'Historical engineering handoff documents and phase transition notes across refactor phases.',
    keyFiles: [
      { name: 'HANDOFF.md', desc: 'Historical engineering handoff summary' },
      { name: 'HANDOFF.zh-CN.md', desc: 'Chinese translation of historical handoff summary' },
      { name: 'HANDOFF-refactor-phase.md', desc: 'Refactor phase handoff report' },
      {
        name: 'HANDOFF-refactor-phase.zh-CN.md',
        desc: 'Chinese translation of refactor phase handoff report',
      },
    ],
    instructions: ['Read-only historical handoffs.'],
    testing: 'Documentation review.',
    patterns: 'Handoff records.',
    internalDeps: [],
    externalDeps: [],
  },

  'docs/archive/testing': {
    title: 'archive-testing',
    purpose: 'Historical test session notes, manual test playbooks, and verification logs.',
    keyFiles: [
      { name: 'TESTING-NOTES.md', desc: 'Historical testing notes and execution logs' },
      { name: 'TESTING-NOTES.zh-CN.md', desc: 'Chinese translation of historical testing notes' },
    ],
    instructions: ['Read-only historical test records.'],
    testing: 'Documentation review.',
    patterns: 'Test logs.',
    internalDeps: [],
    externalDeps: [],
  },

  'docs/archive/reviews': {
    title: 'archive-reviews',
    purpose: 'Historical architecture reviews, security audits, and boost optimization notes.',
    keyFiles: [
      {
        name: 'review-notes-boost.md',
        desc: 'Notes on performance and stability optimization phases',
      },
    ],
    instructions: ['Read-only historical reviews.'],
    testing: 'Documentation review.',
    patterns: 'Audit reports.',
    internalDeps: [],
    externalDeps: [],
  },

  'docs/archive/reviews/review-2026-09': {
    title: 'review-2026-09',
    purpose:
      'Architecture review and dependency graph documentation from the September 2026 audit.',
    keyFiles: [
      {
        name: 'dependency-graph.md',
        desc: 'Monorepo dependency graph and cross-package call paths',
      },
      {
        name: 'jev-capabilities.md',
        desc: 'Detailed capability assessment of JEV heuristic engine',
      },
    ],
    instructions: ['Archived review documentation.'],
    testing: 'Documentation review.',
    patterns: 'Review summaries and graphs.',
    internalDeps: [],
    externalDeps: [],
  },

  'docs/archive/reviews/review-2026-09/by-module': {
    title: 'by-module',
    purpose:
      'Module-by-module audit reports covering extension tools, JEV engine, Native MCP bridge, scripts, and shared utils.',
    keyFiles: [
      { name: 'docs-inventory.md', desc: 'Comprehensive inventory of all documentation assets' },
      { name: 'extension-tools.md', desc: 'Audit of extension tool implementations and schemas' },
      { name: 'jev.md', desc: 'Deep dive into JEV engine logic and test adequacy' },
      { name: 'native-mcp.md', desc: 'Audit of native MCP bridge, stdio transport, and security' },
      {
        name: 'scripts-install.md',
        desc: 'Evaluation of installer scripts and registration reliability',
      },
      { name: 'shared-utils.md', desc: 'Review of shared coordinate, error formatting, and types' },
    ],
    instructions: ['Detailed per-module technical breakdown.'],
    testing: 'Documentation review.',
    patterns: 'Module reviews.',
    internalDeps: [],
    externalDeps: [],
  },

  'docs/archive/reviews/review-skill-2026-09': {
    title: 'review-skill-2026-09',
    purpose:
      'Skill audit, tool contract verification, and core capability assessments from September 2026.',
    keyFiles: [
      { name: 'core-capabilities.md', desc: 'Assessment of core AI agent browser capabilities' },
      { name: 'jev-and-bridge.md', desc: 'Evaluation of JEV decision loop and bridge performance' },
      { name: 'readme-facts.md', desc: 'Fact-checking audit of claims made in README documents' },
      {
        name: 'skill-audit.md',
        desc: 'Evaluation of SKILL.md instructions, decision trees, and clarity',
      },
      { name: 'tool-contracts.md', desc: 'Rigorous contract audit of 49 tools against real code' },
    ],
    instructions: ['Verification records of tool contracts and skill compliance.'],
    testing: 'Documentation review.',
    patterns: 'Audit reports.',
    internalDeps: [],
    externalDeps: [],
  },

  packages: {
    title: 'packages',
    purpose:
      'Container directory for shared libraries and common packages across the BrowserPaw monorepo.',
    keyFiles: [],
    instructions: [
      'Code in packages/ must remain environment-agnostic and free of DOM or Node-specific assumptions where possible.',
      'Always build packages/shared before building apps that depend on it.',
    ],
    testing: 'Run `pnpm --filter chrome-mcp-shared build` to verify type generation.',
    patterns: 'Exporting both TypeScript source and compiled definitions.',
    internalDeps: [],
    externalDeps: ['typescript'],
  },

  'packages/shared': {
    title: 'shared',
    purpose:
      'Single Source of Truth (SSOT) shared package defining the v5 CLI command registry, internal extension tool schemas, coordinate models, and standardized error formatting.',
    keyFiles: [
      { name: 'package.json', desc: 'Shared package configuration and build scripts' },
      { name: 'tsconfig.json', desc: 'TypeScript compiler configuration' },
    ],
    instructions: [
      'This package is imported by both app/chrome-extension and app/native-server.',
      'Keep code strictly platform-agnostic (no DOM or Node.js built-ins in shared types).',
    ],
    testing: 'Run `pnpm --filter chrome-mcp-shared build` to verify compilation.',
    patterns:
      'TypeScript command and schema definitions; coordinate normalization; semver comparison.',
    internalDeps: [],
    externalDeps: ['typescript'],
  },

  'packages/shared/src': {
    title: 'src',
    purpose:
      'Source files for the v5 CLI command registry, internal extension schemas, coordinate types, error formatting, and version constants.',
    keyFiles: [
      { name: 'commands.ts', desc: 'Single-source CLI command specs, help, and search metadata' },
      { name: 'constants.ts', desc: 'Shared operational constants and magic numbers' },
      { name: 'coordinate.ts', desc: 'Coordinate model normalization supporting [x,y] and {x,y}' },
      { name: 'error-format.ts', desc: 'Standardized error response formatter with stack control' },
      { name: 'index.ts', desc: 'Barrel export for shared contracts and tools' },
      { name: 'tools.ts', desc: 'Internal extension execution schema definitions' },
      { name: 'types.ts', desc: 'Universal coordinate, batch action, and diff payload interfaces' },
      { name: 'version.ts', desc: 'Single source of truth version constant' },
    ],
    instructions: [
      'commands.ts defines the public v5 CLI command surface, help text, and search metadata.',
      'tools.ts defines internal extension tool contracts shared with app/chrome-extension.',
      'error-format.ts provides standardized error reporting with stack control.',
    ],
    testing: 'Run typecheck and consumer package tests.',
    patterns: 'Const assertions, JSON Schema compatible types, enum-like string literals.',
    internalDeps: [],
    externalDeps: [],
  },

  plugins: {
    title: 'plugins',
    purpose:
      'Client-specific BrowserPaw distributions for ChatGPT/Codex, Hermes, Claude Code, and DeepSeek Harness.',
    keyFiles: [],
    instructions: [
      'Keep each client package in its documented native layout; do not mix client-specific instructions into skills/browserpaw.',
      'Edit only skills/browserpaw, then run node scripts/sync-skills.mjs.',
    ],
    testing: 'Run root script tests and `pytest plugins/browserpaw-hermes/tests`.',
    patterns:
      'Unified v5 CLI-backed client plugins: Portable Agent Plugins, Hermes native plugins, Claude Code plugins, and DSH Cordis bundles.',
    internalDeps: ['skills/browserpaw'],
    externalDeps: ['Python 3.9+ (optional test environment)'],
  },

  'plugins/browserpaw-claude': {
    title: 'browserpaw-claude',
    purpose:
      'Claude Code plugin distribution backed by the repository-root .claude-plugin/marketplace.json catalog.',
    keyFiles: [
      { name: 'README.md', desc: 'Claude Code plugin installation and usage documentation' },
    ],
    instructions: [
      'Manifest lives at .claude-plugin/plugin.json; its name must match the catalog entry name in .claude-plugin/marketplace.json.',
      'Skills are mirrored verbatim from skills/browserpaw/ by scripts/sync-skills.mjs.',
      'Plugin contract coverage lives in scripts/browserpaw-plugins.test.mjs.',
    ],
    testing:
      '`node --test scripts/browserpaw-plugins.test.mjs`; when Claude Code is installed, also run `claude plugin validate plugins/browserpaw-claude --strict`.',
    patterns: 'Claude Code plugin manifest, marketplace catalog entry, and SessionStart hook.',
    internalDeps: ['skills/browserpaw'],
    externalDeps: ['Claude Code', 'browserpaw CLI on PATH'],
  },

  'plugins/browserpaw': {
    title: 'browserpaw',
    purpose:
      'Portable Agent Plugins v1.0.0 package for ChatGPT/Codex, bundling the read-only BrowserPaw Skill and icons.',
    keyFiles: [
      {
        name: 'plugin.json',
        desc: 'Portable Agent Plugins v1 manifest and OpenAI presentation metadata',
      },
    ],
    instructions: [
      'Keep skills/browserpaw synchronized with the canonical skill.',
      'Do not recreate .codex-plugin/ or mcp-skills/ compatibility copies.',
    ],
    testing: '`node --test scripts/browserpaw-plugins.test.mjs`',
    patterns: 'Portable Agent Plugins v1 plugin.json plus canonical skills.',
    internalDeps: ['skills/browserpaw'],
    externalDeps: [],
  },

  'plugins/browserpaw/skills': {
    title: 'skills',
    purpose: 'Container for plugin-scoped agent skill distributions.',
    keyFiles: [],
    instructions: ['Holds the browserpaw plugin skill package.'],
    testing: 'Verify file synchronization.',
    patterns: 'Container directory.',
    internalDeps: ['skills/browserpaw'],
    externalDeps: [],
  },

  'plugins/browserpaw/skills/browserpaw': {
    title: 'browserpaw',
    purpose: 'Verbatim portable mirror of the client-neutral BrowserPaw Agent Skill.',
    keyFiles: [{ name: 'SKILL.md', desc: 'Client-neutral skill entry point' }],
    instructions: [
      'Mirrored automatically by scripts/sync-skills.mjs; edit only skills/browserpaw.',
    ],
    testing: 'Verify sync script output.',
    patterns: 'Progressive disclosure through references, scripts, and assets.',
    internalDeps: ['skills/browserpaw'],
    externalDeps: [],
  },

  'plugins/browserpaw/skills/browserpaw/assets/recipes': {
    title: 'recipes',
    purpose: 'Bundled static site recipes copied into the Native runtime.',
    keyFiles: [{ name: 'developer.mozilla.org.md', desc: 'MDN site-specific operating notes' }],
    instructions: ['Mirrored from skills/browserpaw/assets/recipes and copied to dist/recipes.'],
    testing: 'Verify file parity.',
    patterns: 'Static site recipes.',
    internalDeps: ['skills/browserpaw/assets/recipes'],
    externalDeps: [],
  },

  'plugins/browserpaw/skills/browserpaw/references': {
    title: 'references',
    purpose:
      'Reference documentation on CLI commands, browser data management, debugging, recipes, and troubleshooting.',
    keyFiles: [
      { name: 'commands.md', desc: 'CLI command patterns and execution guidance' },
      {
        name: 'browser-data.md',
        desc: 'History, bookmarks, downloads, storage, and cookies workflows',
      },
      {
        name: 'debugging.md',
        desc: 'Network, console, performance, emulation, PDF, and CDP guidance',
      },
      { name: 'recipe-contract.md', desc: 'Self-learned recipe format and validation rules' },
    ],
    instructions: ['Mirrored from skills/browserpaw/references.'],
    testing: 'Verify file parity.',
    patterns: 'Technical references.',
    internalDeps: ['skills/browserpaw/references'],
    externalDeps: [],
  },

  'plugins/browserpaw-hermes': {
    title: 'browserpaw-hermes',
    purpose:
      'Native Hermes plugin providing the unified `browserpaw` CLI tool and read-only skill mirror.',
    keyFiles: [
      { name: 'plugin.yaml', desc: 'Hermes manifest and declared tool entry' },
      { name: '__init__.py', desc: 'Hermes plugin implementation' },
    ],
    instructions: [
      'Keep `plugin.yaml` and `__init__.py` aligned with the unified `browserpaw` CLI tool contract.',
      'Mirrored skills live under skills/browserpaw/ via scripts/sync-skills.mjs.',
    ],
    testing: '`pytest plugins/browserpaw-hermes/tests`',
    patterns: 'Hermes native Python plugin forwarding CLI execution and gateway `MEDIA:` paths.',
    internalDeps: ['skills/browserpaw'],
    externalDeps: ['Python 3.9+', 'Hermes >=0.21.5'],
  },

  'plugins/browserpaw-hermes/tests': {
    title: 'tests',
    purpose:
      'Python integration tests for the Hermes `browserpaw` CLI wrapper and media forwarding.',
    keyFiles: [
      {
        name: 'test_plugin.py',
        desc: 'Verifies Hermes CLI execution, MEDIA output, and schema validation',
      },
    ],
    instructions: ['Run with pytest in a Python 3.9+ environment.'],
    testing: '`pytest plugins/browserpaw-hermes/tests/`',
    patterns: 'Pytest unit tests for Hermes plugin tool invocation.',
    internalDeps: ['plugins/browserpaw-hermes'],
    externalDeps: ['pytest'],
  },

  'plugins/browserpaw-dsh': {
    title: 'browserpaw-dsh',
    purpose:
      'DeepSeek Harness Cordis plugin distribution bundling `browserpaw` CLI, read-only skill, and `~/.browserpaw` routing.',
    keyFiles: [
      {
        name: 'package.json',
        desc: 'DSH adapter package metadata, `browserpaw` dependency, and Cordis bundle declaration',
      },
      {
        name: 'index.js',
        desc: 'DSH plugin entry point injecting skill and `~/.browserpaw` learned-workflow context',
      },
      { name: 'cordis.patch.yml', desc: 'Cordis profile patch installed by DeepSeek Harness' },
    ],
    instructions: [
      'Keep the adapter version aligned with its release and avoid overwriting ~/.browserpaw.',
      'Store only the generated canonical skill mirror in skills/browserpaw.',
    ],
    testing: '`node --test scripts/browserpaw-plugins.test.mjs` and `npm pack --dry-run --json`.',
    patterns:
      'Cordis plugin bundle with bundled `browserpaw` CLI dependency and canonical skill injection.',
    internalDeps: ['skills/browserpaw', 'packages/shared'],
    externalDeps: ['DeepSeek Harness', 'Node.js 22+'],
  },

  'plugins/browserpaw-dsh/skills/browserpaw': {
    title: 'browserpaw',
    purpose: 'Generated DSH mirror of the client-neutral BrowserPaw Agent Skill.',
    keyFiles: [{ name: 'SKILL.md', desc: 'Canonical skill entry point' }],
    instructions: [
      'Edit skills/browserpaw and run scripts/sync-skills.mjs; never edit this mirror directly.',
    ],
    testing: '`node --test scripts/sync-skills.test.mjs`',
    patterns: 'Progressive disclosure through references, scripts, and assets.',
    internalDeps: ['skills/browserpaw'],
    externalDeps: [],
  },

  scripts: {
    title: 'scripts',
    purpose: 'Repository lifecycle, build automation, and documentation generation scripts.',
    keyFiles: [
      {
        name: 'clean.js',
        desc: 'Cross-platform directory cleaner for dist, build, and node_modules',
      },
      {
        name: 'gen-commands-doc.mjs',
        desc: 'Generator extracting CLI command docs from packages/shared/src/commands.ts into docs/COMMANDS.md',
      },
      {
        name: 'generate-agents-docs.mjs',
        desc: 'Hierarchical AGENTS.md documentation generator for deepinit',
      },
      { name: 'verify.mjs', desc: 'Full local verification gate runner' },
      {
        name: 'release-notes.mjs',
        desc: 'Validates release notes against docs/releases/TEMPLATE.md',
      },
      { name: 'validate-docs.mjs', desc: 'Validates markdown links, text integrity, and versions' },
      {
        name: 'extension-artifacts.mjs',
        desc: 'Packages release artifacts and verifies extension deployment',
      },
      {
        name: 'sync-skills.mjs',
        desc: 'Synchronizes canonical skills/browserpaw across the portable, Claude, DSH, Native, and Hermes skill distributions',
      },
      {
        name: 'validate-agents-docs.mjs',
        desc: 'Validator verifying hierarchical AGENTS.md parent links and required sections',
      },
    ],
    instructions: [
      'Whenever skills/browserpaw/SKILL.md or commands.ts are updated, run `node scripts/sync-skills.mjs` and `pnpm docs:commands`.',
      'Use pure Node.js APIs (node:fs, node:path) to preserve cross-platform compatibility on Windows and POSIX.',
    ],
    testing:
      'Test script execution: `node scripts/sync-skills.mjs --check` and `node --test scripts/*.test.mjs`.',
    patterns: 'ES Modules with `node:` prefix; AST and source extraction for automated docs.',
    internalDeps: ['packages/shared/src/commands.ts', 'skills/browserpaw/SKILL.md'],
    externalDeps: ['node:fs', 'node:path', 'node:crypto'],
  },

  skills: {
    title: 'skills',
    purpose: 'Canonical agent skills; BrowserPaw lives in skills/browserpaw.',
    keyFiles: [],
    instructions: ['Edit skills/browserpaw and run node scripts/sync-skills.mjs.'],
    testing: 'Run node scripts/sync-skills.mjs --check.',
    patterns: 'Canonical source with client-specific generated plugin bundles.',
    internalDeps: ['scripts/sync-skills.mjs'],
    externalDeps: [],
  },

  'skills/browserpaw': {
    title: 'browserpaw',
    purpose:
      'Canonical AI Agent Skill package for BrowserPaw. Encodes CLI workflow, task ownership, self-learned recipe routing, and reference documentation.',
    keyFiles: [
      {
        name: 'SKILL.md',
        desc: 'Canonical skill definition containing CLI workflow, safety rules, and learned-routing markers',
      },
    ],
    instructions: [
      'This directory is the Single Source of Truth for skills. Edit this canonical directory; plugin bundles are generated from it.',
      'After modifying SKILL.md, run `node scripts/sync-skills.mjs` to propagate changes to all mirrors.',
    ],
    testing:
      'Verify command syntax against packages/shared/src/commands.ts and run `node scripts/sync-skills.mjs --check`.',
    patterns:
      'Progressive disclosure with compact SKILL.md, references/, and bundled recipes under assets/recipes/.',
    internalDeps: ['scripts/sync-skills.mjs'],
    externalDeps: ['Agent Skills protocol'],
  },

  'skills/browserpaw/assets/recipes': {
    title: 'recipes',
    purpose: 'Static site-specific operating notes copied into the Native runtime.',
    keyFiles: [{ name: 'developer.mozilla.org.md', desc: 'MDN operating notes' }],
    instructions: [
      'Recipes instruct agents on optimal tool sequencing for tasks like web extraction, login handling, and search.',
    ],
    testing: 'Manual evaluation with AI agents.',
    patterns: 'Task-specific procedural playbooks.',
    internalDeps: [],
    externalDeps: [],
  },

  'skills/browserpaw/references': {
    title: 'references',
    purpose:
      'Reference documentation covering CLI commands, browser data management, debugging, recipes, and troubleshooting.',
    keyFiles: [
      { name: 'commands.md', desc: 'CLI command patterns and execution guidance' },
      {
        name: 'browser-data.md',
        desc: 'History, bookmarks, downloads, storage, and cookies workflows',
      },
      {
        name: 'debugging.md',
        desc: 'Network, console, performance, emulation, PDF, and CDP guidance',
      },
      { name: 'recipe-contract.md', desc: 'Self-learned recipe format and validation rules' },
      { name: 'TROUBLESHOOTING.md', desc: 'Troubleshooting guide mirrored for skill consumers' },
    ],
    instructions: [
      'Consult commands.md, browser-data.md, debugging.md, and recipe-contract.md for detailed workflows.',
    ],
    testing: 'Documentation integrity checks.',
    patterns: 'Detailed reference specifications.',
    internalDeps: [],
    externalDeps: [],
  },

  test: {
    title: 'test',
    purpose:
      'Root directory for packaged npm CLI smoke tests and isolated live Chrome for Testing verification suites.',
    keyFiles: [
      {
        name: 'package-smoke.mjs',
        desc: 'Verifies packed npm tarball installation, setup scopes, and host launch',
      },
    ],
    instructions: [
      'Use isolated temporary directories and BROWSERPAW_TEST_CHROME for live browser verification; never clobber user profiles.',
      'Historical MCP integration manuals are archived under docs/archive/testing/.',
    ],
    testing:
      'Run `node test/package-smoke.mjs` (included in `pnpm verify`) and `pnpm test:e2e` with `BROWSERPAW_TEST_CHROME` set.',
    patterns: 'Isolated BrowserPaw home and Chrome for Testing E2E harness.',
    internalDeps: ['packages/shared', 'app/native-server'],
    externalDeps: ['Node.js test runner', 'Chrome for Testing'],
  },
};

// Scan non-dot directories
function scanDirectories(baseDir) {
  const dirs = [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Strictly skip hidden dirs and build output
    if (entry.name.startsWith('.')) continue;
    if (
      ['node_modules', 'dist', 'build', '.output', '__pycache__', '.wxt', '__mocks__'].includes(
        entry.name,
      )
    )
      continue;

    const fullPath = path.join(baseDir, entry.name);
    const relPath = path.relative('.', fullPath).replace(/\\/g, '/');
    if (/^(?:research|releases|docs\/archive)(?:\/|$)/.test(relPath)) continue;
    if (relPath === 'test/complex-html-testing') continue;
    // Installable plugin roots are shipped as-is; keep development notes outside them.
    if (/^plugins\/browserpaw(?:-[^/]+)?(?:\/|$)/.test(relPath)) continue;
    if (
      /^skills\/browserpaw(?:\/|$)/.test(relPath) ||
      /^plugins\/[^/]+\/(?:skills|mcp-skills)(?:\/|$)/.test(relPath) ||
      /^plugins\/browserpaw-hermes\/skill-template(?:\/|$)/.test(relPath)
    ) {
      continue;
    }
    dirs.push(relPath);
    dirs.push(...scanDirectories(fullPath));
  }
  return dirs;
}

const allDirs = [
  '.',
  ...scanDirectories('.')
    .filter((dir) => Object.hasOwn(METADATA, dir))
    .sort(),
];
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
    externalDeps: [],
  };

  // Inspect physical directory contents
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const dirPrefix = isRoot ? '' : dirPath.replace(/\\/g, '/') + '/';
  const files = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name !== 'AGENTS.md' &&
        !e.name.startsWith('.') &&
        trackedFiles.has(dirPrefix + e.name),
    )
    .map((e) => e.name)
    .sort();

  const subdirs = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith('.') &&
        !['node_modules', 'dist', 'build', '.output', '__pycache__', '.wxt', '__mocks__'].includes(
          e.name,
        ),
    )
    .map((e) => e.name)
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
      const knownFile = meta.keyFiles?.find((kf) => kf.name === f);
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
      const desc = childMeta
        ? childMeta.purpose.slice(0, 90).replace(/\n/g, ' ') + '...'
        : 'Directory without additional generated guidance.';
      content += `| \`${s}/\` | ${desc} |\n`;
    }
    content += `\n`;
  }

  // For AI Agents
  content += `## For AI Agents\n\n`;
  content += `### Working In This Directory\n`;
  const instructions =
    meta.instructions && meta.instructions.length > 0
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

// Optional path arguments restrict the write set; without them the whole tree is regenerated.
const requested = process.argv
  .slice(2)
  .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '') || '.');
const writeDirs =
  requested.length > 0 ? sortedDirs.filter((d) => requested.includes(d)) : sortedDirs;
for (const dir of requested) {
  if (!sortedDirs.includes(dir)) {
    console.error(`Unknown directory: ${dir}`);
    process.exit(1);
  }
}

console.log(`Generating AGENTS.md across ${writeDirs.length} directories in hierarchical order...`);

let writtenCount = 0;
for (const dir of writeDirs) {
  const targetPath = path.join(dir, 'AGENTS.md');
  let markdown = generateAgentsMd(dir);
  if (fs.existsSync(targetPath)) {
    const manual = fs.readFileSync(targetPath, 'utf-8').match(/^## Manual Notes\r?\n([\s\S]*)$/m);
    if (manual)
      markdown = markdown.replace(
        /(## Manual Notes\n)[\s\S]*$/,
        (_, heading) => heading + manual[1],
      );
  }
  fs.writeFileSync(targetPath, markdown, 'utf-8');
  writtenCount++;
}

console.log(`Successfully generated and wrote ${writtenCount} AGENTS.md files.`);
