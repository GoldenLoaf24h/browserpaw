import type { PageSettleResult } from 'chrome-mcp-shared';
import type { executeInPage as ExecuteInPageFn } from '@/entrypoints/background/tools/browser/in-page-engine';
import type { cdpSessionManager as CDPSessionManagerInstance } from '@/utils/cdp-session-manager';

export interface WaitForPageSettleOptions {
  timeoutMs?: number;
  quietPeriodMs?: number;
  adaptiveMs?: number;
  hasActiveRequests?: boolean;
  action?: {
    kind?: string;
    node?: number | string;
    role?: string;
  };
}

/**
 * In-page MutationObserver watchdog that waits for DOM mutations to settle.
 * Features 2-rAF micro-wait + ARIA combobox candidate option listener + MutationObserver.
 * - Standard click/mutation settles in <=50ms (2 rAF frames + debounce).
 * - Combobox autocomplete options settle in <=200ms as soon as options appear.
 */
export function inPageWaitForDOMSettle(
  timeoutMsOrOptions: number | WaitForPageSettleOptions = 1500,
  quietPeriodMs = 150,
  adaptiveMs?: number,
  hasActiveRequests = false,
  action?: { kind?: string; node?: number | string; role?: string },
): Promise<{
  settled: boolean;
  durationMs: number;
  mutationsObserved: number;
  autocompleteSettled?: boolean;
}> {
  let timeoutMs = 1500;
  if (typeof timeoutMsOrOptions === 'object' && timeoutMsOrOptions !== null) {
    timeoutMs = timeoutMsOrOptions.timeoutMs ?? 1500;
    quietPeriodMs = timeoutMsOrOptions.quietPeriodMs ?? 150;
    adaptiveMs = timeoutMsOrOptions.adaptiveMs ?? adaptiveMs;
    hasActiveRequests = timeoutMsOrOptions.hasActiveRequests ?? false;
    action = timeoutMsOrOptions.action ?? action;
  } else if (typeof timeoutMsOrOptions === 'number') {
    timeoutMs = timeoutMsOrOptions;
  }

  return new Promise((resolve) => {
    const startTime = performance.now();
    let mutationCount = 0;
    let quietTimer: any = null;
    let timeoutTimer: any = null;
    let observer: MutationObserver | null = null;
    let isDone = false;
    let rAFId: number | null = null;

    const cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (rAFId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rAFId);
      }
      if (observer) {
        try {
          observer.disconnect();
        } catch {}
        observer = null;
      }
    };

    const done = (settled: boolean, autocompleteSettled = false) => {
      if (isDone) return;
      isDone = true;
      cleanup();
      const durationMs = Math.round(performance.now() - startTime);
      resolve({ settled, durationMs, mutationsObserved: mutationCount, autocompleteSettled });
    };

    // 1. Check for Combobox autocomplete candidate options (browser.py:46-65 pattern)
    let field: Element | null = null;
    if (action?.node !== undefined) {
      const g = globalThis as any;
      const isolatedMap = g[Symbol.for('__browser_use_isolated_index_map__')];
      const targetId =
        typeof action.node === 'string' && action.node.startsWith('e')
          ? parseInt(action.node.slice(1), 10)
          : action.node;
      const pawFast = g.__pawFast || g.__clawFast;
      field =
        pawFast?.actionElements?.get(action.node) ||
        pawFast?.actionElements?.get(targetId) ||
        pawFast?.nodes?.get(action.node) ||
        pawFast?.nodes?.get(targetId) ||
        isolatedMap?.get(targetId) ||
        isolatedMap?.get(action.node) ||
        (document.querySelector(`[data-mcp-idx="${action.node}"]`) as Element) ||
        (document.querySelector(`[data-mcp-idx="${targetId}"]`) as Element) ||
        null;
    }

    const isCombobox =
      action?.role === 'combobox' ||
      field?.getAttribute('role') === 'combobox' ||
      (field?.tagName?.toUpperCase() === 'INPUT' &&
        field?.getAttribute('aria-autocomplete') !== null) ||
      (field?.tagName?.toUpperCase() === 'INPUT' &&
        (field?.getAttribute('aria-controls') !== null ||
          field?.getAttribute('aria-owns') !== null));

    const isAutocomplete = action?.kind === 'fill' && isCombobox;

    // 2. Hybrid rAF + MutationObserver Micro-Wait
    let frames = 0;
    const maxTimeout = isAutocomplete ? Math.min(timeoutMs, 200) : timeoutMs;
    const initialQuietMs =
      !hasActiveRequests && typeof adaptiveMs === 'number' && adaptiveMs > 0
        ? adaptiveMs
        : quietPeriodMs;

    timeoutTimer = setTimeout(() => {
      done(false);
    }, maxTimeout);

    // Combobox option discovery loop
    if (isAutocomplete && typeof requestAnimationFrame === 'function') {
      const checkCandidateOptions = () => {
        if (isDone) return;
        const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
          .split(/\s+/)
          .filter(Boolean);

        const roots = ids.length
          ? (ids.map((id) => document.getElementById(id)).filter(Boolean) as Element[])
          : [document.body || document.documentElement];

        const options = roots.flatMap((root) => [
          ...root.querySelectorAll('[role="option"], [role="listbox"] > *'),
        ]);

        frames++;
        const hasVisibleOption = options.some((e) => {
          const r = e.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.top < window.innerHeight &&
            (typeof (e as any).checkVisibility !== 'function' ||
              (e as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          );
        });

        if (frames >= 2 && hasVisibleOption) {
          done(true, true);
        } else {
          rAFId = requestAnimationFrame(checkCandidateOptions);
        }
      };
      rAFId = requestAnimationFrame(checkCandidateOptions);
    } else if (typeof requestAnimationFrame === 'function') {
      // Regular action: wait for 2 rAF frames (≈32ms) to allow layout/render cycle
      const rafLoop = () => {
        if (isDone) return;
        frames++;
        if (frames >= 2) {
          if (mutationCount === 0 || !observer) {
            done(true);
            return;
          }
        }
        rAFId = requestAnimationFrame(rafLoop);
      };
      rAFId = requestAnimationFrame(rafLoop);
    }

    quietTimer = setTimeout(() => {
      if (frames >= 2 || typeof requestAnimationFrame !== 'function') {
        done(true);
      }
    }, initialQuietMs);

    try {
      observer = new MutationObserver((mutations) => {
        if (isDone) return;
        mutationCount += mutations.length;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          if (frames >= 2 || typeof requestAnimationFrame !== 'function') {
            done(true);
          }
        }, quietPeriodMs);
      });

      const root = document.documentElement || document.body;
      if (root) {
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } else {
        done(true);
      }
    } catch {
      quietTimer = setTimeout(() => done(true), initialQuietMs);
    }
  });
}

