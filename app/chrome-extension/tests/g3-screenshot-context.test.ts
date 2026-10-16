import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screenshotTool } from '../entrypoints/background/tools/browser/screenshot';
import { screenshotContextManager, scaleCoordinates } from '@/utils/screenshot-context';
import { snapshotCacheManager } from '@/utils/snapshot-cache-manager';
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
  let fillTextCalls: Array<{ text: string; x: number; y: number }> = [];

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
        // 2D surface used by overlayCoordinateGrid, so D-07 can assert drawn labels
        font: '',
        strokeStyle: '',
        lineWidth: 1,
        save: vi.fn(),
        restore: vi.fn(),
        setLineDash: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
        fillText: vi.fn((text: string, x: number, y: number) => {
          fillTextCalls.push({ text, x, y });
        }),
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
      this.result = VALID_URL_SEQ[urlSeqIdx++ % VALID_URL_SEQ.length];
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
    fillTextCalls = [];

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
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(
        async (_id: number, msg: any) => {
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_WARMUP_PAGE) return { success: true };
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_SLICE) return { success: true };
          return { success: true };
        },
      );
      vi.spyOn(imageUtils, 'stitchImages').mockResolvedValue(
        new MockOffscreenCanvas(1000, 10000) as any,
      );

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
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(
        async (_id: number, msg: any) => {
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE)
            return { success: true };
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
        },
      );

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
        testEl.getBoundingClientRect = () =>
          ({
            left: 50,
            top: 60,
            width: 200,
            height: 100,
            toJSON: () => ({ left: 50, top: 60, width: 200, height: 100 }),
          }) as any;
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
      {
        label: 'active CSS bitmap at DPR 2',
        active: true,
        dpr: 2,
        bitmapWidth: 1000,
        bitmapHeight: 900,
        rect: { x: 120, y: 140, width: 200, height: 150 },
        source: [110, 130, 220, 170],
        origin: [110, 130],
        size: [220, 170],
      },
      {
        label: 'background physical bitmap at DPR 2',
        active: false,
        dpr: 2,
        bitmapWidth: 2000,
        bitmapHeight: 1800,
        rect: { x: 120, y: 140, width: 200, height: 150 },
        source: [220, 260, 440, 340],
        origin: [110, 130],
        size: [220, 170],
      },
      {
        label: 'active CSS bitmap at DPR 1',
        active: true,
        dpr: 1,
        bitmapWidth: 1000,
        bitmapHeight: 900,
        rect: { x: 120, y: 140, width: 200, height: 150 },
        source: [110, 130, 220, 170],
        origin: [110, 130],
        size: [220, 170],
      },
      {
        label: 'independent bitmap axis ratios',
        active: true,
        dpr: 2,
        bitmapWidth: 2000,
        bitmapHeight: 1350,
        rect: { x: 120, y: 140, width: 200, height: 150 },
        source: [220, 195, 440, 255],
        origin: [110, 130],
        size: [220, 170],
      },
      {
        label: 'partially outside top-left viewport',
        active: true,
        dpr: 2,
        bitmapWidth: 1000,
        bitmapHeight: 900,
        rect: { x: -50, y: -20, width: 200, height: 150 },
        source: [0, 0, 160, 140],
        origin: [0, 0],
        size: [160, 140],
      },
      {
        label: 'partially outside bottom-right viewport',
        active: false,
        dpr: 2,
        bitmapWidth: 2000,
        bitmapHeight: 1800,
        rect: { x: 940, y: 860, width: 200, height: 150 },
        source: [1860, 1700, 140, 100],
        origin: [930, 850],
        size: [70, 50],
      },
    ])(
      'SC08 crops $label using actual bitmap geometry',
      async ({ active, dpr, bitmapWidth, bitmapHeight, rect, source, origin, size }) => {
        lastCanvasWidth = bitmapWidth;
        lastCanvasHeight = bitmapHeight;
        vi.spyOn(screenshotTool as any, 'resolveAffinityTab').mockResolvedValue({
          id: tabId,
          windowId: 1,
          active,
        });
        const execute = vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
          async (_target, fnName) =>
            [
              {
                frameId: 0,
                result:
                  fnName === 'inPageGetScrollState'
                    ? {
                        viewportWidth: 1000,
                        viewportHeight: 900,
                        scrollX: 30,
                        scrollY: 60,
                        docWidth: 2000,
                        docHeight: 3000,
                      }
                    : {
                        success: false,
                        reason: 'tainted canvas',
                        rect,
                        devicePixelRatio: dpr,
                        kind: 'canvas',
                      },
              },
            ] as any,
        );
        vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) =>
          fn(),
        );
        const capture = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({
          data: VALID_PNG_1.split(',')[1],
        });

        const res = await screenshotTool.execute({
          tabId,
          assetIndex: 1,
          padding: 10,
          format: 'png',
        });

        expect(res.isError).toBeFalsy();
        expect(drawImage.mock.calls[0].slice(1)).toEqual([...source, 0, 0, ...size]);
        expect(execute).toHaveBeenCalledWith({ tabId }, 'inPageGetScrollState', []);
        if (active) {
          expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' });
          expect(capture).not.toHaveBeenCalled();
        } else {
          expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
          expect(capture).toHaveBeenCalledWith(tabId, 'Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
          });
        }
        const metadata = JSON.parse((res.content[0] as any).text);
        expect(metadata).toMatchObject({
          assetSource: 'viewport-crop',
          imageWidth: size[0],
          imageHeight: size[1],
          viewportWidth: 1000,
          viewportHeight: 900,
          originX: origin[0],
          originY: origin[1],
        });
        const ctx = screenshotContextManager.getContext(tabId)!;
        expect(ctx).toMatchObject({
          captureMode: 'element',
          screenshotWidth: size[0],
          screenshotHeight: size[1],
          cropWidth: size[0],
          cropHeight: size[1],
          originX: origin[0],
          originY: origin[1],
          viewportWidth: 1000,
          viewportHeight: 900,
          scrollX: 30,
          scrollY: 60,
        });
        expect(scaleCoordinates(size[0] / 2, size[1] / 2, ctx)).toEqual({
          x: origin[0] + size[0] / 2,
          y: origin[1] + size[1] / 2,
        });
      },
    );

    it('SC08 rejects unavailable CSS viewport instead of guessing DPR', async () => {
      vi.spyOn(screenshotTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId,
        windowId: 1,
        active: true,
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (_target, fnName) =>
          [
            {
              frameId: 0,
              result:
                fnName === 'inPageGetScrollState'
                  ? { viewportWidth: 0, viewportHeight: 900 }
                  : { rect: { x: 120, y: 140, width: 200, height: 150 }, devicePixelRatio: 2 },
            },
          ] as any,
      );
      const res = await screenshotTool.execute({ tabId, assetIndex: 1, format: 'png' });
      expect(res.isError).toBe(true);
      expect((res.content[0] as any).text).toContain(
        'Invalid viewport dimensions for asset fallback',
      );
      expect(screenshotContextManager.getContext(tabId)).toBeUndefined();
    });
  });

  describe('3. Accepted ROI lossless contracts', () => {
    it.each([false, true])(
      'bounds the Jev first capture and rejects document drift=%s',
      async (drift) => {
        vi.useFakeTimers();
        try {
          const url = 'https://example.com/vision';
          const scroll = { scrollX: 0, scrollY: 0, viewportWidth: 1000, viewportHeight: 1000 };
          let scrollProbes = 0;
          vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, name) => {
            if (name === 'inPageGetScrollState') scrollProbes++;
            return [
              {
                documentId: drift && scrollProbes > 1 ? 'replaced-document' : 'vision-document',
                result:
                  name === 'inPageGetScrollState'
                    ? scroll
                    : { url, title: 'Vision', activeInputs: [], alerts: [] },
              },
            ] as any;
          });
          vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) =>
            fn(),
          );
          vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_id, method) => {
            if (method === 'Page.getLayoutMetrics') {
              return { cssVisualViewport: { clientWidth: 1000, clientHeight: 1000 } };
            }
            return new Promise(() => {});
          });
          (chrome as any).debugger = { sendCommand: vi.fn(() => new Promise(() => {})) };
          vi.spyOn(screenshotTool as any, 'injectScreenshotHelper').mockResolvedValue(undefined);
          vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(
            async (_id: number, msg: any) =>
              msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS
                ? {
                    ...scroll,
                    totalWidth: 1000,
                    totalHeight: 1000,
                    devicePixelRatio: 1,
                    currentScrollX: 0,
                    currentScrollY: 0,
                  }
                : { success: true },
          );
          let settled = false;
          const pending = screenshotTool
            .execute({ tabId, format: 'png', _jevVision: true } as any)
            .then((value) => {
              settled = true;
              return value;
            });
          await vi.advanceTimersByTimeAsync(2500);
          expect(settled).toBe(true);
          const result = await pending;
          expect(screenshotTool.captureTabPngWithRetry).toHaveBeenCalledTimes(1);
          if (drift) {
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toContain('Document changed during screenshot capture');
            return;
          }
          expect(result.isError, JSON.stringify(result)).toBeFalsy();
          const metadata = JSON.parse((result.content[0] as any).text);
          expect(metadata.cdpCaptureWarning).toContain('1500ms');
          expect(screenshotContextManager.getVisionFrame(metadata.visionFrame.id)).toBeDefined();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each([
      { active: false, stalledRetry: false },
      { active: true, stalledRetry: false },
      { active: false, stalledRetry: true },
      { active: true, stalledRetry: true },
    ])(
      'bounds black-bar retry when active=$active and stalledRetry=$stalledRetry',
      async ({ active, stalledRetry }) => {
        vi.useFakeTimers();
        try {
          vi.spyOn(screenshotTool as any, 'resolveAffinityTab').mockResolvedValue({
            id: tabId,
            windowId: 1,
            active,
            width: 1000,
            height: 1000,
          });
          vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) =>
            fn(),
          );
          let captureCount = 0;
          const capture = vi
            .spyOn(cdpSessionManager, 'sendCommand')
            .mockImplementation(async (_id, method) => {
              if (method === 'Runtime.evaluate') {
                return new Promise(() => {});
              }
              if (method === 'Page.getLayoutMetrics') {
                return {
                  cssVisualViewport: { clientWidth: 1000, clientHeight: 1000, pageX: 0, pageY: 0 },
                };
              }
              if (method === 'Page.captureScreenshot' && ++captureCount === 2 && stalledRetry) {
                return new Promise(() => {});
              }
              return { data: VALID_PNG_1.split(',')[1], mimeType: 'image/png' };
            });
          let settled = false;
          const result = screenshotTool.execute({ tabId, format: 'png' }).then((value) => {
            settled = true;
            return value;
          });
          await vi.advanceTimersByTimeAsync(2500);
          expect(settled).toBe(true);
          const response = await result;
          expect(response.isError).toBeFalsy();
          expect(JSON.parse((response.content[0] as any).text).cdpCaptureWarning).toBe(
            stalledRetry ? 'Black-bar recapture exceeded 1000ms; using initial frame' : undefined,
          );
          expect(
            capture.mock.calls.filter((call) => call[1] === 'Page.captureScreenshot'),
          ).toHaveLength(2);
          expect(capture.mock.calls.filter((call) => call[1] === 'Runtime.evaluate')).toHaveLength(
            active ? 2 : 0,
          );
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each([
      {
        label: 'region default',
        args: { region: { x0: 100, y0: 50, x1: 1500, y1: 650 } },
        accepted: true,
        width: 1400,
        height: 600,
      },
      {
        label: 'crop alias default',
        args: { crop: { x0: 100, y0: 50, x1: 1500, y1: 650 } },
        accepted: true,
        width: 1400,
        height: 600,
      },
      {
        label: 'explicit maxWidth',
        args: { region: { x0: 100, y0: 50, x1: 1500, y1: 650 }, maxWidth: 300 },
        accepted: true,
        width: 300,
        height: 129,
      },
      {
        label: 'rejected ROI fallback',
        args: { region: { x0: 100, y0: 50, x1: NaN, y1: 650 } },
        accepted: false,
        width: 1280,
        height: 720,
      },
    ])('uses accepted results.roi for $label', async ({ args, accepted, width, height }) => {
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) =>
        fn(),
      );
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
        async (_id, method, params: any) => {
          if (method === 'Page.getLayoutMetrics') {
            return {
              cssVisualViewport: { clientWidth: 1600, clientHeight: 900, pageX: 0, pageY: 0 },
            };
          }
          if (method === 'Page.captureScreenshot') {
            if (params.clip && !Number.isFinite(params.clip.width))
              throw new Error('Invalid ROI clip');
            return { data: VALID_PNG_1.split(',')[1], mimeType: 'image/png' };
          }
          return {};
        },
      );

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

    it.each([false, true])(
      'disables soft budget downsampling for accepted ROI with fullPage=%s',
      async (fullPage) => {
        lastCanvasWidth = 1400;
        lastCanvasHeight = 600;
        const largePngBase64 = btoa(atob(VALID_PNG_1.split(',')[1]) + '\0'.repeat(460 * 1024));
        vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) =>
          fn(),
        );
        vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_id, method) => {
          if (method === 'Page.getLayoutMetrics') {
            return {
              cssVisualViewport: { clientWidth: 1600, clientHeight: 900, pageX: 0, pageY: 0 },
            };
          }
          return { data: largePngBase64, mimeType: 'image/png' };
        });
        const transport = vi.spyOn(imageUtils, 'smartCompressForTransport').mockResolvedValue({
          dataUrl: VALID_PNG_1,
          mimeType: 'image/png',
          width: 1400,
          height: 600,
          scaleRatio: 1,
          wasDownscaled: false,
          byteLength: 100,
        });

        const res = await screenshotTool.execute({
          tabId,
          format: 'png',
          region: { x0: 100, y0: 50, x1: 1500, y1: 650 },
          maxWidth: 1400,
          fullPage,
          allowDimensionScaling: true,
        });

        expect(res.isError).toBeFalsy();
        expect(largePngBase64.length).toBeGreaterThan(450 * 1024);
        expect(transport).toHaveBeenCalledTimes(1);
        expect(transport.mock.calls[0][1]).toMatchObject({
          allowDimensionScaling: false,
          quality: 0.92,
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
      },
    );
  });

  describe('4. P2 maxWidth Default Clamping and Parameter Contracts', () => {
    it('S-05 preserves CDP viewport dimensions through maxWidth scaling', async () => {
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _owner, fn) =>
        fn(),
      );
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_id, method) => {
        if (method === 'Page.getLayoutMetrics') {
          return {
            cssVisualViewport: { clientWidth: 1600, clientHeight: 900, pageX: 30, pageY: 60 },
          };
        }
        return { data: VALID_PNG_1.split(',')[1], mimeType: 'image/png' };
      });
      const helper = vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry');

      const result = await screenshotTool.execute({
        tabId,
        background: true,
        format: 'png',
        maxWidth: 640,
      });

      expect(result.isError).toBeFalsy();
      const metadata = JSON.parse((result.content[0] as any).text);
      expect(metadata).toMatchObject({
        imageWidth: 640,
        imageHeight: 360,
        viewportWidth: 1600,
        viewportHeight: 900,
      });
      const context = screenshotContextManager.getContext(tabId)!;
      expect(context).toMatchObject({
        screenshotWidth: 640,
        screenshotHeight: 360,
        viewportWidth: 1600,
        viewportHeight: 900,
        scrollX: 30,
        scrollY: 60,
      });
      expect(scaleCoordinates(568, 200, context)).toEqual({ x: 1420, y: 500 });
      expect(helper).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'ordinary default',
        highClarity: undefined,
        maxWidth: undefined,
        expectedWidth: 1280,
      },
      {
        label: 'high clarity default',
        highClarity: true,
        maxWidth: undefined,
        expectedWidth: 1600,
      },
      { label: 'high clarity explicit cap', highClarity: true, maxWidth: 300, expectedWidth: 300 },
    ])(
      'preserves the width contract for $label on a 1600px viewport',
      async ({ highClarity, maxWidth, expectedWidth }) => {
        vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(
          async (_id: number, msg: any) => {
            if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE)
              return { success: true };
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
          },
        );

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
      },
    );

    it('honors explicit maxWidth 300 and preserves smaller dimensions', async () => {
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(
        async (_id: number, msg: any) => {
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE)
            return { success: true };
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
        },
      );

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

  describe('D-06: screenshot URL and assetSrc scrubbing', () => {
    it('scrubs sensitive tokens and query parameters from returned tab url and assetSrc', async () => {
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: tabId,
        url: 'https://example.com/oauth/callback?access_token=secret_tok_123&api_key=key_abc',
        title: 'Sensitive Page',
      });

      // Mock executeInPage for asset retrieval with sensitive src
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            success: true,
            kind: 'img',
            src: 'https://cdn.example.com/private.png?signature=secsig123&token=tok456',
            dataUrl: VALID_PNG_1,
            rect: { x: 0, y: 0, width: 100, height: 100 },
          },
        },
      ] as any);

      const res = await screenshotTool.execute({
        tabId,
        assetIndex: 1,
      });

      expect(res.isError).toBeFalsy();
      const payload = JSON.parse(res.content[0].text as string);

      expect(payload.url).not.toContain('secret_tok_123');
      expect(payload.url).not.toContain('key_abc');
      expect(payload.url).toContain('REDACTED');

      expect(payload.assetSrc).not.toContain('secsig123');
      expect(payload.assetSrc).not.toContain('tok456');
      expect(payload.assetSrc).toContain('REDACTED');
    });
  });

  describe('D-19: multi-frame asset routing via snapshot cache', () => {
    it('routes subframe asset to target frameId with local index instead of broadcasting global index to all frames', async () => {
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: tabId,
        url: 'https://example.com/dashboard',
        title: 'Multi-frame Dashboard',
      });

      // Register assetRoutes in snapshot cache: global asset 4 -> frameId 99, localIndex 0
      snapshotCacheManager.setSnapshot(tabId, {
        url: 'https://example.com/dashboard',
        elementCount: 10,
        assetRoutes: new Map([
          [1, { frameId: 0, localIndex: 0 }],
          [2, { frameId: 0, localIndex: 1 }],
          [3, { frameId: 0, localIndex: 2 }],
          [4, { frameId: 99, localIndex: 0 }],
        ]),
      });

      const spy = vi
        .spyOn(inPageEngine, 'executeInPage')
        .mockImplementation(async (target: any, funcName: string, args?: any[]) => {
          if (funcName === 'inPageGetAssetImage') {
            return [
              {
                frameId: target.frameIds?.[0] ?? 0,
                result: {
                  success: true,
                  kind: 'img',
                  src: 'https://subframe.example.com/slot.png',
                  dataUrl: VALID_PNG_1,
                  rect: { x: 10, y: 10, width: 200, height: 100 },
                },
              },
            ] as any;
          }
          return [] as any;
        });

      await screenshotTool.execute({
        tabId,
        assetIndex: 4,
      });

      expect(spy).toHaveBeenCalled();
      const assetCall = spy.mock.calls.find((call) => call[1] === 'inPageGetAssetImage');
      expect(assetCall).toBeDefined();

      // Must target frameId 99 specifically, not allFrames: true
      const targetArg = assetCall![0] as any;
      expect(targetArg.frameIds).toEqual([99]);
      expect(targetArg.allFrames).toBeUndefined();

      // Must pass 1-based local index (localIndex 0 + 1 = 1) instead of global index (4)
      const funcArgs = assetCall![2] as any[];
      expect(funcArgs[0]).toBe(1);

      spy.mockRestore();
    });
  });

  describe('D-07: grid overlay labels survive maxWidth downscale', () => {
    it('maps downscaled canvas pixels back to unscaled CSS viewport coordinates in badges, rulers and origin badge', async () => {
      // Element capture 2000x1200 CSS at viewport origin (1200, 0); explicit maxWidth 1280 -> scale 0.64
      vi.spyOn(screenshotTool as any, 'sendToHelperWithRetry').mockImplementation(
        async (_id: number, msg: any) => {
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE)
            return { success: true };
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS) {
            return {
              totalWidth: 3200,
              totalHeight: 1200,
              viewportWidth: 3200,
              viewportHeight: 1200,
              devicePixelRatio: 1,
              currentScrollX: 0,
              currentScrollY: 0,
            };
          }
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_GET_ELEMENT_DETAILS) {
            return {
              devicePixelRatio: 1,
              rect: { x: 1200, y: 0, width: 2000, height: 1200 },
            };
          }
          return { success: true };
        },
      );

      const gridSpy = vi.spyOn(imageUtils, 'overlayCoordinateGrid');

      const res = await screenshotTool.execute({
        tabId,
        selector: '#hero',
        grid: true,
        maxWidth: 1280,
        format: 'png',
      });
      expect(res.isError).toBeFalsy();

      // The downscale really happened and the crop origin is still the unscaled CSS origin
      const ctx = screenshotContextManager.getContext(tabId)!;
      expect(ctx.screenshotWidth).toBe(1280);
      expect(ctx.screenshotHeight).toBe(768);
      expect(ctx.originX).toBe(1200);
      expect(ctx.cropWidth).toBe(2000);

      // The overlay must be told the canvas is 0.64x of the CSS space it annotates
      expect(gridSpy).toHaveBeenCalledTimes(1);
      const gridOptions = gridSpy.mock.calls[0][5] as any;
      expect(gridOptions.viewportScale).toBeCloseTo(0.64, 6);

      const labels = fillTextCalls.map((c) => c.text);
      // Intersection badge at canvas (200,200) -> CSS (1200 + 200/0.64, 200/0.64) = (1513, 313)
      expect(labels).toContain('(1513,313)');
      // Top ruler major tick at canvas x=200 -> CSS 1513
      expect(labels).toContain('1513');
      // Left ruler major tick at canvas y=200 -> CSS 313
      expect(labels).toContain('313');
      // Corner origin badge keeps reporting the unscaled CSS crop origin
      expect(labels).toContain('1200,0');

      // Pre-fix values (canvas pixels treated as CSS pixels) must be gone
      expect(labels).not.toContain('(1400,200)');
      expect(labels).not.toContain('1400');
      expect(labels).not.toContain('200');
    });
  });

  describe('D-12: cross-frame helper fanout', () => {
    const MAIN_FRAME = { frameId: 0, url: 'https://example.com/' };
    const CHILD_FRAME = { frameId: 1, url: 'https://embed.example.com/widget' };
    const RESTRICTED_FRAME = { frameId: 3, url: 'chrome://settings/' };

    const stubFrames = (frames: Array<{ frameId: number; url: string }>) => {
      (globalThis as any).chrome.webNavigation = {
        getAllFrames: vi.fn().mockResolvedValue(frames),
      };
    };

    const PAGE_DETAILS = {
      totalWidth: 1000,
      totalHeight: 600,
      viewportWidth: 1000,
      viewportHeight: 600,
      devicePixelRatio: 1,
      currentScrollX: 12,
      currentScrollY: 34,
    };

    it('waits for every frame prepare to settle before the finally-reset is dispatched', async () => {
      stubFrames([MAIN_FRAME, CHILD_FRAME, { frameId: 2, url: 'https://slow.example.com/' }]);

      let inFlight = 0;
      const inFlightAtReset: number[] = [];
      let releaseSlowFrame!: () => void;
      const slowFrameGate = new Promise<void>((resolve) => {
        releaseSlowFrame = resolve;
      });
      let onReset: (() => void) | undefined;
      const resetSeen = new Promise<void>((resolve) => {
        onReset = resolve;
      });

      (screenshotTool as any).sendMessageToTab = vi.fn(
        async (_tabId: number, msg: any, frameId?: number) => {
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE) {
            if (frameId === 1) throw new Error('frame 1 helper is gone');
            if (frameId === 2) {
              inFlight++;
              try {
                await slowFrameGate;
              } finally {
                inFlight--;
              }
            }
            return { success: true };
          }
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE) {
            inFlightAtReset.push(inFlight);
            onReset?.();
            return { success: true };
          }
          return { success: true };
        },
      );
      // The post-failure re-inject fails too, so a retry round cannot hide the state
      vi.spyOn(screenshotTool as any, 'injectScreenshotHelper')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error('re-inject failed'));

      const execPromise = screenshotTool.execute({ tabId, fullPage: true });
      // Either the reset already fired (early reject) or the fanout is still waiting on frame 2
      await Promise.race([resetSeen, new Promise((resolve) => setTimeout(resolve, 500))]);
      releaseSlowFrame();
      const res = await execPromise;

      expect(res.isError).toBe(true);
      expect(inFlightAtReset.length).toBeGreaterThan(0);
      // A Promise.all early reject starts the reset while frame 2 is still preparing
      expect(inFlightAtReset.every((n) => n === 0)).toBe(true);
    });

    it('fans prepare/reset out to valid frames only, reads dimensions from frame 0, and keeps main scroll off child resets', async () => {
      stubFrames([MAIN_FRAME, CHILD_FRAME, RESTRICTED_FRAME]);

      const sent: Array<{ action: string; frameId?: number; msg: any }> = [];
      (screenshotTool as any).sendMessageToTab = vi.fn(
        async (_tabId: number, msg: any, frameId?: number) => {
          sent.push({ action: msg.action, frameId, msg });
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS) return PAGE_DETAILS;
          return { success: true };
        },
      );
      vi.spyOn(imageUtils, 'stitchImages').mockResolvedValue(
        new MockOffscreenCanvas(1000, 600) as any,
      );

      const res = await screenshotTool.execute({ tabId, fullPage: true });
      expect(res.isError).toBeFalsy();

      const framesFor = (action: string) =>
        sent.filter((s) => s.action === action).map((s) => s.frameId);

      // preparePage / prepareSlice / reset fan out to every valid frame (chrome:// filtered out)
      expect(framesFor(TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE)).toEqual([0, 1]);
      expect(framesFor(TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_SLICE)).toEqual([0, 1]);
      expect(framesFor(TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE)).toEqual([0, 1]);
      // dimensions and scroll are read from the main frame only
      expect(framesFor(TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS)).toEqual([0]);
      expect(framesFor(TOOL_MESSAGE_TYPES.SCREENSHOT_WARMUP_PAGE)).toEqual([0]);

      const resetFor = (frameId: number) =>
        sent.find(
          (s) =>
            s.action === TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE &&
            s.frameId === frameId,
        )!.msg;
      expect(resetFor(0).scrollX).toBe(12);
      expect(resetFor(0).scrollY).toBe(34);
      // a child frame must not replay the main frame's original scroll coordinates
      expect(resetFor(1)).toEqual({
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE,
      });
    });

    it('still injects the helper into child frames when the main frame already answers the ping', async () => {
      const freshTabId = 909;
      stubFrames([MAIN_FRAME, CHILD_FRAME, { frameId: 2, url: 'https://third.example.com/' }]);

      const executeScript = vi.fn().mockResolvedValue([{ frameId: 1, result: null }]);
      (globalThis as any).chrome.scripting = { executeScript };
      (globalThis as any).chrome.tabs.get = vi
        .fn()
        .mockResolvedValue({ id: freshTabId, windowId: 1, url: 'https://example.com/' });
      (globalThis as any).chrome.tabs.sendMessage = vi.fn(
        async (_tabId: number, msg: any, options?: any) => {
          if (options?.frameId === 0 && String(msg.action).startsWith('mcp_ping_')) {
            return { status: 'pong' };
          }
          throw new Error(`no helper in frame ${options?.frameId}`);
        },
      );
      // Exercise the real shared injectContentScript instead of the suite's stub
      (screenshotTool as any).injectContentScript.mockRestore();

      await (screenshotTool as any).injectScreenshotHelper(freshTabId);

      // frame 0 answered the ping, frames 1 and 2 still get a targeted injection
      expect(executeScript).toHaveBeenCalledTimes(2);
      const targets = executeScript.mock.calls.map((call) => call[0].target);
      expect(
        targets
          .map((t) => t.frameIds)
          .flat()
          .sort(),
      ).toEqual([1, 2]);
      // Chrome rejects frameIds combined with allFrames, so the target must be frameIds-only
      for (const target of targets) {
        expect(target.frameIds).toHaveLength(1);
        expect(target.allFrames).toBeUndefined();
      }
    });

    it('still broadcasts the reset when preparePage itself rejects', async () => {
      stubFrames([MAIN_FRAME, CHILD_FRAME]);

      const resetFrames: number[] = [];
      (screenshotTool as any).sendMessageToTab = vi.fn(
        async (_tabId: number, msg: any, frameId?: number) => {
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE) {
            throw new Error('helper missing in every frame');
          }
          if (msg.action === TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE) {
            resetFrames.push(frameId!);
          }
          return { success: true };
        },
      );
      vi.spyOn(screenshotTool as any, 'injectScreenshotHelper').mockResolvedValue(undefined);

      const res = await screenshotTool.execute({ tabId, fullPage: true });

      expect(res.isError).toBe(true);
      // didPreparePage is set before the prepare await, so the finally reset still runs
      expect(resetFrames).toEqual([0, 1]);
    });
  });
});
