import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureSnapshotBaseline, captureDeltaIfRequested } from '../utils/delta-helper';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';
import { InteractIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as frameCoordinates from '../utils/frame-coordinates';
import * as raceCdpModule from '../utils/race-cdp';

describe('G3 Iframe Interaction Regression & Real Dynamic Probe Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    snapshotCacheManager.clear(1);
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'http://127.0.0.1/iframe-test.html' }),
        query: vi.fn().mockResolvedValue([{ id: 1, url: 'http://127.0.0.1/iframe-test.html' }]),
      },
      scripting: {
        executeScript: vi.fn(),
      },
      webNavigation: {
        getFrame: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1/iframe-content.html' }),
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0 }, { frameId: 4 }]),
      },
    };
    document.body.innerHTML = '';
  });

  describe('delta-helper subframe index preservation', () => {
    it('preserves subframe isolated index from namespace when establishing baseline', async () => {
      const mockPrunerResults = [
        {
          frameId: 0,
          result: {
            indexedElements: [
              { index: 1, tagName: 'h1', text: 'Parent Title' },
              { index: 2, tagName: 'iframe', attributes: { id: 'test-iframe' } },
              { index: 3, tagName: 'button', text: 'Parent Button' },
            ],
          },
        },
        {
          frameId: 4,
          result: {
            indexedElements: [
              { index: 401, tagName: 'h2', text: 'Iframe Heading' },
              {
                index: 402,
                tagName: 'button',
                attributes: { id: 'iframe-action-btn' },
                text: 'Inside Iframe Button',
              },
            ],
          },
        },
      ];

      const executeInPageSpy = vi
        .spyOn(engine, 'executeInPage')
        .mockImplementation(async (target: any, fnName: string) => {
          if (fnName === 'inPageDOMPruner') {
            return mockPrunerResults as any;
          }
          return [] as any;
        });

      await ensureSnapshotBaseline(1, true);

      const reindexCalls = executeInPageSpy.mock.calls.filter((c) => c[1] === 'inPageReindexFrame');
      expect(reindexCalls.length).toBe(0);

      const snap = snapshotCacheManager.getSnapshot(1);
      expect(snap).toBeDefined();
      expect(snap?.elementCount).toBe(5);
      const fp402 = snap?.fingerprints?.get(402);
      expect(fp402).toBeDefined();
      expect(fp402?.tagName).toBe('button');
      expect(fp402?.text).toBe('Inside Iframe Button');
    });

    it('fails closed and does not cache false baseline if inPageDOMPruner throws an error', async () => {
      vi.spyOn(engine, 'executeInPage').mockRejectedValue(new Error('Frame disconnected'));

      await ensureSnapshotBaseline(1, true);
      expect(snapshotCacheManager.isSnapshotValid(1)).toBe(false);
      expect(snapshotCacheManager.getSnapshot(1)).toBeUndefined();
    });

    it('preserves subframe namespace indices without reindex during captureDeltaIfRequested', async () => {
      const mockPrunerResults = [
        {
          frameId: 0,
          result: {
            indexedElements: [{ index: 1, tagName: 'button', text: 'Top' }],
          },
        },
        {
          frameId: 2,
          result: {
            indexedElements: [{ index: 201, tagName: 'a', text: 'Sub Link' }],
          },
        },
      ];

      const executeInPageSpy = vi
        .spyOn(engine, 'executeInPage')
        .mockImplementation(async (_target: any, fnName: string) => {
          if (fnName === 'inPageDOMPruner') {
            return mockPrunerResults as any;
          }
          return [{ result: true }] as any;
        });

      await captureDeltaIfRequested(1, true, 0);

      const reindexCalls = executeInPageSpy.mock.calls.filter((c) => c[1] === 'inPageReindexFrame');
      expect(reindexCalls.length).toBe(0);
    });
  });

  describe('interact-index subframe occlusion coordinate projection', () => {
    it('projects occRes coordinates to top viewport before comparison and CDP dispatch', async () => {
      const tool = new InteractIndexTool();
      vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) =>
        fn({} as any),
      );
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);

      vi.spyOn(tool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'http://127.0.0.1/iframe-test.html',
      });

      vi.spyOn(frameCoordinates, 'projectFramePoint').mockImplementation(
        async (_tab, _frame, point) => ({ x: point.x + 109, y: point.y + 89 }),
      );

      vi.spyOn(engine, 'executeInPage').mockImplementation(async (target: any, fnName: string) => {
        if (fnName === 'inPageGetElementCoordinates' || fnName === 'inPageWaitForActionable') {
          if (!target?.allFrames) {
            return [{ frameId: 0, result: { success: false } }] as any;
          }
          return [
            { frameId: 0, result: { success: false } },
            { frameId: 4, result: { success: true, x: 75, y: 89, tagName: 'button' } },
          ] as any;
        }
        if (fnName === 'inPageCheckOcclusion') {
          return [{ result: { x: 76, y: 90 } }] as any;
        }
        if (fnName === 'inPageGetScrollState') {
          return [
            { result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 } },
          ] as any;
        }
        if (fnName === 'inPageArmDeliveryProbe' || fnName === 'inPageReadDeliveryProbe') {
          return [{ result: { delivered: true } }] as any;
        }
        return [{ result: null }] as any;
      });

      const res = await tool.execute({
        tabId: 1,
        index: 5,
        action: 'click',
        humanize: false,
        includeDelta: false,
      });

      expect(res.isError).toBe(false);
      const data = JSON.parse((res.content[0] as any).text);
      expect(data.coordinates.x).toBe(185);
      expect(data.coordinates.y).toBe(179);
    });
  });

  describe('batch click interception subframe routing and local coordinates', () => {
    it('dispatches inPageCheckInterception to target frameId with local coordinates', async () => {
      const tabId = 1;
      const { batchActionsTool } =
        await import('../entrypoints/background/tools/browser/batch-actions');
      const unifiedLocatorModule =
        await import('../entrypoints/background/tools/browser/unified-locator');
      const agentCursorModule =
        await import('../entrypoints/background/tools/browser/agent-cursor');

      vi.spyOn(agentCursorModule, 'animateAgentCursor').mockResolvedValue(undefined as any);
      vi.spyOn(agentCursorModule, 'animateAgentCursorClick').mockResolvedValue(undefined as any);
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_t, _o, fn) =>
        fn({} as any),
      );
      vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);

      vi.spyOn(frameCoordinates, 'projectFramePoint').mockImplementation(
        async (_tab, _frame, point) => ({ x: point.x + 300, y: point.y + 200 }),
      );

      vi.spyOn(unifiedLocatorModule, 'resolveTargetLocation').mockResolvedValue({
        success: true,
        resolutionPath: 'ref',
        index: 402,
        frameId: 4,
        x: 20,
        y: 30,
        tagName: 'button',
        text: 'Inside Iframe',
      });

      let interceptionCall: { target: any; args: any[] } | undefined;

      vi.spyOn(engine, 'executeInPage').mockImplementation(
        async (target: any, fnName: string, args?: any[]) => {
          if (fnName === 'inPageCheckInterception') {
            interceptionCall = { target, args: args || [] };
            return [{ result: { intercepted: false } }] as any;
          }
          if (fnName === 'inPageWaitForActionable') {
            return [{ result: { success: true } }] as any;
          }
          return [{ result: true }] as any;
        },
      );

      vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId,
        url: 'http://127.0.0.1/iframe-test.html',
      });

      await batchActionsTool.execute({
        tabId,
        actions: [{ type: 'click', ref: 402 }],
      });

      expect(interceptionCall).toBeDefined();
      expect(interceptionCall?.target).toEqual({ tabId, frameIds: [4] });
      expect(interceptionCall?.args[0]).toBe(402);
      expect(interceptionCall?.args[1]).toBe(20);
      expect(interceptionCall?.args[2]).toBe(30);
    });
  });
});