let cdpSessionManagerCache: typeof CDPSessionManagerInstance | null = null;
async function getCdpSessionManager(): Promise<typeof CDPSessionManagerInstance> {
  if (cdpSessionManagerCache) return cdpSessionManagerCache;
  const mod = await import('@/utils/cdp-session-manager');
  cdpSessionManagerCache = mod.cdpSessionManager;
  return cdpSessionManagerCache;
}

let executeInPageCache: typeof ExecuteInPageFn | null = null;
async function getExecuteInPage(): Promise<typeof ExecuteInPageFn> {
  if (executeInPageCache) return executeInPageCache;
  const mod = await import('@/entrypoints/background/tools/browser/in-page-engine');
  executeInPageCache = mod.executeInPage;
  return executeInPageCache;
}

/**
 * Execute DOM settle watchdog in target tab.
 * Monitors DOM mutations and returns once mutations pause for quietPeriodMs or timeout occurs.
 */
export async function waitForPageSettle(
  tabId: number,
  options?: WaitForPageSettleOptions,
): Promise<PageSettleResult> {
  const timeoutMs = Math.max(200, Math.min(options?.timeoutMs ?? 1500, 10000));
  const quietPeriodMs = Math.max(35, Math.min(options?.quietPeriodMs ?? 100, 2000));
  const adaptiveMs = options?.adaptiveMs !== undefined ? options.adaptiveMs : 30;

  // Retrieve 100% accurate in-flight request status via CDP session manager Network tracking
  let hasActiveNet = options?.hasActiveRequests;
  if (hasActiveNet === undefined) {
    await new Promise((r) => setTimeout(r, 40));
    try {
      const cdpSessionManager = await getCdpSessionManager();
      hasActiveNet = cdpSessionManager.hasInFlightRequests(tabId);
    } catch {
      hasActiveNet = false;
    }
  }

  // If there are active in-flight requests, wait for them to reach quiescence before DOM settle
  if (hasActiveNet) {
    await waitForNetworkQuiescence(tabId, Math.min(timeoutMs, 1000));
    try {
      const cdpSessionManager = await getCdpSessionManager();
      hasActiveNet = cdpSessionManager.hasInFlightRequests(tabId);
    } catch {
      hasActiveNet = false;
    }
  }

  try {
    const executeInPage = await getExecuteInPage();
    const results = await executeInPage<PageSettleResult>({ tabId }, 'inPageWaitForDOMSettle', [
      timeoutMs,
      quietPeriodMs,
      adaptiveMs,
      hasActiveNet,
      options?.action,
    ]);
    const settleRes = results?.[0]?.result ?? {
      settled: true,
      durationMs: 0,
      mutationsObserved: 0,
    };
    settleRes.networkSettled = !hasActiveNet;

    // Check for secondary confirmation traps (e.g. "Discard draft?", "放弃帖子？")
    try {
      const trapRes = (await executeInPage({ tabId }, 'inPageDetectConfirmationTrap', []))?.[0]
        ?.result;
      if (trapRes?.detected) {
        settleRes.confirmationTrap = trapRes;
      }
    } catch {}

    return settleRes;
  } catch {
    // If navigation happened or scripting was blocked, return gracefully
    return { settled: true, durationMs: 0, mutationsObserved: 0, networkSettled: true };
  }
}

