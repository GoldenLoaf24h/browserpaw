import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeInPage,
  injectedTabs,
  tabDocumentNamespaces,
} from '../entrypoints/background/tools/browser/in-page-engine';

vi.mock('../entrypoints/background/tools/browser/index-namespace', () => ({
  reserveIndexNamespaces: vi.fn(async (count: number) =>
    Array.from({ length: count }, (_, i) => (i + 1) * 2 ** 24),
  ),
}));

describe('read-only frame observations isolate renderer failures', () => {
  beforeEach(() => {
    injectedTabs.clear();
    tabDocumentNamespaces.clear();
    vi.useFakeTimers();
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 1, url: 'https://example.com' } as any);
    chrome.scripting = { executeScript: vi.fn() } as any;
    chrome.webNavigation.getAllFrames = vi.fn(async () => [
      { frameId: 0, documentId: 'main' },
      { frameId: 9, documentId: 'blocked' },
    ]) as any;
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async (options: any) => {
      const documentId = options.target.documentIds?.[0];
      if (options.target.allFrames || documentId === 'blocked') return new Promise(() => {});
      if (options.files) return [{ frameId: 0, documentId: 'main' }] as any;
      if (typeof options.args?.[0] === 'number')
        return [{ frameId: 0, documentId: 'main', result: true }] as any;
      return [
        {
          frameId: 0,
          documentId: 'main',
          result: {
            engineType: 'object',
            fnType: 'function',
            singleTurn: true,
            status: 'success',
            value: { treeString: 'main content', indexedElements: [] },
          },
        },
      ] as any;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['inPageDOMPruner', 'inPageFastSnapshot'])(
    '%s preserves the readable document and reports the timed-out document',
    async (name) => {
      const pending = executeInPage({ tabId: 1, allFrames: true }, name, []);
      const checked = expect(pending).resolves.toMatchObject([
        { frameId: 0, documentId: 'main', result: { treeString: 'main content' } },
        { frameId: 9, documentId: 'blocked', error: expect.stringContaining('timeout') },
      ]);
      await vi.advanceTimersByTimeAsync(4001);
      await checked;
      const calls = vi.mocked(chrome.scripting.executeScript).mock.calls;
      expect(calls.every(([options]) => !options.target.allFrames)).toBe(true);
      expect(calls.every(([options]) => options.injectImmediately === true)).toBe(true);
      expect(
        calls.filter(([options]) => options.target.documentIds?.[0] === 'blocked'),
      ).toHaveLength(1);
      expect(
        calls.filter(([options]) => (options as any).args?.[0] === '__MCP_INPAGE__'),
      ).toHaveLength(1);
    },
  );

  it('keeps arbitrary all-frame entrypoints on their original dispatch path', async () => {
    const pending = executeInPage({ tabId: 1, allFrames: true }, 'inPageClick', []);
    const checked = expect(pending).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(4001);
    await checked;
    expect(chrome.webNavigation.getAllFrames).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('keeps a child error page attached to its actual document instead of the main frame', async () => {
    const execute = vi.mocked(chrome.scripting.executeScript).getMockImplementation()!;
    vi.mocked(chrome.scripting.executeScript).mockImplementation((options: any) => {
      if (options.target.documentIds?.[0] === 'blocked')
        return Promise.reject(new Error('Frame is showing error page'));
      return execute(options);
    });
    const results = await executeInPage<any>({ tabId: 1, allFrames: true }, 'inPageDOMPruner', []);
    expect(results).toMatchObject([
      { frameId: 0, documentId: 'main', result: { treeString: 'main content' } },
      { frameId: 9, documentId: 'blocked', result: { isErrorPage: true } },
    ]);
  });
});
