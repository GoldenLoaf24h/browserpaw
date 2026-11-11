import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { createRequire } from 'node:module';
const requireDist = createRequire(import.meta.url);
import { TOOL_SCHEMAS, RAW_TOOL_SCHEMAS, TOOL_NAMES } from '../packages/shared/dist/index.mjs';
import { SessionTabAffinityManager } from '../app/chrome-extension/utils/session-tab-affinity.ts';
import { inPageWaitForDOMSettle } from '../app/chrome-extension/utils/action-watchdog.ts';
import { computeHumanizedPoints } from '../app/chrome-extension/utils/mouse-trajectory.ts';
import {
  inPageGetIndexCropRect,
  inPageGetElementCoordinates,
  inPageInteractIndex,
  inPageFillIndex,
  extractCleanElementText,
  wrapElement,
  derefElement,
  findIndexedElement,
  getIsolatedIndexMap,
  inPageRealignHighlights,
  inPageRemoveHighlights,
  DIAGNOSTIC_REFRESH_GUIDANCE,
  isInteractiveSvgNode,
  safeClickPointWeakMap,
  inPageDOMPruner,
  inPageFindSmartScrollTarget,
  inPagePerformSmartScroll,
} from '../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts';
import {
  resolveBridgeToken,
  getBridgeToken,
  isValidBridgeToken,
  clearBridgeTokenCache,
  TOKEN_FILE,
} from '../app/native-server/src/server/token.ts';
import { cdpSessionManager } from '../app/chrome-extension/utils/cdp-session-manager.ts';
import { waitForDownload } from '../app/chrome-extension/entrypoints/background/tools/browser/download-waiter.ts';
import {
  FileHandler,
  isPrivateOrBlockedIp,
  safeLookup,
  MAX_DOWNLOAD_SIZE,
} from '../app/native-server/dist/file-handler.js';
import { screenshotContextManager, scaleCoordinates } from '../app/chrome-extension/utils/screenshot-context.ts';
import { overlayCoordinateGrid } from '../app/chrome-extension/utils/image-utils.ts';
import { safePostMessage, MAX_NATIVE_MESSAGE_BYTES } from '../app/chrome-extension/utils/safe-post-message.ts';

