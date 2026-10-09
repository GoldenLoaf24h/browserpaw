import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screenshotTool } from '../entrypoints/background/tools/browser/screenshot';
import { screenshotContextManager, scaleCoordinates } from '@/utils/screenshot-context';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { inPageGetAssetImage } from '../entrypoints/background/tools/browser/dom-indexer';
import * as imageUtils from '@/utils/image-utils';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

describe('G3 Screenshot Context & Bounds Regression Suite', () => {
  const tabId = 404;
  const VALID_PNG_1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const VALID_PNG_2 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9QzwAEjAwMDAwAFAkCAc0pPzYAAAAASUVORK5CYII=';
  const VALID_WEBP =
    'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=';
  const VALID_URL_SEQ = [VALID_PNG_1, VALID_PNG_2, VALID_WEBP];
  let urlSeqIdx = 0;

  let lastCanvasWidth = 1000;
  let lastCanvasHeight = 1000;
  const drawImage = vi.fn();

  class MockOffscreenCanvas {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return {
        drawImage,
        fillRect: vi.fn(),
        fillStyle: '',
        getImageData: vi.fn(() => ({ data: new Uint8Array(4) })),
      };
    }
    async convertToBlob(options?: any) {
      lastCanvasWidth = this.width;
      lastCanvasHeight = this.height;
      return new Blob(['fake-img'], { type: options?.type || 'image/png' });
    }
  }

  class MockFileReader {
    result: string | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    readAsDataURL(_blob: any) {
      this.result = VALID_URL_SEQ[(urlSeqIdx++) % VALID_URL_SEQ.length];
      if (this.onloadend) {
        Promise.resolve().then(() => this.onloadend!());
      }
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    screenshotContextManager.clear(tabId);
    urlSeqIdx = 0;
    lastCanvasWidth = 1000;
    lastCanvasHeight = 1000;
    drawImage.mockClear();

    // Isolated global stubs via vi.stubGlobal to prevent suite pollution
    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
    vi.stubGlobal('FileReader', MockFileReader);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (_source: any) => ({
        width: lastCanvasWidth,
        height: lastCanvasHeight,
        close: vi.fn(),
      })),
    );

    // Chrome tabs API mock
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: tabId, windowId: 1, width: 800, height: 600 }),
        captureVisibleTab: vi.fn().mockResolvedValue(VALID_PNG_1),
        sendMessage: vi.fn().mockResolvedValue({ success: true }),
      },
    });

    vi.spyOn(screenshotTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: tabId,
      windowId: 1,
      width: 800,
      height: 600,
    });
    vi.spyOn(screenshotTool as any, 'tryGetTab').mockResolvedValue({
      id: tabId,
      windowId: 1,
      width: 800,
      height: 600,
    });
    vi.spyOn(screenshotTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(screenshotTool as any, 'sendMessageToTab').mockResolvedValue({ success: true });
    vi.spyOn(screenshotTool as any, 'captureTabPngWithRetry').mockResolvedValue(VALID_PNG_1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    screenshotContextManager.clear(tabId);
  });

  describe('1. P1 Fullpage Truncation Context Fidelity', () => {
    it('directly tests _captureFullPage production method returning originalCaptureWidth/Height under maxHeight truncation', async () => {
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(async (_id: number, msg: any) => {
        if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_WARMUP_PAGE) return { success: true };
        if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_SLICE) return { success: true };
        return { success: true };
      });
      vi.spyOn(imageUtils, 'stitchImages').mockResolvedValue(new MockOffscreenCanvas(1000, 10000) as any);

      const pageDetails = {
        totalWidth: 1000,
        totalHeight: 20000,
        viewportWidth: 1000,
        viewportHeight: 1000,
        devicePixelRatio: 1,
        currentScrollX: 0,
        currentScrollY: 0,
      };

      // Call the REAL _captureFullPage production method
      const fullCapture = await screenshotTool._captureFullPage(
        tabId,
        { fullPage: true, maxHeight: 10000, width: 500 },
        pageDetails,
      );

      // Verify the returned original capture dimensions match the truncated 10000 CSS height, not totalHeight 20000
      expect(fullCapture.originalCaptureHeight).toBe(10000);
      expect(fullCapture.originalCaptureWidth).toBe(1000);
      expect(fullCapture.widthCss).toBe(500);
      expect(fullCapture.heightCss).toBe(5000);
      expect(imageUtils.stitchImages).toHaveBeenCalledWith(expect.any(Array), 1000, 10000);
    });

    it('stitches only the actual height when MAX_CAPTURE_PARTS stops capture after 50 slices', async () => {
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockResolvedValue({ success: true });
      lastCanvasWidth = 1000;
      lastCanvasHeight = 200;
      const stitch = vi.spyOn(imageUtils, 'stitchImages');

      const fullCapture = await screenshotTool._captureFullPage(
        tabId,
        { fullPage: true, maxHeight: 20000 },
        {
          totalWidth: 1000,
          totalHeight: 20000,
          viewportWidth: 1000,
          viewportHeight: 200,
          devicePixelRatio: 1,
          currentScrollX: 0,
          currentScrollY: 0,
        },
      );

      expect(stitch).toHaveBeenCalledTimes(1);
      expect(stitch).toHaveBeenCalledWith(expect.any(Array), 1000, 10000);
      expect(stitch.mock.calls[0][0]).toHaveLength(50);
      expect(stitch.mock.calls[0][0][49].y).toBe(9800);
      expect(screenshotTool.captureTabPngWithRetry).toHaveBeenCalledTimes(50);
      expect(fullCapture.originalCaptureWidth).toBe(1000);
      expect(fullCapture.originalCaptureHeight).toBe(10000);
      expect(fullCapture.widthCss).toBe(1000);
      expect(fullCapture.heightCss).toBe(fullCapture.originalCaptureHeight);
      expect(lastCanvasHeight).toBe(10000);
    }, 10000);

    it('records actual captured CSS height in docHeight via execute and maps center click to CSS 5000 not 10000', async () => {
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(async (_id: number, msg: any) => {
        if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE) return { success: true };
        if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS) {
          return {
            totalWidth: 1000,
            totalHeight: 20000,
            viewportWidth: 1000,
            viewportHeight: 1000,
            devicePixelRatio: 1,
            currentScrollX: 0,
            currentScrollY: 0,
          };
        }
        return { success: true };
      });

      // Mock real _captureFullPage return contract with captured 10000 CSS height and 5000 downscaled output
      vi.spyOn(screenshotTool as any, '_captureFullPage').mockResolvedValue({
        dataUrl: VALID_PNG_1,
        widthCss: 500,
        heightCss: 5000,
        originalCaptureWidth: 1000,
        originalCaptureHeight: 10000,
      });

      const res = await screenshotTool.execute({
        tabId,
        fullPage: true,
        maxHeight: 10000,
        width: 500,
      });

      expect(res.isError).toBeFalsy();

      const ctx = screenshotContextManager.getContext(tabId);
      expect(ctx).toBeDefined();
      expect(ctx?.captureMode).toBe('fullpage');
      expect(ctx?.screenshotWidth).toBe(500);
      expect(ctx?.screenshotHeight).toBe(5000);

      // docHeight must reflect the actually captured 10000 CSS px, NOT the uncaptured totalHeight 20000
      expect(ctx?.docHeight).toBe(10000);
      expect(ctx?.docWidth).toBe(1000);

      // Center click on screenshot space (250, 2500)
      const mappedCenter = scaleCoordinates(250, 2500, ctx!);
      // Must map to the center of captured content (CSS 500, 5000), not uncaptured CSS (500, 10000)
      expect(mappedCenter.x).toBe(500);
      expect(mappedCenter.y).toBe(5000);
    });
  });

  describe('2. P1 Asset Viewport-Crop Fallback Context & Origin', () => {
    it('directly asserts inPageGetAssetImage returns devicePixelRatio from window.devicePixelRatio', async () => {
      const MAP_KEY = Symbol.for('__browser_use_page_assets__') as any;
      const origDpr = (window as any).devicePixelRatio;
      try {
        const testEl = document.createElement('div');
        testEl.getBoundingClientRect = () => ({
          left: 50,
          top: 60,
          width: 200,
          height: 100,
          toJSON: () => ({ left: 50, top: 60, width: 200, height: 100 }),
        } as any);
        (globalThis as any)[MAP_KEY] = [{ el: testEl, kind: 'video', src: 'blob:video1' }];
        (window as any).devicePixelRatio = 2;

        const assetRes = await inPageGetAssetImage(1);
        expect(assetRes.rect?.x).toBe(50);
        expect(assetRes.rect?.y).toBe(60);
        expect(assetRes.rect?.width).toBe(200);
        expect(assetRes.rect?.height).toBe(100);
        expect(assetRes.devicePixelRatio).toBe(2);
      } finally {
        delete (globalThis as any)[MAP_KEY];
        (window as any).devicePixelRatio = origDpr;
      }
    });

    it.each([
      { label: 'active CSS bitmap at DPR 2', active: true, dpr: 2, bitmapWidth: 1000, bitmapHeight: 900, rect: { x: 120, y: 140, width: 200, height: 150 }, source: [110, 130, 220, 170], origin: [110, 130], size: [220, 170] },
      { label: 'background physical bitmap at DPR 2', active: false, dpr: 2, bitmapWidth: 2000, bitmapHeight: 1800, rect: { x: 120, y: 140, width: 200, height: 150 }, source: [220, 260, 440, 340], origin: [110, 130], size: [220, 170] },
      { label: 'active CSS bitmap at DPR 1', active: true, dpr: 1, bitmapWidth: 1000, bitmapHeight: 900, rect: { x: 120, y: 140, width: 200, height: 150 }, source: [110, 130, 220, 170], origin: [110, 130], size: [220, 170] },
      { label: 'independent bitmap axis ratios', active: true, dpr: 2, bitmapWidth: 2000, bitmapHeight: 1350, rect: { x: 120, y: 140, width: 200, height: 150 }, source: [220, 195, 440, 255], origin: [110, 130], size: [220, 170] },
      { label: 'partially outside top-left viewport', active: true, dpr: 2, bitmapWidth: 1000, bitmapHeight: 900, rect: { x: -50, y: -20, width: 200, height: 150 }, source: [0, 0, 160, 140], origin: [0, 0], size: [160, 140] },
      { label: 'partially outside bottom-right viewport', active: false, dpr: 2, bitmapWidth: 2000, bitmapHeight: 1800, rect: { x: 940, y: 860, width: 200, height: 150 }, source: [1860, 1700, 140, 100], origin: [930, 850], size: [70, 50] },
    ])('SC08 crops $label using actual bitmap geometry', async ({ active, dpr, bitmapWidth, bitmapHeight, rect, source, origin, size }) => {
      lastCanvasWidth = bitmapWidth;
      lastCanvasHeight = bitmapHeight;
      vi.spyOn(screenshotTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId, windowId: 1, active,
      });
      const execute = vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => [
        { frameId: 0, result: fnName === 'inPageGetScrollState'
          ? { viewportWidth: 1000, viewportHeight: 900, scrollX: 30, scrollY: 60, docWidth: 2000, docHeight: 3000 }
          : { success: false, reason: 'tainted canvas', rect, devicePixelRatio: dpr, kind: 'canvas' } },
      ] as any);
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) => fn());
      const capture = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({
        data: VALID_PNG_1.split(',')[1],
      });

      const res = await screenshotTool.execute({ tabId, assetIndex: 1, padding: 10, format: 'png' });

      expect(res.isError).toBeFalsy();
      expect(drawImage.mock.calls[0].slice(1)).toEqual([...source, 0, 0, ...size]);
      expect(execute).toHaveBeenCalledWith({ tabId }, 'inPageGetScrollState', []);
      if (active) {
        expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' });
        expect(capture).not.toHaveBeenCalled();
      } else {
        expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
        expect(capture).toHaveBeenCalledWith(tabId, 'Page.captureScreenshot', {
          format: 'png', fromSurface: true,
        });
      }
      const metadata = JSON.parse((res.content[0] as any).text);
      expect(metadata).toMatchObject({
        assetSource: 'viewport-crop', imageWidth: size[0], imageHeight: size[1],
        viewportWidth: 1000, viewportHeight: 900, originX: origin[0], originY: origin[1],
      });
      const ctx = screenshotContextManager.getContext(tabId)!;
      expect(ctx).toMatchObject({
        captureMode: 'element', screenshotWidth: size[0], screenshotHeight: size[1],
        cropWidth: size[0], cropHeight: size[1], originX: origin[0], originY: origin[1],
        viewportWidth: 1000, viewportHeight: 900, scrollX: 30, scrollY: 60,
      });
      expect(scaleCoordinates(size[0] / 2, size[1] / 2, ctx)).toEqual({
        x: origin[0] + size[0] / 2, y: origin[1] + size[1] / 2,
      });
    });

    it('SC08 rejects unavailable CSS viewport instead of guessing DPR', async () => {
      vi.spyOn(screenshotTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId, windowId: 1, active: true,
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => [
        { frameId: 0, result: fnName === 'inPageGetScrollState'
          ? { viewportWidth: 0, viewportHeight: 900 }
          : { rect: { x: 120, y: 140, width: 200, height: 150 }, devicePixelRatio: 2 } },
      ] as any);
      const res = await screenshotTool.execute({ tabId, assetIndex: 1, format: 'png' });
      expect(res.isError).toBe(true);
      expect((res.content[0] as any).text).toContain('Invalid viewport dimensions for asset fallback');
      expect(screenshotContextManager.getContext(tabId)).toBeUndefined();
    });
  });

  describe('3. Accepted ROI lossless contracts', () => {
    it.each([
      { label: 'region default', args: { region: { x0: 100, y0: 50, x1: 1500, y1: 650 } }, accepted: true, width: 1400, height: 600 },
      { label: 'crop alias default', args: { crop: { x0: 100, y0: 50, x1: 1500, y1: 650 } }, accepted: true, width: 1400, height: 600 },
      { label: 'explicit maxWidth', args: { region: { x0: 100, y0: 50, x1: 1500, y1: 650 }, maxWidth: 300 }, accepted: true, width: 300, height: 129 },
      { label: 'rejected ROI fallback', args: { region: { x0: 100, y0: 50, x1: NaN, y1: 650 } }, accepted: false, width: 1280, height: 720 },
    ])('uses accepted results.roi for $label', async ({ args, accepted, width, height }) => {
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) => fn());
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_id, method, params: any) => {
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { clientWidth: 1600, clientHeight: 900, pageX: 0, pageY: 0 } };
        }
        if (method === 'Page.captureScreenshot') {
          if (params.clip && !Number.isFinite(params.clip.width)) throw new Error('Invalid ROI clip');
          return { data: VALID_PNG_1.split(',')[1], mimeType: 'image/png' };
        }
        return {};
      });

      const res = await screenshotTool.execute({ tabId, format: 'png', ...args });

      expect(res.isError).toBeFalsy();
      const metadata = JSON.parse((res.content[0] as any).text);
      const ctx = screenshotContextManager.getContext(tabId)!;
      expect(metadata.roi?.width).toBe(accepted ? 1400 : undefined);
      expect(metadata.imageWidth).toBe(width);
      expect(ctx.screenshotWidth).toBe(width);
      expect(ctx.screenshotHeight).toBe(height);
      expect(lastCanvasWidth).toBe(width);
      expect(lastCanvasHeight).toBe(height);
      if (accepted) {
        expect(ctx.cropWidth).toBe(1400);
        expect(ctx.cropHeight).toBe(600);
        expect(scaleCoordinates(width / 2, height / 2, ctx)).toMatchObject({ x: 800, y: 350 });
      }
    });

    it.each([false, true])('disables soft budget downsampling for accepted ROI with fullPage=%s', async (fullPage) => {
      lastCanvasWidth = 1400;
      lastCanvasHeight = 600;
      const largePngBase64 = btoa(atob(VALID_PNG_1.split(',')[1]) + '\0'.repeat(460 * 1024));
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) => fn());
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_id, method) => {
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { clientWidth: 1600, clientHeight: 900, pageX: 0, pageY: 0 } };
        }
        return { data: largePngBase64, mimeType: 'image/png' };
      });
      const transport = vi.spyOn(imageUtils, 'smartCompressForTransport').mockResolvedValue({
        dataUrl: VALID_PNG_1, mimeType: 'image/png', width: 1400, height: 600,
        scaleRatio: 1, wasDownscaled: false, byteLength: 100,
      });

      const res = await screenshotTool.execute({
        tabId, format: 'png', region: { x0: 100, y0: 50, x1: 1500, y1: 650 },
        maxWidth: 1400, fullPage, allowDimensionScaling: true,
      });

      expect(res.isError).toBeFalsy();
      expect(largePngBase64.length).toBeGreaterThan(450 * 1024);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0][1]).toMatchObject({
        allowDimensionScaling: false, quality: 0.92,
      });
      const metadata = JSON.parse((res.content[0] as any).text);
      expect(metadata.roi.width).toBe(1400);
      expect(metadata.imageWidth).toBe(1400);
      expect(metadata.imageHeight).toBe(600);
      expect(screenshotContextManager.getContext(tabId)?.screenshotWidth).toBe(1400);

      const ctx = screenshotContextManager.getContext(tabId)!;
      expect(ctx.captureMode).toBe('element');
      const mappedCenter = scaleCoordinates(1400 / 2, 600 / 2, ctx);
      expect(mappedCenter).toEqual({ x: 800, y: 350 });
      expect(mappedCenter.isDocumentSpace).toBeFalsy();
    });
  });

  describe('4. P2 maxWidth Default Clamping and Parameter Contracts', () => {
    it.each([
      { label: 'ordinary default', highClarity: undefined, maxWidth: undefined, expectedWidth: 1280 },
      { label: 'high clarity default', highClarity: true, maxWidth: undefined, expectedWidth: 1600 },
      { label: 'high clarity explicit cap', highClarity: true, maxWidth: 300, expectedWidth: 300 },
    ])('preserves the width contract for $label on a 1600px viewport', async ({ highClarity, maxWidth, expectedWidth }) => {
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(async (_id: number, msg: any) => {
        if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE) return { success: true };
        if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS) {
          return {
            totalWidth: 1600,
            totalHeight: 900,
            viewportWidth: 1600,
            viewportHeight: 900,
            devicePixelRatio: 1,
            currentScrollX: 0,
            currentScrollY: 0,
          };
        }
        return { success: true };
      });

      const res = await screenshotTool.execute({
        tabId,
        highClarity,
        maxWidth,
      });

      expect(res.isError).toBeFalsy();
      const ctx = screenshotContextManager.getContext(tabId);
      expect(ctx).toBeDefined();
      expect(ctx!.screenshotWidth).toBe(expectedWidth);
      expect(ctx!.screenshotHeight).toBe(Math.round(900 * (expectedWidth / 1600)));
      expect(lastCanvasWidth).toBe(expectedWidth);
      expect(lastCanvasHeight).toBe(ctx!.screenshotHeight);
    });

    it('honors explicit maxWidth 300 and preserves smaller dimensions', async () => {
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(async (_id: number, msg: any) => {
        if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE) return { success: true };
        if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS) {
          return {
            totalWidth: 800,
            totalHeight: 600,
            viewportWidth: 800,
            viewportHeight: 600,
            devicePixelRatio: 1,
            currentScrollX: 0,
            currentScrollY: 0,
          };
        }
        return { success: true };
      });

      const res = await screenshotTool.execute({
        tabId,
        maxWidth: 300,
      });

      expect(res.isError).toBeFalsy();
      const ctx = screenshotContextManager.getContext(tabId);
      expect(ctx).toBeDefined();
      expect(ctx!.screenshotWidth).toBe(300);
      expect(ctx!.screenshotHeight).toBe(Math.round(600 * (300 / 800))); // 225
    });
  });
});

