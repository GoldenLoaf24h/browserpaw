import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dismissOverlayTool } from '../entrypoints/background/tools/browser/dismiss-overlay';
import { clickTool } from '../entrypoints/background/tools/browser/interaction';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as raceCdpModule from '../utils/race-cdp';

describe('BUG-17: Punch-Through regression in chrome_dismiss_overlay', () => {
  const mockTab = { id: 701, url: 'https://example.com' };

  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).chrome = {
      tabs: {
        query: vi.fn(async () => [mockTab]),
        get: vi.fn(async () => mockTab),
      },
      storage: {
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
      },
    };
  });

  it('does NOT dispatch redundant CDP physical clicks to original coordinates when in-page synthetic dismissal already succeeded', async () => {
    const raceCdpSpy = vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);
    const withSessionSpy = vi
      .spyOn(cdpSessionManager, 'withSession')
      .mockImplementation(async (_tabId, _caller, fn) => {
        return fn({} as any);
      });

    // In-page engine simulated: dismissedCount = 1, popup closed via synthetic click
    vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
      {
        result: {
          dismissedCount: 1,
          overlays: [
            {
              title: 'Marketing Promo',
              buttonText: '关闭',
              action: 'clicked_close_button',
              x: 250,
              y: 180,
            },
          ],
        },
      },
    ] as any);

    const res = await dismissOverlayTool.execute({
      tabId: 701,
      waitForSettle: false,
    });

    expect(res.isError).toBe(false);

    // Punch-through prevention: because in-page dismissal succeeded (dismissedCount > 0),
    // CDP physical click fallback must NOT be dispatched to x=250, y=180.
    expect(raceCdpSpy).not.toHaveBeenCalled();
    expect(withSessionSpy).not.toHaveBeenCalled();
  });

  it('dispatches CDP physical click fallback only when in-page synthetic dismissal did NOT succeed', async () => {
    const raceCdpSpy = vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);
    const withSessionSpy = vi
      .spyOn(cdpSessionManager, 'withSession')
      .mockImplementation(async (_tabId, _caller, fn) => {
        return fn({} as any);
      });

    // In-page engine simulated: dismissedCount = 0 (synthetic event failed to dismiss React modal),
    // but clickable overlay was identified at x=100, y=200
    vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
      {
        result: {
          dismissedCount: 0,
          overlays: [
            {
              title: 'React Stubborn Dialog',
              buttonText: 'Close',
              action: 'clicked_close_button',
              x: 100,
              y: 200,
            },
          ],
        },
      },
    ] as any);

    const res = await dismissOverlayTool.execute({
      tabId: 701,
      waitForSettle: false,
    });

    expect(res.isError).toBe(false);
    expect(withSessionSpy).toHaveBeenCalledWith(701, 'dismiss-overlay', expect.any(Function));
    expect(raceCdpSpy).toHaveBeenCalledWith(
      701,
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 100,
        y: 200,
      }),
    );
    expect(raceCdpSpy).toHaveBeenCalledWith(
      701,
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mouseReleased',
        x: 100,
        y: 200,
      }),
    );
  });
});

describe('FUNC-02: fill-core auto-submit 4s timeout reports unknown delivery', () => {
  const mockTab = { id: 705, url: 'https://example.com', windowId: 1 };

  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).chrome = {
      tabs: {
        query: vi.fn(async () => [mockTab]),
        get: vi.fn(async () => mockTab),
      },
      storage: {
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: { success: true } }]),
      },
    };
  });

  it('reports submitStatus: unknown and submitted != true when 4000ms timeout races clickPromise', async () => {
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName: string) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [{ result: { success: true, x: 50, y: 50, value: '', tagName: 'input' } }] as any;
      }
      if (fnName === 'inPageCheckOcclusion') {
        return [{ result: { x: 50, y: 50 } }] as any;
      }
      if (fnName === 'inPageVerifyActiveElement') {
        return [{ result: { isFocused: true } }] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [
          { result: { committed: true, submitButtonState: { found: true, index: 2 } } },
        ] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    vi.spyOn(clickTool, 'execute').mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ content: [{ type: 'text', text: 'late' }], isError: false }),
            8000,
          ),
        ),
    );
    const deadlineAt = Date.now() + 50;

    const res = await performPhysicalFill({
      tabId: 705,
      target: 1,
      text: 'Submit test',
      submit: true,
      submitTarget: { index: 2 },
      deadlineAt,
      clear: false,
    });

    // Must NOT report submitted: true or success: true for timed-out delivery
    expect(res.submitted).not.toBe(true);
    expect(res.submitResult?.status).toBe('unknown');
    expect(res.submitResult?.timedOut).toBe(true);
  }, 10000);

  it('treats inner success: false as submitted: false even if isError is false', async () => {
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName: string) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [{ result: { success: true, x: 50, y: 50, value: '', tagName: 'input' } }] as any;
      }
      if (fnName === 'inPageCheckOcclusion') {
        return [{ result: { x: 50, y: 50 } }] as any;
      }
      if (fnName === 'inPageVerifyActiveElement') {
        return [{ result: { isFocused: true } }] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [
          { result: { committed: true, submitButtonState: { found: true, index: 2 } } },
        ] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    vi.spyOn(clickTool, 'execute').mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify({ success: false, error: 'Validation rejected' }) },
      ],
      isError: false,
    });

    const res = await performPhysicalFill({
      tabId: 705,
      target: 1,
      text: 'Submit test',
      submit: true,
      submitTarget: { index: 2 },
      clear: false,
    });

    expect(res.submitted).toBe(false);
  });
});
