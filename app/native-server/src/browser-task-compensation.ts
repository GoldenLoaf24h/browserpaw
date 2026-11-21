import type {
  BrowserTask,
  BrowserTaskInventory,
  BrowserTaskPageCompensation,
  BrowserTaskPendingCreation,
  TaskPage,
} from './browser-task-types';
import { lastActiveTabId, taskInventory } from './browser-task-ownership';

interface CompensationOptions {
  previousCurrentTabId?: number;
  previousBrowserInstanceId?: string;
  pageWasPersisted: boolean;
  pendingCreation?: BrowserTaskPendingCreation;
}

interface CompensationResult {
  task: BrowserTaskInventory;
  page: TaskPage;
  compensation: BrowserTaskPageCompensation;
  message: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function compensateFailedOpenPage(
  close: () => Promise<void>,
  withLedgerLock: <T>(operation: () => Promise<T>) => Promise<T>,
  requireTask: (taskId: string) => BrowserTask,
  persist: () => Promise<void>,
  taskId: string,
  page: TaskPage,
  options: CompensationOptions,
): Promise<CompensationResult> {
  let cleanupError: string | undefined;
  try {
    await close();
  } catch (error) {
    cleanupError = errorMessage(error);
  }

  return withLedgerLock(async () => {
    const current = requireTask(taskId);
    let target = current.pages.find(
      (candidate) =>
        candidate.tabId === page.tabId &&
        candidate.documentId === page.documentId &&
        candidate.browserInstanceId === page.browserInstanceId &&
        candidate.ownership === 'owned' &&
        candidate.state === 'active',
    );

    if (!cleanupError) {
      if (target) {
        current.pages = current.pages.filter((candidate) => candidate !== target);
        if (current.currentTabId === page.tabId) {
          current.currentTabId =
            options.previousCurrentTabId === page.tabId
              ? lastActiveTabId(current)
              : options.previousCurrentTabId;
        }
        if (!options.pageWasPersisted && current.browserInstanceId === page.browserInstanceId) {
          current.browserInstanceId = options.previousBrowserInstanceId;
        }
      }
      if (options.pendingCreation) {
        current.pendingCreations = current.pendingCreations.filter(
          (candidate) => candidate !== options.pendingCreation,
        );
      }
      const compensatedPage = target || page;
      compensatedPage.state = 'closed';
      current.updatedAt = Date.now();
      let ledgerPersisted = true;
      let ledgerError: string | undefined;
      try {
        await persist();
      } catch (error) {
        ledgerPersisted = false;
        ledgerError = errorMessage(error);
      }
      return {
        task: taskInventory(current),
        page: compensatedPage,
        compensation: {
          status: 'closed',
          tabId: page.tabId,
          documentId: page.documentId,
          browserInstanceId: page.browserInstanceId,
          ledgerPersisted,
          ...(ledgerError ? { error: `Final ledger persistence failed: ${ledgerError}` } : {}),
        },
        message: ledgerPersisted
          ? 'the self-created page was closed after exact identity verification'
          : `the self-created page was closed after exact identity verification, but the final ledger state could not be persisted: ${ledgerError}`,
      };
    }

    if (!target && !options.pageWasPersisted) {
      current.pages.push(page);
      current.currentTabId = page.tabId;
      current.browserInstanceId = page.browserInstanceId;
      target = page;
    }
    if (options.pendingCreation) {
      current.pendingCreations = current.pendingCreations.filter(
        (candidate) => candidate !== options.pendingCreation,
      );
    }
    if (target) {
      target.recovery = {
        status: 'cleanupPending',
        reason: cleanupError,
        failedAt: Date.now(),
      };
    }
    current.updatedAt = Date.now();
    let ledgerPersisted = true;
    let ledgerError: string | undefined;
    try {
      await persist();
    } catch (error) {
      ledgerPersisted = false;
      ledgerError = errorMessage(error);
    }
    return {
      task: taskInventory(current),
      page: target || page,
      compensation: {
        status: 'retained',
        tabId: page.tabId,
        documentId: page.documentId,
        browserInstanceId: page.browserInstanceId,
        ledgerPersisted,
        error: cleanupError,
      },
      message: ledgerPersisted
        ? `verified cleanup did not complete (${cleanupError}); the page identity and cleanupPending state were persisted for recovery`
        : `verified cleanup did not complete (${cleanupError}); the page identity remains in memory, but neither cleanup nor its recovery record could be persisted: ${ledgerError}`,
    };
  });
}