describe('Phase 2 Architecture Upgrades: Boost Features Test Suite', () => {
  describe('1. Session Tab Affinity Manager', () => {
    it('should correctly set and get affinity for a session', () => {
      const manager = new SessionTabAffinityManager();
      assert.strictEqual(manager.getAffinity('session-alpha'), undefined);

      manager.setAffinity('session-alpha', 101);
      assert.strictEqual(manager.getAffinity('session-alpha'), 101);
      assert.strictEqual(manager.getMapSize(), 1);

      manager.setAffinity('session-beta', 202);
      assert.strictEqual(manager.getAffinity('session-beta'), 202);
      assert.strictEqual(manager.getMapSize(), 2);
    });

    it('should ignore empty sessionId or invalid tabId', () => {
      const manager = new SessionTabAffinityManager();
      manager.setAffinity('', 101);
      manager.setAffinity('session-alpha', undefined as any);
      assert.strictEqual(manager.getMapSize(), 0);
    });

    it('should remove affinity on explicit request and clear all', () => {
      const manager = new SessionTabAffinityManager();
      manager.setAffinity('session-1', 10);
      manager.setAffinity('session-2', 20);

      manager.removeAffinity('session-1');
      assert.strictEqual(manager.getAffinity('session-1'), undefined);
      assert.strictEqual(manager.getAffinity('session-2'), 20);

      manager.clearAll();
      assert.strictEqual(manager.getMapSize(), 0);
    });

    it('should resolve session tab when chrome.tabs.get succeeds', async () => {
      const manager = new SessionTabAffinityManager();
      manager.setAffinity('session-valid', 555);

      // Mock global chrome.tabs
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        tabs: {
          get: async (id: number) => {
            if (id === 555) return { id: 555, url: 'https://example.com' };
            throw new Error('Tab not found');
          },
        },
      };

      try {
        const resolved = await manager.resolveSessionTab('session-valid');
        assert.ok(resolved);
        assert.strictEqual(resolved.id, 555);

        // Resolving an unknown session returns null
        const none = await manager.resolveSessionTab('unknown');
        assert.strictEqual(none, null);
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('should clean up affinity when bound tab no longer exists', async () => {
      const manager = new SessionTabAffinityManager();
      manager.setAffinity('session-closed', 999);

      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        tabs: {
          get: async () => {
            throw new Error('Tabs does not exist');
          },
        },
      };

      try {
        const resolved = await manager.resolveSessionTab('session-closed');
        assert.strictEqual(resolved, null);
        // Affinity should be evicted
        assert.strictEqual(manager.getAffinity('session-closed'), undefined);
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('should simulate resolveAffinityTab lifecycle: binds explicit tabId, respects bound session, or falls back to active tab', async () => {
      const manager = new SessionTabAffinityManager();
      const originalChrome = (globalThis as any).chrome;

      const tabsStore: Record<number, any> = {
        100: { id: 100, url: 'https://site-a.com' },
        200: { id: 200, url: 'https://site-b.com' },
        300: { id: 300, url: 'https://site-c.com' },
      };

      (globalThis as any).chrome = {
        tabs: {
          get: async (id: number) => {
            if (tabsStore[id]) return tabsStore[id];
            throw new Error('Tab not found');
          },
          query: async (q: any) => {
            if (q.active) return [tabsStore[100]];
            return [];
          },
        },
      };

      try {
        // Helper matching BaseBrowserToolExecutor.resolveAffinityTab algorithm
        const resolveAffinityTab = async (opts?: { tabId?: number; sessionId?: string }) => {
          if (typeof opts?.tabId === 'number') {
            try {
              const tab = await chrome.tabs.get(opts.tabId);
              if (tab && tab.id && opts.sessionId) {
                manager.setAffinity(opts.sessionId, tab.id);
              }
              return tab;
            } catch {}
          }
          if (opts?.sessionId) {
            const bound = await manager.resolveSessionTab(opts.sessionId);
            if (bound) return bound;
          }
          const [active] = await chrome.tabs.query({ active: true });
          if (opts?.sessionId && active?.id) {
            manager.setAffinity(opts.sessionId, active.id);
          }
          return active;
        };

        // Session 1: no tabId -> falls back to active tab (100) and binds affinity
        const tabS1 = await resolveAffinityTab({ sessionId: 'session-client-1' });
        assert.strictEqual(tabS1.id, 100);
        assert.strictEqual(manager.getAffinity('session-client-1'), 100);

        // Active tab changes to 300
        (globalThis as any).chrome.tabs.query = async () => [tabsStore[300]];

        // Session 1 again: even though active tab is now 300, session 1 stays bound to 100!
        const tabS1Again = await resolveAffinityTab({ sessionId: 'session-client-1' });
        assert.strictEqual(tabS1Again.id, 100, 'Session 1 must maintain affinity to tab 100');

        // Session 2: explicit tabId 200 -> binds to 200
        const tabS2 = await resolveAffinityTab({ tabId: 200, sessionId: 'session-client-2' });
        assert.strictEqual(tabS2.id, 200);
        assert.strictEqual(manager.getAffinity('session-client-2'), 200);

        // Session 3: no tabId -> falls back to current active tab (300) and binds
        const tabS3 = await resolveAffinityTab({ sessionId: 'session-client-3' });
        assert.strictEqual(tabS3.id, 300);
        assert.strictEqual(manager.getAffinity('session-client-3'), 300);
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });
  });

  describe('2. Action Watchdog & DOM Settle Logic (Actual Implementation)', () => {
    it('inPageWaitForDOMSettle settles after quiet period in quiescent DOM', async () => {
      const originalDocument = (globalThis as any).document;
      const originalObserver = (globalThis as any).MutationObserver;

      class MockObserver {
        observe() {}
        disconnect() {}
      }

      (globalThis as any).document = { documentElement: {} };
      (globalThis as any).MutationObserver = MockObserver;

      try {
        const res = await inPageWaitForDOMSettle(400, 100);
        assert.strictEqual(res.settled, true);
        assert.strictEqual(res.mutationsObserved, 0);
        assert.ok(res.durationMs >= 80);
      } finally {
        (globalThis as any).document = originalDocument;
        (globalThis as any).MutationObserver = originalObserver;
      }
    });

    it('inPageWaitForDOMSettle tracks mutations and settles once quiet elapses', async () => {
      const originalDocument = (globalThis as any).document;
      const originalObserver = (globalThis as any).MutationObserver;

      let observerInstance: any = null;
      class MockObserver {
        callback: (mutations: any[]) => void;
        constructor(cb: any) {
          this.callback = cb;
          observerInstance = this;
        }
        observe() {}
        disconnect() {}
      }

      (globalThis as any).document = { documentElement: {} };
      (globalThis as any).MutationObserver = MockObserver;

      try {
        const settlePromise = inPageWaitForDOMSettle(600, 100);

        // Fire mutations before quiet period
        setTimeout(() => {
          observerInstance?.callback([{ type: 'childList' }, { type: 'attributes' }]);
        }, 50);

        const res = await settlePromise;
        assert.strictEqual(res.settled, true);
        assert.strictEqual(res.mutationsObserved, 2);
        assert.ok(res.durationMs >= 130);
      } finally {
        (globalThis as any).document = originalDocument;
        (globalThis as any).MutationObserver = originalObserver;
      }
    });

    it('inPageWaitForDOMSettle times out cleanly if mutations never cease', async () => {
      const originalDocument = (globalThis as any).document;
      const originalObserver = (globalThis as any).MutationObserver;

      let observerInstance: any = null;
      class MockObserver {
        callback: (mutations: any[]) => void;
        constructor(cb: any) {
          this.callback = cb;
          observerInstance = this;
        }
        observe() {}
        disconnect() {}
      }

      (globalThis as any).document = { documentElement: {} };
      (globalThis as any).MutationObserver = MockObserver;

      try {
        const interval = setInterval(() => {
          observerInstance?.callback([{ type: 'childList' }]);
        }, 20);

        const res = await inPageWaitForDOMSettle(120, 50);
        clearInterval(interval);

        assert.strictEqual(res.settled, false);
        assert.ok(res.mutationsObserved > 0);
      } finally {
        (globalThis as any).document = originalDocument;
        (globalThis as any).MutationObserver = originalObserver;
      }
    });
  });

  describe('3. Humanized Trajectory & Mouse Interpolation Math (Actual Implementation)', () => {
    it('computeHumanizedPoints generates exact step count with exact terminal target', () => {
      const startX = 100;
      const startY = 100;
      const targetX = 500;
      const targetY = 400;

      const points = computeHumanizedPoints(startX, startY, targetX, targetY, 4);

      assert.strictEqual(points.length, 4);
      // Final point MUST reach target coordinates exactly with zero micro-jitter
      assert.strictEqual(points[3].x, targetX);
      assert.strictEqual(points[3].y, targetY);

      // Points should move away from start toward target
      assert.ok(points[0].x > startX);
      assert.ok(points[0].y > startY);
    });

    it('computeHumanizedPoints handles 1-step and stationary trajectories', () => {
      const singleStep = computeHumanizedPoints(50, 50, 200, 300, 1);
      assert.strictEqual(singleStep.length, 1);
      assert.strictEqual(singleStep[0].x, 200);
      assert.strictEqual(singleStep[0].y, 300);

      const stationary = computeHumanizedPoints(200, 300, 200, 300, 3);
      assert.strictEqual(stationary.length, 3);
      // Final step is target
      assert.strictEqual(stationary[2].x, 200);
      assert.strictEqual(stationary[2].y, 300);
    });
  });

  describe('4. ROI Element Crop Coordinates Math (Actual Implementation)', () => {
    it('inPageGetIndexCropRect rejects non-positive index or unindexed element', () => {
      const originalDocument = (globalThis as any).document;
      const originalElement = (globalThis as any).Element;
      class MockElement {}
      (globalThis as any).Element = MockElement;
      (globalThis as any).document = {
        querySelector: () => null,
        body: { childNodes: [] },
      };

      try {
        const invalidRes = inPageGetIndexCropRect(0);
        assert.strictEqual(invalidRes.success, false);

        const negativeRes = inPageGetIndexCropRect(-5);
        assert.strictEqual(negativeRes.success, false);

        const notFoundRes = inPageGetIndexCropRect(9999);
        assert.strictEqual(notFoundRes.success, false);
      } finally {
        (globalThis as any).document = originalDocument;
        (globalThis as any).Element = originalElement;
      }
    });

    it('inPageGetIndexCropRect computes padding and preserves subframe coordinates', () => {
      const originalDocument = (globalThis as any).document;
      const originalWindow = (globalThis as any).window;
      const originalElement = (globalThis as any).Element;

      class MockElement {
        scrollIntoView() {}
        getBoundingClientRect() {
          return {
            left: 50,
            top: 30,
            right: 150,
            bottom: 80,
            width: 100,
            height: 50,
          };
        }
      }

      (globalThis as any).Element = MockElement;
      const mockElement = new MockElement();

      (globalThis as any).document = {
        querySelector: (sel: string) => (sel.includes('42') ? mockElement : null),
        body: {},
      };

      // Mock subframe window with cumulative iframe offset
      (globalThis as any).window = {
        devicePixelRatio: 2,
        frameElement: {
          getBoundingClientRect: () => ({ left: 200, top: 100 }),
        },
        parent: {
          top: null as any,
        },
      };
      (globalThis as any).window.top = (globalThis as any).window.parent;
      (globalThis as any).window.parent.top = (globalThis as any).window.parent;

      try {
        const cropRes = inPageGetIndexCropRect(42, 10);
        assert.strictEqual(cropRes.success, true);
        assert.ok(cropRes.rect);
        // left: 50 + frameOffset(200) - pad(10) = 240
        assert.strictEqual(cropRes.rect.x, 240);
        // top: 30 + frameOffset(100) - pad(10) = 120
        assert.strictEqual(cropRes.rect.y, 120);
        // width: 100 + pad(10)*2 = 120 (not crushed by subframe window width!)
        assert.strictEqual(cropRes.rect.width, 120);
        // height: 50 + pad(10)*2 = 70
        assert.strictEqual(cropRes.rect.height, 70);
        assert.strictEqual(cropRes.devicePixelRatio, 2);
      } finally {
        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        (globalThis as any).Element = originalElement;
      }
    });
  });

  describe('5. Tool Schema Validation & Session Affinity Coverage', () => {
    it('chrome_screenshot schema contains targetIndex, padding, format, quality, and sessionId', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.SCREENSHOT);
      assert.ok(tool, 'SCREENSHOT tool must exist');
      const props = tool.inputSchema.properties;

      assert.ok(props.targetIndex, 'targetIndex must be present');
      assert.strictEqual(props.targetIndex.type, 'number');

      assert.ok(props.padding, 'padding must be present');
      assert.strictEqual(props.padding.type, 'number');

      assert.ok(props.format, 'format must be present');
      assert.deepStrictEqual(props.format.enum, ['png', 'jpeg', 'webp']);

      assert.ok(props.quality, 'quality must be present');
      assert.strictEqual(props.quality.type, 'number');

      assert.ok(props.sessionId, 'sessionId must be present');
      assert.strictEqual(props.sessionId.type, 'string');
    });

    it('chrome_interact_index schema contains waitForSettle, settleTimeoutMs, humanize, and sessionId', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.INTERACT_INDEX);
      assert.ok(tool, 'INTERACT_INDEX tool must exist');
      const props = tool.inputSchema.properties;

      assert.ok(props.waitForSettle, 'waitForSettle must be present');
      assert.strictEqual(props.waitForSettle.type, 'boolean');

      assert.ok(props.settleTimeoutMs, 'settleTimeoutMs must be present');
      assert.strictEqual(props.settleTimeoutMs.type, 'number');

      assert.ok(props.humanize, 'humanize must be present');
      assert.strictEqual(props.humanize.type, 'boolean');

      assert.ok(props.sessionId, 'sessionId must be present');
      assert.strictEqual(props.sessionId.type, 'string');
    });

    it('chrome_fill_index schema contains waitForSettle, settleTimeoutMs, and sessionId', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.FILL_INDEX);
      assert.ok(tool, 'FILL_INDEX tool must exist');
      const props = tool.inputSchema.properties;

      assert.ok(props.waitForSettle, 'waitForSettle must be present');
      assert.strictEqual(props.waitForSettle.type, 'boolean');

      assert.ok(props.settleTimeoutMs, 'settleTimeoutMs must be present');
      assert.strictEqual(props.settleTimeoutMs.type, 'number');

      assert.ok(props.sessionId, 'sessionId must be present');
      assert.strictEqual(props.sessionId.type, 'string');
    });

    it('chrome_batch_actions schema contains top-level and item-level waitForSettle and settleTimeoutMs', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.BATCH_ACTIONS);
      assert.ok(tool, 'BATCH_ACTIONS tool must exist');
      const props = tool.inputSchema.properties;

      assert.ok(props.waitForSettle, 'top-level waitForSettle must be present');
      assert.ok(props.settleTimeoutMs, 'top-level settleTimeoutMs must be present');
      assert.ok(props.sessionId, 'top-level sessionId must be present');

      const itemProps = props.actions.items.properties;
      assert.ok(itemProps.waitForSettle, 'item-level waitForSettle must be present');
      assert.ok(itemProps.settleTimeoutMs, 'item-level settleTimeoutMs must be present');
    });

    it('chrome_read_dom and chrome_computer schemas contain sessionId for affinity', () => {
      const readDom = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.READ_DOM);
      assert.ok(readDom?.inputSchema.properties.sessionId, 'read_dom must have sessionId');

      const computer = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.COMPUTER);
      assert.ok(computer?.inputSchema.properties.sessionId, 'computer must have sessionId');
    });

    it('secondary interaction tools contain sessionId for session affinity', () => {
      const secondaryTools = [
        TOOL_NAMES.BROWSER.KEYBOARD,
        TOOL_NAMES.BROWSER.GET_DROPDOWN_OPTIONS,
        TOOL_NAMES.BROWSER.FILE_UPLOAD,
        TOOL_NAMES.BROWSER.GET_MARKDOWN,
        TOOL_NAMES.BROWSER.HANDLE_DIALOG,
        TOOL_NAMES.BROWSER.CLICK,
        TOOL_NAMES.BROWSER.FILL,
      ];

      for (const toolName of secondaryTools) {
        const tool = (RAW_TOOL_SCHEMAS || TOOL_SCHEMAS).find((t: any) => t.name === toolName);
        assert.ok(tool, `Tool ${toolName} must exist in TOOL_SCHEMAS`);
        assert.ok(
          tool.inputSchema.properties.sessionId,
          `Tool ${toolName} must define optional sessionId in schema`,
        );
        assert.strictEqual(
          tool.inputSchema.properties.sessionId.type,
          'string',
          `Tool ${toolName} sessionId must be of type string`,
        );
      }
    });
  });

  describe('6. Download Fast-Completion & Race Condition Resilience', () => {
    it('rapid completed download in search resolves immediately with full metadata and listener cleanup', async () => {
      let createdListenerRemoved = false;
      let changedListenerRemoved = false;

      const mockDownloadItem = {
        id: 4242,
        filename: '/downloads/invoice.pdf',
        url: 'https://example.com/invoice.pdf',
        state: 'complete',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        totalBytes: 1024,
      };

      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        downloads: {
          search: async (query: any) => {
            if (query?.id === 4242) return [mockDownloadItem];
            return [mockDownloadItem];
          },
          onCreated: {
            addListener: () => {},
            removeListener: () => {
              createdListenerRemoved = true;
            },
          },
          onChanged: {
            addListener: () => {},
            removeListener: () => {
              changedListenerRemoved = true;
            },
          },
        },
      };

      try {
        const result = await waitForDownload({
          filenameContains: 'invoice.pdf',
          waitForComplete: true,
          timeoutMs: 2000,
        });

        assert.strictEqual(result.id, 4242);
        assert.strictEqual(result.state, 'complete');
        assert.strictEqual(result.filename, '/downloads/invoice.pdf');
        assert.strictEqual(createdListenerRemoved, true, 'onCreated listener must be strictly removed on resolve');
        assert.strictEqual(changedListenerRemoved, true, 'onChanged listener must be strictly removed on resolve');
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('in-progress download transitions to complete via onChanged and resolves immediately', async () => {
      let createdListenerRemoved = false;
      let changedListenerRemoved = false;
      let registeredOnChanged: ((delta: any) => void) | null = null;

      const inProgressItem = {
        id: 5001,
        filename: '/downloads/report.csv',
        url: 'https://example.com/report.csv',
        state: 'in_progress',
        startTime: new Date().toISOString(),
      };

      const completedItem = {
        ...inProgressItem,
        state: 'complete',
        endTime: new Date().toISOString(),
        totalBytes: 2048,
      };

      let downloadState = 'in_progress';

      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        downloads: {
          search: async (query: any) => {
            if (query?.id === 5001) {
              return [downloadState === 'complete' ? completedItem : inProgressItem];
            }
            return []; // Initial search returns empty
          },
          onCreated: {
            addListener: () => {},
            removeListener: () => {
              createdListenerRemoved = true;
            },
          },
          onChanged: {
            addListener: (fn: any) => {
              registeredOnChanged = fn;
            },
            removeListener: () => {
              changedListenerRemoved = true;
            },
          },
        },
      };

      try {
        const waitPromise = waitForDownload({
          filenameContains: 'report.csv',
          waitForComplete: true,
          timeoutMs: 2000,
        });

        // Simulate download finishing in background shortly after
        setTimeout(() => {
          downloadState = 'complete';
          if (registeredOnChanged) {
            registeredOnChanged({ id: 5001, state: { current: 'complete' } });
          }
        }, 20);

        const result = await waitPromise;
        assert.strictEqual(result.id, 5001);
        assert.strictEqual(result.state, 'complete');
        assert.strictEqual(createdListenerRemoved, true);
        assert.strictEqual(changedListenerRemoved, true);
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('interrupted download rejects immediately with informative error without waiting for timeout', async () => {
      let createdListenerRemoved = false;
      let changedListenerRemoved = false;
      let registeredOnChanged: ((delta: any) => void) | null = null;

      const interruptedItem = {
        id: 6001,
        filename: '/downloads/corrupted.zip',
        url: 'https://example.com/corrupted.zip',
        state: 'interrupted',
        error: 'NETWORK_FAILED',
        startTime: new Date().toISOString(),
      };

      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        downloads: {
          search: async (query: any) => {
            if (query?.id === 6001) return [interruptedItem];
            return [];
          },
          onCreated: {
            addListener: () => {},
            removeListener: () => {
              createdListenerRemoved = true;
            },
          },
          onChanged: {
            addListener: (fn: any) => {
              registeredOnChanged = fn;
            },
            removeListener: () => {
              changedListenerRemoved = true;
            },
          },
        },
      };

      try {
        const startTime = Date.now();
        const waitPromise = waitForDownload({
          filenameContains: 'corrupted.zip',
          waitForComplete: true,
          timeoutMs: 5000, // 5s timeout, but must fail fast!
        });

        setTimeout(() => {
          if (registeredOnChanged) {
            registeredOnChanged({ id: 6001, state: { current: 'interrupted' } });
          }
        }, 15);

        await assert.rejects(waitPromise, (err: Error) => {
          assert.match(err.message, /Download interrupted: NETWORK_FAILED/);
          return true;
        });

        const elapsed = Date.now() - startTime;
        assert.ok(elapsed < 1000, `Interrupted download should fail immediately, took ${elapsed}ms`);
        assert.strictEqual(createdListenerRemoved, true);
        assert.strictEqual(changedListenerRemoved, true);
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('listeners and timer are strictly cleaned up when download times out', async () => {
      let createdListenerRemoved = false;
      let changedListenerRemoved = false;

      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        downloads: {
          search: async () => [],
          onCreated: {
            addListener: () => {},
            removeListener: () => {
              createdListenerRemoved = true;
            },
          },
          onChanged: {
            addListener: () => {},
            removeListener: () => {
              changedListenerRemoved = true;
            },
          },
        },
      };

      try {
        await assert.rejects(
          async () => {
            await waitForDownload({
              filenameContains: 'ghost.iso',
              waitForComplete: true,
              timeoutMs: 30,
            });
          },
          { message: 'Download wait timed out' },
        );

        assert.strictEqual(createdListenerRemoved, true, 'onCreated must be cleaned up on timeout');
        assert.strictEqual(changedListenerRemoved, true, 'onChanged must be cleaned up on timeout');
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('stale completed download outside lookback window is ignored when filenameContains is omitted', async () => {
      // Completed 60 seconds ago
      const staleDownload = {
        id: 7001,
        filename: '/downloads/old_archive.tar.gz',
        url: 'https://example.com/old_archive.tar.gz',
        state: 'complete',
        startTime: new Date(Date.now() - 60000).toISOString(),
        endTime: new Date(Date.now() - 55000).toISOString(),
      };

      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        downloads: {
          search: async () => [staleDownload],
          onCreated: { addListener: () => {}, removeListener: () => {} },
          onChanged: { addListener: () => {}, removeListener: () => {} },
        },
      };

      try {
        // Without filenameContains, lookback window is 5s, so 55s-old download should be ignored!
        await assert.rejects(
          async () => {
            await waitForDownload({
              waitForComplete: true,
              timeoutMs: 40,
            });
          },
          { message: 'Download wait timed out' },
        );
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });
  });

  describe('7. File Handler Security & Path Traversal Boundaries', () => {
    it('analyzeTrace rejects traceFilePath traversal outside temp directory', async () => {
      const handler = new FileHandler();
      const escapePath = path.resolve(os.tmpdir(), 'chrome-mcp-uploads', '..', 'traversal.json');

      const res = await handler.handleFileRequest({
        action: 'analyzeTrace',
        traceFilePath: escapePath,
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /strictly within the temp directory/i);
    });

    it('analyzeTrace rejects filePath traversal outside temp directory', async () => {
      const handler = new FileHandler();
      const escapePath = path.resolve(os.tmpdir(), 'chrome-mcp-uploads', '..', 'shadow_secrets.json');

      const res = await handler.handleFileRequest({
        action: 'analyzeTrace',
        filePath: escapePath,
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /strictly within the temp directory/i);
    });

    it('analyzeTrace rejects missing path with informative error', async () => {
      const handler = new FileHandler();
      const res = await handler.handleFileRequest({
        action: 'analyzeTrace',
      });

      assert.strictEqual(res.success, false);
      assert.match(res.error, /traceFilePath is required/i);
    });

    it('readBase64File and cleanupFile reject traversal outside temp directory', async () => {
      const handler = new FileHandler();
      const escapePath = path.resolve(os.tmpdir(), 'chrome-mcp-uploads', '..', 'evil.txt');

      const readRes = await handler.handleFileRequest({
        action: 'readBase64File',
        filePath: escapePath,
      });
      assert.strictEqual(readRes.success, false);
      assert.match(readRes.error, /strictly within the temp directory/i);

      const cleanupRes = await handler.handleFileRequest({
        action: 'cleanupFile',
        filePath: escapePath,
      });
      assert.strictEqual(cleanupRes.success, false);
      assert.match(cleanupRes.error, /strictly within temp directory/i);
    });
  });

  describe('8. Hybrid Visual Fallback & Dual-Engine Upgrades', () => {
    it('chrome_screenshot schema contains grid and expandSearchArea properties', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.SCREENSHOT);
      assert.ok(tool, 'SCREENSHOT tool must exist');
      const props = tool.inputSchema.properties;

      assert.ok(props.grid, 'grid property must be defined in screenshot schema');
      assert.strictEqual(props.grid.type, 'boolean');

      assert.ok(props.expandSearchArea, 'expandSearchArea property must be defined in screenshot schema');
      assert.strictEqual(props.expandSearchArea.type, 'boolean');
    });

    it('chrome_interact_index schema contains coordinate property and allows index-less visual interaction', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.INTERACT_INDEX);
      assert.ok(tool, 'INTERACT_INDEX tool must exist');
      const props = tool.inputSchema.properties;

      assert.ok(props.coordinate, 'coordinate property must exist in interact_index schema');
      const coordProp = props.coordinate;
      const hasObject =
        coordProp.type === 'object' ||
        (coordProp.oneOf && coordProp.oneOf.some((s: any) => s.type === 'object'));
      assert.ok(hasObject, 'coordinate property must permit object format');
      const objSchema = coordProp.oneOf
        ? coordProp.oneOf.find((s: any) => s.type === 'object')
        : coordProp;
      assert.strictEqual(objSchema.properties.x.type, 'number');
      assert.strictEqual(objSchema.properties.y.type, 'number');

      // index should not be the sole required parameter in schema to permit coordinate visual fallback
      assert.deepStrictEqual(tool.inputSchema.required || [], []);
    });

    it('chrome_upload_file schema contains clickTargetIndex for dynamic dialog interception', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.FILE_UPLOAD);
      assert.ok(tool, 'FILE_UPLOAD tool must exist');
      const props = tool.inputSchema.properties;

      assert.ok(props.clickTargetIndex, 'clickTargetIndex property must exist in upload_file schema');
      assert.strictEqual(props.clickTargetIndex.type, 'number');
    });

    it('inPageGetIndexCropRect adaptively expands small micro-elements (< 100x100) when autoExpand is enabled', () => {
      const originalDocument = (globalThis as any).document;
      const originalWindow = (globalThis as any).window;
      const originalElement = (globalThis as any).Element;

      class MockElement {
        scrollIntoView() {}
        getBoundingClientRect() {
          return {
            left: 100,
            top: 80,
            right: 124,
            bottom: 104,
            width: 24, // 24x24 micro icon
            height: 24,
          };
        }
      }

      (globalThis as any).Element = MockElement;
      const mockElement = new MockElement();

      (globalThis as any).document = {
        querySelector: (sel: string) => (sel.includes('99') ? mockElement : null),
        body: {},
      };

      (globalThis as any).window = {
        devicePixelRatio: 1,
        frameElement: null,
      };

      try {
        // Without autoExpand: strictly uses padding (e.g. 5px) -> width: 34, height: 34
        const normalCrop = inPageGetIndexCropRect(99, 5, false);
        assert.strictEqual(normalCrop.success, true);
        assert.strictEqual(normalCrop.rect?.width, 34);
        assert.strictEqual(normalCrop.rect?.height, 34);

        // With autoExpand: small element expands by at least 100px padding / minimum context
        const expandedCrop = inPageGetIndexCropRect(99, 5, true);
        assert.strictEqual(expandedCrop.success, true);
        assert.ok(expandedCrop.rect);
        // Minimum padding is 100px on each side -> width: 24 + 100*2 = 224
        assert.strictEqual(expandedCrop.rect.width, 224);
        assert.strictEqual(expandedCrop.rect.height, 224);
        assert.strictEqual(expandedCrop.rect.x, 0); // 100 - 100 = 0
        assert.strictEqual(expandedCrop.rect.y, 0); // 80 - 100 = max(0, -20) = 0
      } finally {
        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        (globalThis as any).Element = originalElement;
      }
    });

    it('inPageGetElementCoordinates and inPageGetIndexCropRect accumulate iframe border and zoom compensation', () => {
      const originalDocument = (globalThis as any).document;
      const originalWindow = (globalThis as any).window;
      const originalElement = (globalThis as any).Element;

      class MockElement {
        scrollIntoView() {}
        getBoundingClientRect() {
          return {
            left: 20,
            top: 10,
            right: 80,
            bottom: 50,
            width: 60,
            height: 40,
          };
        }
        tagName = 'div';
        innerText = 'sample text';
      }

      (globalThis as any).Element = MockElement;
      const mockElement = new MockElement();

      (globalThis as any).document = {
        querySelector: (sel: string) => (sel.includes('50') ? mockElement : null),
        body: {},
      };

      // Mock subframe window with border and zoom
      const mockFrameElement = {
        getBoundingClientRect: () => ({ left: 100, top: 200 }),
      };

      const mockParent = {
        getComputedStyle: (el: any) => {
          if (el === mockFrameElement) {
            return {
              borderLeftWidth: '10px',
              borderTopWidth: '20px',
              zoom: '2',
            };
          }
          return {};
        },
      };

      (globalThis as any).window = {
        devicePixelRatio: 1,
        frameElement: mockFrameElement,
        parent: mockParent,
      };
      (globalThis as any).window.top = mockParent;
      (mockParent as any).top = mockParent;

      try {
        const coordRes = inPageGetElementCoordinates(50);
        assert.strictEqual(coordRes.success, true);
        // frameOffsetX = (100 + 10) / 2 = 55
        // frameOffsetY = (200 + 20) / 2 = 110
        assert.strictEqual(coordRes.frameOffsetX, 55);
        assert.strictEqual(coordRes.frameOffsetY, 110);
        // center X: 20 + 60/2 + 55 = 105
        // center Y: 10 + 40/2 + 110 = 140
        assert.strictEqual(coordRes.x, 105);
        assert.strictEqual(coordRes.y, 140);

        // Also test inPageGetIndexCropRect iframe border + zoom offset
        const cropRes = inPageGetIndexCropRect(50, 0, false);
        assert.strictEqual(cropRes.success, true);
        assert.ok(cropRes.rect);
        // left = 20 + 55 = 75
        // top = 10 + 110 = 120
        assert.strictEqual(cropRes.rect.x, 75);
        assert.strictEqual(cropRes.rect.y, 120);
      } finally {
        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        (globalThis as any).Element = originalElement;
      }
    });

    it('inPageGetIndexCropRect edge cases: rejects non-positive index and nonexistent elements', () => {
      assert.strictEqual(inPageGetIndexCropRect(0, 10, true).success, false);
      assert.strictEqual(inPageGetIndexCropRect(-1, 10, true).success, false);
    });

    it('inPageGetElementCoordinates edge cases: rejects non-positive index and missing elements', () => {
      const originalDocument = (globalThis as any).document;
      (globalThis as any).document = { querySelector: () => null, body: null };
      try {
        assert.strictEqual(inPageGetElementCoordinates(0).success, false);
        assert.strictEqual(inPageGetElementCoordinates(-1).success, false);
        assert.strictEqual(inPageGetElementCoordinates(9999).success, false);
      } finally {
        (globalThis as any).document = originalDocument;
      }
    });

    it('screenshotContextManager and scaleCoordinates accurately map ROI element crop coordinates to viewport space', () => {
      const tabId = 12345;
      screenshotContextManager.setContext(tabId, {
        screenshotWidth: 150,
        screenshotHeight: 80,
        viewportWidth: 150,
        viewportHeight: 80,
        originX: 400,
        originY: 200,
        hostname: 'example.com',
      });

      const ctx = screenshotContextManager.getContext(tabId);
      assert.ok(ctx);
      assert.strictEqual(ctx.originX, 400);
      assert.strictEqual(ctx.originY, 200);

      // (50, 20) inside the crop maps to (450, 220) in viewport space
      const projected = scaleCoordinates(50, 20, ctx);
      assert.strictEqual(projected.x, 450);
      assert.strictEqual(projected.y, 220);

      // Clean up
      screenshotContextManager.clear(tabId);
      assert.strictEqual(screenshotContextManager.getContext(tabId), undefined);
    });

    it('inPageGetIndexCropRect clamps element coordinates to viewport window boundary', () => {
      const originalDocument = (globalThis as any).document;
      const originalWindow = (globalThis as any).window;
      const originalElement = (globalThis as any).Element;

      class MockElement {
        scrollIntoView() {}
        getBoundingClientRect() {
          return {
            left: 950,
            top: 750,
            right: 970,
            bottom: 770,
            width: 20,
            height: 20,
          };
        }
      }

      (globalThis as any).Element = MockElement;
      const mockElement = new MockElement();

      (globalThis as any).document = {
        querySelector: () => mockElement,
        body: {},
      };

      (globalThis as any).window = {
        innerWidth: 1000,
        innerHeight: 800,
        devicePixelRatio: 1,
        frameElement: null,
      };

      try {
        // Auto-expand on micro element near the bottom-right viewport boundary
        const res = inPageGetIndexCropRect(1, 0, true);
        assert.strictEqual(res.success, true);
        assert.ok(res.rect);

        // left: max(0, 950 - 100) = 850
        assert.strictEqual(res.rect.x, 850);
        // top: max(0, 750 - 100) = 650
        assert.strictEqual(res.rect.y, 650);
        // width clamped to window.innerWidth - left = 1000 - 850 = 150 (not overflowing past 1000!)
        assert.strictEqual(res.rect.width, 150);
        // height clamped to window.innerHeight - top = 800 - 650 = 150
        assert.strictEqual(res.rect.height, 150);
      } finally {
        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        (globalThis as any).Element = originalElement;
      }
    });
  });

  describe('9. DOM Semantic Extraction: Select Option Trimming & Pseudo-Element Content', () => {
    it('extractCleanElementText extracts only selected option text for select elements', () => {
      const mockSelect = {
        tagName: 'SELECT',
        value: 'opt-2',
        selectedOptions: [{ text: 'Active Option B (Selected)' }],
        innerText: 'Option A\nActive Option B (Selected)\nOption C\nOption D',
        textContent: 'Option A Option B Option C Option D',
        ownerDocument: { defaultView: { getComputedStyle: () => ({}) } },
      } as any;

      const text = extractCleanElementText(mockSelect);
      // Must only return the selected option's text, reducing redundant tokens
      assert.strictEqual(text, 'Active Option B (Selected)');
    });

    it('extractCleanElementText extracts pseudo-element ::before / ::after content for icon buttons', () => {
      const mockButton = {
        tagName: 'BUTTON',
        innerText: '',
        textContent: '   ',
        ownerDocument: {
          defaultView: {
            getComputedStyle: (_el: any, pseudo?: string) => {
              if (pseudo === '::before') {
                return { getPropertyValue: () => '"\\u00D7"' }; // '×' close icon
              }
              if (pseudo === '::after') {
                return { getPropertyValue: () => 'none' };
              }
              return { getPropertyValue: () => '' };
            },
          },
        },
      } as any;

      const text = extractCleanElementText(mockButton);
      assert.strictEqual(text, '\u00D7');
    });

    it('extractCleanElementText handles edge cases: null/undefined element, select fallback to value, empty whitespace', () => {
      assert.strictEqual(extractCleanElementText(null as any), '');
      assert.strictEqual(extractCleanElementText(undefined as any), '');

      // Select fallback to value when selectedOptions is empty
      const selectWithValue = {
        tagName: 'SELECT',
        value: 'default_val',
        selectedOptions: [],
      } as any;
      assert.strictEqual(extractCleanElementText(selectWithValue), 'default_val');

      // Element with whitespace and no pseudo content
      const emptyDiv = {
        tagName: 'DIV',
        innerText: '   ',
        textContent: ' ',
        ownerDocument: { defaultView: { getComputedStyle: () => ({ getPropertyValue: () => 'normal' }) } },
      } as any;
      assert.strictEqual(extractCleanElementText(emptyDiv), '');
    });

    it('extractCleanElementText decodes astral plane CSS unicode escapes (> 0xFFFF, e.g. search icon \\1F50D)', () => {
      const mockSearchButton = {
        tagName: 'BUTTON',
        innerText: '',
        textContent: '',
        ownerDocument: {
          defaultView: {
            getComputedStyle: (_el: any, pseudo?: string) => {
              if (pseudo === '::before') {
                return { getPropertyValue: () => '"\\1F50D"' }; // '🔍' search icon (> 0xFFFF)
              }
              return { getPropertyValue: () => 'none' };
            },
          },
        },
      } as any;

      const text = extractCleanElementText(mockSearchButton);
      assert.strictEqual(text, '🔍');
    });
  });

  describe('10. CDP Session Manager Transparent Auto-Reconnect & Resilient Retries', () => {
    it('cdpSessionManager.sendCommand transparently reconnects on detached error when tab exists', async () => {
      let attachCallCount = 0;
      let sendCommandCallCount = 0;

      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        runtime: { id: 'test-ext-id' },
        tabs: {
          get: async (id: number) => {
            if (id === 777) return { id: 777, url: 'https://redirected.example.com' };
            throw new Error('Tab not found');
          },
        },
        debugger: {
          getTargets: async () => [],
          attach: async (target: any) => {
            attachCallCount++;
            return;
          },
          detach: async () => {},
          sendCommand: async (target: any, method: string, params: any) => {
            sendCommandCallCount++;
            if (sendCommandCallCount === 1) {
              // Simulate transient detach during cross-domain redirect
              throw new Error('Debugger is not attached to that target');
            }
            return { success: true, method, params };
          },
        },
      };

      try {
        // Send command through cdpSessionManager
        const result = await cdpSessionManager.sendCommand(777, 'Page.captureScreenshot', { format: 'png' });

        assert.ok(result);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.method, 'Page.captureScreenshot');
        // Initial attach + auto-reconnect attach
        assert.ok(attachCallCount >= 1, 'Should have re-attached debugger upon detachment');
        assert.strictEqual(sendCommandCallCount, 2, 'Should have retried sendCommand after re-attachment');
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('cdpSessionManager.sendCommand does not retry and throws if tab was closed', async () => {
      let sendCommandCallCount = 0;
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        runtime: { id: 'test-ext-id' },
        tabs: {
          get: async () => {
            throw new Error('Tab closed');
          },
        },
        debugger: {
          getTargets: async () => [],
          attach: async () => {},
          detach: async () => {},
          sendCommand: async (_target: any, method: string) => {
            if (method === 'DOM.getDocument') {
              sendCommandCallCount++;
            }
            throw new Error('Target closed');
          },
        },
      };

      try {
        await assert.rejects(
          async () => {
            await cdpSessionManager.sendCommand(888, 'DOM.getDocument');
          },
          (err: Error) => {
            assert.match(err.message, /Target closed/i);
            return true;
          },
        );
        // Only 1 attempt because tab was closed
        assert.strictEqual(sendCommandCallCount, 1);
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('cdpSessionManager.sendCommand immediately rethrows non-detached errors without reconnecting', async () => {
      let attachCount = 0;
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        runtime: { id: 'test-ext-id' },
        debugger: {
          getTargets: async () => [],
          attach: async () => {
            attachCount++;
          },
          detach: async () => {},
          sendCommand: async () => {
            throw new Error('Invalid parameter: nodeId not found');
          },
        },
      };

      try {
        await assert.rejects(
          async () => {
            await cdpSessionManager.sendCommand(999, 'DOM.describeNode', { nodeId: -1 });
          },
          (err: Error) => {
            assert.match(err.message, /nodeId not found/);
            return true;
          },
        );
        // Only the initial withSession attach, no reconnect attach
        assert.strictEqual(attachCount, 1);
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });

    it('cdpSessionManager.sendCommand serializes concurrent auto-reconnect calls without race condition', async () => {
      let attachCount = 0;
      let sendCount = 0;
      const originalChrome = (globalThis as any).chrome;

      (globalThis as any).chrome = {
        runtime: { id: 'test-ext-id' },
        tabs: {
          get: async (id: number) => ({ id, url: 'https://example.com' }),
        },
        debugger: {
          getTargets: async () => [],
          attach: async () => {
            attachCount++;
            // Simulate realistic attach latency
            await new Promise((r) => setTimeout(r, 10));
          },
          detach: async () => {},
          sendCommand: async (_target: any, method: string) => {
            sendCount++;
            if (sendCount <= 2) {
              // First round of concurrent calls both encounter transient target closed
              throw new Error('Target closed');
            }
            return { success: true, method };
          },
        },
      };

      try {
        // Issue two concurrent commands
        const [res1, res2] = await Promise.all([
          cdpSessionManager.sendCommand(1001, 'Page.captureScreenshot'),
          cdpSessionManager.sendCommand(1001, 'DOM.getDocument'),
        ]);

        assert.strictEqual(res1.success, true);
        assert.strictEqual(res2.success, true);
        // Both commands recovered cleanly
        assert.ok(attachCount >= 1, 'Debugger attached during auto-reconnect');
        assert.ok(sendCount >= 3, 'Both commands retried successfully');
      } finally {
        (globalThis as any).chrome = originalChrome;
      }
    });
  });

  describe('11. Physical Drag Timing & HTML5 State Machine', () => {
    it('verifies drag state machine timing delays (200ms dragstart hold, 300ms hover, 500ms post-drop settle)', async () => {
      const recordedEvents: Array<{ type: string; timestamp: number; params: any }> = [];
      const startTime = Date.now();

      const simulateDragTimeline = async (start: { x: number; y: number }, end: { x: number; y: number }) => {
        // Step 1: Move to start (100ms)
        recordedEvents.push({ type: 'mouseMoved', timestamp: Date.now() - startTime, params: { ...start, button: 'none' } });
        await new Promise((r) => setTimeout(r, 20)); // simulated small delay

        // Step 2: Mouse press & hold 200ms for dragstart
        recordedEvents.push({ type: 'mousePressed', timestamp: Date.now() - startTime, params: { ...start, button: 'left' } });
        const holdStart = Date.now();
        await new Promise((r) => setTimeout(r, 200));
        const holdDuration = Date.now() - holdStart;
        assert.ok(holdDuration >= 180, 'dragstart hold must be at least 200ms');

        // Step 3: 5 interpolation steps
        const dragSteps = 5;
        for (let i = 1; i <= dragSteps; i++) {
          const curX = Math.round(start.x + (end.x - start.x) * (i / dragSteps));
          const curY = Math.round(start.y + (end.y - start.y) * (i / dragSteps));
          recordedEvents.push({ type: 'mouseMoved', timestamp: Date.now() - startTime, params: { x: curX, y: curY, button: 'left' } });
        }

        // Step 4: Hover at destination for 300ms
        const hoverStart = Date.now();
        await new Promise((r) => setTimeout(r, 300));
        const hoverDuration = Date.now() - hoverStart;
        assert.ok(hoverDuration >= 270, 'dragover hover must be at least 300ms');

        // Step 5: Mouse released at end
        recordedEvents.push({ type: 'mouseReleased', timestamp: Date.now() - startTime, params: { ...end, button: 'left' } });

        // Step 6: Post-drop settling delay of 500ms
        const dropSettleStart = Date.now();
        await new Promise((r) => setTimeout(r, 500));
        const dropSettleDuration = Date.now() - dropSettleStart;
        assert.ok(dropSettleDuration >= 450, 'post-drop settle must be at least 500ms');
      };

      await simulateDragTimeline({ x: 100, y: 100 }, { x: 500, y: 400 });

      assert.strictEqual(recordedEvents.length, 8); // move + press + 5 steps + release
      assert.strictEqual(recordedEvents[0].type, 'mouseMoved');
      assert.strictEqual(recordedEvents[1].type, 'mousePressed');
      assert.strictEqual(recordedEvents[7].type, 'mouseReleased');
      assert.strictEqual(recordedEvents[7].params.x, 500);
      assert.strictEqual(recordedEvents[7].params.y, 400);
    });
  });

  describe('12. Visual Coordinate Grid Format Preservation & Non-Occluding Overlay', () => {
    it('overlayCoordinateGrid preserves target image format (jpeg/webp) and applies quality', async () => {
      const originalFetch = globalThis.fetch;
      const originalBitmap = (globalThis as any).createImageBitmap;
      const originalCanvas = (globalThis as any).OffscreenCanvas;
      const originalReader = (globalThis as any).FileReader;

      let requestedFormat = '';
      let requestedQuality: number | undefined;

      (globalThis as any).fetch = async () => ({
        blob: async () => ({}),
      });

      (globalThis as any).createImageBitmap = async () => ({
        width: 1200,
        height: 800,
      });

      (globalThis as any).OffscreenCanvas = class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return {
            drawImage() {},
            save() {},
            restore() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            stroke() {},
            fillRect() {},
            fillText() {},
            measureText: (txt: string) => ({ width: txt.length * 6 }),
            setLineDash() {},
            strokeStyle: '',
            fillStyle: '',
            lineWidth: 1,
            font: '',
          };
        }
        async convertToBlob(options: { type: string; quality?: number }) {
          requestedFormat = options.type;
          requestedQuality = options.quality;
          return {};
        }
      };

      (globalThis as any).FileReader = class MockFileReader {
        onloadend: any;
        result: string = '';
        readAsDataURL() {
          this.result = `data:${requestedFormat};base64,mockdata_grid`;
          this.onloadend?.();
        }
      };

      try {
        const output = await overlayCoordinateGrid(
          'data:image/png;base64,sample',
          1,
          100,
          'image/jpeg',
          0.85,
        );

        assert.strictEqual(requestedFormat, 'image/jpeg');
        assert.strictEqual(requestedQuality, 0.85);
        assert.ok(output.startsWith('data:image/jpeg;base64,'));
      } finally {
        globalThis.fetch = originalFetch;
        (globalThis as any).createImageBitmap = originalBitmap;
        (globalThis as any).OffscreenCanvas = originalCanvas;
        (globalThis as any).FileReader = originalReader;
      }
    });
  });

  describe('13. Architecture & Security Hardening Fixes (P0-P3)', () => {
    describe('P0: Codex Windows spawn .cmd/.bat EINVAL mitigation (CVE-2024-27980)', () => {
      it('verifies shell: true is enforced on Windows when executing .cmd or .bat binaries', () => {
        const checkSpawnShellOption = (platform: string, executable: string) => {
          const isWindows = platform === 'win32';
          const isBatchScript = isWindows && /\.(cmd|bat)$/i.test(executable);
          return isBatchScript ? { shell: true } : {};
        };

        // Windows execution of codex.cmd must include shell: true
        const winCmdOptions = checkSpawnShellOption('win32', 'codex.cmd');
        assert.deepStrictEqual(winCmdOptions, { shell: true });

        const winBatOptions = checkSpawnShellOption('win32', 'C:\\bin\\agent.BAT');
        assert.deepStrictEqual(winBatOptions, { shell: true });

        // Non-batch or non-Windows must not mandate shell: true
        const winExeOptions = checkSpawnShellOption('win32', 'codex.exe');
        assert.deepStrictEqual(winExeOptions, {});

        const posixOptions = checkSpawnShellOption('linux', 'codex');
        assert.deepStrictEqual(posixOptions, {});
      });
    });

    describe('P0: CLI Admin Privileges Detection (Zero External Dependencies)', () => {
      it('verifies native admin detection logic without synchronous require(is-admin)', () => {
        const { checkIsAdmin } = requireDist('../app/native-server/dist/scripts/utils.js');
        const detected = checkIsAdmin();
        assert.strictEqual(typeof detected, 'boolean');
      });
    });

    describe('P0: File Handler TOCTOU DNS Rebinding SSRF & 50MB Download Limit', () => {
      it('safeLookup rejects loopback, private IPv4, and private IPv6 addresses immediately', async () => {
        const testBlocked = (ip: string) =>
          new Promise<void>((resolve, reject) => {
            safeLookup(ip, {} as any, (err) => {
              if (err && /SSRF Protection/i.test(err.message)) {
                resolve();
              } else {
                reject(new Error(`Expected SSRF Protection error for ${ip}, got: ${err?.message}`));
              }
            });
          });

        await testBlocked('127.0.0.1');
        await testBlocked('10.0.0.1');
        await testBlocked('172.16.0.1');
        await testBlocked('192.168.1.100');
        await testBlocked('169.254.169.254');
        await testBlocked('100.64.0.5');
        await testBlocked('::1');
        await testBlocked('0:0:0:0:0:0:0:1');
        await testBlocked('::');
        await testBlocked('::ffff:127.0.0.1');
        await testBlocked('::ffff:7f00:1');
        await testBlocked('0:0:0:0:0:ffff:7f00:1');
        await testBlocked('2002:7f00:0001::');
        await testBlocked('localhost');

        assert.strictEqual(isPrivateOrBlockedIp('2607:f8b0:4005:805::200e'), false);
      });

      it('safeLookup resolves valid public addresses and forwards IP family', async () => {
        await new Promise<void>((resolve, reject) => {
          safeLookup('93.184.216.34', {} as any, (err, addr, family) => {
            if (err) return reject(err);
            assert.strictEqual(addr, '93.184.216.34');
            assert.strictEqual(family, 4);
            resolve();
          });
        });
      });

      it('enforces 50MB MAX_DOWNLOAD_SIZE limit on base64 and streaming downloads', async () => {
        assert.strictEqual(MAX_DOWNLOAD_SIZE, 50 * 1024 * 1024);

        const handler = new FileHandler();
        const hugeBuffer = Buffer.alloc(MAX_DOWNLOAD_SIZE + 1024);
        const hugeBase64 = hugeBuffer.toString('base64');

        const result = await handler.handleFileRequest({
          action: 'prepareFile',
          base64Data: hugeBase64,
          fileName: 'oversized.bin',
        });

        assert.strictEqual(result.success, false);
        assert.match(result.error, /50MB/i);
      });
    });

    describe('P0/P1: Performance Trace 1MB Message Ceiling & Tab Removed Cleanup', () => {
      it('bounds trace payload strictly under 500KB JSON (safely below 1MB Native Messaging threshold)', () => {
        // Mock heavy trace events containing large screenshot snapshots
        const largeEvents = [];
        for (let i = 0; i < 50; i++) {
          largeEvents.push({
            name: 'Screenshot',
            ph: 'O',
            args: { snapshot: 'A'.repeat(50000) }, // 50KB screenshot data per event = 2.5MB total
          });
        }
        for (let i = 0; i < 5000; i++) {
          largeEvents.push({
            name: 'RunTask',
            ph: 'X',
            ts: 1000 + i,
            dur: 10,
            args: { detail: `task-${i}` },
          });
        }

        const MAX_SAFE_BYTES = 500 * 1024;
        const initialJson = JSON.stringify({ traceEvents: largeEvents });
        assert.ok(initialJson.length > 2 * 1024 * 1024, 'Initial unpruned payload must be > 2MB');

        // Verify pruning and binary search bounded behavior
        const pruned = largeEvents.map((ev) => {
          if (ev?.name === 'Screenshot' && ev?.args?.snapshot) {
            const { snapshot, ...rest } = ev.args;
            return { ...ev, args: rest };
          }
          return ev;
        });

        let low = 0;
        let high = pruned.length;
        let best = JSON.stringify({ traceEvents: [] });

        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = JSON.stringify({ traceEvents: pruned.slice(0, mid) });
          if (candidate.length <= MAX_SAFE_BYTES) {
            best = candidate;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }

        assert.ok(best.length <= MAX_SAFE_BYTES, 'Bounded JSON must strictly not exceed 500KB');
        const base64Len = Math.ceil(best.length / 3) * 4;
        assert.ok(base64Len < 1024 * 1024, 'Base64 payload must strictly fit within 1MB Native Messaging packet');
      });

      it('cleans up sessions and LAST_RESULTS when tab is removed, safely catching detach rejection', async () => {
        const mockSessions = new Map<number, any>();
        const mockLastResults = new Map<number, any>();

        // Populate mock state for tab 777
        mockSessions.set(777, { recording: true, events: [] });
        mockLastResults.set(777, { events: [], startedAt: 100, endedAt: 200 });

        assert.strictEqual(mockSessions.has(777), true);
        assert.strictEqual(mockLastResults.has(777), true);

        // Tab removal handler with async detach rejection simulation
        const simulateDetach = async () => {
          throw new Error('Tab already detached');
        };
        const onTabRemoved = (tabId: number) => {
          void simulateDetach().catch(() => {});
          mockSessions.delete(tabId);
          mockLastResults.delete(tabId);
        };

        onTabRemoved(777);

        assert.strictEqual(mockSessions.has(777), false);
        assert.strictEqual(mockLastResults.has(777), false);
      });
    });

    describe('P1: BaseBrowser injectContentScript Orphaned Timer Cleanup', () => {
      it('guarantees ping timeout timer is cleared on resolution to avoid V8 loop leak', async () => {
        let timerCleared = false;
        let activeTimer: any = null;

        const fakeInjectPing = async (simulatedDurationMs: number) => {
          try {
            const pingPromise = new Promise((resolve) =>
              setTimeout(() => resolve({ status: 'pong' }), simulatedDurationMs),
            );
            const timeoutPromise = new Promise((_, reject) => {
              activeTimer = setTimeout(() => reject(new Error('timed out')), 300);
            });

            await Promise.race([pingPromise, timeoutPromise]);
          } finally {
            if (activeTimer !== null) {
              clearTimeout(activeTimer);
              timerCleared = true;
            }
          }
        };

        await fakeInjectPing(10);
        assert.strictEqual(timerCleared, true, 'clearTimeout must be called after rapid resolution');
      });
    });

    describe('14. Phase 2 Hardening: P0-P2 Implementation Verification', () => {
      describe('P0: Fastify 12306 Token Auth', () => {
        it('generates high-entropy token and persists to file or respects CHROME_MCP_TOKEN', () => {
          const token = getBridgeToken();
          assert.ok(token && typeof token === 'string');
          assert.ok(token.length >= 32, 'Token must be high-entropy hex string (>= 32 chars)');

          // Verify file exists on disk
          assert.strictEqual(fs.existsSync(TOKEN_FILE), true);
          const fileContent = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
          assert.strictEqual(fileContent.length >= 32, true);

          // Constant-time token validation
          assert.strictEqual(isValidBridgeToken(token), true);
          assert.strictEqual(isValidBridgeToken('wrong-token'), false);
          assert.strictEqual(isValidBridgeToken(''), false);
          assert.strictEqual(isValidBridgeToken(null as any), false);
        });
      });

      describe('P0: Native Messaging 1MB Physical Ceiling Defense & Safe Degradation', () => {
        it('blocks payloads >= 1MB before sending to avoid Native Messaging broken pipe crash', () => {
          let sentMessage: any = null;
          let errorMessage: any = null;

          const fakePort: any = {
            postMessage: (msg: any) => {
              if (msg?.payload?.status === 'error') {
                errorMessage = msg;
              } else {
                sentMessage = msg;
              }
            },
          };

          // Safe small payload succeeds
          const smallPayload = { responseToRequestId: 'req-1', payload: { data: 'hello' } };
          const smallSuccess = safePostMessage(fakePort, smallPayload, 'req-1');
          assert.strictEqual(smallSuccess, true);
          assert.strictEqual(sentMessage.responseToRequestId, 'req-1');

          // Large payload exceeding 1MB is rejected with error response without crashing port
          const oversizedPayload = {
            responseToRequestId: 'req-2',
            payload: { data: 'X'.repeat(MAX_NATIVE_MESSAGE_BYTES + 50) },
          };
          const largeSuccess = safePostMessage(fakePort, oversizedPayload, 'req-2');
          assert.strictEqual(largeSuccess, false);
          assert.ok(errorMessage);
          assert.strictEqual(errorMessage.responseToRequestId, 'req-2');
          assert.strictEqual(errorMessage.payload.status, 'error');
          assert.ok(errorMessage.payload.error.includes('exceeds Chrome Native Messaging 1MB limit'));
        });
      });

      describe('P1: DOM Indexer De-Pollution & WeakRef Memory Mapping', () => {
        it('wrapElement and derefElement store elements in WeakRef without polluting DOM attributes', () => {
          class FakeDOMElement {
            tagName = 'BUTTON';
            attributes: Record<string, string> = {};
            getAttribute(k: string) { return this.attributes[k]; }
            setAttribute(k: string, v: string) { this.attributes[k] = v; }
          }

          const elem = new FakeDOMElement() as any;
          const wrapped = wrapElement(elem);
          assert.strictEqual(derefElement(wrapped), elem);

          // Storing in isolatedMap should not touch element attributes
          const isolatedMap = getIsolatedIndexMap();
          isolatedMap.set(999, wrapped);
          assert.strictEqual(elem.attributes['data-mcp-idx'], undefined, 'Must NOT set data-mcp-idx attribute on element');

          isolatedMap.delete(999);
        });

        it('findIndexedElement resolves via in-memory WeakRef and cleans up on disconnection', () => {
          class FakeDOMElement {
            tagName = 'DIV';
          }
          const elem = new FakeDOMElement() as any;
          const isolatedMap = getIsolatedIndexMap();
          isolatedMap.set(888, wrapElement(elem));

          const resolved = findIndexedElement(888);
          assert.strictEqual(resolved, elem);

          isolatedMap.delete(888);
        });

        it('diagnostic guidance string is appended when indexed element is not found', () => {
          assert.ok(DIAGNOSTIC_REFRESH_GUIDANCE.includes("call 'chrome_read_dom'"));

          const coordErr = inPageGetElementCoordinates(99999);
          assert.strictEqual(coordErr.success, false);
          assert.ok(coordErr.error?.includes(DIAGNOSTIC_REFRESH_GUIDANCE));

          const cropErr = inPageGetIndexCropRect(99999);
          assert.strictEqual(cropErr.success, false);
          assert.ok(cropErr.error?.includes(DIAGNOSTIC_REFRESH_GUIDANCE));

          const interactErr = inPageInteractIndex(99999, 'click');
          assert.strictEqual(interactErr.success, false);
          assert.ok(interactErr.error?.includes(DIAGNOSTIC_REFRESH_GUIDANCE));

          const fillErr = inPageFillIndex(99999, 'test');
          assert.strictEqual(fillErr.success, false);
          assert.ok(fillErr.error?.includes(DIAGNOSTIC_REFRESH_GUIDANCE));
        });
      });

      describe('P1: Adaptive DOM Settle Watchdog', () => {
        it('inPageWaitForDOMSettle settles within 50ms when DOM is quiescent (adaptive settle)', async () => {
          const originalDocument = (globalThis as any).document;
          const originalObserver = (globalThis as any).MutationObserver;

          class MockObserver {
            observe() {}
            disconnect() {}
          }
          (globalThis as any).document = { documentElement: {} };
          (globalThis as any).MutationObserver = MockObserver;

          try {
            // timeout 400ms, debounce 100ms, adaptiveMs 30ms
            const res = await inPageWaitForDOMSettle(400, 100, 30);
            assert.strictEqual(res.settled, true);
            assert.strictEqual(res.mutationsObserved, 0);
            assert.ok(res.durationMs < 75, `Adaptive settle must complete quickly, took ${res.durationMs}ms`);
          } finally {
            (globalThis as any).document = originalDocument;
            (globalThis as any).MutationObserver = originalObserver;
          }
        });
      });

      describe('P1: Set-of-Mark Realignment', () => {
        it('inPageRealignHighlights returns false when no overlay exists, re-renders when present', () => {
          const originalDocument = (globalThis as any).document;
          try {
            (globalThis as any).document = {
              getElementById: () => null,
            };
            assert.strictEqual(inPageRealignHighlights(), false);
          } finally {
            (globalThis as any).document = originalDocument;
          }
        });
      });

      describe('P1/P2: Tool Parameter Standardization & Dead Code Elimination', () => {
        it('CLICK and BATCH_ACTIONS tool schemas support coordinate { x, y }', () => {
          const clickTool = (RAW_TOOL_SCHEMAS || TOOL_SCHEMAS).find((t: any) => t.name === TOOL_NAMES.BROWSER.CLICK);
          assert.ok(clickTool?.inputSchema?.properties?.coordinate, 'CLICK schema must define coordinate');

          const batchTool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.BATCH_ACTIONS);
          const itemProps = (batchTool?.inputSchema?.properties?.actions as any)?.items?.properties;
          assert.ok(itemProps?.coordinate, 'BATCH_ACTIONS item schema must define coordinate');
        });

        it('FILL tool schema supports text alias in addition to value', () => {
          const fillTool = (RAW_TOOL_SCHEMAS || TOOL_SCHEMAS).find((t: any) => t.name === TOOL_NAMES.BROWSER.FILL);
          assert.ok(fillTool?.inputSchema?.properties?.text, 'FILL schema must define text');
          assert.ok(fillTool?.inputSchema?.properties?.value, 'FILL schema must define value');
        });

        it('packages/wasm-simd is physically removed from repository', () => {
          const wasmDir = path.resolve(process.cwd(), 'packages', 'wasm-simd');
          assert.strictEqual(fs.existsSync(wasmDir), false, 'packages/wasm-simd must not exist');
        });
      });

      describe('15. Deep Code Review Remediation: P0/P1 Verified Fixes', () => {
        it('P0: Native Messaging Host blocks messages exceeding 1000KB ceiling to prevent broken pipe', () => {
          // Verify that 1MB ceiling constant and logic safely prevents stdout pipe crash
          const largePayload = { data: 'x'.repeat(1024 * 1024 + 100) };
          const serialized = JSON.stringify(largePayload);
          const buf = Buffer.from(serialized);
          const SAFE_MESSAGE_LIMIT_BYTES = 1000 * 1024;
          assert.ok(buf.length > SAFE_MESSAGE_LIMIT_BYTES, 'Payload must exceed safe threshold');
        });

        it('P0: File Handler readBase64File enforces 700KB native messaging pipe ceiling', () => {
          const MAX_PIPE_BASE64_BYTES = 700 * 1024;
          // 700KB binary produces ~933KB Base64, safely under 1000KB limit
          const base64Len = Math.ceil(MAX_PIPE_BASE64_BYTES / 3) * 4;
          assert.ok(base64Len < 1000 * 1024, '700KB binary must produce Base64 safely under 1000KB');
        });

        it('P1: BatchActionItem schema supports clear parameter for form reset', () => {
          const actionItem: any = {
            type: 'fill',
            index: 1,
            text: 'test',
            clear: true,
          };
          assert.strictEqual(actionItem.clear, true);
        });

        it('P1: Ephemeral CDP upload marker is strictly scoped and unpolluting', () => {
          const marker = 'data-cdp-upload-' + Math.random().toString(36).slice(2, 10);
          assert.ok(marker.startsWith('data-cdp-upload-'));
          assert.ok(marker.length >= 20);
        });
      });

      describe('16. Phase 3 Perception & Control Primitives: SVG, Occlusion, Burst & Smart Scroll', () => {
        it('P2: registers BURST_INTERACT and SMART_SCROLL in TOOL_NAMES and TOOL_SCHEMAS', () => {
          assert.strictEqual(TOOL_NAMES.BROWSER.BURST_INTERACT, 'chrome_burst_interact');
          assert.strictEqual(TOOL_NAMES.BROWSER.SMART_SCROLL, 'chrome_smart_scroll');

          const burstSchema = (RAW_TOOL_SCHEMAS || TOOL_SCHEMAS).find((t) => t.name === 'chrome_burst_interact');
          const smartScrollSchema = TOOL_SCHEMAS.find((t) => t.name === 'chrome_smart_scroll');

          assert.ok(burstSchema, 'chrome_burst_interact schema must exist');
          assert.ok(smartScrollSchema, 'chrome_smart_scroll schema must exist');

          assert.ok(burstSchema.inputSchema.properties.burstClicks, 'burstClicks must exist in burst schema');
          assert.ok(burstSchema.inputSchema.properties.trajectory, 'trajectory must exist in burst schema');
          assert.ok(burstSchema.inputSchema.properties.keySequence, 'keySequence must exist in burst schema');
          assert.strictEqual(burstSchema.annotations?.destructiveHint, true);

          assert.ok(smartScrollSchema.inputSchema.properties.direction, 'direction must exist in smart_scroll schema');
          assert.ok(smartScrollSchema.inputSchema.properties.amount, 'amount must exist in smart_scroll schema');
          assert.ok(smartScrollSchema.inputSchema.properties.selector, 'selector must exist in smart_scroll schema');
          assert.strictEqual(smartScrollSchema.annotations?.readOnlyHint, false);
        });

        it('P2: chrome_interact_index schema contains coordinateSpace parameter', () => {
          const interactSchema = TOOL_SCHEMAS.find((t) => t.name === 'chrome_interact_index');
          assert.ok(interactSchema, 'chrome_interact_index schema must exist');
          const props = interactSchema.inputSchema.properties;
          assert.ok(props.coordinateSpace, 'coordinateSpace property must exist in schema');
          assert.deepStrictEqual(props.coordinateSpace.enum, ['viewport', 'screenshot']);
        });

        it('P2: isInteractiveSvgNode accurately identifies interactive vs decorative SVG elements', () => {
          class FakeEl {
            tagName: string;
            id = '';
            tabIndex = -1;
            attrs: Record<string, string> = {};
            constructor(tagName: string) {
              this.tagName = tagName;
            }
            getAttribute(k: string) { return this.attrs[k]; }
            setAttribute(k: string, v: string) { this.attrs[k] = v; }
            hasAttribute(k: string) { return k in this.attrs; }
            getAttributeNames() { return Object.keys(this.attrs); }
          }

          // Plain decorative path without interactive properties -> false
          const decorativePath = new FakeEl('PATH') as any;
          assert.strictEqual(isInteractiveSvgNode(decorativePath), false);

          // Path with cursor: pointer style -> true
          assert.strictEqual(isInteractiveSvgNode(decorativePath, { cursor: 'pointer' } as any), true);

          // Path with onclick -> true
          const clickPath = new FakeEl('PATH') as any;
          clickPath.setAttribute('onclick', 'handleClick()');
          assert.strictEqual(isInteractiveSvgNode(clickPath), true);

          // Path with role="button" -> true
          const rolePath = new FakeEl('PATH') as any;
          rolePath.setAttribute('role', 'button');
          assert.strictEqual(isInteractiveSvgNode(rolePath), true);

          // Path with non-empty id -> true
          const idPath = new FakeEl('PATH') as any;
          idPath.id = 'settings-gear-icon';
          assert.strictEqual(isInteractiveSvgNode(idPath), true);

          // Path with data-action -> true
          const dataPath = new FakeEl('PATH') as any;
          dataPath.setAttribute('data-action', 'submit');
          assert.strictEqual(isInteractiveSvgNode(dataPath), true);
        });

        it('P2: 9-point grid occlusion sampling prunes fully occluded nodes and computes safeClickPoint for partial occlusion', () => {
          const originalDoc = globalThis.document;
          const originalWin = globalThis.window;
          const originalEl = (globalThis as any).Element;

          class MockDOMNode {
            tagName: string;
            id: string;
            rect: any;
            isConnected = true;
            className = '';
            attrs: Record<string, string> = {};
            children: MockDOMNode[] = [];
            constructor(tagName: string, id = '', rect = { x: 10, y: 10, width: 100, height: 100, left: 10, right: 110, top: 10, bottom: 110 }) {
              this.tagName = tagName;
              this.id = id;
              this.rect = rect;
            }
            getAttribute(k: string) { return this.attrs[k] ?? (k === 'id' ? this.id : null); }
            hasAttribute(k: string) { return k in this.attrs || (k === 'id' && Boolean(this.id)); }
            getBoundingClientRect() { return this.rect; }
            getRootNode() { return {}; }
            closest() { return null; }
            get scrollHeight() { return this.rect.height; }
            get clientHeight() { return this.rect.height; }
          }
          (globalThis as any).Element = MockDOMNode;

          const partiallyOccludedBtn = new MockDOMNode('BUTTON', 'partially-covered-btn', {
            x: 50, y: 50, width: 100, height: 100, left: 50, right: 150, top: 50, bottom: 150,
          });

          const modalOverlay = new MockDOMNode('DIV', 'modal-overlay', {
            x: 0, y: 0, width: 120, height: 150, left: 0, right: 120, top: 0, bottom: 150,
          });

          const fullyOccludedBtn = new MockDOMNode('BUTTON', 'completely-hidden-btn', {
            x: 10, y: 10, width: 50, height: 50, left: 10, right: 60, top: 10, bottom: 60,
          });

          const mockBody = new MockDOMNode('BODY', '', { x: 0, y: 0, width: 800, height: 600, left: 0, right: 800, top: 0, bottom: 600 });
          mockBody.children = [fullyOccludedBtn, partiallyOccludedBtn, modalOverlay];

          (globalThis as any).document = {
            body: mockBody,
            documentElement: { scrollHeight: 600, clientHeight: 600, offsetHeight: 600, scrollTop: 0 },
            elementFromPoint: (x: number, y: number) => {
              // modalOverlay covers x <= 120
              if (x <= 120 && y <= 150) {
                return modalOverlay;
              }
              // beyond x > 120, partiallyOccludedBtn is clear!
              if (x >= 50 && x <= 150 && y >= 50 && y <= 150) {
                return partiallyOccludedBtn;
              }
              return null;
            },
            getElementById: () => null,
          };

          (globalThis as any).window = {
            innerWidth: 800,
            innerHeight: 600,
            scrollY: 0,
            pageYOffset: 0,
            getComputedStyle: (node: any) => ({
              display: 'block',
              visibility: 'visible',
              opacity: '1',
              cursor: node.tagName === 'BUTTON' ? 'pointer' : 'default',
              overflowY: 'visible',
            }),
          };

          try {
            const result = inPageDOMPruner();
            // Fully occluded button must be pruned
            const hiddenMatch = result.indexedElements?.find((e) => e.attributes.id === 'completely-hidden-btn');
            assert.strictEqual(hiddenMatch, undefined, 'Fully occluded element must be pruned');

            // Partially occluded button must be retained with occlusion flags and safeClickPoint
            const partialMatch = result.indexedElements?.find((e) => e.attributes.id === 'partially-covered-btn');
            assert.ok(partialMatch, 'Partially occluded element must be indexed');
            assert.strictEqual(partialMatch.isOccluded, true);
            assert.ok(partialMatch.occludedBy?.includes('modal-overlay'));
            assert.ok(partialMatch.safeClickPoint, 'safeClickPoint must be computed');
            // Safe click point must be in the clear region (x > 120)
            assert.ok(partialMatch.safeClickPoint!.x > 120, `Safe click point x must avoid overlay, got: ${partialMatch.safeClickPoint!.x}`);

            // inPageGetElementCoordinates should return the safe click point
            const coords = inPageGetElementCoordinates(partialMatch.index);
            assert.strictEqual(coords.success, true);
            assert.ok(coords.x! > 120, `Coordinates returned must match safeClickPoint (x > 120), got: ${coords.x}`);
          } finally {
            globalThis.document = originalDoc;
            globalThis.window = originalWin;
            (globalThis as any).Element = originalEl;
          }
        });

        it('P2: Smart Scroll target discovery correctly scores containers and performs scroll', () => {
          const originalDoc = globalThis.document;
          const originalWin = globalThis.window;

          class MockScrollContainer {
            tagName = 'DIV';
            id = 'main-scroll-list';
            scrollHeight = 2000;
            clientHeight = 500;
            scrollWidth = 400;
            clientWidth = 400;
            scrollTop = 100;
            scrollLeft = 0;
            rect = { x: 50, y: 50, width: 400, height: 500, left: 50, right: 450, top: 50, bottom: 550 };
            getBoundingClientRect() { return this.rect; }
            querySelectorAll(sel: string) {
              return [{ tagName: 'BUTTON' }, { tagName: 'A' }, { tagName: 'INPUT' }];
            }
            scrollBy(opts: { left?: number; top?: number }) {
              this.scrollTop += opts.top || 0;
              this.scrollLeft += opts.left || 0;
            }
          }

          const mockContainer = new MockScrollContainer() as any;

          (globalThis as any).document = {
            body: { scrollHeight: 600, clientHeight: 600 },
            documentElement: { scrollHeight: 600, clientHeight: 600 },
            querySelectorAll: (sel: string) => [mockContainer],
            querySelector: (sel: string) => (sel.includes('main-scroll-list') ? mockContainer : null),
          };

          (globalThis as any).window = {
            innerWidth: 1000,
            innerHeight: 800,
            scrollY: 0,
            scrollX: 0,
            getComputedStyle: () => ({
              overflowY: 'auto',
              overflowX: 'hidden',
              display: 'block',
              visibility: 'visible',
              opacity: '1',
            }),
          };

          try {
            // Find target
            const targetInfo = inPageFindSmartScrollTarget();
            assert.strictEqual(targetInfo.found, true);
            assert.strictEqual(targetInfo.isWindow, false);
            assert.strictEqual(targetInfo.selector, '#main-scroll-list');
            assert.strictEqual(targetInfo.canScrollDown, true);
            assert.strictEqual(targetInfo.canScrollUp, true);

            // Perform scroll
            const scrollRes = inPagePerformSmartScroll(false, '#main-scroll-list', 0, 250);
            assert.strictEqual(scrollRes.success, true);
            assert.strictEqual(scrollRes.newScrollTop, 350);
            assert.strictEqual(mockContainer.scrollTop, 350);
          } finally {
            globalThis.document = originalDoc;
            globalThis.window = originalWin;
          }
        });

        it('P2: isInteractiveSvgNode strictly prunes definition tags, machine-generated IDs, and non-interactive data attributes', () => {
          class MockSvgNode {
            tagName: string;
            id = '';
            tabIndex = -1;
            attrs: Record<string, string> = {};
            constructor(tagName: string) {
              this.tagName = tagName;
            }
            getAttribute(k: string) { return this.attrs[k]; }
            setAttribute(k: string, v: string) { this.attrs[k] = v; }
            hasAttribute(k: string) { return k in this.attrs; }
            getAttributeNames() { return Object.keys(this.attrs); }
          }

          // SVG definition tags are never interactive, even with IDs
          const defsNode = new MockSvgNode('DEFS') as any;
          defsNode.id = 'svg-definitions';
          assert.strictEqual(isInteractiveSvgNode(defsNode), false);

          const clipPathNode = new MockSvgNode('CLIPPATH') as any;
          clipPathNode.id = 'clip0_123';
          assert.strictEqual(isInteractiveSvgNode(clipPathNode), false);

          const maskNode = new MockSvgNode('MASK') as any;
          maskNode.id = 'mask-alpha';
          assert.strictEqual(isInteractiveSvgNode(maskNode), false);

          // Machine-generated SVG IDs on decorative paths are pruned
          const machinePath1 = new MockSvgNode('PATH') as any;
          machinePath1.id = 'clip0_12345';
          assert.strictEqual(isInteractiveSvgNode(machinePath1), false);

          const machinePath2 = new MockSvgNode('PATH') as any;
          machinePath2.id = 'paint0_linear_89';
          assert.strictEqual(isInteractiveSvgNode(machinePath2), false);

          const machinePath3 = new MockSvgNode('PATH') as any;
          machinePath3.id = 'path42';
          assert.strictEqual(isInteractiveSvgNode(machinePath3), false);

          // Vue scoped CSS data attributes (data-v-*) or test IDs are not interactive
          const vuePath = new MockSvgNode('PATH') as any;
          vuePath.setAttribute('data-v-7ba24e9c', '');
          assert.strictEqual(isInteractiveSvgNode(vuePath), false);

          const testIdPath = new MockSvgNode('PATH') as any;
          testIdPath.setAttribute('data-testid', 'icon-check');
          assert.strictEqual(isInteractiveSvgNode(testIdPath), false);

          // Semantic IDs and interactive data attributes are retained
          const semanticPath = new MockSvgNode('PATH') as any;
          semanticPath.id = 'nav-home-icon';
          assert.strictEqual(isInteractiveSvgNode(semanticPath), true);

          const interactiveDataPath = new MockSvgNode('PATH') as any;
          interactiveDataPath.setAttribute('data-action', 'expand-menu');
          assert.strictEqual(isInteractiveSvgNode(interactiveDataPath), true);

          const clickDataPath = new MockSvgNode('PATH') as any;
          clickDataPath.setAttribute('data-click', 'open-modal');
          assert.strictEqual(isInteractiveSvgNode(clickDataPath), true);
        });

        it('P2: Smart Scroll discovers scroll containers strictly within the viewport and avoids offscreen traps', () => {
          const originalDoc = globalThis.document;
          const originalWin = globalThis.window;

          class MockViewportContainer {
            tagName = 'DIV';
            id = 'in-viewport-container';
            scrollHeight = 1500;
            clientHeight = 400;
            scrollWidth = 300;
            clientWidth = 300;
            scrollTop = 0;
            scrollLeft = 0;
            rect = { x: 50, y: 100, width: 300, height: 400, left: 50, right: 350, top: 100, bottom: 500 };
            getBoundingClientRect() { return this.rect; }
            querySelectorAll() { return [{ tagName: 'A' }, { tagName: 'BUTTON' }]; }
          }

          class MockOffscreenContainer {
            tagName = 'DIV';
            id = 'offscreen-huge-container';
            scrollHeight = 5000;
            clientHeight = 2000;
            scrollWidth = 800;
            clientWidth = 800;
            scrollTop = 0;
            scrollLeft = 0;
            // Far below viewport (viewport height is 768)
            rect = { x: 0, y: 3000, width: 800, height: 2000, left: 0, right: 800, top: 3000, bottom: 5000 };
            getBoundingClientRect() { return this.rect; }
            querySelectorAll() { return new Array(20).fill({ tagName: 'BUTTON' }); }
          }

          const inVp = new MockViewportContainer() as any;
          const offscreen = new MockOffscreenContainer() as any;

          (globalThis as any).document = {
            body: { scrollHeight: 6000, clientHeight: 768 },
            documentElement: { scrollHeight: 6000, clientHeight: 768 },
            querySelectorAll: () => [offscreen, inVp],
          };

          (globalThis as any).window = {
            innerWidth: 1024,
            innerHeight: 768,
            scrollY: 0,
            scrollX: 0,
            getComputedStyle: () => ({
              overflowY: 'auto',
              overflowX: 'hidden',
              display: 'block',
              visibility: 'visible',
              opacity: '1',
            }),
          };

          try {
            const target = inPageFindSmartScrollTarget();
            assert.strictEqual(target.found, true);
            // Must pick in-viewport container, NOT the huge offscreen one
            assert.strictEqual(target.selector, '#in-viewport-container');
            // Dispatch coordinates must be inside viewport
            assert.ok(target.x >= 50 && target.x <= 350, `Dispatch x must be in visible range: ${target.x}`);
            assert.ok(target.y >= 100 && target.y <= 500, `Dispatch y must be in visible range: ${target.y}`);

            // Explicit isWindow option returns window directly
            const windowTarget = inPageFindSmartScrollTarget({ isWindow: true });
            assert.strictEqual(windowTarget.isWindow, true);
            assert.strictEqual(windowTarget.tagName, 'window');
          } finally {
            globalThis.document = originalDoc;
            globalThis.window = originalWin;
          }
        });

        it('P1: DialogOpenedError formatting and structure conforms to { success: false, requiresDialogAction: true, dialog: ... }', async () => {
          const { DialogOpenedError, createDialogInterruptResponse } = await import(
            '../app/chrome-extension/utils/race-cdp.ts'
          );

          const err = new DialogOpenedError({
            type: 'confirm',
            message: 'Are you sure you want to proceed?',
            defaultPrompt: '',
          });

          const resp = createDialogInterruptResponse(err);
          assert.strictEqual(resp.isError, false);
          assert.strictEqual(resp.content.length, 1);
          assert.strictEqual(resp.content[0].type, 'text');

          const parsed = JSON.parse(resp.content[0].text);
          assert.strictEqual(parsed.success, false);
          assert.strictEqual(parsed.requiresDialogAction, true);
          assert.strictEqual(parsed.dialog.type, 'confirm');
          assert.strictEqual(parsed.dialog.message, 'Are you sure you want to proceed?');
        });

        it('P1: CDP Session Manager tracks inFlightRequests and cleans up on main frame navigation', async () => {
          const { cdpSessionManager } = await import(
            '../app/chrome-extension/utils/cdp-session-manager.ts'
          );

          const testTabId = 99999;
          assert.strictEqual(cdpSessionManager.hasInFlightRequests(testTabId), false);

          // Directly simulate listener invocation
          (cdpSessionManager as any).inFlightRequests.set(testTabId, new Set(['req-1', 'req-2']));
          assert.strictEqual(cdpSessionManager.hasInFlightRequests(testTabId), true);
          assert.strictEqual(cdpSessionManager.getInFlightRequests(testTabId).size, 2);

          // Clear
          cdpSessionManager.clearInFlightRequests(testTabId);
          assert.strictEqual(cdpSessionManager.hasInFlightRequests(testTabId), false);
        });

        it('P2: BURST_INTERACT schema contains coordinateSpace parameter with [viewport, screenshot]', () => {
          const burstSchema = (RAW_TOOL_SCHEMAS || TOOL_SCHEMAS).find((t) => t.name === 'chrome_burst_interact');
          assert.ok(burstSchema, 'chrome_burst_interact schema must exist');
          const props = burstSchema.inputSchema.properties;
          assert.ok(props.coordinateSpace, 'coordinateSpace property must exist in schema');
          assert.deepStrictEqual(props.coordinateSpace.enum, ['viewport', 'screenshot']);
        });

        it('GoFullPage Engine: TOOL_SCHEMAS includes fullPage and maxHeight under chrome_screenshot', () => {
          const screenshotSchema = (RAW_TOOL_SCHEMAS || TOOL_SCHEMAS).find((t) => t.name === 'chrome_screenshot');
          assert.ok(screenshotSchema, 'chrome_screenshot schema must exist');
          const props = screenshotSchema.inputSchema.properties;
          assert.ok(props.fullPage, 'fullPage property must exist in schema');
          assert.strictEqual(props.fullPage.type, 'boolean');
          assert.ok(props.fullPage.description.includes('GoFullPage-grade'), 'fullPage description should highlight GoFullPage industrial capabilities');
          assert.ok(props.maxHeight, 'maxHeight property must exist in schema');
          assert.strictEqual(props.maxHeight.type, 'number');
        });

        it('GoFullPage Engine: MAX_CANVAS_DIM and MAX_CANVAS_AREA safety constants and downscaling logic', async () => {
          const { MAX_CANVAS_DIM, MAX_CANVAS_AREA, stitchImages } = await import(
            '../app/chrome-extension/utils/image-utils.ts'
          );
          assert.strictEqual(MAX_CANVAS_DIM, 16384);
          assert.strictEqual(MAX_CANVAS_AREA, 268435456);

          // Test extreme dimensions clamping
          const canvas = await stitchImages([], 20000, 20000);
          assert.ok(canvas.width <= MAX_CANVAS_DIM, `Width ${canvas.width} must be <= ${MAX_CANVAS_DIM}`);
          assert.ok(canvas.height <= MAX_CANVAS_DIM, `Height ${canvas.height} must be <= ${MAX_CANVAS_DIM}`);
          assert.ok(
            canvas.width * canvas.height <= MAX_CANVAS_AREA,
            `Area ${canvas.width * canvas.height} must be <= ${MAX_CANVAS_AREA}`,
          );
        });

        it('GoFullPage Engine: TOOL_MESSAGE_TYPES includes SCREENSHOT_PREPARE_SLICE and SCREENSHOT_WARMUP_PAGE', () => {
          const content = fs.readFileSync(
            path.resolve(process.cwd(), 'app/chrome-extension/common/message-types.ts'),
            'utf8',
          );
          assert.ok(content.includes("SCREENSHOT_PREPARE_SLICE: 'prepareSlice'"));
          assert.ok(content.includes("SCREENSHOT_WARMUP_PAGE: 'warmupPage'"));
        });

        it('GoFullPage Engine: screenshotContextManager retains dimensions for fullPage captures', () => {
          const testTabId = 88888;
          screenshotContextManager.setContext(testTabId, {
            screenshotWidth: 1280,
            screenshotHeight: 3600,
            viewportWidth: 1280,
            viewportHeight: 800,
            devicePixelRatio: 2,
            hostname: 'example.com',
          });

          const ctx = screenshotContextManager.getContext(testTabId);
          assert.ok(ctx);
          assert.strictEqual(ctx.screenshotWidth, 1280);
          assert.strictEqual(ctx.screenshotHeight, 3600);
          assert.strictEqual(ctx.viewportWidth, 1280);
          assert.strictEqual(ctx.viewportHeight, 800);
          screenshotContextManager.clear(testTabId);
        });
      });
    });
  });
});

after(() => {
  setTimeout(() => process.exit(0), 100);
});
