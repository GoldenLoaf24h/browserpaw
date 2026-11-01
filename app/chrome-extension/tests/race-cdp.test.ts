import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  raceCdp,
  createDialogInterruptResponse,
  DialogOpenedError,
  CdpDispatchTimeoutError,
  isCdpDispatchTimeoutError,
  isCdpOutcomeUncertainError,
  createMousePressGuard,
  dispatchMousePressRelease,
} from '../utils/race-cdp';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { keyboardTool } from '../entrypoints/background/tools/browser/keyboard';

describe('A-14: raceCdp timeout reports an uncertain dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue(null);
  });

  function dialogResponse(err: Error) {
    return JSON.parse((createDialogInterruptResponse(err as any).content[0] as any).text);
  }

  it('marks an already-pending dialog as blocked before dispatch', async () => {
    const dialog = {
      dialogId: 'dialog-1-1',
      type: 'confirm',
      message: 'Already open',
      defaultPrompt: '',
      sessionId: 'frame-1',
    };
    vi.mocked(cdpSessionManager.getPendingDialog).mockReturnValue(dialog);
    const send = vi.spyOn(cdpSessionManager, 'sendCommand');

    const err = await raceCdp(1, 'Input.dispatchKeyEvent', {}, 10).catch((e) => e);
    const payload = dialogResponse(err);

    expect(send).not.toHaveBeenCalled();
    expect(err.dispatchStage).toBe('before');
    expect(isCdpOutcomeUncertainError(err)).toBe(false);
    expect(payload).toMatchObject({
      success: false,
      status: 'blocked',
      retry: true,
      requiresDialogAction: true,
      dialog,
    });
  });

  it('marks a dialog observed after dispatch as unknown without replaying', async () => {
    const dialog = {
      dialogId: 'dialog-1-2',
      type: 'alert',
      message: 'Opened by the action',
      defaultPrompt: '',
      sessionId: 'frame-2',
    };
    let observer: ((...args: any[]) => void) | undefined;
    vi.spyOn(cdpSessionManager, 'addCdpEventObserver').mockImplementation((fn) => {
      observer = fn;
    });
    vi.spyOn(cdpSessionManager, 'removeCdpEventObserver').mockImplementation(() => {});
    vi.mocked(cdpSessionManager.getPendingDialog).mockReturnValueOnce(null).mockReturnValue(dialog);
    const send = vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(() => {
      observer?.(1, 'Page.javascriptDialogOpening', dialog, { tabId: 1, sessionId: 'frame-2' });
      return new Promise(() => {}) as any;
    });

    const err = await raceCdp(1, 'Input.dispatchMouseEvent', {}, 50).catch((e) => e);
    const payload = dialogResponse(err);

    expect(send).toHaveBeenCalledTimes(1);
    expect(err.dispatchStage).toBe('after');
    expect(isCdpOutcomeUncertainError(err)).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      status: 'unknown',
      retry: false,
      requiresDialogAction: true,
      dialog,
    });
  });

  it('marks a dispatch timeout with a pending dialog as unknown and never retries', async () => {
    const dialog = {
      dialogId: 'dialog-1-3',
      type: 'alert',
      message: 'Timed out with dialog',
      defaultPrompt: '',
      sessionId: 'root',
    };
    vi.mocked(cdpSessionManager.getPendingDialog).mockReturnValueOnce(null).mockReturnValue(dialog);
    const send = vi
      .spyOn(cdpSessionManager, 'sendCommand')
      .mockImplementation(() => new Promise(() => {}) as any);

    const err = await raceCdp(1, 'Input.dispatchMouseEvent', {}, 10).catch((e) => e);
    const payload = dialogResponse(err);

    expect(send).toHaveBeenCalledTimes(1);
    expect(err.dispatchStage).toBe('after');
    expect(isCdpOutcomeUncertainError(err)).toBe(true);
    expect(payload.status).toBe('unknown');
    expect(payload.retry).toBe(false);
  });

  it('preserves an uncertain disconnect error and does not dispatch again', async () => {
    const original = new Error(
      'CDP Input.dispatchMouseEvent outcome unknown: connection lost after dispatch',
    );
    const send = vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(original);

    const err = await raceCdp(1, 'Input.dispatchMouseEvent', {}, 10).catch((e) => e);

    expect(err).toBe(original);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects with CdpDispatchTimeoutError flagged uncertain', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      () => new Promise(() => {}) as any,
    );

    const err = await raceCdp(1, 'Input.dispatchMouseEvent', {}, 10).catch((e) => e);

    expect(err).toBeInstanceOf(CdpDispatchTimeoutError);
    expect(err.uncertain).toBe(true);
    expect(err.method).toBe('Input.dispatchMouseEvent');
    // Existing string-based callers must keep working.
    expect(err.message.startsWith('CDP_DISPATCH_TIMEOUT')).toBe(true);
    expect(isCdpDispatchTimeoutError(err)).toBe(true);
  });

  it('does not re-dispatch after a timeout when the first dispatch lands late', async () => {
    let sendCount = 0;
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation((() => {
      sendCount++;
      // Resolves only after the race window has already elapsed.
      return new Promise((resolve) => setTimeout(() => resolve({}), 40));
    }) as any);

    await raceCdp(1, 'Input.dispatchMouseEvent', {}, 10).catch(() => {});
    // Let the late-arriving dispatch settle.
    await new Promise((r) => setTimeout(r, 60));

    expect(sendCount).toBe(1);
  });
});

