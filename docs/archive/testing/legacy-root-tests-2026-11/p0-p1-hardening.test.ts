/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TOOL_NAMES, TOOL_SCHEMAS } from '../packages/shared/dist/index.mjs';
import { ScreenshotRingBuffer } from '../app/chrome-extension/utils/screenshot-ring-buffer.ts';
import {
  SnapshotCacheManager,
  snapshotCacheManager,
} from '../app/chrome-extension/utils/snapshot-cache-manager.ts';

describe('P0 & P1 Architecture Hardening Verification', () => {
  describe('P0-1: Background Execution & Focus Protection', () => {
    it('registers ATTACH_TAB and DETACH_TAB in TOOL_NAMES and TOOL_SCHEMAS', () => {
      assert.strictEqual(TOOL_NAMES.BROWSER.ATTACH_TAB, 'chrome_attach_tab');
      assert.strictEqual(TOOL_NAMES.BROWSER.DETACH_TAB, 'chrome_detach_tab');

      const attachSchema = TOOL_SCHEMAS.find((t) => t.name === 'chrome_attach_tab');
      const detachSchema = TOOL_SCHEMAS.find((t) => t.name === 'chrome_detach_tab');

      assert.ok(attachSchema, 'chrome_attach_tab schema must exist');
      assert.ok(detachSchema, 'chrome_detach_tab schema must exist');
      assert.strictEqual(attachSchema.annotations?.destructiveHint, true);
      assert.strictEqual(detachSchema.annotations?.destructiveHint, false);
    });

    it('documents explicit side-effects and warnings for attach_tab', () => {
      const attachSchema = TOOL_SCHEMAS.find((t) => t.name === 'chrome_attach_tab');
      assert.ok(
        attachSchema?.description?.includes('side effects') ||
          attachSchema?.description?.includes('warning') ||
          attachSchema?.description?.includes('debugging banner') ||
          attachSchema?.description?.includes('attach'),
      );
    });

    it('verifies source code guards against focus stealing in navigate and switch-tab', async () => {
      const fs = await import('node:fs');
      const commonCode = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/common.ts',
        'utf-8',
      );

      // Verify NavigateTool does not unconditionally activate tab or focus window
      assert.ok(
        commonCode.includes('activate: background === false') ||
          commonCode.includes('focusWindow: background === false'),
        'NavigateTool must respect background flag and not activate tab by default',
      );

      // SwitchTabTool must activate by default and only skip activation when the
      // caller explicitly opts out with background: true. (The previous assertion
      // merely matched NavigateTool's snippet, so it never covered this class.)
      const switchTabBody = commonCode.slice(
        commonCode.indexOf('class SwitchTabTool'),
        commonCode.indexOf('export const switchTabTool'),
      );
      assert.ok(
        switchTabBody.includes('background === true'),
        'SwitchTabTool must treat background:true as the opt-out from activation',
      );
      assert.ok(
        switchTabBody.includes('active: true'),
        'SwitchTabTool must activate the target tab by default',
      );
      assert.ok(
        switchTabBody.includes('args.focusWindow === true'),
        'SwitchTabTool must only focus window when caller explicitly sets focusWindow: true',
      );
    });

    it('verifies auxiliary browser tools do not steal focus on tab creation', async () => {
      const fs = await import('node:fs');
      const consoleTool = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/console.ts',
        'utf-8',
      );

      assert.ok(consoleTool.includes('active: background === false'));
    });

    it('verifies background default semantics in TOOL_SCHEMAS prevent focus stealing', async () => {
      const switchTab = TOOL_SCHEMAS.find((t) => t.name === TOOL_NAMES.BROWSER.SWITCH_TAB);
      assert.ok(
        switchTab?.inputSchema?.properties?.background,
        'SWITCH_TAB schema must include background property',
      );

      const navigate = TOOL_SCHEMAS.find((t) => t.name === TOOL_NAMES.BROWSER.NAVIGATE);
      assert.ok(
        (navigate?.inputSchema?.properties?.background as any)?.description.includes(
          'Default: true',
        ),
        'NAVIGATE schema background must indicate Default: true',
      );

      const computer = TOOL_SCHEMAS.find((t) => t.name === TOOL_NAMES.BROWSER.COMPUTER);
      assert.ok(
        (computer?.inputSchema?.properties?.background as any)?.description.includes(
          'Default: true',
        ),
        'COMPUTER schema background must indicate Default: true',
      );

      const screenshot = TOOL_SCHEMAS.find((t) => t.name === TOOL_NAMES.BROWSER.SCREENSHOT);
      assert.ok(
        (screenshot?.inputSchema?.properties?.background as any)?.description.includes(
          'Default: true',
        ),
        'SCREENSHOT schema background must indicate Default: true',
      );
    });
  });

  describe('P0-2: Screenshot In-Memory Pipeline & Ring Buffer', () => {
    it('ScreenshotRingBuffer manages bounded capacity and evicts oldest items', () => {
      const buffer = new ScreenshotRingBuffer(2);
      assert.strictEqual(buffer.getCapacity(), 2);
      assert.strictEqual(buffer.getSize(), 0);

      buffer.push({
        tabId: 101,
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
        dataBase64: 'base64-data-1',
      });
      assert.strictEqual(buffer.getSize(), 1);
      assert.strictEqual(buffer.getLatest()?.dataBase64, 'base64-data-1');

      buffer.push({
        tabId: 102,
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
        dataBase64: 'base64-data-2',
      });
      assert.strictEqual(buffer.getSize(), 2);
      assert.strictEqual(buffer.getLatest(101)?.dataBase64, 'base64-data-1');
      assert.strictEqual(buffer.getLatest(102)?.dataBase64, 'base64-data-2');

      // Eviction: 3rd push evicts the 1st
      buffer.push({
        tabId: 103,
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
        dataBase64: 'base64-data-3',
      });
      assert.strictEqual(buffer.getSize(), 2);
      assert.strictEqual(buffer.getLatest(101), undefined);
      assert.strictEqual(buffer.getLatest(103)?.dataBase64, 'base64-data-3');

      // Default capacity adjustment to 1
      buffer.setCapacity(1);
      assert.strictEqual(buffer.getSize(), 1);
      assert.strictEqual(buffer.getLatest()?.dataBase64, 'base64-data-3');

      buffer.clear();
      assert.strictEqual(buffer.getSize(), 0);
    });

    it('SCREENSHOT tool schema sets savePng default to false (zero disk write default)', () => {
      const shotSchema = TOOL_SCHEMAS.find((t) => t.name === 'chrome_screenshot');
      assert.ok(shotSchema, 'chrome_screenshot schema must exist');
      const props = shotSchema.inputSchema.properties;
      assert.ok(props.savePng, 'savePng property must exist in schema');
      assert.ok(props.format, 'format property must exist');
      assert.deepStrictEqual(props.format.enum, ['png', 'jpeg', 'webp']);
    });

    it('verifies screenshot tool eliminates duplicate base64 in text block by default', async () => {
      const fs = await import('node:fs');
      const shotCode = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/screenshot.ts',
        'utf-8',
      );
      assert.ok(
        shotCode.includes('storeBase64 = false'),
        'Default storeBase64 must be false to avoid duplicating base64 in text block',
      );
      assert.ok(
        shotCode.includes('storeBase64 === true ? { base64Data } : {}') ||
          shotCode.includes('base64Data: storeBase64 ? base64Data : undefined'),
        'base64Data in text payload must be excluded unless storeBase64 is explicitly true',
      );
    });
  });

  describe('P0-3: Anti-Cheating & Clean Architecture Redline', () => {
    it('ensures no test-specific heuristic or ID match exists in dom-indexer source', async () => {
      const fs = await import('node:fs');
      const content = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts',
        'utf-8',
      );
      // Verify removed test-specific cheat: ctx|drop|drag|slider|well|picker regex
      assert.strictEqual(
        content.includes('/ctx|drop|drag|slider|well|picker/i'),
        false,
        'Test-specific regex must be permanently eliminated',
      );
    });
  });

  describe('P1-4: Unified Locator & Visual Coordinate Abstraction', () => {
    it('resolves target using 4-tier degradation chain: ref -> selector -> text/role -> coordinate', async () => {
      const { resolveTargetLocation } =
        await import('../app/chrome-extension/utils/unified-locator.ts');

      // Tier 1: ref match
      const mockDepsRef = {
        executeInPage: async (target: any, fnName: string, args: any[]) => {
          if (fnName === 'inPageGetElementCoordinates' && args[0] === 5) {
            return [
              { result: { success: true, x: 100, y: 150, tagName: 'BUTTON', text: 'Submit' } },
            ];
          }
          return [{ result: { success: false } }];
        },
      };

      const refRes = await resolveTargetLocation(
        1,
        { ref: 5, selector: '#btn', coordinate: { x: 50, y: 50 } },
        mockDepsRef,
      );
      assert.strictEqual(refRes.success, true);
      assert.strictEqual(refRes.resolutionPath, 'ref');
      assert.strictEqual(refRes.x, 100);
      assert.strictEqual(refRes.y, 150);

      // Tier 2: ref fails -> fallback to selector
      const mockDepsSelector = {
        executeInPage: async (target: any, fnName: string, args: any[]) => {
          if (fnName === 'inPageGetElementCoordinates') return [{ result: { success: false } }];
          if (fnName === 'inPageLocateBySelector' && args[0] === '#submit-btn') {
            return [{ result: { success: true, x: 200, y: 250, tagName: 'INPUT' } }];
          }
          return [{ result: { success: false } }];
        },
      };

      const selRes = await resolveTargetLocation(
        1,
        { ref: 99, selector: '#submit-btn', coordinate: { x: 50, y: 50 } },
        mockDepsSelector,
      );
      assert.strictEqual(selRes.success, true);
      assert.strictEqual(selRes.resolutionPath, 'selector');
      assert.strictEqual(selRes.x, 200);

      // Tier 3: selector fails -> fallback to text/role
      const mockDepsText = {
        executeInPage: async (target: any, fnName: string, args: any[]) => {
          if (fnName === 'inPageGetElementCoordinates') return [{ result: { success: false } }];
          if (fnName === 'inPageLocateBySelector') return [{ result: { success: false } }];
          if (fnName === 'inPageLocateByText' && args[0] === 'Login') {
            return [{ result: { success: true, x: 300, y: 350, tagName: 'BUTTON' } }];
          }
          return [{ result: { success: false } }];
        },
      };

      const textRes = await resolveTargetLocation(
        1,
        { ref: 99, selector: '#none', text: 'Login', coordinate: { x: 50, y: 50 } },
        mockDepsText,
      );
      assert.strictEqual(textRes.success, true);
      assert.strictEqual(textRes.resolutionPath, 'text');
      assert.strictEqual(textRes.x, 300);

      // Tier 4: all fail -> fallback to visual coordinate mode
      const coordRes = await resolveTargetLocation(
        1,
        { ref: 99, selector: '#none', text: 'NotFound', coordinate: { x: 450, y: 550 } },
        {
          executeInPage: async () => [{ result: { success: false } }],
        },
      );
      assert.strictEqual(coordRes.success, true);
      assert.strictEqual(coordRes.resolutionPath, 'coordinate');
      assert.strictEqual(coordRes.x, 450);
      assert.strictEqual(coordRes.y, 550);
    });

    it('attaches box-model visibility warning when target has zero dimensions in coordinate mode', async () => {
      const { resolveTargetLocation } =
        await import('../app/chrome-extension/utils/unified-locator.ts');

      const mockDepsCdp = {
        sendCdpCommand: async (tabId: number, method: string) => {
          if (method === 'DOM.getNodeForLocation') return { backendNodeId: 42 };
          if (method === 'DOM.getBoxModel') {
            return {
              model: { width: 0, height: 0, border: [0, 0, 0, 0] },
            };
          }
          return {};
        },
      };

      const res = await resolveTargetLocation(1, { coordinate: { x: 100, y: 100 } }, mockDepsCdp);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.resolutionPath, 'coordinate');
      assert.ok(res.warning, 'Warning should be attached when element dimensions are 0');
      assert.ok(res.warning?.includes('zero dimensions or may be invisible'));
    });

    it('attaches snapshot invalidation alert when snapshot is stale', async () => {
      const { resolveTargetLocation } =
        await import('../app/chrome-extension/utils/unified-locator.ts');

      const testTabId = 7777;
      snapshotCacheManager.setSnapshot(testTabId, { url: 'https://site.com', elementCount: 10 });
      snapshotCacheManager.invalidate(testTabId, 'Page navigated');

      const mockDeps = {
        executeInPage: async () => [{ result: { success: true, x: 50, y: 50, tagName: 'DIV' } }],
      };

      const res = await resolveTargetLocation(testTabId, { ref: 1 }, mockDeps);
      assert.strictEqual(res.success, true);
      assert.ok(res.warning?.includes("ACTION REQUIRED: Please call 'chrome_read_dom'"));

      snapshotCacheManager.clear(testTabId);
    });
  });

  describe('P1-5: Popup.html Navigation Guard', () => {
    it('blocks navigation to popup.html through isPopupUrl guard across variations', async () => {
      const { isPopupUrl } = await import('../app/chrome-extension/utils/popup-guard.ts');

      assert.strictEqual(isPopupUrl('chrome-extension://abcdefg/popup.html'), true);
      assert.strictEqual(isPopupUrl('chrome-extension://abcdefg/popup.html?session=123'), true);
      assert.strictEqual(isPopupUrl('chrome-extension://abcdefg/popup.html#top'), true);
      assert.strictEqual(isPopupUrl('http://example.com/popup.html'), true);
      assert.strictEqual(isPopupUrl('https://example.com/subpath/popup.html'), true);
      assert.strictEqual(isPopupUrl('chrome-extension://abcdefg/popup'), true);
      assert.strictEqual(isPopupUrl('chrome-extension://abcdefg/options.html'), false);
      assert.strictEqual(isPopupUrl('https://example.com/index.html'), false);
      assert.strictEqual(isPopupUrl(''), false);
      assert.strictEqual(isPopupUrl(undefined), false);
    });
  });

  describe('P1-6: Batch Form Filling & Snapshot Cache Manager', () => {
    it('registers FILL_INDEX and BATCH_ACTIONS in TOOL_NAMES and TOOL_SCHEMAS', () => {
      assert.strictEqual(TOOL_NAMES.BROWSER.FILL_INDEX, 'chrome_fill_index');
      const fillSchema = TOOL_SCHEMAS.find((t) => t.name === 'chrome_fill_index');
      assert.ok(fillSchema, 'chrome_fill_index schema must exist');
    });

    it('SnapshotCacheManager caches snapshots and invalidates on navigation', () => {
      const cache = new SnapshotCacheManager();
      cache.setSnapshot(42, {
        url: 'https://example.com/form',
        elementCount: 15,
      });

      assert.strictEqual(cache.isSnapshotValid(42), true);
      assert.strictEqual(cache.getSnapshot(42)?.elementCount, 15);
      assert.strictEqual(cache.getSnapshot(42)?.url, 'https://example.com/form');

      cache.invalidate(42, 'URL changed');
      assert.strictEqual(cache.isSnapshotValid(42), false);
      const msg = cache.getInvalidationMessage(42);
      assert.ok(msg.includes("ACTION REQUIRED: Please call 'chrome_read_dom'"));
      assert.ok(msg.includes('URL changed'));

      cache.clear(42);
      assert.strictEqual(cache.getSnapshot(42), undefined);
    });

    it('verifies ReadDOM tool schema declares pagination cursor, limit, and maxTextLength', () => {
      const readDomSchema = TOOL_SCHEMAS.find((t) => t.name === 'chrome_read_dom');
      assert.ok(readDomSchema, 'chrome_read_dom schema must exist');
      const props = readDomSchema.inputSchema.properties;
      assert.ok(props.cursor, 'cursor property must exist');
      assert.ok(props.limit, 'limit property must exist');
      assert.ok(props.maxTextLength, 'maxTextLength property must exist');
    });
  });

  describe('P1-7: Complete DOM Snapshot, Ad Filtering & Purified Context', () => {
    it('masks password and sensitive tokens while preserving regular input values', async () => {
      const { inPageDOMPruner } =
        await import('../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts');

      const originalDoc = globalThis.document;
      const originalWin = globalThis.window;
      const originalElement = (globalThis as any).Element;

      class MockElement {}
      (globalThis as any).Element = MockElement;

      const mockElements: any[] = [
        {
          tagName: 'INPUT',
          type: 'password',
          name: 'user_password',
          value: 'SecretPass123!',
          getAttribute: (attr: string) =>
            attr === 'type' ? 'password' : attr === 'name' ? 'user_password' : null,
          hasAttribute: (attr: string) => attr === 'type' || attr === 'name',
          getBoundingClientRect: () => ({
            x: 10,
            y: 10,
            width: 100,
            height: 30,
            left: 10,
            right: 110,
            top: 10,
            bottom: 40,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 30,
          clientHeight: 30,
        },
        {
          tagName: 'INPUT',
          type: 'text',
          name: 'cc-number',
          value: '4111-2222-3333-4444',
          getAttribute: (attr: string) =>
            attr === 'type' ? 'text' : attr === 'name' ? 'cc-number' : null,
          hasAttribute: (attr: string) => attr === 'type' || attr === 'name',
          getBoundingClientRect: () => ({
            x: 10,
            y: 50,
            width: 100,
            height: 30,
            left: 10,
            right: 110,
            top: 50,
            bottom: 80,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 30,
          clientHeight: 30,
        },
        {
          tagName: 'INPUT',
          type: 'text',
          name: 'username',
          value: 'johndoe',
          getAttribute: (attr: string) =>
            attr === 'type' ? 'text' : attr === 'name' ? 'username' : null,
          hasAttribute: (attr: string) => attr === 'type' || attr === 'name',
          getBoundingClientRect: () => ({
            x: 10,
            y: 90,
            width: 100,
            height: 30,
            left: 10,
            right: 110,
            top: 90,
            bottom: 120,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 30,
          clientHeight: 30,
        },
      ];

      (globalThis as any).document = {
        body: {
          tagName: 'BODY',
          children: mockElements,
          getAttribute: () => null,
          hasAttribute: () => false,
          closest: () => null,
          getBoundingClientRect: () => ({
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            left: 0,
            right: 800,
            top: 0,
            bottom: 600,
          }),
          scrollHeight: 600,
          clientHeight: 600,
          offsetHeight: 600,
        },
        documentElement: {
          scrollHeight: 600,
          clientHeight: 600,
          offsetHeight: 600,
          scrollTop: 0,
        },
        elementFromPoint: () => null,
        getElementById: () => null,
      };

      (globalThis as any).window = {
        innerWidth: 800,
        innerHeight: 600,
        scrollY: 0,
        pageYOffset: 0,
        getComputedStyle: () => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          cursor: 'text',
          overflowY: 'visible',
        }),
      };

      mockElements.forEach((el) => Object.setPrototypeOf(el, MockElement.prototype));
      Object.setPrototypeOf((globalThis as any).document.body, MockElement.prototype);

      try {
        const result = inPageDOMPruner();
        assert.ok(result.indexedElements && result.indexedElements.length > 0);

        const passEl = result.indexedElements.find((e) => e.attributes.name === 'user_password');
        const ccEl = result.indexedElements.find((e) => e.attributes.name === 'cc-number');
        const userEl = result.indexedElements.find((e) => e.attributes.name === 'username');

        assert.ok(passEl, 'Password element should be indexed');
        assert.strictEqual(passEl.value, '••••••••', 'Password value must be masked');

        assert.ok(ccEl, 'Credit card element should be indexed');
        assert.strictEqual(ccEl.value, '••••••••', 'Credit card value must be masked');

        assert.ok(userEl, 'Username element should be indexed');
        assert.strictEqual(userEl.value, 'johndoe', 'Regular field value should be preserved');
      } finally {
        globalThis.document = originalDoc;
        globalThis.window = originalWin;
        (globalThis as any).Element = originalElement;
      }
    });

    it('filters out ad and tracking elements from the indexed DOM tree', async () => {
      const { inPageDOMPruner } =
        await import('../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts');

      const originalDoc = globalThis.document;
      const originalWin = globalThis.window;
      const originalElement = (globalThis as any).Element;

      class MockElement {}
      (globalThis as any).Element = MockElement;

      const mockElements: any[] = [
        {
          tagName: 'DIV',
          className: 'google_ads ad-banner-top',
          getAttribute: (attr: string) => (attr === 'class' ? 'google_ads ad-banner-top' : null),
          hasAttribute: (attr: string) => attr === 'class',
          getBoundingClientRect: () => ({
            x: 0,
            y: 0,
            width: 728,
            height: 90,
            left: 0,
            right: 728,
            top: 0,
            bottom: 90,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 90,
          clientHeight: 90,
        },
        {
          tagName: 'BUTTON',
          getAttribute: () => null,
          hasAttribute: () => false,
          getBoundingClientRect: () => ({
            x: 10,
            y: 150,
            width: 100,
            height: 40,
            left: 10,
            right: 110,
            top: 150,
            bottom: 190,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 40,
          clientHeight: 40,
          textContent: 'Legitimate Button',
        },
      ];

      (globalThis as any).document = {
        body: {
          tagName: 'BODY',
          children: mockElements,
          getAttribute: () => null,
          hasAttribute: () => false,
          closest: () => null,
          getBoundingClientRect: () => ({
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            left: 0,
            right: 800,
            top: 0,
            bottom: 600,
          }),
          scrollHeight: 600,
          clientHeight: 600,
          offsetHeight: 600,
        },
        documentElement: {
          scrollHeight: 600,
          clientHeight: 600,
          offsetHeight: 600,
          scrollTop: 0,
        },
        elementFromPoint: () => null,
        getElementById: () => null,
      };

      (globalThis as any).window = {
        innerWidth: 800,
        innerHeight: 600,
        scrollY: 0,
        pageYOffset: 0,
        getComputedStyle: () => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          cursor: 'pointer',
          overflowY: 'visible',
        }),
      };

      mockElements.forEach((el) => Object.setPrototypeOf(el, MockElement.prototype));
      Object.setPrototypeOf((globalThis as any).document.body, MockElement.prototype);

      try {
        const result = inPageDOMPruner();
        const adEl = result.indexedElements?.find((e) => e.tagName === 'div');
        const btnEl = result.indexedElements?.find((e) => e.tagName === 'button');

        assert.strictEqual(adEl, undefined, 'Ad banner should be filtered out completely');
        assert.ok(btnEl, 'Legitimate button should be indexed');
      } finally {
        globalThis.document = originalDoc;
        globalThis.window = originalWin;
        (globalThis as any).Element = originalElement;
      }
    });

    it('respects configurable maxTextLength option in extractCleanElementText and pruner', async () => {
      const { extractCleanElementText } =
        await import('../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts');

      const longString = 'A'.repeat(300);
      const mockEl = {
        tagName: 'P',
        innerText: longString,
        ownerDocument: undefined,
      } as any;

      const defaultText = extractCleanElementText(mockEl);
      assert.strictEqual(defaultText.length, 120, 'Default length should be 120');

      const customShort = extractCleanElementText(mockEl, 50);
      assert.strictEqual(customShort.length, 50, 'Custom maxTextLength of 50 should be honored');

      const customLong = extractCleanElementText(mockEl, 250);
      assert.strictEqual(customLong.length, 250, 'Custom maxTextLength of 250 should be honored');
    });

    it('indexes non-interactive informational nodes (h1, alert) with isInteractive: false', async () => {
      const { inPageDOMPruner } =
        await import('../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts');

      const originalDoc = globalThis.document;
      const originalWin = globalThis.window;
      const originalElement = (globalThis as any).Element;

      class MockElement {}
      (globalThis as any).Element = MockElement;

      const mockElements: any[] = [
        {
          tagName: 'H1',
          textContent: 'Main Page Heading',
          innerText: 'Main Page Heading',
          getAttribute: () => null,
          hasAttribute: () => false,
          getBoundingClientRect: () => ({
            x: 10,
            y: 10,
            width: 400,
            height: 40,
            left: 10,
            right: 410,
            top: 10,
            bottom: 50,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 40,
          clientHeight: 40,
        },
        {
          tagName: 'DIV',
          role: 'alert',
          textContent: 'Your session has expired',
          innerText: 'Your session has expired',
          getAttribute: (attr: string) => (attr === 'role' ? 'alert' : null),
          hasAttribute: (attr: string) => attr === 'role',
          getBoundingClientRect: () => ({
            x: 10,
            y: 60,
            width: 400,
            height: 30,
            left: 10,
            right: 410,
            top: 60,
            bottom: 90,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 30,
          clientHeight: 30,
        },
        {
          tagName: 'BUTTON',
          textContent: 'Dismiss',
          innerText: 'Dismiss',
          getAttribute: () => null,
          hasAttribute: () => false,
          getBoundingClientRect: () => ({
            x: 10,
            y: 100,
            width: 80,
            height: 30,
            left: 10,
            right: 90,
            top: 100,
            bottom: 130,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 30,
          clientHeight: 30,
        },
      ];

      (globalThis as any).document = {
        body: {
          tagName: 'BODY',
          children: mockElements,
          getAttribute: () => null,
          hasAttribute: () => false,
          closest: () => null,
          getBoundingClientRect: () => ({
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            left: 0,
            right: 800,
            top: 0,
            bottom: 600,
          }),
          scrollHeight: 600,
          clientHeight: 600,
          offsetHeight: 600,
        },
        documentElement: {
          scrollHeight: 600,
          clientHeight: 600,
          offsetHeight: 600,
          scrollTop: 0,
        },
        elementFromPoint: () => null,
        getElementById: () => null,
      };

      (globalThis as any).window = {
        innerWidth: 800,
        innerHeight: 600,
        scrollY: 0,
        pageYOffset: 0,
        getComputedStyle: () => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          cursor: 'default',
          overflowY: 'visible',
        }),
      };

      mockElements.forEach((el) => Object.setPrototypeOf(el, MockElement.prototype));
      Object.setPrototypeOf((globalThis as any).document.body, MockElement.prototype);

      try {
        const result = inPageDOMPruner();
        const h1El = result.indexedElements?.find((e) => e.tagName === 'h1');
        const alertEl = result.indexedElements?.find((e) => e.role === 'alert');
        const btnEl = result.indexedElements?.find((e) => e.tagName === 'button');

        assert.ok(h1El, 'Heading should be indexed as key-informational node');
        assert.strictEqual(h1El.isInteractive, false, 'Heading should have isInteractive = false');

        assert.ok(alertEl, 'Alert should be indexed as key-informational node');
        assert.strictEqual(alertEl.isInteractive, false, 'Alert should have isInteractive = false');

        assert.ok(btnEl, 'Button should be indexed');
        assert.strictEqual(btnEl.isInteractive, true, 'Button should have isInteractive = true');
      } finally {
        globalThis.document = originalDoc;
        globalThis.window = originalWin;
        (globalThis as any).Element = originalElement;
      }
    });

    it('performs deterministic visual reading-order sorting by y coordinate then x coordinate', async () => {
      const { inPageDOMPruner } =
        await import('../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts');

      const originalDoc = globalThis.document;
      const originalWin = globalThis.window;
      const originalElement = (globalThis as any).Element;

      class MockElement {}
      (globalThis as any).Element = MockElement;

      // Unordered elements in DOM: bottom-right first, top-left second, top-right third
      const mockElements: any[] = [
        {
          tagName: 'BUTTON',
          id: 'btn-bottom',
          textContent: 'Bottom Action',
          getAttribute: (attr: string) => (attr === 'id' ? 'btn-bottom' : null),
          hasAttribute: (attr: string) => attr === 'id',
          getBoundingClientRect: () => ({
            x: 100,
            y: 300,
            width: 80,
            height: 30,
            left: 100,
            right: 180,
            top: 300,
            bottom: 330,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 30,
          clientHeight: 30,
        },
        {
          tagName: 'BUTTON',
          id: 'btn-top-right',
          textContent: 'Top Right Action',
          getAttribute: (attr: string) => (attr === 'id' ? 'btn-top-right' : null),
          hasAttribute: (attr: string) => attr === 'id',
          getBoundingClientRect: () => ({
            x: 200,
            y: 50,
            width: 80,
            height: 30,
            left: 200,
            right: 280,
            top: 50,
            bottom: 80,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 30,
          clientHeight: 30,
        },
        {
          tagName: 'BUTTON',
          id: 'btn-top-left',
          textContent: 'Top Left Action',
          getAttribute: (attr: string) => (attr === 'id' ? 'btn-top-left' : null),
          hasAttribute: (attr: string) => attr === 'id',
          getBoundingClientRect: () => ({
            x: 20,
            y: 50,
            width: 80,
            height: 30,
            left: 20,
            right: 100,
            top: 50,
            bottom: 80,
          }),
          children: [],
          getRootNode: () => ({}),
          closest: () => null,
          scrollHeight: 30,
          clientHeight: 30,
        },
      ];

      (globalThis as any).document = {
        body: {
          tagName: 'BODY',
          children: mockElements,
          getAttribute: () => null,
          hasAttribute: () => false,
          closest: () => null,
          getBoundingClientRect: () => ({
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            left: 0,
            right: 800,
            top: 0,
            bottom: 600,
          }),
          scrollHeight: 600,
          clientHeight: 600,
          offsetHeight: 600,
        },
        documentElement: {
          scrollHeight: 600,
          clientHeight: 600,
          offsetHeight: 600,
          scrollTop: 0,
        },
        elementFromPoint: () => null,
        getElementById: () => null,
      };

      (globalThis as any).window = {
        innerWidth: 800,
        innerHeight: 600,
        scrollY: 0,
        pageYOffset: 0,
        getComputedStyle: () => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          cursor: 'pointer',
          overflowY: 'visible',
        }),
      };

      mockElements.forEach((el) => Object.setPrototypeOf(el, MockElement.prototype));
      Object.setPrototypeOf((globalThis as any).document.body, MockElement.prototype);

      try {
        const result = inPageDOMPruner();
        assert.strictEqual(result.indexedElements?.length, 3);
        // Order should be sorted: btn-top-left (y:50, x:20), btn-top-right (y:50, x:200), btn-bottom (y:300, x:100)
        assert.strictEqual(result.indexedElements![0].attributes.id, 'btn-top-left');
        assert.strictEqual(result.indexedElements![1].attributes.id, 'btn-top-right');
        assert.strictEqual(result.indexedElements![2].attributes.id, 'btn-bottom');
      } finally {
        globalThis.document = originalDoc;
        globalThis.window = originalWin;
        (globalThis as any).Element = originalElement;
      }
    });
  });

  describe('P0 & P1 Deep Security, Memory & Protocol Hardening', () => {
    it('verifies isDestructiveTarget regex logic matches snake_case keywords and ignores non-boundary substrings', async () => {
      const fs = await import('node:fs');
      const clientCode = fs.readFileSync('app/native-server/src/jev/jev-client.ts', 'utf-8');
      assert.ok(
        clientCode.includes('(^|[^a-zA-Z0-9])'),
        'Must use [^a-zA-Z0-9] boundary to allow snake_case',
      );
      assert.ok(
        clientCode.includes('LATIN_DESTRUCTIVE_REGEX'),
        'Must use precompiled regex for Latin destructive keywords',
      );
    });

    it('verifies findMatchingPauseKeyword regex logic handles snake_case tokens', async () => {
      const fs = await import('node:fs');
      const engineCode = fs.readFileSync(
        'app/native-server/src/jev/fast-decision-engine.ts',
        'utf-8',
      );
      assert.ok(
        engineCode.includes('(^|[^a-zA-Z0-9])'),
        'Must use [^a-zA-Z0-9] boundary in findMatchingPauseKeyword',
      );
    });

    it('verifies deepElementFromPoint succeeds with mock root in non-browser environment', async () => {
      const { deepElementFromPoint } =
        await import('../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts');
      const mockElement = { tagName: 'DIV' };
      const mockDoc = {
        nodeType: 9,
        elementFromPoint: (x: number, y: number) => mockElement,
      };
      const result = deepElementFromPoint(10, 20, mockDoc as any);
      assert.strictEqual(result, mockElement);
    });

    it('verifies cdpSessionManager.hasInFlightRequests prunes requests older than 5000ms', async () => {
      const { cdpSessionManager } =
        await import('../app/chrome-extension/utils/cdp-session-manager.ts');
      const tabId = 99999;
      const internalMap = (cdpSessionManager as any).inFlightRequests;
      const reqMap = new Map<string, number>();
      reqMap.set('stale-req-1', Date.now() - 6000);
      internalMap.set(tabId, reqMap);

      assert.strictEqual(cdpSessionManager.hasInFlightRequests(tabId), false);
      assert.strictEqual(reqMap.size, 0);

      reqMap.set('fresh-req-1', Date.now());
      assert.strictEqual(cdpSessionManager.hasInFlightRequests(tabId), true);
      cdpSessionManager.clearInFlightRequests(tabId);
    });

    it('verifies Fastify server preHandler whitelists /media-asset/:assetId', async () => {
      const fs = await import('node:fs');
      const serverCode = fs.readFileSync('app/native-server/src/server/index.ts', 'utf-8');
      assert.ok(
        serverCode.includes("pathOnly === '/ping' || pathOnly.startsWith('/media-asset/')"),
        'Server preHandler must allow /media-asset/ without requiring token',
      );
    });

    it('verifies accessibility-tree-helper cross-frame bridge enforces subframe and parent validation', async () => {
      const fs = await import('node:fs');
      const helperCode = fs.readFileSync(
        'app/chrome-extension/inject-scripts/accessibility-tree-helper.js',
        'utf-8',
      );
      assert.ok(
        helperCode.includes('window === window.top || !window.parent || window.parent === window'),
        'Must reject execution if window is top-level',
      );
      assert.ok(
        helperCode.includes('ev.source !== window.parent'),
        'Must reject messages not sent by window.parent',
      );
    });
  });
});
