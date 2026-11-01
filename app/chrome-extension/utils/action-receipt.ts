import type { DownloadObservation } from 'chrome-mcp-shared';
import { downloadsWatchdog } from '../entrypoints/background/watchdogs';
import { cdpSessionManager, type CdpEventObserver } from './cdp-session-manager';

export interface PopupReceipt {
  tabId: number;
  url?: string;
  title?: string;
  openerTabId?: number;
  windowId?: number;
}

export interface DialogReceipt {
  dialogId?: string;
  type: string;
  message: string;
  defaultPrompt?: string;
  sessionId?: string;
}

export interface FileChooserReceipt {
  mode?: string;
  backendNodeId?: number;
  sessionId?: string;
  requiresAction?: boolean;
}

export interface ActionReceipt {
  hasReceipt: boolean;
  popups?: PopupReceipt[];
  dialog?: DialogReceipt;
  dialogs?: DialogReceipt[];
  fileChooser?: FileChooserReceipt;
  downloads?: DownloadObservation[];
}

export interface ActionReceiptOptions {
  settleMs?: number;
}

export interface ActionReceiptHandle {
  finish: () => Promise<ActionReceipt>;
  cancel: () => void;
}

const MAX_TITLE_LEN = 120;
const MAX_MSG_LEN = 500;
const MAX_URL_LEN = 500;
const DEFAULT_SETTLE_MS = 50;

