import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionTabAffinity, startHandoverTracking } from '../utils/session-tab-affinity';
import {
  inPageDOMPruner,
  inPageExtractDropdownOptions,
  inPageDismissOverlays,
  inPageVerifyInputCommitment,
  getIsolatedIndexMap,
  wrapElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { cdpSessionManager } from '../utils/cdp-session-manager';

describe('Auto Tab Affinity Handover, Viewport Virtualization & Universal Framework Support', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    sessionTabAffinity.clearAll();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Auto Tab Affinity Handover
  // =========================================================================
  describe('1. Auto Tab Affinity Handover', () => {
    it('automatically transfers session affinity when a child tab with openerTabId is created and activated', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({ id, windowId: 1, active: id === 200 })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn((fn) => {
              const idx = createdListeners.indexOf(fn);
              if (idx !== -1) createdListeners.splice(idx, 1);
            }),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn((fn) => {
              const idx = activatedListeners.indexOf(fn);
              if (idx !== -1) activatedListeners.splice(idx, 1);
            }),
          },
        },
      };

      // Set initial affinity for session
      sessionTabAffinity.setAffinity('test-session', 100);
      expect(sessionTabAffinity.getAffinity('test-session')).toBe(100);

      // Start handover tracking
      const tracker = startHandoverTracking(100, 'test-session', { windowId: 1 });

      // Simulate child tab created and activated
      const childTab = { id: 200, openerTabId: 100, windowId: 1, active: true };
      for (const fn of [...createdListeners]) fn(childTab);
      for (const fn of [...activatedListeners]) fn({ tabId: 200, windowId: 1 });

      const result = await tracker.waitForHandover(500);
      expect(result).not.toBeNull();
      expect(result?.handover).toBe(true);
      expect(result?.newTabId).toBe(200);
      expect(result?.previousTabId).toBe(100);

      // Affinity must have auto-transferred to childTabId 200
      expect(sessionTabAffinity.getAffinity('test-session')).toBe(200);
    });

    it('transfers affinity even when openerTabId is undefined (rel="noopener" / window.open without opener) with webNavigation sourceTabId proof', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];
      const navTargetListeners: Array<(details: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({ id, windowId: 1, active: id === 300 })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn((fn) => {
              const idx = createdListeners.indexOf(fn);
              if (idx !== -1) createdListeners.splice(idx, 1);
            }),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn((fn) => {
              const idx = activatedListeners.indexOf(fn);
              if (idx !== -1) activatedListeners.splice(idx, 1);
            }),
          },
        },
        webNavigation: {
          onCreatedNavigationTarget: {
            addListener: vi.fn((fn) => navTargetListeners.push(fn)),
            removeListener: vi.fn((fn) => {
              const idx = navTargetListeners.indexOf(fn);
              if (idx !== -1) navTargetListeners.splice(idx, 1);
            }),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-rel-noopener', 100);

      const tracker = startHandoverTracking(100, 'session-rel-noopener', { windowId: 1 });

      // In real Chromium, target="_blank" rel="noopener" lacks tab.openerTabId,
      // but fires webNavigation.onCreatedNavigationTarget with sourceTabId = 100!
      for (const fn of [...navTargetListeners]) {
        fn({ sourceTabId: 100, tabId: 300, url: 'https://example.com/target-blank-noopener' });
      }

      // Child tab opened with rel="noopener" has NO openerTabId
      const noOpenerTab = { id: 300, openerTabId: undefined, windowId: 1, active: true };
      for (const fn of [...createdListeners]) fn(noOpenerTab);
      for (const fn of [...activatedListeners]) fn({ tabId: 300, windowId: 1 });

      const result = await tracker.waitForHandover(500);
      expect(result).not.toBeNull();
      expect(result?.handover).toBe(true);
      expect(result?.newTabId).toBe(300);
      expect(sessionTabAffinity.getAffinity('session-rel-noopener')).toBe(300);
    });

    it('gracefully times out without changing affinity when no new tab opens', async () => {
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
          onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
          onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        },
      };

      sessionTabAffinity.setAffinity('session-quiet', 100);
      const tracker = startHandoverTracking(100, 'session-quiet', { windowId: 1 });

      const result = await tracker.waitForHandover(50);
      expect(result).toBeNull();
      expect(sessionTabAffinity.getAffinity('session-quiet')).toBe(100);
    });

    it('handles async query race where child tab onCreated arrives before query snapshot resolves', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];

      let resolveQuery: (tabs: any[]) => void;
      const queryPromise = new Promise<any[]>((resolve) => {
        resolveQuery = resolve;
      });

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(() => queryPromise),
          get: vi.fn(async (id: number) => ({
            id,
            windowId: 1,
            active: id === 400,
            url: 'https://example.com/item/1',
          })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-async-race', 100);
      const tracker = startHandoverTracking(100, 'session-async-race', { windowId: 1 });

      // Child tab created and activated BEFORE query snapshot resolves
      const childTab = { id: 400, openerTabId: 100, windowId: 1, active: true };
      for (const fn of [...createdListeners]) fn(childTab);
      for (const fn of [...activatedListeners]) fn({ tabId: 400, windowId: 1 });

      // Now query resolves including both 100 and the new tab 400
      resolveQuery!([
        { id: 100, windowId: 1 },
        { id: 400, windowId: 1 },
      ]);

      const result = await tracker.waitForHandover(500);
      expect(result).not.toBeNull();
      expect(result?.handover).toBe(true);
      expect(result?.newTabId).toBe(400);
      expect(sessionTabAffinity.getAffinity('session-async-race')).toBe(400);
    });

    it('isolates handover tracking by windowId to avoid capturing tabs created in other windows', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async (filter: any) => {
            if (filter?.windowId === 1) return [{ id: 100, windowId: 1 }];
            if (filter?.windowId === 2) return [{ id: 999, windowId: 2 }];
            return [
              { id: 100, windowId: 1 },
              { id: 999, windowId: 2 },
            ];
          }),
          get: vi.fn(async (id: number) => ({ id, windowId: id === 999 ? 2 : 1, active: true })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-window-iso', 100);
      const tracker = startHandoverTracking(100, 'session-window-iso', { windowId: 1 });

      // Tab 999 opened in Window 2 by unrelated user action
      const unrelatedTab = { id: 999, windowId: 2, active: true };
      for (const fn of [...createdListeners]) fn(unrelatedTab);
      for (const fn of [...activatedListeners]) fn({ tabId: 999, windowId: 2 });

      const result = await tracker.waitForHandover(60);
      expect(result).toBeNull();
      expect(sessionTabAffinity.getAffinity('session-window-iso')).toBe(100);
    });

    it('inherits parent tab group when auto-handover affinity migrates to child tab', async () => {
      const groupMock = vi.fn(async () => 55);
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({
            id,
            windowId: 1,
            groupId: id === 100 ? 55 : -1,
            active: id === 500,
          })),
          group: groupMock,
          onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
          onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        },
      };

      sessionTabAffinity.setAffinity('session-tabgroup', 100);
      sessionTabAffinity.handleChildTabActivated(500, 100, 'https://example.com');

      expect(sessionTabAffinity.getAffinity('session-tabgroup')).toBe(500);
      // Wait microtask for chrome.tabs.group call
      await new Promise((r) => setTimeout(r, 20));
      expect(groupMock).toHaveBeenCalledWith({ tabIds: [500], groupId: 55 });
    });

    // =========================================================================
    // BROWSER-SESSION-01 Reproduction Cases:
    // User clicks a button in tab 100 that only mutates logs or fetches API.
    // While tracking, the user independently opens a new tab 999 (e.g. GitHub)
    // in window 1 without openerTabId or webNavigation sourceTabId proof.
    // Handover MUST be rejected (return null), and affinity MUST remain bound to tab 100.
    // =========================================================================
    it('BROWSER-SESSION-01: does NOT handover affinity to concurrent user-created tab without opener or navigation proof', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({
            id,
            windowId: 1,
            active: id === 999,
            url: 'https://github.com/my-project',
            title: 'GitHub: Where the world builds software',
          })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn((fn) => {
              const idx = createdListeners.indexOf(fn);
              if (idx !== -1) createdListeners.splice(idx, 1);
            }),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn((fn) => {
              const idx = activatedListeners.indexOf(fn);
              if (idx !== -1) activatedListeners.splice(idx, 1);
            }),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-srcdoc-log', 100);
      expect(sessionTabAffinity.getAffinity('session-srcdoc-log')).toBe(100);

      const tracker = startHandoverTracking(100, 'session-srcdoc-log', { windowId: 1 });

      // Simulate concurrent user action: user opens a new tab in the same window (e.g. via Ctrl+T or bookmark)
      // Tab 999 has NO openerTabId and NO parent navigation proof!
      const userCreatedTab = {
        id: 999,
        openerTabId: undefined,
        windowId: 1,
        active: true,
        url: 'https://github.com/my-project',
        title: 'GitHub',
      };
      for (const fn of [...createdListeners]) fn(userCreatedTab);
      for (const fn of [...activatedListeners]) fn({ tabId: 999, windowId: 1 });

      // Handover MUST NOT occur; tracker must return null and affinity must remain on tab 100
      const result = await tracker.waitForHandover(200);
      expect(result).toBeNull();
      expect(sessionTabAffinity.getAffinity('session-srcdoc-log')).toBe(100);
    });

    it('does NOT handover affinity when an existing user tab is activated', async () => {
      const activatedListeners: Array<(activeInfo: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [
            { id: 100, windowId: 1 },
            { id: 500, windowId: 1, url: 'https://news.ycombinator.com', title: 'Hacker News' },
          ]),
          get: vi.fn(async (id: number) => ({
            id,
            windowId: 1,
            active: id === 500,
            url: 'https://news.ycombinator.com',
            title: 'Hacker News',
          })),
          onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn((fn) => {
              const idx = activatedListeners.indexOf(fn);
              if (idx !== -1) activatedListeners.splice(idx, 1);
            }),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-existing-tab', 100);
      const tracker = startHandoverTracking(100, 'session-existing-tab', { windowId: 1 });

      // User switches to existing tab 500
      for (const fn of [...activatedListeners]) fn({ tabId: 500, windowId: 1 });

      const result = await tracker.waitForHandover(150);
      expect(result).toBeNull();
      expect(sessionTabAffinity.getAffinity('session-existing-tab')).toBe(100);
    });

    it('transfers affinity when webNavigation proof arrives before OR after onCreated for valid rel="noopener"', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];
      const navTargetListeners: Array<(details: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({ id, windowId: 1, active: id === 301 })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
        webNavigation: {
          onCreatedNavigationTarget: {
            addListener: vi.fn((fn) => navTargetListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-proof-order', 100);
      const tracker = startHandoverTracking(100, 'session-proof-order', { windowId: 1 });

      // Scenario: onCreated fires FIRST without openerTabId, and webNavigation proof arrives slightly AFTER
      const noOpenerTab = { id: 301, openerTabId: undefined, windowId: 1, active: true };
      for (const fn of [...createdListeners]) fn(noOpenerTab);

      // Proof arrives asynchronously after tab creation
      for (const fn of [...navTargetListeners]) {
        fn({ sourceTabId: 100, tabId: 301, url: 'https://example.com/item' });
      }

      for (const fn of [...activatedListeners]) fn({ tabId: 301, windowId: 1 });

      const result = await tracker.waitForHandover(500);
      expect(result).not.toBeNull();
      expect(result?.handover).toBe(true);
      expect(result?.newTabId).toBe(301);
      expect(sessionTabAffinity.getAffinity('session-proof-order')).toBe(301);
    });

    it('transfers affinity when onCreated active=false, onActivated active=true arrives before navproof, and navproof arrives last', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];
      const navTargetListeners: Array<(details: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({
            id,
            windowId: 1,
            active: true,
            url: 'https://example.com/activated-child',
          })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
        webNavigation: {
          onCreatedNavigationTarget: {
            addListener: vi.fn((fn) => navTargetListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-late-navproof', 100);
      const tracker = startHandoverTracking(100, 'session-late-navproof', { windowId: 1 });

      // Step 1: onCreated fires first with active = false (tab initially spawned in background)
      const initialInactiveTab = { id: 305, openerTabId: undefined, windowId: 1, active: false };
      for (const fn of [...createdListeners]) fn(initialInactiveTab);

      // Step 2: onActivated fires next; tabs.get returns active = true, but navproof is NOT yet available
      for (const fn of [...activatedListeners]) fn({ tabId: 305, windowId: 1 });

      // Step 3: webNavigation.onCreatedNavigationTarget arrives LAST with sourceTabId proof = 100
      for (const fn of [...navTargetListeners]) {
        fn({ sourceTabId: 100, tabId: 305, url: 'https://example.com/activated-child' });
      }

      // Handover MUST successfully transfer to tab 305 based on fresh tab active state!
      const result = await tracker.waitForHandover(500);
      expect(result).not.toBeNull();
      expect(result?.handover).toBe(true);
      expect(result?.newTabId).toBe(305);
      expect(sessionTabAffinity.getAffinity('session-late-navproof')).toBe(305);
    });

    it('does NOT handover affinity if webNavigation proof points to an unrelated sourceTabId', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];
      const navTargetListeners: Array<(details: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({ id, windowId: 1, active: id === 302 })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
        webNavigation: {
          onCreatedNavigationTarget: {
            addListener: vi.fn((fn) => navTargetListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-wrong-source', 100);
      const tracker = startHandoverTracking(100, 'session-wrong-source', { windowId: 1 });

      // Proof says tab 302 was spawned by unrelated tab 888 (NOT parent 100!)
      for (const fn of [...navTargetListeners]) {
        fn({ sourceTabId: 888, tabId: 302, url: 'https://external.com' });
      }

      const noOpenerTab = { id: 302, openerTabId: undefined, windowId: 1, active: true };
      for (const fn of [...createdListeners]) fn(noOpenerTab);
      for (const fn of [...activatedListeners]) fn({ tabId: 302, windowId: 1 });

      const result = await tracker.waitForHandover(200);
      expect(result).toBeNull();
      expect(sessionTabAffinity.getAffinity('session-wrong-source')).toBe(100);
    });

    it('does NOT mutate affinity if delayed chrome.tabs.get callback resolves after tracker cancel', async () => {
      let resolveDelayedGet: ((tab: any) => void) | null = null;
      const delayedGetPromise = new Promise<any>((resolve) => {
        resolveDelayedGet = resolve;
      });

      const activatedListeners: Array<(activeInfo: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn((id: number) => {
            if (id === 909) return delayedGetPromise;
            return Promise.resolve({ id, windowId: 1, active: true });
          }),
          onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-cancel-guard', 100);
      const tracker = startHandoverTracking(100, 'session-cancel-guard', { windowId: 1 });

      // Trigger onActivated which starts the async tabs.get(909)
      for (const fn of [...activatedListeners]) fn({ tabId: 909, windowId: 1 });

      // Tracker is cancelled before delayed get resolves
      tracker.cancel();

      // Now delayed tabs.get resolves with active tab 909
      if (resolveDelayedGet) {
        (resolveDelayedGet as any)({ id: 909, openerTabId: 100, windowId: 1, active: true });
      }
      await new Promise((r) => setTimeout(r, 60));

      // Affinity must remain safely on 100, not hijacked by cancelled tracker
      expect(sessionTabAffinity.getAffinity('session-cancel-guard')).toBe(100);
    });

    it('multi-session isolation: does NOT hijack concurrent session bound to same parent tab during handover', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({
            id,
            windowId: 1,
            active: id === 600,
            openerTabId: 100,
          })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
        },
      };

      (sessionTabAffinity as any).initListeners();
      sessionTabAffinity.setAffinity('session-A', 100);
      sessionTabAffinity.setAffinity('session-B', 100);

      const tracker = startHandoverTracking(100, 'session-A', { windowId: 1 });

      expect(createdListeners.length).toBe(2);
      expect(activatedListeners.length).toBe(2);

      const childTab = { id: 600, openerTabId: 100, windowId: 1, active: true };
      for (const fn of [...createdListeners]) fn(childTab);
      for (const fn of [...activatedListeners]) fn({ tabId: 600, windowId: 1 });

      const result = await tracker.waitForHandover(300);
      expect(result).not.toBeNull();
      expect(result?.newTabId).toBe(600);

      expect(sessionTabAffinity.getAffinity('session-A')).toBe(600);
      expect(sessionTabAffinity.getAffinity('session-B')).toBe(100);
    });

    it.each(['https://example.com/child', 'about:blank'])(
      'BROWSER-SESSION-02: resolves a pending child URL before reporting handover (%s)',
      async (finalUrl) => {
        const createdListeners: Array<(tab: any) => void> = [];
        (globalThis as any).chrome = {
          tabs: {
            get: vi.fn(async (id: number) => ({
              id,
              windowId: 1,
              active: true,
              url: finalUrl,
              title: 'Child',
            })),
            onCreated: {
              addListener: vi.fn((fn) => createdListeners.push(fn)),
              removeListener: vi.fn(),
            },
            onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
            onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
          },
        };
        sessionTabAffinity.setAffinity('session-A', 100);
        sessionTabAffinity.setAffinity('session-B', 100);
        const tracker = startHandoverTracking(100, 'session-A', { windowId: 1 });
        for (const listener of createdListeners) {
          listener({
            id: 601,
            openerTabId: 100,
            windowId: 1,
            active: true,
            url: '',
            pendingUrl: 'https://example.com/child',
          });
        }
        const result = await tracker.waitForHandover(100);
        if (finalUrl === 'about:blank') {
          expect(result).toBeNull();
          expect(sessionTabAffinity.getAffinity('session-A')).toBe(100);
        } else {
          expect(result).toMatchObject({ handover: true, newTabId: 601, url: finalUrl });
          expect(sessionTabAffinity.getAffinity('session-A')).toBe(601);
        }
        expect(sessionTabAffinity.getAffinity('session-B')).toBe(100);
      },
    );

    it('tab lifecycle: aborts tracking when parentTabId is removed', async () => {
      const removedListeners: Array<(tabId: number) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => []),
          get: vi.fn(async () => null),
          onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
          onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
          onRemoved: {
            addListener: vi.fn((fn) => removedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      sessionTabAffinity.setAffinity('session-parent-closed', 100);
      const tracker = startHandoverTracking(100, 'session-parent-closed', { windowId: 1 });

      for (const fn of [...removedListeners]) fn(100);

      const result = await tracker.waitForHandover(150);
      expect(result).toBeNull();
    });

    it('tab lifecycle: does NOT handover to child tab if child tab was closed before handover resolves', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => []),
          get: vi.fn(async (_id: number) => {
            throw new Error('Tabs cannot be edited: tab was closed');
          }),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
        },
      };

      sessionTabAffinity.setAffinity('session-child-dead', 100);
      const tracker = startHandoverTracking(100, 'session-child-dead', { windowId: 1 });

      const deadChild = { id: 700, openerTabId: 100, windowId: 1, active: true };
      for (const fn of [...createdListeners]) fn(deadChild);
      for (const fn of [...activatedListeners]) fn({ tabId: 700, windowId: 1 });

      const result = await tracker.waitForHandover(150);
      expect(result).toBeNull();
      expect(sessionTabAffinity.getAffinity('session-child-dead')).toBe(100);
    });
  });

  // =========================================================================
  // 2. Viewport Virtualization Pruning
  // =========================================================================
  describe('2. Viewport Virtualization Pruning in inPageDOMPruner', () => {
    it('folds distant offscreen repetitive sibling cards into virtualized markers in reading order', () => {
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });

      const container = document.createElement('div');
      container.id = 'product-list';
      document.body.appendChild(container);

      // Create 15 repetitive product cards
      // First 3 inside viewport (y = 50, 200, 350 <= 900)
      // Remaining 12 offscreen but within threshold (y = 950..1500)
      for (let i = 0; i < 15; i++) {
        const card = document.createElement('div');
        card.className = 'product-card';
        const isOffscreen = i >= 3;
        const top = isOffscreen ? 950 + (i - 3) * 45 : 50 + i * 150;

        card.getBoundingClientRect = () =>
          ({
            top,
            bottom: top + 40,
            left: 50,
            right: 350,
            width: 300,
            height: 40,
            x: 50,
            y: top,
            toJSON: () => {},
          }) as DOMRect;

        const btn = document.createElement('button');
        btn.textContent = `Buy Item ${i + 1}`;
        btn.getBoundingClientRect = card.getBoundingClientRect;

        card.appendChild(btn);
        container.appendChild(card);
      }

      const res = inPageDOMPruner({ virtualizeViewport: true, viewportThreshold: 800 });

      // Check virtualization metrics
      expect(res.virtualizedCount).toBeGreaterThan(0);
      expect(res.virtualizedSummary).toBeDefined();
      expect(res.virtualizedSummary?.length).toBeGreaterThan(0);
      expect(res.virtualizedSummary?.[0].selector).toContain('div#product-list');

      // Verify that the treeString contains the virtualized annotation marker
      expect(res.treeString).toMatch(/~ \[virtualized: \d+ similar offscreen items/);

      // Verify that in-viewport items are preserved and indexed
      expect(res.treeString).toContain('Buy Item 1');
      expect(res.treeString).toContain('Buy Item 2');
      expect(res.treeString).toContain('Buy Item 3');

      // Verify that numeric indexing did NOT give an index to the virtual marker
      for (const [idxStr, entry] of Object.entries(res.indexMap)) {
        expect(entry.tagName).not.toBe('virtual_marker');
        expect(Number(idxStr)).toBeGreaterThan(0);
      }
    });

    it('protects critical navigation, footer, dialog, and sticky elements from being virtualized', () => {
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });

      const nav = document.createElement('nav');
      nav.id = 'main-nav';
      const navLink = document.createElement('a');
      navLink.href = '/checkout';
      navLink.textContent = 'Proceed to Checkout';
      // Nav link placed within threshold window
      navLink.getBoundingClientRect = () =>
        ({
          top: 1000,
          bottom: 1050,
          left: 50,
          right: 250,
          width: 200,
          height: 50,
          x: 50,
          y: 1000,
          toJSON: () => {},
        }) as DOMRect;
      nav.appendChild(navLink);
      document.body.appendChild(nav);

      const footer = document.createElement('footer');
      const footerBtn = document.createElement('button');
      footerBtn.textContent = 'Contact Support';
      footerBtn.getBoundingClientRect = () =>
        ({
          top: 1200,
          bottom: 1250,
          left: 50,
          right: 250,
          width: 200,
          height: 50,
          x: 50,
          y: 1200,
          toJSON: () => {},
        }) as DOMRect;
      footer.appendChild(footerBtn);
      document.body.appendChild(footer);

      const res = inPageDOMPruner({ virtualizeViewport: true, viewportThreshold: 800 });
      expect(res.treeString).toContain('Proceed to Checkout');
      expect(res.treeString).toContain('Contact Support');
    });

    it('does not virtualize when virtualizeViewport is explicitly false', () => {
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });

      const container = document.createElement('div');
      container.id = 'items';
      document.body.appendChild(container);

      for (let i = 0; i < 8; i++) {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.getBoundingClientRect = () =>
          ({
            top: 200,
            bottom: 250,
            left: 50,
            right: 200,
            width: 150,
            height: 50,
            x: 50,
            y: 200,
            toJSON: () => {},
          }) as DOMRect;
        const btn = document.createElement('button');
        btn.textContent = `Item ${i}`;
        btn.getBoundingClientRect = item.getBoundingClientRect;
        item.appendChild(btn);
        container.appendChild(item);
      }

      const res = inPageDOMPruner({ virtualizeViewport: false });
      expect(res.virtualizedCount).toBeUndefined();
      expect(res.virtualizedSummary).toBeUndefined();
      expect(res.treeString).not.toContain('~ [virtualized:');
    });

    it('clips items inside nested scrollable containers when calculating offscreen virtualization', () => {
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });

      const scrollContainer = document.createElement('div');
      scrollContainer.id = 'chat-scroll-container';
      scrollContainer.style.overflowY = 'auto';
      scrollContainer.getBoundingClientRect = () =>
        ({
          top: 100,
          bottom: 400,
          left: 50,
          right: 350,
          width: 300,
          height: 300,
          x: 50,
          y: 100,
          toJSON: () => {},
        }) as DOMRect;
      document.body.appendChild(scrollContainer);

      // Create 15 chat messages inside the 300px-high scroll container
      for (let i = 0; i < 15; i++) {
        const msg = document.createElement('div');
        msg.className = 'chat-message';
        // Messages 0..4 are within 100..350px (inside container)
        // Messages 5..9 are > 450px (clipped by container overflow:auto, but still < window.innerHeight 900px)
        const topY = 100 + i * 50;
        msg.getBoundingClientRect = () =>
          ({
            top: topY,
            bottom: topY + 40,
            left: 60,
            right: 340,
            width: 280,
            height: 40,
            x: 60,
            y: topY,
            toJSON: () => {},
          }) as DOMRect;
        const textBtn = document.createElement('button');
        textBtn.textContent = `Message ${i}`;
        textBtn.getBoundingClientRect = msg.getBoundingClientRect;
        msg.appendChild(textBtn);
        scrollContainer.appendChild(msg);
      }

      const res = inPageDOMPruner({ virtualizeViewport: true, viewportThreshold: 800 });
      expect(res.virtualizedCount).toBeGreaterThan(0);
      expect(res.treeString).toContain('~ [virtualized:');
      expect(res.treeString).toContain('chat-message');
    });

    it('preserves exact DOM order of interleaved siblings during virtualization pruning', () => {
      Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });

      const feed = document.createElement('div');
      feed.id = 'interleaved-feed';
      document.body.appendChild(feed);

      // Create 6 items: alternating type A (in viewport) and type B (in viewport)
      for (let i = 0; i < 6; i++) {
        const item = document.createElement('div');
        item.className = i % 2 === 0 ? 'post-card' : 'sponsor-banner';
        const topY = 100 + i * 60;
        item.getBoundingClientRect = () =>
          ({
            top: topY,
            bottom: topY + 50,
            left: 100,
            right: 400,
            width: 300,
            height: 50,
            x: 100,
            y: topY,
            toJSON: () => {},
          }) as DOMRect;
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = `${item.className} ${i}`;
        link.getBoundingClientRect = item.getBoundingClientRect;
        item.appendChild(link);
        feed.appendChild(item);
      }

      const res = inPageDOMPruner({ virtualizeViewport: true });
      // Verify all 6 items appear in strictly alternating sequence in the output
      const matches = Array.from(res.treeString.matchAll(/(post-card|sponsor-banner) \d/g)).map(
        (m) => m[0],
      );
      expect(matches).toEqual([
        'post-card 0',
        'sponsor-banner 1',
        'post-card 2',
        'sponsor-banner 3',
        'post-card 4',
        'sponsor-banner 5',
      ]);
    });

    it('protects document.activeElement from virtualization pruning even if positioned offscreen', () => {
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });

      const container = document.createElement('div');
      container.id = 'long-form-feed';
      document.body.appendChild(container);

      let focusedInput: HTMLInputElement | null = null;
      for (let i = 0; i < 10; i++) {
        const row = document.createElement('div');
        row.className = 'form-row';
        const topY = 800 + i * 100; // Far offscreen (> 500)
        row.getBoundingClientRect = () =>
          ({
            top: topY,
            bottom: topY + 80,
            left: 50,
            right: 500,
            width: 450,
            height: 80,
            x: 50,
            y: topY,
            toJSON: () => {},
          }) as DOMRect;
        const input = document.createElement('input');
        input.value = `Row value ${i}`;
        input.getBoundingClientRect = row.getBoundingClientRect;
        row.appendChild(input);
        container.appendChild(row);
        if (i === 6) focusedInput = input;
      }

      // Focus row 6 input
      focusedInput?.focus();
      expect(document.activeElement).toBe(focusedInput);

      const res = inPageDOMPruner({ virtualizeViewport: true, viewportThreshold: 2000 });
      // Row 6 with the active focused input must NOT be folded away
      expect(res.treeString).toContain('Row value 6');
    });
  });

  // =========================================================================
  // 3. Universal Frontend UI Framework Compatibility
  // =========================================================================
  describe('3. Universal Frontend UI Framework Compatibility', () => {
    it('recognizes dropdown selected items across Radix UI, Shadcn, MUI, and Element Plus', async () => {
      // 1. Radix UI / Shadcn combobox portal
      const radixPortal = document.createElement('div');
      radixPortal.setAttribute('data-radix-popper-content-wrapper', '');
      radixPortal.setAttribute('role', 'listbox');

      const radixItem1 = document.createElement('div');
      radixItem1.setAttribute('role', 'option');
      radixItem1.setAttribute('data-radix-collection-item', '');
      radixItem1.setAttribute('data-state', 'checked');
      radixItem1.textContent = 'Radix Selected Item';

      const radixItem2 = document.createElement('div');
      radixItem2.setAttribute('role', 'option');
      radixItem2.setAttribute('data-radix-collection-item', '');
      radixItem2.setAttribute('data-state', 'unchecked');
      radixItem2.textContent = 'Radix Unchecked Item';

      radixPortal.appendChild(radixItem1);
      radixPortal.appendChild(radixItem2);
      document.body.appendChild(radixPortal);

      const selectTrigger = document.createElement('button');
      selectTrigger.id = 'select-trigger';
      selectTrigger.setAttribute('role', 'combobox');
      document.body.appendChild(selectTrigger);

      const dropdownRes = await inPageExtractDropdownOptions(undefined, '#select-trigger');
      expect(dropdownRes.success).toBe(true);
      expect(dropdownRes.options).toHaveLength(2);
      expect(dropdownRes.options?.[0].selected).toBe(true);
      expect(dropdownRes.options?.[1].selected).toBe(false);

      // 2. Element Plus select dropdown
      radixPortal.remove();
      const elDropdown = document.createElement('div');
      elDropdown.className = 'el-select-dropdown';
      elDropdown.setAttribute('role', 'listbox');

      const elItem1 = document.createElement('li');
      elItem1.className = 'el-select-dropdown__item is-selected';
      elItem1.textContent = 'Element Plus Active';

      const elItem2 = document.createElement('li');
      elItem2.className = 'el-select-dropdown__item';
      elItem2.textContent = 'Element Plus Normal';

      elDropdown.appendChild(elItem1);
      elDropdown.appendChild(elItem2);
      document.body.appendChild(elDropdown);

      const elRes = await inPageExtractDropdownOptions(undefined, '#select-trigger');
      expect(elRes.success).toBe(true);
      expect(elRes.options?.[0].selected).toBe(true);
      expect(elRes.options?.[1].selected).toBe(false);
    });

    it('dismisses overlays using universal class names without vendor bias', () => {
      // Test universal modal/dialog/popup/drawer close button
      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.style.position = 'fixed';
      modal.style.zIndex = '9999';
      modal.style.display = 'block';
      modal.style.visibility = 'visible';

      modal.getBoundingClientRect = () =>
        ({
          top: 0,
          left: 0,
          width: 500,
          height: 400,
          right: 500,
          bottom: 400,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect;

      const closeBtn = document.createElement('button');
      closeBtn.className = 'dialog-close popup-close';
      closeBtn.textContent = '×';
      closeBtn.getBoundingClientRect = () =>
        ({
          top: 10,
          left: 450,
          width: 30,
          height: 30,
          right: 480,
          bottom: 40,
          x: 450,
          y: 10,
          toJSON: () => {},
        }) as DOMRect;

      let clicked = false;
      closeBtn.onclick = () => {
        clicked = true;
        modal.style.display = 'none';
      };

      modal.appendChild(closeBtn);
      document.body.appendChild(modal);

      const dismissRes = inPageDismissOverlays({ maxDismissals: 1 });
      expect(dismissRes.dismissedCount).toBe(1);
      expect(clicked).toBe(true);
      expect(dismissRes.overlays[0].action).toBe('clicked_close_button');
      expect(dismissRes.overlays[0].dismissed).toBe(true);
      expect(dismissRes.overlays[0].needsPhysicalFallback).toBe(false);
    });

    it('verifies input commitment with generic button classes (btn-primary, btn-action, icon-search)', () => {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = 'query term';

      const searchBtn = document.createElement('button');
      searchBtn.className = 'btn-action btn-primary';
      const icon = document.createElement('span');
      icon.className = 'icon-search magnif';
      searchBtn.appendChild(icon);

      form.appendChild(input);
      form.appendChild(searchBtn);
      document.body.appendChild(form);

      // Register input in isolated index map with index 1
      getIsolatedIndexMap().set(1, wrapElement(input));

      const commitmentRes = inPageVerifyInputCommitment(1, 'query term');
      expect(commitmentRes.committed).toBe(true);
      expect(commitmentRes.submitButtonState?.found).toBe(true);
    });

    it('dismisses overlays using Element Plus headerbtn and Tailwind data-modal-hide', () => {
      // 1. Element Plus modal
      const elDialog = document.createElement('div');
      elDialog.className = 'el-overlay';
      elDialog.style.position = 'fixed';
      elDialog.style.zIndex = '2000';
      elDialog.style.display = 'block';
      elDialog.getBoundingClientRect = () =>
        ({
          top: 0,
          left: 0,
          width: 600,
          height: 400,
          right: 600,
          bottom: 400,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect;

      const headerBtn = document.createElement('button');
      headerBtn.className = 'el-dialog__headerbtn';
      headerBtn.getBoundingClientRect = () =>
        ({
          top: 10,
          left: 550,
          width: 30,
          height: 30,
          right: 580,
          bottom: 40,
          x: 550,
          y: 10,
          toJSON: () => {},
        }) as DOMRect;

      let elClicked = false;
      headerBtn.onclick = () => {
        elClicked = true;
        elDialog.style.display = 'none';
      };
      elDialog.appendChild(headerBtn);
      document.body.appendChild(elDialog);

      const dismissRes = inPageDismissOverlays({ maxDismissals: 1 });
      expect(dismissRes.dismissedCount).toBe(1);
      expect(elClicked).toBe(true);
      expect(dismissRes.overlays[0].buttonSelector).toContain('el-dialog__headerbtn');
      expect(dismissRes.overlays[0].dismissed).toBe(true);
      expect(dismissRes.overlays[0].needsPhysicalFallback).toBe(false);
    });

    it('aggregates subframe virtualization metrics into mergedData in ReadDOMTool', async () => {
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn(async (id: number) => ({ id, url: 'https://example.com' })),
        },
      };

      vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              result: {
                treeString: '[1] <button>Main</button>',
                elementCount: 1,
                interactiveCount: 1,
                compressionRatio: 0.5,
                indexMap: {},
                indexedElements: [
                  {
                    index: 1,
                    tagName: 'button',
                    attributes: {},
                    rect: { x: 0, y: 0, width: 10, height: 10 },
                    isInteractive: true,
                  },
                ],
                virtualizedCount: 5,
                virtualizedSummary: [{ selector: 'div.list > div.card', count: 5 }],
              },
            },
            {
              frameId: 1,
              result: {
                treeString: '[1] <button>Sub</button>',
                elementCount: 1,
                interactiveCount: 1,
                compressionRatio: 0.5,
                indexMap: {},
                indexedElements: [
                  {
                    index: 1,
                    tagName: 'button',
                    attributes: {},
                    rect: { x: 0, y: 0, width: 10, height: 10 },
                    isInteractive: true,
                  },
                ],
                virtualizedCount: 8,
                virtualizedSummary: [{ selector: 'div.feed > div.post', count: 8 }],
              },
            },
          ] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      const res = await readDOMTool.execute({ tabId: 100 });
      expect(res.isError).toBe(false);
      const data = JSON.parse(res.content[0].text);
      expect(data.virtualizedCount).toBe(13); // 5 from main + 8 from subframe
      expect(data.virtualizedSummary).toHaveLength(2);
      expect(data.virtualizedSummary[1].selector).toContain('iframe[1]');
    });

    it('performPhysicalFill with pressEnter captures child tab opened during Enter key dispatch', async () => {
      const createdListeners: Array<(tab: any) => void> = [];
      const activatedListeners: Array<(activeInfo: any) => void> = [];

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [{ id: 100, windowId: 1 }]),
          get: vi.fn(async (id: number) => ({
            id,
            windowId: 1,
            active: id === 777,
            url: 'https://example.com/checkout',
          })),
          onCreated: {
            addListener: vi.fn((fn) => createdListeners.push(fn)),
            removeListener: vi.fn(),
          },
          onActivated: {
            addListener: vi.fn((fn) => activatedListeners.push(fn)),
            removeListener: vi.fn(),
          },
        },
      };

      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _label, fn) =>
        fn(),
      );
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
        async (_tabId, method, params: any) => {
          // When Enter key is dispatched, simulate the child tab creation event
          if (
            method === 'Input.dispatchKeyEvent' &&
            params?.key === 'Enter' &&
            params?.type === 'keyDown'
          ) {
            const childTab = { id: 777, openerTabId: 100, windowId: 1, active: true };
            for (const fn of [...createdListeners]) fn(childTab);
            for (const fn of [...activatedListeners]) fn({ tabId: 777, windowId: 1 });
          }
          return {};
        },
      );

      vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
        if (fnName === 'inPageGetElementCoordinates') {
          return [{ result: { success: true, x: 100, y: 100, tagName: 'input' } }] as any;
        }
        if (fnName === 'inPageVerifyInputCommitment') {
          return [{ result: { success: true, committed: true } }] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      sessionTabAffinity.setAffinity('fill-enter-session', 100);

      const fillRes = await performPhysicalFill({
        tabId: 100,
        target: 1,
        text: 'search query',
        pressEnter: true,
        sessionId: 'fill-enter-session',
      });

      expect(fillRes.success).toBe(true);
      expect(fillRes.tabHandover).toBeDefined();
      expect(fillRes.tabHandover?.handover).toBe(true);
      expect(fillRes.tabHandover?.newTabId).toBe(777);
      expect(sessionTabAffinity.getAffinity('fill-enter-session')).toBe(777);
    });
  });
});
