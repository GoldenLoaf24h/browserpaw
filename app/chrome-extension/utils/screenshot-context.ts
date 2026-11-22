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
const STORAGE_KEY = 'browserpaw_screenshot_contexts_v1';
const contexts = new Map<number, ScreenshotContext>();
const locallyModifiedTabs = new Set<number>();
let clearGeneration = 0;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

function getSessionStorage(): chrome.storage.SessionStorageArea | null {
  if (
    typeof chrome !== 'undefined' &&
    typeof chrome.storage?.session?.get === 'function' &&
    typeof chrome.storage?.session?.set === 'function'
  ) {
    return chrome.storage.session;
  }
  return null;
}

function persistContexts(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  const now = Date.now();
  const serialized: Record<string, ScreenshotContext> = {};
  for (const [tabId, ctx] of contexts.entries()) {
    if (now - ctx.timestamp <= TTL_MS) {
      serialized[String(tabId)] = ctx;
    } else {
      contexts.delete(tabId);
    }
  }
  void Promise.resolve(storage.set({ [STORAGE_KEY]: serialized })).catch(() => {});
}

async function hydrateFromSessionStorage(): Promise<void> {
  const storage = getSessionStorage();
  if (!storage) {
    hydrated = true;
    return;
  }
  const startGeneration = clearGeneration;
  try {
    const stored = await storage.get(STORAGE_KEY);
    if (clearGeneration !== startGeneration) return;
    const rawMap = stored?.[STORAGE_KEY];
    if (rawMap && typeof rawMap === 'object') {
      const now = Date.now();
      let prunedAny = false;
      for (const [rawTabId, rawCtx] of Object.entries(rawMap as Record<string, unknown>)) {
        const tabId = Number(rawTabId);
        if (!Number.isInteger(tabId) || locallyModifiedTabs.has(tabId)) continue;
        const ctx = rawCtx as ScreenshotContext | null;
        if (
          !ctx ||
          typeof ctx !== 'object' ||
          typeof ctx.timestamp !== 'number' ||
          now - ctx.timestamp > TTL_MS
        ) {
          prunedAny = true;
          continue;
        }
        contexts.set(tabId, ctx);
      }
      if (prunedAny) {
        persistContexts();
      }
    }
    hydrated = true;
  } catch {
    hydrated = true;
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  try {
    chrome.tabs.onRemoved.addListener((closedTabId: number) => {
      locallyModifiedTabs.add(closedTabId);
      if (contexts.delete(closedTabId)) {
        persistContexts();
      }
    });
  } catch {}
}

export const screenshotContextManager = {
  async ensureHydrated(force = false): Promise<void> {
    if (force) {
      hydrated = false;
      hydratePromise = null;
      locallyModifiedTabs.clear();
    }
    if (hydrated) return;
    if (!hydratePromise) {
      hydratePromise = hydrateFromSessionStorage().finally(() => {
        hydratePromise = null;
      });
    }
    await hydratePromise;
  },

  setContext(tabId: number, ctx: Omit<ScreenshotContext, 'timestamp'>) {
    locallyModifiedTabs.add(tabId);
    contexts.set(tabId, { ...ctx, timestamp: Date.now() });
    persistContexts();
  },

  getContext(tabId: number): ScreenshotContext | undefined {
    const ctx = contexts.get(tabId);
    if (!ctx) return undefined;
    if (Date.now() - ctx.timestamp > TTL_MS) {
      locallyModifiedTabs.add(tabId);
      contexts.delete(tabId);
      persistContexts();
      return undefined;
    }
    return ctx;
  },

  getTtlRemaining(tabId: number): number {
    const ctx = contexts.get(tabId);
    return ctx ? TTL_MS - (Date.now() - ctx.timestamp) : -1;
  },

  clear(tabId?: number) {
    if (typeof tabId === 'number') {
      locallyModifiedTabs.add(tabId);
      contexts.delete(tabId);
    } else {
      clearGeneration += 1;
      locallyModifiedTabs.clear();
      contexts.clear();
    }
    persistContexts();
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
