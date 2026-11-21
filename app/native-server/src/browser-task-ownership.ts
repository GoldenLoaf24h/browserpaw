import type {
  BrowserInventory,
  BrowserTask,
  BrowserTaskInventory,
  BrowserTaskPageInventory,
  BrowserTaskSummary,
  TaskPage,
} from './browser-task-types';

export function pageInventory(page: TaskPage): BrowserTaskPageInventory {
  return {
    tabId: page.tabId,
    ...(page.openerTabId !== undefined ? { openerTabId: page.openerTabId } : {}),
    ownership: page.ownership,
    state: page.state,
    url: page.url,
    documentId: page.documentId,
    browserInstanceId: page.browserInstanceId,
    ...(page.pendingDocumentId ? { pendingDocumentId: page.pendingDocumentId } : {}),
    ...(page.viewport ? { viewport: page.viewport } : {}),
    ...(page.recovery ? { recovery: page.recovery } : {}),
  };
}

export function taskInventory(task: BrowserTask): BrowserTaskInventory {
  return {
    id: task.id,
    name: task.name,
    ...(task.goal ? { goal: task.goal } : {}),
    ...(task.browser ? { browser: task.browser } : {}),
    ...(task.browserInstanceId ? { browserInstanceId: task.browserInstanceId } : {}),
    status: task.status,
    maxPages: task.maxPages,
    ...(task.currentTabId !== undefined ? { currentTabId: task.currentTabId } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.cancelledAt !== undefined ? { cancelledAt: task.cancelledAt } : {}),
    pages: task.pages.map(pageInventory),
    pendingCreations: task.pendingCreations,
    downloads: task.downloads || [],
  };
}

export function taskSummary(task: BrowserTask): BrowserTaskSummary {
  return {
    id: task.id,
    name: task.name,
    ...(task.goal ? { goal: task.goal } : {}),
    status: task.status,
    ...(task.currentTabId !== undefined ? { currentTabId: task.currentTabId } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.cancelledAt !== undefined ? { cancelledAt: task.cancelledAt } : {}),
    pageCount: task.pages.length,
    downloadCount: task.downloads?.length ?? 0,
    ...(task.pendingCreations.length > 0
      ? { pendingCreationCount: task.pendingCreations.length }
      : {}),
  };
}

export function activeOwnedPages(task: BrowserTask): TaskPage[] {
  return task.pages.filter((page) => page.ownership === 'owned' && page.state === 'active');
}

export function lastActiveTabId(task: BrowserTask): number | undefined {
  return task.pages
    .filter(
      (page) =>
        page.state === 'active' && (page.ownership === 'owned' || page.ownership === 'borrowed'),
    )
    .at(-1)?.tabId;
}

export function pageIdentityVerified(
  task: BrowserTask,
  page: TaskPage,
  inventory: BrowserInventory,
): boolean {
  const observed = inventory.tabs.find((candidate) => candidate.tabId === page.tabId);
  return Boolean(
    task.browserInstanceId === inventory.browserInstanceId &&
    page.browserInstanceId === inventory.browserInstanceId &&
    observed?.browserInstanceId === inventory.browserInstanceId &&
    observed.documentId === page.documentId &&
    (page.ownership !== 'owned' || observed.isAgentManaged === true),
  );
}

export function pendingIdentityCanBeAdopted(
  task: BrowserTask,
  page: TaskPage,
  inventory: BrowserInventory,
): boolean {
  const observed = inventory.tabs.find((candidate) => candidate.tabId === page.tabId);
  return Boolean(
    task.browserInstanceId === inventory.browserInstanceId &&
    page.browserInstanceId === inventory.browserInstanceId &&
    observed?.browserInstanceId === inventory.browserInstanceId &&
    observed.documentId &&
    page.pendingDocumentId === observed.documentId &&
    (page.ownership !== 'owned' || observed.isAgentManaged === true),
  );
}

export function knownPendingTabId(pending: { tabId?: number }): number | undefined {
  return typeof pending.tabId === 'number' && Number.isInteger(pending.tabId) && pending.tabId > 0
    ? pending.tabId
    : undefined;
}

export function isUnknownPending(pending: { tabId?: number; unknownId?: string }): boolean {
  return (
    knownPendingTabId(pending) === undefined &&
    typeof pending.unknownId === 'string' &&
    pending.unknownId.trim().length > 0
  );
}
