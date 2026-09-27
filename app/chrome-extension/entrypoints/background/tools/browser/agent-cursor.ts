/**
 * BrowserPaw Agent Cursor Controller (Background)
 *
 * Coordinates cursor movement animation in the target tab before physical
 * CDP input dispatch. Supports synchronization (waiting for arrival signal
 * within a safe timeout) and graceful fallback when tab is background/throttled.
 */

let globalMoveSequence = 0;
interface PendingArrival {
  tabId: number;
  resolver: (value?: any) => void;
  timer: any;
}
const pendingArrivals = new Map<number, PendingArrival>();

// Listen for arrival notifications from content scripts
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'AGENT_CURSOR_ARRIVED' && typeof message.moveSequence === 'number') {
      const item = pendingArrivals.get(message.moveSequence);
      if (item) {
        clearTimeout(item.timer);
        pendingArrivals.delete(message.moveSequence);
        item.resolver();
      }
    }
  });
}

// Global physical cursor position across all tabs/windows
let lastGlobalCursorPosition: { x: number; y: number; timestamp: number } | null = null;
const lastTabCursorPositions = new Map<number, { x: number; y: number; timestamp: number }>();

export function getLastGlobalCursorPosition(): { x: number; y: number } | null {
  if (!lastGlobalCursorPosition) return null;
  if (Date.now() - lastGlobalCursorPosition.timestamp > 300_000) {
    lastGlobalCursorPosition = null;
    return null;
  }
  return { x: lastGlobalCursorPosition.x, y: lastGlobalCursorPosition.y };
}

export function cleanupPendingArrivals(tabId: number): void {
  for (const [seq, item] of pendingArrivals.entries()) {
    if (item.tabId === tabId) {
      clearTimeout(item.timer);
      pendingArrivals.delete(seq);
      item.resolver();
    }
  }
}

export function cleanupTabCursorState(tabId: number, preservePosition = false): void {
  if (!preservePosition) {
    lastTabCursorPositions.delete(tabId);
  }
  cleanupPendingArrivals(tabId);
}

// Clean up pending arrival timers and cached positions if target tab closes or navigates
if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onRemoved?.addListener?.((closedTabId: number) => {
    cleanupTabCursorState(closedTabId);
  });
  chrome.tabs.onUpdated?.addListener?.((updatedTabId: number, changeInfo) => {
    if (changeInfo.status === 'loading') {
      // Strictly forbid deleting physical cursor positions on reload/navigation!
      // In real human browsing, navigating/refreshing preserves physical cursor position.
      cleanupTabCursorState(updatedTabId, true);
    }
  });
}

export interface AnimateCursorOptions {
  waitForArrival?: boolean;
  timeoutMs?: number;
  immediate?: boolean;
  actionNote?: string;
}

export function getLastKnownCursorPosition(tabId: number): { x: number; y: number } | null {
  const pos = lastTabCursorPositions.get(tabId);
  if (!pos) return null;
  if (Date.now() - pos.timestamp > 120_000) {
    lastTabCursorPositions.delete(tabId);
    return null;
  }
  return { x: pos.x, y: pos.y };
}

export async function setAgentCursorNote(
  tabId: number,
  note: string,
  durationMs = 2500,
): Promise<void> {
  if (typeof tabId !== 'number' || tabId <= 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'AGENT_CURSOR_SET_NOTE',
      note,
      durationMs,
    });
  } catch {}
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

  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  const prevPos = lastTabCursorPositions.get(tabId) || lastGlobalCursorPosition;
  const currentPos = { x: roundedX, y: roundedY, timestamp: Date.now() };
  lastTabCursorPositions.set(tabId, currentPos);
  lastGlobalCursorPosition = currentPos;

  const seq = ++globalMoveSequence;
  const timeoutMs = options.timeoutMs ?? 350;
  const shouldWait = options.waitForArrival !== false;
  const sendImmediate = options.immediate === true;

  let isBackground = false;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.get) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      isBackground = Boolean(tab && !tab.active);
    }
  } catch {}

  const movePayload = {
    type: 'AGENT_CURSOR_MOVE',
    x: roundedX,
    y: roundedY,
    fromX: prevPos?.x,
    fromY: prevPos?.y,
    moveSequence: seq,
    immediate: sendImmediate,
    actionNote: options.actionNote,
  };

  if (!shouldWait || sendImmediate || isBackground) {
    try {
      void chrome.tabs.sendMessage(tabId, movePayload).catch(() => {});
    } catch {}
    return;
  }

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pendingArrivals.delete(seq);
      resolve();
    }, timeoutMs);

    pendingArrivals.set(seq, {
      tabId,
      resolver: resolve,
      timer,
    });

    try {
      void chrome.tabs.sendMessage(tabId, movePayload).catch(() => {
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

export async function hideAgentCursor(tabId: number, force = false): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'AGENT_CURSOR_HIDE', force });
  } catch {}
}

export async function animateAgentCursorClick(
  tabId: number,
  x?: number,
  y?: number,
  actionNote?: string,
): Promise<void> {
  if (typeof tabId !== 'number' || tabId <= 0) return;
  if (typeof x === 'number' && typeof y === 'number') {
    const currentPos = { x: Math.round(x), y: Math.round(y), timestamp: Date.now() };
    lastTabCursorPositions.set(tabId, currentPos);
    lastGlobalCursorPosition = currentPos;
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'AGENT_CURSOR_CLICK',
      x: typeof x === 'number' ? Math.round(x) : undefined,
      y: typeof y === 'number' ? Math.round(y) : undefined,
      actionNote,
    });
  } catch {}
}
