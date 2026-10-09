import { resolveToolName } from 'chrome-mcp-shared';
/**
 * Dispatcher for in-page entrypoints registered by entrypoints/inpage-engine.ts.
 *
 * chrome.scripting.executeScript({ func }) serializes only the function body,
 * so in-page entrypoints that reference module-scope helpers crash with
 * ReferenceError in the page's isolated world. Instead, we inject the bundled
 * inpage-engine script (registers every entrypoint on globalThis.__MCP_INPAGE__)
 * and invoke the requested entrypoint by name with self-contained dispatchers.
 *
 * Chrome (verified on 150) does NOT await a Promise returned by an injected
 * async func: the InjectionResult.result silently becomes undefined. So every
 * dispatcher below is synchronous, and async entrypoints run via a
 * start -> poll -> retrieve protocol backed by a per-call box on globalThis.
 *
 * If the engine file is missing, the file injection rejects loudly instead of
 * silently returning undefined inside the page.
 */

import { isRestrictedChromeUrl, restrictedUrlErrorMessage } from '../../../../utils/restricted-url';

const INPAGE_NAMESPACE = '__MCP_INPAGE__';
const EXECUTE_TIMEOUT_MS = 4_000;
let callSequence = 0;

/**
 * Cache of tabs where inpage-engine.js has already been injected.
 * In Chrome MV3, repeated file injections of the 100KB bundle on every single sub-action
 * (coordinate resolution, occlusion probe, delivery probe) add 4-6 seconds of latency.
 */
export const injectedTabs = new Set<number>();
if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      injectedTabs.delete(tabId);
    }
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    injectedTabs.delete(tabId);
  });
}

/**
 * Detects whether an error represents page navigation, frame removal, or execution context destruction.
 */
/**
 * Detects whether an error represents Chrome's native error page (e.g. chrome-error://chromewebdata/).
 */
export function isShowingErrorPageError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('is showing error page');
}
export function isNavigationOrContextDestroyedError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('frame was removed') ||
    msg.includes('frame with id') ||
    msg.includes('context was destroyed') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('receiving end does not exist') ||
    msg.includes('could not establish connection') ||
    msg.includes('tab was closed') ||
    msg.includes('no tab with id') ||
    msg.includes('cannot access contents of the page')
  );
}

/**
 * chrome.scripting.executeScript itself can hang forever when the renderer is
 * blocked (e.g. a native dialog is open). Wrap every injection with a timeout
 * so the tool surfaces a structured error instead of deadlocking.
 */
