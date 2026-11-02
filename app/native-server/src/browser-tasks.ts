import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DownloadObservation } from 'chrome-mcp-shared';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type BrowserCall = (
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
  signal?: AbortSignal,
) => Promise<CallToolResult>;

type TaskStatus = 'active' | 'finished' | 'cancelled';
type PageOwnership = 'owned' | 'borrowed' | 'user';
type PageState = 'active' | 'handedOff' | 'closed';

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

interface TaskPage {
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

interface BrowserTask {
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

interface TaskLedger {
  version: 1;
  tasks: Record<string, BrowserTask>;
}

interface BrowserTabSnapshot {
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

interface BrowserInventory {
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

export interface BrowserTaskResult {
  ok: boolean;
  action: string;
  message?: string;
  error?: string;
  task?: BrowserTaskInventory;
  tasks?: BrowserTaskInventory[];
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

const DEFAULT_MAX_PAGES = 8;
const LEDGER_VERSION = 1 as const;
const OWN_TASK_TOOL_NAMES = new Set(['chrome_task', 'browser_task', 'browserpaw_task']);
const TASK_FORBIDDEN_TOOLS = new Set([
  'chrome_tab_group_close',
  'chrome_tab_group_create',
  'chrome_tab_group_update',
  'chrome_tab_group_ungroup',
  'chrome_switch_tab',
  'chrome_move_tab',
  'chrome_attach_tab',
  'chrome_detach_tab',
  'chrome_cdp_execute',
]);
const CREATED_TAB_MESSAGE = 'Opened URL in new tab in existing window';
const DELAYED_NAVIGATION_TIMEOUT_MS = 10_000;
const DELAYED_NAVIGATION_POLL_MS = 100;
const OBSERVATION_TOOL_NAMES = new Set([
  'get_windows_and_tabs',
  'chrome_screenshot',
  'chrome_read_dom',
  'chrome_get_markdown',
  'chrome_get_web_content',
  'chrome_grep',
  'chrome_tool_docs',
  'chrome_get_links',
  'chrome_inspect_media',
  'chrome_get_dropdown_options',
  'chrome_console',
  'chrome_network_capture',
  'chrome_history',
  'chrome_bookmark_search',
  'chrome_doctor',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function assertSourceDownloadRequest(
  args: Record<string, unknown>,
  supported: boolean,
): void {
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { requestDispatched: false });
  };
  if (args.tabId === undefined) {
    if (
      args.guid !== undefined ||
      args.clickTargetIndex !== undefined ||
      args.frameId !== undefined
    )
      fail('Source download requires a verified tabId');
    return;
  }
  if (!Number.isSafeInteger(args.tabId) || (args.tabId as number) <= 0)
    fail('Invalid download tabId');
  if ((args.guid !== undefined) === (args.clickTargetIndex !== undefined))
    fail('Source download requires exactly one observed guid or clickTargetIndex');
  if (
    args.guid !== undefined &&
    (typeof args.guid !== 'string' || !args.guid.trim() || args.guid.length > 128)
  )
    fail('Invalid download guid');
  if (
    args.clickTargetIndex !== undefined &&
    (!Number.isSafeInteger(args.clickTargetIndex) || (args.clickTargetIndex as number) <= 0)
  )
    fail('Invalid download clickTargetIndex');
  if (
    args.frameId !== undefined &&
    (args.clickTargetIndex === undefined ||
      !Number.isSafeInteger(args.frameId) ||
      (args.frameId as number) < 0)
  )
    fail('Download frameId requires a clickTargetIndex and must be a non-negative integer');
  if (!supported)
    fail(
      'Extension does not support source-scoped downloads; reload a compatible BrowserPaw build',
    );
}

function isDownloadObservation(value: unknown): value is DownloadObservation {
  if (!isRecord(value)) return false;
  return (
    typeof value.guid === 'string' &&
    value.guid.length > 0 &&
    value.guid.length <= 128 &&
    Number.isSafeInteger(value.tabId) &&
    (value.tabId as number) > 0 &&
    typeof value.frameId === 'string' &&
    value.frameId.length > 0 &&
    typeof value.url === 'string' &&
    typeof value.suggestedFilename === 'string' &&
    typeof value.epoch === 'string' &&
    value.epoch.length > 0 &&
    ['inProgress', 'completed', 'canceled', 'unknown'].includes(String(value.state)) &&
    ['receivedBytes', 'totalBytes', 'startedAt', 'updatedAt', 'sequence'].every(
      (key) =>
        typeof value[key] === 'number' &&
        Number.isFinite(value[key]) &&
        (value[key] as number) >= 0,
    )
  );
}

export function verifySourceDownloadResult(
  args: Record<string, unknown>,
  result: CallToolResult,
): CallToolResult {
  if (args.tabId === undefined || result.isError) return result;
  const payload = tryParseCallResult(result);
  const download = payload?.download;
  if (
    payload?.success === true &&
    isDownloadObservation(download) &&
    download.tabId === args.tabId &&
    (args.guid === undefined || download.guid === args.guid) &&
    (download.state === 'completed' ||
      (args.waitForComplete === false && download.state === 'inProgress'))
  )
    return result;
  return unknownActionResult(
    new Error(
      'Download result has no matching authoritative page/GUID source or verified download state',
    ),
    result,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCallResult(result: CallToolResult): Record<string, unknown> {
  if (result.isError) {
    throw Object.assign(new Error(resultText(result) || 'Browser tool call failed'), { result });
  }
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = resultText(result);
  if (!text) throw new Error('Browser tool returned no JSON payload');
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error('Browser tool payload is not an object');
    return parsed;
  } catch (error) {
    throw new Error(
      `Browser tool returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function tryParseCallResult(result: CallToolResult): Record<string, unknown> | null {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const blocks = result.content || [];
  const joined = blocks
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  if (joined) {
    try {
      const parsed = JSON.parse(joined);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Diagnostic text around a JSON block is not one JSON document.
    }
  }
  for (let index = blocks.length - 1; index >= 0; index--) {
    const item = blocks[index];
    if (item.type !== 'text' || !item.text) continue;
    try {
      const parsed = JSON.parse(item.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Keep scanning earlier text blocks.
    }
  }
  return null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

function errorPayload(error: unknown): Record<string, unknown> {
  const source = isRecord(error) ? error : {};
  return {
    success: false,
    ...(typeof source.status === 'string' ? { status: source.status } : {}),
    ...(typeof source.outcome === 'string' ? { outcome: source.outcome } : {}),
    ...(typeof source.retry === 'boolean' ? { retry: source.retry } : {}),
    ...(typeof source.dispatched === 'boolean' ? { dispatched: source.dispatched } : {}),
    ...(source.receipt !== undefined ? { receipt: source.receipt } : {}),
    error: typeof source.error === 'string' ? source.error : errorMessage(error),
  };
}

function requestNotSent(error: unknown): boolean {
  return isRecord(error) && error.requestDispatched === false;
}

export function withStructuredPayload(
  attached: CallToolResult | undefined,
  payload: Record<string, unknown>,
): CallToolResult {
  const content = [...(attached?.content || [])];
  let replaced = false;
  for (let index = content.length - 1; index >= 0; index--) {
    const item = content[index];
    if (item.type !== 'text') continue;
    try {
      if (isRecord(JSON.parse(item.text))) {
        content[index] = { ...item, text: JSON.stringify(payload) };
        replaced = true;
        break;
      }
    } catch {
      // Keep non-JSON diagnostics intact.
    }
  }
  if (!replaced) content.push({ type: 'text', text: JSON.stringify(payload) });
  return {
    ...(attached || {}),
    content,
    structuredContent: payload,
    isError: true,
  };
}

function blockedMutationResult(error: unknown, attached?: CallToolResult): CallToolResult {
  const parsed = attached ? tryParseCallResult(attached) || {} : {};
  return withStructuredPayload(attached, {
    ...errorPayload(error),
    ...parsed,
    success: false,
    status: 'blocked',
    retry: false,
    dispatched: false,
  });
}

function unknownActionResult(error: unknown, attached?: CallToolResult): CallToolResult {
  const parsed = attached ? tryParseCallResult(attached) || {} : {};
  const explicitStatus =
    parsed.status === 'blocked' || parsed.status === 'failed' || parsed.status === 'cancelled';
  return withStructuredPayload(attached, {
    ...errorPayload(error),
    ...parsed,
    success: false,
    ...(explicitStatus ? {} : { status: 'unknown', outcome: 'unknown' }),
    retry: false,
  });
}

function cancelledCallResult(
  result: CallToolResult | undefined,
  options: {
    taskId: string;
    name: string;
    reason: 'task' | 'signal';
    requestDispatched: boolean;
    error?: unknown;
    postActionError?: unknown;
  },
): CallToolResult {
  const failure = options.error === undefined ? {} : errorPayload(options.error);
  const original = result ? tryParseCallResult(result) || {} : {};
  const source = { ...failure, ...original };
  const hasOutcome = typeof source.status === 'string' || typeof source.outcome === 'string';
  const outcomeUnknown =
    options.requestDispatched &&
    !hasOutcome &&
    (options.error !== undefined || result?.isError === true);
  // Native can prove the request started, not that the browser dispatched the action.
  // Keep any tool-reported dispatched value authoritative and expose the transport fact separately.
  const cancellation = {
    status: 'cancelled',
    retry: false,
    requestDispatched: options.requestDispatched,
    reason: options.reason,
    taskId: options.taskId,
    tool: options.name,
    message:
      options.reason === 'task'
        ? `Task ${options.taskId} was cancelled while ${options.name} was running; the recorded outcome is preserved and must not be replayed`
        : `The external request signal was aborted while ${options.name} was running; the recorded outcome is preserved and must not be replayed`,
    ...(options.postActionError !== undefined
      ? { postActionError: errorMessage(options.postActionError) }
      : {}),
  };
  const payload = {
    ...source,
    status:
      typeof source.status === 'string' ? source.status : outcomeUnknown ? 'unknown' : 'cancelled',
    ...(typeof source.outcome === 'string'
      ? { outcome: source.outcome }
      : outcomeUnknown
        ? { outcome: 'unknown' }
        : {}),
    retry: false,
    cancelled: true,
    ...(options.reason === 'task' ? { taskStatus: 'cancelled' } : {}),
    cancellation,
  };
  const content = [...(result?.content || [])];
  let replaced = false;
  for (let index = content.length - 1; index >= 0; index--) {
    const item = content[index];
    if (item.type !== 'text') continue;
    try {
      if (isRecord(JSON.parse(item.text))) {
        content[index] = { ...item, text: JSON.stringify(payload) };
        replaced = true;
        break;
      }
    } catch {
      // Keep non-JSON diagnostics intact and add the structured cancellation block.
    }
  }
  if (!replaced) content.push({ type: 'text', text: JSON.stringify(payload) });

  return {
    ...(result || {}),
    content,
    structuredContent: payload,
    isError: true,
    _meta: {
      ...(isRecord(result?._meta) ? result._meta : {}),
      cancellation,
    },
  };
}

function postActionUnknownResult(
  result: CallToolResult,
  options: {
    taskId: string;
    name: string;
    tabId: number;
    reason:
      'navigation_loading_timeout' | 'navigation_identity_lost' | 'post_action_verification_failed';
    error?: unknown;
  },
): CallToolResult {
  const postAction = {
    status: 'unknown',
    outcome: 'unknown',
    retry: false,
    reason: options.reason,
    taskId: options.taskId,
    tool: options.name,
    message:
      options.reason === 'navigation_loading_timeout'
        ? `Tab ${options.tabId} remained loading after ${options.name}; inspect task status and the current receipt before any explicit retry`
        : options.reason === 'navigation_identity_lost'
          ? `Tab ${options.tabId} disappeared or changed browser identity after ${options.name}; inspect task status and the current receipt before any explicit recovery`
          : `Post-action verification failed after ${options.name} was dispatched (${errorMessage(options.error)}); the action result and receipt were preserved, but task identity was not verified. Inspect task status and fresh browser inventory before any explicit recovery; it must not be replayed`,
    ...(options.error !== undefined ? { error: errorMessage(options.error) } : {}),
  };
  const payload = {
    ...(tryParseCallResult(result) || {}),
    status: 'unknown',
    outcome: 'unknown',
    retry: false,
    postAction,
  };
  const content = [...(result.content || [])];
  let replaced = false;
  for (let index = content.length - 1; index >= 0; index--) {
    const item = content[index];
    if (item.type !== 'text') continue;
    try {
      if (isRecord(JSON.parse(item.text))) {
        content[index] = { ...item, text: JSON.stringify(payload) };
        replaced = true;
        break;
      }
    } catch {
      // Keep non-JSON diagnostics intact and add the structured post-action block.
    }
  }
  if (!replaced) content.push({ type: 'text', text: JSON.stringify(payload) });

  return {
    ...result,
    content,
    structuredContent: payload,
    isError: true,
    _meta: {
      ...(isRecord(result._meta) ? result._meta : {}),
      postAction,
    },
  };
}

function resultText(result: CallToolResult): string {
  return (result.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function knownPendingTabId(pending: BrowserTaskPendingCreation): number | undefined {
  return optionalPositiveInt(pending.tabId);
}

function isUnknownPending(pending: BrowserTaskPendingCreation): boolean {
  return (
    knownPendingTabId(pending) === undefined &&
    typeof pending.unknownId === 'string' &&
    pending.unknownId.trim().length > 0
  );
}

function homeDir(): string {
  return process.env.BROWSERPAW_HOME || path.join(os.homedir(), '.browserpaw');
}

function pageInventory(page: TaskPage): BrowserTaskPageInventory {
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

function taskInventory(task: BrowserTask): BrowserTaskInventory {
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

export class BrowserTaskManager {
  private readonly call: BrowserCall;
  private readonly ledgerFile: string;
  private loaded = false;
  private loading: Promise<void> | undefined;
  private ledger: TaskLedger = { version: LEDGER_VERSION, tasks: {} };
  private ledgerQueue: Promise<unknown> = Promise.resolve();
  private readonly taskQueues = new Map<string, Promise<unknown>>();
  private readonly activeTaskCalls = new Map<string, Set<AbortController>>();

  constructor(options: BrowserTaskManagerOptions) {
    this.call = options.call;
    this.ledgerFile = path.join(options.storageDir || homeDir(), 'tasks.json');
  }

  async execute(
    args: Record<string, unknown> & { action?: string },
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<BrowserTaskResult> {
    const action = optionalString(args.action) || '';
    if (signal?.aborted)
      return {
        ok: false,
        action,
        status: 'cancelled',
        retry: false,
        dispatched: false,
        error: 'Browser request was cancelled',
      };
    try {
      switch (action) {
        case 'start':
          return await this.start(args, sessionId);
        case 'list':
          return await this.withLedgerLock(async () => {
            await this.ensureLoaded();
            return {
              ok: true,
              action,
              tasks: Object.values(this.ledger.tasks)
                .filter(
                  (task) => !task.ownerSessionId || !sessionId || task.ownerSessionId === sessionId,
                )
                .map(taskInventory),
            };
          });
        case 'status':
          return await this.status(args, sessionId);
        case 'resume':
          return await this.resume(args, sessionId, signal);
        case 'takeOver':
          return await this.takeOver(args, sessionId);
        case 'open':
          return await this.open(args, sessionId, signal);
        case 'borrow':
          return await this.borrow(args, sessionId);
        case 'handOff':
          return await this.handOff(args, sessionId, signal);
        case 'finish':
          return await this.finish(args, sessionId, signal);
        case 'cancel':
          return await this.cancel(args, sessionId);
        default:
          return { ok: false, action, error: `Unknown action: ${action || '(missing)'}` };
      }
    } catch (error) {
      const detail = isRecord(error) ? error : {};
      const attached = isCallToolResult(detail.result) ? detail.result : undefined;
      if (attached || typeof detail.requestDispatched === 'boolean') {
        const failure = requestNotSent(error)
          ? blockedMutationResult(error, attached)
          : unknownActionResult(error, attached);
        return {
          ...tryParseCallResult(failure),
          ok: false,
          action,
          content: failure.content,
        };
      }
      return { ok: false, action, error: errorMessage(error) };
    }
  }

  async callTool(
    taskId: string,
    name: string,
    args: Record<string, unknown> = {},
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    if (OWN_TASK_TOOL_NAMES.has(name) || /^(?:chrome|browser|browserpaw)_task(?:_|$)/.test(name)) {
      throw new Error(`Recursive task tool call is forbidden: ${name}`);
    }
    if (TASK_FORBIDDEN_TOOLS.has(name)) {
      throw new Error(`Task-scoped execution cannot call browser management tool: ${name}`);
    }

    return this.withTaskLock(taskId, async () => {
      await this.ensureLoaded();
      const task = this.requireTask(taskId);
      this.assertTaskAccess(task, sessionId);
      if (task.status === 'cancelled') {
        return cancelledCallResult(undefined, {
          taskId,
          name,
          reason: 'task',
          requestDispatched: false,
        });
      }
      this.requireActiveTask(task);

      const target = this.resolveTargetPage(task, args);
      const callArgs = { ...args };
      delete callArgs.taskId;
      if (
        [
          'chrome_click_element',
          'chrome_fill_or_select',
          'chrome_keyboard',
          'chrome_batch_actions',
          'chrome_form_pipeline',
        ].includes(name)
      ) {
        callArgs._taskId = task.id;
      }
      const observationOnly =
        OBSERVATION_TOOL_NAMES.has(name) ||
        (name === 'chrome_handle_download' && typeof callArgs.guid === 'string');

      if (callArgs.tabIds !== undefined) {
        const tabIds = Array.isArray(callArgs.tabIds) ? callArgs.tabIds : [callArgs.tabIds];
        for (const value of tabIds) {
          this.resolvePage(task, requiredNumber(value, 'tabIds entry'));
        }
      }
      callArgs.tabId = target.tabId;

      if (name === 'chrome_navigate') {
        if (callArgs.newTab === true || callArgs.newWindow === true) {
          throw new Error('Task navigation cannot create a new tab; use task action "open"');
        }
      }
      if (name === 'chrome_close_tabs') {
        if (target.ownership !== 'owned') {
          throw new Error(`Cannot close borrowed/user task page ${target.tabId}`);
        }
        if (
          callArgs.url !== undefined ||
          callArgs.allManagedGroups !== undefined ||
          callArgs.groupIds !== undefined
        ) {
          throw new Error('Task close cannot use URL or tab-group selectors');
        }
        callArgs.tabIds = [target.tabId];
        delete callArgs.tabId;
        callArgs.expectedTabs = [
          {
            tabId: target.tabId,
            documentId: target.documentId,
            browserInstanceId: target.browserInstanceId,
          },
        ];
      }

      const cancellationReason = (): 'task' | 'signal' | undefined =>
        task.status === 'cancelled' ? 'task' : signal?.aborted ? 'signal' : undefined;
      const cancelledResult = (
        result: CallToolResult | undefined,
        requestDispatched: boolean,
        error?: unknown,
        postActionError?: unknown,
      ): CallToolResult => {
        const reason = cancellationReason();
        if (!reason)
          throw new Error('Cancellation result requested without an aborted task or signal');
        return cancelledCallResult(result, {
          taskId,
          name,
          reason,
          requestDispatched,
          ...(error !== undefined ? { error } : {}),
          ...(postActionError !== undefined ? { postActionError } : {}),
        });
      };

      let before: BrowserInventory;
      try {
        before = await this.readInventory(sessionId);
      } catch (error) {
        if (cancellationReason()) return cancelledResult(undefined, false, error);
        return blockedMutationResult(error);
      }
      if (cancellationReason()) return cancelledResult(undefined, false);
      this.requireActiveTask(task);
      try {
        this.assertObservedPage(task, target, before);
        if (name === 'chrome_handle_download')
          assertSourceDownloadRequest(callArgs, before.sourceDownloads);
        await this.refreshDownloads(taskId, before);
      } catch (error) {
        if (cancellationReason()) return cancelledResult(undefined, false, error);
        return blockedMutationResult(error);
      }
      if (!observationOnly) {
        const budget = this.budgetDiagnostic(task);
        if (budget) {
          throw new Error(
            `Task page budget exceeded (${budget.pageCount}/${budget.budget}); actual pages: ${JSON.stringify(
              budget.pages,
            )}`,
          );
        }
      }

      const controller = new AbortController();
      let activeCalls = this.activeTaskCalls.get(taskId);
      if (!activeCalls) {
        activeCalls = new Set();
        this.activeTaskCalls.set(taskId, activeCalls);
      }
      activeCalls.add(controller);
      const forwardAbort = () => controller.abort();
      signal?.addEventListener('abort', forwardAbort, { once: true });
      if (signal?.aborted) controller.abort();
      let result: CallToolResult;
      let requestDispatched = false;
      try {
        if (cancellationReason()) return cancelledResult(undefined, false);
        requestDispatched = true;
        result = await this.call(name, callArgs, sessionId, controller.signal);
        if (name === 'chrome_handle_download')
          result = verifySourceDownloadResult(callArgs, result);
      } catch (error) {
        const attached = (error as { result?: unknown } | null)?.result;
        const attachedResult = isCallToolResult(attached) ? attached : undefined;
        const notSent = requestNotSent(error);
        if (cancellationReason()) {
          return cancelledResult(attachedResult, notSent ? false : requestDispatched, error);
        }
        return notSent
          ? blockedMutationResult(error, attachedResult)
          : unknownActionResult(error, attachedResult);
      } finally {
        signal?.removeEventListener('abort', forwardAbort);
        activeCalls.delete(controller);
        if (activeCalls.size === 0) this.activeTaskCalls.delete(taskId);
      }
      try {
        await this.refreshDownloads(taskId, before, result, target.tabId);
        let after = await this.readInventory(sessionId);
        const popupSync = await this.syncOwnedPopups(
          taskId,
          after,
          this.popupReceiptOpeners(result),
        );
        await this.refreshDownloads(taskId, after, result, target.tabId);
        if (popupSync.budgetExceeded) {
          (result as CallToolResult & { _meta?: Record<string, unknown> })._meta = {
            ...(result._meta || {}),
            budgetExceeded: popupSync.budgetExceeded,
          };
        }
        if (name === 'chrome_close_tabs' && !result.isError) {
          const payload = parseCallResult(result);
          const closed = Array.isArray(payload.closedTabIds)
            ? payload.closedTabIds.filter((id): id is number => typeof id === 'number')
            : [];
          if (payload.success === true && closed.includes(target.tabId)) {
            await this.withLedgerLock(async () => {
              const current = this.requireTask(taskId);
              this.removePage(current, target.tabId);
              current.updatedAt = Date.now();
              try {
                await this.persist();
              } catch (error) {
                throw new Error(
                  `Page ${target.tabId} was closed, but task ledger persistence failed: ${errorMessage(error)}`,
                );
              }
            });
          }
          return cancellationReason() ? cancelledResult(result, true) : result;
        }

        if (cancellationReason()) return cancelledResult(result, true);
        if (result.isError || observationOnly) return result;
        this.requireActiveTask(task);
        if (this.isDelayedNavigationLoading(after, target)) {
          this.activeTaskCalls.set(taskId, activeCalls);
          activeCalls.add(controller);
          signal?.addEventListener('abort', forwardAbort, { once: true });
          if (signal?.aborted) controller.abort();
          try {
            const delayed = await this.waitForDelayedNavigation(
              target,
              after,
              sessionId,
              () => Boolean(cancellationReason()),
              controller.signal,
            );
            after = delayed.inventory;
            if (cancellationReason()) return cancelledResult(result, true);
            if (delayed.stopReason) {
              return postActionUnknownResult(result, {
                taskId,
                name,
                tabId: target.tabId,
                reason:
                  delayed.stopReason === 'timeout'
                    ? 'navigation_loading_timeout'
                    : 'navigation_identity_lost',
              });
            }
          } finally {
            signal?.removeEventListener('abort', forwardAbort);
            activeCalls.delete(controller);
            if (activeCalls.size === 0) this.activeTaskCalls.delete(taskId);
          }
        }
        await this.withLedgerLock(async () => {
          const current = this.requireTask(taskId);
          this.requireActiveTask(current);
          const page = this.resolvePage(current, target.tabId);
          const observed = after.tabs.find((candidate) => candidate.tabId === page.tabId);
          if (
            !observed ||
            after.browserInstanceId !== page.browserInstanceId ||
            observed.browserInstanceId !== page.browserInstanceId ||
            !observed.documentId
          ) {
            throw new Error(
              `${name} ran, but tab ${page.tabId} identity could not be recorded; the action was not rolled back`,
            );
          }
          if (observed.documentId === page.documentId) {
            page.url = observed.url || page.url;
            page.lastVerifiedAt = Date.now();
          } else {
            page.pendingDocumentId = observed.documentId;
            page.pendingUrl = observed.url || page.pendingUrl;
          }
          current.updatedAt = Date.now();
          await this.persist();
        });

        if (cancellationReason()) return cancelledResult(result, true);
        return result;
      } catch (error) {
        if (cancellationReason()) {
          return cancelledResult(result, true, undefined, error);
        }
        return postActionUnknownResult(result, {
          taskId,
          name,
          tabId: target.tabId,
          reason: 'post_action_verification_failed',
          error,
        });
      }
    });
  }

  private async start(
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<BrowserTaskResult> {
    return this.withLedgerLock(async () => {
      await this.ensureLoaded();
      const name = requiredString(args.name, 'name');
      const now = Date.now();
      const task: BrowserTask = {
        id: crypto.randomUUID(),
        ...(sessionId ? { ownerSessionId: sessionId } : {}),
        name,
        ...(optionalString(args.goal) ? { goal: optionalString(args.goal) } : {}),
        ...(optionalString(args.browser) ? { browser: optionalString(args.browser) } : {}),
        status: 'active',
        maxPages: DEFAULT_MAX_PAGES,
        createdAt: now,
        updatedAt: now,
        pages: [],
        pendingCreations: [],
      };
      this.ledger.tasks[task.id] = task;
      try {
        await this.persist();
      } catch (error) {
        delete this.ledger.tasks[task.id];
        throw new Error(
          `Task was not started because ledger persistence failed: ${errorMessage(error)}`,
        );
      }
      return {
        ok: true,
        action: 'start',
        message: `Started task ${task.id}`,
        task: taskInventory(task),
      };
    });
  }

  private async status(
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<BrowserTaskResult> {
    return this.withLedgerLock(async () => {
      await this.ensureLoaded();
      const task = this.requireTask(args.taskId);
      this.assertTaskAccess(task, sessionId);
      return { ok: true, action: 'status', task: taskInventory(task) };
    });
  }

  private async resume(
    args: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<BrowserTaskResult> {
    const taskId = requiredString(args.taskId, 'taskId');
    const adopt = args.adopt === true;
    return this.withTaskLock(taskId, async () => {
      await this.ensureLoaded();
      const task = this.requireTask(taskId);
      this.assertTaskAccess(task, sessionId);
      const cancelled = this.cancelledTaskResult('resume', task);
      if (cancelled) return cancelled;
      this.requireActiveTask(task);
      const inventory = await this.readInventory(sessionId);
      await this.refreshDownloads(taskId, inventory);
      const popupSync = await this.syncOwnedPopups(
        taskId,
        inventory,
        new Map<number, number | undefined>(),
      );
      const verified = new Map<number, { exists: boolean; identityVerified: boolean }>();
      const restore: Array<Pick<TaskPage, 'tabId' | 'documentId' | 'browserInstanceId'>> = [];
      let unresolvedPendingCreations = 0;
      const ok = await this.withLedgerLock(async () => {
        const task = this.requireTask(taskId);
        this.requireActiveTask(task);
        const observedById = new Map(inventory.tabs.map((tab) => [tab.tabId, tab]));
        let ok = true;
        for (const page of task.pages) {
          if (page.state !== 'active') {
            verified.set(page.tabId, { exists: false, identityVerified: false });
            continue;
          }
          const observed = observedById.get(page.tabId);
          const exists = Boolean(observed);
          const stillManaged =
            page.ownership === 'borrowed' ? Boolean(observed) : observed?.isAgentManaged === true;
          const sameStoredIdentity = Boolean(
            observed &&
            stillManaged &&
            inventory.browserInstanceId === page.browserInstanceId &&
            observed.browserInstanceId === page.browserInstanceId &&
            observed.documentId === page.documentId,
          );
          const adoptPendingIdentity = Boolean(
            adopt &&
            observed &&
            stillManaged &&
            inventory.browserInstanceId === page.browserInstanceId &&
            observed.browserInstanceId === page.browserInstanceId &&
            observed.documentId &&
            page.pendingDocumentId === observed.documentId,
          );
          if (adoptPendingIdentity) {
            page.documentId = observed!.documentId!;
            page.url = observed!.url || page.url;
            delete page.pendingDocumentId;
            delete page.pendingUrl;
          }
          const identityVerified = sameStoredIdentity || adoptPendingIdentity;
          if (identityVerified) {
            page.url = observed!.url || page.url;
            page.lastVerifiedAt = Date.now();
            if (page.ownership === 'owned') {
              restore.push({
                tabId: page.tabId,
                documentId: page.documentId,
                browserInstanceId: page.browserInstanceId,
              });
            }
          } else {
            ok = false;
            if (exists && !stillManaged && page.ownership === 'owned') {
              page.ownership = 'user';
              page.state = 'handedOff';
              this.markDownloadsHandedOff(task, page.tabId);
              if (task.currentTabId === page.tabId) task.currentTabId = this.lastActiveTabId(task);
            }
          }
          verified.set(page.tabId, { exists, identityVerified });
        }

        for (const pending of [...task.pendingCreations]) {
          const tabId = knownPendingTabId(pending);
          if (tabId === undefined) {
            unresolvedPendingCreations++;
            continue;
          }
          if (task.pages.some((page) => page.tabId === tabId)) {
            task.pendingCreations = task.pendingCreations.filter(
              (candidate) => candidate !== pending,
            );
            continue;
          }
          const observed = observedById.get(tabId);
          if (!observed) {
            // The browser no longer contains this tab, so there is no resource
            // left to adopt or clean up. Keep the rest of the ledger intact.
            task.pendingCreations = task.pendingCreations.filter(
              (candidate) => candidate !== pending,
            );
            continue;
          }
          const sameBrowser =
            (!task.browserInstanceId || task.browserInstanceId === inventory.browserInstanceId) &&
            observed.browserInstanceId === inventory.browserInstanceId;
          const canAdopt =
            adopt &&
            sameBrowser &&
            observed.isAgentManaged === true &&
            typeof observed.documentId === 'string' &&
            observed.documentId.length > 0;
          if (!canAdopt) {
            unresolvedPendingCreations++;
            ok = false;
            continue;
          }

          const page: TaskPage = {
            tabId,
            ...(observed.windowId !== undefined
              ? { windowId: observed.windowId }
              : pending.windowId !== undefined
                ? { windowId: pending.windowId }
                : {}),
            ...(observed.openerTabId !== undefined ? { openerTabId: observed.openerTabId } : {}),
            url: observed.url || pending.requestedUrl,
            documentId: observed.documentId!,
            browserInstanceId: inventory.browserInstanceId,
            ownership: 'owned',
            state: 'active',
            openedAt: pending.createdAt,
            lastVerifiedAt: Date.now(),
          };
          task.pendingCreations = task.pendingCreations.filter(
            (candidate) => candidate !== pending,
          );
          task.browserInstanceId = inventory.browserInstanceId;
          task.pages.push(page);
          task.currentTabId = tabId;
          verified.set(tabId, { exists: true, identityVerified: true });
          restore.push({
            tabId,
            documentId: page.documentId,
            browserInstanceId: page.browserInstanceId,
          });
        }

        task.updatedAt = Date.now();
        await this.persist();
        return ok;
      });

      const viewports = new Map<number, BrowserTaskViewport>();
      for (const page of restore) {
        viewports.set(page.tabId, await this.requestOwnedViewport(taskId, page, sessionId, signal));
      }
      if (viewports.size > 0) {
        await this.withLedgerLock(async () => {
          const current = this.requireTask(taskId);
          for (const page of current.pages) {
            const viewport = viewports.get(page.tabId);
            const verifiedPage = verified.get(page.tabId);
            if (viewport && verifiedPage?.identityVerified) page.viewport = viewport;
          }
          current.updatedAt = Date.now();
          await this.persist();
        });
      }

      return this.withLedgerLock(async () => {
        const task = this.requireTask(taskId);
        return {
          ok,
          action: 'resume',
          ...(ok
            ? {}
            : {
                error: [
                  'One or more task pages no longer exist or failed identity verification; URL alone is never used to adopt a page',
                  unresolvedPendingCreations > 0
                    ? `${unresolvedPendingCreations} pending page creation(s) still require an explicit resume with adopt: true after their tab and document identity are observable`
                    : '',
                ]
                  .filter(Boolean)
                  .join('; '),
              }),
          task: {
            ...taskInventory(task),
            pages: task.pages.map((page) => ({
              ...pageInventory(page),
              ...(verified.get(page.tabId) || {
                exists: false,
                identityVerified: false,
              }),
            })),
          },
          ...(popupSync.budgetExceeded ? { budgetExceeded: popupSync.budgetExceeded } : {}),
        };
      });
    });
  }

  private async takeOver(
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<BrowserTaskResult> {
    if (!sessionId) throw new Error('takeOver requires an MCP session identity');
    if (args.confirm !== true) throw new Error('takeOver requires confirm: true');
    const taskId = requiredString(args.taskId, 'taskId');
    return this.withTaskLock(taskId, () =>
      this.withLedgerLock(async () => {
        await this.ensureLoaded();
        const task = this.requireTask(taskId);
        const cancelled = this.cancelledTaskResult('takeOver', task);
        if (cancelled) return cancelled;
        this.requireActiveTask(task);
        const previousOwnerSessionId = task.ownerSessionId;
        task.ownerSessionId = sessionId;
        task.updatedAt = Date.now();
        try {
          await this.persist();
        } catch (error) {
          task.ownerSessionId = previousOwnerSessionId;
          throw error;
        }
        return {
          ok: true,
          action: 'takeOver',
          message: 'Task ownership transferred; call resume to verify its pages',
          task: taskInventory(task),
        };
      }),
    );
  }

  private async open(
    args: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<BrowserTaskResult> {
    const taskId = requiredString(args.taskId, 'taskId');
    const url = requiredString(args.url, 'url');
    return this.withTaskLock(taskId, async () => {
      await this.ensureLoaded();
      const task = this.requireTask(taskId);
      this.assertTaskAccess(task, sessionId);
      const cancelled = this.cancelledTaskResult('open', task, signal);
      if (cancelled) return cancelled;
      this.requireActiveTask(task);
      const previousCurrentTabId = task.currentTabId;
      const previousBrowserInstanceId = task.browserInstanceId;
      const unresolvedCreations = task.pendingCreations.filter(
        (pending) => pending.retained !== true,
      );
      if (unresolvedCreations.length > 0) {
        return {
          ok: false,
          action: 'open',
          status: 'blocked',
          retry: false,
          dispatched: false,
          error: `Task ${task.id} has ${unresolvedCreations.length} unresolved page creation receipt(s); inspect status and finish after the affected tabs are resolved`,
          task: taskInventory(task),
        };
      }
      if (this.activeOwnedPages(task).length + task.pendingCreations.length >= task.maxPages) {
        return {
          ok: false,
          action: 'open',
          status: 'blocked',
          retry: false,
          dispatched: false,
          error: `Task page budget reached (${task.maxPages})`,
          task: taskInventory(task),
        };
      }

      let result: CallToolResult;
      try {
        result = await this.call(
          'chrome_navigate',
          { url, newTab: true, background: true },
          sessionId,
          signal,
        );
      } catch (error) {
        return this.openDeliveryFailure(task, url, undefined, error);
      }
      if (result.isError) return this.openDeliveryFailure(task, url, result);
      const payload = tryParseCallResult(result);
      const tabId = optionalPositiveInt(payload?.tabId);
      const windowId = optionalPositiveInt(payload?.windowId);
      if (
        !payload ||
        tabId === undefined ||
        (payload.windowId !== undefined && windowId === undefined)
      ) {
        return this.openDeliveryFailure(
          task,
          url,
          unknownActionResult(
            new Error('chrome_navigate returned no valid page creation identity'),
            result,
          ),
        );
      }
      const created =
        payload.created === true ||
        (payload.success === true && payload.message === CREATED_TAB_MESSAGE);
      if (!created) {
        throw new Error(
          'chrome_navigate did not return native creation proof; refusing to own a reused page',
        );
      }

      const pendingCreation: BrowserTaskPendingCreation = {
        tabId,
        ...(windowId !== undefined ? { windowId } : {}),
        requestedUrl: url,
        createdAt: Date.now(),
        reason: 'browser identity verification pending',
      };
      const pendingWrite = await this.recordPendingCreation(taskId, pendingCreation);
      if (!pendingWrite.persisted) {
        return {
          ok: false,
          action: 'open',
          error: `Page ${tabId} was created but its pending creation receipt could not be persisted: ${pendingWrite.error}`,
          task: pendingWrite.task,
          dispatched: true,
          pendingCreation,
          ledgerPersisted: false,
        };
      }

      let committed: {
        page: TaskPage;
        persisted: boolean;
        cancelled: boolean;
        budgetExceeded?: BrowserTaskBudgetDiagnostic;
        error?: string;
        task: BrowserTaskInventory;
      };
      try {
        const inventory = await this.readInventory(sessionId);
        const observed = inventory.tabs.find((tab) => tab.tabId === tabId);
        if (!observed) {
          throw new Error(`Created tab ${tabId} was not observed in browser inventory`);
        }
        if (!observed.documentId) {
          throw new Error(
            `Browser inventory did not provide documentId for created tab ${tabId}; cannot prove identity`,
          );
        }
        if (observed.isAgentManaged !== true) {
          throw new Error(`Created tab ${tabId} was not confirmed as agent-managed`);
        }

        committed = await this.withLedgerLock(async () => {
          const current = this.requireTask(taskId);
          if (
            current.browserInstanceId &&
            current.browserInstanceId !== inventory.browserInstanceId
          ) {
            throw new Error(
              'Browser instance changed; refusing to attach the task to another browser',
            );
          }

          const page: TaskPage = {
            tabId,
            ...(windowId !== undefined ? { windowId } : {}),
            url: observed.url || url,
            documentId: observed.documentId!,
            browserInstanceId: inventory.browserInstanceId,
            ownership: 'owned',
            state: 'active',
            openedAt: Date.now(),
            lastVerifiedAt: Date.now(),
          };
          const pendingIndex = current.pendingCreations.indexOf(pendingCreation);
          if (pendingIndex >= 0) current.pendingCreations.splice(pendingIndex, 1);
          current.browserInstanceId = inventory.browserInstanceId;
          current.pages.push(page);
          current.currentTabId = tabId;
          current.updatedAt = Date.now();
          const cancelled = current.status === 'cancelled';
          const budgetExceeded = this.budgetDiagnostic(current);
          try {
            await this.persist();
          } catch (error) {
            current.pages = current.pages.filter((candidate) => candidate !== page);
            if (pendingIndex >= 0 && !current.pendingCreations.includes(pendingCreation)) {
              current.pendingCreations.splice(
                Math.min(pendingIndex, current.pendingCreations.length),
                0,
                pendingCreation,
              );
            }
            current.currentTabId = previousCurrentTabId;
            current.browserInstanceId = previousBrowserInstanceId;
            current.updatedAt = Date.now();
            return {
              page,
              persisted: false,
              cancelled,
              budgetExceeded,
              error: `Page ${tabId} was created but task ledger persistence failed: ${errorMessage(error)}`,
              task: taskInventory(current),
            };
          }
          return {
            page,
            persisted: true,
            cancelled,
            budgetExceeded,
            task: taskInventory(current),
          };
        });
      } catch (error) {
        return this.withLedgerLock(async () => ({
          ok: false,
          action: 'open',
          error: errorMessage(error),
          task: taskInventory(this.requireTask(taskId)),
          dispatched: true,
          pendingCreation,
          ledgerPersisted: true,
        }));
      }
      if (!committed.persisted) {
        const compensated = await this.compensateFailedOpenPage(taskId, committed.page, {
          sessionId,
          previousCurrentTabId,
          previousBrowserInstanceId,
          pageWasPersisted: false,
          pendingCreation,
        });
        return {
          ok: false,
          action: 'open',
          error: `${committed.error}; ${compensated.message}`,
          task: compensated.task,
          dispatched: true,
          created: pageInventory(compensated.page),
          compensation: compensated.compensation,
          ...(committed.budgetExceeded ? { budgetExceeded: committed.budgetExceeded } : {}),
        };
      }
      if (committed.cancelled) {
        return {
          ok: false,
          action: 'open',
          status: 'cancelled',
          retry: false,
          error:
            'Task was cancelled while navigation was in flight; the proven created page was recorded for explicit finish cleanup',
          task: committed.task,
          dispatched: true,
          created: pageInventory(committed.page),
          ...(committed.budgetExceeded ? { budgetExceeded: committed.budgetExceeded } : {}),
        };
      }
      if (committed.budgetExceeded) {
        return {
          ok: false,
          action: 'open',
          error: `Task page budget exceeded (${committed.budgetExceeded.pageCount}/${committed.budgetExceeded.budget})`,
          task: committed.task,
          dispatched: true,
          created: pageInventory(committed.page),
          budgetExceeded: committed.budgetExceeded,
        };
      }

      const beforeViewport = this.requireTask(taskId);
      if (beforeViewport.status === 'cancelled' || signal?.aborted) {
        return {
          ok: false,
          action: 'open',
          status: 'cancelled',
          retry: false,
          error:
            'Task was cancelled before viewport setup; the proven created page was recorded for explicit finish cleanup',
          task: taskInventory(beforeViewport),
          dispatched: true,
          created: pageInventory(committed.page),
        };
      }
      const viewport = await this.requestOwnedViewport(taskId, committed.page, sessionId, signal);
      const viewportCommit = await this.withLedgerLock(async () => {
        const current = this.requireTask(taskId);
        const page = current.pages.find(
          (candidate) =>
            candidate.tabId === tabId &&
            candidate.documentId === committed.page.documentId &&
            candidate.browserInstanceId === committed.page.browserInstanceId,
        );
        if (page) {
          page.viewport = viewport;
          current.updatedAt = Date.now();
          try {
            await this.persist();
          } catch (error) {
            return {
              persisted: false,
              cancelled: current.status === 'cancelled',
              error: `Page ${tabId} was created but viewport capability persistence failed: ${errorMessage(error)}`,
              task: taskInventory(current),
            };
          }
        }
        if (current.status === 'cancelled') {
          return {
            persisted: true,
            cancelled: true,
            task: taskInventory(current),
          };
        }
        return {
          persisted: true,
          cancelled: false,
          task: taskInventory(current),
        };
      });
      if (!viewportCommit.persisted) {
        const compensated = await this.compensateFailedOpenPage(taskId, committed.page, {
          sessionId,
          previousCurrentTabId,
          previousBrowserInstanceId,
          pageWasPersisted: true,
        });
        return {
          ok: false,
          action: 'open',
          error: `${viewportCommit.error}; ${compensated.message}`,
          task: compensated.task,
          dispatched: true,
          created: pageInventory(compensated.page),
          compensation: compensated.compensation,
        };
      }
      if (viewportCommit.cancelled) {
        return {
          ok: false,
          action: 'open',
          error:
            'Task was cancelled before viewport update completed; the created page remains recorded for explicit finish cleanup',
          task: viewportCommit.task,
          dispatched: true,
          created: pageInventory(committed.page),
        };
      }
      return {
        ok: true,
        action: 'open',
        message:
          viewport.status === 'native'
            ? `Opened owned page ${tabId} with native viewport ${viewport.width}x${viewport.height}${
                viewport.dpr ? ` @ ${viewport.dpr}x` : ''
              }`
            : `Opened owned page ${tabId}; viewport capability is limited`,
        task: viewportCommit.task,
      };
    });
  }

  private async openDeliveryFailure(
    task: BrowserTask,
    url: string,
    result: CallToolResult | undefined,
    error?: unknown,
  ): Promise<BrowserTaskResult> {
    const attached =
      error !== undefined && isCallToolResult((error as { result?: unknown }).result)
        ? (error as { result: CallToolResult }).result
        : undefined;
    const source = result || attached;
    const parsed = source ? tryParseCallResult(source) || {} : {};
    const payload = { ...(error === undefined ? {} : errorPayload(error)), ...parsed };
    const baseError =
      typeof payload.error === 'string'
        ? payload.error
        : source
          ? resultText(source) || 'Browser tool call failed'
          : errorMessage(error);
    const preserved = {
      ...(payload.receipt !== undefined ? { receipt: payload.receipt } : {}),
      ...(source?.content?.length ? { content: source.content } : {}),
    };
    if (error !== undefined && requestNotSent(error)) {
      return {
        ok: false,
        action: 'open',
        status: 'blocked',
        retry: false,
        dispatched: false,
        error: baseError,
        ...preserved,
        task: taskInventory(task),
      };
    }

    const tabId = optionalPositiveInt(payload.tabId);
    const created = payload.created === true;
    const explicitStatus = payload.status === 'blocked' || payload.status === 'failed';
    const status = typeof payload.status === 'string' ? payload.status : 'unknown';
    const outcome =
      typeof payload.outcome === 'string'
        ? payload.outcome
        : status === 'unknown'
          ? 'unknown'
          : undefined;
    let pendingCreation: BrowserTaskPendingCreation | undefined;
    let pendingTask = taskInventory(task);
    let ledgerPersisted: boolean | undefined;
    let persistError: string | undefined;
    if (created && tabId !== undefined) {
      const windowId = optionalPositiveInt(payload.windowId);
      pendingCreation = {
        tabId,
        ...(windowId !== undefined ? { windowId } : {}),
        requestedUrl: url,
        createdAt: Date.now(),
        reason: 'browser identity verification pending',
        ...(payload.receipt !== undefined ? { receipt: payload.receipt } : {}),
      };
    } else if (tabId === undefined && (created || (!explicitStatus && status === 'unknown'))) {
      pendingCreation = {
        unknownId: `unknown:${crypto.randomUUID()}`,
        requestedUrl: url,
        createdAt: Date.now(),
        reason: 'unknown page creation had no tabId',
        ...(payload.receipt !== undefined ? { receipt: payload.receipt } : {}),
      };
    }
    if (pendingCreation) {
      const pendingWrite = await this.recordPendingCreation(task.id, pendingCreation);
      pendingTask = pendingWrite.task;
      ledgerPersisted = pendingWrite.persisted;
      if (!pendingWrite.persisted) {
        persistError = knownPendingTabId(pendingCreation)
          ? `Page ${knownPendingTabId(pendingCreation)} was created but its pending creation receipt could not be persisted: ${pendingWrite.error}`
          : `Unknown page creation receipt ${pendingCreation.unknownId} could not be persisted: ${pendingWrite.error}`;
      }
    }
    const known = pendingCreation !== undefined && knownPendingTabId(pendingCreation) !== undefined;
    const note =
      pendingCreation && !known
        ? `Unknown page creation had no tabId; receipt ${pendingCreation.unknownId} blocks another open until finish keepUnknownPages with confirm: true`
        : undefined;
    return {
      ok: false,
      action: 'open',
      status,
      ...(outcome ? { outcome } : {}),
      retry: false,
      ...(known
        ? { dispatched: true }
        : typeof payload.dispatched === 'boolean'
          ? { dispatched: payload.dispatched }
          : {}),
      error: [baseError, persistError, note]
        .filter((part): part is string => Boolean(part))
        .join('; '),
      ...preserved,
      task: pendingTask,
      ...(pendingCreation ? { pendingCreation, ledgerPersisted } : {}),
    };
  }

  private async borrow(
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<BrowserTaskResult> {
    const taskId = requiredString(args.taskId, 'taskId');
    const tabId = requiredNumber(args.tabId, 'tabId');
    return this.withTaskLock(taskId, async () => {
      await this.ensureLoaded();
      const task = this.requireTask(taskId);
      this.assertTaskAccess(task, sessionId);
      const cancelled = this.cancelledTaskResult('borrow', task);
      if (cancelled) return cancelled;
      this.requireActiveTask(task);
      const inventory = await this.readInventory(sessionId);
      const observed = inventory.tabs.find((tab) => tab.tabId === tabId);
      if (!observed) throw new Error(`Tab ${tabId} does not exist`);
      if (!observed.documentId) {
        throw new Error(`Browser inventory did not provide documentId for tab ${tabId}`);
      }
      if (observed.isAgentManaged === true) {
        throw new Error(`Tab ${tabId} is agent-managed and cannot be borrowed as a user page`);
      }

      return this.withLedgerLock(async () => {
        const current = this.requireTask(taskId);
        this.requireActiveTask(current);
        for (const other of Object.values(this.ledger.tasks)) {
          if (other.id === current.id || other.status !== 'active') continue;
          if (other.pages.some((page) => page.state === 'active' && page.tabId === tabId)) {
            throw new Error(`Tab ${tabId} is already leased by task ${other.id}`);
          }
        }
        if (
          current.browserInstanceId &&
          current.browserInstanceId !== inventory.browserInstanceId
        ) {
          throw new Error('Browser instance changed; refusing to borrow in another browser');
        }

        const page: TaskPage = {
          tabId,
          ...(observed.windowId !== undefined ? { windowId: observed.windowId } : {}),
          url: observed.url,
          documentId: observed.documentId!,
          browserInstanceId: inventory.browserInstanceId,
          ownership: 'borrowed',
          state: 'active',
          openedAt: Date.now(),
          lastVerifiedAt: Date.now(),
        };
        const previousCurrent = current.currentTabId;
        const previousInstance = current.browserInstanceId;
        current.browserInstanceId = inventory.browserInstanceId;
        current.pages.push(page);
        current.currentTabId = tabId;
        current.updatedAt = Date.now();
        try {
          await this.persist();
        } catch (error) {
          current.pages = current.pages.filter((candidate) => candidate !== page);
          current.currentTabId = previousCurrent;
          current.browserInstanceId = previousInstance;
          throw new Error(
            `Page was borrowed, but task ledger persistence failed: ${errorMessage(error)}`,
          );
        }
        return {
          ok: true,
          action: 'borrow',
          message: `Borrowed user page ${tabId}; it will not be deleted`,
          task: taskInventory(current),
        };
      });
    });
  }

  private async handOff(
    args: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<BrowserTaskResult> {
    const taskId = requiredString(args.taskId, 'taskId');
    const tabId = requiredNumber(args.tabId, 'tabId');
    return this.withTaskLock(taskId, async () => {
      await this.ensureLoaded();
      const task = this.requireTask(taskId);
      this.assertTaskAccess(task, sessionId);
      const cancelled = this.cancelledTaskResult('handOff', task, signal);
      if (cancelled) return cancelled;
      this.requireActiveTask(task);
      const page = this.resolvePage(task, tabId);
      if (page.ownership === 'borrowed') {
        throw new Error(`Borrowed page ${tabId} is already user-owned`);
      }
      let inventory: BrowserInventory;
      try {
        inventory = await this.readInventory(sessionId);
      } catch (error) {
        const failure = blockedMutationResult(error);
        return {
          ...tryParseCallResult(failure),
          ok: false,
          action: 'handOff',
          task: taskInventory(task),
          content: failure.content,
        };
      }
      const popupSync = await this.syncOwnedPopups(
        taskId,
        inventory,
        new Map<number, number | undefined>(),
      );
      try {
        this.assertObservedPage(task, page, inventory);
      } catch (error) {
        return {
          ok: false,
          action: 'handOff',
          status: 'blocked',
          retry: false,
          dispatched: false,
          error: errorMessage(error),
          task: taskInventory(this.requireTask(taskId)),
        };
      }
      await this.refreshDownloads(taskId, inventory);
      await this.releaseOwnedPage(task, page, sessionId, signal);

      return this.withLedgerLock(async () => {
        const current = this.requireTask(taskId);
        const currentPage = this.resolvePage(current, tabId);
        currentPage.ownership = 'user';
        currentPage.state = 'handedOff';
        this.markDownloadsHandedOff(current, tabId);
        delete currentPage.recovery;
        if (current.currentTabId === tabId) {
          current.currentTabId = this.lastActiveTabId(current);
        }
        current.updatedAt = Date.now();
        await this.persist();
        return {
          ok: true,
          action: 'handOff',
          message: `Handed page ${tabId} to the user`,
          task: taskInventory(current),
          ...(popupSync.budgetExceeded ? { budgetExceeded: popupSync.budgetExceeded } : {}),
        };
      });
    });
  }

  private async finish(
    args: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<BrowserTaskResult> {
    const taskId = requiredString(args.taskId, 'taskId');
    const keep = this.numberArray(args.keep, 'keep');
    return this.withTaskLock(taskId, async () => {
      await this.ensureLoaded();
      const task = this.requireTask(taskId);
      this.assertTaskAccess(task, sessionId);
      let completedActions = 0;
      const requestCancellation = (): BrowserTaskResult | undefined =>
        signal?.aborted
          ? {
              ok: false,
              action: 'finish',
              status: 'cancelled',
              retry: false,
              dispatched: completedActions > 0,
              completedActions,
              error: 'Finish request was cancelled; completed page releases remain recorded',
              task: taskInventory(this.requireTask(taskId)),
            }
          : undefined;
      const initialCancellation = requestCancellation();
      if (initialCancellation) return initialCancellation;
      if (args.keepUnknownPages !== undefined && typeof args.keepUnknownPages !== 'boolean') {
        throw new Error('keepUnknownPages must be boolean');
      }
      const keepUnknownPages = args.keepUnknownPages === true;
      if (keepUnknownPages && args.confirm !== true) {
        throw new Error('finish keepUnknownPages requires confirm: true');
      }
      if (task.status === 'finished') {
        const handedOverUnknown = task.pendingCreations.filter(
          (pending) => pending.retained === true || isUnknownPending(pending),
        );
        return {
          ok: true,
          action: 'finish',
          message: 'Task was already finished',
          task: taskInventory(task),
          ...(handedOverUnknown.length > 0
            ? {
                warning:
                  'Unidentified page-creation receipts remain retained and were not closed or cleaned up',
                handedOverUnknown,
              }
            : {}),
        };
      }
      for (const tabId of keep) {
        const page = this.resolvePage(task, tabId);
        if (page.ownership !== 'owned' || page.state !== 'active') {
          throw new Error(`keep may contain only active owned pages; ${tabId} is not eligible`);
        }
      }

      const keepSet = new Set(keep);
      let inventory: BrowserInventory;
      try {
        inventory = await this.readInventory(sessionId);
      } catch (error) {
        const failure = blockedMutationResult(error);
        return {
          ...tryParseCallResult(failure),
          ok: false,
          action: 'finish',
          task: taskInventory(task),
          content: failure.content,
        };
      }
      await this.refreshDownloads(taskId, inventory);
      const pendingDownloads = (task.downloads || []).filter(
        (download) =>
          (download.state === 'inProgress' || download.state === 'unknown') &&
          task.pages.some(
            (page) =>
              page.tabId === download.tabId &&
              page.ownership === 'owned' &&
              page.state === 'active' &&
              inventory.tabs.some(
                (tab) => tab.tabId === page.tabId && tab.isAgentManaged !== false,
              ) &&
              !keepSet.has(page.tabId),
          ),
      );
      if (pendingDownloads.length > 0) {
        return {
          ok: false,
          action: 'finish',
          status: 'downloads_pending',
          dispatched: false,
          retry: false,
          task: taskInventory(task),
          error:
            'Task pages have active or unverified downloads. Wait using their GUIDs, or explicitly retain/hand off the pages; no download was canceled or replayed.',
        };
      }
      const inventoryTabIds = new Set(inventory.tabs.map((page) => page.tabId));
      const presentPendingCreations = task.pendingCreations.filter((pending) => {
        const tabId = knownPendingTabId(pending);
        return tabId !== undefined && inventoryTabIds.has(tabId);
      });
      if (presentPendingCreations.length > 0 && !keepUnknownPages) {
        return {
          ok: false,
          action: 'finish',
          status: 'unverified',
          retry: false,
          dispatched: false,
          error: `Task finish refused: unresolved created tab(s) ${presentPendingCreations
            .map((pending) => knownPendingTabId(pending))
            .join(
              ', ',
            )} still exist in browser inventory. No page was closed or released because document identity is unknown.`,
          task: taskInventory(task),
        };
      }
      if (task.pendingCreations.length > 0) {
        await this.withLedgerLock(async () => {
          const current = this.requireTask(taskId);
          current.pendingCreations = current.pendingCreations.filter((pending) => {
            if (isUnknownPending(pending)) return true;
            const tabId = knownPendingTabId(pending);
            return tabId !== undefined && inventoryTabIds.has(tabId);
          });
          current.updatedAt = Date.now();
          try {
            await this.persist();
          } catch (error) {
            throw new Error(
              `Pending creation receipts were cleared, but task ledger persistence failed: ${errorMessage(error)}`,
            );
          }
        });
      }
      const unknownUnresolved = this.requireTask(taskId).pendingCreations.filter(
        (pending) => isUnknownPending(pending) && pending.retained !== true,
      );
      if (unknownUnresolved.length > 0 && !keepUnknownPages) {
        return {
          ok: false,
          action: 'finish',
          status: 'unverified',
          retry: false,
          dispatched: false,
          error: `Task finish refused: ${unknownUnresolved.length} unidentified page-creation receipt(s) have no tabId. No page was closed. Pass keepUnknownPages: true and confirm: true to retain them without claiming cleanup.`,
          task: taskInventory(this.requireTask(taskId)),
        };
      }
      const popupSync = await this.syncOwnedPopups(
        taskId,
        inventory,
        new Map<number, number | undefined>(),
      );
      const refreshed = this.requireTask(taskId);
      const activeOwned = this.activeOwnedPages(refreshed);
      const verifiedOwned = activeOwned.filter((page) => {
        const observed = inventory.tabs.find((candidate) => candidate.tabId === page.tabId);
        return Boolean(
          observed &&
          observed.isAgentManaged === true &&
          observed.browserInstanceId === refreshed.browserInstanceId &&
          observed.documentId === page.documentId,
        );
      });
      const unverified = activeOwned.filter((page) => !verifiedOwned.includes(page));
      const unreleased = unverified.filter((page) => {
        const observed = inventory.tabs.find((candidate) => candidate.tabId === page.tabId);
        return observed !== undefined && observed.isAgentManaged !== false;
      });
      if (unreleased.length > 0) {
        return {
          ok: false,
          action: 'finish',
          status: 'unverified',
          retry: false,
          dispatched: false,
          error: `Task finish refused: browser/document identity is unverified for owned tabs ${unreleased.map((page) => page.tabId).join(', ')}. Pages remain owned. ${refreshed.status === 'cancelled' ? 'Task is cancelled; preserve these pages for the user and retry finish after they have been explicitly closed.' : 'Resume to inspect pending navigation before cleanup.'}`,
          task: taskInventory(refreshed),
        };
      }
      const pagesToKeep = verifiedOwned.filter((page) => keepSet.has(page.tabId));
      for (const page of pagesToKeep) {
        const cancellation = requestCancellation();
        if (cancellation) return cancellation;
        await this.releaseOwnedPage(refreshed, page, sessionId, signal);
        completedActions++;
        await this.withLedgerLock(async () => {
          const current = this.requireTask(taskId);
          const released = this.resolvePage(current, page.tabId);
          released.ownership = 'user';
          released.state = 'handedOff';
          this.markDownloadsHandedOff(current, released.tabId);
          delete released.recovery;
          current.currentTabId = this.lastActiveTabId(current);
          current.updatedAt = Date.now();
          await this.persist();
        });
      }
      const cancellation = requestCancellation();
      if (cancellation) return cancellation;
      const ownedToClose = verifiedOwned.filter((page) => !keepSet.has(page.tabId));
      const ids = ownedToClose.map((page) => page.tabId);
      if (ids.length > 0) {
        const result = await this.call(
          'chrome_close_tabs',
          {
            tabIds: ids,
            expectedTabs: ownedToClose.map((page) => ({
              tabId: page.tabId,
              documentId: page.documentId,
              browserInstanceId: page.browserInstanceId,
            })),
          },
          sessionId,
          signal,
        );
        const payload = parseCallResult(result);
        const closed = Array.isArray(payload.closedTabIds)
          ? payload.closedTabIds.filter((id): id is number => typeof id === 'number')
          : [];
        const missing = ids.filter((id) => !closed.includes(id));
        if (payload.success !== true || missing.length > 0) {
          throw new Error(
            `Failed to close owned task pages: ${missing.join(', ') || 'unknown error'}`,
          );
        }
      }

      return this.withLedgerLock(async () => {
        const current = this.requireTask(taskId);
        for (const page of unverified) {
          const observed = inventory.tabs.find((candidate) => candidate.tabId === page.tabId);
          if (observed) {
            page.ownership = 'user';
            page.state = 'handedOff';
            this.markDownloadsHandedOff(current, page.tabId);
          } else {
            page.state = 'closed';
          }
        }
        current.pages = current.pages.filter((page) => !ids.includes(page.tabId));
        current.pages = current.pages.filter((page) => page.state !== 'closed');
        current.pages = current.pages.filter((page) => page.ownership !== 'borrowed');
        current.currentTabId = this.lastActiveTabId(current);
        current.updatedAt = Date.now();
        const handedOverUnknown = current.pendingCreations.filter(isUnknownPending);
        if (keepUnknownPages) {
          for (const pending of current.pendingCreations) pending.retained = true;
        }
        const retainedPending = keepUnknownPages ? current.pendingCreations : handedOverUnknown;
        if (current.status === 'active') {
          current.status = 'finished';
          current.finishedAt = current.updatedAt;
        }
        await this.persist();
        return {
          ok: true,
          action: 'finish',
          message:
            retainedPending.length > 0
              ? 'Task finished; pending page-creation receipts were retained and no pending page was closed'
              : current.status === 'cancelled'
                ? 'Cancelled task cleanup finished; cancellation state was preserved'
                : 'Task finished; borrowed pages were released without deletion',
          task: taskInventory(current),
          ...((current.downloads || []).some(
            (download) => download.state === 'inProgress' || download.state === 'unknown',
          )
            ? {
                warning:
                  'Downloads on retained or borrowed pages continue in Chrome; download completion and file cleanup are not claimed.',
              }
            : {}),
          ...(retainedPending.length > 0
            ? {
                warning:
                  'Pending page-creation receipts were retained for the user. They were not closed and cleanup was not claimed.',
                handedOverUnknown: retainedPending,
              }
            : {}),
          ...(popupSync.budgetExceeded ? { budgetExceeded: popupSync.budgetExceeded } : {}),
        };
      });
    });
  }

  private async cancel(
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<BrowserTaskResult> {
    const taskId = requiredString(args.taskId, 'taskId');
    return this.withLedgerLock(async () => {
      await this.ensureLoaded();
      const task = this.requireTask(taskId);
      this.assertTaskAccess(task, sessionId);
      if (task.status === 'finished') throw new Error(`Task ${taskId} is finished`);
      if (task.status === 'cancelled') {
        return {
          ok: true,
          action: 'cancel',
          message: 'Task was already cancelled; no actions were rolled back',
          task: taskInventory(task),
        };
      }
      task.status = 'cancelled';
      task.cancelledAt = Date.now();
      task.updatedAt = task.cancelledAt;
      for (const controller of this.activeTaskCalls.get(taskId) || []) {
        controller.abort();
      }
      await this.persist();
      return {
        ok: true,
        action: 'cancel',
        message: 'Task cancelled; already-issued browser actions were not rolled back',
        task: taskInventory(task),
      };
    });
  }

  private isDelayedNavigationLoading(inventory: BrowserInventory, page: TaskPage): boolean {
    const observed = inventory.tabs.find((candidate) => candidate.tabId === page.tabId);
    return Boolean(
      observed &&
      inventory.browserInstanceId === page.browserInstanceId &&
      observed.browserInstanceId === page.browserInstanceId &&
      observed.documentId === page.documentId &&
      observed.status?.toLowerCase() === 'loading' &&
      // null means no uncommitted navigation; older inventories omit this field.
      observed.pendingUrl !== null,
    );
  }

  private async waitForDelayedNavigation(
    page: TaskPage,
    initial: BrowserInventory,
    sessionId: string | undefined,
    isCancelled: () => boolean,
    signal: AbortSignal,
  ): Promise<{
    inventory: BrowserInventory;
    stopReason?: 'timeout' | 'identityLost';
  }> {
    const deadline = Date.now() + DELAYED_NAVIGATION_TIMEOUT_MS;
    let inventory = initial;
    while (!isCancelled()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { inventory, stopReason: 'timeout' };
      await this.waitForDelayedNavigationPoll(
        Math.min(DELAYED_NAVIGATION_POLL_MS, remaining),
        signal,
      );
      if (isCancelled()) return { inventory };
      const read = await this.readInventoryBeforeDeadline(sessionId, signal, deadline);
      if (read.kind === 'stopped') {
        return { inventory, ...(read.reason === 'timeout' ? { stopReason: 'timeout' } : {}) };
      }
      if (read.kind === 'error') throw read.error;
      inventory = read.inventory;
      const observed = inventory.tabs.find((candidate) => candidate.tabId === page.tabId);
      if (
        !observed ||
        inventory.browserInstanceId !== page.browserInstanceId ||
        observed.browserInstanceId !== page.browserInstanceId
      ) {
        return { inventory, stopReason: 'identityLost' };
      }
      if (!this.isDelayedNavigationLoading(inventory, page)) return { inventory };
    }
    return { inventory };
  }

  private async readInventoryBeforeDeadline(
    sessionId: string | undefined,
    signal: AbortSignal,
    deadline: number,
  ): Promise<
    | { kind: 'inventory'; inventory: BrowserInventory }
    | { kind: 'stopped'; reason: 'timeout' | 'cancelled' }
    | { kind: 'error'; error: unknown }
  > {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: 'stopped', reason: 'timeout' };
    if (signal.aborted) return { kind: 'stopped', reason: 'cancelled' };

    // Native abort waits for the dispatched result, so the deadline must race the read itself.
    const readController = new AbortController();
    const read = this.readInventory(sessionId, readController.signal).then(
      (inventory): { kind: 'inventory'; inventory: BrowserInventory } => ({
        kind: 'inventory',
        inventory,
      }),
      (error): { kind: 'error'; error: unknown } => ({ kind: 'error', error }),
    );
    let cleanup = () => {};
    const stopped = new Promise<{ kind: 'stopped'; reason: 'timeout' | 'cancelled' }>((resolve) => {
      const timer = setTimeout(() => {
        readController.abort();
        resolve({ kind: 'stopped', reason: 'timeout' });
      }, remaining);
      const onAbort = () => {
        readController.abort();
        resolve({ kind: 'stopped', reason: 'cancelled' });
      };
      cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([read, stopped]);
    } finally {
      cleanup();
    }
  }

  private waitForDelayedNavigationPoll(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private async readInventory(sessionId?: string, signal?: AbortSignal): Promise<BrowserInventory> {
    const payload = parseCallResult(
      signal
        ? await this.call('get_windows_and_tabs', {}, sessionId, signal)
        : await this.call('get_windows_and_tabs', {}, sessionId),
    );
    const browserInstanceId = requiredString(
      payload.browserInstanceId,
      'browser inventory browserInstanceId',
    );
    if (!Array.isArray(payload.windows)) {
      throw new Error('Browser inventory did not contain windows');
    }
    const tabs: BrowserTabSnapshot[] = [];
    for (const window of payload.windows) {
      if (!isRecord(window) || !Array.isArray(window.tabs)) continue;
      for (const rawTab of window.tabs) {
        if (!isRecord(rawTab)) continue;
        const tabId = rawTab.tabId;
        if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) continue;
        tabs.push({
          tabId,
          ...(typeof rawTab.windowId === 'number'
            ? { windowId: rawTab.windowId }
            : typeof window.windowId === 'number'
              ? { windowId: window.windowId }
              : {}),
          ...(typeof rawTab.openerTabId === 'number' ? { openerTabId: rawTab.openerTabId } : {}),
          url: typeof rawTab.url === 'string' ? rawTab.url : '',
          ...(typeof rawTab.status === 'string' ? { status: rawTab.status } : {}),
          ...(rawTab.pendingUrl === null || typeof rawTab.pendingUrl === 'string'
            ? { pendingUrl: rawTab.pendingUrl }
            : {}),
          ...(typeof rawTab.documentId === 'string' ? { documentId: rawTab.documentId } : {}),
          browserInstanceId:
            typeof rawTab.browserInstanceId === 'string'
              ? rawTab.browserInstanceId
              : browserInstanceId,
          ...(typeof rawTab.isAgentManaged === 'boolean'
            ? { isAgentManaged: rawTab.isAgentManaged }
            : {}),
          downloads: Array.isArray(rawTab.downloads)
            ? rawTab.downloads.filter(
                (item): item is DownloadObservation =>
                  isDownloadObservation(item) && item.tabId === tabId,
              )
            : [],
        });
      }
    }
    return {
      browserInstanceId,
      tabs,
      sourceDownloads:
        isRecord(payload.capabilities) && payload.capabilities.sourceDownloads === true,
    };
  }

  private markDownloadsHandedOff(task: BrowserTask, tabId: number): void {
    for (const download of task.downloads || []) {
      if (download.tabId === tabId && download.state === 'inProgress') {
        download.state = 'unknown';
        download.reason =
          'Source page was handed to the user; subsequent completion is not verified';
        download.updatedAt = Date.now();
      }
    }
  }

  private async refreshDownloads(
    taskId: string,
    inventory: BrowserInventory,
    result?: CallToolResult,
    sourceTabId?: number,
  ): Promise<void> {
    await this.withLedgerLock(async () => {
      const task = this.requireTask(taskId);
      const known = new Map(
        (task.downloads || []).map((download) => [download.guid, { ...download }]),
      );
      const payload = result ? tryParseCallResult(result) : null;
      const receipt = payload && isRecord(payload.receipt) ? payload.receipt : null;
      const evidence = [
        payload?.download,
        ...(Array.isArray(payload?.downloads) ? payload.downloads : []),
        ...(Array.isArray(receipt?.downloads) ? receipt.downloads : []),
      ].filter(isDownloadObservation);
      const observed = new Set<string>();
      for (const page of task.pages.filter(
        (page) => page.state === 'active' && page.ownership !== 'user',
      )) {
        const tab = inventory.tabs.find((tab) => tab.tabId === page.tabId);
        const fromAction =
          page.tabId === sourceTabId
            ? evidence.filter((download) => download.tabId === page.tabId)
            : [];
        const liveSource =
          inventory.browserInstanceId === page.browserInstanceId &&
          tab?.browserInstanceId === page.browserInstanceId;
        if (!liveSource && fromAction.length === 0) continue;
        const candidates = [
          ...fromAction,
          ...(liveSource && inventory.sourceDownloads ? tab?.downloads || [] : []),
        ];
        for (const download of candidates) {
          const previous = known.get(download.guid);
          // A borrowed page may contain the user's older downloads; only explicit action evidence joins a task.
          if (
            !previous &&
            ((!inventory.sourceDownloads &&
              !fromAction.some((item) => item.guid === download.guid)) ||
              download.startedAt < task.createdAt ||
              (page.ownership === 'borrowed' &&
                !evidence.some((item) => item.guid === download.guid)))
          )
            continue;
          if (
            previous &&
            (previous.tabId !== page.tabId || previous.browserInstanceId !== page.browserInstanceId)
          )
            continue;
          observed.add(download.guid);
          if (previous && (previous.state === 'completed' || previous.state === 'canceled'))
            continue;
          if (
            previous?.epoch === download.epoch &&
            (previous.state === 'unknown' || download.sequence < previous.sequence)
          )
            continue;
          known.set(download.guid, { ...download, browserInstanceId: page.browserInstanceId });
        }
      }
      for (const download of known.values()) {
        if (download.state === 'inProgress' && !observed.has(download.guid)) {
          download.state = 'unknown';
          download.reason = 'Source download is no longer observable; completion is unverified';
          download.updatedAt = Date.now();
        }
      }
      const downloads = [...known.values()];
      if (JSON.stringify(task.downloads || []) !== JSON.stringify(downloads)) {
        const previous = task.downloads;
        task.downloads = downloads;
        try {
          await this.persist();
        } catch (error) {
          task.downloads = previous;
          throw error;
        }
      }
    });
  }

  private requireTask(taskId: unknown): BrowserTask {
    return this.resolveTask(requiredString(taskId, 'taskId'));
  }

  private resolveTask(taskId: string): BrowserTask {
    const task = this.ledger.tasks[taskId];
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  private cancelledTaskResult(
    action: string,
    task: BrowserTask,
    signal?: AbortSignal,
  ): BrowserTaskResult | undefined {
    if (task.status !== 'cancelled' && !signal?.aborted) return undefined;
    return {
      ok: false,
      action,
      status: 'cancelled',
      retry: false,
      dispatched: false,
      error:
        task.status === 'cancelled'
          ? `Task ${task.id} is cancelled`
          : 'Browser request was cancelled',
      task: taskInventory(task),
    };
  }

  private requireActiveTask(task: BrowserTask): void {
    if (task.status === 'cancelled') throw new Error(`Task ${task.id} is cancelled`);
    if (task.status === 'finished') throw new Error(`Task ${task.id} is finished`);
  }

  private assertRequestActive(signal?: AbortSignal): void {
    if (signal?.aborted)
      throw Object.assign(new Error('Browser request was cancelled before dispatch'), {
        status: 'cancelled',
        requestDispatched: false,
      });
  }

  private assertTaskAccess(task: BrowserTask, sessionId?: string): void {
    if (task.ownerSessionId && sessionId !== task.ownerSessionId) {
      throw new Error(`Task ${task.id} is owned by another MCP session`);
    }
  }

  private resolveTargetPage(task: BrowserTask, args: Record<string, unknown>): TaskPage {
    const explicit = args.tabId;
    if (explicit !== undefined) return this.resolvePage(task, requiredNumber(explicit, 'tabId'));
    if (task.currentTabId !== undefined) return this.resolvePage(task, task.currentTabId);
    throw new Error(`Task ${task.id} has no current page; call open or borrow first`);
  }

  private resolvePage(task: BrowserTask, tabId: number): TaskPage {
    const page = task.pages.find(
      (candidate) => candidate.tabId === tabId && candidate.state === 'active',
    );
    if (!page) throw new Error(`Tab ${tabId} is not an active page of task ${task.id}`);
    if (page.ownership !== 'owned' && page.ownership !== 'borrowed') {
      throw new Error(`Tab ${tabId} is not owned or borrowed by task ${task.id}`);
    }
    return page;
  }

  private activeOwnedPages(task: BrowserTask): TaskPage[] {
    return task.pages.filter((page) => page.ownership === 'owned' && page.state === 'active');
  }

  private budgetDiagnostic(task: BrowserTask): BrowserTaskBudgetDiagnostic | undefined {
    const pageCount = this.activeOwnedPages(task).length;
    if (pageCount <= task.maxPages) return undefined;
    return {
      exceeded: true,
      budget: task.maxPages,
      pageCount,
      pages: task.pages.map(pageInventory),
    };
  }

  private popupReceiptOpeners(result: CallToolResult): Map<number, number | undefined> {
    const payload = tryParseCallResult(result);
    const receipt = payload && isRecord(payload.receipt) ? payload.receipt : null;
    const popups = receipt && Array.isArray(receipt.popups) ? receipt.popups : [];
    const openers = new Map<number, number | undefined>();
    for (const popup of popups) {
      if (!isRecord(popup) || typeof popup.tabId !== 'number') continue;
      openers.set(
        popup.tabId,
        typeof popup.openerTabId === 'number' ? popup.openerTabId : undefined,
      );
    }
    return openers;
  }

  private async syncOwnedPopups(
    taskId: string,
    inventory: BrowserInventory,
    receiptOpeners: Map<number, number | undefined>,
  ): Promise<{ added: number; budgetExceeded?: BrowserTaskBudgetDiagnostic }> {
    return this.withLedgerLock(async () => {
      const task = this.requireTask(taskId);
      if (task.browserInstanceId && task.browserInstanceId !== inventory.browserInstanceId) {
        return { added: 0 };
      }

      let added = 0;
      let changed = true;
      while (changed) {
        changed = false;
        const ownedIds = new Set(
          task.pages
            .filter((page) => page.ownership === 'owned' && page.state === 'active')
            .map((page) => page.tabId),
        );
        for (const observed of inventory.tabs) {
          if (task.pages.some((page) => page.tabId === observed.tabId)) continue;
          if (
            observed.isAgentManaged !== true ||
            !observed.documentId ||
            observed.browserInstanceId !== inventory.browserInstanceId
          ) {
            continue;
          }
          const receiptOpener = receiptOpeners.get(observed.tabId);
          if (
            receiptOpener !== undefined &&
            observed.openerTabId !== undefined &&
            receiptOpener !== observed.openerTabId
          ) {
            continue;
          }
          const openerTabId = receiptOpener ?? observed.openerTabId;
          if (openerTabId === undefined || !ownedIds.has(openerTabId)) continue;
          const leasedElsewhere = Object.values(this.ledger.tasks).some(
            (other) =>
              other.id !== task.id &&
              other.status === 'active' &&
              other.pages.some(
                (page) =>
                  page.state === 'active' &&
                  page.tabId === observed.tabId &&
                  page.browserInstanceId === inventory.browserInstanceId,
              ),
          );
          if (leasedElsewhere) continue;

          task.pages.push({
            tabId: observed.tabId,
            ...(observed.windowId !== undefined ? { windowId: observed.windowId } : {}),
            openerTabId,
            url: observed.url,
            documentId: observed.documentId,
            browserInstanceId: inventory.browserInstanceId,
            ownership: 'owned',
            state: 'active',
            openedAt: Date.now(),
            lastVerifiedAt: Date.now(),
          });
          task.browserInstanceId = inventory.browserInstanceId;
          task.updatedAt = Date.now();
          added++;
          changed = true;
        }
      }
      if (added > 0) await this.persist();
      return { added, budgetExceeded: this.budgetDiagnostic(task) };
    });
  }

  private assertObservedPage(task: BrowserTask, page: TaskPage, inventory: BrowserInventory): void {
    const observed = inventory.tabs.find((candidate) => candidate.tabId === page.tabId);
    const sameBrowser = Boolean(
      task.browserInstanceId === inventory.browserInstanceId &&
      page.browserInstanceId === inventory.browserInstanceId &&
      observed?.browserInstanceId === inventory.browserInstanceId,
    );
    const sameDocument = Boolean(observed?.documentId && observed.documentId === page.documentId);
    if (
      sameBrowser &&
      sameDocument &&
      (page.ownership !== 'owned' || observed?.isAgentManaged === true)
    )
      return;

    const canAdopt =
      sameBrowser && observed?.documentId && page.pendingDocumentId === observed.documentId;
    throw new Error(
      `Tab ${page.tabId} failed browser/document identity verification; refusing to mutate it` +
        (canAdopt ? '; run resume with adopt: true to confirm the pending document' : ''),
    );
  }

  private async releaseOwnedPage(
    task: BrowserTask,
    page: TaskPage,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (page.ownership !== 'owned') {
      throw new Error(`Only owned pages can be released; tab ${page.tabId} is ${page.ownership}`);
    }
    this.assertRequestActive(signal);
    const result = await this.call(
      'browserpaw_release_owned_page',
      {
        taskId: task.id,
        tabId: page.tabId,
        documentId: page.documentId,
        browserInstanceId: page.browserInstanceId,
      },
      sessionId,
      signal,
    );
    const payload = parseCallResult(result);
    if (payload.success !== true) {
      throw new Error(`Browser did not confirm release of task page ${page.tabId}`);
    }
  }

  private async compensateFailedOpenPage(
    taskId: string,
    page: TaskPage,
    options: {
      sessionId?: string;
      previousCurrentTabId?: number;
      previousBrowserInstanceId?: string;
      pageWasPersisted: boolean;
      pendingCreation?: BrowserTaskPendingCreation;
    },
  ): Promise<{
    task: BrowserTaskInventory;
    page: TaskPage;
    compensation: BrowserTaskPageCompensation;
    message: string;
  }> {
    let cleanupError: string | undefined;
    try {
      await this.closeCreatedPage(page, options.sessionId);
    } catch (error) {
      cleanupError = errorMessage(error);
    }

    return this.withLedgerLock(async () => {
      const current = this.requireTask(taskId);
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
                ? this.lastActiveTabId(current)
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
          await this.persist();
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
        await this.persist();
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

  private async recordPendingCreation(
    taskId: string,
    pendingCreation: BrowserTaskPendingCreation,
  ): Promise<{ persisted: boolean; task: BrowserTaskInventory; error?: string }> {
    return this.withLedgerLock(async () => {
      const task = this.requireTask(taskId);
      task.pendingCreations.push(pendingCreation);
      task.updatedAt = Date.now();
      try {
        await this.persist();
        return { persisted: true, task: taskInventory(task) };
      } catch (error) {
        return { persisted: false, task: taskInventory(task), error: errorMessage(error) };
      }
    });
  }

  private async closeCreatedPage(page: TaskPage, sessionId?: string): Promise<void> {
    const result = await this.call(
      'chrome_close_tabs',
      {
        tabIds: [page.tabId],
        expectedTabs: [
          {
            tabId: page.tabId,
            documentId: page.documentId,
            browserInstanceId: page.browserInstanceId,
          },
        ],
      },
      sessionId,
    );
    const payload = parseCallResult(result);
    const closed = Array.isArray(payload.closedTabIds)
      ? payload.closedTabIds.filter((id): id is number => typeof id === 'number')
      : [];
    if (payload.success !== true || !closed.includes(page.tabId)) {
      const detail =
        typeof payload.error === 'string'
          ? payload.error
          : typeof payload.message === 'string'
            ? payload.message
            : 'Browser did not confirm the close';
      throw new Error(detail);
    }
  }

  private async requestOwnedViewport(
    taskId: string,
    page: Pick<TaskPage, 'tabId' | 'documentId' | 'browserInstanceId'>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<BrowserTaskViewport> {
    try {
      this.assertRequestActive(signal);
      const result = await this.call(
        'browserpaw_set_owned_viewport',
        {
          taskId,
          tabId: page.tabId,
          documentId: page.documentId,
          browserInstanceId: page.browserInstanceId,
        },
        sessionId,
        signal,
      );
      const payload = parseCallResult(result);
      const viewport = isRecord(payload.viewport) ? payload.viewport : null;
      if (
        payload.success === true &&
        viewport &&
        (viewport.status === 'native' || viewport.status === 'limited') &&
        typeof viewport.width === 'number' &&
        Number.isFinite(viewport.width) &&
        viewport.width >= 0 &&
        typeof viewport.height === 'number' &&
        Number.isFinite(viewport.height) &&
        viewport.height >= 0 &&
        (viewport.dpr === undefined ||
          (typeof viewport.dpr === 'number' && Number.isFinite(viewport.dpr) && viewport.dpr > 0))
      ) {
        return {
          status: viewport.status,
          width: viewport.width,
          height: viewport.height,
          ...(typeof viewport.dpr === 'number' ? { dpr: viewport.dpr } : {}),
          ...(optionalString(viewport.reason) ? { reason: optionalString(viewport.reason) } : {}),
        };
      }
      return {
        status: 'limited',
        width: 0,
        height: 0,
        reason: 'Viewport control returned no valid capability payload',
      };
    } catch (error) {
      return {
        status: 'limited',
        width: 0,
        height: 0,
        reason: errorMessage(error),
      };
    }
  }

  private numberArray(value: unknown, field: string): number[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${field} must be an array of positive integers`);
    return value.map((item) => requiredNumber(item, `${field} entry`));
  }

  private removePage(task: BrowserTask, tabId: number): void {
    task.pages = task.pages.filter((page) => page.tabId !== tabId);
    if (task.currentTabId === tabId) task.currentTabId = this.lastActiveTabId(task);
  }

  private lastActiveTabId(task: BrowserTask): number | undefined {
    return task.pages
      .filter(
        (page) =>
          page.state === 'active' && (page.ownership === 'owned' || page.ownership === 'borrowed'),
      )
      .at(-1)?.tabId;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = this.loadLedger().finally(() => {
        this.loading = undefined;
      });
    }
    await this.loading;
  }

  private async loadLedger(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.ledgerFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || parsed.version !== LEDGER_VERSION || !isRecord(parsed.tasks)) {
        throw new Error(`Unsupported or corrupt task ledger: ${this.ledgerFile}`);
      }
      this.ledger = parsed as unknown as TaskLedger;
      for (const task of Object.values(this.ledger.tasks)) {
        if (!Array.isArray(task.pendingCreations)) task.pendingCreations = [];
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.ledger = { version: LEDGER_VERSION, tasks: {} };
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.ledgerFile), { recursive: true, mode: 0o700 });
    const tempFile = `${this.ledgerFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const body = `${JSON.stringify(this.ledger, null, 2)}\n`;
    try {
      await fs.promises.writeFile(tempFile, body, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tempFile, this.ledgerFile);
    } catch (error) {
      await fs.promises.rm(tempFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async withLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.ledgerQueue.then(operation, operation);
    this.ledgerQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) || Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.taskQueues.set(taskId, tail);
    try {
      return await run;
    } finally {
      if (this.taskQueues.get(taskId) === tail) this.taskQueues.delete(taskId);
    }
  }
}
