// @vitest-environment node
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { SessionTabAffinityManager } from '../utils/session-tab-affinity';
import { inPageWaitForDOMSettle } from '../utils/action-watchdog';
import { computeHumanizedPoints } from '../utils/mouse-trajectory';
import {
  inPageGetIndexCropRect,
  getIsolatedIndexMap,
  wrapElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { waitForDownload } from '../entrypoints/background/tools/browser/download-waiter';
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

    let mutationCallback: ((mutations: any[]) => void) | undefined;
    class MockObserver {
      callback: (mutations: any[]) => void;
      constructor(cb: any) {
        this.callback = cb;
        mutationCallback = cb;
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
        mutationCallback?.([{ type: 'childList' }, { type: 'attributes' }]);
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

    let mutationCallback: ((mutations: any[]) => void) | undefined;
    class MockObserver {
      callback: (mutations: any[]) => void;
      constructor(cb: any) {
        this.callback = cb;
        mutationCallback = cb;
      }
      observe() {}
      disconnect() {}
    }

    (globalThis as any).document = { documentElement: {} };
    (globalThis as any).MutationObserver = MockObserver;

    try {
      const interval = setInterval(() => {
        mutationCallback?.([{ type: 'childList' }]);
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

    Object.assign(mockElement, { isConnected: true, ownerDocument: document });
    const previousEntry = getIsolatedIndexMap().get(42);
    getIsolatedIndexMap().set(42, wrapElement(mockElement as any));

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
      if (previousEntry === undefined) getIsolatedIndexMap().delete(42);
      else getIsolatedIndexMap().set(42, previousEntry);
      (globalThis as any).document = originalDocument;
      (globalThis as any).window = originalWindow;
      (globalThis as any).Element = originalElement;
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
      assert.strictEqual(
        createdListenerRemoved,
        true,
        'onCreated listener must be strictly removed on resolve',
      );
      assert.strictEqual(
        changedListenerRemoved,
        true,
        'onChanged listener must be strictly removed on resolve',
      );
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
