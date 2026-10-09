import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dismissOverlayTool } from '../entrypoints/background/tools/browser/dismiss-overlay';
import { computerTool } from '../entrypoints/background/tools/browser/computer';
import * as interactionModule from '../entrypoints/background/tools/browser/interaction';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { undoLastActionTool } from '../entrypoints/background/tools/browser/undo-action';
import { actionHistoryManager } from '../utils/action-history-manager';
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
    const withSessionSpy = vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) => {
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
    const withSessionSpy = vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) => {
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
    expect(raceCdpSpy).toHaveBeenCalledWith(701, 'Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mousePressed',
      x: 100,
      y: 200,
    }));
    expect(raceCdpSpy).toHaveBeenCalledWith(701, 'Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mouseReleased',
      x: 100,
      y: 200,
    }));
  });
});

describe('FUNC-01: computer.fill_form result reporting', () => {
  const mockTab = { id: 702, url: 'https://example.com', windowId: 1 };

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

  it('returns isError: true and success: false when all fields fail', async () => {
    vi.spyOn(interactionModule.fillTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: 'Element not found' }],
      isError: true,
    });

    const res = await computerTool.execute({
      action: 'fill_form',
      tabId: 702,
      elements: [
        { ref: 'input_1', value: 'Alice' },
        { ref: 'input_2', value: 'Secret' },
      ],
    } as any);

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.filled).toBe(0);
    expect(payload.total).toBe(2);
    expect(payload.results).toEqual([
      { ref: 'input_1', ok: false, error: expect.any(String) },
      { ref: 'input_2', ok: false, error: expect.any(String) },
    ]);
  });

  it('returns partial: true and reports item-by-item results when some fields succeed', async () => {
    vi.spyOn(interactionModule.fillTool, 'execute')
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'OK' }], isError: false })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Failed to focus' }], isError: true });

    const res = await computerTool.execute({
      action: 'fill_form',
      tabId: 702,
      elements: [
        { ref: 'input_1', value: 'Alice' },
        { ref: 'input_2', value: 'Secret' },
      ],
    } as any);

    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.partial).toBe(true);
    expect(payload.filled).toBe(1);
    expect(payload.total).toBe(2);
    expect(payload.results[0].ok).toBe(true);
    expect(payload.results[1].ok).toBe(false);
    expect(payload.results[1].error).toBe('Failed to focus');
  });

  it('treats inner success: false or empty result in fillTool as failure even if isError is false', async () => {
    vi.spyOn(interactionModule.fillTool, 'execute')
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Synthetic reject' }) }],
        isError: false,
      })
      .mockResolvedValueOnce({
        content: [],
        isError: false,
      });

    const res = await computerTool.execute({
      action: 'fill_form',
      tabId: 702,
      elements: [
        { ref: 'input_1', value: 'Alice' },
        { ref: 'input_2', value: 'Secret' },
      ],
    } as any);

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.filled).toBe(0);
    expect(payload.results[0].ok).toBe(false);
    expect(payload.results[0].error).toBe('Synthetic reject');
    expect(payload.results[1].ok).toBe(false);
  });
});

describe('FUNC-03: undo-action peek-before-pop and error propagation', () => {
  const mockTab = { id: 703, url: 'https://example.com', windowId: 1 };

  beforeEach(() => {
    vi.restoreAllMocks();
    actionHistoryManager.clear(703);
    (globalThis as any).chrome = {
      tabs: {
        query: vi.fn(async () => [mockTab]),
        get: vi.fn(async () => mockTab),
      },
      storage: {
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
      },
      scripting: {
        executeScript: vi.fn(),
      },
    };
  });

  it('does NOT pop action when in-page revert fails, and reports isError: true with success: false', async () => {
    actionHistoryManager.pushAction(703, {
      type: 'fill',
      index: 5,
      prevValue: 'Original Text',
      timestamp: Date.now(),
    });

    // Simulate in-page execution returning failure (element destroyed / detached)
    (globalThis as any).chrome.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { success: false, reason: 'Element no longer in DOM' } },
    ]);

    const res = await undoLastActionTool.execute({ tabId: 703 });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(false);

    // Action must NOT be popped so caller can retry or inspect
    const remaining = actionHistoryManager.peekAction(703);
    expect(remaining).toBeDefined();
    expect(remaining?.type).toBe('fill');
    expect((remaining as any)?.prevValue).toBe('Original Text');
  });

  it('pops action when in-page revert succeeds and reports isError: false with success: true', async () => {
    actionHistoryManager.pushAction(703, {
      type: 'fill',
      index: 5,
      prevValue: 'Original Text',
      timestamp: Date.now(),
    });

    (globalThis as any).chrome.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { success: true, restoredValue: 'Original Text' } },
    ]);

    const res = await undoLastActionTool.execute({ tabId: 703 });

    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(true);

    // Action must be popped now
    expect(actionHistoryManager.peekAction(703)).toBeUndefined();
  });
});

