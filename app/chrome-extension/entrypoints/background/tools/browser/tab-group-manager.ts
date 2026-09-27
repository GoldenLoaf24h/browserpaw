/**
 * BrowserPaw Agent Tab Group Lifecycle Manager
 *
 * Implements 1:1 parity with industrial-grade Chrome Tab Grouping:
 * 1. Automatic grouping: places Agent tabs into a dedicated colored tab group.
 * 2. Adaptive naming: default title is "Agent", customizable by the agent to reflect the current task.
 * 3. Zero-orphan cleanup: strictly guarantees that when tabs are closed or tasks complete,
 *    the tab group is completely removed and never left as a ghost/empty group.
 */

export type TabGroupColor =
  'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export interface EnsureAgentGroupOptions {
  title?: string;
  color?: TabGroupColor;
  windowId?: number;
}

/**
 * Universal Page Title Cleaner
 * Extracts a concise, informative topic or brand from raw page title
 * using universal structural delimiters without hardcoded domain dictionaries.
 */
export function cleanPageTitle(rawTitle: string): string {
  if (!rawTitle) return '';
  const trimmed = rawTitle.trim();
  if (['New Tab', '新标签页', 'about:blank', 'Untitled'].includes(trimmed)) {
    return '';
  }

  // Defer raw URLs to extractBrandFromUrl to prevent setting URL as group title
  if (/^https?:\/\//i.test(trimmed)) {
    return '';
  }

  // Universal structural delimiters used across web page titles worldwide
  // Handles spaced delimiters, typography dashes, pipes, underscores, and CJK-flanked hyphens.
  // Crucially preserves hyphens inside ASCII words (e.g. "COVID-19", "Wi-Fi", "E-Commerce").
  const delimiters = [
    ' - ',
    ' | ',
    ' _ ',
    '·',
    ' — ',
    ' – ',
    ' // ',
    ' » ',
    ' _',
    '_ ',
    '_',
    ' |',
    '| ',
    '|',
    '—',
    '–',
    ' -',
    '- ',
  ];
  for (const d of delimiters) {
    if (trimmed.includes(d)) {
      const parts = trimmed
        .split(d)
        .map((p) => p.trim())
        .filter(Boolean);
      // Prefer the first informative part (specific page title/topic)
      if (parts[0] && parts[0].length >= 2 && parts[0].length <= 30) {
        return parts[0];
      }
      // Or fallback to the last part (usually site brand name)
      if (parts.length > 1) {
        const last = parts[parts.length - 1];
        if (last && last.length >= 2 && last.length <= 25) {
          return last;
        }
      }
    }
  }

  // Handle hyphens that are NOT part of ASCII hyphenated words (e.g. "汽车之家-懂车更懂你", "京东(JD.COM)-正品低价")
  // In ASCII words (COVID-19, Wi-Fi, E-Commerce), the hyphen is flanked by [a-zA-Z0-9] on both sides.
  // If a hyphen is preceded or followed by non-ASCII/punctuation/CJK, it acts as a title delimiter.
  const nonWordHyphenMatch = /(?:(?<![a-zA-Z0-9])-)|(?:-(?![a-zA-Z0-9]))/.exec(trimmed);
  if (nonWordHyphenMatch && typeof nonWordHyphenMatch.index === 'number') {
    const idx = nonWordHyphenMatch.index;
    const part1 = trimmed.slice(0, idx).trim();
    const part2 = trimmed.slice(idx + 1).trim();
    if (part1.length >= 2 && part1.length <= 30) {
      return part1;
    }
    if (part2.length >= 2 && part2.length <= 25) {
      return part2;
    }
  }

  return trimmed.length > 25 ? trimmed.slice(0, 25).trim() : trimmed;
}

/**
 * Universal Domain Brand Extractor
 * Derives a clean, capitalized brand name from a URL hostname (e.g. "github.com" -> "Github", "item.jd.com" -> "Jd")
 * without hardcoded domain lookup dictionaries.
 */