function truncate(text: unknown, maxLen = MAX_MSG_LEN): string | undefined {
  if (typeof text !== 'string') return undefined;
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

export function startActionReceipt(
  tabId: number,
  options?: ActionReceiptOptions,
): ActionReceiptHandle {
  const settleMs = Math.max(0, Math.min(500, options?.settleMs ?? DEFAULT_SETTLE_MS));
  let state: 'active' | 'settling' | 'done' = 'active';
  let finishPromise: Promise<ActionReceipt> | null = null;
  let cachedReceipt: ActionReceipt = { hasReceipt: false };

  const dialogs: DialogReceipt[] = [];
  let dialogSequence = 0;
  let observedFileChooser: FileChooserReceipt | undefined;
  const observedPopups = new Map<number, PopupReceipt>();
  const downloadByGuid = new Map<string, DownloadObservation>();
  const preexistingDownloads = new Set<string>();
  let offDownloads = () => {};
  try {
    for (const item of downloadsWatchdog.getPageDownloads(tabId) || []) {
      if (item?.tabId === tabId && item.guid) preexistingDownloads.add(item.guid);
    }
    offDownloads = downloadsWatchdog.on('source-download-updated', (item: DownloadObservation) => {
      if (state === 'done' || item?.tabId !== tabId || !item.guid) return;
      if (preexistingDownloads.has(item.guid)) return;
      if (typeof item.sequence !== 'number' || !Number.isFinite(item.sequence)) return;
      const prev = downloadByGuid.get(item.guid);
      if (prev && prev.sequence >= item.sequence) return;
      downloadByGuid.set(item.guid, item);
    });
  } catch {
    offDownloads = () => {};
    downloadByGuid.clear();
  }

  const pendingDialogs = cdpSessionManager.getPendingDialogs(tabId);
  const legacyPending = cdpSessionManager.getPendingDialog(tabId);
  if (
    legacyPending &&
    !pendingDialogs.some((dialog) => dialog.dialogId === legacyPending.dialogId)
  ) {
    pendingDialogs.push(legacyPending);
  }
  for (const existing of pendingDialogs) {
    dialogs.push({
      dialogId: existing.dialogId || `receipt-${tabId}-existing-${++dialogSequence}`,
      type: existing.type || 'alert',
      message: truncate(existing.message, MAX_MSG_LEN) || '',
      defaultPrompt: truncate(existing.defaultPrompt, MAX_MSG_LEN),
      sessionId: existing.sessionId,
    });
  }

  const cdpObserver: CdpEventObserver = (eventTabId, method, params, source) => {
    if (state === 'done' || eventTabId !== tabId) return;
    if (method === 'Page.javascriptDialogOpening') {
      const sessionId = source?.sessionId;
      const managed = cdpSessionManager
        .getPendingDialogs(tabId)
        .filter(
          (dialog) =>
            dialog.sessionId === sessionId &&
            !dialogs.some((existingDialog) => existingDialog.dialogId === dialog.dialogId),
        );
      dialogs.push({
        dialogId:
          managed[managed.length - 1]?.dialogId ||
          `receipt-${tabId}-${sessionId || 'root'}-${++dialogSequence}`,
        type: String(params?.type || 'alert'),
        message: truncate(params?.message, MAX_MSG_LEN) || '',
        defaultPrompt: truncate(params?.defaultPrompt, MAX_MSG_LEN),
        sessionId,
      });
    } else if (method === 'Page.javascriptDialogClosed') {
      const sessionId = source?.sessionId;
      const index = dialogs.findIndex((dialog) => dialog.sessionId === sessionId);
      if (index >= 0) dialogs.splice(index, 1);
    } else if (method === 'Page.fileChooserOpened') {
      observedFileChooser = {
        mode: params?.mode,
        backendNodeId: params?.backendNodeId,
        sessionId: source?.sessionId,
        requiresAction: true,
      };
    }
  };
  cdpSessionManager.addCdpEventObserver(cdpObserver);

  const onCreated = (tab: chrome.tabs.Tab) => {
    if (state === 'done' || !tab || typeof tab.id !== 'number' || tab.id === tabId) return;
    if (tab.openerTabId === tabId) {
      observedPopups.set(tab.id, {
        tabId: tab.id,
        url: truncate(tab.url || (tab as any).pendingUrl, MAX_URL_LEN),
        title: truncate(tab.title, MAX_TITLE_LEN),
        openerTabId: tab.openerTabId,
        windowId: tab.windowId,
      });
    }
  };

  const onNavTarget = (d: { sourceTabId: number; tabId: number; url?: string }) => {
    if (state === 'done' || !d || d.sourceTabId !== tabId || d.tabId === tabId) return;
    const existingPopup = observedPopups.get(d.tabId);
    if (existingPopup) {
      if (!existingPopup.url && d.url) existingPopup.url = truncate(d.url, MAX_URL_LEN);
    } else {
      observedPopups.set(d.tabId, {
        tabId: d.tabId,
        url: truncate(d.url, MAX_URL_LEN),
        openerTabId: tabId,
      });
    }
  };

  const onUpdated = (id: number, chg: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
    if (state === 'done') return;
    const popup = observedPopups.get(id);
    if (popup) {
      if (chg.url || tab.url) popup.url = truncate(chg.url || tab.url, MAX_URL_LEN);
      if (chg.title || tab.title) popup.title = truncate(chg.title || tab.title, MAX_TITLE_LEN);
    }
  };

  if (typeof chrome !== 'undefined') {
    chrome.tabs?.onCreated?.addListener?.(onCreated);
    chrome.tabs?.onUpdated?.addListener?.(onUpdated);
    chrome.webNavigation?.onCreatedNavigationTarget?.addListener?.(onNavTarget);
  }

  const cleanup = () => {
    const off = offDownloads;
    offDownloads = () => {};
    try {
      off();
    } catch {
      // Listener removal is best-effort; the receipt itself must still settle.
    }
    cdpSessionManager.removeCdpEventObserver(cdpObserver);
    if (typeof chrome !== 'undefined') {
      chrome.tabs?.onCreated?.removeListener?.(onCreated);
      chrome.tabs?.onUpdated?.removeListener?.(onUpdated);
      chrome.webNavigation?.onCreatedNavigationTarget?.removeListener?.(onNavTarget);
    }
  };

  const cancel = () => {
    if (state === 'done') return;
    state = 'done';
    cleanup();
  };

  const finish = (): Promise<ActionReceipt> => {
    if (state === 'done') return Promise.resolve(cachedReceipt);
    if (finishPromise) return finishPromise;

    finishPromise = (async () => {
      state = 'settling';
      try {
        if (settleMs > 0) {
          await new Promise((r) => setTimeout(r, settleMs));
        }
        const popups = observedPopups.size > 0 ? Array.from(observedPopups.values()) : undefined;
        const receipts = dialogs.length > 0 ? [...dialogs] : undefined;
        const dialog = receipts?.[receipts.length - 1];
        // Map insertion is first-start order; a later progress sequence must not move an earlier GUID.
        const downloads = downloadByGuid.size > 0 ? [...downloadByGuid.values()] : undefined;
        const hasReceipt = Boolean(dialog || observedFileChooser || popups || downloads);
        cachedReceipt = {
          hasReceipt,
          ...(popups ? { popups } : {}),
          ...(dialog ? { dialog } : {}),
          ...(receipts ? { dialogs: receipts } : {}),
          ...(observedFileChooser ? { fileChooser: observedFileChooser } : {}),
          ...(downloads ? { downloads } : {}),
        };
        return cachedReceipt;
      } finally {
        state = 'done';
        cleanup();
      }
    })();
    return finishPromise;
  };

  return { finish, cancel };
}

export function attachActionReceipt<T extends object>(result: T, receipt?: ActionReceipt): T {
  if (!receipt || !receipt.hasReceipt || !result || typeof result !== 'object') {
    return result;
  }
  const res = result as any;
  if (Array.isArray(res.content)) {
    for (let i = res.content.length - 1; i >= 0; i--) {
      const block = res.content[i];
      if (block?.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsed.receipt = receipt;
            block.text = JSON.stringify(parsed);
            return result;
          }
          if (Array.isArray(parsed) || (parsed !== null && typeof parsed !== 'object')) {
            res.content.push({ type: 'text', text: JSON.stringify({ receipt }) });
            return result;
          }
        } catch {
          const isErr = Boolean(res.isError);
          block.text = JSON.stringify(
            isErr
              ? { success: false, error: block.text, receipt }
              : { success: true, text: block.text, receipt },
          );
          return result;
        }
      }
    }
    res.content.push({ type: 'text', text: JSON.stringify({ receipt }) });
    return result;
  }
  res.receipt = receipt;
  return result;
}

export async function withActionReceipt<T extends object>(
  tabId: number,
  run: () => Promise<T>,
  options?: ActionReceiptOptions,
): Promise<T> {
  const handle = startActionReceipt(tabId, options);
  let didThrow = false;
  let runError: unknown;
  let val: T | undefined;

  try {
    val = await run();
  } catch (err) {
    didThrow = true;
    runError = err;
  }

  try {
    let receipt: ActionReceipt = { hasReceipt: false };
    try {
      receipt = await handle.finish();
    } catch (finishErr) {
      if (!didThrow) throw finishErr;
    }

    if (didThrow) {
      if (receipt.hasReceipt && runError && typeof runError === 'object') {
        (runError as any).receipt = receipt;
      }
      throw runError;
    }

    if (!receipt.hasReceipt || !val || typeof val !== 'object') {
      return val as T;
    }

    return attachActionReceipt(val, receipt);
  } finally {
    handle.cancel();
  }
}
