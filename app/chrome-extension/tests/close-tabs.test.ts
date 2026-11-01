import { describe, it, expect, vi, beforeEach } from 'vitest';
import { closeTabsTool } from '../entrypoints/background/tools/browser/common';
import { sessionTabAffinity } from '../utils/session-tab-affinity';
import { tabGroupManager } from '../entrypoints/background/tools/browser/tab-group-manager';
import * as browserIdentity from '../utils/browser-identity';

describe('CloseTabsTool (chrome_close_tabs)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionTabAffinity.clearAll();
  });

  it('rejects closing active tab without explicit confirmation or tabIds', async () => {
    const res = await closeTabsTool.execute({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('pass confirm: true or specify tabIds explicitly');
  });

  it('allows closing active tab when confirm: true is explicitly provided', async () => {
    const mockTabsQuery = vi.fn().mockResolvedValue([{ id: 101, active: true }]);
    const mockTabsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome.tabs as any).query = mockTabsQuery;
    (chrome.tabs as any).remove = mockTabsRemove;

    const res = await closeTabsTool.execute({ confirm: true });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.closedTabIds).toEqual([101]);
    expect(mockTabsRemove).toHaveBeenCalledWith(101);
  });

  it('closes session affinity tab without requiring confirm when sessionId has affinity', async () => {
    const mockTabsGet = vi.fn().mockImplementation(async (tid: number) => {
      if (tid === 202) return { id: 202, active: false };
      throw new Error('Tab not found');
    });
    const mockTabsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome.tabs as any).get = mockTabsGet;
    (chrome.tabs as any).remove = mockTabsRemove;

    // Set affinity
    sessionTabAffinity.setAffinity('session-agent-1', 202);
    expect(sessionTabAffinity.getAffinity('session-agent-1')).toBe(202);

    const res = await closeTabsTool.execute({ sessionId: 'session-agent-1' });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.closedTabIds).toEqual([202]);
    expect(parsed.message).toContain('session tab');
    expect(mockTabsRemove).toHaveBeenCalledWith(202);

    // Affinity should be cleaned up
    expect(sessionTabAffinity.getAffinity('session-agent-1')).toBeUndefined();
  });

  it('matches exact URLs without trailing slash properly', async () => {
    const mockTabsQuery = vi.fn().mockImplementation(async (queryInfo: any) => {
      if (queryInfo.url === 'https://example.com/login*') {
        return [{ id: 303, url: 'https://example.com/login', active: false }];
      }
      return [];
    });
    const mockTabsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome.tabs as any).query = mockTabsQuery;
    (chrome.tabs as any).remove = mockTabsRemove;

    const res = await closeTabsTool.execute({ url: 'https://example.com/login' });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.closedTabIds).toEqual([303]);
    expect(mockTabsRemove).toHaveBeenCalledWith([303]);
  });

  it('closes task-owned tabs only when document and browser identities still match', async () => {
    const mockTabsGet = vi.fn().mockResolvedValue({ id: 304, url: 'https://owned.example/' });
    const mockTabsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome.tabs as any).get = mockTabsGet;
    (chrome.tabs as any).remove = mockTabsRemove;
    (chrome.webNavigation as any).getFrame = vi.fn().mockResolvedValue({ documentId: 'doc-304' });
    vi.spyOn(tabGroupManager, 'ensureStorageLoaded').mockResolvedValue(undefined);
    vi.spyOn(tabGroupManager, 'isAgentTab').mockReturnValue(true);
    vi.spyOn(browserIdentity, 'getBrowserInstanceId').mockResolvedValue('browser-1');

    const expectedTabs = [{ tabId: 304, documentId: 'doc-304', browserInstanceId: 'browser-1' }];
    const res = await closeTabsTool.execute({ tabIds: [304], expectedTabs });

    expect(res.isError).toBe(false);
    expect(mockTabsRemove).toHaveBeenCalledWith([304]);
  });

  it('refuses task-owned tab cleanup when the document identity changed', async () => {
    const mockTabsGet = vi.fn().mockResolvedValue({ id: 305, url: 'https://new-page.example/' });
    const mockTabsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome.tabs as any).get = mockTabsGet;
    (chrome.tabs as any).remove = mockTabsRemove;
    (chrome.webNavigation as any).getFrame = vi
      .fn()
      .mockResolvedValue({ documentId: 'doc-after-navigation' });
    vi.spyOn(tabGroupManager, 'ensureStorageLoaded').mockResolvedValue(undefined);
    vi.spyOn(tabGroupManager, 'isAgentTab').mockReturnValue(true);
    vi.spyOn(browserIdentity, 'getBrowserInstanceId').mockResolvedValue('browser-1');

    const res = await closeTabsTool.execute({
      tabIds: [305],
      expectedTabs: [{ tabId: 305, documentId: 'doc-305', browserInstanceId: 'browser-1' }],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('document identity changed');
    expect(mockTabsRemove).not.toHaveBeenCalled();
  });

  it('safely handles fallback tab filtering without matching unrelated tabs containing URL in query string', async () => {
    const mockTabsQuery = vi.fn().mockImplementation(async (queryInfo: any) => {
      if (queryInfo.url) {
        // Simulate query returning empty (e.g. strict pattern mismatch)
        return [];
      }
      // Return all tabs for fallback
      return [
        { id: 401, url: 'https://example.com/login', active: false },
        { id: 402, url: 'https://google.com/search?q=https://example.com/login', active: false },
      ];
    });
    const mockTabsRemove = vi.fn().mockResolvedValue(undefined);
    (chrome.tabs as any).query = mockTabsQuery;
    (chrome.tabs as any).remove = mockTabsRemove;

    const res = await closeTabsTool.execute({ url: 'https://example.com/login' });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    // Should ONLY close 401, NOT 402 which merely has it in query string
    expect(parsed.closedTabIds).toEqual([401]);
    expect(mockTabsRemove).toHaveBeenCalledWith([401]);
  });
});