export function extractBrandFromUrl(urlStr?: string): string {
  if (!urlStr) return '';
  try {
    const u = new URL(urlStr);
    if (!u.protocol.startsWith('http')) {
      if (u.protocol === 'chrome:') return 'Chrome';
      return '';
    }
    const hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!hostname) return '';

    // Handle localhost and IP addresses
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return 'Localhost';
    }
    // For general IPv4 or IPv6 addresses, return the hostname rather than extracting an octet digit
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')) {
      return hostname;
    }

    const parts = hostname.split('.');
    if (parts.length === 0) return '';

    // Handle multi-part domains like "amazon.co.uk" or "item.jd.com" or "github.com"
    let brandLabel = '';
    const twoPartTLDs = new Set([
      'co.uk',
      'com.cn',
      'co.jp',
      'co.au',
      'com.au',
      'co.nz',
      'com.hk',
      'org.uk',
      'gov.uk',
      'com.tw',
      'com.sg',
      'co.in',
      'gov.cn',
      'edu.cn',
      'org.cn',
      'net.cn',
    ]);
    const lastTwo = parts.slice(-2).join('.');
    if (twoPartTLDs.has(lastTwo) && parts.length >= 3) {
      brandLabel = parts[parts.length - 3];
    } else if (parts.length >= 2) {
      brandLabel = parts[parts.length - 2];
    } else {
      brandLabel = parts[0];
    }

    if (brandLabel) {
      return brandLabel.charAt(0).toUpperCase() + brandLabel.slice(1);
    }
  } catch {}
  return '';
}

/**
 * Derives a smart, task-aligned group title dynamically:
 * 1. Intelligent extraction from page title
 * 2. Dynamic brand extraction from hostname
 * 3. Default fallback to "Agent"
 */
export function deriveSmartGroupTitle(
  tab?: { title?: string; url?: string; pendingUrl?: string } | null,
  fallbackUrl?: string,
): string {
  // 1. Check if tab has a meaningful title first
  if (tab?.title) {
    const cleaned = cleanPageTitle(tab.title);
    if (cleaned) return cleaned;
  }

  // 2. Derive from URL hostname brand
  const urlStr = tab?.url || tab?.pendingUrl || fallbackUrl;
  const brand = extractBrandFromUrl(urlStr);
  if (brand) return brand;

  // 3. Fallback to default
  return TabGroupManager.DEFAULT_TITLE;
}

/**
 * Check if a URL represents a new tab or blank browser page.
 */
export function isNewTabUrl(url?: string): boolean {
  if (url === undefined || url === null) return false;
  const clean = url.trim().toLowerCase();
  return (
    clean === '' ||
    clean === 'about:blank' ||
    clean === 'chrome://newtab/' ||
    clean === 'chrome://newtab' ||
    clean === 'chrome://new-tab-page/' ||
    clean === 'chrome://new-tab-page' ||
    clean === 'chrome-search://local-ntp/local-ntp.html' ||
    clean === 'edge://newtab/' ||
    clean === 'edge://newtab'
  );
}

export class TabGroupManager {
  private static instance: TabGroupManager | null = null;
  public static readonly DEFAULT_TITLE = 'Agent';
  public static readonly DEFAULT_COLOR: TabGroupColor = 'blue';

  private managedGroupIds: Set<number> = new Set<number>();
  private explicitGroupTitles: Map<number, string> = new Map<number, string>();
  private agentTabIds: Set<number> = new Set<number>();
  private agentCreationInProgress = 0;
  private listenersRegistered = false;
  private storageLoadedPromise: Promise<void> | null = null;
  private static readonly STORAGE_KEY = 'tab_group_manager_managed_groups';
  private static readonly TITLES_STORAGE_KEY = 'tab_group_manager_explicit_titles';
  private static readonly AGENT_TABS_STORAGE_KEY = 'tab_group_manager_agent_tabs';

  public static getInstance(): TabGroupManager {
    if (!TabGroupManager.instance) {
      TabGroupManager.instance = new TabGroupManager();
    }
    return TabGroupManager.instance;
  }

  constructor() {
    this.registerEventListeners();
    this.storageLoadedPromise = this.loadFromStorage().then(() => {
      // Clean up any empty or orphan residue groups left from previous sessions or crashed tests
      void this.cleanupEmptyOrOrphanGroups().catch(() => {});
    });
  }

  public registerAgentTab(tabId: number): void {
    if (typeof tabId === 'number' && tabId > 0) {
      this.agentTabIds.add(tabId);
      void this.saveToStorage();
    }
  }

  public isAgentTab(tabId: number): boolean {
    return typeof tabId === 'number' && this.agentTabIds.has(tabId);
  }

  public beginAgentTabCreation(): void {
    this.agentCreationInProgress++;
  }

