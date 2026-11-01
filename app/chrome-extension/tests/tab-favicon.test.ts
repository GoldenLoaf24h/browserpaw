import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TabFaviconManager,
  AGENT_FAVICON_DATA_URL,
} from '../entrypoints/background/tools/browser/tab-favicon';

describe('TabFaviconManager (Glowing Agent Favicon & Clean Restoration)', () => {
  let manager: TabFaviconManager;
  let executedScriptArgs: any[] = [];
  let removedListener: ((tabId: number) => void) | undefined;
  let updatedListener: ((tabId: number, changeInfo: any) => void) | undefined;

  beforeEach(() => {
    executedScriptArgs = [];
    (globalThis as any).chrome = (globalThis as any).chrome || {};
    (globalThis as any).chrome.tabs = (globalThis as any).chrome.tabs || {};
    (globalThis as any).chrome.tabs.get = vi.fn(async (id: number) => ({
      id,
      url: 'https://example.com/dashboard',
      favIconUrl: 'https://example.com/favicon.ico',
    }));
    (globalThis as any).chrome.tabs.onRemoved = {
      addListener: vi.fn((fn: any) => {
        removedListener = fn;
      }),
      removeListener: vi.fn(),
    };
    (globalThis as any).chrome.tabs.onUpdated = {
      addListener: vi.fn((fn: any) => {
        updatedListener = fn;
      }),
      removeListener: vi.fn(),
    };
    if (!(globalThis as any).chrome.tabs.onCreated) {
      (globalThis as any).chrome.tabs.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
    }
    (globalThis as any).chrome.scripting = {
      executeScript: vi.fn(async (opts: any) => {
        executedScriptArgs.push(opts);
        return [{ result: true }];
      }),
    };

    manager = new TabFaviconManager();
  });

  it('records original favicon and injects agent glowing favicon', async () => {
    const ok = await manager.setAgentFavicon(10);
    expect(ok).toBe(true);
    expect(manager.getOriginalFavicon(10)).toBe('https://example.com/favicon.ico');
    expect(executedScriptArgs.length).toBe(1);
    expect(executedScriptArgs[0].args[0]).toBe(AGENT_FAVICON_DATA_URL);
  });

  it('restores original favicon cleanly when automation ends', async () => {
    await manager.setAgentFavicon(10);
    const restored = await manager.restoreFavicon(10);
    expect(restored).toBe(true);
    expect(manager.getOriginalFavicon(10)).toBeUndefined();
    expect(executedScriptArgs.length).toBe(2);
    expect(executedScriptArgs[1].args[0]).toBe('https://example.com/favicon.ico');
  });

  it('uses only current DOM markers and restores the original link after repeated activation', async () => {
    document.head.innerHTML = '<link rel="shortcut icon" href="https://example.com/favicon.ico">';
    (chrome.scripting.executeScript as any).mockImplementation(async (opts: any) => {
      opts.func(...opts.args);
      return [{ result: true }];
    });

    try {
      await manager.setAgentFavicon(10);
      await manager.setAgentFavicon(10);
      expect(document.querySelectorAll('link[data-browserpaw-injected="true"]')).toHaveLength(1);
      const markers = Array.from(document.querySelectorAll('link')).flatMap((link) =>
        link.getAttributeNames().filter((name) => name.startsWith('data-browser')),
      );
      expect(markers.sort()).toEqual([
        'data-browserpaw-injected',
        'data-browserpaw-original-favicon',
        'data-browserpaw-original-rel',
      ]);

      await manager.restoreFavicon(10);
      const links = document.querySelectorAll('link');
      expect(links).toHaveLength(1);
      expect(links[0].rel).toBe('shortcut icon');
      expect(links[0].href).toBe('https://example.com/favicon.ico');
      expect(
        links[0].getAttributeNames().filter((name) => name.startsWith('data-browser')),
      ).toEqual([]);
    } finally {
      document.head.innerHTML = '';
    }
  });

  it('safely skips restricted chrome:// URLs', async () => {
    (chrome.tabs.get as any).mockResolvedValueOnce({
      id: 20,
      url: 'chrome://settings',
      favIconUrl: undefined,
    });

    const ok = await manager.setAgentFavicon(20);
    expect(ok).toBe(false);
    expect(manager.getOriginalFavicon(20)).toBeUndefined();
    expect(executedScriptArgs.length).toBe(0);
  });

  it('tracks active tab through markTabActive and handleCallTool JSON parsing', async () => {
    const markSpy = vi.spyOn(manager, 'markTabActive');
    manager.markTabActive(77);
    expect(markSpy).toHaveBeenCalledWith(77);

    // Verify handleCallTool logic:
    const { handleCallTool } = await import('../entrypoints/background/tools/index');
    const { tabFaviconManager } =
      await import('../entrypoints/background/tools/browser/tab-favicon');
    const globalSpy = vi.spyOn(tabFaviconManager, 'markTabActive');

    (chrome.tabs as any).query = vi
      .fn()
      .mockResolvedValue([{ id: 42, url: 'https://example.com' }]);
    (chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 42, url: 'https://example.com' });
    (chrome.tabs as any).update = vi.fn().mockResolvedValue({ id: 42, url: 'https://example.com' });

    await handleCallTool({
      name: 'chrome_navigate',
      args: { url: 'https://example.com' },
    });

    expect(globalSpy).toHaveBeenCalledWith(42);
  }, 15000);

  it('clears and deletes idle timer and original favicon on tab removed', () => {
    const timer = setTimeout(() => {}, 100000);
    (manager as any).idleTimers.set(55, timer);
    (manager as any).originalFavicons.set(55, 'https://example.com/fav.ico');

    expect((manager as any).idleTimers.has(55)).toBe(true);
    expect((manager as any).originalFavicons.has(55)).toBe(true);

    removedListener?.(55);

    expect((manager as any).idleTimers.has(55)).toBe(false);
    expect((manager as any).originalFavicons.has(55)).toBe(false);
  });

  it('updates originalFavicon if initially null when onUpdated supplies favIconUrl', async () => {
    (chrome.tabs.get as any).mockResolvedValueOnce({
      id: 88,
      url: 'https://example.com/loading',
      favIconUrl: undefined,
    });

    await manager.setAgentFavicon(88);
    expect(manager.getOriginalFavicon(88)).toBeNull();

    // Now page finishes loading and fires onUpdated with real icon
    (chrome.tabs.get as any).mockResolvedValueOnce({
      id: 88,
      url: 'https://example.com/loading',
      favIconUrl: 'https://example.com/real-favicon.ico',
    });

    updatedListener?.(88, { favIconUrl: 'https://example.com/real-favicon.ico' });
    expect(manager.getOriginalFavicon(88)).toBe('https://example.com/real-favicon.ico');

    await new Promise((r) => setTimeout(r, 10));

    await manager.restoreFavicon(88);
    expect(executedScriptArgs[executedScriptArgs.length - 1].args[0]).toBe(
      'https://example.com/real-favicon.ico',
    );
  });

  it('rejects agent favicon data url in onUpdated so it does not poison original favicon', async () => {
    (chrome.tabs.get as any).mockResolvedValueOnce({
      id: 99,
      url: 'https://example.com/loading',
      favIconUrl: undefined,
    });

    await manager.setAgentFavicon(99);
    expect(manager.getOriginalFavicon(99)).toBeNull();

    // Browser fires onUpdated when the injected SVG link changes the tab favicon
    updatedListener?.(99, { favIconUrl: AGENT_FAVICON_DATA_URL });
    expect(manager.getOriginalFavicon(99)).toBeNull();
  });
});
