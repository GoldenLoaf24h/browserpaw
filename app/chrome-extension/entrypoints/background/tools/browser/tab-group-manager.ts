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

export class TabGroupManager {
  private static instance: TabGroupManager | null = null;
  public static readonly DEFAULT_TITLE = 'Agent';
  public static readonly DEFAULT_COLOR: TabGroupColor = 'blue';

  private managedGroupIds: Set<number> = new Set<number>();
  private explicitGroupTitles: Map<number, string> = new Map<number, string>();
  private listenersRegistered = false;
  private storageLoadedPromise: Promise<void> | null = null;
  private static readonly STORAGE_KEY = 'tab_group_manager_managed_groups';
  private static readonly TITLES_STORAGE_KEY = 'tab_group_manager_explicit_titles';

  public static getInstance(): TabGroupManager {
    if (!TabGroupManager.instance) {
      TabGroupManager.instance = new TabGroupManager();
    }
    return TabGroupManager.instance;
  }

  constructor() {
    this.registerEventListeners();
    this.storageLoadedPromise = this.loadFromStorage();
  }

  public async ensureStorageLoaded(): Promise<void> {
    if (this.storageLoadedPromise) {
      await this.storageLoadedPromise;
    }
  }

  private async loadFromStorage(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
        const data = await chrome.storage.session.get([
          TabGroupManager.STORAGE_KEY,
          TabGroupManager.TITLES_STORAGE_KEY,
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
      }
    } catch {}
  }

  private async saveToStorage(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
        await chrome.storage.session.set({
          [TabGroupManager.STORAGE_KEY]: Array.from(this.managedGroupIds),
          [TabGroupManager.TITLES_STORAGE_KEY]: Array.from(this.explicitGroupTitles.entries()),
        });
      }
    } catch {}
  }

  public registerEventListeners(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;

    // Listen to tab removal to aggressively clean up empty or orphan groups
    if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((_tabId, _removeInfo) => {
        // Debounce slightly to allow Chrome to update tab group states
        setTimeout(() => {
          this.cleanupEmptyOrOrphanGroups().catch(() => {});
        }, 80);
      });
    }

    // Listen to group removal
    if (typeof chrome !== 'undefined' && chrome.tabGroups?.onRemoved) {
      chrome.tabGroups.onRemoved.addListener((group) => {
        if (group && typeof group.id === 'number') {
          this.managedGroupIds.delete(group.id);
          this.explicitGroupTitles.delete(group.id);
          void this.saveToStorage();
        }
      });
    }

    // Dynamic Title Self-Healing: when page finishes loading, auto-derive meaningful title if not explicitly set
    if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
      chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
        await this.ensureStorageLoaded();
        if (tab?.groupId && tab.groupId !== -1 && this.managedGroupIds.has(tab.groupId)) {
          if (changeInfo.status === 'complete' || changeInfo.title) {
            if (!this.explicitGroupTitles.has(tab.groupId)) {
              try {
                const group = await chrome.tabGroups.get(tab.groupId);
                if (!group.title || group.title === TabGroupManager.DEFAULT_TITLE) {
                  const smartTitle = deriveSmartGroupTitle(tab);
                  if (smartTitle && smartTitle !== TabGroupManager.DEFAULT_TITLE) {
                    await chrome.tabGroups.update(tab.groupId, { title: smartTitle });
                  }
                }
              } catch {}
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
      if (isExplicitTitle) {
        this.explicitGroupTitles.set(newGroupId, title);
      }
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
   * completely eliminating orphan tab group clutter.
   */
  public async cleanupEmptyOrOrphanGroups(): Promise<number> {
    if (typeof chrome === 'undefined' || !chrome.tabGroups) {
      return 0;
    }

    await this.ensureStorageLoaded();
    let removedCount = 0;
    const groupIds = Array.from(this.managedGroupIds);

    for (const gid of groupIds) {
      try {
        const tabs = await chrome.tabs.query({ groupId: gid });
        if (!tabs || tabs.length === 0) {
          this.managedGroupIds.delete(gid);
          this.explicitGroupTitles.delete(gid);
          const tg = chrome.tabGroups as any;
          if (typeof tg.remove === 'function') {
            await tg.remove(gid).catch(() => {});
          }
          removedCount++;
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
   * Closes all tabs in a managed group and removes the group completely.
   */
  public async closeManagedGroup(groupId: number): Promise<boolean> {
    if (typeof chrome === 'undefined' || !chrome.tabs) return false;
    try {
      await this.ensureStorageLoaded();
      const tabs = await chrome.tabs.query({ groupId });
      const tabIds = tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number');
      if (tabIds.length > 0) {
        await chrome.tabs.remove(tabIds);
      }
      this.managedGroupIds.delete(groupId);
      this.explicitGroupTitles.delete(groupId);
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
    let count = 0;
    for (const gid of Array.from(this.managedGroupIds)) {
      const ok = await this.closeManagedGroup(gid);
      if (ok) count++;
    }
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
    this.storageLoadedPromise = Promise.resolve();
  }
}

export const tabGroupManager = TabGroupManager.getInstance();
