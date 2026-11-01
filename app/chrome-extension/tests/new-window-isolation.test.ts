import { afterEach, expect, it, vi } from 'vitest';
import { navigateTool } from '../entrypoints/background/tools/browser/common';
import { tabFaviconManager } from '../entrypoints/background/tools/browser/tab-favicon';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('honors newWindow even when a matching user page already exists', async () => {
  const url = 'https://example.org/article';
  const existing = { id: 11, windowId: 1, url, active: false, groupId: -1 };
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [existing]),
      get: vi.fn(async () => existing),
      update: vi.fn(),
    },
    windows: {
      create: vi.fn(async () => ({ id: 2, tabs: [{ id: 22, windowId: 2, url }] })),
    },
    storage: { local: { get: vi.fn(async () => ({})) } },
  });
  vi.spyOn(navigateTool as any, 'tryGetTab').mockResolvedValue(undefined);
  vi.spyOn(navigateTool as any, 'waitForTabNavigationComplete').mockResolvedValue(undefined);
  vi.spyOn(tabFaviconManager, 'setAgentFavicon').mockResolvedValue(undefined);
  const result = await navigateTool.execute({
    url,
    newWindow: true,
    background: true,
    autoGroup: false,
  });
  expect(result.isError).toBe(false);
  expect(chrome.windows.create).toHaveBeenCalledWith(
    expect.objectContaining({ url, focused: false }),
  );
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(tabFaviconManager.setAgentFavicon).not.toHaveBeenCalledWith(11);
  expect(JSON.stringify(result)).toContain('22');
});

it('reports pending navigation instead of returning the previous page as the destination', async () => {
  const old = { id: 22, windowId: 2, url: 'https://example.org/old', active: false };
  const destination = 'https://example.org/new';
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ ...old, status: 'loading', pendingUrl: destination })),
      update: vi.fn(async () => ({})),
    },
  });
  vi.spyOn(navigateTool as any, 'tryGetTab').mockResolvedValue(old);
  vi.spyOn(navigateTool as any, 'navigateAndWait').mockImplementation(async (_id, action) =>
    action(),
  );
  vi.spyOn(navigateTool as any, 'ensureFocus').mockResolvedValue(undefined);
  vi.spyOn(tabFaviconManager, 'setAgentFavicon').mockResolvedValue(undefined);
  const response = await navigateTool.execute({
    tabId: 22,
    url: destination,
    background: true,
    autoGroup: false,
  });
  expect(chrome.tabs.update).toHaveBeenCalledWith(22, { url: destination });
  const result = JSON.parse(response.content[0].text as string);
  expect(result.url).toBe(destination);
  expect(result.navigationPending).toBe(true);
  expect(result.status).toBe('loading');
});
