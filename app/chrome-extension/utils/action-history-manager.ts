export type ActionRecord =
  | { type: 'navigate'; prevUrl: string; timestamp: number }
  | { type: 'fill'; index?: number; selector?: string; prevValue: string; timestamp: number };

export class ActionHistoryManager {
  private static instance: ActionHistoryManager | null = null;
  private historyByTab = new Map<number, ActionRecord[]>();
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
      });
    }
  }

  public pushAction(tabId: number, record: ActionRecord): void {
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
