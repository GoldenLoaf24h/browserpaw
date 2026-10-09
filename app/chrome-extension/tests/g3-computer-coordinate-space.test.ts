import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computerTool } from '../entrypoints/background/tools/browser/computer';
import { screenshotContextManager } from '../utils/screenshot-context';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

describe('G3 Computer Coordinate Space & FullPage Alignment', () => {
  const testTabId = 9988;
  let dispatchedEvents: Array<{ method: string; params: any }> = [];
  let currentScrollX = 0;
  let currentScrollY = 0;

  beforeEach(() => {
    screenshotContextManager.clear(testTabId);
    vi.restoreAllMocks();
    dispatchedEvents = [];
    currentScrollX = 0;
    currentScrollY = 0;

    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({
          id,
          windowId: 1,
          url: 'https://example.com/page',
          active: true,
        })),
        query: vi.fn(async () => [{ id: testTabId, windowId: 1, url: 'https://example.com/page', active: true }]),
      },
    };

    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId: number, method: string, params: any) => {
      dispatchedEvents.push({ method, params });
      return {};
    });

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId: number, _caller: string, fn: any) => {
      const mockSession = {
        send: vi.fn(async (method: string, params: any) => {
          dispatchedEvents.push({ method, params });
          return {};
        }),
      };
      return fn(mockSession);
    });

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target: any, method: string, args?: any[]) => {
      if (method === 'inPageGetScrollState') {
        return [{
          result: {
            scrollX: currentScrollX,
            scrollY: currentScrollY,
            viewportWidth: 1000,
            viewportHeight: 800,
            docWidth: 1000,
            docHeight: 2500,
          }
        }] as any;
      }
      if (method === 'inPageInstantScrollTo') {
        currentScrollX = args?.[0] ?? 0;
        currentScrollY = args?.[1] ?? 0;
        return [{ result: { success: true, scrollX: currentScrollX, scrollY: currentScrollY } }] as any;
      }
      return [{ result: true }] as any;
    });
  });

  it('fails closed when coordinateSpace is screenshot but screenshot context is missing or expired', async () => {
    const result = await computerTool.execute({
      action: 'left_click',
      coordinateSpace: 'screenshot',
      coordinates: { x: 250, y: 875 },
      tabId: testTabId,
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/screenshot context.*(expired|not found|missing)/i);
  });

  it('accurately projects fullpage screenshot coordinates to document space and brings into viewport via scrolling', async () => {
    // SC07 scenario: fullPage capture at 500x1250, document dimensions 1000x2500
    // Point (250, 875) in screenshot space -> (500, 1750) in document space.
    // Viewport is 1000x800. Initial scroll is at (0, 0).
    screenshotContextManager.setContext(testTabId, {
      screenshotWidth: 500,
      screenshotHeight: 1250,
      viewportWidth: 1000,
      viewportHeight: 800,
      captureMode: 'fullpage',
      docWidth: 1000,
      docHeight: 2500,
      hostname: 'example.com',
    });

    const result = await computerTool.execute({
      action: 'left_click',
      coordinateSpace: 'screenshot',
      coordinates: { x: 250, y: 875 },
      tabId: testTabId,
    } as any);

    expect(result.isError).toBe(false);
    // Target docY = 1750. Centering in 800vh -> scrollY = 1750 - 400 = 1350.
    // Dispatched click Y = 1750 - 1350 = 400. Dispatched X = 500.
    const mousePress = dispatchedEvents.find(e => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed');
    expect(mousePress).toBeDefined();
    expect(mousePress?.params?.x).toBe(500);
    expect(mousePress?.params?.y).toBe(400);
  });

  it('defaults to viewport space and leaves CSS viewport coordinates unmodified', async () => {
    // Even if a fullpage context exists in cache, default coordinateSpace: viewport ignores it
    screenshotContextManager.setContext(testTabId, {
      screenshotWidth: 500,
      screenshotHeight: 1250,
      viewportWidth: 1000,
      viewportHeight: 800,
      captureMode: 'fullpage',
      docWidth: 1000,
      docHeight: 2500,
      hostname: 'example.com',
    });

    const result = await computerTool.execute({
      action: 'left_click',
      coordinates: { x: 300, y: 200 },
      tabId: testTabId,
    } as any);

    expect(result.isError).toBe(false);
    const mousePress = dispatchedEvents.find(e => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed');
    expect(mousePress?.params?.x).toBe(300);
    expect(mousePress?.params?.y).toBe(200);
  });

  it('correctly handles polymorphic coordinate representations: array point and bounding box', async () => {
    screenshotContextManager.setContext(testTabId, {
      screenshotWidth: 500,
      screenshotHeight: 1250,
      viewportWidth: 1000,
      viewportHeight: 800,
      captureMode: 'fullpage',
      docWidth: 1000,
      docHeight: 2500,
      hostname: 'example.com',
    });

    // Array point [x, y] in screenshot space
    const pointResult = await computerTool.execute({
      action: 'left_click',
      coordinateSpace: 'screenshot',
      coordinates: [250, 875],
      tabId: testTabId,
    } as any);
    expect(pointResult.isError).toBe(false);

    // Bounding box [ymin, xmin, ymax, xmax] in screenshot space
    // Center: ((870+880)/2, (240+260)/2) = (875, 250) -> x=250, y=875
    dispatchedEvents = [];
    const boxResult = await computerTool.execute({
      action: 'left_click',
      coordinateSpace: 'screenshot',
      coordinates: [870, 240, 880, 260],
      tabId: testTabId,
    } as any);
    expect(boxResult.isError).toBe(false);
    const boxPress = dispatchedEvents.find(e => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed');
    expect(boxPress?.params?.x).toBe(500);
    expect(boxPress?.params?.y).toBe(400);
  });

  it('correctly scales ROI crop coordinates without double scaling', async () => {
    // ROI crop: captured image is 400x300, representing cropWidth: 400, cropHeight: 300 at origin (200, 150)
    screenshotContextManager.setContext(testTabId, {
      screenshotWidth: 400,
      screenshotHeight: 300,
      viewportWidth: 1280,
      viewportHeight: 800,
      cropWidth: 400,
      cropHeight: 300,
      originX: 200,
      originY: 150,
      captureMode: 'element',
      hostname: 'example.com',
    });

    // Center of crop image (200, 150) -> viewport position should be 200 + 200 = 400, 150 + 150 = 300
    const result = await computerTool.execute({
      action: 'left_click',
      coordinateSpace: 'screenshot',
      coordinates: { x: 200, y: 150 },
      tabId: testTabId,
    } as any);

    expect(result.isError).toBe(false);
    const mousePress = dispatchedEvents.find(e => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed');
    expect(mousePress?.params?.x).toBe(400);
    expect(mousePress?.params?.y).toBe(300);
  });

  it('supports drag with single unified scroll alignment and fails closed on excessive distance', async () => {
    screenshotContextManager.setContext(testTabId, {
      screenshotWidth: 500,
      screenshotHeight: 1250,
      viewportWidth: 1000,
      viewportHeight: 800,
      captureMode: 'fullpage',
      docWidth: 1000,
      docHeight: 2500,
      hostname: 'example.com',
    });

    // Valid drag within viewport distance
    const dragRes = await computerTool.execute({
      action: 'left_click_drag',
      coordinateSpace: 'screenshot',
      startCoordinates: { x: 250, y: 800 }, // doc (500, 1600)
      coordinates: { x: 250, y: 900 },      // doc (500, 1800) -> dy = 200, fits in 800 vh
      tabId: testTabId,
    } as any);
    expect(dragRes.isError).toBe(false);

    // Excessive drag exceeding viewport bounds -> fail closed
    const excessiveDragRes = await computerTool.execute({
      action: 'left_click_drag',
      coordinateSpace: 'screenshot',
      startCoordinates: { x: 250, y: 100 },  // doc (500, 200)
      coordinates: { x: 250, y: 1100 },      // doc (500, 2200) -> dy = 2000 > 800 vh
      tabId: testTabId,
    } as any);
    expect(excessiveDragRes.isError).toBe(true);
    expect(excessiveDragRes.content[0].text).toMatch(/cannot fit simultaneously within viewport/i);
  });

  it('fails closed when screenshot origin hostname mismatches tab url', async () => {
    screenshotContextManager.setContext(testTabId, {
      screenshotWidth: 500,
      screenshotHeight: 1250,
      viewportWidth: 1000,
      viewportHeight: 800,
      captureMode: 'viewport',
      hostname: 'malicious.com',
    });

    const result = await computerTool.execute({
      action: 'left_click',
      coordinateSpace: 'screenshot',
      coordinates: { x: 250, y: 300 },
      tabId: testTabId,
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/domain changed|origin|hostname/i);
  });
});

