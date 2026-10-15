import { cdpSessionManager } from './cdp-session-manager.ts';

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt: string;
}

export class DialogOpenedError extends Error {
  dialog: DialogInfo;
  constructor(dialog: DialogInfo) {
    super(
      `A native JavaScript dialog (${dialog.type}: "${dialog.message}") opened and paused execution.`,
    );
    this.name = 'DialogOpenedError';
    this.dialog = dialog;
  }
}

/**
 * A CDP dispatch that was not acknowledged inside the race window. "Not acked"
 * is not "not delivered": the command may still land afterwards, so callers must
 * treat it as an unknown outcome and never blind-retry a state-mutating action.
 */
export class CdpDispatchTimeoutError extends Error {
  readonly uncertain = true;
  readonly method: string;
  constructor(method: string) {
    super(
      `CDP_DISPATCH_TIMEOUT:${method}: renderer not acking (modal dialog is open or tab is hidden), call chrome_handle_dialog first`,
    );
    this.name = 'CdpDispatchTimeoutError';
    this.method = method;
  }
}

/**
 * Detects the timeout shape across module boundaries (mocks, re-wrapped errors),
 * where `instanceof` alone is not reliable.
 */
export function isCdpDispatchTimeoutError(err: unknown): boolean {
  return (
    err instanceof CdpDispatchTimeoutError ||
    String((err as Error)?.message || '').startsWith('CDP_DISPATCH_TIMEOUT')
  );
}

/**
 * True when a CDP dispatch may have executed but its outcome is unknown - either
 * it was not acked inside the race window, or the connection dropped after it
 * was sent. Such a result must never be followed by a blind retry.
 */
export function isCdpOutcomeUncertainError(err: unknown): boolean {
  return (
    isCdpDispatchTimeoutError(err) ||
    String((err as Error)?.message || '').includes('outcome unknown')
  );
}

export type CdpMouseDispatch = (params: Record<string, unknown>) => Promise<unknown>;

export interface MousePressGuard {
  /** Dispatches the press; compensation is armed before dispatch because a timed-out press may still land. */
  press(params: Record<string, unknown>): Promise<void>;
  /** Dispatches the release; disarms compensation on success or when its outcome is uncertain. */
  release(params?: Record<string, unknown>): Promise<void>;
  /** Best-effort compensating release. No-op when never pressed or already released. */
  compensate(): Promise<void>;
}

/**
 * Guards a physical mouse press so the button can never stay down: a successful
 * press is released either by the normal release or by a compensating release in
 * the caller's finally block. An unacknowledged dispatch is never re-sent, so a
 * timeout can not turn into a second click.
 */
export function createMousePressGuard(
  dispatch: CdpMouseDispatch,
  releaseParams: Record<string, unknown>,
): MousePressGuard {
  let pressAttempted = false;
  let released = false;
  return {
    async press(params: Record<string, unknown>): Promise<void> {
      // Armed before dispatch: a timed-out press may still land, and a release
      // without a matching press is a no-op, so compensating is always safe.
      pressAttempted = true;
      await dispatch(params);
    },
    async release(params?: Record<string, unknown>): Promise<void> {
      try {
        await dispatch(params ?? releaseParams);
        released = true;
      } catch (err) {
        // A timed-out release may still land; re-sending it is not idempotent.
        if (isCdpOutcomeUncertainError(err)) {
          released = true;
        }
        throw err;
      }
    },
    async compensate(): Promise<void> {
      if (!pressAttempted || released) return;
      try {
        // Always state the released bitmask explicitly, even for callers whose
        // normal release omitted `buttons`.
        await dispatch({ ...releaseParams, buttons: 0 });
      } catch {
        // Best effort only: the caller's original error must survive.
      }
    },
  };
}

/**
 * Dispatches one press/release pair with guaranteed release compensation.
 * The release mirrors the press (same coordinates, button and clickCount).
 */
export async function dispatchMousePressRelease(
  dispatch: CdpMouseDispatch,
  pressParams: Record<string, unknown>,
  releaseParams?: Record<string, unknown>,
): Promise<void> {
  const guard = createMousePressGuard(
    dispatch,
    releaseParams ?? { ...pressParams, type: 'mouseReleased', buttons: 0 },
  );
  try {
    await guard.press(pressParams);
    await guard.release();
  } finally {
    await guard.compensate();
  }
}

export function createDialogInterruptResponse(err: DialogOpenedError | DialogInfo) {
  const dialog = err instanceof DialogOpenedError ? err.dialog : err;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: false,
          requiresDialogAction: true,
          dialog: {
            type: dialog.type,
            message: dialog.message,
            defaultPrompt: dialog.defaultPrompt,
          },
        }),
      },
    ],
    isError: false,
  };
}

/**
 * Race a CDP dispatch against a short timeout or instant dialog opening event,
 * so an unresponsive renderer surfaces a structured error instead of deadlocking.
 */
export async function raceCdp<T>(
  tabId: number,
  method: string,
  params: object,
  ms = 3000,
): Promise<T> {
  const pending = cdpSessionManager.getPendingDialog(tabId);
  if (pending) {
    throw new DialogOpenedError(pending);
  }

  let timer: any;
  let observer: ((eventTabId: number, method: string, params: any) => void) | null = null;

  try {
    const racePromise = new Promise<never>((_, reject) => {
      observer = (eventTabId: number, eventMethod: string, eventParams: any) => {
        if (eventTabId === tabId && eventMethod === 'Page.javascriptDialogOpening') {
          reject(
            new DialogOpenedError({
              type: String(eventParams?.type || 'alert'),
              message: String(eventParams?.message || ''),
              defaultPrompt: String(eventParams?.defaultPrompt || ''),
            }),
          );
        }
      };
      cdpSessionManager.addCdpEventObserver(observer);

      timer = setTimeout(() => {
        const currentPending = cdpSessionManager.getPendingDialog(tabId);
        if (currentPending) {
          reject(new DialogOpenedError(currentPending));
        } else {
          reject(new CdpDispatchTimeoutError(method));
        }
      }, ms);
    });

    return await Promise.race([
      cdpSessionManager.sendCommand(tabId, method, params as any),
      racePromise,
    ]);
  } finally {
    clearTimeout(timer);
    if (observer) {
      cdpSessionManager.removeCdpEventObserver(observer);
    }
  }
}

export class StalePageError extends Error {
  code: string;
  retry: boolean;
  constructor(message = 'target_occluded', code = 'target_occluded', retry = true) {
    super(message);
    this.name = 'StalePageError';
    this.code = code;
    this.retry = retry;
  }
}

export function createTargetOccludedResponse(err?: StalePageError | Error | string) {
  const msg =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : 'Target element is occluded by an overlay, out of viewport, or detached from DOM.';
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: false,
          error: 'target_occluded',
          retry: true,
          message: msg,
        }),
      },
    ],
    isError: true,
  };
}
