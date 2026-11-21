import { afterEach, expect, it, vi } from 'vitest';
import { closeTabsTool, navigateTool } from '../entrypoints/background/tools/browser/common';
import { getMarkdownTool } from '../entrypoints/background/tools/browser/get-markdown';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { tabFaviconManager } from '../entrypoints/background/tools/browser/tab-favicon';
import { tabGroupManager } from '../entrypoints/background/tools/browser/tab-group-manager';

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
  const payload = JSON.parse(result.content[0].text as string);
  expect(payload).toMatchObject({
    success: true,
    created: true,
    tabId: 22,
    windowId: 2,
    url,
  });
});

it('returns created page identity when agentWindowMode is window and newTab is requested', async () => {
  const url = 'http://127.0.0.1:43210/';
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 88, windowId: 9, url })),
      update: vi.fn(),
    },
    windows: {
      create: vi.fn(async () => ({ id: 9, tabs: [{ id: 88, windowId: 9, pendingUrl: url }] })),
    },
    storage: { local: { get: vi.fn(async () => ({ agentWindowMode: 'window' })) } },
  });
  vi.spyOn(navigateTool as any, 'tryGetTab').mockResolvedValue(undefined);
  vi.spyOn(navigateTool as any, 'waitForTabNavigationComplete').mockResolvedValue(undefined);
  vi.spyOn(tabFaviconManager, 'setAgentFavicon').mockResolvedValue(undefined);

  const result = await navigateTool.execute({
    url,
    newTab: true,
    background: true,
    autoGroup: false,
  });
  expect(result.isError).toBe(false);
  const payload = JSON.parse(result.content[0].text as string);
  expect(payload).toMatchObject({
    success: true,
    message: 'Opened URL in new window',
    created: true,
    tabId: 88,
    windowId: 9,
    url,
  });
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

it('restores focus to an active Chrome window when creating a background window', async () => {
  const url = 'https://example.org/bg';
  const windowsUpdate = vi.fn(async () => ({}));
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 33, windowId: 20, url })),
    },
    windows: {
      getLastFocused: vi.fn(async () => ({ id: 1, focused: true })),
      create: vi.fn(async () => ({ id: 20, tabs: [{ id: 33, windowId: 20, url }] })),
      update: windowsUpdate,
    },
    storage: { local: { get: vi.fn(async () => ({ agentWindowMode: 'window' })) } },
  });
  vi.spyOn(navigateTool as any, 'tryGetTab').mockResolvedValue(undefined);
  vi.spyOn(navigateTool as any, 'waitForTabNavigationComplete').mockResolvedValue(undefined);
  vi.spyOn(tabFaviconManager, 'setAgentFavicon').mockResolvedValue(undefined);

  const result = await navigateTool.execute({
    url,
    newTab: true,
    background: true,
    autoGroup: false,
  });
  expect(result.isError).toBe(false);
  expect(windowsUpdate).toHaveBeenCalledWith(1, { focused: true });
});

it('ungroups closing agent-managed tabs before chrome.tabs.remove', async () => {
  const events: string[] = [];
  const groupedTab = { id: 501, windowId: 1, groupId: 77, url: 'http://localhost:3000/' };
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async () => groupedTab),
      ungroup: vi.fn(async (ids: number[]) => {
        events.push(`ungroup:${ids.join(',')}`);
      }),
      remove: vi.fn(async (ids: number[]) => {
        events.push(`remove:${ids.join(',')}`);
      }),
      query: vi.fn(async () => []),
    },
    tabGroups: {
      query: vi.fn(async () => []),
    },
    storage: {
      local: { get: vi.fn(async () => ({})) },
      session: { get: vi.fn(async () => ({})) },
    },
  });
  vi.spyOn(tabFaviconManager, 'restoreFavicon').mockResolvedValue(undefined);
  vi.spyOn(tabGroupManager, 'ensureStorageLoaded').mockResolvedValue(undefined);
  vi.spyOn(tabGroupManager, 'isAgentTab').mockReturnValue(true);
  vi.spyOn(tabGroupManager, 'cleanupEmptyOrOrphanGroups').mockResolvedValue(0);
  tabGroupManager.registerAgentTab(501);

  const result = await closeTabsTool.execute({ tabIds: [501] });
  expect(result.isError).toBe(false);
  expect(events).toEqual(['ungroup:501', 'remove:501']);
});

it('returns an explicit string error when get_markdown hits a Chrome error page', async () => {
  vi.spyOn(getMarkdownTool as any, 'resolveAffinityTab').mockResolvedValue({
    id: 601,
    url: 'http://127.0.0.1:9999/',
  });
  vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
    {
      documentId: '',
      frameId: 0,
      result: {
        error: 'Frame with ID 0 is showing error page',
        isErrorPage: true,
        success: false,
      } as any,
    },
  ]);

  const result = await getMarkdownTool.execute({ tabId: 601 });
  expect(result.isError).toBe(true);
  expect(typeof result.content[0].text).toBe('string');
  expect(result.content[0].text).toContain('Cannot extract markdown from error page');
});
