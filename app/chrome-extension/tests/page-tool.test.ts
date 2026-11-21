import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTool } from '../entrypoints/background/tools/browser/page';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

describe('PageTool', () => {
  const tab = { id: 12, windowId: 3, url: 'https://example.com/' };
  let tool: PageTool;

  beforeEach(() => {
    tool = new PageTool();
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async () => tab),
        query: vi.fn(async () => [tab]),
        move: vi.fn(async (tabId: number, moveProperties: chrome.tabs.MoveProperties) => ({
          ...tab,
          id: tabId,
          index: moveProperties.index,
          windowId: moveProperties.windowId ?? tab.windowId,
        })),
      },
      windows: {
        update: vi.fn(async (windowId: number) => ({ id: windowId, focused: true })),
        remove: vi.fn(async () => undefined),
      },
    };
  });

  it('moves only the explicit tab ID to the explicit window and index', async () => {
    const response = await tool.execute({
      action: 'tab_move',
      tabId: 12,
      windowId: 3,
      index: 0,
    });
    expect(response.isError).toBe(false);
    expect(chrome.tabs.move).toHaveBeenCalledWith(12, { index: 0, windowId: 3 });
  });

  it('closes only the explicit window ID', async () => {
    const response = await tool.execute({ action: 'window_close', windowId: 42 });
    expect(response.isError).toBe(false);
    expect(chrome.windows.remove).toHaveBeenCalledWith(42);
  });

  it('returns a bounded links result for an observed ref', async () => {
    vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
      {
        result: [
          { url: 'https://example.com/1', text: 'One', internal: true, nofollow: false },
          { url: 'https://example.com/2', text: 'Two', internal: true, nofollow: false },
        ],
      },
    ] as any);

    const response = await tool.execute({
      action: 'text_links',
      tabId: 12,
      frameId: 5,
      index: 9,
      limit: 1,
    });

    expect(inPageEngine.executeInPage).toHaveBeenCalledWith(
      { tabId: 12, frameIds: [5] },
      'inPageGetLinks',
      [{ index: 9, sameOriginOnly: false }],
    );
    expect(response.structuredContent).toMatchObject({
      count: 1,
      totalCount: 2,
      truncated: true,
      links: [{ text: 'One' }],
    });
  });

  it('reports a missing explicitly scoped target', async () => {
    vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValueOnce([{ result: null, frameId: 0 }]);
    expect(
      (await tool.execute({ action: 'text_links', tabId: 12, selector: '#missing' })).isError,
    ).toBe(true);
  });
});
