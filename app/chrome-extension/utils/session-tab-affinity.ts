/**
 * Session Tab Affinity Manager
 * Binds client MCP sessions to dedicated Chrome tabs to prevent concurrent agents
 * from hijacking each other's active tabs when tabId is omitted.
 */
import {
  tabGroupManager,
  isNewTabUrl,
} from '../entrypoints/background/tools/browser/tab-group-manager';

const STORAGE_KEY = 'session_tab_affinity_map';

export interface TabHandoverInfo {
  handover: boolean;
  previousTabId: number;
  newTabId: number;
  url?: string;
  title?: string;
}

export interface TabHandoverTracker {
  waitForHandover(timeoutMs?: number): Promise<TabHandoverInfo | null>;
  cancel(): void;
}

interface TabLineageRecord {
  parentTabId: number;
  createdAt: number;
  active: boolean;
  url?: string;
  title?: string;
  sessionId?: string;
}

export class SessionTabAffinityManager {
  private affinityMap = new Map<string, number>();
  private tabLineage = new Map<number, TabLineageRecord>();
  private activeHandoverTrackers = new Set<
    (tab: chrome.tabs.Tab, activated: boolean, isCreated?: boolean) => void
  >();

  constructor() {
    this.initListeners();
    void this.loadFromStorage();
  }

