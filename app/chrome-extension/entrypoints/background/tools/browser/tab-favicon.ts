/**
 * BrowserPaw Tab Favicon State Manager
 *
 * Implements 1:1 parity with OpenAI/ChatGPT extension tab state signaling:
 * - When an Agent starts automating a tab, replace its Favicon with a glowing blue dot.
 * - Caches the original favicon URL before replacement.
 * - When automation ends or tab is released/closed, restores the original favicon cleanly.
 */

export const AGENT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <defs>
    <filter id="cursor-halo" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="0" stdDeviation="1.8" flood-color="#339cff" flood-opacity="0.95"/>
      <feDropShadow dx="0" dy="0" stdDeviation="3.5" flood-color="#0066ff" flood-opacity="0.6"/>
    </filter>
  </defs>
  <path d="M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.0872 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z" fill="#000000" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" paint-order="stroke fill" transform="translate(1, 1) scale(1.9)" filter="url(#cursor-halo)"/>
</svg>`;

export const AGENT_FAVICON_DATA_URL = 'data:image/svg+xml,' + encodeURIComponent(AGENT_FAVICON_SVG);

import { isRestrictedChromeUrl } from '@/utils/restricted-url';

export class TabFaviconManager {
  private static instance: TabFaviconManager | null = null;
  // Map of tabId -> original favicon URL (or null if the page had no favicon)
  private originalFavicons: Map<number, string | null> = new Map();
  private listenersRegistered = false;
  private static readonly STORAGE_KEY = 'tab_favicon_manager_original_favicons';

  public static getInstance(): TabFaviconManager {
    if (!TabFaviconManager.instance) {
      TabFaviconManager.instance = new TabFaviconManager();
    }
    return TabFaviconManager.instance;
  }

  private idleTimers: Map<number, any> = new Map();

  constructor() {
    this.registerEventListeners();
    void this.loadFromStorage();
  }

  private async loadFromStorage(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
        const data = await chrome.storage.session.get(TabFaviconManager.STORAGE_KEY);
        if (
          data &&
          data[TabFaviconManager.STORAGE_KEY] &&
          typeof data[TabFaviconManager.STORAGE_KEY] === 'object'
        ) {
          for (const [tidStr, val] of Object.entries(data[TabFaviconManager.STORAGE_KEY])) {
            const tid = parseInt(tidStr, 10);
            if (!isNaN(tid) && !this.originalFavicons.has(tid)) {
              this.originalFavicons.set(tid, (val as string | null) ?? null);
            }
          }
        }
      }
    } catch {}
  }

  private async saveToStorage(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
        const obj: Record<string, string | null> = {};
        for (const [tid, val] of this.originalFavicons.entries()) {
          obj[String(tid)] = val;
        }
        await chrome.storage.session.set({ [TabFaviconManager.STORAGE_KEY]: obj });
      }
    } catch {}
  }

  public registerEventListeners(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;

    if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        const timer = this.idleTimers.get(tabId);
        if (timer) {
          clearTimeout(timer);
          this.idleTimers.delete(tabId);
        }
        this.originalFavicons.delete(tabId);
        void this.saveToStorage();
      });

      chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
        if (this.originalFavicons.has(tabId)) {
          if (
            changeInfo.favIconUrl &&
            changeInfo.favIconUrl !== AGENT_FAVICON_DATA_URL &&
            !changeInfo.favIconUrl.includes('cursor-halo') &&
            !this.originalFavicons.get(tabId)
          ) {
            this.originalFavicons.set(tabId, changeInfo.favIconUrl);
            void this.saveToStorage();
          }
          if (changeInfo.status === 'complete' || changeInfo.favIconUrl) {
            void this.setAgentFavicon(tabId);
          }
        }
      });
    }
  }

  /**
   * Replaces the tab favicon with the glowing agent indicator
   */
  public async setAgentFavicon(tabId: number): Promise<boolean> {
    if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
      return false;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !tab.url || isRestrictedChromeUrl(tab.url)) {
        return false;
      }

      // If not yet recorded or recorded as null, record original favicon if available
      if (!this.originalFavicons.has(tabId) || !this.originalFavicons.get(tabId)) {
        if (
          tab.favIconUrl &&
          tab.favIconUrl !== AGENT_FAVICON_DATA_URL &&
          !tab.favIconUrl.includes('cursor-halo')
        ) {
          this.originalFavicons.set(tabId, tab.favIconUrl);
          void this.saveToStorage();
        } else if (!this.originalFavicons.has(tabId)) {
          this.originalFavicons.set(tabId, null);
          void this.saveToStorage();
        }
      }

      const agentDataUrl = AGENT_FAVICON_DATA_URL;

      await chrome.scripting.executeScript({
        target: { tabId },
        func: (dataUrl: string) => {
          try {
            const head = document.head || document.documentElement;
            const links = Array.from(
              document.querySelectorAll<HTMLLinkElement>(
                "link[rel~='icon'], link[rel='shortcut icon'], link[rel='alternate icon'], link[rel='apple-touch-icon']",
              ),
            );
            for (const link of links) {
              if (
                link.getAttribute('data-browserpaw-injected') === 'true' ||
                link.getAttribute('data-browserclaw-injected') === 'true'
              ) {
                link.remove();
                continue;
              }
              if (
                !link.dataset.browserpawOriginalFavicon &&
                !link.dataset.browserclawOriginalFavicon
              ) {
                link.dataset.browserpawOriginalFavicon = link.href;
                link.dataset.browserpawOriginalRel = link.rel;
                link.dataset.browserclawOriginalFavicon = link.href;
                link.dataset.browserclawOriginalRel = link.rel;
              }
              link.rel = 'alternate icon';
            }
            const link = document.createElement('link');
            link.rel = 'icon';
            link.type = 'image/svg+xml';
            link.setAttribute('data-browserpaw-injected', 'true');
            link.setAttribute('data-browserclaw-injected', 'true');
            link.href = dataUrl;
            if (head.firstChild) {
              head.insertBefore(link, head.firstChild);
            } else {
              head.appendChild(link);
            }
          } catch {}
        },
        args: [agentDataUrl],
      });

      return true;
    } catch (error) {
      // Script injection might fail on restricted or unloading tabs; fail silently
      return false;
    }
  }

  /**
   * Restores the tab's original favicon
   */
  public async restoreFavicon(tabId: number): Promise<boolean> {
    const timer = this.idleTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(tabId);
    }
    if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
      this.originalFavicons.delete(tabId);
      return false;
    }

    const origUrl = this.originalFavicons.get(tabId);
    this.originalFavicons.delete(tabId);
    void this.saveToStorage();

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (originalHref: string | null) => {
          try {
            const injected = document.querySelectorAll(
              'link[data-browserpaw-injected="true"], link[data-browserclaw-injected="true"]',
            );
            injected.forEach((el) => el.remove());
            const links = Array.from(
              document.querySelectorAll<HTMLLinkElement>(
                "link[rel~='icon'], link[rel='shortcut icon'], link[rel='alternate icon'], link[rel='apple-touch-icon']",
              ),
            );
            for (const link of links) {
              const origRel =
                link.dataset.browserpawOriginalRel || link.dataset.browserclawOriginalRel;
              if (origRel) {
                link.rel = origRel;
                delete link.dataset.browserpawOriginalRel;
                delete link.dataset.browserclawOriginalRel;
              }
              const origFav =
                link.dataset.browserpawOriginalFavicon || link.dataset.browserclawOriginalFavicon;
              if (origFav) {
                link.href = origFav;
                delete link.dataset.browserpawOriginalFavicon;
                delete link.dataset.browserclawOriginalFavicon;
              } else if (originalHref) {
                link.href = originalHref;
              }
            }
          } catch {}
        },
        args: [origUrl ?? null],
      });
      return true;
    } catch {
      return false;
    }
  }

  public getOriginalFavicon(tabId: number): string | null | undefined {
    return this.originalFavicons.get(tabId);
  }

  /**
   * Marks a tab active under Agent automation:
   * Replaces favicon with the glowing agent indicator and resets the idle auto-restore timer.
   */
  public markTabActive(tabId: number, idleRestoreMs = 600000): void {
    if (typeof tabId !== 'number' || tabId <= 0) return;
    void this.setAgentFavicon(tabId);
    const existing = this.idleTimers.get(tabId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.idleTimers.delete(tabId);
      void this.restoreFavicon(tabId);
    }, idleRestoreMs);
    this.idleTimers.set(tabId, timer);
  }

  public resetForTest(): void {
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    this.originalFavicons.clear();
  }
}

export const tabFaviconManager = TabFaviconManager.getInstance();
