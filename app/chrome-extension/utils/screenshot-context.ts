// In-memory screenshot and immutable vision frame context manager per tab
// Used to scale coordinates from screenshot space to viewport space and guard against frame drift

export interface ScreenshotContext {
  // Final screenshot dimensions (in CSS pixels after any scaling)
  screenshotWidth: number;
  screenshotHeight: number;
  // Viewport dimensions (CSS pixels)
  viewportWidth: number;
  viewportHeight: number;
  // Viewport-relative origin offset for element crops (ROI)
  originX?: number;
  originY?: number;
  // Region/crop dimensions in CSS viewport pixels before transport downscaling
  cropWidth?: number;
  cropHeight?: number;
  // Device pixel ratio at capture time (optional, for reference)
  devicePixelRatio?: number;
  // Hostname of the page when the screenshot was taken (used for domain safety checks)
  hostname?: string;
  // Full URL of the page at capture time
  url?: string;
  // Document ID of the page at capture time
  documentId?: string;
  // Scroll offsets at the exact moment of screenshot capture
  scrollX?: number;
  scrollY?: number;
  // Mode of capture to differentiate viewport vs fullpage vs element crops
  captureMode?: 'viewport' | 'fullpage' | 'element';
  // Full document dimensions when captureMode is fullpage
  docWidth?: number;
  docHeight?: number;
  // TypeSafe vision frame identifier if captured via _jevVision
  visionFrameId?: string;
  // Letterbox padding applied to reach minimum dimensions [280..1568]
  padX?: number;
  padY?: number;
  // Inner image content dimensions before padding
  contentWidth?: number;
  contentHeight?: number;
  // Scaling ratio from original source to content
  scaleRatio?: number;
  // Capture-time semantic perceptual signature
  perceptiveSignature?: any;
  // Timestamp
  timestamp: number;
}

export interface VisionFrameContext {
  id: string;
  tabId: number;
  url: string;
  documentId?: string;
  title?: string;
  createdAt: number;
  isInvalidated: boolean;
  invalidationReason?: string;
  consumed?: boolean;
  consumedAt?: number;

  // Final dimensions in Jev image space (within [280..1568])
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  padX: number;
  padY: number;
  scaleRatio: number;

  // Source page geometry
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio?: number;
  captureMode?: 'viewport' | 'fullpage' | 'element';
  originX?: number;
  originY?: number;
  cropWidth?: number;
  cropHeight?: number;

