import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reserveIndexNamespaces } from '../entrypoints/background/tools/browser/index-namespace';
import {
  executeInPage,
  injectedTabs,
  tabDocumentNamespaces,
} from '../entrypoints/background/tools/browser/in-page-engine';
import {
  findIndexedElement,
  getIsolatedIndexMap,
  indexElement,
  inPageSetIndexNamespace,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('DOM Index Namespace Manager & in-page integration', () => {
  let localStorageMock: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    injectedTabs.clear();
    tabDocumentNamespaces.clear();
    localStorageMock = {};

    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[]) => {
            if (typeof keys === 'string') {
              return { [keys]: localStorageMock[keys] };
            }
            return { ...localStorageMock };
          }),
          set: vi.fn(async (items: Record<string, any>) => {
            Object.assign(localStorageMock, items);
          }),
        },
      },
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 101, url: 'https://example.com' }),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn(),
      },
    };
  });

  describe('1. reserveIndexNamespaces Unit Tests', () => {
    const NAMESPACE_SIZE = 2 ** 24;

    it('allocates strictly serialized, non-overlapping namespaces concurrently', async () => {
      // Launch 3 concurrent reservation calls with counts 1, 3, 2
      const [res1, res2, res3] = await Promise.all([
        reserveIndexNamespaces(1),
        reserveIndexNamespaces(3),
        reserveIndexNamespaces(2),
      ]);

      expect(res1).toHaveLength(1);
      expect(res2).toHaveLength(3);
      expect(res3).toHaveLength(2);

      const allBases = [...res1, ...res2, ...res3];
      // All bases must be multiples of 2**24 and strictly unique
      for (const b of allBases) {
        expect(b % NAMESPACE_SIZE).toBe(0);
      }
      const uniqueSet = new Set(allBases);
      expect(uniqueSet.size).toBe(6);

      // Verify continuous monotonically increasing ranges: 1, 2, 3, 4, 5, 6
      allBases.sort((a, b) => a - b);
      for (let i = 0; i < allBases.length; i++) {
        expect(allBases[i]).toBe((i + 1) * NAMESPACE_SIZE);
      }

      // Storage should reflect total allocated: 1 (start) + 6 = 7
      expect(localStorageMock['domIndexNextNamespace']).toBe(7);
    });

    it('survives service-worker restarts via vi.resetModules without reusing references', async () => {
      // Step 1: Initial allocation before restart
      const firstAlloc = await reserveIndexNamespaces(3);
      expect(firstAlloc).toEqual([1 * NAMESPACE_SIZE, 2 * NAMESPACE_SIZE, 3 * NAMESPACE_SIZE]);
      expect(localStorageMock['domIndexNextNamespace']).toBe(4);

      // Step 2: Simulate service-worker restart by wiping in-memory modules
      vi.resetModules();

      // Step 3: Re-import module as a new execution context
      const reloadedModule =
        await import('../entrypoints/background/tools/browser/index-namespace');

      // Step 4: Allocate in the new worker lifecycle
      const secondAlloc = await reloadedModule.reserveIndexNamespaces(2);
      // Must start from 4 * NAMESPACE_SIZE, never rollback to 1
      expect(secondAlloc).toEqual([4 * NAMESPACE_SIZE, 5 * NAMESPACE_SIZE]);
      expect(localStorageMock['domIndexNextNamespace']).toBe(6);
    });

    it('fails closed and does not leak/publish refs when storage persistence fails', async () => {
      (chrome.storage.local.set as any).mockRejectedValueOnce(
        new Error('Disk quota exceeded or persistent storage failure'),
      );

      let caughtErr: Error | null = null;
      try {
        await reserveIndexNamespaces(2);
      } catch (e) {
        caughtErr = e as Error;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr?.message).toContain('Disk quota exceeded');

      // Ensure subsequent calls are NOT deadlocked (lock was properly released in finally)
      const recoverAlloc = await reserveIndexNamespaces(1);
      expect(recoverAlloc).toEqual([1 * NAMESPACE_SIZE]);
      expect(localStorageMock['domIndexNextNamespace']).toBe(2);
    });

    it('refuses to reuse references on corrupted storage or integer overflow', async () => {
      // Corrupt storage (negative integer)
      localStorageMock['domIndexNextNamespace'] = -1;
      await expect(reserveIndexNamespaces(1)).rejects.toThrow(
        'DOM index namespace exhausted or corrupt; refusing to reuse references',
      );

      // Corrupt storage (non-safe integer)
      localStorageMock['domIndexNextNamespace'] = 'corrupt-string';
      await expect(reserveIndexNamespaces(1)).rejects.toThrow(
        'DOM index namespace exhausted or corrupt; refusing to reuse references',
      );

      // Invalid count parameter
      localStorageMock['domIndexNextNamespace'] = 1;
      await expect(reserveIndexNamespaces(0)).rejects.toThrow(
        'DOM index namespace exhausted or corrupt; refusing to reuse references',
      );
      await expect(reserveIndexNamespaces(-5)).rejects.toThrow(
        'DOM index namespace exhausted or corrupt; refusing to reuse references',
      );

      // Exhaustion near Number.MAX_SAFE_INTEGER
      const maxNamespaceIndex = Math.floor(Number.MAX_SAFE_INTEGER / NAMESPACE_SIZE);
      localStorageMock['domIndexNextNamespace'] = maxNamespaceIndex;
      await expect(reserveIndexNamespaces(2)).rejects.toThrow(
        'DOM index namespace exhausted or corrupt; refusing to reuse references',
      );
    });
  });

  describe('2. executeInPage Dispatcher Integration', () => {
    const NAMESPACE_SIZE = 2 ** 24;

    it('assigns distinct bases to same frame with different documentIds and multi-iframes', async () => {
      const setupCalls: Array<{ documentId: string; base: number }> = [];
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        // 1. Inpage engine file injection returning main frame + iframe with documentIds
        if (opts.files) {
          return [
            { frameId: 0, documentId: 'doc-main-1', result: undefined },
            { frameId: 1, documentId: 'doc-sub-1', result: undefined },
          ];
        }

        // 2. Namespace setup calls targeting specific documentIds
        if (opts.target?.documentIds) {
          setupCalls.push({
            documentId: opts.target.documentIds[0],
            base: opts.args?.[0],
          });
          return [{ frameId: 0, documentId: opts.target.documentIds[0], result: true }];
        }

        // 3. Entrypoint single-turn execution
        return [
          {
            frameId: 0,
            documentId: 'doc-main-1',
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { frame: 'main', indexed: true },
            },
          },
          {
            frameId: 1,
            documentId: 'doc-sub-1',
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { frame: 'sub', indexed: true },
            },
          },
        ];
      });

      const res = await executeInPage<{ frame: string; indexed: boolean }>(
        { tabId: 101, allFrames: true },
        'inPageDOMPruner',
        [],
      );

      expect(res).toHaveLength(2);
      expect(setupCalls).toHaveLength(2);

      // Both documents must receive unique and distinct namespace bases
      const [call1, call2] = setupCalls;
      expect(call1.documentId).toBe('doc-main-1');
      expect(call2.documentId).toBe('doc-sub-1');
      expect(call1.base).toBe(1 * NAMESPACE_SIZE);
      expect(call2.base).toBe(2 * NAMESPACE_SIZE);
      expect(call1.base).not.toBe(call2.base);
    });

    it('preserves a live reference after reinjection and expires it after hard navigation', async () => {
      const g = globalThis as any;
      const namespaceKey = Symbol.for('__browser_use_index_namespace__');
      const identityKey = Symbol.for('__browser_use_index_identity__');
      let documentId = 'document-before-navigation';
      const replaceDocument = () => {
        delete g[namespaceKey];
        delete g[identityKey];
        getIsolatedIndexMap().clear();
        document.body.innerHTML = '<button id="save">Save</button>';
      };
      replaceDocument();
      g.__MCP_INPAGE__ = {
        inPageSetIndexNamespace,
        observe: () => indexElement(document.querySelector('button')!),
      };
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        const result = opts.files ? undefined : opts.func(...opts.args);
        return [{ frameId: 0, documentId, result }];
      });

      try {
        const first = (await executeInPage<number>({ tabId: 101 }, 'observe', []))[0].result;
        const originalNode = document.querySelector('button')!;
        expect(first).toBeGreaterThan(2 ** 24);
        expect(findIndexedElement(first)).toBe(originalNode);

        // Recreated worker: the new dispatcher has no injection cache, while the document survives.
        vi.resetModules();
        const restarted = await import('../entrypoints/background/tools/browser/in-page-engine');
        const stable = (await restarted.executeInPage<number>({ tabId: 101 }, 'observe', []))[0]
          .result;
        expect(stable).toBe(first);

        // A navigation reuses the frame ID but creates a fresh isolated document context.
        restarted.injectedTabs.clear();
        documentId = 'document-after-navigation';
        replaceDocument();
        const next = (await restarted.executeInPage<number>({ tabId: 101 }, 'observe', []))[0]
          .result;
        expect(next).toBeGreaterThan(first);
        expect(findIndexedElement(first)).toBeNull();
        expect(findIndexedElement(next)).toBe(document.querySelector('button'));
      } finally {
        delete g.__MCP_INPAGE__;
        delete g[namespaceKey];
        delete g[identityKey];
        getIsolatedIndexMap().clear();
        document.body.innerHTML = '';
      }
    });

    it('fails closed when returned frames lack documentId', async () => {
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        if (opts.files) {
          // Frame lacks documentId
          return [{ frameId: 0, result: undefined }];
        }
        return [];
      });

      await expect(executeInPage({ tabId: 101 }, 'inPageDOMPruner', [])).rejects.toThrow(
        'Cannot identify document for DOM index namespace',
      );
    });

    it('retries pre-dispatch setup once when a document disappears during namespace install', async () => {
      let injections = 0;
      let namespaceCalls = 0;
      let entrypointCalls = 0;
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        if (opts.files) {
          injections++;
          return [
            {
              frameId: 0,
              documentId: injections === 1 ? 'doc-before-nav' : 'doc-after-nav',
              result: undefined,
            },
          ];
        }
        if (opts.target?.documentIds) {
          namespaceCalls++;
          if (namespaceCalls === 1) {
            throw new Error('No document with id doc-before-nav in tab with id 101');
          }
          return [{ frameId: 0, documentId: 'doc-after-nav', result: true }];
        }
        entrypointCalls++;
        return [
          {
            frameId: 0,
            documentId: 'doc-after-nav',
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: 'ok',
            },
          },
        ];
      });

      const res = await executeInPage<string>({ tabId: 101 }, 'observe', []);

      expect(res[0].result).toBe('ok');
      expect(injections).toBe(2);
      expect(namespaceCalls).toBe(2);
      expect(entrypointCalls).toBe(1);
    });

    it('fails closed when namespace setter callback does not return true', async () => {
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        if (opts.files) {
          return [{ frameId: 0, documentId: 'doc-strict-1', result: undefined }];
        }
        if (opts.target?.documentIds) {
          // Namespace initialization returned false or undefined
          return [{ frameId: 0, documentId: 'doc-strict-1', result: false }];
        }
        return [];
      });

      await expect(executeInPage({ tabId: 101 }, 'inPageDOMPruner', [])).rejects.toThrow(
        'Cannot initialize document DOM index namespace',
      );
    });

    it('avoids redundant namespace reservations and setter calls for already-initialized documents in allFrames calls', async () => {
      const setupCalls: Array<{ documentId: string; base: number }> = [];
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        if (opts.files) {
          return [
            { frameId: 0, documentId: 'doc-main-1', result: undefined },
            { frameId: 1, documentId: 'doc-sub-1', result: undefined },
          ];
        }
        if (opts.target?.documentIds) {
          setupCalls.push({
            documentId: opts.target.documentIds[0],
            base: opts.args?.[0],
          });
          return [{ frameId: 0, documentId: opts.target.documentIds[0], result: true }];
        }
        return [
          {
            frameId: 0,
            documentId: 'doc-main-1',
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { success: true },
            },
          },
          {
            frameId: 1,
            documentId: 'doc-sub-1',
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { success: true },
            },
          },
        ];
      });

      // Call 1: initial allocation
      await executeInPage({ tabId: 101, allFrames: true }, 'inPageDOMPruner', []);
      expect(setupCalls).toHaveLength(2);
      expect(localStorageMock['domIndexNextNamespace']).toBe(3);

      // Call 2: repeated allFrames call on identical documents
      await executeInPage({ tabId: 101, allFrames: true }, 'inPageDOMPruner', []);
      expect(setupCalls).toHaveLength(2);
      expect(localStorageMock['domIndexNextNamespace']).toBe(3);
    });

    it('allocates namespace only for newly observed documentId in existing frame', async () => {
      const setupCalls: Array<{ documentId: string; base: number }> = [];
      let subDocumentId = 'doc-sub-1';
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        if (opts.files) {
          return [
            { frameId: 0, documentId: 'doc-main-1', result: undefined },
            { frameId: 1, documentId: subDocumentId, result: undefined },
          ];
        }
        if (opts.target?.documentIds) {
          setupCalls.push({
            documentId: opts.target.documentIds[0],
            base: opts.args?.[0],
          });
          return [{ frameId: 0, documentId: opts.target.documentIds[0], result: true }];
        }
        return [
          {
            frameId: 0,
            documentId: 'doc-main-1',
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { success: true },
            },
          },
          {
            frameId: 1,
            documentId: subDocumentId,
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { success: true },
            },
          },
        ];
      });

      await executeInPage({ tabId: 101, allFrames: true }, 'inPageDOMPruner', []);
      expect(setupCalls).toHaveLength(2);
      expect(localStorageMock['domIndexNextNamespace']).toBe(3);

      // Subframe navigates to a new documentId
      subDocumentId = 'doc-sub-2';
      await executeInPage({ tabId: 101, allFrames: true }, 'inPageDOMPruner', []);
      // Only the new documentId should be reserved and configured
      expect(setupCalls).toHaveLength(3);
      expect(setupCalls[2].documentId).toBe('doc-sub-2');
      expect(setupCalls[2].base).toBe(3 * NAMESPACE_SIZE);
      expect(localStorageMock['domIndexNextNamespace']).toBe(4);
    });

    it('does not cache documentId when namespace initialization fails', async () => {
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        if (opts.files) {
          return [{ frameId: 0, documentId: 'doc-fail-1', result: undefined }];
        }
        if (opts.target?.documentIds) {
          return [{ frameId: 0, documentId: 'doc-fail-1', result: false }];
        }
        return [];
      });

      await expect(executeInPage({ tabId: 101 }, 'inPageDOMPruner', [])).rejects.toThrow(
        'Cannot initialize document DOM index namespace',
      );
    });

    it('cleans up document namespace cache on tab navigation or removal', async () => {
      const setupCalls: Array<{ documentId: string; base: number }> = [];
      (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
        if (opts.files) {
          return [{ frameId: 0, documentId: 'doc-nav-1', result: undefined }];
        }
        if (opts.target?.documentIds) {
          setupCalls.push({
            documentId: opts.target.documentIds[0],
            base: opts.args?.[0],
          });
          return [{ frameId: 0, documentId: opts.target.documentIds[0], result: true }];
        }
        return [
          {
            frameId: 0,
            documentId: 'doc-nav-1',
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { success: true },
            },
          },
        ];
      });

      await executeInPage({ tabId: 101, allFrames: true }, 'inPageDOMPruner', []);
      expect(setupCalls).toHaveLength(1);
      expect(tabDocumentNamespaces.get(101)?.has('doc-nav-1')).toBe(true);

      // Simulate tab loading (navigation)
      tabDocumentNamespaces.delete(101);

      // Next call should re-allocate because tab cache was cleared
      await executeInPage({ tabId: 101, allFrames: true }, 'inPageDOMPruner', []);
      expect(setupCalls).toHaveLength(2);
    });
  });
});
