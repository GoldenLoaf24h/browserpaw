import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  raceCdp,
  CdpDispatchTimeoutError,
  isCdpDispatchTimeoutError,
  createMousePressGuard,
  dispatchMousePressRelease,
} from '../utils/race-cdp';
import { cdpSessionManager } from '../utils/cdp-session-manager';

describe('A-14: raceCdp timeout reports an uncertain dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue(null);
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
});