  // Capture-time semantic perceptual signature
  perceptiveSignature?: any;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const contexts = new Map<number, ScreenshotContext>();
const visionFrames = new Map<string, VisionFrameContext>();
const activeVisionFrameByTab = new Map<number, string>();

export const MAX_VISION_FRAMES = 50;

function pruneVisionFrames(): void {
  const now = Date.now();
  for (const [id, f] of visionFrames.entries()) {
    if (now - f.createdAt > TTL_MS) {
      visionFrames.delete(id);
      if (activeVisionFrameByTab.get(f.tabId) === id) {
        activeVisionFrameByTab.delete(f.tabId);
      }
    }
  }
  if (visionFrames.size > MAX_VISION_FRAMES) {
    const list = Array.from(visionFrames.values()).sort((a, b) => a.createdAt - b.createdAt);
    for (const f of list) {
      if (visionFrames.size <= MAX_VISION_FRAMES) break;
      const isActive = activeVisionFrameByTab.get(f.tabId) === f.id;
      if (!isActive || f.isInvalidated || f.consumed) {
        visionFrames.delete(f.id);
        if (isActive) activeVisionFrameByTab.delete(f.tabId);
      }
    }
    for (const f of list) {
      if (visionFrames.size <= MAX_VISION_FRAMES) break;
      visionFrames.delete(f.id);
      if (activeVisionFrameByTab.get(f.tabId) === f.id) {
        activeVisionFrameByTab.delete(f.tabId);
      }
    }
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  try {
    chrome.tabs.onRemoved.addListener((closedTabId: number) => {
      contexts.delete(closedTabId);
      activeVisionFrameByTab.delete(closedTabId);
      for (const [id, frame] of visionFrames.entries()) {
        if (frame.tabId === closedTabId) {
          visionFrames.delete(id);
        }
      }
    });
  } catch {}
}

export const screenshotContextManager = {
  // Store or update latest general screenshot context for a tab
  setContext(tabId: number, ctx: Omit<ScreenshotContext, 'timestamp'>) {
    // If a different screenshot is taken on this tab, invalidate any pending vision frame
    // to strictly enforce fail-closed execution during cloud inference races
    const activeFrameId = activeVisionFrameByTab.get(tabId);
    if (activeFrameId && activeFrameId !== ctx.visionFrameId) {
      const activeFrame = visionFrames.get(activeFrameId);
      if (activeFrame) {
        activeFrame.isInvalidated = true;
        activeFrame.invalidationReason = `Replaced by subsequent screenshot capture on tab ${tabId}`;
      }
      activeVisionFrameByTab.delete(tabId);
    }

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

  // Create an immutable vision frame for Jev and register it as active for the tab
  createVisionFrame(
    frame: Omit<VisionFrameContext, 'createdAt' | 'isInvalidated'>,
  ): Readonly<VisionFrameContext> {
    const previousFrameId = activeVisionFrameByTab.get(frame.tabId);
    if (previousFrameId) {
      const prev = visionFrames.get(previousFrameId);
      if (prev) {
        prev.isInvalidated = true;
        prev.invalidationReason = `Replaced by vision frame ${frame.id} on tab ${frame.tabId}`;
      }
    }

    const immutableFrame: VisionFrameContext = {
      ...frame,
      createdAt: Date.now(),
      isInvalidated: false,
    };

    visionFrames.set(frame.id, immutableFrame);
    activeVisionFrameByTab.set(frame.tabId, frame.id);

    // Sync into regular context for backward compatibility
    this.setContext(frame.tabId, {
      screenshotWidth: frame.width,
      screenshotHeight: frame.height,
      viewportWidth: frame.viewportWidth,
      viewportHeight: frame.viewportHeight,
      cropWidth: frame.cropWidth,
      cropHeight: frame.cropHeight,
      originX: frame.originX,
      originY: frame.originY,
      devicePixelRatio: frame.devicePixelRatio,
      hostname: frame.url ? new URL(frame.url).hostname : undefined,
      url: frame.url,
      documentId: frame.documentId,
      scrollX: frame.scrollX,
      scrollY: frame.scrollY,
      captureMode: frame.captureMode,
      visionFrameId: frame.id,
      padX: frame.padX,
      padY: frame.padY,
      contentWidth: frame.contentWidth,
      contentHeight: frame.contentHeight,
      scaleRatio: frame.scaleRatio,
      perceptiveSignature: frame.perceptiveSignature,
    });

    pruneVisionFrames();
    return immutableFrame;
  },

  // Retrieve an immutable vision frame by its exact identifier
  getVisionFrame(frameId: string): VisionFrameContext | undefined {
    const frame = visionFrames.get(frameId);
    if (!frame) return undefined;
    if (Date.now() - frame.createdAt > TTL_MS) {
      frame.isInvalidated = true;
      frame.invalidationReason = `Vision frame ${frameId} expired after 5m TTL`;
    }
    return frame;
  },

  // Get current active vision frame ID for a tab
  getActiveVisionFrameId(tabId: number): string | undefined {
    return activeVisionFrameByTab.get(tabId);
  },

  // Invalidate a vision frame explicitly
  invalidateVisionFrame(frameId: string, reason: string): void {
    const frame = visionFrames.get(frameId);
    if (frame) {
      frame.isInvalidated = true;
      frame.invalidationReason = reason;
    }
  },

  // Mark vision frame as consumed by interaction dispatch (single-use protection)
  consumeVisionFrame(frameId: string): boolean {
    pruneVisionFrames();
    const frame = visionFrames.get(frameId);
    if (!frame) return false;
    if (frame.consumed) return false;
    if (frame.isInvalidated) return false;
    if (Date.now() - frame.createdAt > TTL_MS) {
      frame.isInvalidated = true;
      frame.invalidationReason = `Vision frame ${frameId} expired after 5m TTL`;
      return false;
    }
    if (activeVisionFrameByTab.get(frame.tabId) !== frameId) {
      return false;
    }
    frame.consumed = true;
    frame.consumedAt = Date.now();
    frame.isInvalidated = true;
    frame.invalidationReason = 'Consumed by interaction execution (single-use protection)';
    activeVisionFrameByTab.delete(frame.tabId);
    return true;
  },

  // Remaining TTL in ms, or -1 when no live context exists
  getTtlRemaining(tabId: number): number {
    const ctx = contexts.get(tabId);
    if (!ctx) return -1;
    return TTL_MS - (Date.now() - ctx.timestamp);
  },

  // Remaining TTL in ms for a specific vision frame
  getVisionFrameTtlRemaining(frameId: string): number {
    const frame = visionFrames.get(frameId);
    if (!frame) return -1;
    return TTL_MS - (Date.now() - frame.createdAt);
  },

  clear(tabId?: number) {
    if (typeof tabId === 'number') {
      activeVisionFrameByTab.delete(tabId);
      for (const [id, frame] of visionFrames.entries()) {
        if (frame.tabId === tabId) {
          visionFrames.delete(id);
        }
      }
      contexts.delete(tabId);
    } else {
      activeVisionFrameByTab.clear();
      visionFrames.clear();
      contexts.clear();
    }
  },
};

export interface ScaledCoordinateResult {
  x: number;
  y: number;
  isDocumentSpace?: boolean;
}

// Scale screenshot-space coordinates (x,y) to viewport or document CSS pixels
export function scaleCoordinates(
  x: number,
  y: number,
  ctx: ScreenshotContext,
): ScaledCoordinateResult {
  if (!ctx.screenshotWidth || !ctx.screenshotHeight) {
    return { x, y };
  }
  if (ctx.captureMode === 'fullpage') {
    const docW = ctx.docWidth ?? ctx.screenshotWidth;
    const docH = ctx.docHeight ?? ctx.screenshotHeight;
    const sx = (x / ctx.screenshotWidth) * docW;
    const sy = (y / ctx.screenshotHeight) * docH;
    return { x: Math.round(sx), y: Math.round(sy), isDocumentSpace: true };
  }
  const ox = ctx.originX || 0;
  const oy = ctx.originY || 0;
  const isCropped = Boolean(ctx.originX || ctx.originY || ctx.cropWidth || ctx.cropHeight);
  const targetW =
    ctx.cropWidth ??
    (isCropped ? (ctx.cropWidth ?? ctx.screenshotWidth) : ctx.viewportWidth || ctx.screenshotWidth);
  const targetH =
    ctx.cropHeight ??
    (isCropped
      ? (ctx.cropHeight ?? ctx.screenshotHeight)
      : ctx.viewportHeight || ctx.screenshotHeight);
  const sx = ox + (x / ctx.screenshotWidth) * targetW;
  const sy = oy + (y / ctx.screenshotHeight) * targetH;
  return { x: Math.round(sx), y: Math.round(sy) };
}

// Scale vision frame image coordinates (pixels from returned image) back to viewport CSS coordinates
export function scaleVisionFrameCoordinates(
  x: number,
  y: number,
  frame: VisionFrameContext,
): ScaledCoordinateResult | { error: string } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { error: `Coordinate (${x}, ${y}) must be finite numbers` };
  }

  const padX = frame.padX || 0;
  const padY = frame.padY || 0;
  const contentW = frame.contentWidth || frame.width - 2 * padX;
  const contentH = frame.contentHeight || frame.height - 2 * padY;

  // Strict bounds check: coordinate must fall within active content, not padding
  if (x < padX || x > padX + contentW || y < padY || y > padY + contentH) {
    return {
      error: `Coordinate (${x}, ${y}) falls outside content into letterbox padding [padX=${padX}, padY=${padY}, content=${contentW}x${contentH}]`,
    };
  }

  const unpaddedX = Math.max(0, Math.min(contentW, x - padX));
  const unpaddedY = Math.max(0, Math.min(contentH, y - padY));

  if (frame.captureMode === 'element') {
    const ox = frame.originX || 0;
    const oy = frame.originY || 0;
    const cropW = frame.cropWidth ?? frame.viewportWidth;
    const cropH = frame.cropHeight ?? frame.viewportHeight;
    const sx = ox + (unpaddedX / contentW) * cropW;
    const sy = oy + (unpaddedY / contentH) * cropH;
    return { x: Math.round(sx), y: Math.round(sy) };
  }

  const sx = (unpaddedX / contentW) * frame.viewportWidth;
  const sy = (unpaddedY / contentH) * frame.viewportHeight;
  return { x: Math.round(sx), y: Math.round(sy) };
}