describe('A-02: mouse press compensation never leaves the button down', () => {
  it('dispatches exactly one compensating release with buttons: 0 when the normal release fails', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const original = new Error('renderer gone');
    const dispatch = vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      if (params.type === 'mouseReleased') throw original;
    });

    const err = await dispatchMousePressRelease(
      dispatch,
      { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1 },
    ).catch((e) => e);

    // The original error must survive, not the compensation failure.
    expect(err).toBe(original);
    const presses = calls.filter((c) => c.type === 'mousePressed');
    const releases = calls.filter((c) => c.type === 'mouseReleased');
    // No duplicate click: one press, one release attempt, one compensation.
    expect(presses).toHaveLength(1);
    expect(releases).toHaveLength(2);
    expect(releases[1]).toMatchObject({ type: 'mouseReleased', buttons: 0, x: 10, y: 20 });
  });

  it('does not compensate when the normal release succeeded', async () => {
    const dispatch = vi.fn(async () => {});

    await dispatchMousePressRelease(dispatch, {
      type: 'mousePressed',
      x: 1,
      y: 2,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((c) => (c[0] as any).type)).toEqual([
      'mousePressed',
      'mouseReleased',
    ]);
  });

  it('compensates an uncertain press but never re-sends the press', async () => {
    const dispatch = vi.fn(async () => {
      throw new CdpDispatchTimeoutError('Input.dispatchMouseEvent');
    });
    const guard = createMousePressGuard(dispatch, { type: 'mouseReleased', buttons: 0 });

    await guard.press({ type: 'mousePressed', buttons: 1 }).catch(() => {});
    await guard.compensate();

    // Uncertain press still gets a compensating release (it may have landed),
    // but never a second press.
    expect(dispatch.mock.calls.filter((c) => (c[0] as any).type === 'mousePressed')).toHaveLength(
      1,
    );
    expect(dispatch.mock.calls.filter((c) => (c[0] as any).type === 'mouseReleased')).toHaveLength(
      1,
    );
  });

  it('compensates a press timeout through the shared press/release entry point', async () => {
    const original = new CdpDispatchTimeoutError('Input.dispatchMouseEvent');
    const dispatch = vi.fn(async (params: Record<string, unknown>) => {
      if (params.type === 'mousePressed') throw original;
    });

    const err = await dispatchMousePressRelease(dispatch, {
      type: 'mousePressed',
      x: 10,
      y: 20,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    }).catch((e) => e);

    expect(err).toBe(original);
    expect(dispatch.mock.calls.map(([params]) => params.type)).toEqual([
      'mousePressed',
      'mouseReleased',
    ]);
    expect(dispatch.mock.calls[1][0]).toMatchObject({ buttons: 0, x: 10, y: 20 });
  });

  it('does not re-send a release that timed out (non-idempotent retry ban)', async () => {
    const dispatch = vi.fn(async (params: Record<string, unknown>) => {
      if (params.type === 'mouseReleased') {
        throw new CdpDispatchTimeoutError('Input.dispatchMouseEvent');
      }
    });

    await dispatchMousePressRelease(
      dispatch,
      { type: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 1, y: 1, button: 'left', buttons: 0, clickCount: 1 },
    ).catch(() => {});

    expect(dispatch.mock.calls.filter((c) => (c[0] as any).type === 'mouseReleased')).toHaveLength(
      1,
    );
  });

  it('does not re-send a release whose delivery outcome is unknown', async () => {
    const dispatch = vi.fn(async (params: Record<string, unknown>) => {
      if (params.type === 'mouseReleased') {
        throw new Error(
          'CDP Input.dispatchMouseEvent outcome unknown: connection lost after dispatch (cdp-test). The command may have executed; inspect page state before retrying.',
        );
      }
    });

    await dispatchMousePressRelease(
      dispatch,
      { type: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 1, y: 1, button: 'left', buttons: 0, clickCount: 1 },
    ).catch(() => {});

    expect(dispatch.mock.calls.map((c) => (c[0] as any).type)).toEqual([
      'mousePressed',
      'mouseReleased',
    ]);
  });

  it('does not compensate a release that hit an after-dialog', async () => {
    const original = new DialogOpenedError(
      { type: 'alert', message: 'Opened after release', defaultPrompt: '' },
      'after',
    );
    const dispatch = vi.fn(async (params: Record<string, unknown>) => {
      if (params.type === 'mouseReleased') throw original;
    });

    const err = await dispatchMousePressRelease(dispatch, {
      type: 'mousePressed',
      x: 1,
      y: 1,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    }).catch((e) => e);

    expect(err).toBe(original);
    expect(dispatch.mock.calls.map((c) => (c[0] as any).type)).toEqual([
      'mousePressed',
      'mouseReleased',
    ]);
  });

  it('keeps guard release disarmed after an after-dialog', async () => {
    const original = new DialogOpenedError(
      { type: 'alert', message: 'Opened after release', defaultPrompt: '' },
      'after',
    );
    const dispatch = vi.fn(async (params: Record<string, unknown>) => {
      if (params.type === 'mouseReleased') throw original;
    });
    const guard = createMousePressGuard(dispatch, { type: 'mouseReleased', buttons: 0 });

    await guard.press({ type: 'mousePressed', buttons: 1 });
    await guard.release().catch(() => {});
    await guard.compensate();

    expect(dispatch.mock.calls.filter((c) => (c[0] as any).type === 'mouseReleased')).toHaveLength(
      1,
    );
  });

  it('keeps before-dialog release eligible for compensation', async () => {
    const original = new DialogOpenedError(
      { type: 'alert', message: 'Already open', defaultPrompt: '' },
      'before',
    );
    const dispatch = vi.fn(async (params: Record<string, unknown>) => {
      if (params.type === 'mouseReleased') throw original;
    });

    const err = await dispatchMousePressRelease(dispatch, {
      type: 'mousePressed',
      x: 1,
      y: 1,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    }).catch((e) => e);

    expect(err).toBe(original);
    expect(isCdpOutcomeUncertainError(original)).toBe(false);
    expect(dispatch.mock.calls.filter((c) => (c[0] as any).type === 'mouseReleased')).toHaveLength(
      2,
    );
  });
});

