export type ActionRecord =
  | { type: 'navigate'; prevUrl: string; timestamp: number; documentEpoch?: number }
  | {
      type: 'fill';
      index?: number;
      selector?: string;
      prevValue: string;
      timestamp: number;
      documentEpoch?: number;
    };

export class ActionHistoryManager {
  private static instance: ActionHistoryManager | null = null;
  private historyByTab = new Map<number, ActionRecord[]>();
  private documentEpochByTab = new Map<number, number>();
  private readonly MAX_HISTORY = 5;

  public static getInstance(): ActionHistoryManager {
    if (!ActionHistoryManager.instance) {
      ActionHistoryManager.instance = new ActionHistoryManager();
    }
    return ActionHistoryManager.instance;
  }

  constructor() {
    if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        this.historyByTab.delete(tabId);
        this.documentEpochByTab.delete(tabId);
      });
    }

    // Document identity: every committed main-frame navigation - hard load or SPA
    // history update - starts a new document epoch. Records stamped with an older
    // epoch must never be replayed into the new document.
    if (typeof chrome !== 'undefined') {
      const bumpDocumentEpoch = (details: { tabId?: number; frameId?: number }) => {
        if (typeof details?.tabId !== 'number') return;
        if (typeof details.frameId === 'number' && details.frameId !== 0) return;
        this.documentEpochByTab.set(details.tabId, this.getDocumentEpoch(details.tabId) + 1);
      };
      chrome.webNavigation?.onCommitted?.addListener?.(bumpDocumentEpoch);
      chrome.webNavigation?.onHistoryStateUpdated?.addListener?.(bumpDocumentEpoch);
    }
  }

  public getDocumentEpoch(tabId: number): number {
    return this.documentEpochByTab.get(tabId) ?? 0;
  }

  public pushAction(tabId: number, record: ActionRecord): void {
    record.documentEpoch = this.getDocumentEpoch(tabId);
    const list = this.historyByTab.get(tabId) || [];
    list.push(record);
    if (list.length > this.MAX_HISTORY) {
      list.shift();
    }
    this.historyByTab.set(tabId, list);
  }

  public popAction(tabId: number): ActionRecord | undefined {
    const list = this.historyByTab.get(tabId);
    if (!list || list.length === 0) return undefined;
    return list.pop();
  }

  public peekAction(tabId: number): ActionRecord | undefined {
    const list = this.historyByTab.get(tabId);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  public removeAction(tabId: number, record: ActionRecord): boolean {
    const list = this.historyByTab.get(tabId);
    if (!list || list.length === 0) return false;
    const idx = list.lastIndexOf(record);
    if (idx !== -1) {
      list.splice(idx, 1);
      return true;
    }
    return false;
  }

  public clear(tabId?: number): void {
    if (typeof tabId === 'number') {
      this.historyByTab.delete(tabId);
    } else {
      this.historyByTab.clear();
    }
  }
}

export const actionHistoryManager = ActionHistoryManager.getInstance();
