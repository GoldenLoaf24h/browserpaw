import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dismissOverlayTool } from '../entrypoints/background/tools/browser/dismiss-overlay';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as raceCdpModule from '../utils/race-cdp';

function mockTab(id: number) {
  return { id, url: 'https://example.com', windowId: 1 };
}

function installChrome(tab: ReturnType<typeof mockTab>) {
  (globalThis as any).chrome = {
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async () => tab),
    },
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
    },
  };
}

function withSessionPassthrough() {
  return vi
    .spyOn(cdpSessionManager, 'withSession')
    .mockImplementation(async (_tabId, _caller, fn) => fn({} as any));
}

describe('A-08: dismissedCount only reflects real CDP click success', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installChrome(mockTab(801));
  });

  it('does not count a rejected CDP click and reports success: false with the recorded error', async () => {
    vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
      {
        result: {
          dismissedCount: 0,
          overlays: [
            {
              title: 'Stubborn Modal',
              buttonText: 'Close',
              action: 'clicked_close_button',
              x: 120,
              y: 240,
            },
          ],
        },
      },
    ] as any);
    withSessionPassthrough();
    const raceCdpSpy = vi
      .spyOn(raceCdpModule, 'raceCdp')
      .mockRejectedValue(new Error('renderer did not acknowledge'));

    const res = await dismissOverlayTool.execute({ tabId: 801, waitForSettle: false });

    expect(raceCdpSpy).toHaveBeenCalled();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.dismissedCount).toBe(0);
    expect(parsed.success).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toContain('renderer did not acknowledge');
  });

  it('counts a click only after the CDP click resolves', async () => {
    vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
      {
        result: {
          dismissedCount: 0,
          overlays: [
            {
              title: 'React Modal',
              buttonText: 'Close',
              action: 'clicked_close_button',
              x: 10,
              y: 20,
            },
          ],
        },
      },
    ] as any);
    withSessionPassthrough();
    const raceCdpSpy = vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);

    const res = await dismissOverlayTool.execute({ tabId: 801, waitForSettle: false });

    expect(raceCdpSpy).toHaveBeenCalled();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.dismissedCount).toBe(1);
    expect(parsed.success).toBe(true);
    expect(parsed.overlays[0].dismissed).toBe(true);
  });

  it('keeps the pre-click dismissedCount and reports the error when the press dispatch fails', async () => {
    vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
      {
        result: {
          dismissedCount: 1,
          overlays: [
            {
              title: 'Layer 2',
              buttonText: 'Close',
              action: 'clicked_close_button',
              needsPhysicalFallback: true,
              x: 33,
              y: 44,
            },
          ],
        },
      },
    ] as any);
    withSessionPassthrough();
    vi.spyOn(raceCdpModule, 'raceCdp').mockRejectedValue(new Error('dispatch timeout'));

    const res = await dismissOverlayTool.execute({ tabId: 801, waitForSettle: false });

    const parsed = JSON.parse((res.content[0] as any).text);
    // The in-page dismissal already succeeded, so its count survives...
    expect(parsed.dismissedCount).toBe(1);
    // ...but the failed physical fallback must be visible instead of silently swallowed.
    expect(parsed.success).toBe(false);
    expect(parsed.errors[0]).toContain('dispatch timeout');
  });
});
