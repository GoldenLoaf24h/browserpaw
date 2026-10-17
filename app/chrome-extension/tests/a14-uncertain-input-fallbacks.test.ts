/**
 * A-14 regression: an uncertain CDP input outcome ("timed out" or "outcome
 * unknown") must never be followed by a synthetic re-injection at the four
 * remaining upper callers. Each test drives the real tool entry point with
 * mocked CDP/in-page layers and asserts the observable second injection did
 * NOT happen, while a definite failure still keeps the original fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computerTool } from '../entrypoints/background/tools/browser/computer';
import { keyboardTool } from '../entrypoints/background/tools/browser/keyboard';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import * as fillCoreModule from '../entrypoints/background/tools/browser/fill-core';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import { smartScrollTool } from '../entrypoints/background/tools/browser/smart-scroll';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as raceCdpModule from '../utils/race-cdp';
import { CdpDispatchTimeoutError } from '../utils/race-cdp';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { sessionTabAffinity } from '../utils/session-tab-affinity';

const OUTCOME_UNKNOWN_MESSAGE =
  'CDP Input.dispatchMouseEvent outcome unknown: connection lost after dispatch (tab detached). The command may have executed; inspect page state before retrying.';

function passthroughSession() {
  return vi
    .spyOn(cdpSessionManager, 'withSession')
    .mockImplementation(async (_tabId, _caller, fn) => fn({} as any));
}

function installActiveTabChrome(tabId: number) {
  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({
        id,
        windowId: 1,
        url: 'https://example.com/page',
        active: true,
      })),
      query: vi.fn(async () => [
        { id: tabId, windowId: 1, url: 'https://example.com/page', active: true },
      ]),
      sendMessage: vi.fn(() => {
        throw new Error('no content script receiver in unit test');
      }),
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn(async () => [{ result: undefined }]) },
    runtime: { getPlatformInfo: vi.fn(async () => ({ os: 'win' })) },
    debugger: { onEvent: { addListener: vi.fn(), removeListener: vi.fn() } },
  };
}

describe('A-14 computer.type: uncertain insertText must not fall back to DOM typing', () => {
  const tabId = 9301;

  beforeEach(() => {
    installActiveTabChrome(tabId);
    passthroughSession();
  });

  it('fails closed and never calls keyboardTool when insertText times out', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new CdpDispatchTimeoutError('Input.insertText'),
    );
    const keyboardSpy = vi.spyOn(keyboardTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    } as any);

    const res = await computerTool.execute({
      action: 'type',
      text: 'hello world',
      tabId,
      autoGroup: false,
    } as any);

    expect(keyboardSpy).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/outcome unknown/i);
  });

  it('keeps the DOM keyboard fallback when insertText fails definitively', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new Error('Input.insertText rejected: debugger detached before dispatch'),
    );
    const keyboardSpy = vi.spyOn(keyboardTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true,"via":"dom_fallback"}' }],
      isError: false,
    } as any);

    const res = await computerTool.execute({
      action: 'type',
      text: 'hello',
      tabId,
      autoGroup: false,
    } as any);

    expect(keyboardSpy).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(false);
  });
});

describe('A-14 computer.key: uncertain key dispatch must not fall back to DOM keyboard', () => {
  const tabId = 9302;

  beforeEach(() => {
    installActiveTabChrome(tabId);
    passthroughSession();
  });

  it('fails closed and never calls keyboardTool when key dispatch times out', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new CdpDispatchTimeoutError('Input.dispatchKeyEvent'),
    );
    const keyboardSpy = vi.spyOn(keyboardTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    } as any);

    const res = await computerTool.execute({
      action: 'key',
      text: 'Enter',
      tabId,
      autoGroup: false,
    } as any);

    expect(keyboardSpy).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/outcome unknown/i);
  });

  it('keeps the DOM keyboard fallback when key dispatch fails definitively', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new Error('Input.dispatchKeyEvent rejected: target detached before dispatch'),
    );
    const keyboardSpy = vi.spyOn(keyboardTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true,"via":"dom_fallback"}' }],
      isError: false,
    } as any);

    const res = await computerTool.execute({
      action: 'key',
      text: 'Enter',
      tabId,
      autoGroup: false,
    } as any);

    expect(keyboardSpy).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(false);
  });
});

describe('A-14 fill-core auto-submit: uncertain click must not be retried with Enter', () => {
  const tabId = 9401;

  function mockFillPipeline(submitButtonState: Record<string, unknown>) {
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetElementCoordinates') {
          return [
            {
              result: {
                success: true,
                x: 100,
                y: 100,
                tagName: 'input',
                inputType: 'text',
                value: '',
              },
            },
          ] as any;
        }
        if (fnName === 'inPageCheckOcclusion') {
          return [{ result: { x: 100, y: 100 } }] as any;
        }
        if (fnName === 'inPageVerifyActiveElement') {
          return [{ result: { isFocused: true } }] as any;
        }
        if (fnName === 'inPageVerifyInputCommitment') {
          return [{ result: { success: true, committed: true, submitButtonState } }] as any;
        }
        return [{ result: { success: true } }] as any;
      },
    );
  }

  beforeEach(() => {
    installActiveTabChrome(tabId);
    passthroughSession();
    vi.spyOn(sessionTabAffinity, 'startHandoverTracking').mockReturnValue({
      waitForHandover: vi.fn(async () => null),
      cancel: vi.fn(),
    } as any);
    vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);
    mockFillPipeline({ found: true, index: 9 });
  });

  function enterDispatches(): any[] {
    return (raceCdpModule.raceCdp as any).mock.calls.filter(
      ([, method, params]: any[]) => method === 'Input.dispatchKeyEvent' && params?.key === 'Enter',
    );
  }

  function inPageFillCalls(): any[] {
    return (inPageEngine.executeInPage as any).mock.calls.filter(
      ([, fnName]: any[]) => fnName === 'inPageFillIndex',
    );
  }

  it('reports the uncertain click and never presses Enter', async () => {
    vi.spyOn(interactIndexTool, 'execute').mockRejectedValue(new Error(OUTCOME_UNKNOWN_MESSAGE));

    const res = await performPhysicalFill({ tabId, target: 1, text: 'hello', submit: true });

    expect(enterDispatches()).toHaveLength(0);
    expect(res.submitted).toBe(false);
    expect(res.submitMethod).toBe('click');
    expect((res.submitResult as any)?.status).toBe('unknown');
    expect((res.submitResult as any)?.message).toMatch(/not retrying/i);
  });

  it('keeps the Enter fallback when the click fails definitively', async () => {
    vi.spyOn(interactIndexTool, 'execute').mockRejectedValue(new Error('Element is not clickable'));

    const res = await performPhysicalFill({ tabId, target: 1, text: 'hello', submit: true });

    expect(enterDispatches().length).toBeGreaterThan(0);
    expect(res.submitted).toBe(true);
    expect(res.submitMethod).toBe('pressEnter');
  });

  it('fails closed and never synthesizes an in-page Enter when the Enter dispatch is uncertain', async () => {
    mockFillPipeline({ found: false });
    vi.mocked(raceCdpModule.raceCdp).mockImplementation(
      async (_tabId: number, method: string, params: any) => {
        if (method === 'Input.dispatchKeyEvent' && params?.key === 'Enter') {
          throw new Error(OUTCOME_UNKNOWN_MESSAGE);
        }
        return {} as any;
      },
    );

    const res = await performPhysicalFill({ tabId, target: 1, text: 'hello', submit: true });

    expect(inPageFillCalls()).toHaveLength(0);
    expect(res.submitted).toBe(false);
    expect(res.submitMethod).toBe('pressEnter');
    expect((res.submitResult as any)?.status).toBe('unknown');
    expect((res.submitResult as any)?.message).toMatch(/not retrying/i);
  });

  it('native fill: uncertain typing must fail closed and never fall back to inPageFillIndex (fill-core:847)', async () => {
    vi.mocked(raceCdpModule.raceCdp).mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Input.insertText') {
        throw new CdpDispatchTimeoutError('Input.insertText');
      }
      return {} as any;
    });

    await expect(performPhysicalFill({ tabId, target: 1, text: 'hello' })).rejects.toThrow(
      CdpDispatchTimeoutError,
    );

    expect(inPageFillCalls()).toHaveLength(0);
  });

  it('native fill: keeps inPageFillIndex fallback when CDP typing fails definitively', async () => {
    vi.mocked(raceCdpModule.raceCdp).mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Input.insertText') {
        throw new Error('Input.insertText rejected: element not focused');
      }
      return {} as any;
    });

    const res = await performPhysicalFill({ tabId, target: 1, text: 'hello' });

    expect(inPageFillCalls().length).toBeGreaterThan(0);
    expect(res.success).toBe(true);
  });
});

describe('A-14 fill-index: downstream uncertain outcome prohibits auto-click and reports honest status', () => {
  const tabId = 9402;

  beforeEach(() => {
    installActiveTabChrome(tabId);
    (fillIndexTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: tabId,
      url: 'https://example.com/page',
    });
    vi.spyOn(sessionTabAffinity, 'runSerialized').mockImplementation(async (_key: any, op: any) =>
      op(),
    );
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageDetectPerceptiveSignature') return [{ result: null }] as any;
        return [{ result: { success: true } }] as any;
      },
    );
  });

  it('does not auto-click submit button or claim pressEnterDispatched when submit Enter outcome is unknown', async () => {
    vi.spyOn(fillCoreModule, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      index: 1,
      ref: 1,
      selector: '#search-box',
      filledText: 'browserpaw',
      isTrusted: true,
      method: 'cdp_native',
      tagName: 'input',
      inputType: 'search',
      isSearch: true,
      submitButtonState: { found: true, index: 9, text: 'Search' },
      autoSubmitHandled: true,
      submitted: false,
      submitMethod: 'pressEnter',
      submitResult: {
        success: false,
        status: 'unknown',
        message: 'Enter submission outcome is unknown; not retrying in-page.',
      },
    } as any);

    const interactSpy = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    } as any);

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'browserpaw',
      submit: true,
      tabId,
      waitForSettle: false,
      includeDelta: false,
    });

    expect(interactSpy).not.toHaveBeenCalled();
    expect(res.isError).toBe(false);

    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.committed).toBe(true);
    expect(parsed.submitted).toBe(false);
    expect(parsed.submitResult?.status).toBe('unknown');
    expect(parsed.pressEnterDispatched).not.toBe(true);
  });

  it('does not auto-click submit button when pressEnter is requested and Enter outcome is unknown', async () => {
    vi.spyOn(fillCoreModule, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      index: 1,
      ref: 1,
      selector: '#search-box',
      filledText: 'browserpaw',
      isTrusted: true,
      method: 'cdp_native',
      tagName: 'input',
      inputType: 'search',
      isSearch: true,
      submitButtonState: { found: true, index: 9, text: 'Search' },
      autoSubmitHandled: true,
      submitted: false,
      submitMethod: 'pressEnter',
      submitResult: {
        success: false,
        status: 'unknown',
        message: 'Enter submission outcome is unknown; not retrying in-page.',
      },
    } as any);

    const interactSpy = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    } as any);

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'browserpaw',
      pressEnter: true,
      tabId,
      waitForSettle: false,
      includeDelta: false,
    });

    expect(interactSpy).not.toHaveBeenCalled();
    expect(res.isError).toBe(false);

    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.committed).toBe(true);
    expect(parsed.submitted).toBe(false);
    expect(parsed.submitResult?.status).toBe('unknown');
    expect(parsed.pressEnterDispatched).not.toBe(true);
  });
});

describe('A-14 batch-actions scroll: uncertain wheel must not be re-issued in-page', () => {
  const tabId = 9501;

  beforeEach(() => {
    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: tabId,
      url: 'https://example.com/page',
    });
    (batchActionsTool as any).safeExecuteScript = vi.fn(async () => undefined);
    installActiveTabChrome(tabId);
    passthroughSession();
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageDetectPerceptiveSignature') return [{ result: null }] as any;
        return [{ result: { success: true } }] as any;
      },
    );
  });

  it('fails the step and never calls window.scrollBy after a wheel timeout', async () => {
    vi.spyOn(raceCdpModule, 'raceCdp').mockRejectedValue(
      new CdpDispatchTimeoutError('Input.dispatchMouseEvent'),
    );
    const safeExecuteScript = (batchActionsTool as any).safeExecuteScript as ReturnType<
      typeof vi.fn
    >;

    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'scroll', direction: 'down', amount: 500, x: 100, y: 100 } as any],
    });

    expect(safeExecuteScript).not.toHaveBeenCalled();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results[0].success).toBe(false);
    expect(String(parsed.results[0].error)).toMatch(/CDP_DISPATCH_TIMEOUT/);
    expect(parsed.interruptedReason).toContain('scroll');
  });

  it('keeps the window.scrollBy fallback when the wheel fails definitively', async () => {
    vi.spyOn(raceCdpModule, 'raceCdp').mockRejectedValue(
      new Error('Input.dispatchMouseEvent rejected: not attached to target'),
    );
    const safeExecuteScript = (batchActionsTool as any).safeExecuteScript as ReturnType<
      typeof vi.fn
    >;

    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'scroll', direction: 'down', amount: 500, x: 100, y: 100 } as any],
    });

    expect(safeExecuteScript).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results[0].success).toBe(true);
    expect(parsed.results[0].output?.method).toBe('window_scroll_by');
  });

  it('key action: uncertain single-char insertText must fail closed without dispatchKeyEvent fallback (batch-actions:778)', async () => {
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(
      async (_tabId: number, method: string) => {
        if (method === 'Input.insertText') {
          throw new CdpDispatchTimeoutError('Input.insertText');
        }
        return {} as any;
      },
    );

    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'key', key: 'a' } as any],
    });

    const keyEvents = (raceCdpModule.raceCdp as any).mock.calls.filter(
      ([, method]: any[]) => method === 'Input.dispatchKeyEvent',
    );
    expect(keyEvents).toHaveLength(0);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results[0].success).toBe(false);
    expect(String(parsed.results[0].error)).toMatch(/CDP_DISPATCH_TIMEOUT/);
  });

  it('key action: keeps dispatchKeyEvent fallback when single-char insertText fails definitively', async () => {
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(
      async (_tabId: number, method: string) => {
        if (method === 'Input.insertText') {
          throw new Error('Input.insertText rejected definitively');
        }
        return {} as any;
      },
    );

    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'key', key: 'a' } as any],
    });

    const keyEvents = (raceCdpModule.raceCdp as any).mock.calls.filter(
      ([, method]: any[]) => method === 'Input.dispatchKeyEvent',
    );
    expect(keyEvents.length).toBeGreaterThan(0);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.results[0].success).toBe(true);
  });
});

describe('A-14 smart-scroll wheel: uncertain dispatch must not be re-issued in-page', () => {
  const tabId = 9601;

  beforeEach(() => {
    (smartScrollTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({ id: tabId });
    installActiveTabChrome(tabId);
    passthroughSession();
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageFindSmartScrollTarget') {
          return [
            {
              result: {
                found: true,
                isWindow: true,
                tagName: 'window',
                x: 400,
                y: 300,
                width: 800,
                height: 600,
                scrollLeft: 0,
                scrollTop: 0,
                scrollWidth: 800,
                scrollHeight: 1200,
                clientWidth: 800,
                clientHeight: 600,
                canScrollDown: true,
                canScrollUp: false,
                canScrollRight: false,
                canScrollLeft: false,
              },
            },
          ] as any;
        }
        return [{ result: { success: true } }] as any;
      },
    );
  });

  function inPageScrollCalls(): any[] {
    return (inPageEngine.executeInPage as any).mock.calls.filter(
      ([, fnName]: any[]) => fnName === 'inPagePerformSmartScroll',
    );
  }

  it('fails closed and never falls back to in-page scroll after an uncertain wheel', async () => {
    vi.spyOn(raceCdpModule, 'raceCdp').mockRejectedValue(new Error(OUTCOME_UNKNOWN_MESSAGE));

    const res = await smartScrollTool.execute({
      tabId,
      direction: 'down',
      amount: 500,
      waitForSettle: false,
    });

    expect(inPageScrollCalls()).toHaveLength(0);
    expect(res.isError).toBe(true);
  });

  it('keeps the in-page fallback when the wheel fails definitively', async () => {
    vi.spyOn(raceCdpModule, 'raceCdp').mockRejectedValue(
      new Error('Input.dispatchMouseEvent rejected: not attached to target'),
    );

    const res = await smartScrollTool.execute({
      tabId: 9602,
      direction: 'down',
      amount: 500,
      waitForSettle: false,
    });

    expect(inPageScrollCalls()).toHaveLength(1);
    expect(res.isError).toBe(false);
  });
});
