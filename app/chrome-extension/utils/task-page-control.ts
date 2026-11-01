import { cdpSessionManager } from './cdp-session-manager';
import { getBrowserInstanceId } from './browser-identity';
import { tabGroupManager } from '../entrypoints/background/tools/browser/tab-group-manager';
import { tabFaviconManager } from '../entrypoints/background/tools/browser/tab-favicon';
import { downloadsWatchdog } from '../entrypoints/background/watchdogs/downloads-watchdog';

export type TaskPageControlAction = 'viewport' | 'release';
export type TaskPageOwnership = 'owned' | 'borrowed' | 'user';

export interface TaskPageControlPayload {
  action: TaskPageControlAction;
  taskId: string;
  tabId: number;
  documentId: string;
  browserInstanceId: string;
  ownership: TaskPageOwnership;
}

export interface TaskPageControlResult {
  success: boolean;
  action: TaskPageControlAction;
  error?: string;
  released?: boolean;
  idempotent?: boolean;
  warnings?: string[];
  viewportRestored?: boolean;
  viewport?: {
    status: 'native' | 'limited';
    width: number;
    height: number;
    dpr?: number;
    reason?: string;
  };
}

interface ViewportHolder {
  taskId: string;
  tabId: number;
  documentId: string;
  browserInstanceId: string;
  owner: string;
}

const STORAGE_KEY = 'task_page_control_holders';
const RELEASED_STORAGE_KEY = 'task_page_control_released';
const holders = new Map<string, ViewportHolder>();
const releasedReceipts = new Map<string, ReleasedReceipt>();
const taskQueues = new Map<string, Promise<unknown>>();
let holdersLoaded: Promise<void> | null = null;
let tabRemovalListenerRegistered = false;

function ownerForTask(taskId: string): string {
  return `task-viewport:${taskId}`;
}

function holderKey(taskId: string, tabId: number): string {
  return `${taskId}\u0000${tabId}`;
}

interface ReleasedReceipt {
  taskId: string;
  tabId: number;
  documentId: string;
  browserInstanceId: string;
  releasedAt: number;
}

function releasedKey(payload: TaskPageControlPayload): string {
  return `${holderKey(payload.taskId, payload.tabId)}\u0000${payload.documentId}\u0000${payload.browserInstanceId}`;
}

function validPayload(payload: TaskPageControlPayload): string | null {
  if (payload?.action !== 'viewport' && payload?.action !== 'release') {
    return 'action must be "viewport" or "release"';
  }
  if (!payload.taskId || typeof payload.taskId !== 'string') return 'taskId is required';
  if (!Number.isSafeInteger(payload.tabId) || payload.tabId <= 0) return 'tabId is required';
  if (!payload.documentId || typeof payload.documentId !== 'string') {
    return 'documentId is required';
  }
  if (!payload.browserInstanceId || typeof payload.browserInstanceId !== 'string') {
    return 'browserInstanceId is required';
  }
  return null;
}

function registerTabRemovalListener(): void {
  if (tabRemovalListenerRegistered || typeof chrome === 'undefined') return;
  if (!chrome.tabs?.onRemoved?.addListener) return;
  tabRemovalListenerRegistered = true;
  chrome.tabs.onRemoved.addListener((tabId) => {
    let changed = false;
    for (const [key, holder] of holders.entries()) {
      if (holder.tabId === tabId) {
        holders.delete(key);
        changed = true;
      }
    }
    if (changed) void persistHolders();
  });
}

async function ensureHoldersLoaded(): Promise<void> {
  registerTabRemovalListener();
  if (holdersLoaded) return holdersLoaded;
  holdersLoaded = (async () => {
    try {
      const stored = await chrome.storage.session.get([STORAGE_KEY, RELEASED_STORAGE_KEY]);
      const entries = stored?.[STORAGE_KEY];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (
            entry &&
            typeof entry.taskId === 'string' &&
            Number.isSafeInteger(entry.tabId) &&
            typeof entry.documentId === 'string' &&
            typeof entry.browserInstanceId === 'string' &&
            typeof entry.owner === 'string' &&
            entry.owner === ownerForTask(entry.taskId)
          ) {
            holders.set(holderKey(entry.taskId, entry.tabId), entry as ViewportHolder);
          }
        }
      }
      const receipts = stored?.[RELEASED_STORAGE_KEY];
      if (Array.isArray(receipts)) {
        for (const receipt of receipts) {
          if (
            receipt &&
            typeof receipt.taskId === 'string' &&
            Number.isSafeInteger(receipt.tabId) &&
            typeof receipt.documentId === 'string' &&
            typeof receipt.browserInstanceId === 'string' &&
            Number.isFinite(receipt.releasedAt)
          ) {
            const payload = receipt as TaskPageControlPayload;
            releasedReceipts.set(releasedKey(payload), receipt as ReleasedReceipt);
          }
        }
      }
    } catch {}
  })();
  return holdersLoaded;
}

