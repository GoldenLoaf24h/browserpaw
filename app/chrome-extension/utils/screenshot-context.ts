// In-memory screenshot context used for screenshot-space coordinate projection.

export interface ScreenshotContext {
  screenshotWidth: number;
  screenshotHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  originX?: number;
  originY?: number;
  cropWidth?: number;
  cropHeight?: number;
  devicePixelRatio?: number;
  hostname?: string;
  url?: string;
  documentId?: string;
  scrollX?: number;
  scrollY?: number;
  captureMode?: 'viewport' | 'fullpage' | 'element';
  docWidth?: number;
  docHeight?: number;
  timestamp: number;
}

const TTL_MS = 5 * 60 * 1000;
const contexts = new Map<number, ScreenshotContext>();

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  try {
    chrome.tabs.onRemoved.addListener((closedTabId: number) => contexts.delete(closedTabId));
  } catch {}
}

export const screenshotContextManager = {
  setContext(tabId: number, ctx: Omit<ScreenshotContext, 'timestamp'>) {
    contexts.set(tabId, { ...ctx, timestamp: Date.now() });
  },

  getContext(tabId: number): ScreenshotContext | undefined {
    const ctx = contexts.get(tabId);
    if (!ctx) return undefined;
    if (Date.now() - ctx.timestamp > TTL_MS) {
      contexts.delete(tabId);
      return undefined;
    }
    return ctx;
  },

  getTtlRemaining(tabId: number): number {
    const ctx = contexts.get(tabId);
    return ctx ? TTL_MS - (Date.now() - ctx.timestamp) : -1;
  },

  clear(tabId?: number) {
    if (typeof tabId === 'number') contexts.delete(tabId);
    else contexts.clear();
  },
};

export interface ScaledCoordinateResult {
  x: number;
  y: number;
  isDocumentSpace?: boolean;
}

export function scaleCoordinates(
  x: number,
  y: number,
  ctx: ScreenshotContext,
): ScaledCoordinateResult {
  if (!ctx.screenshotWidth || !ctx.screenshotHeight) return { x, y };
  if (ctx.captureMode === 'fullpage') {
    const docW = ctx.docWidth ?? ctx.screenshotWidth;
    const docH = ctx.docHeight ?? ctx.screenshotHeight;
    return {
      x: Math.round((x / ctx.screenshotWidth) * docW),
      y: Math.round((y / ctx.screenshotHeight) * docH),
      isDocumentSpace: true,
    };
  }
  const ox = ctx.originX || 0;
  const oy = ctx.originY || 0;
  const isCropped = Boolean(ctx.originX || ctx.originY || ctx.cropWidth || ctx.cropHeight);
  const targetW =
    ctx.cropWidth ?? (isCropped ? ctx.screenshotWidth : ctx.viewportWidth || ctx.screenshotWidth);
  const targetH =
    ctx.cropHeight ??
    (isCropped ? ctx.screenshotHeight : ctx.viewportHeight || ctx.screenshotHeight);
  return {
    x: Math.round(ox + (x / ctx.screenshotWidth) * targetW),
    y: Math.round(oy + (y / ctx.screenshotHeight) * targetH),
  };
}
