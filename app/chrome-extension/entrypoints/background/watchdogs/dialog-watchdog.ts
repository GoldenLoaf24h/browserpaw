import { BaseWatchdog } from './base-watchdog';
import { cdpSessionManager, type CdpEventObserver } from '@/utils/cdp-session-manager';

export interface DialogEventData {
  tabId: number;
  type?: string;
  message?: string;
  defaultPrompt?: string;
  url?: string;
  timestamp: number;
}

/**
 * Dialog Watchdog
 * Decoupled observer for native JavaScript alert/confirm/prompt/beforeunload dialogs.
 * Listens on CDP Page.javascriptDialogOpening / Page.javascriptDialogClosed
 * and emits 'dialog-opened' / 'dialog-closed' events across the extension event bus.
 */
export class DialogWatchdog extends BaseWatchdog {
  public readonly name = 'dialog';
  public readonly listensTo = ['Page.javascriptDialogOpening', 'Page.javascriptDialogClosed'];
  private observer: CdpEventObserver | null = null;
  private pendingDialogs = new Map<number, DialogEventData>();
  private tabRemovedListener: ((tabId: number) => void) | null = null;

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.observer = (tabId: number, method: string, params: any) => {
      if (method === 'Page.javascriptDialogOpening') {
        const data: DialogEventData = {
          tabId,
          type: params?.type,
          message: params?.message,
          defaultPrompt: params?.defaultPrompt,
          url: params?.url,
          timestamp: Date.now(),
        };
        this.pendingDialogs.set(tabId, data);
        this.emit('dialog-opened', data);
      } else if (method === 'Page.javascriptDialogClosed') {
        const previous = this.pendingDialogs.get(tabId);
        this.pendingDialogs.delete(tabId);
        this.emit('dialog-closed', {
          tabId,
          result: params?.result,
          userInput: params?.userInput,
          previous,
          timestamp: Date.now(),
        });
      }
    };

    cdpSessionManager.addCdpEventObserver(this.observer);

    this.tabRemovedListener = (tabId: number) => {
      this.pendingDialogs.delete(tabId);
    };
    if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
      chrome.tabs.onRemoved.addListener(this.tabRemovedListener);
    }
  }

  public stop(): void {
    if (!this.isRunning) return;
    if (this.observer) {
      cdpSessionManager.removeCdpEventObserver(this.observer);
      this.observer = null;
    }
    if (this.tabRemovedListener) {
      if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.removeListener) {
        chrome.tabs.onRemoved.removeListener(this.tabRemovedListener);
      }
      this.tabRemovedListener = null;
    }
    this.pendingDialogs.clear();
    this.isRunning = false;
  }

  public getPendingDialog(tabId: number): DialogEventData | undefined {
    return this.pendingDialogs.get(tabId);
  }

  public hasPendingDialog(tabId: number): boolean {
    return this.pendingDialogs.has(tabId);
  }
}

export const dialogWatchdog = new DialogWatchdog();
