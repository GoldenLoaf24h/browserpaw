import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { networkCaptureStartTool, networkCaptureStopTool } from '../entrypoints/background/tools/browser/network-capture-web-request';
import { networkCaptureTool } from '../entrypoints/background/tools/browser/network-capture';

describe('G3-P1-NETWORK: Target tab resolution & Session Owner isolation', () => {
  const activeTab: chrome.tabs.Tab = {
    id: 1,
    url: 'chrome-extension://fake-id/overlays.html',
    active: true,
    highlighted: true,
    pinned: false,
    incognito: false,
    selected: true,
    windowId: 10,
    index: 0,
    discarded: false,
    autoDiscardable: false,
    groupId: -1,
  };

  const targetTab: chrome.tabs.Tab = {
    id: 2,
    url: 'https://example.com/target',
    active: false,
    highlighted: false,
    pinned: false,
    incognito: false,
    selected: false,
    windowId: 10,
    index: 1,
    discarded: false,
    autoDiscardable: false,
    groupId: -1,
  };

  const createMockChrome = () => {
    const existingChrome = (globalThis as any).chrome || {};
    return {
      ...existingChrome,
      tabs: {
        get: vi.fn(async (id: number) => {
          if (id === 1) return activeTab;
          if (id === 2) return targetTab;
          throw new Error('Tab not found');
        }),
        query: vi.fn(async (queryInfo: any) => {
          if (queryInfo.active) {
            return [activeTab];
          }
          if (queryInfo.url) {
            if (queryInfo.url === targetTab.url) return [targetTab];
            return [];
          }
          return [activeTab, targetTab];
        }),
        create: vi.fn(async (props: any) => {
          return { ...targetTab, id: 3, url: props.url };
        }),
        onRemoved: { addListener: vi.fn() },
      },
      windows: {
        update: vi.fn(),
      },
      webRequest: {
        onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
        onBeforeSendHeaders: { addListener: vi.fn(), removeListener: vi.fn() },
        onSendHeaders: { addListener: vi.fn(), removeListener: vi.fn() },
        onHeadersReceived: { addListener: vi.fn(), removeListener: vi.fn() },
        onResponseStarted: { addListener: vi.fn(), removeListener: vi.fn() },
        onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
        onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('chrome', createMockChrome());
  });

  afterEach(async () => {
    const startTool = networkCaptureStartTool as any;
    const activeTabIds = new Set<number>([
      ...Array.from((startTool.captureData?.keys() as Iterable<number>) || []),
      ...Array.from((startTool.captureTimers?.keys() as Iterable<number>) || []),
      ...Array.from((startTool.inactivityTimers?.keys() as Iterable<number>) || []),
    ]);
    for (const tid of activeTabIds) {
      try {
        await networkCaptureStartTool.stopCapture(tid);
      } catch {}
      try {
        startTool.cleanupCapture(tid);
      } catch {}
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Direct networkCaptureStartTool execution', () => {
    it('strictly resolves explicit tabId without falling back to active overlays tab', async () => {
      // Execute start directly specifying tabId: 2 while active tab is tab 1 (overlays)
      const res = await networkCaptureStartTool.execute({
        tabId: 2,
      } as any);

      expect(res.isError).toBe(false);
      // Capture data must be established on tab 2
      expect((networkCaptureStartTool as any).captureData.has(2)).toBe(true);
      // Must NOT be established on tab 1
      expect((networkCaptureStartTool as any).captureData.has(1)).toBe(false);
    });

    it('prioritizes explicit tabId when both url and tabId are provided', async () => {
      const res = await networkCaptureStartTool.execute({
        tabId: 2,
        url: 'https://another-site.com',
      } as any);

      expect(res.isError).toBe(false);
      // Must operate on explicit tab 2, not create or query another-site
      expect((networkCaptureStartTool as any).captureData.has(2)).toBe(true);
      expect(chrome.tabs.create).not.toHaveBeenCalled();
    });

    it('fails fast on invalid explicit tabId and refuses fallback to active tab', async () => {
      const res = await networkCaptureStartTool.execute({
        tabId: 99999,
      } as any);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Tab 99999 not found');
      // Must NOT fall back to active tab 1
      expect((networkCaptureStartTool as any).captureData.has(1)).toBe(false);
    });
  });

  describe('End-to-End via networkCaptureTool wrapper (TC06 C Reproduction)', () => {
    it('starts on target tab and stops cleanly by owner session without missing capture error', async () => {
      const sessionId = 'session-owner-123';

      // 1. Start webRequest capture on background tab 2 while tab 1 is active overlays
      const startRes = await networkCaptureTool.execute({
        action: 'start',
        tabId: 2,
        sessionId,
        needResponseBody: false,
      });

      expect(startRes.isError).toBe(false);
      const startPayload = JSON.parse(startRes.content[0].text);
      expect(startPayload.tabId).toBe(2);
      expect(startPayload.backend).toBe('webRequest');

      // Verify backend capture state is genuinely on tab 2
      expect((networkCaptureStartTool as any).captureData.has(2)).toBe(true);
      expect((networkCaptureStartTool as any).captureData.has(1)).toBe(false);

      // 2. Stop capture by same session owner specifying tabId: 2
      const stopRes = await networkCaptureTool.execute({
        action: 'stop',
        tabId: 2,
        sessionId,
        needResponseBody: false,
      });

      expect(stopRes.isError).toBe(false);
      const stopPayload = JSON.parse(stopRes.content[0].text);
      expect(stopPayload.tabId).toBe(2);
      expect(stopPayload.backend).toBe('webRequest');
      expect((networkCaptureStartTool as any).captureData.has(2)).toBe(false);
    });
  });
});