/**
 * Wait for in-flight network requests to reach quiescence (zero active requests).
 * Incorporates an initial grace delay (allowing async event handlers to dispatch requests)
 * and a sliding quiet window. Bounded by maxWaitMs to prevent indefinite hangs.
 */
export async function waitForNetworkQuiescence(
  tabId: number,
  maxWaitMs = 2000,
  pollIntervalMs = 25,
  quietSlidingWindowMs = 120,
  initialGraceMs = 60,
): Promise<boolean> {
  try {
    const cdpSessionManager = await getCdpSessionManager();
    if (!cdpSessionManager.isAttached(tabId)) {
      return true;
    }
    await cdpSessionManager.enableNetworkDomain(tabId).catch(() => {});

    // Brief initial grace delay allowing asynchronous onClick/mutation handlers
    // to dispatch fetch/XHR network requests to Chromium
    if (initialGraceMs > 0) {
      await new Promise((r) => setTimeout(r, initialGraceMs));
    }

    // Fast path: if zero in-flight requests exist after initial grace, return immediately
    if (!cdpSessionManager.hasInFlightRequests(tabId)) {
      return true;
    }

    const deadline = Date.now() + Math.max(0, maxWaitMs - initialGraceMs);
    let consecutiveQuietStart = 0;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const hasReq = cdpSessionManager.hasInFlightRequests(tabId);
      if (hasReq) {
        consecutiveQuietStart = 0;
      } else {
        if (consecutiveQuietStart === 0) {
          consecutiveQuietStart = Date.now();
        } else if (Date.now() - consecutiveQuietStart >= quietSlidingWindowMs) {
          return true; // Successfully sustained zero active requests for quietSlidingWindowMs
        }
      }
    }
    return !cdpSessionManager.hasInFlightRequests(tabId);
  } catch {
    return true;
  }
}

/**
 * Helper to check in-flight network requests for a tab via CDP session manager.
 */
export async function hasActiveNetworkRequests(tabId: number): Promise<boolean> {
  try {
    const cdpSessionManager = await getCdpSessionManager();
    return cdpSessionManager.hasInFlightRequests(tabId);
  } catch {
    return false;
  }
}