async function persistHolders(): Promise<boolean> {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: Array.from(holders.values()),
      [RELEASED_STORAGE_KEY]: Array.from(releasedReceipts.values()),
    });
    return true;
  } catch {
    return false;
  }
}

async function verifyOwnedPage(payload: TaskPageControlPayload): Promise<string | null> {
  if (payload.ownership !== 'owned') {
    return `Task page ownership is ${payload.ownership}; only self-created pages are eligible`;
  }
  await tabGroupManager.ensureStorageLoaded();
  if (!tabGroupManager.isAgentTab(payload.tabId)) {
    return `Tab ${payload.tabId} is not registered as an agent-owned tab`;
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(payload.tabId);
  } catch {
    return `Tab ${payload.tabId} no longer exists`;
  }
  if (!tab?.id) return `Tab ${payload.tabId} no longer exists`;

  let documentId: string | undefined;
  try {
    documentId = (await chrome.webNavigation.getFrame({ tabId: payload.tabId, frameId: 0 }))
      ?.documentId;
  } catch {}
  if (!documentId || documentId !== payload.documentId) {
    return `Tab ${payload.tabId} document identity does not match`;
  }

  let browserInstanceId: string;
  try {
    browserInstanceId = await getBrowserInstanceId();
  } catch (error) {
    return `Browser identity unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (browserInstanceId !== payload.browserInstanceId) {
    return `Browser instance identity does not match`;
  }
  return null;
}

async function runTaskExclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
  const previous = taskQueues.get(taskId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  taskQueues.set(taskId, current);
  try {
    return await current;
  } finally {
    if (taskQueues.get(taskId) === current) taskQueues.delete(taskId);
  }
}

async function detachViewportOwner(tabId: number, owner: string): Promise<void> {
  try {
    await cdpSessionManager.detach(tabId, owner);
  } catch {}
}

async function applyViewport(payload: TaskPageControlPayload): Promise<TaskPageControlResult> {
  await ensureHoldersLoaded();
  const initialIdentityError = await verifyOwnedPage(payload);
  if (initialIdentityError) {
    return { success: false, action: 'viewport', error: initialIdentityError };
  }
  const key = holderKey(payload.taskId, payload.tabId);
  const existing = holders.get(key);
  const owner = ownerForTask(payload.taskId);
  let attachedForThisAttempt = false;
  try {
    const currentlyAttached = cdpSessionManager.isAttached(payload.tabId);
    if (!existing && currentlyAttached) {
      // A restarted worker can lose the in-memory holder while chrome.debugger
      // remains attached. Remove a possible orphan owner before reacquiring.
      await detachViewportOwner(payload.tabId, owner);
    }
    if (!existing || !currentlyAttached) {
      await cdpSessionManager.attach(payload.tabId, owner);
      attachedForThisAttempt = true;
    }
    holders.set(key, {
      taskId: payload.taskId,
      tabId: payload.tabId,
      documentId: payload.documentId,
      browserInstanceId: payload.browserInstanceId,
      owner,
    });
    await persistHolders();

    const identityError = await verifyOwnedPage(payload);
    if (identityError) throw new Error(identityError);
    // Follow the real window. A fixed emulated viewport makes wide/portrait
    // windows look wrong and hides the user's actual DPR.
    await cdpSessionManager.sendCommand(payload.tabId, 'Emulation.clearDeviceMetricsOverride', {});
    const measured = await cdpSessionManager.sendCommand(payload.tabId, 'Runtime.evaluate', {
      expression: '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })',
      returnByValue: true,
    });
    const value = measured?.result?.value;
    if (
      !Number.isFinite(value?.width) ||
      value.width <= 0 ||
      !Number.isFinite(value?.height) ||
      value.height <= 0 ||
      !Number.isFinite(value?.dpr) ||
      value.dpr <= 0
    ) {
      throw new Error(
        `Native viewport measurement failed (${value?.width ?? 'unknown'}x${value?.height ?? 'unknown'} @ ${value?.dpr ?? 'unknown'}x)`,
      );
    }
    const finalIdentityError = await verifyOwnedPage(payload);
    if (finalIdentityError) {
      throw new Error(finalIdentityError);
    }
    return {
      success: true,
      action: 'viewport',
      viewport: {
        status: 'native',
        width: Math.round(value.width),
        height: Math.round(value.height),
        dpr: Number(value.dpr),
      },
    };
  } catch (error) {
    if (attachedForThisAttempt || existing) {
      try {
        await cdpSessionManager.sendCommand(
          payload.tabId,
          'Emulation.clearDeviceMetricsOverride',
          {},
        );
      } catch {}
      await detachViewportOwner(payload.tabId, owner);
    }
    holders.delete(key);
    await persistHolders();
    return {
      success: true,
      action: 'viewport',
      viewport: {
        status: 'limited',
        width: 0,
        height: 0,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function releasePage(payload: TaskPageControlPayload): Promise<TaskPageControlResult> {
  await ensureHoldersLoaded();
  const owner = ownerForTask(payload.taskId);
  const key = holderKey(payload.taskId, payload.tabId);
  const warnings: string[] = [];

  let releaseError: string | undefined;
  let viewportRestored = true;
  try {
    await cdpSessionManager.sendCommand(payload.tabId, 'Emulation.clearDeviceMetricsOverride', {});
  } catch (error) {
    viewportRestored = false;
    warnings.push(
      `Failed to clear device metrics override: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await detachViewportOwner(payload.tabId, owner);
  let agentRegistrationReleased = false;
  try {
    await tabGroupManager.releaseAgentTab(payload.tabId);
    agentRegistrationReleased = true;
  } catch (error) {
    releaseError ||= `Failed to release agent tab registration: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return {
      success: false,
      action: 'release',
      error: releaseError,
      warnings: warnings.length > 0 ? warnings : undefined,
      viewportRestored,
    };
  }
  if (agentRegistrationReleased) {
    downloadsWatchdog.endSourceTracking(payload.tabId, 'task-page-released');
    try {
      const restored = await tabFaviconManager.restoreFavicon(payload.tabId);
      if (!restored) warnings.push('Original favicon was not restored');
    } catch (error) {
      warnings.push(
        `Failed to restore the original favicon: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  holders.delete(key);
  releasedReceipts.set(releasedKey(payload), {
    taskId: payload.taskId,
    tabId: payload.tabId,
    documentId: payload.documentId,
    browserInstanceId: payload.browserInstanceId,
    releasedAt: Date.now(),
  });
  const receiptPersisted = await persistHolders();
  if (!receiptPersisted) {
    warnings.push(
      'Release receipt could not be persisted; a later retry may not be idempotent after worker restart',
    );
  }
  return {
    success: true,
    action: 'release',
    released: true,
    viewportRestored,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function handleTaskPageControl(
  payload: TaskPageControlPayload,
): Promise<TaskPageControlResult> {
  const payloadError = validPayload(payload);
  if (payloadError) {
    return { success: false, action: payload?.action || 'viewport', error: payloadError };
  }
  return runTaskExclusive(holderKey(payload.taskId, payload.tabId), async () => {
    await ensureHoldersLoaded();
    if (payload.action === 'release' && releasedReceipts.has(releasedKey(payload))) {
      return {
        success: true,
        action: 'release',
        released: true,
        idempotent: true,
        warnings: ['Release already recorded for this task page'],
      };
    }
    const identityError = await verifyOwnedPage(payload);
    if (identityError) {
      return { success: false, action: payload.action, error: identityError };
    }
    return payload.action === 'viewport' ? applyViewport(payload) : releasePage(payload);
  });
}

export function resetTaskPageControlForTest(): void {
  holders.clear();
  releasedReceipts.clear();
  taskQueues.clear();
  holdersLoaded = null;
  tabRemovalListenerRegistered = false;
}