describe('dialog dispatch uncertainty classification', () => {
  it('recognizes dialog errors only by explicit name and after/unknown stage', () => {
    expect(
      isCdpOutcomeUncertainError({
        name: 'DialogOpenedError',
        dispatchStage: 'after',
      }),
    ).toBe(true);
    expect(
      isCdpOutcomeUncertainError({
        name: 'DialogOpenedError',
        dispatchStage: 'unknown',
      }),
    ).toBe(true);
  });

  it('does not infer uncertainty from before-stage or dialog-like messages', () => {
    expect(
      isCdpOutcomeUncertainError({
        name: 'DialogOpenedError',
        dispatchStage: 'before',
      }),
    ).toBe(false);
    expect(
      isCdpOutcomeUncertainError(
        new Error('A native JavaScript dialog opened and paused execution.'),
      ),
    ).toBe(false);
    expect(
      isCdpOutcomeUncertainError({
        name: 'Error',
        dispatchStage: 'after',
      }),
    ).toBe(false);
  });
});

describe('dialog interrupt production caller', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn(async () => ({ id: 10, url: 'https://example.com' })) },
      scripting: { executeScript: vi.fn(async () => []) },
    });
    vi.spyOn(keyboardTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 10,
      url: 'https://example.com',
    });
    vi.spyOn(keyboardTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(keyboardTool as any, 'sendMessageToTab').mockResolvedValue({ success: true });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, fn) =>
      fn({} as any),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the handleDialog-compatible response shape and receipt', async () => {
    const dialog = {
      dialogId: 'dialog-10-1',
      type: 'confirm',
      message: 'Continue?',
      defaultPrompt: '',
      sessionId: 'frame-10',
    };
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(new DialogOpenedError(dialog));
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue(dialog);

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Ctrl+A' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(false);
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('unknown');
    expect(payload.retry).toBe(false);
    expect(payload.requiresDialogAction).toBe(true);
    expect(payload.dialog).toMatchObject(dialog);
    expect(payload.receipt?.dialog).toMatchObject({
      dialogId: 'dialog-10-1',
      message: 'Continue?',
      sessionId: 'frame-10',
    });
  });
});
