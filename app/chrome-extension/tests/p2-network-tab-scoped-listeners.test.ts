import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { networkCaptureStartTool } from '../entrypoints/background/tools/browser/network-capture-web-request';

/**
 * P2-2: webRequest capture must only receive events for the tabs it is capturing.
 *
 * Chrome delivers webRequest events for every tab unless a `tabId` filter is supplied, so the
 * listener set has to be registered per captured tab and torn down when that tab stops.
 */
describe('P2-2: network capture registers tab-scoped request listeners', () => {
  const WEB_REQUEST_EVENTS = [
    'onBeforeRequest',
    'onSendHeaders',
    'onHeadersReceived',
    'onCompleted',
    'onErrorOccurred',
  ] as const;

  const makeTab = (id: number): chrome.tabs.Tab => ({
    id,
    url: `https://example.com/tab-${id}`,
    active: id === 1,
    highlighted: id === 1,
    pinned: false,
    incognito: false,
    selected: id === 1,
    windowId: 10,
    index: id - 1,
    discarded: false,
    autoDiscardable: false,
    groupId: -1,
  });

  const capturedTabIds = (eventName: string): number[] =>
    (chrome.webRequest as any)[eventName].addListener.mock.calls.map(
      (call: any[]) => call[1]?.tabId,
    );

  let startTool: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    startTool = networkCaptureStartTool as any;
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async (id: number) => makeTab(id)),
        query: vi.fn(async () => [makeTab(1)]),
        create: vi.fn(async (props: any) => ({ ...makeTab(3), url: props.url })),
        onRemoved: { addListener: vi.fn() },
        onCreated: { addListener: vi.fn() },
      },
      windows: { update: vi.fn() },
      webRequest: Object.fromEntries(
        WEB_REQUEST_EVENTS.map((name) => [name, { addListener: vi.fn(), removeListener: vi.fn() }]),
      ),
    });
  });

  afterEach(async () => {
    for (const tabId of Array.from(startTool.captureData.keys() as Iterable<number>)) {
      try {
        await networkCaptureStartTool.stopCapture(tabId);
      } catch {}
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('scopes every listener to the captured tab instead of every tab in the browser', async () => {
    await networkCaptureStartTool.execute({ tabId: 2 } as any);

    for (const eventName of WEB_REQUEST_EVENTS) {
      expect((chrome.webRequest as any)[eventName].addListener).toHaveBeenCalledTimes(1);
      expect(capturedTabIds(eventName)).toEqual([2]);
    }
  });

  it('keeps the other tab capturing when one of two tabs stops', async () => {
    await networkCaptureStartTool.execute({ tabId: 1 } as any);
    await networkCaptureStartTool.execute({ tabId: 2 } as any);

    expect(capturedTabIds('onBeforeRequest')).toEqual([1, 2]);

    await networkCaptureStartTool.stopCapture(2);

    // Tab 2's listeners are gone, tab 1's are untouched: exactly one removal per event.
    for (const eventName of WEB_REQUEST_EVENTS) {
      expect((chrome.webRequest as any)[eventName].removeListener).toHaveBeenCalledTimes(1);
      const removed = (chrome.webRequest as any)[eventName].removeListener.mock.calls[0][0];
      const registered = (chrome.webRequest as any)[eventName].addListener.mock.calls;
      expect(removed).toBe(registered[1][0]);
      expect(removed).not.toBe(registered[0][0]);
    }

    expect(startTool.captureData.has(1)).toBe(true);
    expect(startTool.captureData.has(2)).toBe(false);
  });

  it('drops the listeners when the captured tab is closed', async () => {
    await networkCaptureStartTool.execute({ tabId: 2 } as any);

    startTool.handleTabRemoved(2);

    for (const eventName of WEB_REQUEST_EVENTS) {
      expect((chrome.webRequest as any)[eventName].removeListener).toHaveBeenCalledTimes(1);
    }
    expect(startTool.captureData.has(2)).toBe(false);
  });

  it('replaces the listener set when capture restarts on the same tab', async () => {
    await networkCaptureStartTool.execute({ tabId: 2 } as any);
    await networkCaptureStartTool.execute({ tabId: 2 } as any);

    // Restarting stops the previous session first, so the old set is removed and exactly one
    // set stays live and tracked.
    expect(capturedTabIds('onBeforeRequest')).toEqual([2, 2]);
    expect((chrome.webRequest as any).onBeforeRequest.removeListener).toHaveBeenCalledTimes(1);

    const registered = (chrome.webRequest as any).onBeforeRequest.addListener.mock.calls;
    const removed = (chrome.webRequest as any).onBeforeRequest.removeListener.mock.calls;
    expect(removed[0][0]).toBe(registered[0][0]);
    expect(removed[0][0]).not.toBe(registered[1][0]);
    expect(startTool.listeners.get(2).onBeforeRequest).toBe(registered[1][0]);
  });
});
