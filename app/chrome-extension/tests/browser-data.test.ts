import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bookmarkDuplicates,
  bookmarksTool,
  cookiesTool,
  historyTool,
  storageTool,
} from '../entrypoints/background/tools/browser/browser-data';

afterEach(() => vi.unstubAllGlobals());

describe('browser data tools', () => {
  it('aggregates visits inside the requested window rather than using lifetime totals', async () => {
    const search = vi.fn().mockResolvedValue([
      { url: 'https://a.example/1', visitCount: 500 },
      { url: 'https://b.example/2', visitCount: 1 },
    ]);
    const getVisits = vi
      .fn()
      .mockResolvedValueOnce([{ visitTime: 5 }])
      .mockResolvedValueOnce([{ visitTime: 15 }]);
    vi.stubGlobal('chrome', { history: { search, getVisits } });
    const response = await historyTool.execute({ action: 'top', since: 10, until: 20 });
    expect(response.structuredContent).toMatchObject({
      sampledUrls: 2,
      domains: [{ domain: 'b.example', visits: 1, lastVisit: 15 }],
    });
  });

  it('deduplicates exact URLs inside each folder and preserves fragment variants', () => {
    const bookmark = (id: string, url: string, dateAdded: number) => ({
      id,
      title: id,
      url,
      dateAdded,
      parentId: '4',
    });
    expect(
      bookmarkDuplicates([
        bookmark('1', 'https://example.com/#a', 40),
        bookmark('2', 'https://example.com/#a', 20),
        bookmark('3', 'https://example.com/#b', 10),
        { id: '5', title: 'Other', children: [bookmark('6', 'https://example.com/#a', 5)] },
      ]),
    ).toEqual([{ folderId: '4', url: 'https://example.com/#a', keep: '2', remove: ['1'] }]);
  });

  it('preflights nonempty folders before deleting any selected bookmark', async () => {
    const remove = vi.fn();
    vi.stubGlobal('chrome', {
      bookmarks: {
        get: vi.fn().mockResolvedValue([
          { id: 'book', url: 'https://example.com', parentId: '4' },
          { id: 'folder', parentId: '4' },
        ]),
        getChildren: vi.fn().mockResolvedValue([{ id: 'child' }]),
        remove,
      },
    });
    const response = await bookmarksTool.execute({ action: 'rm', ids: ['book', 'folder'] });
    expect(response.isError).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it('omits cookie values by default', async () => {
    vi.stubGlobal('chrome', {
      cookies: {
        getAll: vi
          .fn()
          .mockResolvedValue([{ name: 'login', value: 'fixture', domain: 'example.com' }]),
      },
    });
    expect((await cookiesTool.execute({ action: 'list' })).structuredContent?.items).toEqual([
      { name: 'login', domain: 'example.com' },
    ]);
  });

  it('binds storage to a specific main document', async () => {
    const executeScript = vi.fn().mockResolvedValue([{ result: { key: 'name', value: 'value' } }]);
    vi.stubGlobal('chrome', {
      webNavigation: {
        getFrame: vi
          .fn()
          .mockResolvedValue({ url: 'https://example.com/page', documentId: 'document-123' }),
      },
      scripting: { executeScript },
    });
    const response = await storageTool.execute({
      action: 'get',
      area: 'local',
      key: 'name',
      tabId: 5,
    });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 5, documentIds: ['document-123'] } }),
    );
    expect(response.structuredContent).toMatchObject({
      origin: 'https://example.com',
      key: 'name',
      value: 'value',
    });
  });
});
