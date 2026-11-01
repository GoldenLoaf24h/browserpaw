import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TabGroupManager,
  tabGroupManager,
} from '../entrypoints/background/tools/browser/tab-group-manager';
import { sessionTabAffinity } from '../utils/session-tab-affinity';
import { windowTool } from '../entrypoints/background/tools/browser/window';
import { tabGroupCreateTool } from '../entrypoints/background/tools/browser/tab-group';
import { webFetcherTool } from '../entrypoints/background/tools/browser/web-fetcher';
import { downloadsWatchdog } from '../entrypoints/background/watchdogs/downloads-watchdog';

describe('Ego Page Ledger & Tab Ownership MV3 Recovery Suite', () => {
  let mockTabs: any[];
  let mockGroups: Map<number, any>;
  let mockSessionStorage: Record<string, any>;
  let onCreatedListeners: Array<(tab: any) => void>;
  let onUpdatedListeners: Array<(tabId: number, changeInfo: any, tab: any) => void>;
  let onRemovedListeners: Array<(tabId: number) => void>;
  let nextGroupId = 100;
  let nextTabId = 2000;

  beforeEach(() => {
    nextGroupId = 100;
    nextTabId = 2000;
    mockSessionStorage = {};
    mockTabs = [
      { id: 10, windowId: 1, groupId: -1, url: 'https://user-reading.org', title: 'User Article' },
      { id: 20, windowId: 1, groupId: -1, url: 'https://my-work.com', title: 'Work Dashboard' },
    ];
    mockGroups = new Map();
    onCreatedListeners = [];
    onUpdatedListeners = [];
    onRemovedListeners = [];

    (globalThis as any).chrome = {
      storage: {
        session: {
          get: vi.fn(async (keys?: string | string[]) => {
            if (!keys) return { ...mockSessionStorage };
            if (typeof keys === 'string') {
              return { [keys]: mockSessionStorage[keys] };
            }
            const res: Record<string, any> = {};
            for (const k of keys) {
              if (mockSessionStorage[k] !== undefined) {
                res[k] = mockSessionStorage[k];
              }
            }
            return res;
          }),
          set: vi.fn(async (obj: Record<string, any>) => {
            Object.assign(mockSessionStorage, obj);
          }),
        },
      },
      tabs: {
        create: vi.fn(async (props: any) => {
          const tid = nextTabId++;
          const newT = {
            id: tid,
            windowId: props.windowId ?? 1,
            groupId: -1,
            url: props.url || '',
            title: props.title || '',
            status: 'complete',
            active: props.active ?? true,
          };
          mockTabs.push(newT);
          return newT;
        }),
        get: vi.fn(async (id: number) => {
          const t = mockTabs.find((x) => x.id === id);
          if (!t) throw new Error(`Tab ${id} not found`);
          return { ...t };
        }),
        query: vi.fn(async (q?: any) => {
          let list = [...mockTabs];
          if (typeof q?.groupId === 'number') {
            list = list.filter((t) => t.groupId === q.groupId);
          }
          if (typeof q?.windowId === 'number') {
            list = list.filter((t) => t.windowId === q.windowId);
          }
          if (q?.active) {
            list = list.filter((t) => t.active);
          }
          return list;
        }),
        group: vi.fn(
          async (opts: { tabIds: number[]; groupId?: number; createProperties?: any }) => {
            if (opts.groupId) {
              for (const tid of opts.tabIds) {
                const tab = mockTabs.find((x) => x.id === tid);
                if (tab) tab.groupId = opts.groupId;
              }
              return opts.groupId;
            }
            const gid = nextGroupId++;
            mockGroups.set(gid, {
              id: gid,
              windowId: opts.createProperties?.windowId ?? 1,
              title: '',
              color: 'blue',
            });
            for (const tid of opts.tabIds) {
              const tab = mockTabs.find((x) => x.id === tid);
              if (tab) tab.groupId = gid;
            }
            return gid;
          },
        ),
        ungroup: vi.fn(async (ids: number | number[]) => {
          const arr = Array.isArray(ids) ? ids : [ids];
          for (const tid of arr) {
            const tab = mockTabs.find((x) => x.id === tid);
            if (tab) tab.groupId = -1;
          }
        }),
        remove: vi.fn(async (ids: number | number[]) => {
          const arr = Array.isArray(ids) ? ids : [ids];
          mockTabs = mockTabs.filter((t) => !arr.includes(t.id));
        }),
        sendMessage: vi.fn(async () => ({ success: true, textContent: 'Sample Page Text' })),
        update: vi.fn(async (id: number, props: any) => {
          const t = mockTabs.find((x) => x.id === id);
          if (t) Object.assign(t, props);
          return t;
        }),
        onCreated: {
          addListener: vi.fn((fn) => onCreatedListeners.push(fn)),
          removeListener: vi.fn(),
        },
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: {
          addListener: vi.fn((fn) => onUpdatedListeners.push(fn)),
          removeListener: vi.fn(),
        },
        onRemoved: {
          addListener: vi.fn((fn) => onRemovedListeners.push(fn)),
          removeListener: vi.fn(),
        },
      },
      tabGroups: {
        get: vi.fn(async (gid: number) => {
          const g = mockGroups.get(gid);
          if (!g) throw new Error(`Group ${gid} not found`);
          return { ...g };
        }),
        query: vi.fn(async () => Array.from(mockGroups.values())),
        update: vi.fn(async (gid: number, props: any) => {
          const g = mockGroups.get(gid);
          if (g) Object.assign(g, props);
          return g;
        }),
        remove: vi.fn(async (gid: number) => {
          mockGroups.delete(gid);
        }),
        onRemoved: { addListener: vi.fn() },
      },
      windows: {
        getAll: vi.fn(async () => [
          {
            id: 1,
            focused: true,
            state: 'normal',
            tabs: mockTabs,
          },
        ]),
        update: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: { success: true } }]),
      },
    };

    tabGroupManager.resetForTest();
    sessionTabAffinity.clearAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports source-download support and per-page records without filename matching', async () => {
    vi.spyOn(downloadsWatchdog, 'ensureReady').mockResolvedValue(undefined);
    vi.spyOn(downloadsWatchdog, 'sourceTrackingAvailable', 'get').mockReturnValue(true);
    vi.spyOn(downloadsWatchdog, 'getPageDownloads').mockImplementation(
      (tabId) => [{ guid: `g-${tabId}`, tabId, suggestedFilename: 'same.txt' }] as any,
    );
    const response = await windowTool.execute();
    const data = JSON.parse((response.content[0] as any).text);
    expect(data.capabilities).toEqual({ sourceDownloads: true });
    expect(data.windows[0].tabs[0].downloads).toEqual([
      { guid: 'g-10', tabId: 10, suggestedFilename: 'same.txt' },
    ]);
    expect(data.windows[0].tabs[1].downloads[0].guid).toBe('g-20');
  });

  // =========================================================================
  // 1. 新建任务页与 popup 归属不会在 worker 重启后丢失 (Parent is owned)
  // =========================================================================
  it('1. New task page and popup attribution survive MV3 worker restart without loss', async () => {
    mockTabs.push({ id: 101, windowId: 1, groupId: -1, url: 'https://agent-task.com' });
    tabGroupManager.registerAgentTab(101);
    sessionTabAffinity.setAffinity('session-alpha', 101);

    mockTabs.push({
      id: 102,
      windowId: 1,
      groupId: -1,
      openerTabId: 101,
      url: 'https://agent-task.com/oauth',
    });
    sessionTabAffinity.handleChildTabActivated(
      102,
      101,
      'https://agent-task.com/oauth',
      'OAuth Popup',
      'session-alpha',
    );

    await new Promise((r) => setTimeout(r, 60));

    expect(tabGroupManager.isAgentTab(101)).toBe(true);
    expect(tabGroupManager.isAgentTab(102)).toBe(true);
    expect(sessionTabAffinity.getAffinity('session-alpha')).toBe(102);

    await tabGroupManager.saveToStorage();
    await sessionTabAffinity.saveToStorage();

    // Simulate MV3 Service Worker restart
    tabGroupManager.resetForTest();
    (sessionTabAffinity as any).affinityMap.clear();
    (sessionTabAffinity as any).tabLineage.clear();

    await (tabGroupManager as any).loadFromStorage();
    await (sessionTabAffinity as any).loadFromStorage();

    expect(tabGroupManager.isAgentTab(101)).toBe(true);
    expect(tabGroupManager.isAgentTab(102)).toBe(true);
    expect(sessionTabAffinity.getAffinity('session-alpha')).toBe(102);
  });

  // =========================================================================
  // 2. 主审核心：User parent 仅被 setAffinity，其派生的 popup 保持 unknown 不 owned
  // =========================================================================
  it('2. User parent with session affinity spawns popup -> routes affinity but remains unmanaged (NOT owned)', async () => {
    mockTabs.push({
      id: 50,
      windowId: 1,
      groupId: -1,
      url: 'https://my-bank.com',
      title: 'Personal Bank',
    });
    sessionTabAffinity.setAffinity('user-session', 50);

    expect(sessionTabAffinity.getAffinity('user-session')).toBe(50);
    expect(tabGroupManager.isAgentTab(50)).toBe(false);

    mockTabs.push({
      id: 51,
      windowId: 1,
      groupId: -1,
      openerTabId: 50,
      url: 'https://my-bank.com/2fa',
    });
    sessionTabAffinity.handleChildTabActivated(
      51,
      50,
      'https://my-bank.com/2fa',
      '2FA Prompt',
      'user-session',
    );

    await new Promise((r) => setTimeout(r, 60));

    // Session affinity correctly routes to the popup child tab
    expect(sessionTabAffinity.getAffinity('user-session')).toBe(51);

    // CRITICAL SECURITY ASSERTION:
    // Neither parent tab 50 nor popup tab 51 must ever become agent owned!
    expect(tabGroupManager.isAgentTab(50)).toBe(false);
    expect(tabGroupManager.isAgentTab(51)).toBe(false);

    // Managed cleanup must NOT close the user popup or user parent
    await tabGroupManager.closeAllManagedGroups();
    await tabGroupManager.cleanupEmptyOrOrphanGroups();

    expect(mockTabs.some((t) => t.id === 50)).toBe(true);
    expect(mockTabs.some((t) => t.id === 51)).toBe(true);
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(expect.arrayContaining([50]));
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(expect.arrayContaining([51]));
  });

  // =========================================================================
  // 3. 主审核心：ensureAgentTabGroup 管理已有 user 标签页分组，但绝不自动授权 ownership
  // =========================================================================
  it('3. ensureAgentTabGroup organizes tabs into groups but strictly does NOT confer ownership', async () => {
    // Tab 30 is an existing user page
    const userTab = {
      id: 30,
      windowId: 1,
      groupId: -1,
      url: 'https://my-docs.com',
      title: 'User Document',
    };
    mockTabs.push(userTab);

    // Auto-group / ensureAgentTabGroup is called for tab 30
    const gid = await tabGroupManager.ensureAgentTabGroup(30, { title: 'AutoGrouped Task' });
    expect(gid).toBeDefined();
    expect(mockTabs.find((t) => t.id === 30)?.groupId).toBe(gid);

    // CRITICAL ASSERTION: Tab 30 must remain UNMANAGED (NOT owned) despite being in an agent group!
    expect(tabGroupManager.isAgentTab(30)).toBe(false);

    // Close all managed groups -> tab 30 must be safely ungrouped, NOT closed!
    await tabGroupManager.closeAllManagedGroups();

    expect(mockTabs.some((t) => t.id === 30)).toBe(true);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([30]);
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(expect.arrayContaining([30]));
  });

  // =========================================================================
  // 4. 主审核心：tabGroupCreateTool 显式分组用户页，cleanup 时只 ungroup 绝不 close
  // =========================================================================
  it('4. Explicit tab_group tool groups user tabs without conferring ownership; cleanup only ungroups them', async () => {
    const userTabA = {
      id: 40,
      windowId: 1,
      groupId: -1,
      url: 'https://article.com/1',
      title: 'Article 1',
    };
    const userTabB = {
      id: 41,
      windowId: 1,
      groupId: -1,
      url: 'https://article.com/2',
      title: 'Article 2',
    };
    mockTabs.push(userTabA, userTabB);

    // Agent or user calls chrome_tab_group tool to group existing user tabs
    const groupResult = await tabGroupCreateTool.execute({
      tabIds: [40, 41],
      title: 'Explicit User Group',
      color: 'green',
    });
    expect(groupResult.isError).toBe(false);

    // Group created successfully
    expect(mockTabs.find((t) => t.id === 40)?.groupId).toBeGreaterThan(0);
    expect(mockTabs.find((t) => t.id === 41)?.groupId).toBeGreaterThan(0);

    // CRITICAL SECURITY ASSERTION:
    // Neither tab 40 nor tab 41 becomes an agent tab!
    expect(tabGroupManager.isAgentTab(40)).toBe(false);
    expect(tabGroupManager.isAgentTab(41)).toBe(false);

    // When closing managed groups, tabs 40 & 41 must be ungrouped, NEVER closed!
    const closedCount = await tabGroupManager.closeAllManagedGroups();
    expect(closedCount).toBe(1);

    expect(mockTabs.some((t) => t.id === 40)).toBe(true);
    expect(mockTabs.some((t) => t.id === 41)).toBe(true);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([40, 41]);
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(expect.arrayContaining([40]));
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(expect.arrayContaining([41]));
  });

  // =========================================================================
  // 5. 主审核心：webFetcherTool 仅在新建自有页面时登记 ownership，复用现有页不登记
  // =========================================================================
  it('5. webFetcherTool registers ownership only for freshly created tabs, not existing tabs', async () => {
    // 1. Fetching non-existent URL creates a new tab -> MUST be registered as owned!
    const freshResult = await webFetcherTool.execute({
      url: 'https://example-new-fetch.com',
      textContent: true,
      background: true,
    });
    expect(freshResult.isError).toBe(false);

    const createdTab = mockTabs.find((t) => t.url === 'https://example-new-fetch.com');
    expect(createdTab).toBeDefined();
    expect(tabGroupManager.isAgentTab(createdTab!.id)).toBe(true);

    // 2. Fetching existing user URL (tab 10: https://user-reading.org) -> MUST NOT register ownership!
    expect(tabGroupManager.isAgentTab(10)).toBe(false);
    const existingResult = await webFetcherTool.execute({
      url: 'https://user-reading.org',
      textContent: true,
      background: true,
    });
    expect(existingResult.isError).toBe(false);

    // Tab 10 must STILL be unmanaged
    expect(tabGroupManager.isAgentTab(10)).toBe(false);
  });

  // =========================================================================
  // 6. 主审核心：agentCreationInProgress 期间 user 打开同 URL 新页保持 unknown，仅实际 returned 成为 owned
  // =========================================================================
  it('6. User creates tab during pending agent tab creation -> user tab remains unknown, only returned tab is owned', async () => {
    const targetUrl = 'https://shop.example.com/item/42';

    // Agent begins tab creation flow
    tabGroupManager.beginAgentTabCreation();

    // User concurrently opens a tab with identical URL
    const concurrentUserTab = {
      id: 666,
      windowId: 1,
      groupId: -1,
      url: targetUrl,
      title: 'Item 42',
    };
    mockTabs.push(concurrentUserTab);

    tabGroupManager.registerEventListeners();
    for (const fn of onCreatedListeners) {
      await fn(concurrentUserTab);
    }

    // Concurrent user tab MUST NOT be claimed as an agent tab!
    expect(tabGroupManager.isAgentTab(666)).toBe(false);

    // Returned agent tab 777 arrives from chrome.tabs.create
    const actualAgentTab = {
      id: 777,
      windowId: 1,
      groupId: -1,
      url: targetUrl,
      title: 'Item 42',
    };
    mockTabs.push(actualAgentTab);
    tabGroupManager.endAgentTabCreation(777);

    // Only returned tab 777 is owned!
    expect(tabGroupManager.isAgentTab(777)).toBe(true);
    expect(tabGroupManager.isAgentTab(666)).toBe(false);

    await tabGroupManager.cleanupEmptyOrOrphanGroups();
    expect(mockTabs.some((t) => t.id === 666)).toBe(true);
  });

  // =========================================================================
  // 7. 主审核心：新页名 New Tab / blank 依然可以是 Agent 自有页，不能靠 URL 剥离 ownership
  // =========================================================================
  it('7. Agent owned tab with title "New Tab" or blank URL is NEVER stripped of ownership', async () => {
    // Agent explicitly registers tab 105 as owned
    mockTabs.push({
      id: 105,
      windowId: 1,
      groupId: 101,
      url: 'chrome://newtab/',
      title: 'New Tab',
    });
    tabGroupManager.registerAgentTab(105);
    expect(tabGroupManager.isAgentTab(105)).toBe(true);

    tabGroupManager.registerEventListeners();

    // Tab update event fires while page is still in initial New Tab state
    for (const fn of onUpdatedListeners) {
      await fn(105, { status: 'loading' }, {
        id: 105,
        groupId: 101,
        url: 'chrome://newtab/',
        title: 'New Tab',
      } as any);
    }

    // CRITICAL ASSERTION: Ownership is strictly preserved; tab is NOT ejected from agent tab set!
    expect(tabGroupManager.isAgentTab(105)).toBe(true);
    expect(chrome.tabs.ungroup).not.toHaveBeenCalledWith(105);
  });

  // =========================================================================
  // 8. 恢复期间并发 registerAgentTab 不会被旧快照清理掉 (Candidate Isolation)
  // =========================================================================
  it('8. Concurrent tab registration during storage recovery is not purged by stale query snapshot', async () => {
    mockSessionStorage['tab_group_manager_agent_tabs'] = [10];

    let resolveQuery: (tabs: any[]) => void;
    const pendingQueryPromise = new Promise<any[]>((resolve) => {
      resolveQuery = resolve;
    });

    const origQuery = chrome.tabs.query;
    (chrome.tabs.query as any) = vi.fn(() => pendingQueryPromise);

    tabGroupManager.resetForTest();
    const loadPromise = (tabGroupManager as any).loadFromStorage();

    // Concurrent registration for tab 777 while query is in-flight
    mockTabs.push({ id: 777, windowId: 1, groupId: -1 });
    tabGroupManager.registerAgentTab(777);
    expect(tabGroupManager.isAgentTab(777)).toBe(true);

    // Stale snapshot resolves with only tab 10 (lacks tab 777)
    resolveQuery!([{ id: 10, windowId: 1 }]);
    await loadPromise;

    (chrome.tabs.query as any) = origQuery;

    // VERIFICATION: Tab 777 is preserved!
    expect(tabGroupManager.isAgentTab(10)).toBe(true);
    expect(tabGroupManager.isAgentTab(777)).toBe(true);
  });

  // =========================================================================
  // 9. 存储写入失败 fail-safe，不产生 unhandled rejection，且默认不关闭未知 tab
  // =========================================================================
  it('9. Storage write failures fail-safe, log errors, and never close unmanaged tabs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    tabGroupManager.registerAgentTab(10);
    expect(tabGroupManager.isAgentTab(10)).toBe(true);
    await tabGroupManager.saveToStorage();

    (chrome.storage.session.set as any).mockImplementation(async () => {
      throw new Error('QuotaExceededError');
    });

    tabGroupManager.registerAgentTab(15);
    await new Promise((r) => setTimeout(r, 40));

    expect(errorSpy).toHaveBeenCalled();
    expect(tabGroupManager.isAgentTab(10)).toBe(true);
    expect(tabGroupManager.isAgentTab(15)).toBe(true);

    await expect(tabGroupManager.saveToStorage()).rejects.toThrow('QuotaExceededError');
    expect(tabGroupManager.isAgentTab(20)).toBe(false);
  });

  // =========================================================================
  // 10. WindowTool 反映真实的 isAgentManaged 状态
  // =========================================================================
  it('10. WindowTool accurately reflects isAgentManaged status without regressions', async () => {
    mockTabs[0].status = 'loading';
    mockTabs[0].pendingUrl = 'https://example.com/next?token=sensitive-value';
    mockTabs[1].status = 'loading';
    tabGroupManager.registerAgentTab(10);

    const res = await windowTool.execute();
    expect(res.isError).toBe(false);

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.windowCount).toBe(1);
    expect(parsed.windows[0].tabs).toHaveLength(2);

    const tab10 = parsed.windows[0].tabs.find((t: any) => t.tabId === 10);
    const tab20 = parsed.windows[0].tabs.find((t: any) => t.tabId === 20);

    expect(tab10.isAgentManaged).toBe(true);
    expect(tab20.isAgentManaged).toBe(false);
    expect(tab10.pendingUrl).toBe('https://example.com/next?token=REDACTED');
    expect(tab20.pendingUrl).toBeNull();
  });
  // =========================================================================
  // 11. 主审核心：恢复期间 session affinity prune 不会误删已并发重绑到新 tab 的映射
  // =========================================================================
  it('11. Session affinity recovery prune does NOT delete session if session was rebound to new tab concurrently', async () => {
    // Storage has dead binding: session-race -> tab 999 (not in open tabs)
    mockSessionStorage['session_tab_affinity_map'] = { 'session-race': 999 };

    let resolveQuery: (tabs: any[]) => void;
    const pendingQuery = new Promise<any[]>((resolve) => {
      resolveQuery = resolve;
    });

    const origQuery = chrome.tabs.query;
    (chrome.tabs.query as any) = vi.fn(() => pendingQuery);

    sessionTabAffinity.clearAll();
    const loadPromise = (sessionTabAffinity as any).loadFromStorage();

    // Concurrent request re-binds session-race to live tab 10 before query snapshot returns!
    sessionTabAffinity.setAffinity('session-race', 10);
    expect(sessionTabAffinity.getAffinity('session-race')).toBe(10);

    // Stale snapshot returns: live tab 10 exists, dead tab 999 does not
    resolveQuery!([{ id: 10, windowId: 1 }]);
    await loadPromise;

    (chrome.tabs.query as any) = origQuery;

    // VERIFICATION: session-race MUST NOT be deleted because it now points to 10 (not dead 999)!
    expect(sessionTabAffinity.getAffinity('session-race')).toBe(10);
  });

  // =========================================================================
  // 12. 主审核心：onRemoved 时即便 affinityMap 未绑定该 tab，单独删除 tabLineage 也必须持久化
  // =========================================================================
  it('12. onRemoved persists state when tabLineage entry is deleted even if affinityMap was not bound', async () => {
    sessionTabAffinity.clearAll();

    // Directly record lineage for child tab 555 without binding session affinity
    (sessionTabAffinity as any).tabLineage.set(555, {
      parentTabId: 10,
      createdAt: Date.now(),
      active: false,
      url: 'https://popup.example.com',
    });
    await sessionTabAffinity.saveToStorage();

    expect(mockSessionStorage['session_tab_affinity_lineage']['555']).toBeDefined();

    // Register listeners
    (sessionTabAffinity as any).initListeners();

    // Trigger tab removal for tab 555
    for (const fn of onRemovedListeners) {
      fn(555);
    }

    // Wait microtask for persistState queue to flush
    await new Promise((r) => setTimeout(r, 40));

    // VERIFICATION: tabLineage 555 is purged in memory AND persisted into storage!
    expect((sessionTabAffinity as any).tabLineage.has(555)).toBe(false);
    expect(mockSessionStorage['session_tab_affinity_lineage']['555']).toBeUndefined();
  });
});
