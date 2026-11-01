import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screenshotTool } from '../entrypoints/background/tools/browser/screenshot';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as frameCoordinates from '../utils/frame-coordinates';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';

describe('Screenshot assetIndex cache route strictness', () => {
  const tabId = 1;

  beforeEach(() => {
    vi.restoreAllMocks();
    snapshotCacheManager.clear(tabId);
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: tabId, url: 'https://example.com', active: true }),
        query: vi.fn().mockResolvedValue([{ id: tabId, url: 'https://example.com', active: true }]),
      },
    };
    vi.spyOn(screenshotTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: tabId,
      windowId: 1,
      active: true,
    });
  });

  it('rejects with refresh guidance when assetIndex route is missing in snapshot cache, without broadcasting allFrames', async () => {
    const executeSpy = vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async () => []);

    const res = await screenshotTool.execute({
      tabId,
      assetIndex: 999,
    });

    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('Asset 999');
    expect(text).toContain('read_dom');

    // MUST NOT broadcast to all frames with global index
    const broadcastCalls = executeSpy.mock.calls.filter(
      (c) => c[1] === 'inPageGetAssetImage' && (c[0] as any)?.allFrames === true,
    );
    expect(broadcastCalls.length).toBe(0);
  });

  it('uses specific frameId and localIndex from cache route and extracts without guessing first', async () => {
    snapshotCacheManager.setSnapshot(tabId, {
      url: 'https://example.com',
      elementCount: 5,
      assetRoutes: new Map([[5, { frameId: 12, localIndex: 2 }]]),
    });

    const executeSpy = vi
      .spyOn(inPageEngine, 'executeInPage')
      .mockImplementation(async (target: any, fnName: string, args?: any[]) => {
        if (fnName === 'inPageGetAssetImage') {
          return [
            {
              frameId: 12,
              result: {
                success: true,
                kind: 'img',
                src: 'https://example.com/asset.png',
                dataUrl:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                rect: { x: 10, y: 10, width: 50, height: 50 },
              },
            },
          ] as any;
        }
        return [] as any;
      });

    const res = await screenshotTool.execute({
      tabId,
      assetIndex: 5,
    });

    expect(res.isError).toBeFalsy();
    const assetCall = executeSpy.mock.calls.find((c) => c[1] === 'inPageGetAssetImage');
    expect(assetCall).toBeDefined();
    expect((assetCall![0] as any).frameIds).toEqual([12]);
    expect((assetCall![0] as any).allFrames).toBeUndefined();
    expect(assetCall![2]?.[0]).toBe(3); // localIndex 2 + 1
  });

  it('fails closed when subframe projection rejects instead of cropping by frame offsets', async () => {
    snapshotCacheManager.setSnapshot(tabId, {
      url: 'https://example.com',
      elementCount: 1,
      assetRoutes: new Map([[5, { frameId: 12, localIndex: 0 }]]),
    });
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetAssetImage') {
          return [
            {
              frameId: 12,
              result: {
                success: false,
                reason: 'tainted canvas',
                kind: 'canvas',
                rect: { x: 10, y: 20, width: 50, height: 40 },
                frameOffsetX: 300,
                frameOffsetY: 200,
              },
            },
          ] as any;
        }
        if (fnName === 'inPageGetScrollState') {
          return [
            {
              result: { viewportWidth: 1000, viewportHeight: 800, scrollX: 0, scrollY: 0 },
            },
          ] as any;
        }
        return [] as any;
      },
    );
    vi.spyOn(frameCoordinates, 'projectFramePoint').mockRejectedValue(
      new Error("Frame 12 is not in this tab's confirmed sessions"),
    );
    const captureSpy = vi.spyOn(screenshotTool as any, 'captureTabPng');

    const res = await screenshotTool.execute({
      tabId,
      assetIndex: 5,
    });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toMatch(/Frame 12.*confirmed sessions/);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown frame rather than treating zero offsets as an identity', async () => {
    snapshotCacheManager.setSnapshot(tabId, {
      url: 'https://example.com',
      elementCount: 1,
      assetRoutes: new Map([[6, { frameId: 99, localIndex: 0 }]]),
    });
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetAssetImage') {
          return [
            {
              frameId: 99,
              result: {
                success: false,
                reason: 'opaque cross-origin image',
                kind: 'img',
                rect: { x: 10, y: 20, width: 50, height: 40 },
                frameOffsetX: 0,
                frameOffsetY: 0,
              },
            },
          ] as any;
        }
        if (fnName === 'inPageGetScrollState') {
          return [
            {
              result: { viewportWidth: 1000, viewportHeight: 800, scrollX: 0, scrollY: 0 },
            },
          ] as any;
        }
        return [] as any;
      },
    );
    (chrome as any).webNavigation = {
      getFrame: vi.fn().mockResolvedValue(undefined),
    };
    const captureSpy = vi.spyOn(screenshotTool as any, 'captureTabPng');

    const res = await screenshotTool.execute({
      tabId,
      assetIndex: 6,
    });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Frame 99 has no active document');
    expect(captureSpy).not.toHaveBeenCalled();
  });
});