  public endAgentTabCreation(tabId?: number): void {
    if (this.agentCreationInProgress > 0) {
      this.agentCreationInProgress--;
    }
    if (typeof tabId === 'number' && tabId > 0) {
      this.registerAgentTab(tabId);
    }
  }

  public async ensureStorageLoaded(): Promise<void> {
    if (this.storageLoadedPromise) {
      await this.storageLoadedPromise;
    }
  }

  private getStorageArea(): chrome.storage.StorageArea | null {
    if (typeof chrome === 'undefined' || !chrome.storage) return null;
    return chrome.storage.session || chrome.storage.local || null;
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const storage = this.getStorageArea();
      if (storage?.get) {
        const data = await storage.get([
          TabGroupManager.STORAGE_KEY,
          TabGroupManager.TITLES_STORAGE_KEY,
          TabGroupManager.AGENT_TABS_STORAGE_KEY,
        ]);
        if (data && Array.isArray(data[TabGroupManager.STORAGE_KEY])) {
          for (const gid of data[TabGroupManager.STORAGE_KEY]) {
            if (typeof gid === 'number') {
              this.managedGroupIds.add(gid);
            }
          }
        }
        if (data && Array.isArray(data[TabGroupManager.TITLES_STORAGE_KEY])) {
          for (const [gid, title] of data[TabGroupManager.TITLES_STORAGE_KEY]) {
            if (typeof gid === 'number' && typeof title === 'string') {
              this.explicitGroupTitles.set(gid, title);
            }
          }
        }
        if (data && Array.isArray(data[TabGroupManager.AGENT_TABS_STORAGE_KEY])) {
          for (const tid of data[TabGroupManager.AGENT_TABS_STORAGE_KEY]) {
            if (typeof tid === 'number') {
              this.agentTabIds.add(tid);
            }
          }
        }
      }

      // Re-hydrate agentTabIds from open tabs in managed groups that are not new tabs
      if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
        for (const gid of Array.from(this.managedGroupIds)) {
          try {
            const tabsInGroup = await chrome.tabs.query({ groupId: gid });
            for (const t of tabsInGroup) {
              if (
                typeof t.id === 'number' &&
                !isNewTabUrl(t.url || (t as any).pendingUrl) &&
                t.title !== 'New Tab' &&
                t.title !== '新标签页'
              ) {
                this.agentTabIds.add(t.id);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  private async saveToStorage(): Promise<void> {
    try {
      const storage = this.getStorageArea();
      if (storage?.set) {
        await storage.set({
          [TabGroupManager.STORAGE_KEY]: Array.from(this.managedGroupIds),
          [TabGroupManager.TITLES_STORAGE_KEY]: Array.from(this.explicitGroupTitles.entries()),
          [TabGroupManager.AGENT_TABS_STORAGE_KEY]: Array.from(this.agentTabIds),
        });
      }
    } catch {}
  }

  public async registerManagedGroup(groupId: number, title?: string): Promise<void> {
    if (typeof groupId === 'number' && groupId > 0) {
      await this.ensureStorageLoaded();
      this.managedGroupIds.add(groupId);
      if (title && title.trim()) {
        this.explicitGroupTitles.set(groupId, title.trim());
      }
      await this.saveToStorage();
    }
  }

  public async unregisterManagedGroup(groupId: number): Promise<void> {
    if (typeof groupId === 'number') {
      await this.ensureStorageLoaded();
      this.managedGroupIds.delete(groupId);
      this.explicitGroupTitles.delete(groupId);
      await this.saveToStorage();
    }
  }

  public async isAgentGroup(groupId: number): Promise<boolean> {
    if (typeof groupId !== 'number' || groupId <= 0) return false;
    await this.ensureStorageLoaded();
    if (this.managedGroupIds.has(groupId)) return true;
    if (typeof chrome !== 'undefined' && chrome.tabGroups?.get) {
      try {
        const group = await chrome.tabGroups.get(groupId);
        if (
          group &&
          (group.title === TabGroupManager.DEFAULT_TITLE ||
            this.explicitGroupTitles.has(groupId) ||
            Array.from(this.explicitGroupTitles.values()).includes(group.title || ''))
        ) {
          this.managedGroupIds.add(groupId);
          return true;
        }
      } catch {}
    }
    // Also check if any open tab in this group is an agent tab
    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      try {
        const tabsInGroup = await chrome.tabs.query({ groupId });
        if (tabsInGroup.some((t) => typeof t.id === 'number' && this.agentTabIds.has(t.id))) {
          this.managedGroupIds.add(groupId);
          return true;
        }
      } catch {}
    }
    return false;
  }

  public registerEventListeners(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;

    // 1. Listen to tab removal to aggressively clean up empty or orphan groups and memory
    if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((removedTabId: number) => {
        this.agentTabIds.delete(removedTabId);
        // Immediate cleanup + debounced cleanup
        void this.cleanupEmptyOrOrphanGroups().catch(() => {});
        setTimeout(() => {
          this.cleanupEmptyOrOrphanGroups().catch(() => {});
        }, 120);
      });
    }

    // 2. Listen to tab creation to prevent user tabs in the same window from being erroneously grouped into agent groups
    if (typeof chrome !== 'undefined' && chrome.tabs?.onCreated) {
      chrome.tabs.onCreated.addListener(async (tab: chrome.tabs.Tab) => {
        if (!tab || typeof tab.id !== 'number') return;
        await this.ensureStorageLoaded();

        const createdTabId = tab.id;
        const tabUrl = tab.url || (tab as any).pendingUrl || '';
        const isNewTab =
          isNewTabUrl(tabUrl) ||
          tab.title === 'New Tab' ||
          tab.title === '新标签页' ||
          (!tab.url && !(tab as any).pendingUrl);

        if (this.agentCreationInProgress > 0 && !isNewTab) {
          this.agentTabIds.add(createdTabId);
          return;
        }

        const rawGroupId = (tab as any).groupId;
        if (typeof rawGroupId === 'number' && rawGroupId > 0) {
          const isAgentManaged = await this.isAgentGroup(rawGroupId);
          if (isAgentManaged) {
            const isAgent = this.agentTabIds.has(createdTabId);
            if (!isAgent || isNewTab) {
              console.log(
                `[TabGroupManager] User opened tab ${createdTabId} in window ${tab.windowId}. Ejecting from agent tab group ${rawGroupId}.`,
              );
              try {
                if (chrome.tabs.ungroup) {
                  await chrome.tabs.ungroup(createdTabId);
                  void this.cleanupEmptyOrOrphanGroups();
                }
              } catch (err) {
                console.warn('[TabGroupManager] Failed to ungroup user tab:', err);
              }
            }
          }
        }

        // Fast follow-up: in case Chrome groups the tab asynchronously right after creation
        if (!this.agentTabIds.has(createdTabId) || isNewTab) {
          const checkAndUngroup = async () => {
            try {
              const updated = await chrome.tabs.get(createdTabId);
              if (updated && typeof updated.groupId === 'number' && updated.groupId > 0) {
                const isManaged = await this.isAgentGroup(updated.groupId);
                if (isManaged) {
                  const stillAgent = this.agentTabIds.has(updated.id!);
                  const isNtp =
                    isNewTabUrl(updated.url || (updated as any).pendingUrl) ||
                    updated.title === 'New Tab' ||
                    updated.title === '新标签页';
                  if (!stillAgent || isNtp) {
                    await chrome.tabs.ungroup(updated.id!);
                    void this.cleanupEmptyOrOrphanGroups();
                  }
                }
              }
            } catch {}
          };
          setTimeout(checkAndUngroup, 50);
          setTimeout(checkAndUngroup, 150);
        }
      });
    }

    // 3. Listen to group removal
    if (typeof chrome !== 'undefined' && chrome.tabGroups?.onRemoved) {
      chrome.tabGroups.onRemoved.addListener((group) => {
        if (group && typeof group.id === 'number') {
          this.managedGroupIds.delete(group.id);
          this.explicitGroupTitles.delete(group.id);
          void this.saveToStorage();
        }
      });
    }

    // 4. Dynamic Title Self-Healing & User-Tab Ejection Guard
    if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
      chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
        await this.ensureStorageLoaded();
        const effectiveGroupId = changeInfo?.groupId ?? tab?.groupId;
        if (typeof effectiveGroupId === 'number' && effectiveGroupId > 0) {
          const isAgentManaged = await this.isAgentGroup(effectiveGroupId);
          if (isAgentManaged) {
            const isAgent = this.agentTabIds.has(tabId);
            const tabUrl = tab?.url || (tab as any)?.pendingUrl || '';
            const isNewTab =
              isNewTabUrl(tabUrl) || tab?.title === 'New Tab' || tab?.title === '新标签页';

            // Guard: If a non-agent user tab ends up in an agent group, eject it immediately
            if (!isAgent || isNewTab) {
              console.log(
                `[TabGroupManager] Non-agent tab ${tabId} found in managed group ${effectiveGroupId}. Ungrouping.`,
              );
              try {
                if (chrome.tabs.ungroup) {
                  await chrome.tabs.ungroup(tabId);
                  void this.cleanupEmptyOrOrphanGroups();
                }
              } catch {}
              return;
            }

            if (changeInfo.status === 'complete' || changeInfo.title) {
              if (!this.explicitGroupTitles.has(effectiveGroupId)) {
                try {
                  const group = await chrome.tabGroups.get(effectiveGroupId);
                  if (!group.title || group.title === TabGroupManager.DEFAULT_TITLE) {
                    const smartTitle = deriveSmartGroupTitle(tab);
                    if (smartTitle && smartTitle !== TabGroupManager.DEFAULT_TITLE) {
                      await chrome.tabGroups.update(effectiveGroupId, { title: smartTitle });
                      this.explicitGroupTitles.set(effectiveGroupId, smartTitle);
                      void this.saveToStorage();
                    }
                  }
                } catch {}
              }
            }
          }
        }
      });
    }
  }