async function raceInjection<T>(p: Promise<T>, what: string, ms = EXECUTE_TIMEOUT_MS): Promise<T> {
  let timer: any;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `executeScript timeout (${what}, ${ms}ms): renderer not acking — a native dialog may be open, call ${resolveToolName('handle_dialog')} first`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function executeInPage<R = any>(
  target: chrome.scripting.InjectionTarget,
  fnName: string,
  args: unknown[],
  timeoutMs = EXECUTE_TIMEOUT_MS,
): Promise<chrome.scripting.InjectionResult<R>[]> {
  // Reject browser internal / web store pages up front so read_dom,
  // interact_index, batch_actions, etc. return a friendly error instead of the
  // raw "Cannot access a chrome:// URL" exception.
  if (typeof target.tabId === 'number') {
    const tab = await chrome.tabs.get(target.tabId).catch(() => null);
    if (isRestrictedChromeUrl(tab?.url)) {
      throw new Error(restrictedUrlErrorMessage(tab?.url));
    }
  }

  const isAlreadyInjected =
    typeof target.tabId === 'number' && !target.allFrames && injectedTabs.has(target.tabId);
  if (!isAlreadyInjected) {
    try {
      await raceInjection(
        chrome.scripting.executeScript({ target, files: ['inpage-engine.js'] }),
        'injection',
      );
      if (typeof target.tabId === 'number') {
        injectedTabs.add(target.tabId);
      }
    } catch (err) {
      if (typeof target.tabId === 'number' && isNavigationOrContextDestroyedError(err)) {
        injectedTabs.delete(target.tabId);
      }
      if (isShowingErrorPageError(err)) {
        return [
          {
            documentId: '',
            frameId: 0,
            result: {
              error: err instanceof Error ? err.message : String(err),
              isErrorPage: true,
              success: false,
            } as unknown as R,
          },
        ];
      }
      throw err;
    }
  }

  const slot = `__MCP_CALL_${++callSequence}`;

  // 1) Evaluate entrypoint: Try Single-Turn Evaluation first.
  // If the entrypoint function is synchronous or settled immediately, return its result in Turn 1.
  // If it returns a Promise, stash it in globalThis[slot] for the poll/retrieve fallback.
  let startResults: chrome.scripting.InjectionResult<{
    engineType: string;
    fnType: string;
    singleTurn?: boolean;
    status?: 'success' | 'error' | 'unavailable';
    value?: unknown;
    error?: string;
    promiseType?: string;
  }>[];

  const cleanupSlot = (slotKey: string, tgt?: chrome.scripting.InjectionTarget) => {
    if (typeof target.tabId === 'number') {
      chrome.scripting
        .executeScript({
          target: tgt || (typeof effectiveTarget !== 'undefined' ? effectiveTarget : target),
          func: (k: string) => {
            const g = globalThis as any;
            if (g && g[k]) {
              g[k].abandoned = true;
              delete g[k];
            }
          },
          args: [slotKey],
        })
        .catch(() => {});
    }
  };

  let abandoned = false;
  const startPromise = chrome.scripting.executeScript({
    target,
    func: (ns: string, name: string, fnArgs: unknown[], slotKey: string, stashSync?: boolean) => {
      const g = globalThis as any;
      const engine = g[ns];
      const fn = engine ? engine[name] : undefined;

      if (typeof engine !== 'object' || typeof fn !== 'function') {
        return {
          engineType: typeof engine,
          fnType: typeof fn,
          singleTurn: false,
          status: 'unavailable',
        };
      }

      try {
        const raw = fn.call(engine, ...fnArgs);
        const isAsync = Boolean(raw && typeof raw.then === 'function');

        // Stash box only for async promises, or for allFrames sync when mixed frames might fall back to poll/retrieve
        if (isAsync || stashSync) {
          const box: {
            promise?: unknown;
            settled: boolean;
            listening?: boolean;
            value?: unknown;
            error?: string;
          } = {
            promise: raw,
            settled: !isAsync,
            listening: false,
            value: !isAsync
              ? raw === undefined
                ? { __mcpInpageReturn: 'undefined' }
                : raw
              : undefined,
            error: undefined,
          };
          g[slotKey] = box;
        }

        if (!isAsync) {
          return {
            engineType: 'object',
            fnType: 'function',
            singleTurn: true,
            status: 'success',
            value: raw === undefined ? { __mcpInpageReturn: 'undefined' } : raw,
          };
        }

        return {
          engineType: 'object',
          fnType: 'function',
          singleTurn: false,
          promiseType: typeof raw,
        };
      } catch (err) {
        return {
          engineType: 'object',
          fnType: 'function',
          singleTurn: true,
          status: 'error',
          error: String(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err),
        };
      }
    },
    args: [INPAGE_NAMESPACE, fnName, args, slot, Boolean(target.allFrames)],
  });

  startPromise
    .then(() => {
      if (abandoned) {
        cleanupSlot(slot, target);
      }
    })
    .catch(() => {});

  try {
    startResults = (await raceInjection(
      startPromise,
      'eval-or-start',
    )) as unknown as chrome.scripting.InjectionResult<{
      engineType: string;
      fnType: string;
      singleTurn?: boolean;
      status?: 'success' | 'error' | 'unavailable';
      value?: unknown;
      error?: string;
      promiseType?: string;
    }>[];
  } catch (err) {
    abandoned = true;
    cleanupSlot(slot, target);
    if (typeof target.tabId === 'number' && isNavigationOrContextDestroyedError(err)) {
      injectedTabs.delete(target.tabId);
    }
    if (isShowingErrorPageError(err)) {
      return [
        {
          documentId: '',
          frameId: 0,
          result: {
            error: err instanceof Error ? err.message : String(err),
            isErrorPage: true,
            success: false,
          } as unknown as R,
        },
      ];
    }
    throw err;
  }

  const validFrames = (startResults ?? [])
    .filter((r) => r?.result?.engineType === 'object' && r?.result?.fnType === 'function')
    .map((r) => r.frameId);

  if (target.allFrames) {
    if (validFrames.length === 0) {
      if (typeof target.tabId === 'number') {
        injectedTabs.delete(target.tabId);
      }
      throw new Error(`In-page engine ${fnName} unavailable in any frame`);
    }
  } else {
    for (const r of startResults ?? []) {
      const info = r?.result;
      if (!info || info.engineType !== 'object' || info.fnType !== 'function') {
        if (typeof target.tabId === 'number') {
          injectedTabs.delete(target.tabId);
        }
        throw new Error(
          `In-page engine ${fnName} unavailable: ${info ? `engine=${info.engineType} fn=${info.fnType}` : 'no injection result'}`,
        );
      }
    }
  }

  // Fast Path: Check if all valid frames resolved in Single-Turn Evaluation
  const validResults = target.allFrames
    ? (startResults ?? []).filter((r) => validFrames.includes(r.frameId))
    : (startResults ?? []);

  const allSingleTurn =
    validResults.length > 0 && validResults.every((r) => r?.result?.singleTurn === true);

  if (allSingleTurn) {
    if (target.allFrames) {
      cleanupSlot(slot, target);
    }

    for (const r of validResults) {
      if (r?.result?.status === 'error') {
        throw new Error(`In-page engine ${fnName} failed: ${r.result.error}`);
      }
      const val = r?.result?.value as any;
      if (val && typeof val === 'object' && val.__mcpInpageReturn === 'undefined') {
        throw new Error(`In-page engine ${fnName} returned undefined`);
      }
    }

    return validResults.map((r) => ({
      documentId: r.documentId,
      frameId: r.frameId,
      result: r.result?.value as R,
    }));
  }

  const effectiveTarget: chrome.scripting.InjectionTarget =
    target.allFrames && typeof target.tabId === 'number' && validFrames.length > 0
      ? { tabId: target.tabId, frameIds: validFrames }
      : target;

  let retrieved = false;
  try {
    // 2) Poll: attach settle callbacks; every dispatcher stays synchronous.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pollResults = (await raceInjection(
        chrome.scripting.executeScript({
          target: effectiveTarget,
          func: (slotKey: string) => {
            const box = (globalThis as any)[slotKey];
            if (!box) return { done: true, missing: true };
            if (box.settled) return { done: true };
            const promise = box.promise;
            if (promise && typeof promise.then === 'function') {
              if (box.listening) return { done: false };
              box.listening = true;
              promise.then(
                (value: unknown) => {
                  if (box.abandoned) return;
                  box.value = value;
                  box.settled = true;
                },
                (err: unknown) => {
                  if (box.abandoned) return;
                  box.error = String(
                    err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err,
                  );
                  box.settled = true;
                },
              );
              return { done: false };
            }
            box.value = promise;
            box.settled = true;
            return { done: true };
          },
          args: [slot],
        }),
        'poll',
      )) as unknown as chrome.scripting.InjectionResult<{ done: boolean }>[];

      if ((pollResults ?? []).every((r) => r?.result?.done)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // 3) Retrieve: collect settled values and clean the box up.
    const results = (await raceInjection(
      chrome.scripting.executeScript({
        target: effectiveTarget,
        func: (slotKey: string, timeoutMs: number) => {
          const g = globalThis as any;
          const box = g[slotKey];
          if (box) {
            box.abandoned = true;
            delete g[slotKey];
          }
          // A frame can navigate away between start and retrieve - drop it
          // silently; real engine-missing cases already fail at the start step.
          if (!box) return undefined;
          if (!box.settled)
            return { __mcpInpageError: `timeout: entrypoint did not settle in ${timeoutMs}ms` };
          if (box.error !== undefined) return { __mcpInpageError: box.error };
          return box.value === undefined ? { __mcpInpageReturn: 'undefined' } : box.value;
        },
        args: [slot, EXECUTE_TIMEOUT_MS],
      }),
      'retrieve',
    )) as unknown as chrome.scripting.InjectionResult<R>[];
    retrieved = true;

    for (const r of results ?? []) {
      const marker = r?.result as
        { __mcpInpageError?: string; __mcpInpageReturn?: string } | null | undefined;
      if (marker?.__mcpInpageError) {
        throw new Error(`In-page engine ${fnName} failed: ${marker.__mcpInpageError}`);
      }
      if (marker?.__mcpInpageReturn === 'undefined') {
        throw new Error(`In-page engine ${fnName} returned undefined`);
      }
    }
    return results;
  } catch (err) {
    if (typeof target.tabId === 'number' && isNavigationOrContextDestroyedError(err)) {
      injectedTabs.delete(target.tabId);
    }
    if (isShowingErrorPageError(err)) {
      return [
        {
          documentId: '',
          frameId: 0,
          result: {
            error: err instanceof Error ? err.message : String(err),
            isErrorPage: true,
            success: false,
          } as unknown as R,
        },
      ];
    }
    throw err;
  } finally {
    if (!retrieved) {
      cleanupSlot(slot);
    }
  }
}