  private async loadFromStorage(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
        const data = await chrome.storage.session.get(STORAGE_KEY);
        if (data && data[STORAGE_KEY] && typeof data[STORAGE_KEY] === 'object') {
          for (const [k, v] of Object.entries(data[STORAGE_KEY])) {
            if (typeof v === 'number' && !this.affinityMap.has(k)) {
              this.affinityMap.set(k, v);
            }
          }
        }
      }
    } catch {
      // Ignored in non-extension environments (unit tests)
    }
  }

  private async saveToStorage(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
        const obj: Record<string, number> = {};
        for (const [k, v] of this.affinityMap.entries()) {
          obj[k] = v;
        }
        await chrome.storage.session.set({ [STORAGE_KEY]: obj });
      }
    } catch {
      // Ignored in non-extension environments
    }
  }

  private initListeners() {
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        // 1. Tab removal listener: prune affinity bindings and lineage
        if (chrome.tabs.onRemoved?.addListener) {
          chrome.tabs.onRemoved.addListener((removedTabId: number) => {
            let modified = false;
            for (const [sessionId, boundTabId] of this.affinityMap.entries()) {
              if (boundTabId === removedTabId) {
                this.affinityMap.delete(sessionId);
                modified = true;
              }
            }
            this.tabLineage.delete(removedTabId);
            if (modified) {
              void this.saveToStorage();
            }
          });
        }

        // 2. Tab creation listener: track child tab derivation
        if (chrome.tabs.onCreated?.addListener) {
          chrome.tabs.onCreated.addListener((tab: chrome.tabs.Tab) => {
            if (typeof tab.id === 'number') {
              const url = tab.url || (tab as any).pendingUrl;
              const isNewTab =
                isNewTabUrl(url) || tab.title === 'New Tab' || tab.title === '新标签页';
              // Blank or user-opened new tabs must NEVER be registered in lineage or hijack affinity
              if (isNewTab) {
                return;
              }

              // Notify active trackers first so trackers can record the lineage session owner
              for (const tracker of this.activeHandoverTrackers) {
                try {
                  tracker(tab, Boolean(tab.active), true);
                } catch {}
              }

              const parentId = tab.openerTabId;
              if (typeof parentId === 'number') {
                const existingLineage = this.tabLineage.get(tab.id);
                if (!existingLineage) {
                  this.tabLineage.set(tab.id, {
                    parentTabId: parentId,
                    createdAt: Date.now(),
                    active: Boolean(tab.active),
                    url: tab.url,
                    title: tab.title,
                  });
                }
                const lineage = this.tabLineage.get(tab.id);
                if (tab.active) {
                  this.handleChildTabActivated(
                    tab.id,
                    parentId,
                    tab.url,
                    tab.title,
                    lineage?.sessionId,
                  );
                }
              }
            }
          });
        }

        // 3. Tab activation listener: auto-handover affinity to newly active child tabs
        if (chrome.tabs.onActivated?.addListener) {
          chrome.tabs.onActivated.addListener((activeInfo: { tabId: number; windowId: number }) => {
            const tabId = activeInfo.tabId;
            const lineage = this.tabLineage.get(tabId);
            if (lineage) {
              lineage.active = true;
              // If activated within 30 seconds of derivation, handover affinity
              if (Date.now() - lineage.createdAt < 30_000) {
                this.handleChildTabActivated(
                  tabId,
                  lineage.parentTabId,
                  lineage.url,
                  lineage.title,
                  lineage.sessionId,
                );
              }
            }
            if (typeof chrome.tabs.get === 'function') {
              chrome.tabs
                .get(tabId)
                .then((tab) => {
                  if (tab && tab.id) {
                    for (const tracker of this.activeHandoverTrackers) {
                      try {
                        tracker(tab, true, false);
                      } catch {}
                    }
                  }
                })
                .catch(() => {});
            }
          });
        }

        // 4. Tab update listener: keep lineage url & title updated in real time
        if (chrome.tabs.onUpdated?.addListener) {
          chrome.tabs.onUpdated.addListener(
            (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
              const lineage = this.tabLineage.get(updatedTabId);
              if (lineage) {
                if (changeInfo.url || tab.url) lineage.url = changeInfo.url || tab.url;
                if (changeInfo.title || tab.title) lineage.title = changeInfo.title || tab.title;
              }
            },
          );
        }
      }
    } catch {
      // Ignored in non-extension environments (unit tests)
    }
  }

  /**
   * Automatically hands over session affinity from parentTabId to childTabId
   */
  public handleChildTabActivated(
    childTabId: number,
    parentTabId: number,
    url?: string,
    title?: string,
    targetSessionId?: string,
  ): void {
    if (childTabId === parentTabId) return;
    if (isNewTabUrl(url) || title === 'New Tab' || title === '新标签页') return; // Never hand over affinity to blank/new tab

    const parentHadAffinity = Array.from(this.affinityMap.values()).includes(parentTabId);
    let modified = false;
    if (targetSessionId) {
      if (
        this.affinityMap.get(targetSessionId) === parentTabId ||
        !this.affinityMap.has(targetSessionId)
      ) {
        this.affinityMap.set(targetSessionId, childTabId);
        modified = true;
      }
    } else {
      for (const [sessionId, boundTabId] of this.affinityMap.entries()) {
        if (boundTabId === parentTabId) {
          this.affinityMap.set(sessionId, childTabId);
          modified = true;
          console.log(
            `[SessionTabAffinity] Auto Tab Affinity Handover: session [${sessionId}]顺延 from tab ${parentTabId} to child tab ${childTabId} (${url || 'about:blank'})`,
          );
        }
      }
    }
    if (modified) {
      void this.saveToStorage();
    }

    // Auto-group child tab into parent's tab group when parent belongs to an agent group
    if (typeof chrome !== 'undefined' && chrome.tabs?.get && chrome.tabs?.group) {
      try {
        chrome.tabs
          .get(parentTabId)
          .then(async (pTab) => {
            if (pTab && typeof pTab.groupId === 'number' && pTab.groupId > 0) {
              const isAgent =
                parentHadAffinity ||
                tabGroupManager.isAgentTab(parentTabId) ||
                (await tabGroupManager.isAgentGroup(pTab.groupId));
              if (isAgent && !isNewTabUrl(url) && title !== 'New Tab' && title !== '新标签页') {
                tabGroupManager.registerAgentTab(childTabId);
                chrome.tabs.group({ tabIds: [childTabId], groupId: pTab.groupId }).catch(() => {});
              }
            }
          })
          .catch(() => {});
      } catch {}
    }
  }

  /**
   * Starts tracking child tabs spawned by an interaction on parentTabId.
   * Handles target="_blank", window.open, and rel="noopener" where openerTabId may be missing.
   */
  public startHandoverTracking(
    parentTabId: number,
    sessionId?: string,
    _options?: { windowId?: number },
  ): TabHandoverTracker {
    const startTime = Date.now();
    const effectiveSessionId = sessionId;
    const navConfirmedChildTabIds = new Set<number>();
    let detectedChildTab: chrome.tabs.Tab | null = null;
    let isCancelled = false;
    let handoverResolved = false;

    const listener = (tab: chrome.tabs.Tab, activated: boolean, isCreated = false) => {
      if (
        isCancelled ||
        handoverResolved ||
        !tab ||
        typeof tab.id !== 'number' ||
        tab.id === parentTabId
      )
        return;
      if (
        isNewTabUrl(tab.url || (tab as any).pendingUrl) ||
        tab.title === 'New Tab' ||
        tab.title === '新标签页'
      )
        return;

      const isDirectOpener = tab.openerTabId === parentTabId;
      const isNavConfirmed = navConfirmedChildTabIds.has(tab.id);

      if (isDirectOpener || isNavConfirmed) {
        // Record lineage
        this.tabLineage.set(tab.id, {
          parentTabId,
          createdAt: Date.now(),
          active: activated,
          url: tab.url,
          title: tab.title,
          sessionId: effectiveSessionId,
        });

        if (activated) {
          detectedChildTab = tab;
        }
      }
    };

    this.activeHandoverTrackers.add(listener);

    const onNavTarget = (details: { sourceTabId: number; tabId: number; url?: string }) => {
      if (isCancelled || handoverResolved || !details) return;
      if (details.sourceTabId === parentTabId && typeof details.tabId === 'number') {
        navConfirmedChildTabIds.add(details.tabId);
        if (typeof chrome !== 'undefined' && typeof chrome.tabs?.get === 'function') {
          chrome.tabs
            .get(details.tabId)
            .then((freshTab) => {
              if (
                !isCancelled &&
                !handoverResolved &&
                freshTab &&
                typeof freshTab.id === 'number'
              ) {
                listener(freshTab, Boolean(freshTab.active), false);
              }
            })
            .catch(() => {});
        }
      }
    };

    const onCreated = (tab: chrome.tabs.Tab) => {
      listener(tab, Boolean(tab.active), true);
    };
    const onActivated = (activeInfo: { tabId: number; windowId?: number }) => {
      if (typeof chrome !== 'undefined' && typeof chrome.tabs?.get === 'function') {
        chrome.tabs
          .get(activeInfo.tabId)
          .then((tab) => {
            if (tab && typeof tab.id === 'number') listener(tab, true, false);
          })
          .catch(() => {});
      }
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId === parentTabId) {
        cancel();
      } else {
        navConfirmedChildTabIds.delete(removedTabId);
        if (detectedChildTab && detectedChildTab.id === removedTabId) {
          detectedChildTab = null;
        }
      }
    };

    if (typeof chrome !== 'undefined') {
      if (chrome.webNavigation?.onCreatedNavigationTarget?.addListener) {
        chrome.webNavigation.onCreatedNavigationTarget.addListener(onNavTarget);
      }
      if (chrome.tabs) {
        chrome.tabs.onCreated?.addListener?.(onCreated);
        chrome.tabs.onActivated?.addListener?.(onActivated);
        chrome.tabs.onRemoved?.addListener?.(onRemoved);
      }
    }

    const cancel = () => {
      isCancelled = true;
      this.activeHandoverTrackers.delete(listener);
      if (typeof chrome !== 'undefined') {
        if (chrome.webNavigation?.onCreatedNavigationTarget?.removeListener) {
          chrome.webNavigation.onCreatedNavigationTarget.removeListener(onNavTarget);
        }
        if (chrome.tabs) {
          chrome.tabs.onCreated?.removeListener?.(onCreated);
          chrome.tabs.onActivated?.removeListener?.(onActivated);
          chrome.tabs.onRemoved?.removeListener?.(onRemoved);
        }
      }
    };

    const waitForHandover = async (timeoutMs = 1200): Promise<TabHandoverInfo | null> => {
      try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (isCancelled) return null;
          if (detectedChildTab && typeof detectedChildTab.id === 'number') {
            break;
          }
          if (
            !detectedChildTab &&
            navConfirmedChildTabIds.size > 0 &&
            typeof chrome !== 'undefined' &&
            chrome.tabs?.get
          ) {
            for (const cid of navConfirmedChildTabIds) {
              try {
                const cTab = await chrome.tabs.get(cid);
                if (
                  cTab &&
                  cTab.active &&
                  !isNewTabUrl(cTab.url || (cTab as any).pendingUrl) &&
                  cTab.title !== 'New Tab' &&
                  cTab.title !== '新标签页'
                ) {
                  listener(cTab, true, false);
                  if (detectedChildTab) break;
                }
              } catch {}
            }
          }
          await new Promise((r) => setTimeout(r, 60));
        }

        if (isCancelled) return null;
        if (detectedChildTab && typeof detectedChildTab.id === 'number') {
          handoverResolved = true;
          const childId = detectedChildTab.id;

          if (typeof chrome !== 'undefined' && typeof chrome.tabs?.get === 'function') {
            try {
              const liveCheck = await chrome.tabs.get(childId);
              if (!liveCheck || typeof liveCheck.id !== 'number') {
                return null;
              }
            } catch {
              return null;
            }
          }

          if (effectiveSessionId) {
            this.handleChildTabActivated(
              childId,
              parentTabId,
              detectedChildTab.url,
              detectedChildTab.title,
              effectiveSessionId,
            );
          } else {
            this.handleChildTabActivated(
              childId,
              parentTabId,
              detectedChildTab.url,
              detectedChildTab.title,
            );
          }

          // 3. Briefly fetch updated tab state if url was blank or provisional
          let finalUrl = detectedChildTab.url;
          let finalTitle = detectedChildTab.title;
          if (
            (!finalUrl || finalUrl === 'about:blank' || finalUrl.startsWith('chrome://newtab')) &&
            typeof chrome !== 'undefined' &&
            chrome.tabs?.get
          ) {
            const urlPollDeadline = Date.now() + 450;
            while (Date.now() < urlPollDeadline) {
              try {
                const freshTab = await Promise.race([
                  chrome.tabs.get(childId),
                  new Promise<null>((r) => setTimeout(() => r(null), 150)),
                ]);
                if (
                  freshTab &&
                  freshTab.url &&
                  freshTab.url !== 'about:blank' &&
                  !freshTab.url.startsWith('chrome://newtab')
                ) {
                  finalUrl = freshTab.url;
                  finalTitle = freshTab.title;
                  break;
                }
              } catch {}
              await new Promise((r) => setTimeout(r, 60));
            }
          }

          return {
            handover: true,
            previousTabId: parentTabId,
            newTabId: childId,
            url: finalUrl,
            title: finalTitle,
          };
        }

        return null;
      } finally {
        cancel();
      }
    };

    return {
      waitForHandover,
      cancel,
    };
  }

  public getSessionsForTab(tabId: number): string[] {
    const list: string[] = [];
    for (const [sid, boundTabId] of this.affinityMap.entries()) {
      if (boundTabId === tabId) list.push(sid);
    }
    return list;
  }

  public getParentTab(childTabId: number): number | undefined {
    return this.tabLineage.get(childTabId)?.parentTabId;
  }

  public setAffinity(sessionId: string, tabId: number): void {
    if (!sessionId || typeof tabId !== 'number') return;
    this.affinityMap.set(sessionId, tabId);
    void this.saveToStorage();
  }

  public getAffinity(sessionId: string): number | undefined {
    if (!sessionId) return undefined;
    return this.affinityMap.get(sessionId);
  }

  /**
   * Synchronous binding existence check for pre-resolution warning logic.
   * resolveAffinityTab's active-tab fallback BINDS the fallback tab as a side
   * effect, so a post-resolution binding check cannot distinguish "agent
   * bound earlier" from "fallback just bound it" — the warning would never
   * fire. Callers must snapshot BEFORE resolveAffinityTab.
   */
  public hasBinding(sessionId?: string): boolean {
    if (!sessionId) return false;
    return this.affinityMap.has(sessionId);
  }

  public removeAffinity(sessionId: string): void {
    if (!sessionId) return;
    this.affinityMap.delete(sessionId);
    void this.saveToStorage();
  }

  public clearAll(): void {
    this.affinityMap.clear();
    this.tabLineage.clear();
    void this.saveToStorage();
  }

  public getMapSize(): number {
    return this.affinityMap.size;
  }

  /**
   * Resolve an existing Chrome tab bound to sessionId.
   * If the tab was closed or does not exist, deletes the affinity mapping and returns null.
   */
  public async resolveSessionTab(sessionId?: string): Promise<chrome.tabs.Tab | null> {
    if (!sessionId) return null;
    if (!this.affinityMap.has(sessionId)) {
      await this.loadFromStorage();
    }
    const tabId = this.affinityMap.get(sessionId);
    if (typeof tabId !== 'number') return null;

    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.id) {
        return tab;
      }
      this.affinityMap.delete(sessionId);
      void this.saveToStorage();
    } catch {
      this.affinityMap.delete(sessionId);
      void this.saveToStorage();
    }
    return null;
  }

  private queueMap = new Map<string, Promise<any>>();

  /**
   * Run an asynchronous operation sequentially for a given session or tab key.
   * Ensures that concurrent actions (e.g. rapid posts/replies or fast batches)
   * targeting the same tab or session do not overlap or race with each other.
   */
  public async runSerialized<T>(key: string | number, op: () => Promise<T>): Promise<T> {
    const k = String(key);
    const prev = this.queueMap.get(k) || Promise.resolve();
    let currentResolve: () => void;
    const currentPromise = new Promise<void>((resolve) => {
      currentResolve = resolve;
    });

    const chained = prev
      .catch(() => {})
      .then(async () => {
        try {
          return await op();
        } finally {
          currentResolve!();
          if (this.queueMap.get(k) === chained) {
            this.queueMap.delete(k);
          }
        }
      });

    this.queueMap.set(k, chained);
    return chained;
  }
}

export const sessionTabAffinity = new SessionTabAffinityManager();

export function startHandoverTracking(
  parentTabId: number,
  sessionId?: string,
  options?: { windowId?: number },
): TabHandoverTracker {
  return sessionTabAffinity.startHandoverTracking(parentTabId, sessionId, options);
}
