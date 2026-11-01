import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screenshotTool } from '../entrypoints/background/tools/browser/screenshot';
import { computerTool } from '../entrypoints/background/tools/browser/computer';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { screenshotContextManager } from '../utils/screenshot-context';
import {
  assertScreenshotCaptureStable,
  clearScreenshotValidity,
  createScreenshotCapture,
  inPageReadScreenshotState,
  SCREENSHOT_CAPTURE_VALIDATION_BOUNDARY,
  validateScreenshotCapture,
  type ScreenshotPageState,
} from '../utils/screenshot-validity';

const VALID_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let lastCanvasWidth = 1000;
let lastCanvasHeight = 800;

class MockOffscreenCanvas {
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) })),
      measureText: vi.fn(() => ({ width: 10 })),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
    };
  }

  async convertToBlob(options?: { type?: string }) {
    lastCanvasWidth = this.width;
    lastCanvasHeight = this.height;
    return new Blob(['image'], { type: options?.type || 'image/png' });
  }
}

class MockFileReader {
  result: string | null = null;
  onloadend: (() => void) | null = null;

  readAsDataURL() {
    this.result = VALID_PNG;
    this.onloadend?.();
  }
}

describe('Screenshot capture validity', () => {
  const tabId = 5150;
  const baseState = {
    documentId: 'doc-capture-1',
    documentURL: 'https://example.com/page',
    scrollX: 12,
    scrollY: 34,
    viewportWidth: 1000,
    viewportHeight: 800,
    devicePixelRatio: 2,
  };

  let currentState = { ...baseState };
  let probeQueue: Array<typeof baseState> = [];
  let dispatchedEvents: Array<{ method: string; params: any }> = [];
  let baseSendCommand: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    screenshotContextManager.clear(tabId);
    clearScreenshotValidity(tabId);
    currentState = { ...baseState };
    probeQueue = [];
    dispatchedEvents = [];
    lastCanvasWidth = 1000;
    lastCanvasHeight = 800;
    document.body.innerHTML = '<button id="original">Original</button>';
    document
      .querySelectorAll('[data-test-screenshot-validity]')
      .forEach((element) => element.remove());
    delete (globalThis as any).__browserpaw_dom_revision_v1__;

    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
    vi.stubGlobal('FileReader', MockFileReader);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () => new Blob(['image'], { type: 'image/png' }),
      })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: lastCanvasWidth,
        height: lastCanvasHeight,
        close: vi.fn(),
      })),
    );
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: tabId,
          windowId: 1,
          active: true,
          url: 'https://example.com/page',
        }),
        captureVisibleTab: vi.fn().mockResolvedValue(VALID_PNG),
      },
      scripting: {
        executeScript: vi.fn(async ({ func }: any) => {
          if (typeof func !== 'function') return [{ result: undefined }];
          const actual = func();
          const state = probeQueue.shift() || currentState;
          return [
            {
              result: {
                ...actual,
                documentId: state.documentId,
                documentURL: state.documentURL,
                width: state.viewportWidth,
                height: state.viewportHeight,
                dpr: state.devicePixelRatio,
                scrollX: state.scrollX,
                scrollY: state.scrollY,
              },
            },
          ];
        }),
      },
    });

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetScrollState') {
          const state = probeQueue.shift() || currentState;
          return [
            {
              documentId: state.documentId,
              result: {
                scrollX: state.scrollX,
                scrollY: state.scrollY,
                viewportWidth: state.viewportWidth,
                viewportHeight: state.viewportHeight,
                documentURL: state.documentURL,
              },
            },
          ] as any;
        }
        return [{ result: true }] as any;
      },
    );

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(
      async (_tabId: number, _caller: string, fn: any) => fn({}),
    );
    baseSendCommand = async (_tabId: number, method: string, params: any) => {
      if (method === 'Runtime.evaluate') {
        if (String(params?.expression || '').includes('devicePixelRatio')) {
          return {
            result: {
              value: (probeQueue[0] || currentState).devicePixelRatio,
            },
          };
        }
        return { result: { value: true } };
      }
      if (method === 'Page.getLayoutMetrics') {
        const state = probeQueue[0] || currentState;
        return {
          cssVisualViewport: {
            clientWidth: state.viewportWidth,
            clientHeight: state.viewportHeight,
            pageX: state.scrollX,
            pageY: state.scrollY,
          },
        };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: VALID_PNG.split(',')[1], mimeType: 'image/png' };
      }
      if (method === 'Input.dispatchMouseEvent') {
        dispatchedEvents.push({ method, params });
      }
      return {};
    };
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(baseSendCommand);

    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined);
    vi.spyOn(screenshotTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: tabId,
      windowId: 1,
      active: true,
      url: 'https://example.com/page',
    });
    vi.spyOn(screenshotTool as any, 'tryGetTab').mockResolvedValue({
      id: tabId,
      windowId: 1,
      active: true,
      url: 'https://example.com/page',
    });
    vi.spyOn(screenshotTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(screenshotTool as any, 'sendMessageToTab').mockResolvedValue({ success: true });
    vi.spyOn(computerTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: tabId,
      windowId: 1,
      active: true,
      url: 'https://example.com/page',
    });
  });

  afterEach(() => {
    screenshotContextManager.clear(tabId);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function captureScreenshot() {
    probeQueue = [{ ...baseState }, { ...baseState }];
    return screenshotTool.execute({ tabId, format: 'png' });
  }

  it('keeps viewport helper fallback free of scrollbar preparation mutations', async () => {
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (id, method, params) => {
      if (method === 'Page.captureScreenshot') throw new Error('Compositor unavailable');
      return baseSendCommand(id, method, params);
    });
    vi.spyOn(screenshotTool as any, 'injectScreenshotHelper').mockResolvedValue(undefined);
    vi.spyOn(screenshotTool as any, 'captureTabPngWithRetry').mockResolvedValue(VALID_PNG);
    const helper = vi
      .spyOn(screenshotTool as any, 'sendToHelperWithRetry')
      .mockImplementation(async (_id: number, message: any) => {
        if (message.action === 'preparePageForCapture') {
          const style = document.createElement('style');
          style.textContent = 'html { scrollbar-width: none; }';
          document.head.append(style);
        }
        if (message.action === 'getPageDetails')
          return {
            totalWidth: 1000,
            totalHeight: 2000,
            viewportWidth: 1000,
            viewportHeight: 800,
            devicePixelRatio: 2,
            currentScrollX: 12,
            currentScrollY: 34,
          };
        return { success: true };
      });
    const result = await captureScreenshot();
    expect(result.isError).toBeFalsy();
    expect(
      helper.mock.calls.some(([, message]) => message.action === 'preparePageForCapture'),
    ).toBe(false);
    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.captureId).toMatch(/^cap_/);
    expect(payload.coordinateValidation.supported).toBe(true);
  });

  it('returns captureId, capture time, documentId, and viewport identity', async () => {
    const result = await captureScreenshot();
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.captureId).toMatch(/^cap_/);
    expect(payload.capturedAt).toEqual(expect.any(Number));
    expect(payload.documentId).toBe(baseState.documentId);
    expect(payload.viewport).toEqual({
      width: baseState.viewportWidth,
      height: baseState.viewportHeight,
      dpr: baseState.devicePixelRatio,
      scrollX: baseState.scrollX,
      scrollY: baseState.scrollY,
    });
    expect(payload.coordinateValidation).toEqual({
      supported: true,
      boundary: SCREENSHOT_CAPTURE_VALIDATION_BOUNDARY,
    });
  });

  it.each([
    ['document', { documentId: 'doc-replaced' }, /document changed/i],
    ['viewport', { viewportWidth: 1024 }, /viewport changed/i],
    ['scroll position', { scrollY: 35 }, /page scrolled/i],
  ])('fails when the %s changes during capture', async (_label, patch, message) => {
    probeQueue = [{ ...baseState }, { ...baseState, ...patch }];

    const result = await screenshotTool.execute({ tabId, format: 'png' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(message);
  });

  it('fails when DOM changes during capture on the same document and viewport', async () => {
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
      async (tabId: number, method: string, params: any) => {
        if (method === 'Page.captureScreenshot') {
          document.body.innerHTML = '<button id="replacement">Replacement</button>';
          await Promise.resolve();
        }
        return baseSendCommand(tabId, method, params);
      },
    );

    const result = await captureScreenshot();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/DOM changed during screenshot capture/i);
  });

  it('validates captureId before click dispatch and marks only validated coordinates', async () => {
    const capture = await captureScreenshot();
    const capturePayload = JSON.parse(capture.content[0].text as string);
    const { captureId } = capturePayload;
    dispatchedEvents = [];

    const result = await computerTool.execute({
      action: 'left_click',
      captureId,
      coordinates: { x: 100, y: 100 },
      tabId,
      autoSnap: false,
      dwellMs: 0,
    } as any);

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text as string);
    expect(payload.captureValidated).toBe(true);
    expect(payload.captureId).toBe(captureId);
    expect(payload.captureValidationBoundary).toBe(SCREENSHOT_CAPTURE_VALIDATION_BOUNDARY);
    const press = dispatchedEvents.find(
      (event) =>
        event.method === 'Input.dispatchMouseEvent' && event.params?.type === 'mousePressed',
    );
    expect(press?.params).toMatchObject({ x: 100, y: 100 });
  });

  it('rejects stale document, viewport, dpr, or scroll before click dispatch', async () => {
    const capture = await captureScreenshot();
    const { captureId } = JSON.parse(capture.content[0].text as string);
    const invalidStates = [
      { ...baseState, documentId: 'doc-replaced' },
      { ...baseState, viewportWidth: 1024 },
      { ...baseState, devicePixelRatio: 2.001 },
      { ...baseState, scrollY: 35 },
    ];

    for (const state of invalidStates) {
      currentState = state;
      dispatchedEvents = [];
      const result = await computerTool.execute({
        action: 'left_click',
        captureId,
        coordinateSpace: 'screenshot',
        coordinates: { x: 100, y: 100 },
        tabId,
        autoSnap: false,
      } as any);

      expect(result.isError).toBe(true);
      expect(dispatchedEvents.some((event) => event.params?.type === 'mousePressed')).toBe(false);
    }
  });

  it('rejects an invalid captureId before drag press dispatch', async () => {
    const capture = await captureScreenshot();
    const { captureId } = JSON.parse(capture.content[0].text as string);
    currentState = { ...baseState, scrollY: 99 };
    dispatchedEvents = [];

    const result = await computerTool.execute({
      action: 'left_click_drag',
      captureId,
      startCoordinates: { x: 100, y: 100 },
      coordinates: { x: 200, y: 200 },
      tabId,
      autoSnap: false,
    } as any);

    expect(result.isError).toBe(true);
    expect(dispatchedEvents.some((event) => event.params?.type === 'mousePressed')).toBe(false);
  });

  it('rejects screenshot-space coordinates without captureId instead of using the latest context', async () => {
    await captureScreenshot();
    currentState = { ...baseState, scrollY: 99 };
    dispatchedEvents = [];

    const result = await computerTool.execute({
      action: 'left_click',
      coordinateSpace: 'screenshot',
      coordinates: { x: 100, y: 100 },
      tabId,
      autoSnap: false,
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/captureId|fresh screenshot/i);
    expect(dispatchedEvents.some((event) => event.params?.type === 'mousePressed')).toBe(false);
  });

  it('invalidates the previous captureId when a new screenshot replaces its scaling context', async () => {
    const first = await captureScreenshot();
    const firstId = JSON.parse(first.content[0].text as string).captureId;
    const second = await captureScreenshot();
    const secondId = JSON.parse(second.content[0].text as string).captureId;
    expect(secondId).not.toBe(firstId);
    currentState = { ...baseState };
    dispatchedEvents = [];

    const result = await computerTool.execute({
      action: 'left_click',
      captureId: firstId,
      coordinates: { x: 100, y: 100 },
      tabId,
      autoSnap: false,
    } as any);

    expect(result.isError).toBe(true);
    expect(dispatchedEvents.some((event) => event.params?.type === 'mousePressed')).toBe(false);
  });

  it('rejects captureId when the same document replaces DOM after capture', async () => {
    const capture = await captureScreenshot();
    const { captureId } = JSON.parse(capture.content[0].text as string);
    document.body.innerHTML = '<button id="replacement">Replacement</button>';
    await Promise.resolve();
    dispatchedEvents = [];

    const result = await computerTool.execute({
      action: 'left_click',
      captureId,
      coordinates: { x: 100, y: 100 },
      tabId,
      autoSnap: false,
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/DOM changed since screenshot capture/i);
    expect(dispatchedEvents.some((event) => event.params?.type === 'mousePressed')).toBe(false);
  });

  it('rejects coordinate validation for captures without a deterministic screenshot space', () => {
    const state: ScreenshotPageState = {
      documentId: 'doc-crop',
      documentURL: 'https://example.com/page',
      width: 1000,
      height: 800,
      dpr: 2,
      scrollX: 0,
      scrollY: 0,
    };
    clearScreenshotValidity(tabId);
    const capture = createScreenshotCapture({
      tabId,
      state,
      contextTimestamp: 88,
      domRevision: 1,
      coordinateValidationSupported: false,
      unsupportedReason: 'Coordinate validation is unavailable for cropped screenshots',
    });

    expect(validateScreenshotCapture(capture.captureId, tabId, state, 88, 1)).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/cropped screenshots/i),
    });
  });

  it('marks cropped screenshot captureIds unsupported and refuses coordinate dispatch', async () => {
    probeQueue = [{ ...baseState }, { ...baseState }];
    const capture = await screenshotTool.execute({
      tabId,
      format: 'png',
      region: { x0: 10, y0: 20, x1: 110, y1: 120 },
    });
    const payload = JSON.parse(capture.content[0].text as string);

    expect(payload.coordinateValidation).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/cropped screenshots/i),
    });
    dispatchedEvents = [];
    const result = await computerTool.execute({
      action: 'left_click',
      captureId: payload.captureId,
      coordinates: { x: 50, y: 50 },
      tabId,
      autoSnap: false,
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cropped screenshots/i);
    expect(dispatchedEvents.some((event) => event.params?.type === 'mousePressed')).toBe(false);
  });

  it('invalidates captureId when a real style text change can move the target', async () => {
    const style = document.createElement('style');
    style.dataset.testScreenshotValidity = 'true';
    style.textContent = 'button { color: black; }';
    document.head.appendChild(style);
    await Promise.resolve();
    const before = inPageReadScreenshotState();
    const capture = createScreenshotCapture({
      tabId,
      state: before,
      contextTimestamp: 101,
      domRevision: before.domRevision,
      coordinateValidationSupported: true,
    });

    style.textContent = 'button { color: black; position: relative; top: 24px; }';
    await Promise.resolve();
    const after = inPageReadScreenshotState();

    expect(after.domRevision).toBeGreaterThan(before.domRevision);
    expect(
      validateScreenshotCapture(capture.captureId, tabId, after, 101, after.domRevision),
    ).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/DOM changed since screenshot capture/i),
    });
  });

  it('invalidates captureId when a real stylesheet link attribute changes', async () => {
    const link = document.createElement('link');
    link.dataset.testScreenshotValidity = 'true';
    link.rel = 'stylesheet';
    link.href = 'data:text/css,button%7Bcolor%3Ablack%7D';
    document.head.appendChild(link);
    await Promise.resolve();
    const before = inPageReadScreenshotState();
    const capture = createScreenshotCapture({
      tabId,
      state: before,
      contextTimestamp: 102,
      domRevision: before.domRevision,
      coordinateValidationSupported: true,
    });

    link.href = 'data:text/css,button%7Bmargin-left%3A32px%7D';
    await Promise.resolve();
    const after = inPageReadScreenshotState();

    expect(after.domRevision).toBeGreaterThan(before.domRevision);
    expect(
      validateScreenshotCapture(capture.captureId, tabId, after, 102, after.domRevision),
    ).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/DOM changed since screenshot capture/i),
    });
  });

  it('ignores only explicitly marked BrowserPaw favicon and overlay noise', async () => {
    const before = inPageReadScreenshotState();
    const favicon = document.createElement('link');
    favicon.dataset.testScreenshotValidity = 'true';
    favicon.rel = 'icon';
    favicon.setAttribute('data-browserpaw-injected', 'true');
    document.head.appendChild(favicon);
    const overlay = document.createElement('div');
    overlay.dataset.testScreenshotValidity = 'true';
    overlay.id = 'codex-agent-overlay-root';
    overlay.dataset.browserpawAgentOverlayRoot = 'true';
    document.documentElement.appendChild(overlay);
    await Promise.resolve();
    const after = inPageReadScreenshotState();

    expect(after.domRevision).toBe(before.domRevision);
  });

  it('counts text changes on a ref-marked real button', async () => {
    const button = document.createElement('button');
    button.setAttribute('data-browserpaw-ref-abc', '1');
    button.textContent = 'Before';
    document.body.appendChild(button);
    await Promise.resolve();
    const before = inPageReadScreenshotState();

    button.textContent = 'After';
    await Promise.resolve();
    const after = inPageReadScreenshotState();

    expect(after.domRevision).toBeGreaterThan(before.domRevision);
  });

  it('counts disabled/class/style changes on a ref-marked real button', async () => {
    const button = document.createElement('button');
    button.setAttribute('data-browserpaw-ref-abc', '1');
    document.body.appendChild(button);
    await Promise.resolve();
    const before = inPageReadScreenshotState();

    button.disabled = true;
    button.className = 'changed';
    button.style.color = 'red';
    await Promise.resolve();
    const after = inPageReadScreenshotState();

    expect(after.domRevision).toBeGreaterThan(before.domRevision);
  });

  it('counts childList changes inside a scroll-target-marked real container', async () => {
    const container = document.createElement('div');
    container.setAttribute('data-browserpaw-scroll-target', '1');
    document.body.appendChild(container);
    await Promise.resolve();
    const before = inPageReadScreenshotState();

    container.appendChild(document.createElement('span'));
    await Promise.resolve();
    const after = inPageReadScreenshotState();

    expect(after.domRevision).toBeGreaterThan(before.domRevision);
  });

  it.each(['data-browserpaw-ref-abc', 'data-browserpaw-scroll-target'])(
    'ignores updates to the BrowserPaw marker attribute itself: %s',
    async (attributeName) => {
      const button = document.createElement('button');
      button.setAttribute(attributeName, '1');
      document.body.appendChild(button);
      await Promise.resolve();
      const before = inPageReadScreenshotState();

      button.setAttribute(attributeName, '2');
      await Promise.resolve();
      const after = inPageReadScreenshotState();

      expect(after.domRevision).toBe(before.domRevision);
    },
  );

  it('runs the serialized injection without module closures and observes page mutations', () => {
    const injectedProbe = new Function(`return (${inPageReadScreenshotState.toString()})();`);
    const before = injectedProbe();
    expect(before.observerInitializedNow).toBe(true);
    document.getElementById('original')!.setAttribute('disabled', '');
    const after = injectedProbe();
    expect(after.documentId).toBe(before.documentId);
    expect(after.observerInitializedNow).toBe(false);
    expect(after.domRevision).toBeGreaterThan(before.domRevision);
  });

  it('validates real document and scroll state without executeInPage mocks', () => {
    const originalScrollX = Object.getOwnPropertyDescriptor(window, 'scrollX');
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const setScroll = (x: number, y: number) => {
      Object.defineProperty(window, 'scrollX', { configurable: true, value: x });
      Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
    };
    const readState = (): ScreenshotPageState => {
      return inPageReadScreenshotState();
    };

    try {
      setScroll(18, 42);
      const before = readState();
      const capture = createScreenshotCapture({
        tabId,
        state: before,
        contextTimestamp: 77,
        domRevision: before.domRevision,
        coordinateValidationSupported: true,
      });
      const unchanged = readState();

      expect(
        validateScreenshotCapture(capture.captureId, tabId, unchanged, 77, unchanged.domRevision)
          .valid,
      ).toBe(true);
      expect(() => assertScreenshotCaptureStable(before, unchanged)).not.toThrow();

      setScroll(18, 42.2);
      const withinTolerance = readState();
      expect(() => assertScreenshotCaptureStable(before, withinTolerance)).not.toThrow();

      setScroll(18, 42.49);
      const subpixelScroll = readState();
      expect(() => assertScreenshotCaptureStable(before, subpixelScroll)).toThrow(/page scrolled/i);
      expect(
        validateScreenshotCapture(
          capture.captureId,
          tabId,
          subpixelScroll,
          77,
          subpixelScroll.domRevision,
        ),
      ).toMatchObject({
        valid: false,
        reason: expect.stringMatching(/scroll changed/i),
      });

      setScroll(18, 42);
      delete (document as any)._browserpaw_doc_id;
      const replaced = readState();
      expect(() => assertScreenshotCaptureStable(before, replaced)).toThrow(/document changed/i);
    } finally {
      if (originalScrollX) Object.defineProperty(window, 'scrollX', originalScrollX);
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY);
    }
  });

  it('invalidates captureId on a real DOM mutation with unchanged page geometry', async () => {
    const before = inPageReadScreenshotState();
    const capture = createScreenshotCapture({
      tabId,
      state: before,
      contextTimestamp: 99,
      domRevision: before.domRevision,
      coordinateValidationSupported: true,
    });

    document.body.innerHTML = '<button id="replacement">Replacement</button>';
    await Promise.resolve();
    const after = inPageReadScreenshotState();

    expect(after.domRevision).toBeGreaterThan(before.domRevision);
    expect(
      validateScreenshotCapture(capture.captureId, tabId, after, 99, after.domRevision),
    ).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/DOM changed since screenshot capture/i),
    });
  });
});