describe('FUNC-08: fill-core records history only on confirmed success', () => {
  const mockTab = { id: 704, url: 'https://example.com', windowId: 1 };

  beforeEach(() => {
    vi.restoreAllMocks();
    actionHistoryManager.clear(704);
    (globalThis as any).chrome = {
      tabs: {
        query: vi.fn(async () => [mockTab]),
        get: vi.fn(async () => mockTab),
      },
      storage: {
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: { success: false } }]),
      },
    };
  });

  it('does NOT push action to history if element coordinate resolution or fill fails', async () => {
    // inPageGetElementCoordinates succeeds and returns previous value, but focus verification fails
    vi.spyOn(inPageEngine, 'executeInPage')
      .mockResolvedValueOnce([
        { result: { success: true, x: 100, y: 100, value: 'Old Value', tagName: 'input' } },
      ] as any)
      .mockResolvedValueOnce([
        { result: { isFocused: false, error: 'Target could not be focused' } },
      ] as any);

    try {
      await performPhysicalFill({
        tabId: 704,
        target: 1,
        text: 'Hello World',
      });
    } catch {}

    // Action history must NOT contain an uncommitted/failed fill
    expect(actionHistoryManager.peekAction(704)).toBeUndefined();
  });

  it('records action to history when physical fill succeeds', async () => {
    // inPageGetElementCoordinates succeeds and returns previous value
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName: string) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [{ result: { success: true, x: 100, y: 100, value: 'Original Value', tagName: 'input' } }] as any;
      }
      if (fnName === 'inPageCheckOcclusion') {
        return [{ result: { x: 100, y: 100 } }] as any;
      }
      if (fnName === 'inPageVerifyActiveElement') {
        return [{ result: { isFocused: true } }] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [{ result: { committed: true } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    const res = await performPhysicalFill({
      tabId: 704,
      target: 1,
      text: 'New Value',
      clear: false,
    });

    expect(res.success).toBe(true);
    const recorded = actionHistoryManager.peekAction(704);
    expect(recorded).toBeDefined();
    expect((recorded as any)?.prevValue).toBe('Original Value');
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
        return [{ result: { committed: true, submitButtonState: { found: true, index: 2 } } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    const interactModule = await import('../entrypoints/background/tools/browser/interact-index');
    // simulate slow click that exceeds 4000ms (does not resolve before timeout)
    vi.spyOn(interactModule.interactIndexTool, 'execute').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }], isError: false }), 8000)),
    );

    const res = await performPhysicalFill({
      tabId: 705,
      target: 1,
      text: 'Submit test',
      submit: true,
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
        return [{ result: { committed: true, submitButtonState: { found: true, index: 2 } } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    const interactModule = await import('../entrypoints/background/tools/browser/interact-index');
    vi.spyOn(interactModule.interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Validation rejected' }) }],
      isError: false,
    });

    const res = await performPhysicalFill({
      tabId: 705,
      target: 1,
      text: 'Submit test',
      submit: true,
      clear: false,
    });

    expect(res.submitted).toBe(false);
  });
});

describe('FUNC-03: undo navigation safety and concurrent record identity', () => {
  const mockTab = { id: 706, url: 'https://example.com/step2', windowId: 1 };

  beforeEach(() => {
    vi.restoreAllMocks();
    actionHistoryManager.clear(706);
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

  it('does NOT pop navigation action and returns error when chrome.tabs.goBack is unavailable', async () => {
    actionHistoryManager.pushAction(706, {
      type: 'navigate',
      prevUrl: 'https://example.com/step1',
      timestamp: Date.now(),
    });

    (globalThis as any).chrome.tabs.goBack = undefined;

    const res = await undoLastActionTool.execute({ tabId: 706 });
    expect(res.isError).toBe(true);
    expect(actionHistoryManager.peekAction(706)).toBeDefined();
  });

  it('removes the specific peeked action and preserves newer concurrent actions', async () => {
    const action1 = {
      type: 'fill' as const,
      index: 1,
      prevValue: 'First',
      timestamp: Date.now(),
    };
    actionHistoryManager.pushAction(706, action1);

    // Peek action1
    const peeked = actionHistoryManager.peekAction(706);
    expect(peeked).toBe(action1);

    // While undo operation is in progress, another action is concurrently recorded
    const action2 = {
      type: 'fill' as const,
      index: 2,
      prevValue: 'Second',
      timestamp: Date.now() + 10,
    };
    actionHistoryManager.pushAction(706, action2);

    // Removing specific action1 must NOT pop action2!
    actionHistoryManager.removeAction(706, action1);

    // Top action must now be action2!
    expect(actionHistoryManager.peekAction(706)).toBe(action2);
  });
});
