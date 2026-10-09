import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureSnapshotBaseline, captureDeltaIfRequested } from '../utils/delta-helper';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';
import { InteractIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as raceCdpModule from '../utils/race-cdp';

describe('G3 Iframe Interaction Regression Tests', () => {
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
      },
    };
  });

  describe('delta-helper subframe index synchronization', () => {
    it('synchronizes subframe isolatedIndexMap via inPageReindexFrame when establishing baseline', async () => {
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
              { index: 1, tagName: 'h2', text: 'Iframe Heading' },
              { index: 2, tagName: 'button', attributes: { id: 'iframe-action-btn' }, text: 'Inside Iframe Button' },
            ],
          },
        },
      ];

      const executeInPageSpy = vi.spyOn(engine, 'executeInPage').mockImplementation(async (target: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageDOMPruner') {
          return mockPrunerResults as any;
        }
        if (fnName === 'inPageReindexFrame') {
          return [{ frameId: target?.frameIds?.[0], result: true }] as any;
        }
        return [] as any;
      });

      // 1. Establish baseline
      await ensureSnapshotBaseline(1, true);

      // 2. Verify inPageReindexFrame was called for subframe 4 with offset 3 (4 - 1)
      const reindexCalls = executeInPageSpy.mock.calls.filter((c) => c[1] === 'inPageReindexFrame');
      expect(reindexCalls.length).toBeGreaterThan(0);
      expect(reindexCalls[0][0]).toEqual({ tabId: 1, frameIds: [4] });
      expect(reindexCalls[0][2]).toEqual([3, false]);

      // 3. Verify snapshot cache has merged 5 elements and tracked subframe button fingerprint
      const snap = snapshotCacheManager.getSnapshot(1);
      expect(snap).toBeDefined();
      expect(snap?.elementCount).toBe(5);
      const fp5 = snap?.fingerprints?.get(5);
      expect(fp5).toBeDefined();
      expect(fp5?.tagName).toBe('button');
      expect(fp5?.text).toBe('Inside Iframe Button');
    });

    it('fails closed and does not cache false baseline if subframe reindex throws an error', async () => {
      const mockPrunerResults = [
        {
          frameId: 0,
          result: {
            indexedElements: [{ index: 1, tagName: 'h1', text: 'Parent' }],
          },
        },
        {
          frameId: 4,
          result: {
            indexedElements: [{ index: 1, tagName: 'button', text: 'Inside' }],
          },
        },
      ];

      vi.spyOn(engine, 'executeInPage').mockImplementation(async (target: any, fnName: string) => {
        if (fnName === 'inPageDOMPruner') {
          return mockPrunerResults as any;
        }
        if (fnName === 'inPageReindexFrame') {
          throw new Error('Frame disconnected');
        }
        return [] as any;
      });

      await ensureSnapshotBaseline(1, true);

      // Snapshot cache must NOT be saved with unsynchronized elements
      expect(snapshotCacheManager.isSnapshotValid(1)).toBe(false);
      expect(snapshotCacheManager.getSnapshot(1)).toBeUndefined();
    });

    it('synchronizes subframe isolatedIndexMap via inPageReindexFrame during captureDeltaIfRequested', async () => {
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
            indexedElements: [{ index: 1, tagName: 'a', text: 'Sub Link' }],
          },
        },
      ];

      const executeInPageSpy = vi.spyOn(engine, 'executeInPage').mockImplementation(async (target: any, fnName: string) => {
        if (fnName === 'inPageDOMPruner') {
          return mockPrunerResults as any;
        }
        return [{ result: true }] as any;
      });

      await captureDeltaIfRequested(1, true, 0);

      const reindexCalls = executeInPageSpy.mock.calls.filter((c) => c[1] === 'inPageReindexFrame');
      expect(reindexCalls.length).toBeGreaterThan(0);
      expect(reindexCalls[0][0]).toEqual({ tabId: 1, frameIds: [2] });
      expect(reindexCalls[0][2]).toEqual([1, false]);
    });
  });

  describe('interact-index subframe occlusion coordinate projection', () => {
    it('projects occRes coordinates to top viewport before comparison and CDP dispatch', async () => {
      const tool = new InteractIndexTool();
      vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);
      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) => fn({} as any));
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);

      vi.spyOn(tool as any, 'resolveAffinityTab').mockResolvedValue({ id: 1, url: 'http://127.0.0.1/iframe-test.html' });

      // Mock subframe offset: iframe at (109, 89)
      (globalThis as any).chrome.scripting.executeScript = vi.fn().mockResolvedValue([
        { result: { offsetX: 109, offsetY: 89 } },
      ]);

      vi.spyOn(engine, 'executeInPage').mockImplementation(async (target: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageGetElementCoordinates') {
          if (!target?.allFrames) {
            // Main frame lookup fails
            return [{ frameId: 0, result: { success: false } }] as any;
          }
          // Subframe lookup across allFrames finds element 5 in frame 4
          return [
            { frameId: 0, result: { success: false } },
            { frameId: 4, result: { success: true, x: 75, y: 89, tagName: 'button' } },
          ] as any;
        }
        if (fnName === 'inPageCheckOcclusion') {
          // Occlusion check inside subframe returns refreshed subframe-local coords
          return [{ result: { x: 76, y: 90 } }] as any;
        }
        if (fnName === 'inPageGetScrollState') {
          return [{ result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 } }] as any;
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
      // Expected coordinates: occRes (76, 90) + iframe offset (109, 89) = (185, 179)
      expect(data.coordinates.x).toBe(185);
      expect(data.coordinates.y).toBe(179);
    });
  });
});
