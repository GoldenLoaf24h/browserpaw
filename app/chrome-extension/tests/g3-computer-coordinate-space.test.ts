import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computerTool } from '../entrypoints/background/tools/browser/computer';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
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
        query: vi.fn(async () => [
          { id: testTabId, windowId: 1, url: 'https://example.com/page', active: true },
        ]),
      },
    };

    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId: number, method: string, params: any) => {
        dispatchedEvents.push({ method, params });
        return {};
      },
    );

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(
      async (_tabId: number, _caller: string, fn: any) => {
        const mockSession = {
          send: vi.fn(async (method: string, params: any) => {
            dispatchedEvents.push({ method, params });
            return {};
          }),
        };
        return fn(mockSession);
      },
    );

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, method: string, args?: any[]) => {
        if (method === 'inPageGetScrollState') {
          return [
            {
              result: {
                scrollX: currentScrollX,
                scrollY: currentScrollY,
                viewportWidth: 1000,
                viewportHeight: 800,
                docWidth: 1000,
                docHeight: 2500,
              },
            },
          ] as any;
        }
        if (method === 'inPageInstantScrollTo') {
          currentScrollX = args?.[0] ?? 0;
          currentScrollY = args?.[1] ?? 0;
          return [
            { result: { success: true, scrollX: currentScrollX, scrollY: currentScrollY } },
          ] as any;
        }
        return [{ result: true }] as any;
      },
    );
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
    const mousePress = dispatchedEvents.find(
      (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
    );
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
    const mousePress = dispatchedEvents.find(
      (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
    );
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
    const boxPress = dispatchedEvents.find(
      (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
    );
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
    const mousePress = dispatchedEvents.find(
      (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
    );
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
      coordinates: { x: 250, y: 900 }, // doc (500, 1800) -> dy = 200, fits in 800 vh
      tabId: testTabId,
    } as any);
    expect(dragRes.isError).toBe(false);

    // Excessive drag exceeding viewport bounds -> fail closed
    const excessiveDragRes = await computerTool.execute({
      action: 'left_click_drag',
      coordinateSpace: 'screenshot',
      startCoordinates: { x: 250, y: 100 }, // doc (500, 200)
      coordinates: { x: 250, y: 1100 }, // doc (500, 2200) -> dy = 2000 > 800 vh
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
  describe('S05: interact-index coordinateSpace support', () => {
    beforeEach(() => {
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (_target: any, method: string, args?: any[]) => {
          if (method === 'inPageGetScrollState') {
            return [
              {
                result: {
                  scrollX: currentScrollX,
                  scrollY: currentScrollY,
                  viewportWidth: 1600,
                  viewportHeight: 900,
                  docWidth: 1600,
                  docHeight: 2500,
                },
              },
            ] as any;
          }
          if (method === 'inPageInstantScrollTo') {
            currentScrollX = args?.[0] ?? 0;
            currentScrollY = args?.[1] ?? 0;
            return [
              { result: { success: true, scrollX: currentScrollX, scrollY: currentScrollY } },
            ] as any;
          }
          return [{ result: true }] as any;
        },
      );
    });

    it('fails closed when coordinateSpace is screenshot but screenshot context is missing or expired', async () => {
      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'click',
        coordinateSpace: 'screenshot',
        coordinate: { x: 500, y: 400 },
        tabId: testTabId,
        autoSnap: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/screenshot context expired or not found/i);
      expect(dispatchedEvents.some((e) => e.params?.type === 'mousePressed')).toBe(false);
    });

    it('scales downsampled screenshot coordinates accurately to viewport without double scaling', async () => {
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 1280,
        screenshotHeight: 720,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        hostname: 'example.com',
      });

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'click',
        coordinateSpace: 'screenshot',
        coordinate: { x: 1136, y: 400 },
        tabId: testTabId,
        autoSnap: false,
      });

      expect(result.isError).toBe(false);
      const pressEvent = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params.type === 'mousePressed',
      );
      expect(pressEvent).toBeDefined();
      expect(pressEvent?.params.x).toBe(1420);
      expect(pressEvent?.params.y).toBe(500);
    });

    it('supports polymorphic coordinate shapes in screenshot space (point array, bbox)', async () => {
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 1280,
        screenshotHeight: 720,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        hostname: 'example.com',
      });

      // Point array [1136, 400]
      dispatchedEvents = [];
      const arrayResult = await interactIndexTool.execute({
        action: 'click',
        coordinateSpace: 'screenshot',
        coordinate: [1136, 400],
        tabId: testTabId,
        autoSnap: false,
      });
      expect(arrayResult.isError).toBe(false);
      const press1 = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params.type === 'mousePressed',
      );
      expect(press1?.params.x).toBe(1420);
      expect(press1?.params.y).toBe(500);

      // Bounding box [ymin, xmin, ymax, xmax] -> center (1136, 400)
      dispatchedEvents = [];
      const bboxResult = await interactIndexTool.execute({
        action: 'click',
        coordinateSpace: 'screenshot',
        coordinate: [390, 1130, 410, 1142],
        tabId: testTabId,
        autoSnap: false,
      });
      expect(bboxResult.isError).toBe(false);
      const press2 = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params.type === 'mousePressed',
      );
      expect(press2?.params.x).toBe(1420);
      expect(press2?.params.y).toBe(500);
    });

    it('scales explicit screenshot normalized coordinate (fraction 0.5, 0.5 -> 800, 450) without double scaling', async () => {
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 1280,
        screenshotHeight: 720,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        hostname: 'example.com',
      });

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'click',
        coordinateSpace: 'screenshot',
        coordinate: { x: 0.5, y: 0.5 },
        tabId: testTabId,
        autoSnap: false,
      });

      expect(result.isError).toBe(false);
      const pressEvent = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params.type === 'mousePressed',
      );
      expect(pressEvent).toBeDefined();
      expect(pressEvent?.params.x).toBe(800);
      expect(pressEvent?.params.y).toBe(450);
    });

    it('preserves default viewport normalized coordinate resolution (fraction 0.5, 0.5 -> 800, 450) with 1600x900 context', async () => {
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 1280,
        screenshotHeight: 720,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        hostname: 'example.com',
      });

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'click',
        // default coordinateSpace (viewport)
        coordinate: { x: 0.5, y: 0.5 },
        tabId: testTabId,
        autoSnap: false,
      });

      expect(result.isError).toBe(false);
      const pressEvent = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params.type === 'mousePressed',
      );
      expect(pressEvent).toBeDefined();
      expect(pressEvent?.params.x).toBe(800);
      expect(pressEvent?.params.y).toBe(450);
    });

    it.each([
      {
        label: 'default object',
        coordinate: { x: 1170, y: 330 },
        coordinateSpace: undefined,
        captureMode: 'viewport' as const,
      },
      {
        label: 'explicit array',
        coordinate: [1170, 330],
        coordinateSpace: 'viewport' as const,
        captureMode: 'viewport' as const,
      },
      {
        label: 'cropped cache',
        coordinate: { x: 1170, y: 330 },
        coordinateSpace: 'viewport' as const,
        captureMode: 'element' as const,
      },
      {
        label: 'fullpage cache',
        coordinate: { x: 1170, y: 330 },
        coordinateSpace: 'viewport' as const,
        captureMode: 'fullpage' as const,
      },
    ])(
      'keeps CSS viewport coordinates unchanged with $label and a scrolled screenshot cache',
      async ({ coordinate, coordinateSpace, captureMode }) => {
        currentScrollY = 600;
        screenshotContextManager.setContext(testTabId, {
          screenshotWidth: 640,
          screenshotHeight: 360,
          viewportWidth: 1600,
          viewportHeight: 900,
          captureMode,
          originX: captureMode === 'element' ? 100 : 0,
          originY: captureMode === 'element' ? 200 : 0,
          cropWidth: captureMode === 'element' ? 800 : undefined,
          cropHeight: captureMode === 'element' ? 450 : undefined,
          scrollX: 0,
          scrollY: 0,
          docWidth: 1600,
          docHeight: 2500,
          hostname: 'example.com',
        });
        const result = await interactIndexTool.execute({
          action: 'click',
          coordinate,
          coordinateSpace,
          tabId: testTabId,
          autoSnap: false,
        });
        expect(result.isError).toBe(false);
        const press = dispatchedEvents.find(
          (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
        );
        expect(press?.params.x).toBe(1170);
        expect(press?.params.y).toBe(330);
        expect(currentScrollY).toBe(600);
      },
    );

    it('S05-drag-1: preserves unscaled viewport drag endpoints despite cached downsampled screenshot', async () => {
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 640,
        screenshotHeight: 360,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        hostname: 'example.com',
      });

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'drag',
        coordinateSpace: 'viewport',
        coordinate: { x: 100, y: 100 },
        end: { coordinate: { x: 500, y: 400 } },
        tabId: testTabId,
        autoSnap: false,
        steps: 2,
      });

      expect(result.isError).toBe(false);
      const press = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
      );
      const release = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mouseReleased',
      );
      expect(press?.params.x).toBe(100);
      expect(press?.params.y).toBe(100);
      expect(release?.params.x).toBe(500);
      expect(release?.params.y).toBe(400);
    });

    it('S05-drag-6: compensates for scroll shift when viewport screenshot space drag runs after page scrolled', async () => {
      currentScrollX = 0;
      currentScrollY = 300;
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 1600,
        screenshotHeight: 900,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        scrollX: 0,
        scrollY: 100,
        hostname: 'example.com',
      });

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'drag',
        coordinateSpace: 'screenshot',
        coordinate: { x: 200, y: 200 },
        end: { coordinate: { x: 200, y: 400 } },
        tabId: testTabId,
        autoSnap: false,
        steps: 2,
      });

      expect(result.isError).toBe(false);
      const press = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
      );
      const release = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mouseReleased',
      );
      expect(press).toBeDefined();
      expect(release).toBeDefined();
      expect(press!.params.y + currentScrollY).toBe(300);
      expect(release!.params.y + currentScrollY).toBe(500);
      expect(press?.params.y).toBe(0);
      expect(release?.params.y).toBe(200);
    });

    it('S05-drag-7: resolves end.index in current viewport scroll without applying capture-time scroll', async () => {
      currentScrollX = 0;
      currentScrollY = 400;
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 1600,
        screenshotHeight: 900,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        scrollX: 0,
        scrollY: 100,
        hostname: 'example.com',
      });

      const originalExecute = inPageEngine.executeInPage;
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (target: any, method: string, args?: any[]) => {
          if (method === 'inPageGetElementCoordinates' && args?.[0] === 99) {
            currentScrollY = 600;
            return [{ result: { success: true, x: 200, y: 150, tagName: 'button' } }] as any;
          }
          return originalExecute(target, method, args);
        },
      );

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'drag',
        coordinateSpace: 'screenshot',
        coordinate: { x: 200, y: 350 },
        end: { index: 99 },
        tabId: testTabId,
        autoSnap: false,
        steps: 2,
      });

      expect(result.isError).toBe(false);
      const press = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
      );
      const release = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mouseReleased',
      );
      expect(press).toBeDefined();
      expect(release).toBeDefined();
      expect(press!.params.y + currentScrollY).toBe(450);
      expect(release!.params.y + currentScrollY).toBe(750);
    });

    it('S05-drag-8: compensates subframe offset for indexed drag start before joint scroll alignment without double offset', async () => {
      currentScrollX = 0;
      currentScrollY = 0;

      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (target: any, method: string, args?: any[]) => {
          if (method === 'inPageGetScrollState') {
            return [
              {
                result: {
                  scrollX: currentScrollX,
                  scrollY: currentScrollY,
                  viewportWidth: 1600,
                  viewportHeight: 900,
                  docWidth: 1600,
                  docHeight: 2500,
                },
              },
            ] as any;
          }
          if (method === 'inPageInstantScrollTo') {
            currentScrollX = args?.[0] ?? 0;
            currentScrollY = args?.[1] ?? 0;
            return [
              { result: { success: true, scrollX: currentScrollX, scrollY: currentScrollY } },
            ] as any;
          }
          if (method === 'inPageGetElementCoordinates' && args?.[0] === 12) {
            if (target.allFrames) {
              return [
                { frameId: 101, result: { success: true, x: 30, y: 40, tagName: 'div' } },
              ] as any;
            }
            return [{ result: { success: false } }] as any;
          }
          return [{ result: true }] as any;
        },
      );

      (globalThis as any).chrome.scripting = {
        executeScript: vi.fn(async ({ target }: any) => [
          {
            result: target.frameIds ? undefined : { offsetX: 100, offsetY: 200 },
          },
        ]),
      };

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'drag',
        index: 12,
        end: { coordinate: { x: 300, y: 350 } },
        tabId: testTabId,
        autoSnap: false,
        steps: 2,
      });

      expect(result.isError).toBe(false);
      const press = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
      );
      const release = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mouseReleased',
      );
      expect(press?.params.x).toBe(130);
      expect(press?.params.y).toBe(240);
      expect(release?.params.x).toBe(300);
      expect(release?.params.y).toBe(350);
    });

    it.each(['failed', 'clamped', 'rejected'])(
      'S05-drag-9: fails closed before pressing when alignment scroll is %s',
      async (failure) => {
        currentScrollY = 0;
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

        vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
          async (_target: any, method: string, args?: any[]) => {
            if (method === 'inPageGetScrollState') {
              return [
                {
                  result: {
                    scrollX: 0,
                    scrollY: 0,
                    viewportWidth: 1000,
                    viewportHeight: 800,
                    docWidth: 1000,
                    docHeight: 2500,
                  },
                },
              ] as any;
            }
            if (method === 'inPageInstantScrollTo') {
              if (failure === 'rejected') throw new Error('Scroll injection rejected');
              return [
                { result: { success: failure === 'clamped', scrollX: 0, scrollY: 0 } },
              ] as any;
            }
            return [{ result: true }] as any;
          },
        );

        dispatchedEvents = [];
        const result = await interactIndexTool.execute({
          action: 'drag',
          coordinateSpace: 'screenshot',
          coordinate: { x: 250, y: 800 },
          end: { coordinate: { x: 250, y: 900 } },
          tabId: testTabId,
          autoSnap: false,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/failed to scroll|outside viewport/i);
        expect(dispatchedEvents.some((e) => e.params?.type === 'mousePressed')).toBe(false);
      },
    );

    it('S05-drag-2: preserves unshifted viewport drag endpoints despite cached cropped screenshot', async () => {
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 800,
        screenshotHeight: 450,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'element',
        originX: 100,
        originY: 200,
        cropWidth: 800,
        cropHeight: 450,
        hostname: 'example.com',
      });

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'drag',
        coordinateSpace: 'viewport',
        coordinate: { x: 100, y: 100 },
        end: { coordinate: { x: 500, y: 400 } },
        tabId: testTabId,
        autoSnap: false,
        steps: 2,
      });

      expect(result.isError).toBe(false);
      const press = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
      );
      const release = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mouseReleased',
      );
      expect(press?.params.x).toBe(100);
      expect(press?.params.y).toBe(100);
      expect(release?.params.x).toBe(500);
      expect(release?.params.y).toBe(400);
    });

    it('S05-drag-3: aligns screenshot-space fullpage drag with unified scroll before mousePressed', async () => {
      currentScrollY = 0;
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

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'drag',
        coordinateSpace: 'screenshot',
        coordinate: { x: 250, y: 800 },
        end: { coordinate: { x: 250, y: 900 } },
        tabId: testTabId,
        autoSnap: false,
        steps: 2,
      });

      expect(result.isError).toBe(false);
      const press = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
      );
      const release = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mouseReleased',
      );
      expect(press).toBeDefined();
      expect(release).toBeDefined();
      expect(press?.params.x).toBe(500);
      expect(press?.params.y).toBe(350);
      expect(release?.params.x).toBe(500);
      expect(release?.params.y).toBe(550);
      expect(press!.params.x + currentScrollX).toBe(500);
      expect(press!.params.y + currentScrollY).toBe(1600);
      expect(release!.params.x + currentScrollX).toBe(500);
      expect(release!.params.y + currentScrollY).toBe(1800);
    });

    it('S05-drag-4: fails closed when drag span cannot fit simultaneously within viewport', async () => {
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

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'drag',
        coordinateSpace: 'screenshot',
        coordinate: { x: 250, y: 100 },
        end: { coordinate: { x: 250, y: 1100 } },
        tabId: testTabId,
        autoSnap: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/cannot fit simultaneously within viewport/i);
      expect(dispatchedEvents.some((e) => e.params?.type === 'mousePressed')).toBe(false);
    });

    it('S05-drag-5: projects args.path points in screenshot space without requiring top-level coordinate', async () => {
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 640,
        screenshotHeight: 360,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        hostname: 'example.com',
      });

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'drag',
        coordinateSpace: 'screenshot',
        path: [
          { x: 40, y: 40 },
          { x: 120, y: 100 },
          { x: 200, y: 160 },
        ],
        tabId: testTabId,
        autoSnap: false,
      });

      expect(result.isError).toBe(false);
      const press = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mousePressed',
      );
      const release = dispatchedEvents.find(
        (e) => e.method === 'Input.dispatchMouseEvent' && e.params?.type === 'mouseReleased',
      );
      expect(press?.params.x).toBe(100);
      expect(press?.params.y).toBe(100);
      expect(release?.params.x).toBe(500);
      expect(release?.params.y).toBe(400);
    });

    it('fails closed when screenshot origin hostname mismatches tab url in interact-index', async () => {
      screenshotContextManager.setContext(testTabId, {
        screenshotWidth: 1280,
        screenshotHeight: 720,
        viewportWidth: 1600,
        viewportHeight: 900,
        captureMode: 'viewport',
        hostname: 'foreign-domain.com',
      });

      dispatchedEvents = [];
      const result = await interactIndexTool.execute({
        action: 'click',
        coordinateSpace: 'screenshot',
        coordinate: { x: 500, y: 400 },
        tabId: testTabId,
        autoSnap: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/domain changed/i);
      expect(dispatchedEvents.some((e) => e.params?.type === 'mousePressed')).toBe(false);
    });

    it('keeps an explicit drag path unchanged when autoSnap finds a nearby target', async () => {
      const execute = inPageEngine.executeInPage;
      const spy = vi
        .spyOn(inPageEngine, 'executeInPage')
        .mockImplementation(async (target: any, method: string, args?: any[]) => {
          if (method === 'inPageSnapCoordinate')
            return [{ result: { snapped: true, x: 115, y: 115 } }] as any;
          return execute(target, method, args);
        });
      const result = await interactIndexTool.execute({
        tabId: testTabId,
        action: 'drag',
        coordinate: { x: 100, y: 100 },
        path: [
          { x: 100, y: 100 },
          { x: 110, y: 100 },
          { x: 120, y: 100 },
        ],
        holdMs: 0,
        dnd: false,
      });
      expect(result.isError).toBe(false);
      expect(dispatchedEvents.find((e) => e.params?.type === 'mousePressed')?.params).toMatchObject(
        { x: 100, y: 100 },
      );
      expect(spy.mock.calls.some((call) => call[1] === 'inPageSnapCoordinate')).toBe(false);
    });

    it('finishes an intercepted HTML5 path without dispatching the remaining mouse moves', async () => {
      const observers = new Set<any>();
      vi.spyOn(cdpSessionManager, 'addCdpEventObserver').mockImplementation((fn) => {
        observers.add(fn);
      });
      vi.spyOn(cdpSessionManager, 'removeCdpEventObserver').mockImplementation((fn) => {
        observers.delete(fn);
      });
      let pressed = false;
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
        async (_tabId, method, params: any) => {
          dispatchedEvents.push({ method, params });
          if (params?.type === 'mousePressed') pressed = true;
          if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved' && pressed) {
            if (params.x === 250) {
              for (const observer of observers)
                observer(testTabId, 'Input.dragIntercepted', {
                  data: { items: [], dragOperationsMask: 1 },
                });
            } else throw new Error('CDP Input.dispatchMouseEvent outcome unknown');
          }
          return {} as any;
        },
      );
      const result = await interactIndexTool.execute({
        tabId: testTabId,
        action: 'drag',
        coordinate: { x: 200, y: 200 },
        path: [
          { x: 200, y: 200 },
          { x: 250, y: 200 },
          { x: 300, y: 200 },
        ],
        autoSnap: false,
        holdMs: 0,
      });
      expect(result.isError).toBe(false);
      expect(
        dispatchedEvents.some(
          (e) => e.method === 'Input.dispatchDragEvent' && e.params.type === 'drop',
        ),
      ).toBe(true);
      expect(
        dispatchedEvents.some(
          (e) =>
            e.method === 'Input.dispatchMouseEvent' &&
            e.params.type === 'mouseMoved' &&
            e.params.x === 300,
        ),
      ).toBe(false);
    });

    it('rejects click-sequence points combined with action drag before dispatching input', async () => {
      const result = await interactIndexTool.execute({
        tabId: testTabId,
        action: 'drag',
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 20 },
        ],
        end: { coordinate: { x: 300, y: 300 } },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/points.*click|points.*drag/i);
      expect(dispatchedEvents).toEqual([]);
    });
  });
});