  /**
   * Ensure a tab is added to the active Agent tab group in its window.
   * If an active managed group already exists in the target window, reuse it;
   * otherwise, create a new managed group with the specified title and color.
   */
  public async ensureAgentTabGroup(
    tabId: number,
    options: EnsureAgentGroupOptions = {},
  ): Promise<number | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.group || !chrome.tabGroups) {
      return null;
    }

    try {
      this.registerAgentTab(tabId);
      await this.ensureStorageLoaded();
      const tab = await chrome.tabs.get(tabId);
      const targetWindowId = options.windowId ?? tab.windowId;
      const isExplicitTitle = Boolean(
        options.title &&
        options.title.trim() &&
        options.title.trim() !== TabGroupManager.DEFAULT_TITLE,
      );
      const title = isExplicitTitle ? options.title!.trim() : deriveSmartGroupTitle(tab);
      const color = options.color || TabGroupManager.DEFAULT_COLOR;

      // Find if there is an existing valid managed group in this window
      let targetGroupId: number | null = null;
      for (const gid of Array.from(this.managedGroupIds)) {
        try {
          const group = await chrome.tabGroups.get(gid);
          if (group.windowId === targetWindowId) {
            targetGroupId = gid;
            break;
          }
        } catch {
          this.managedGroupIds.delete(gid);
          this.explicitGroupTitles.delete(gid);
        }
      }

      // If not found in memory, query chrome.tabGroups for any existing agent group in this window
      if (targetGroupId === null && typeof chrome.tabGroups.query === 'function') {
        try {
          const windowGroups = await chrome.tabGroups.query(
            typeof targetWindowId === 'number' ? { windowId: targetWindowId } : {},
          );
          for (const wg of windowGroups) {
            if (
              typeof wg.id === 'number' &&
              (typeof targetWindowId !== 'number' || wg.windowId === targetWindowId) &&
              (await this.isAgentGroup(wg.id))
            ) {
              targetGroupId = wg.id;
              this.managedGroupIds.add(wg.id);
              break;
            }
          }
        } catch {}
      }

      if (targetGroupId !== null) {
        // Add tab to the existing group
        await chrome.tabs.group({
          tabIds: [tabId],
          groupId: targetGroupId,
        });

        // Update title and/or color if caller provided specific custom title/color or if group has default title
        const updateProps: { title?: string; color?: chrome.tabGroups.UpdateProperties['color'] } =
          {};
        if (isExplicitTitle) {
          updateProps.title = title;
          this.explicitGroupTitles.set(targetGroupId, title);
          void this.saveToStorage();
        } else if (!this.explicitGroupTitles.has(targetGroupId)) {
          try {
            const currentGroup = await chrome.tabGroups.get(targetGroupId);
            if (!currentGroup.title || currentGroup.title === TabGroupManager.DEFAULT_TITLE) {
              if (title && title !== TabGroupManager.DEFAULT_TITLE) {
                updateProps.title = title;
                this.explicitGroupTitles.set(targetGroupId, title);
                void this.saveToStorage();
              }
            }
          } catch {}
        }
        if (options.color) {
          updateProps.color = options.color;
        }
        if (Object.keys(updateProps).length > 0) {
          await chrome.tabGroups.update(targetGroupId, updateProps).catch(() => {});
        }
        return targetGroupId;
      }

      // Create a brand-new group for this window
      const newGroupId = await chrome.tabs.group({
        tabIds: [tabId],
        createProperties:
          typeof targetWindowId === 'number' ? { windowId: targetWindowId } : undefined,
      });

      this.managedGroupIds.add(newGroupId);
      this.explicitGroupTitles.set(newGroupId, title);
      void this.saveToStorage();

      await chrome.tabGroups.update(newGroupId, {
        title,
        color,
        collapsed: false,
      });

      return newGroupId;
    } catch (error) {
      console.warn('[TabGroupManager] ensureAgentTabGroup error:', error);
      return null;
    }
  }

  /**
   * Actively scans all managed groups and removes any group that has 0 tabs,
   * ungroups accidental user tabs, and purges empty/residue groups.
   */
  public async cleanupEmptyOrOrphanGroups(): Promise<number> {
    if (typeof chrome === 'undefined' || !chrome.tabGroups || !chrome.tabs) {
      return 0;
    }

    await this.ensureStorageLoaded();
    let removedCount = 0;

    // Prune closed tabs from agentTabIds to strictly eliminate any memory leaks
    if (typeof chrome.tabs?.query === 'function') {
      try {
        const allOpenTabs = await chrome.tabs.query({});
        const openTabIdSet = new Set(
          allOpenTabs.map((t) => t.id).filter((id): id is number => typeof id === 'number'),
        );
        for (const tid of Array.from(this.agentTabIds)) {
          if (!openTabIdSet.has(tid)) {
            this.agentTabIds.delete(tid);
          }
        }
      } catch {}
    }

    // Collect all candidate group IDs:
    // 1) All actively tracked managedGroupIds
    // 2) Any browser tab group matching managed titles or DEFAULT_TITLE
    const candidateGroupIds = new Set<number>(this.managedGroupIds);

    if (typeof chrome.tabGroups.query === 'function') {
      try {
        const allGroups = await chrome.tabGroups.query({});
        for (const g of allGroups) {
          if (typeof g.id === 'number') {
            candidateGroupIds.add(g.id);
          }
        }
      } catch {}
    }

    for (const gid of candidateGroupIds) {
      try {
        const tabs = await chrome.tabs.query({ groupId: gid });
        if (!tabs || tabs.length === 0) {
          this.managedGroupIds.delete(gid);
          this.explicitGroupTitles.delete(gid);
          const tg = chrome.tabGroups as any;
          if (typeof tg.remove === 'function') {
            await tg.remove(gid).catch(() => {});
          } else if (typeof tg.close === 'function') {
            await tg.close(gid).catch(() => {});
          }
          removedCount++;
        } else {
          // If group has tabs, check if it's an agent group
          const isManaged = await this.isAgentGroup(gid);
          if (isManaged) {
            // Eject any user tabs from this agent group
            const userTabsToEject: number[] = [];
            const agentTabs: chrome.tabs.Tab[] = [];
            for (const t of tabs) {
              if (typeof t.id === 'number') {
                if (!this.agentTabIds.has(t.id)) {
                  userTabsToEject.push(t.id);
                } else {
                  agentTabs.push(t);
                }
              }
            }

            if (userTabsToEject.length > 0) {
              try {
                await chrome.tabs.ungroup(userTabsToEject);
              } catch {}
            }

            // If no agent tabs remain, destroy group completely
            if (agentTabs.length === 0) {
              this.managedGroupIds.delete(gid);
              this.explicitGroupTitles.delete(gid);
              const tg = chrome.tabGroups as any;
              if (typeof tg?.remove === 'function') {
                await tg.remove(gid).catch(() => {});
              } else if (typeof tg?.close === 'function') {
                await tg.close(gid).catch(() => {});
              }
              removedCount++;
            } else if (
              agentTabs.length > 0 &&
              agentTabs.every((t) => isNewTabUrl(t.url || (t as any).pendingUrl))
            ) {
              // If the only remaining tabs in this managed group are agent newtab / blank residue tabs:
              const residueIds = agentTabs.map((t) => t.id!).filter(Boolean);
              for (const tid of residueIds) {
                this.agentTabIds.delete(tid);
              }
              try {
                await chrome.tabs.remove(residueIds);
              } catch {}
              this.managedGroupIds.delete(gid);
              this.explicitGroupTitles.delete(gid);
              const tg = chrome.tabGroups as any;
              if (typeof tg?.remove === 'function') {
                await tg.remove(gid).catch(() => {});
              } else if (typeof tg?.close === 'function') {
                await tg.close(gid).catch(() => {});
              }
              removedCount++;
            }
          }
        }
      } catch {
        // Group no longer exists
        this.managedGroupIds.delete(gid);
        this.explicitGroupTitles.delete(gid);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      void this.saveToStorage();
    }

    return removedCount;
  }

  /**
   * Closes all agent tabs in a managed group and removes the group completely.
   * Accidental user tabs inside the group are safely ejected/ungrouped without data loss.
   */
  public async closeManagedGroup(groupId: number): Promise<boolean> {
    if (typeof chrome === 'undefined' || !chrome.tabs) return false;
    try {
      await this.ensureStorageLoaded();
      const tabs = await chrome.tabs.query({ groupId });
      const userTabsToEject: number[] = [];
      const tabsToClose: number[] = [];

      for (const t of tabs) {
        if (typeof t.id === 'number') {
          // If a user tab was mistakenly in this group, don't close it, ungroup it!
          if (!this.agentTabIds.has(t.id)) {
            userTabsToEject.push(t.id);
          } else {
            tabsToClose.push(t.id);
          }
        }
      }

      if (userTabsToEject.length > 0) {
        try {
          await chrome.tabs.ungroup(userTabsToEject);
        } catch {}
      }

      if (tabsToClose.length > 0) {
        for (const tid of tabsToClose) {
          this.agentTabIds.delete(tid);
        }
        await chrome.tabs.remove(tabsToClose);
      }

      const tg = (chrome as any).tabGroups;
      if (tg && typeof tg.remove === 'function') {
        await tg.remove(groupId).catch(() => {});
      } else if (tg && typeof tg.close === 'function') {
        await tg.close(groupId).catch(() => {});
      }
      this.managedGroupIds.delete(groupId);
      this.explicitGroupTitles.delete(groupId);
      await this.saveToStorage();
      await this.cleanupEmptyOrOrphanGroups();
      return true;
    } catch (error) {
      console.warn('[TabGroupManager] closeManagedGroup error:', error);
      return false;
    }
  }

  /**
   * Close all tabs across all Agent-managed tab groups.
   */
  public async closeAllManagedGroups(): Promise<number> {
    if (typeof chrome === 'undefined' || !chrome.tabs) return 0;
    await this.ensureStorageLoaded();
    let count = 0;
    const gids = new Set<number>(this.managedGroupIds);

    // Also sweep for any orphan groups in chrome.tabGroups
    if (typeof chrome.tabGroups?.query === 'function') {
      try {
        const allGroups = await chrome.tabGroups.query({});
        for (const og of allGroups) {
          if (typeof og.id === 'number') {
            const isAgent = await this.isAgentGroup(og.id);
            if (isAgent) {
              gids.add(og.id);
            }
          }
        }
      } catch {}
    }

    for (const gid of gids) {
      const ok = await this.closeManagedGroup(gid);
      if (ok) count++;
    }

    await this.cleanupEmptyOrOrphanGroups();
    return count;
  }

  /**
   * Check if a tab group ID is currently managed by BrowserPaw agent
   */
  public async isManagedGroup(groupId: number): Promise<boolean> {
    if (typeof groupId !== 'number' || groupId <= 0) return false;
    await this.ensureStorageLoaded();
    return this.managedGroupIds.has(groupId);
  }

  /**
   * Helper to query current managed group IDs
   */
  public getManagedGroupIds(): number[] {
    return Array.from(this.managedGroupIds);
  }

  /**
   * Reset for testing environments
   */
  public resetForTest(): void {
    this.managedGroupIds.clear();
    this.explicitGroupTitles.clear();
    this.agentTabIds.clear();
    this.agentCreationInProgress = 0;
    this.storageLoadedPromise = Promise.resolve();
  }
}

export const tabGroupManager = TabGroupManager.getInstance();
