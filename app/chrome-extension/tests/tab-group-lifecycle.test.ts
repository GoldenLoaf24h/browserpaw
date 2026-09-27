import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TabGroupManager } from '../entrypoints/background/tools/browser/tab-group-manager';

describe('TabGroupManager (Industrial Grouping, Zero-Orphan Cleanup & User Tab Isolation)', () => {
  let manager: TabGroupManager;
  let mockTabs: any[];
  let mockGroups: Map<number, any>;
  let nextGroupId = 100;
  let onCreatedListener: ((tab: any) => void) | null = null;
  let onUpdatedListener: ((tabId: number, changeInfo: any, tab: any) => void) | null = null;
  let onRemovedListener: ((tabId: number) => void) | null = null;

  beforeEach(() => {
    nextGroupId = 100;
    mockTabs = [
      { id: 1, windowId: 10, groupId: -1 },
      { id: 2, windowId: 10, groupId: -1 },
      { id: 3, windowId: 20, groupId: -1 },
    ];
    mockGroups = new Map();
    onCreatedListener = null;
    onUpdatedListener = null;
    onRemovedListener = null;

    (globalThis as any).chrome = {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        get: vi.fn(async (id: number) => {
          const t = mockTabs.find((x) => x.id === id);
          if (!t) throw new Error(`Tab ${id} not found`);
          return { ...t };
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
              windowId: opts.createProperties?.windowId ?? 10,
              title: '',
              color: 'grey',
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
        query: vi.fn(async (queryInfo: { groupId?: number }) => {
          if (typeof queryInfo?.groupId === 'number') {
            return mockTabs.filter((t) => t.groupId === queryInfo.groupId);
          }
          return [...mockTabs];
        }),
        remove: vi.fn(async (ids: number | number[]) => {
          const arr = Array.isArray(ids) ? ids : [ids];
          mockTabs = mockTabs.filter((t) => !arr.includes(t.id));
        }),
        onCreated: {
          addListener: vi.fn((fn) => {
            onCreatedListener = fn;
          }),
        },
        onUpdated: {
          addListener: vi.fn((fn) => {
            onUpdatedListener = fn;
          }),
        },
        onRemoved: {
          addListener: vi.fn((fn) => {
            onRemovedListener = fn;
          }),
        },
      },
      tabGroups: {
        get: vi.fn(async (gid: number) => {
          const g = mockGroups.get(gid);
          if (!g) throw new Error(`Group ${gid} not found`);
          return { ...g };
        }),
        query: vi.fn(async (queryInfo?: any) => {
          let all = Array.from(mockGroups.values());
          if (typeof queryInfo?.windowId === 'number') {
            all = all.filter((g) => g.windowId === queryInfo.windowId);
          }
          if (queryInfo?.title) {
            all = all.filter((g) => g.title === queryInfo.title);
          }
          return all;
        }),
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
    };

    manager = new TabGroupManager();
  });

  it('creates a new group with default title "Agent" and blue color', async () => {
    const gid = await manager.ensureAgentTabGroup(1);
    expect(gid).toBeDefined();
    const group = mockGroups.get(gid!);
    expect(group).toBeDefined();
    expect(group.title).toBe('Agent');
    expect(group.color).toBe('blue');
    expect(manager.getManagedGroupIds()).toContain(gid);
  });

  it('allows agent to specify custom task title and custom color', async () => {
    const gid = await manager.ensureAgentTabGroup(1, {
      title: '财务报表核对任务',
      color: 'green',
    });
    expect(gid).toBeDefined();
    const group = mockGroups.get(gid!);
    expect(group.title).toBe('财务报表核对任务');
    expect(group.color).toBe('green');
  });

  it('reuses existing managed group in the same window for subsequent tabs', async () => {
    const gid1 = await manager.ensureAgentTabGroup(1, { title: 'Agent' });
    const gid2 = await manager.ensureAgentTabGroup(2);
    expect(gid1).toBe(gid2);
    expect(mockTabs.find((t) => t.id === 1)?.groupId).toBe(gid1);
    expect(mockTabs.find((t) => t.id === 2)?.groupId).toBe(gid1);
  });

  it('strictly cleans up empty or orphan groups when all member tabs are removed (zero residue)', async () => {
    const gid = await manager.ensureAgentTabGroup(1);
    expect(manager.getManagedGroupIds()).toContain(gid);

    // Tab 1 is closed
    mockTabs = mockTabs.filter((t) => t.id !== 1);

    // Run cleanup
    const removedCount = await manager.cleanupEmptyOrOrphanGroups();
    expect(removedCount).toBe(1);
    expect(manager.getManagedGroupIds()).not.toContain(gid);
    expect(mockGroups.has(gid!)).toBe(false);
  });

  it('closes all member tabs and deletes group via closeManagedGroup', async () => {
    const gid = await manager.ensureAgentTabGroup(1);
    await manager.ensureAgentTabGroup(2);

    expect(mockTabs.filter((t) => t.groupId === gid).length).toBe(2);

    const success = await manager.closeManagedGroup(gid!);
    expect(success).toBe(true);
    expect(mockTabs.filter((t) => t.groupId === gid).length).toBe(0);
    expect(manager.getManagedGroupIds()).not.toContain(gid);
  });

  it('closes all Agent-managed tab groups via closeAllManagedGroups (Zero-Garbage guarantee)', async () => {
    const gid1 = await manager.ensureAgentTabGroup(1, { title: 'Group 1' });
    const gid2 = await manager.ensureAgentTabGroup(3, { title: 'Group 2', windowId: 999 });

    expect(manager.getManagedGroupIds().length).toBe(2);
    const count = await manager.closeAllManagedGroups();
    expect(count).toBe(2);
    expect(manager.getManagedGroupIds().length).toBe(0);
  });

  it('immediately ungroups user-opened tabs created in the same window from an agent tab group (onCreated)', async () => {
    const gid = await manager.ensureAgentTabGroup(1, { title: '12306' });
    expect(gid).toBeDefined();

    // User opens a new tab in the same window (e.g. Chrome places it into active tab's group)
    const userTab = {
      id: 999,
      windowId: 10,
      groupId: gid,
      url: 'chrome://newtab/',
      pendingUrl: 'chrome://newtab/',
    };
    mockTabs.push(userTab);

    expect(onCreatedListener).toBeDefined();
    await onCreatedListener!(userTab);

    // Assert chrome.tabs.ungroup was called for userTab
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith(999);
    expect(mockTabs.find((t) => t.id === 999)?.groupId).toBe(-1);
  });

  it('ejects non-agent user tabs from agent groups via onUpdated guard', async () => {
    const gid = await manager.ensureAgentTabGroup(1, { title: 'Agent' });
    expect(gid).toBeDefined();

    // User navigates or opens external page in an agent group
    const userTab = {
      id: 888,
      windowId: 10,
      groupId: gid,
      url: 'https://antigravity.google/auth-success',
    };
    mockTabs.push(userTab);

    expect(onUpdatedListener).toBeDefined();
    await onUpdatedListener!(888, { status: 'complete' }, userTab as any);

    expect(chrome.tabs.ungroup).toHaveBeenCalledWith(888);
    expect(mockTabs.find((t) => t.id === 888)?.groupId).toBe(-1);
  });

  it('safely preserves user tabs when closing managed groups (ungroups user tab, closes agent tab)', async () => {
    const gid = await manager.ensureAgentTabGroup(1, { title: 'Test Task' });
    expect(gid).toBeDefined();

    // Simulate an accidental user tab inside this group
    const userTab = {
      id: 777,
      windowId: 10,
      groupId: gid,
      url: 'https://user-private-doc.com',
    };
    mockTabs.push(userTab);

    // Call closeManagedGroup
    const success = await manager.closeManagedGroup(gid!);
    expect(success).toBe(true);

    // User tab 777 must have been ungrouped (not removed)
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([777]);
    expect(mockTabs.some((t) => t.id === 777)).toBe(true);

    // Agent tab 1 must have been removed
    expect(mockTabs.some((t) => t.id === 1)).toBe(false);
  });

  it('prunes dead tab IDs from agentTabIds during cleanup to avoid memory leaks', async () => {
    manager.registerAgentTab(1);
    manager.registerAgentTab(9999); // Dead tab ID that does not exist in chrome.tabs.query

    expect(manager.isAgentTab(9999)).toBe(true);

    await manager.cleanupEmptyOrOrphanGroups();

    expect(manager.isAgentTab(1)).toBe(true);
    expect(manager.isAgentTab(9999)).toBe(false);
  });
});
