/**
 * BrowserPaw Agent Cursor Controller (Background)
 *
 * Coordinates cursor movement animation in the target tab before physical
 * CDP input dispatch. Supports synchronization (waiting for arrival signal
 * within a safe timeout) and graceful fallback when tab is background/throttled.
 */

let globalMoveSequence = 0;
const pendingArrivals = new Map<number, (value?: any) => void>();

// Listen for arrival notifications from content scripts
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'AGENT_CURSOR_ARRIVED' && typeof message.moveSequence === 'number') {
      const resolver = pendingArrivals.get(message.moveSequence);
      if (resolver) {
        pendingArrivals.delete(message.moveSequence);
        resolver();
      }
    }
  });
}

export interface AnimateCursorOptions {
  waitForArrival?: boolean;
  timeoutMs?: number;
  immediate?: boolean;
}

export async function animateAgentCursor(
  tabId: number,
  x: number,
  y: number,
  options: AnimateCursorOptions = {},
): Promise<void> {
  if (typeof tabId !== 'number' || typeof x !== 'number' || typeof y !== 'number') {
    return;
  }

  const seq = ++globalMoveSequence;
  const timeoutMs = options.timeoutMs ?? 180;
  const shouldWait = options.waitForArrival !== false;
  const sendImmediate = options.immediate === true;

  let isBackground = false;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.get) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      isBackground = Boolean(tab && !tab.active);
    }
  } catch {}

  if (!shouldWait || sendImmediate || isBackground) {
    try {
      void chrome.tabs
        .sendMessage(tabId, {
          type: 'AGENT_CURSOR_MOVE',
          x: Math.round(x),
          y: Math.round(y),
          moveSequence: seq,
          immediate: sendImmediate,
        })
        .catch(() => {});
    } catch {}
    return;
  }

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pendingArrivals.delete(seq);
      resolve();
    }, timeoutMs);

    pendingArrivals.set(seq, () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      void chrome.tabs
        .sendMessage(tabId, {
          type: 'AGENT_CURSOR_MOVE',
          x: Math.round(x),
          y: Math.round(y),
          moveSequence: seq,
          immediate: false,
        })
        .catch(() => {
          clearTimeout(timer);
          pendingArrivals.delete(seq);
          resolve();
        });
    } catch {
      clearTimeout(timer);
      pendingArrivals.delete(seq);
      resolve();
    }
  });
}

export async function hideAgentCursor(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'AGENT_CURSOR_HIDE' });
  } catch {}
}

export async function animateAgentCursorClick(
  tabId: number,
  x?: number,
  y?: number,
): Promise<void> {
  if (typeof tabId !== 'number' || tabId <= 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'AGENT_CURSOR_CLICK',
      x: typeof x === 'number' ? Math.round(x) : undefined,
      y: typeof y === 'number' ? Math.round(y) : undefined,
    });
  } catch {}
}
