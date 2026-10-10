import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureSnapshotBaseline, captureDeltaIfRequested } from '../utils/delta-helper';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';
import {
  InteractIndexTool,
  getSubframeViewportOffset,
} from '../entrypoints/background/tools/browser/interact-index';
import { cdpSessionManager } from '../utils/cdp-session-manager';
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
      },
    };
    document.body.innerHTML = '';
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
              {
                index: 2,
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
          if (fnName === 'inPageReindexFrame') {
            return [{ frameId: target?.frameIds?.[0], result: true }] as any;
          }
          return [] as any;
        });

      await ensureSnapshotBaseline(1, true);

      const reindexCalls = executeInPageSpy.mock.calls.filter((c) => c[1] === 'inPageReindexFrame');
      expect(reindexCalls.length).toBeGreaterThan(0);
      expect(reindexCalls[0][0]).toEqual({ tabId: 1, frameIds: [4] });
      expect(reindexCalls[0][2]).toEqual([3, false]);

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

      vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
        if (fnName === 'inPageDOMPruner') {
          return mockPrunerResults as any;
        }
        if (fnName === 'inPageReindexFrame') {
          throw new Error('Frame disconnected');
        }
        return [] as any;
      });

      await ensureSnapshotBaseline(1, true);
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
      expect(reindexCalls.length).toBeGreaterThan(0);
      expect(reindexCalls[0][0]).toEqual({ tabId: 1, frameIds: [2] });
      expect(reindexCalls[0][2]).toEqual([1, false]);
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

      (globalThis as any).chrome.scripting.executeScript = vi
        .fn()
        .mockResolvedValue([{ result: { offsetX: 109, offsetY: 89 } }]);

      vi.spyOn(engine, 'executeInPage').mockImplementation(async (target: any, fnName: string) => {
        if (fnName === 'inPageGetElementCoordinates') {
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

  describe('Real Execution of getSubframeViewportOffset without static offset mocks', () => {
    it('executes real func: accurately targets second iframe when two iframes share identical src, preserving existing attributes', async () => {
      // Setup DOM with existing pre-preserved attribute
      document.documentElement.setAttribute('data-bp-fprobe-existing', 'pre-existing-value');

      const iframe1 = document.createElement('iframe');
      iframe1.src = 'https://embed.example.com/widget';
      iframe1.id = 'frame-first';
      iframe1.getBoundingClientRect = () =>
        ({
          left: 10,
          top: 20,
          right: 310,
          bottom: 220,
          width: 300,
          height: 200,
          x: 10,
          y: 20,
          toJSON: () => ({}),
        }) as DOMRect;

      const iframe2 = document.createElement('iframe');
      iframe2.src = 'https://embed.example.com/widget';
      iframe2.id = 'frame-second';
      iframe2.getBoundingClientRect = () =>
        ({
          left: 150,
          top: 220,
          right: 550,
          bottom: 570,
          width: 400,
          height: 350,
          x: 150,
          y: 220,
          toJSON: () => ({}),
        }) as DOMRect;

      const recordedChildAttr: string | null = null;
      window.getComputedStyle = (el: Element) => {
        if (el === iframe2) {
          return { borderLeftWidth: '5px', borderTopWidth: '7px' } as any;
        }
        return { borderLeftWidth: '0px', borderTopWidth: '0px' } as any;
      };

      document.body.appendChild(iframe1);
      document.body.appendChild(iframe2);

      const iframe2Doc = document.implementation.createHTMLDocument('sub-doc-2');
      const iframe2Win = { document: iframe2Doc, parent: window } as any;
      Object.defineProperty(iframe2Doc, 'defaultView', { value: iframe2Win, configurable: true });
      Object.defineProperty(iframe2, 'contentDocument', { value: iframe2Doc, writable: true });
      Object.defineProperty(iframe2, 'contentWindow', { value: iframe2Win, writable: true });

      const iframe1Doc = document.implementation.createHTMLDocument('sub-doc-1');
      const iframe1Win = { document: iframe1Doc, parent: window } as any;
      Object.defineProperty(iframe1Doc, 'defaultView', { value: iframe1Win, configurable: true });
      Object.defineProperty(iframe1, 'contentDocument', { value: iframe1Doc, writable: true });
      Object.defineProperty(iframe1, 'contentWindow', { value: iframe1Win, writable: true });

      let recordedProbeAttr: string | null = null;

      (globalThis as any).chrome.scripting.executeScript = vi
        .fn()
        .mockImplementation(async ({ target, func, args }) => {
          if (target?.frameIds && target.frameIds.includes(202)) {
            const attr = args?.[0];
            if (attr && !recordedProbeAttr) {
              recordedProbeAttr = attr;
            }
            const prevDoc = globalThis.document;
            try {
              (globalThis as any).document = iframe2Doc;
              func(...(args || []));
            } finally {
              (globalThis as any).document = prevDoc;
            }
            return [{ frameId: 202, result: true }];
          }

          if (!target?.frameIds) {
            const res = await func(...(args || []));

            return [{ frameId: 0, result: res }];
          }

          return [{ result: null }];
        });

      const offset = await getSubframeViewportOffset(1, 202);

      // Target is iframe2: left (150) + borderLeft (5) = 155; top (220) + borderTop (7) = 227
      expect(offset.offsetX).toBe(155);
      expect(offset.offsetY).toBe(227);

      expect(recordedProbeAttr).toBeTruthy();
      expect(recordedProbeAttr).toMatch(/^data-bp-fprobe-[a-z0-9_]+$/);

      // Verify cleanup occurred in finally block
      expect(iframe2Doc.documentElement.hasAttribute(recordedProbeAttr!)).toBe(false);

      // Verify pre-existing attribute on parent document was strictly preserved
      expect(document.documentElement.getAttribute('data-bp-fprobe-existing')).toBe(
        'pre-existing-value',
      );
    });

    it('executes real func: computes accurate cumulative offset for nested 2-level iframes without double-offset', async () => {
      const parentIframe = document.createElement('iframe');
      parentIframe.id = 'parent-iframe';
      parentIframe.getBoundingClientRect = () =>
        ({
          left: 80,
          top: 40,
          right: 680,
          bottom: 440,
          width: 600,
          height: 400,
          x: 80,
          y: 40,
          toJSON: () => ({}),
        }) as DOMRect;

      const parentDoc = document.implementation.createHTMLDocument('parent-doc');
      const parentWin = { document: parentDoc, parent: window } as any;
      Object.defineProperty(parentDoc, 'defaultView', { value: parentWin, configurable: true });
      Object.defineProperty(parentIframe, 'contentDocument', { value: parentDoc, writable: true });
      Object.defineProperty(parentIframe, 'contentWindow', { value: parentWin, writable: true });
      document.body.appendChild(parentIframe);

      const childIframe = parentDoc.createElement('iframe');
      childIframe.id = 'nested-child-iframe';
      childIframe.getBoundingClientRect = () =>
        ({
          left: 30,
          top: 25,
          right: 230,
          bottom: 175,
          width: 200,
          height: 150,
          x: 30,
          y: 25,
          toJSON: () => ({}),
        }) as DOMRect;

      const childDoc = document.implementation.createHTMLDocument('child-doc');
      const childWin = { document: childDoc, parent: parentWin } as any;
      Object.defineProperty(childDoc, 'defaultView', { value: childWin, configurable: true });
      Object.defineProperty(childIframe, 'contentDocument', { value: childDoc, writable: true });
      Object.defineProperty(childIframe, 'contentWindow', { value: childWin, writable: true });
      parentDoc.body.appendChild(childIframe);

      parentWin.getComputedStyle = (el: Element) => {
        if (el === childIframe) return { borderLeftWidth: '3px', borderTopWidth: '5px' } as any;
        return { borderLeftWidth: '0px', borderTopWidth: '0px' } as any;
      };
      window.getComputedStyle = (el: Element) => {
        if (el === parentIframe) return { borderLeftWidth: '10px', borderTopWidth: '8px' } as any;
        return { borderLeftWidth: '0px', borderTopWidth: '0px' } as any;
      };

      (globalThis as any).chrome.scripting.executeScript = vi
        .fn()
        .mockImplementation(async ({ target, func, args }) => {
          if (target?.frameIds && target.frameIds.includes(303)) {
            const attr = args?.[0];
            childDoc.documentElement.setAttribute(attr, '1');
            return [{ frameId: 303, result: true }];
          }
          if (!target?.frameIds) {
            const res = await func(...(args || []));
            return [{ frameId: 0, result: res }];
          }
          return [{ result: null }];
        });

      const offset = await getSubframeViewportOffset(1, 303);

      expect(offset.offsetX).toBe(123);
      expect(offset.offsetY).toBe(78);
    });

    it('rejects partial ancestor chain and falls through when iframe ancestor path is broken/cross-origin', async () => {
      vi.spyOn(cdpSessionManager, 'isAttached').mockReturnValue(false);

      const parentIframe = document.createElement('iframe');
      const parentDoc = document.implementation.createHTMLDocument('parent-doc');
      // Broken parent link: parentWin.parent is an inaccessible non-window object
      const parentWin = { document: parentDoc, parent: { document: null } } as any;
      Object.defineProperty(parentDoc, 'defaultView', { value: parentWin, configurable: true });
      Object.defineProperty(parentIframe, 'contentDocument', { value: parentDoc, writable: true });
      Object.defineProperty(parentIframe, 'contentWindow', { value: parentWin, writable: true });
      document.body.appendChild(parentIframe);

      const childIframe = parentDoc.createElement('iframe');
      const childDoc = document.implementation.createHTMLDocument('child-doc');
      const childWin = { document: childDoc, parent: parentWin } as any;
      Object.defineProperty(childDoc, 'defaultView', { value: childWin, configurable: true });
      Object.defineProperty(childIframe, 'contentDocument', { value: childDoc, writable: true });
      Object.defineProperty(childIframe, 'contentWindow', { value: childWin, writable: true });
      parentDoc.body.appendChild(childIframe);

      (globalThis as any).chrome.scripting.executeScript = vi
        .fn()
        .mockImplementation(async ({ target, func, args }) => {
          if (target?.frameIds && target.frameIds.includes(404)) {
            const prevDoc = globalThis.document;
            try {
              (globalThis as any).document = childDoc;
              func(...(args || []));
            } finally {
              (globalThis as any).document = prevDoc;
            }
            return [{ frameId: 404, result: true }];
          }
          if (!target?.frameIds) {
            const res = await func(...(args || []));

            return [{ frameId: 0, result: res }];
          }
          return [{ result: null }];
        });

      // Must strictly reject partial path and throw fail-closed
      await expect(getSubframeViewportOffset(1, 404)).rejects.toThrow(
        /Could not resolve bounding rect for subframe 404/,
      );
    });

    it('Track 2 CDP matching: only matches context that verifies the unique dynamic probe attribute', async () => {
      (globalThis as any).chrome.scripting.executeScript = vi
        .fn()
        .mockImplementation(async ({ target, func, args }) => {
          if (target?.frameIds) {
            return [{ frameId: 505, result: true }];
          }
          // Track 1 returns null to simulate cross-origin DOM boundary
          return [{ frameId: 0, result: null }];
        });

      vi.spyOn(cdpSessionManager, 'isAttached').mockReturnValue(true);

      let targetContextEvaluated = false;

      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
        async (_tabId: number, method: string, params?: any) => {
          if (method === 'DOM.enable') return {};
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'root_frame' },
                childFrames: [
                  {
                    frame: { id: 'unrelated_frame_1', parentId: 'root_frame' },
                  },
                  {
                    frame: { id: 'target_cdp_frame_match', parentId: 'root_frame' },
                  },
                ],
              },
            };
          }
          if (method === 'Page.createIsolatedWorld') {
            if (params?.frameId === 'target_cdp_frame_match') {
              return { executionContextId: 777 };
            }
            return { executionContextId: 111 };
          }
          if (method === 'Runtime.evaluate') {
            if (params?.contextId === 777) {
              targetContextEvaluated = true;
              return { result: { value: true } }; // Strict probe attribute match!
            }
            return { result: { value: false } };
          }
          if (method === 'DOM.getFrameOwner') {
            if (params?.frameId === 'target_cdp_frame_match') {
              return { backendNodeId: 999 };
            }
            return {};
          }
          if (method === 'DOM.getBoxModel') {
            if (params?.backendNodeId === 999) {
              return {
                model: {
                  content: [160, 240, 560, 240, 560, 440, 160, 440],
                },
              };
            }
          }
          return {};
        },
      );

      const offset = await getSubframeViewportOffset(1, 505);

      expect(targetContextEvaluated).toBe(true);
      expect(offset).toEqual({ offsetX: 160, offsetY: 240 });
    });

    it('guarantees offset state isolation without global fallback leakage across sequential subframes', async () => {
      (globalThis as any).chrome.scripting.executeScript = vi
        .fn()
        .mockImplementation(async ({ target }) => {
          if (target?.frameIds) {
            return [{ frameId: target.frameIds[0], result: true }];
          }
          return [{ frameId: 0, result: null }];
        });

      vi.spyOn(cdpSessionManager, 'isAttached').mockReturnValue(true);

      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
        async (_tabId: number, method: string, params?: any) => {
          if (method === 'DOM.enable') return {};
          if (method === 'Page.getFrameTree') {
            return {
              frameTree: {
                frame: { id: 'root_frame' },
                childFrames: [{ frame: { id: 'frame_alpha', parentId: 'root_frame' } }],
              },
            };
          }
          if (method === 'Page.createIsolatedWorld') {
            return { executionContextId: 101 };
          }
          if (method === 'Runtime.evaluate') {
            return { result: { value: true } };
          }
          if (method === 'DOM.getFrameOwner') {
            return { backendNodeId: 111 };
          }
          if (method === 'DOM.getBoxModel') {
            return {
              model: {
                content: [100, 200, 400, 200, 400, 400, 100, 400],
              },
            };
          }
          return {};
        },
      );

      const offset1 = await getSubframeViewportOffset(1, 101);
      expect(offset1).toEqual({ offsetX: 100, offsetY: 200 });

      // Subsequent call where CDP is not attached: MUST NOT return stale offset1 (100, 200)
      vi.spyOn(cdpSessionManager, 'isAttached').mockReturnValue(false);

      await expect(getSubframeViewportOffset(1, 999)).rejects.toThrow(
        /Could not resolve bounding rect for subframe 999/,
      );
    });
  });
});
