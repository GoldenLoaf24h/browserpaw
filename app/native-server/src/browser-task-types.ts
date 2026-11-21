import type { CallToolResult } from 'chrome-mcp-shared';
import type { DownloadObservation } from 'chrome-mcp-shared';

export type BrowserCall = (
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
  signal?: AbortSignal,
) => Promise<CallToolResult>;

export type TaskStatus = 'active' | 'finished' | 'cancelled';
export type PageOwnership = 'owned' | 'borrowed' | 'user';
export type PageState = 'active' | 'handedOff' | 'closed';

export interface BrowserTaskViewport {
  status: 'native' | 'limited';
  width: number;
  height: number;
  dpr?: number;
  reason?: string;
}

export interface BrowserTaskPageRecovery {
  status: 'cleanupPending';
  reason: string;
  failedAt: number;
}

export interface BrowserTaskPageCompensation {
  status: 'closed' | 'retained';
  tabId: number;
  documentId: string;
  browserInstanceId: string;
  ledgerPersisted: boolean;
  error?: string;
}

export interface BrowserTaskPendingCreation {
  tabId?: number;
  unknownId?: string;
  windowId?: number;
  requestedUrl: string;
  createdAt: number;
  reason: string;
  receipt?: unknown;
  retained?: boolean;
}

export interface TaskPage {
  tabId: number;
  windowId?: number;
  openerTabId?: number;
  url: string;
  documentId: string;
  browserInstanceId: string;
  pendingDocumentId?: string;
  pendingUrl?: string;
  viewport?: BrowserTaskViewport;
  recovery?: BrowserTaskPageRecovery;
  ownership: PageOwnership;
  state: PageState;
  openedAt: number;
  lastVerifiedAt: number;
}

export interface BrowserTask {
  id: string;
  ownerSessionId?: string;
  name: string;
  goal?: string;
  browser?: string;
  browserInstanceId?: string;
  status: TaskStatus;
  maxPages: number;
  currentTabId?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  cancelledAt?: number;
  pages: TaskPage[];
  pendingCreations: BrowserTaskPendingCreation[];
  downloads?: Array<DownloadObservation & { browserInstanceId: string }>;
}

export interface TaskLedger {
  version: 1;
  tasks: Record<string, BrowserTask>;
}

export interface TaskLedgerLoad {
  ledger: TaskLedger;
  changed: boolean;
}

export interface BrowserTabSnapshot {
  tabId: number;
  windowId?: number;
  openerTabId?: number;
  url: string;
  status?: string;
  pendingUrl?: string | null;
  documentId?: string;
  browserInstanceId: string;
  isAgentManaged?: boolean;
  downloads: DownloadObservation[];
}

export interface BrowserInventory {
  browserInstanceId: string;
  sourceDownloads: boolean;
  tabs: BrowserTabSnapshot[];
}

export interface BrowserTaskPageInventory {
  tabId: number;
  openerTabId?: number;
  ownership: PageOwnership;
  state: PageState;
  url: string;
  documentId: string;
  browserInstanceId: string;
  pendingDocumentId?: string;
  viewport?: BrowserTaskViewport;
  recovery?: BrowserTaskPageRecovery;
  exists?: boolean;
  identityVerified?: boolean;
}

export interface BrowserTaskInventory {
  id: string;
  name: string;
  goal?: string;
  browser?: string;
  browserInstanceId?: string;
  status: TaskStatus;
  maxPages: number;
  currentTabId?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  cancelledAt?: number;
  pages: BrowserTaskPageInventory[];
  pendingCreations: BrowserTaskPendingCreation[];
  downloads: Array<DownloadObservation & { browserInstanceId: string }>;
}

export interface BrowserTaskSummary {
  id: string;
  name: string;
  goal?: string;
  status: TaskStatus;
  currentTabId?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  cancelledAt?: number;
  pageCount: number;
  downloadCount: number;
  pendingCreationCount?: number;
}

export interface BrowserTaskResult {
  ok: boolean;
  action: string;
  tabId?: number;
  windowId?: number;
  url?: string;
  message?: string;
  error?: string;
  task?: BrowserTaskInventory;
  tasks?: BrowserTaskSummary[];
  dispatched?: boolean;
  completedActions?: number;
  created?: BrowserTaskPageInventory;
  compensation?: BrowserTaskPageCompensation;
  pendingCreation?: BrowserTaskPendingCreation;
  ledgerPersisted?: boolean;
  budgetExceeded?: BrowserTaskBudgetDiagnostic;
  status?: string;
  outcome?: string;
  retry?: boolean;
  receipt?: unknown;
  content?: CallToolResult['content'];
  warning?: string;
  handedOverUnknown?: BrowserTaskPendingCreation[];
}

export interface BrowserTaskBudgetDiagnostic {
  exceeded: true;
  budget: number;
  pageCount: number;
  pages: BrowserTaskPageInventory[];
}

export interface BrowserTaskManagerOptions {
  call: BrowserCall;
  storageDir?: string;
}
