import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import { grepTool } from '../entrypoints/background/tools/browser/grep';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { captureDeltaIfRequested } from '../utils/delta-helper';

describe('W8 DOM Representation & Robustness (FUNC04 - FUNC07)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    snapshotCacheManager.clear();
  });

  describe('FUNC-04: Fast DOM Snapshot Action Labels & Rect Dimensions', () => {
    it('extracts action label into name, text, treeString and normalizes rect w/h to width/height', async () => {
      const tabId = 101;
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId,
        url: 'https://example.com/app',
      });

      const setSnapshotSpy = vi.spyOn(snapshotCacheManager, 'setSnapshot');

      const mockFastData = {
        url: 'https://example.com/app',
        title: 'App',
        w: 1280,
        h: 800,
        text: 'Page text',
        actions: [
          {
            id: 'e1',
            kind: 'click',
            role: 'button',
            label: 'Submit Order Now',
            rect: { x: 10, y: 20, w: 100, h: 40 },
          },
        ],
      };

      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (target: any, fnName: string) => {
          if (fnName === 'inPageFastSnapshot') {
            return [{ result: mockFastData, frameId: 0 }] as any;
          }
          return [] as any;
        },
      );

      const res = await readDOMTool.execute({ format: 'fast', tabId });
      expect(res.isError).toBe(false);

      const payload = JSON.parse(res.content[0].text);
      expect(payload.treeString).toContain('Submit Order Now');
      expect(payload.treeString).toContain('[1] button "Submit Order Now"');

      // Verify geometry consumption: rect w/h must be normalized to width/height
      expect(setSnapshotSpy).toHaveBeenCalledWith(
        tabId,
        expect.objectContaining({
          representation: 'fast',
          elements: expect.arrayContaining([
            expect.objectContaining({
              index: 1,
              text: 'Submit Order Now',
              attributes: expect.objectContaining({
                name: 'Submit Order Now',
              }),
              rect: { x: 10, y: 20, width: 100, height: 40 },
            }),
          ]),
        }),
      );

      const snapshot = snapshotCacheManager.getSnapshot(tabId);
      expect(snapshot).toBeDefined();
      expect(snapshot?.representation).toBe('fast');
      expect(snapshot?.fingerprints?.get(1)?.text).toBe('Submit Order Now');
    });

    it('P1: fast tree carries the live value of a filled control', async () => {
      const tabId = 103;
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId,
        url: 'https://example.com/search',
      });

      // The fast snapshot reports the control's live value; the tree must not drop it, or a
      // completed fill reads as unperformed and gets repeated until the run reports stuck.
      const mockFastData = {
        url: 'https://example.com/search',
        title: 'Search',
        w: 1280,
        h: 800,
        text: 'Page text',
        actions: [
          {
            id: 'e1',
            kind: 'fill',
            role: 'searchbox',
            label: 'Search',
            value: 'BrowserPaw',
            rect: { x: 10, y: 20, w: 300, h: 40 },
          },
          {
            id: 'e2',
            kind: 'fill',
            role: 'textbox',
            label: 'Empty field',
            value: '',
            rect: { x: 10, y: 80, w: 300, h: 40 },
          },
          {
            id: 'e3',
            kind: 'select',
            role: 'combobox',
            label: 'Country → Japan',
            value: 'jp',
            current_value: 'Japan',
            rect: { x: 10, y: 140, w: 300, h: 40 },
          },
        ],
      };

      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (target: any, fnName: string) => {
          if (fnName === 'inPageFastSnapshot') {
            return [{ result: mockFastData, frameId: 0 }] as any;
          }
          return [] as any;
        },
      );

      const res = await readDOMTool.execute({ format: 'fast', tabId });
      expect(res.isError).toBe(false);
      const payload = JSON.parse(res.content[0].text);

      expect(payload.treeString).toContain('[1] searchbox "Search" value="BrowserPaw"');
      // An empty control must not gain a value attribute.
      expect(payload.treeString).toContain('[2] textbox "Empty field"');
      expect(payload.treeString).not.toContain('[2] textbox "Empty field" value=');
      // A select's option value is not its current state; only current_value describes that.
      expect(payload.treeString).toContain('[3] combobox "Country → Japan"');
      expect(payload.treeString).not.toContain('value="jp"');
    });
  });

  describe('FUNC-05: Grep Subframe Reindex Synchronization', () => {
    it('synchronizes subframe index map via inPageReindexFrame for cross-frame matches', async () => {
      const tabId = 102;
      vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId,
        url: 'https://example.com/multi-frame',
      });

      const executeSpy = vi
        .spyOn(inPageEngine, 'executeInPage')
        .mockImplementation(async (target: any, fnName: string) => {
          if (fnName === 'inPageDOMPruner') {
            return [
              {
                frameId: 0,
                result: {
                  elementCount: 1,
                  interactiveCount: 1,
                  indexedElements: [
                    {
                      index: 1,
                      tagName: 'input',
                      role: 'textbox',
                      text: 'Search input',
                      isInteractive: true,
                    },
                  ],
                  indexMap: { 1: { selector: '#search', tagName: 'input' } },
                },
              },
              {
                frameId: 42,
                result: {
                  elementCount: 1,
                  interactiveCount: 1,
                  indexedElements: [
                    {
                      index: 1,
                      tagName: 'button',
                      role: 'button',
                      text: 'Pay with Card',
                      isInteractive: true,
                    },
                  ],
                  indexMap: { 1: { selector: '#pay', tagName: 'button' } },
                },
              },
            ] as any;
          }
          if (fnName === 'inPageReindexFrame') {
            return [{ frameId: target.frameIds?.[0], result: true }] as any;
          }
          return [] as any;
        });

      const res = await grepTool.execute({ query: 'Pay with Card', tabId });
      expect(res.isError).toBe(false);

      const payload = JSON.parse(res.content[0].text);
      expect(payload.totalMatches).toBe(1);
      expect(payload.matches[0].index).toBe(2);

      // Must invoke inPageReindexFrame on the subframe with frameOffset=1
      const reindexCalls = executeSpy.mock.calls.filter((c) => c[1] === 'inPageReindexFrame');
      expect(reindexCalls.length).toBe(1);
      expect(reindexCalls[0][0]).toEqual({ tabId, frameIds: [42] });
      expect(reindexCalls[0][2]).toEqual([1, false]);
    });
  });

  describe('FUNC-06: Multi-frame AXTree Alignment Deduplication', () => {
    it('renders subframe elements exactly once when AXTree triggers treeChanged', async () => {
      const tabId = 103;
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId,
        url: 'https://example.com/parent',
      });

      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (target: any, fnName: string) => {
          if (fnName === 'inPageDOMPruner') {
            return [
              {
                frameId: 0,
                result: {
                  elementCount: 1,
                  interactiveCount: 1,
                  treeString: '[1] div "Click Me"',
                  indexedElements: [
                    { index: 1, tagName: 'div', text: 'Click Me', isInteractive: false },
                  ],
                  indexMap: { 1: { selector: 'div#c', tagName: 'div' } },
                },
              },
              {
                frameId: 10,
                result: {
                  elementCount: 1,
                  interactiveCount: 1,
                  treeString: '[1] button "Subframe Button"',
                  indexedElements: [
                    { index: 1, tagName: 'button', text: 'Subframe Button', isInteractive: true },
                  ],
                  indexMap: { 1: { selector: 'button#s', tagName: 'button' } },
                },
              },
            ] as any;
          }
          if (fnName === 'inPageReindexFrame') {
            return [{ frameId: 10, result: true }] as any;
          }
          return [] as any;
        },
      );

      // Mock CDP sendCommand to return AX tree that turns div into a button
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({
        nodes: [
          {
            name: { value: 'click me' },
            role: { value: 'button' },
          },
        ],
      } as any);

      const res = await readDOMTool.execute({ tabId, format: 'compact' });
      expect(res.isError).toBe(false);

      const payload = JSON.parse(res.content[0].text);
      const tree = payload.treeString as string;

      // Check how many times Subframe Button appears in treeString
      const occurrences = (tree.match(/Subframe Button/g) || []).length;
      expect(occurrences).toBe(1);
      expect(tree).toContain('frame="10"');
    });
  });

  describe('FUNC-07: Snapshot Cache Representation Tagging & Delta Mode Switching', () => {
    it('tags snapshot representation and returns full baseline (isDelta: false) on mode switch', async () => {
      const tabId = 104;
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: tabId,
        url: 'https://example.com/checkout',
      });

      const fastData = {
        url: 'https://example.com/checkout',
        title: 'Checkout',
        w: 1280,
        h: 800,
        text: 'Checkout',
        actions: [{ id: 'e1', kind: 'click', role: 'button', label: 'Pay Now' }],
      };

      const prunerData = [
        {
          frameId: 0,
          result: {
            elementCount: 2,
            interactiveCount: 2,
            treeString: '[1] button "Pay Now"\n[2] a "Cancel"',
            indexedElements: [
              { index: 1, tagName: 'button', text: 'Pay Now', isInteractive: true },
              { index: 2, tagName: 'a', text: 'Cancel', isInteractive: true },
            ],
            indexMap: {},
          },
        },
      ];

      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (target: any, fnName: string) => {
          if (fnName === 'inPageFastSnapshot') {
            return [{ result: fastData, frameId: 0 }] as any;
          }
          if (fnName === 'inPageDOMPruner') {
            return prunerData as any;
          }
          return [] as any;
        },
      );

      // Step 1: Execute fast snapshot
      const fastRes = await readDOMTool.execute({ format: 'fast', tabId });
      expect(fastRes.isError).toBe(false);

      const snap1 = snapshotCacheManager.getSnapshot(tabId);
      expect(snap1).toBeDefined();
      expect(snap1?.representation).toBe('fast');

      // Step 2: Now call standard read_dom with deltaOnly: true
      const standardDeltaRes = await readDOMTool.execute({ deltaOnly: true, tabId });
      expect(standardDeltaRes.isError).toBe(false);

      const deltaPayload = JSON.parse(standardDeltaRes.content[0].text);
      // Because representation switched from fast to standard, it must NOT return a spurious delta diff
      // Instead, it must fall back to full baseline payload!
      expect(deltaPayload.isDelta).toBeUndefined(); // Standard non-delta payload returned
      expect(deltaPayload.treeString).toBeDefined();
      expect(deltaPayload.treeString).toContain('[1] button "Pay Now"');

      // The cache should now have standard representation
      const snap2 = snapshotCacheManager.getSnapshot(tabId);
      expect(snap2?.representation).toBe('standard');
    });

    it('ensures delta-helper default standard behavior safely rejects fast baseline', async () => {
      const tabId = 105;
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn().mockResolvedValue({ id: tabId, url: 'https://example.com/cart' }),
        },
      };
      // Pre-set a fast snapshot baseline in cache
      snapshotCacheManager.setSnapshot(tabId, {
        url: 'https://example.com/cart',
        elementCount: 1,
        elements: [{ index: 1, tagName: 'button', text: 'Fast Button', isInteractive: true }],
        representation: 'fast',
      });

      // Mock inPageDOMPruner returning standard DOM
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            elementCount: 1,
            interactiveCount: 1,
            indexedElements: [
              { index: 1, tagName: 'button', text: 'Fast Button', isInteractive: true },
            ],
          },
        },
      ] as any);

      // captureDeltaIfRequested defaults to standard representation
      const deltaResult = await captureDeltaIfRequested(tabId, true, 0);
      expect(deltaResult).toBeDefined();
      // Because cached baseline was 'fast' and delta-helper is standard,
      // diffWithPrevious returns isDelta: false, establishing a fresh baseline instead of bogus diffs
      expect(deltaResult?.isDelta).toBe(false);
      expect(deltaResult?.message).toContain('Baseline snapshot established');
      expect(snapshotCacheManager.getSnapshot(tabId)?.representation).toBe('standard');
    });
  });
});
