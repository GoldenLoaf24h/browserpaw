import { type ToolCallContext, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  resolveToolName,
  type BatchActionItem,
  type BatchActionResult,
  type CaptureNetworkOptions,
} from 'chrome-mcp-shared';
import {
  DIAGNOSTIC_REFRESH_GUIDANCE,
  computePerceptiveDelta,
  parseElementIndex,
} from './dom-indexer';
import { executeInPage } from './in-page-engine';
import { waitForPageSettle, waitForNetworkQuiescence } from '@/utils/action-watchdog';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { computeHumanizedPoints } from '@/utils/mouse-trajectory';
import {
  raceCdp as raceCdpBatch,
  DialogOpenedError,
  createDialogInterruptResponse,
  createMousePressGuard,
  isCdpOutcomeUncertainError,
} from '@/utils/race-cdp';
import { resolveTargetLocation, formatLocatorDiagnostics } from './unified-locator';
import { captureDeltaIfRequested, ensureSnapshotBaseline } from '@/utils/delta-helper';
import { projectFramePoint } from '../../../../utils/frame-coordinates';
import { tabFaviconManager } from './tab-favicon';
import {
  animateAgentCursor,
  animateAgentCursorClick,
  formatAgentCursorAction,
  setAgentCursorNote,
} from './agent-cursor';
import { parseUnifiedCoordinate } from '@/utils/coordinate-parser';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { startActionNetworkCapture } from '@/utils/action-network-capture';
import { performPhysicalFill } from './fill-core';
import { withActionReceipt } from '@/utils/action-receipt';
import { throwIfAborted, waitWithAbort } from '@/utils/action-abort';
import {
  createInteractionErrorResponse,
  makeInteractionOutcome,
} from '@/utils/interaction-outcome';

const MUTATING_BATCH_ACTION_TYPES = new Set([
  'click',
  'double_click',
  'right_click',
  'fill',
  'fill_form',
  'press_key',
  'key',
  'scroll',
]);

function isMutatingBatchAction(type: unknown): boolean {
  return typeof type === 'string' && MUTATING_BATCH_ACTION_TYPES.has(type);
}

function dispatchedCountForOutput(type: unknown, output: any): number {
  if (!isMutatingBatchAction(type)) return 0;
  if (!output || typeof output !== 'object') return 0;
  const interaction = output?.interaction?.execution;
  if (interaction?.status === 'unknown' || interaction?.status === 'dispatched') {
    return Math.max(1, Number(interaction.dispatchedCount) || 1);
  }
  if (interaction?.status === 'not_dispatched') return 0;
  if (type === 'fill_form' && Array.isArray(output?.fields)) {
    const count = output.fields.filter(
      (field: any) =>
        field?.committed === true ||
        field?.status === 'unknown' ||
        field?.interaction?.execution?.status === 'dispatched' ||
        field?.interaction?.execution?.status === 'unknown',
    ).length;
    if (count > 0) return count;
  }
  if (output?.requestDispatched === true || output?.committed === true) return 1;
  // Successful batch step outputs are often factual objects without a
  // `success` field; a completed mutating step in that shape was dispatched.
  if (output?.success !== false) return 1;
  return 0;
}

declare module 'chrome-mcp-shared' {
  interface BatchActionItem {
    frameId?: number;
  }
}

export interface BatchActionsParams {
  actions: BatchActionItem[];
  tabId?: number;
  windowId?: number;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  /** Wait for network requests to settle after actions or batch */
  waitForNetworkQuiescence?: boolean;
  quiescenceTimeoutMs?: number;
  includeDelta?: boolean;
  sessionId?: string;
  sessionContext?: string;
  /** Inline capture of network response triggered during batch execution */
  captureNetwork?: CaptureNetworkOptions;
}

type LocatorBatchActionItem = BatchActionItem & {
  targetText?: string;
  role?: string;
  label?: string;
  exact?: boolean;
};

const KEY_ALIASES: Record<string, { key: string; code?: string; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter' },
  return: { key: 'Enter', code: 'Enter' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete' },
  tab: { key: 'Tab', code: 'Tab' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  space: { key: ' ', code: 'Space', text: ' ' },
  pageup: { key: 'PageUp', code: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown' },
  home: { key: 'Home', code: 'Home' },
  end: { key: 'End', code: 'End' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
};

function resolveKey(token: string): { key: string; code?: string; text?: string } {
  const t = (token || '').toLowerCase();
  if (KEY_ALIASES[t]) return KEY_ALIASES[t];
  if (/^f([1-9]|1[0-2])$/.test(t)) {
    return { key: t.toUpperCase(), code: t.toUpperCase() };
  }
  if (token.length === 1) {
    const upper = token.toUpperCase();
    return { key: token, code: `Key${upper}`, text: token };
  }
  return { key: token, code: token };
}

const KEY_VK_CODES: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Delete: 46,
  Tab: 9,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Meta: 91,
};

function virtualKeyCode(key: string, code?: string): number | undefined {
  if (key in KEY_VK_CODES) return KEY_VK_CODES[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return 112 + Number(key.slice(1)) - 1;
  if (/^Key[A-Z]$/.test(code || '')) return 65 + (code as string).charCodeAt(3) - 65;
  if (/^Digit[0-9]$/.test(code || '')) return 48 + Number((code as string).slice(5));
  return undefined;
}

interface ModifierDef {
  key: string;
  code: string;
  vk: number;
  mask: number;
}

const MODIFIER_DEFS: Record<string, ModifierDef> = {
  Control: { key: 'Control', code: 'ControlLeft', vk: 17, mask: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91, mask: 4 },
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18, mask: 1 },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16, mask: 8 },
};

const MODIFIER_TOKENS: Record<string, 'Control' | 'Meta' | 'Alt' | 'Shift'> = {
  ctrl: 'Control',
  control: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
  windows: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

function parseKeyCombo(rawKey: string): {
  keyDef: { key: string; code?: string; text?: string };
  modifierDefs: ModifierDef[];
  modifiersMask: number;
} {
  const parts = (rawKey || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const modifierDefs: ModifierDef[] = [];
  let modifiersMask = 0;
  let mainToken = rawKey || '';
  if (parts.length > 1) {
    mainToken = parts[parts.length - 1];
    for (let i = 0; i < parts.length - 1; i++) {
      const modName = MODIFIER_TOKENS[parts[i].toLowerCase()];
      if (!modName) throw new Error('Unsupported key combo part: ' + parts[i]);
      modifierDefs.push(MODIFIER_DEFS[modName]);
      modifiersMask |= MODIFIER_DEFS[modName].mask;
    }
  }
  return { keyDef: resolveKey(mainToken), modifierDefs, modifiersMask };
}

export class BatchActionsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.BATCH_ACTIONS;

  async execute(args: BatchActionsParams, context?: ToolCallContext): Promise<ToolResult> {
    const actions = args?.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      return createInteractionErrorResponse(
        'actions parameter must be a non-empty array of actions',
        makeInteractionOutcome('not_dispatched', 'not_requested', 'invalid_actions', 0),
        { status: 'blocked', requestDispatched: false },
      );
    }
    const invalidSubmitAction = actions.findIndex(
      (action) => action?.type === 'fill' && action.submit === true && !action.submitTarget,
    );
    if (invalidSubmitAction !== -1) {
      return createInteractionErrorResponse(
        `Action ${invalidSubmitAction} of type 'fill' has submit:true without submitTarget; the entire batch was rejected before dispatch`,
        makeInteractionOutcome('not_dispatched', 'not_requested', 'missing_submit_target', 0),
        {
          status: 'blocked',
          requestDispatched: false,
          failedActionIndex: invalidSubmitAction,
        },
      );
    }
    const conflictingSubmitAction = actions.findIndex(
      (action) => action?.type === 'fill' && action.submit === true && action.pressEnter === true,
    );
    if (conflictingSubmitAction !== -1) {
      return createInteractionErrorResponse(
        `Action ${conflictingSubmitAction} of type 'fill' requests both Enter and an explicit submitTarget; the entire batch was rejected before dispatch`,
        makeInteractionOutcome('not_dispatched', 'not_requested', 'conflicting_submit_actions', 0),
        {
          status: 'blocked',
          requestDispatched: false,
          failedActionIndex: conflictingSubmitAction,
        },
      );
    }

    const signal = context?.signal;
    let mutationAttempted = false;
    let unclassifiedUnknownOutcome = false;
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createInteractionErrorResponse(
          `No active tab found for ${resolveToolName('batch_actions')}`,
          makeInteractionOutcome('not_dispatched', 'not_requested', 'no_active_tab', 0),
          { status: 'blocked', requestDispatched: false },
        );
      }
      const tabId = tab.id;
      tabFaviconManager.markTabActive(tabId);

      return await sessionTabAffinity.runSerialized(tabId, () =>
        withActionReceipt(tabId, async () => {
          const initialUrl = tab.url || '';
          const actionResults: Array<{
            actionIndex: number;
            success: boolean;
            status?: 'success' | 'failed' | 'unknown';
            retry?: boolean;
            requestDispatched?: boolean;
            error?: string;
            output?: any;
          }> = [];
          const extractedData: Record<string, string> = {};
          const assertions: Array<{
            actionIndex: number;
            passed: boolean;
            condition?: string;
            error?: string;
          }> = [];
          let interruptedReason: string | undefined;
          let unknownOutcome = false;
          let dialogInterrupt: DialogOpenedError | undefined;
          let dispatchedActions = 0;

          let spaDriftNotice: string | undefined;

          let isMac = false;
          try {
            const platform = await chrome.runtime.getPlatformInfo();
            isMac = platform?.os === 'mac';
          } catch {}

          const batchNetCapture = startActionNetworkCapture(tabId, args.captureNetwork);

          const preSignature = await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
            .then((r) => r?.[0]?.result)
            .catch(() => null);

          await ensureSnapshotBaseline(tabId, args.includeDelta);

          actionsLoop: for (let i = 0; i < actions.length; i++) {
            throwIfAborted(signal, 'before a batch action');
            const item = actions[i];
            let stepDispatchedCount = 0;
            if (isMutatingBatchAction(item?.type)) {
              mutationAttempted = true;
            }
            if (item && typeof item === 'object') {
              if (
                typeof (item as any).index === 'string' &&
                /^-?\d+$/.test((item as any).index.trim())
              ) {
                item.index = parseInt((item as any).index.trim(), 10);
              }
              if (typeof (item as any).pressEnter === 'string') {
                item.pressEnter = (item as any).pressEnter.trim() === 'true';
              }
              if (typeof (item as any).submit === 'string') {
                (item as any).submit = (item as any).submit.trim() === 'true';
              }
              if (typeof (item as any).clear === 'string') {
                item.clear = (item as any).clear.trim() === 'true';
              }
            }
            const itemNetCapture = startActionNetworkCapture(tabId, item.captureNetwork);

            // Runtime URL drift guard: verify URL has not navigated to a different origin
            const currentTab = await chrome.tabs.get(tabId).catch(() => null);
            if (!currentTab) {
              interruptedReason = `Tab was closed during batch execution`;
              batchNetCapture.dispose();
              break;
            }
            if (currentTab.url !== initialUrl) {
              let sameOrigin = false;
              try {
                const initOrigin = new URL(initialUrl).origin;
                const curOrigin = currentTab.url ? new URL(currentTab.url).origin : '';
                if (initOrigin === curOrigin && curOrigin !== '') {
                  sameOrigin = true;
                }
              } catch {}

              if (!sameOrigin) {
                interruptedReason = `Page URL changed or tab navigated to different origin during batch execution (from "${initialUrl}" to "${currentTab.url}")`;
                batchNetCapture.dispose();
                break;
              } else {
                // SPA path/hash navigation within the same origin: do not abort
                spaDriftNotice = `SPA navigation detected within origin (from "${initialUrl}" to "${currentTab.url}")`;
              }
            }

            try {
              // Precise scheduling: optional absolute epoch-ms deadline per action
              if (typeof item.at === 'number' && item.at > Date.now()) {
                await waitWithAbort(
                  item.at! - Date.now(),
                  signal,
                  'while waiting for a batch action',
                );
              }

              let stepOutput: any;

              switch (item.type) {
                case 'click':
                case 'double_click':
                case 'right_click':
                case 'hover': {
                  const rawCoord =
                    item.coordinate ??
                    (item as any).coordinates ??
                    (typeof item.x === 'number' && typeof item.y === 'number'
                      ? { x: item.x, y: item.y }
                      : undefined);

                  const locatorItem = item as LocatorBatchActionItem;
                  let loc = await resolveTargetLocation(tabId, {
                    ref: item.ref ?? item.index,
                    selector: item.selector,
                    text: locatorItem.targetText ?? item.text,
                    targetText: locatorItem.targetText,
                    role: locatorItem.role,
                    label: locatorItem.label,
                    exact: locatorItem.exact,
                    frameId: item.frameId,
                    coordinate: rawCoord,
                    operation: 'click',
                    taskId: context?.taskId,
                    signal,
                    deadlineAt:
                      (item as any)?.deadlineAt ??
                      (item as any)?.deadline ??
                      (args as any)?.deadlineAt ??
                      (args as any)?.deadline,
                  } as any);

                  if (!loc.success) {
                    throw Object.assign(
                      new Error(
                        loc.error ||
                          `Action ${i} of type '${item.type}' target not found. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                      ),
                      { locator: loc, requestDispatched: false },
                    );
                  }

                  const targetIndex = loc.resolutionPath === 'coordinate' ? undefined : loc.index;
                  if (typeof targetIndex === 'number') {
                    const ready = (
                      await executeInPage(
                        loc.frameId ? { tabId, frameIds: [loc.frameId] } : { tabId },
                        'inPageWaitForActionable',
                        [targetIndex, item.type],
                      )
                    )?.[0]?.result;
                    if (!ready?.success) {
                      throw Object.assign(new Error(ready?.error || 'Target is not actionable'), {
                        requestDispatched: false,
                      });
                    }
                    loc = { ...loc, ...ready };
                  }

                  let targetX = loc.x;
                  let targetY = loc.y;
                  const targetFrameId = loc.frameId ?? 0;

                  if (targetFrameId !== 0) {
                    const localX = (loc as any)?.frameOffsetX || 0;
                    const localY = (loc as any)?.frameOffsetY || 0;
                    ({ x: targetX, y: targetY } = await projectFramePoint(tabId, targetFrameId, {
                      x: targetX - localX,
                      y: targetY - localY,
                    }));
                  }

                  // Interception check & mask piercing
                  let maskPierced: { description: string; reason: string } | undefined;
                  if (typeof targetIndex === 'number' && item.type === 'click') {
                    try {
                      const targetScope =
                        targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId };
                      const interceptRes = (
                        await executeInPage(targetScope, 'inPageCheckInterception', [
                          targetIndex,
                          loc.x - ((loc as any).frameOffsetX || 0),
                          loc.y - ((loc as any).frameOffsetY || 0),
                        ])
                      )?.[0]?.result;
                      if (interceptRes?.intercepted && interceptRes?.description) {
                        if (interceptRes.canPierce && item.pierceOverlay !== false) {
                          maskPierced = {
                            description: interceptRes.description,
                            reason: interceptRes.pierceReason || 'transient_mask',
                          };
                        } else {
                          throw Object.assign(
                            new Error(
                              `Action ${i} click intercepted by ${interceptRes.description}. Please dismiss or interact with the overlay/dialog first.`,
                            ),
                            { requestDispatched: false },
                          );
                        }
                      }
                    } catch (e: any) {
                      if (e.message?.includes('intercepted')) throw e;
                    }
                  }

                  const batchActNote = formatAgentCursorAction(item.type, loc);
                  await animateAgentCursor(tabId, targetX, targetY, {
                    waitForArrival: true,
                    timeoutMs: 350,
                    actionNote: batchActNote,
                  });
                  let usedNativeCDP = false;
                  await cdpSessionManager.withSession(tabId, 'batch-actions-mouse', async () => {
                    // Humanized micro-trajectory (bounded tightly within proximity window)
                    const startX = Math.max(0, targetX - (15 + Math.floor(Math.random() * 15)));
                    const startY = Math.max(0, targetY - (10 + Math.floor(Math.random() * 12)));
                    const points = computeHumanizedPoints(startX, startY, targetX, targetY, 3);
                    for (const pt of points) {
                      await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                        type: 'mouseMoved',
                        x: pt.x,
                        y: pt.y,
                      });
                      await new Promise((r) => setTimeout(r, 10));
                    }

                    if (item.type === 'click') {
                      await animateAgentCursorClick(tabId, targetX, targetY, batchActNote);
                      const clickGuard = createMousePressGuard(
                        (eventParams) =>
                          raceCdpBatch(tabId, 'Input.dispatchMouseEvent', eventParams),
                        {
                          type: 'mouseReleased',
                          x: targetX,
                          y: targetY,
                          button: 'left',
                          buttons: 0,
                          clickCount: 1,
                        },
                      );
                      try {
                        await clickGuard.press({
                          type: 'mousePressed',
                          x: targetX,
                          y: targetY,
                          button: 'left',
                          buttons: 1,
                          clickCount: 1,
                        });
                        await new Promise((r) => setTimeout(r, 35));
                        await clickGuard.release();
                        usedNativeCDP = true;
                      } finally {
                        await clickGuard.compensate();
                      }
                    } else if (item.type === 'double_click') {
                      await animateAgentCursorClick(tabId, targetX, targetY, batchActNote);
                      const firstClickGuard = createMousePressGuard(
                        (eventParams) =>
                          raceCdpBatch(tabId, 'Input.dispatchMouseEvent', eventParams),
                        {
                          type: 'mouseReleased',
                          x: targetX,
                          y: targetY,
                          button: 'left',
                          buttons: 0,
                          clickCount: 1,
                        },
                      );
                      try {
                        await firstClickGuard.press({
                          type: 'mousePressed',
                          x: targetX,
                          y: targetY,
                          button: 'left',
                          buttons: 1,
                          clickCount: 1,
                        });
                        await new Promise((r) => setTimeout(r, 35));
                        await firstClickGuard.release();
                      } finally {
                        await firstClickGuard.compensate();
                      }
                      await new Promise((r) => setTimeout(r, 40));
                      await animateAgentCursorClick(tabId, targetX, targetY, batchActNote);
                      const secondClickGuard = createMousePressGuard(
                        (eventParams) =>
                          raceCdpBatch(tabId, 'Input.dispatchMouseEvent', eventParams),
                        {
                          type: 'mouseReleased',
                          x: targetX,
                          y: targetY,
                          button: 'left',
                          buttons: 0,
                          clickCount: 2,
                        },
                      );
                      try {
                        await secondClickGuard.press({
                          type: 'mousePressed',
                          x: targetX,
                          y: targetY,
                          button: 'left',
                          buttons: 1,
                          clickCount: 2,
                        });
                        await new Promise((r) => setTimeout(r, 35));
                        await secondClickGuard.release();
                        usedNativeCDP = true;
                      } finally {
                        await secondClickGuard.compensate();
                      }
                    } else if (item.type === 'hover') {
                      usedNativeCDP = true;
                    } else if (item.type === 'right_click') {
                      await animateAgentCursorClick(tabId, targetX, targetY, batchActNote);
                      const rightClickTarget =
                        targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId };
                      if (typeof item.index === 'number' && item.index > 0) {
                        await executeInPage(rightClickTarget, 'inPageInteractIndex', [
                          item.index,
                          'right_click',
                        ]);
                      } else {
                        await executeInPage(rightClickTarget, 'inPageDispatchSyntheticClick', [
                          null,
                          targetX,
                          targetY,
                          'right_click',
                        ]);
                      }
                    }
                  });

                  stepOutput = {
                    x: targetX,
                    y: targetY,
                    action: item.type,
                    [item.type]: true,
                    tagName: loc.tagName,
                    text: loc.text,
                    isTrusted: usedNativeCDP,
                    ...(maskPierced ? { piercedOverlay: maskPierced } : {}),
                    ...formatLocatorDiagnostics(loc),
                  };
                  break;
                }

                case 'fill': {
                  const locatorItem = item as LocatorBatchActionItem;
                  const hasSemanticTarget = Boolean(
                    locatorItem.targetText || locatorItem.role || locatorItem.label,
                  );
                  if (
                    typeof item.index !== 'number' &&
                    typeof item.ref === 'undefined' &&
                    !item.selector &&
                    !hasSemanticTarget
                  ) {
                    throw new Error(
                      `Action ${i} of type 'fill' requires ref/index, selector, targetText, role, or label`,
                    );
                  }
                  let targetRef = item.ref ?? item.index ?? item.selector;
                  let targetFrameId = item.frameId;
                  let fillLoc: any;
                  if (hasSemanticTarget) {
                    fillLoc = await resolveTargetLocation(tabId, {
                      ref: item.ref ?? item.index,
                      selector: item.selector,
                      targetText: locatorItem.targetText,
                      role: locatorItem.role,
                      label: locatorItem.label,
                      exact: locatorItem.exact,
                      frameId: item.frameId,
                      operation: 'fill',
                      taskId: context?.taskId,
                      signal,
                      deadlineAt:
                        (item as any)?.deadlineAt ??
                        (item as any)?.deadline ??
                        (args as any)?.deadlineAt ??
                        (args as any)?.deadline,
                    } as any);
                    if (!fillLoc.success) {
                      throw Object.assign(
                        new Error(
                          fillLoc.error ||
                            `Action ${i} of type 'fill' target not found. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                        ),
                        { locator: fillLoc, requestDispatched: false },
                      );
                    }
                    targetRef = fillLoc.index ?? targetRef;
                    targetFrameId = fillLoc.frameId ?? targetFrameId;
                  }
                  if (targetRef === undefined || targetRef === null) {
                    throw new Error(`Action ${i} of type 'fill' resolved no durable target index`);
                  }
                  const text = String(
                    item.value ?? (locatorItem.targetText !== undefined ? '' : (item.text ?? '')),
                  );

                  if (i > 0) {
                    // Dynamic settling: allow framework DOM mutations / re-render from preceding action to settle
                    await waitWithAbort(60, signal, 'before a fill action');
                  }

                  throwIfAborted(signal, 'before a fill action');
                  const fillRes = await performPhysicalFill({
                    tabId,
                    target: targetRef!,
                    text,
                    clear: item.clear,
                    pressEnter: item.pressEnter,
                    submit: item.submit,
                    submitTarget: item.submitTarget,
                    taskId: context?.taskId,
                    preferComposer: item.preferComposer,
                    sessionId: args.sessionId,
                    sessionContext: args.sessionContext,
                    frameId: targetFrameId,
                    signal,
                    deadlineAt:
                      (item as any)?.deadlineAt ??
                      (item as any)?.deadline ??
                      (args as any)?.deadlineAt ??
                      (args as any)?.deadline,
                  });

                  if (!fillRes.success || fillRes.committed === false) {
                    const status =
                      fillRes.status === 'unknown' || fillRes.submitResult?.status === 'unknown'
                        ? 'unknown'
                        : fillRes.status === 'timeout'
                          ? 'timeout'
                          : 'failed';
                    throw Object.assign(
                      new Error(
                        fillRes.error ||
                          fillRes.diagnostics ||
                          `Fill failed on [${targetRef}]. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                      ),
                      {
                        status,
                        retry: status === 'unknown' ? false : undefined,
                        committed: fillRes.committed,
                        receipt: fillRes.receipt,
                        output: fillRes,
                        ...(fillLoc ? { locator: fillLoc } : {}),
                      },
                    );
                  }

                  stepOutput = {
                    success: fillRes.submitResult?.status !== 'unknown',
                    committed: true,
                    status: fillRes.submitResult?.status,
                    ...(fillRes.submitResult ? { submitResult: fillRes.submitResult } : {}),
                    index: fillRes.index,
                    ref: fillRes.ref,
                    selector: fillRes.selector,
                    filledText: text,
                    isTrusted: fillRes.isTrusted,
                    method: fillRes.method,
                    tagName: fillRes.tagName,
                    isComposer: fillRes.isComposer,
                    isEditor: fillRes.isEditor,
                    isSearch: fillRes.isSearch,
                    ...(fillRes.interaction ? { interaction: fillRes.interaction } : {}),
                    submitButtonState: fillRes.submitButtonState,
                    ...(fillRes.submitted
                      ? {
                          submitted: true,
                          submitMethod: fillRes.submitMethod,
                        }
                      : {}),
                    ...(fillRes.disambiguationWarning
                      ? { disambiguationWarning: fillRes.disambiguationWarning }
                      : {}),
                    ...(fillLoc ? formatLocatorDiagnostics(fillLoc) : {}),
                  };
                  break;
                }

                case 'fill_form': {
                  const fields = (item as any).fields;
                  if (!Array.isArray(fields) || fields.length === 0) {
                    throw new Error(
                      `Action ${i} of type 'fill_form' requires non-empty 'fields' array`,
                    );
                  }
                  const fillFormResults: any[] = [];
                  for (let f = 0; f < fields.length; f++) {
                    const field = fields[f];
                    const target = field.ref ?? field.index ?? field.selector;
                    const textVal = String(field.value ?? field.text ?? '');
                    if (!target) {
                      fillFormResults.push({
                        fieldIndex: f,
                        success: false,
                        error: 'Field locator failed: missing ref, index, or selector',
                      });
                      continue;
                    }
                    if (f > 0) {
                      // Dynamic settling: allow framework DOM mutations / re-render from previous field to settle
                      await new Promise((r) => setTimeout(r, 60));
                    }
                    try {
                      throwIfAborted(signal, 'before fill_form field');
                      const fillRes = await performPhysicalFill({
                        tabId,
                        target,
                        text: textVal,
                        clear: field.clear,
                        selector: field.selector,
                        ref: field.ref ?? field.index,
                        sessionId: args.sessionId,
                        sessionContext: args.sessionContext,
                        frameId: field.frameId,
                        signal,
                        deadlineAt:
                          (field as any)?.deadlineAt ??
                          (field as any)?.deadline ??
                          (args as any)?.deadlineAt ??
                          (args as any)?.deadline,
                      });
                      fillFormResults.push({
                        fieldIndex: f,
                        success: fillRes.success && fillRes.committed !== false,
                        status: fillRes.submitResult?.status === 'unknown' ? 'unknown' : undefined,
                        committed: fillRes.committed,
                        ref: field.ref ?? field.index,
                        selector: field.selector,
                        resolutionPath: fillRes.resolutionPath,
                        submitResult: fillRes.submitResult,
                        ...(fillRes.interaction ? { interaction: fillRes.interaction } : {}),
                        error: fillRes.error || fillRes.diagnostics,
                      });
                    } catch (fillErr) {
                      if (fillErr instanceof DialogOpenedError) {
                        Object.assign(fillErr, { output: { fields: fillFormResults } });
                        throw fillErr;
                      }
                      if (isCdpOutcomeUncertainError(fillErr)) {
                        throw fillErr;
                      }
                      fillFormResults.push({
                        fieldIndex: f,
                        success: false,
                        ref: field.ref ?? field.index,
                        selector: field.selector,
                        error: String(fillErr instanceof Error ? fillErr.message : fillErr),
                      });
                    }
                  }
                  const allFieldsPassed = fillFormResults.every((r) => r.success);
                  stepOutput = {
                    success: allFieldsPassed,
                    fields: fillFormResults,
                  };
                  if (
                    fillFormResults.some(
                      (r) => r.status === 'unknown' || r.submitResult?.status === 'unknown',
                    )
                  ) {
                    throw Object.assign(
                      new Error(
                        `Batch fill_form outcome unknown on at least one field; stopping to avoid replay`,
                      ),
                      { status: 'unknown', retry: false, output: stepOutput },
                    );
                  }
                  if (!allFieldsPassed && item.abortOnFailure !== false) {
                    const failedDesc = fillFormResults
                      .filter((r) => !r.success)
                      .map((r) => `field ${r.fieldIndex} [${r.ref ?? r.selector}]: ${r.error}`)
                      .join('; ');
                    throw Object.assign(
                      new Error(
                        `Batch fill_form failed on ${failedDesc}. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                      ),
                      { output: stepOutput },
                    );
                  }
                  break;
                }

                case 'scroll': {
                  const targetRef = item.ref ?? item.index;
                  let targetIndex: number | undefined;
                  if (targetRef !== undefined && targetRef !== null) {
                    const parsed = parseElementIndex(targetRef);
                    if (!parsed) {
                      throw new Error(`Invalid index or ref format: ${targetRef}`);
                    }
                    targetIndex = parsed.numericIndex;
                  }

                  if (typeof targetIndex === 'number' && targetIndex > 0) {
                    const initialScrollTarget =
                      item.frameId !== undefined ? { tabId, frameIds: [item.frameId] } : { tabId };
                    const scrollRes = await executeInPage(
                      initialScrollTarget,
                      'inPageScrollToIndex',
                      [targetIndex],
                    );
                    let scrolled = Boolean(scrollRes?.[0]?.result);
                    if (!scrolled) {
                      const frameTarget =
                        item.frameId !== undefined
                          ? { tabId, frameIds: [item.frameId] }
                          : { tabId, allFrames: true };
                      const frameResults = await executeInPage(frameTarget, 'inPageScrollToIndex', [
                        targetIndex,
                      ]);
                      scrolled = Boolean(frameResults.some((r) => r.result));
                    }
                    if (!scrolled) {
                      throw new Error(
                        `Element with index [${targetIndex}] not found for scroll. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                      );
                    }
                    stepOutput = { scrolledIndex: targetIndex };
                    break;
                  }

                  const rawAmount = Math.abs(item.amount ?? 500);
                  // Honour all four directions. Previously deltaX was hard-coded to 0
                  // and only up/down were mapped, so horizontal scrolls silently
                  // turned into vertical ones.
                  const isHorizontal = item.direction === 'left' || item.direction === 'right';
                  const amount =
                    item.direction === 'up' || item.direction === 'left' ? -rawAmount : rawAmount;
                  const deltaX = isHorizontal ? amount : 0;
                  const deltaY = isHorizontal ? 0 : amount;
                  let cdpScrolled = false;
                  try {
                    const rawCoord =
                      item.coordinate ??
                      (item as any).coordinates ??
                      (typeof item.x === 'number' && typeof item.y === 'number'
                        ? { x: item.x, y: item.y }
                        : undefined);
                    const parsedCoord = rawCoord
                      ? parseUnifiedCoordinate(rawCoord, { tabId })
                      : null;
                    const scrollX = parsedCoord?.x ?? 500;
                    const scrollY = parsedCoord?.y ?? 400;
                    const scrollDir = item.direction || 'down';
                    const scrollNote =
                      (item as any).note ||
                      (item as any).actionNote ||
                      (scrollDir === 'up' ? 'Scrolling back up' : 'Scrolling down timeline');
                    await animateAgentCursor(tabId, scrollX, scrollY, {
                      waitForArrival: true,
                      timeoutMs: 350,
                      actionNote: scrollNote,
                    });
                    await cdpSessionManager.withSession(tabId, 'batch-actions-scroll', async () => {
                      const STEPS = Math.abs(deltaY || deltaX) > 400 ? 14 : 10;
                      const stepDelayMs = 18;
                      let accumulatedX = 0;
                      let accumulatedY = 0;
                      for (let s = 1; s <= STEPS; s++) {
                        const progress = 0.5 * (1 - Math.cos((Math.PI * s) / STEPS));
                        const targetX = Math.round(deltaX * progress);
                        const targetY = Math.round(deltaY * progress);
                        const stepX = targetX - accumulatedX;
                        const stepY = targetY - accumulatedY;
                        accumulatedX += stepX;
                        accumulatedY += stepY;
                        if (stepX !== 0 || stepY !== 0) {
                          await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                            type: 'mouseWheel',
                            x: scrollX,
                            y: scrollY,
                            deltaX: stepX,
                            deltaY: stepY,
                          });
                        }
                        if (s < STEPS) await new Promise((r) => setTimeout(r, stepDelayMs));
                      }
                      cdpScrolled = true;
                    });
                  } catch (scrollErr) {
                    if (scrollErr instanceof DialogOpenedError) {
                      throw scrollErr;
                    }
                    // An unacknowledged wheel may already have scrolled; fail the
                    // step instead of issuing a second, cumulative scroll.
                    if (isCdpOutcomeUncertainError(scrollErr)) {
                      throw scrollErr;
                    }
                  }

                  if (!cdpScrolled) {
                    await this.safeExecuteScript(tabId, {
                      target: { tabId },
                      func: (dx, dy) => {
                        window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
                      },
                      args: [deltaX, deltaY],
                    });
                    await new Promise((r) => setTimeout(r, 120));
                  } else {
                    await new Promise((r) => setTimeout(r, 60));
                  }
                  stepOutput = {
                    scrolled: amount,
                    direction: item.direction ?? 'down',
                    deltaX,
                    deltaY,
                    method: cdpScrolled ? 'cdp_wheel' : 'window_scroll_by',
                  };
                  break;
                }

                case 'wait': {
                  const waitMs = Math.min(item.durationMs ?? 500, 10000);
                  await waitWithAbort(waitMs, signal, 'during a batch wait');
                  stepOutput = { waitedMs: waitMs };
                  break;
                }

                case 'key':
                case 'press_key': {
                  const keyNote =
                    (item as any).note ||
                    (item as any).actionNote ||
                    `Pressing ${item.key || 'Enter'}`;
                  await setAgentCursorNote(tabId, keyNote);
                  const { keyDef, modifierDefs, modifiersMask } = parseKeyCombo(
                    item.key || 'Enter',
                  );
                  const vk = virtualKeyCode(keyDef.key, keyDef.code);
                  throwIfAborted(signal, 'before click action');
                  await cdpSessionManager.withSession(tabId, 'batch-actions', async () => {
                    if (!modifierDefs.length && keyDef.text && keyDef.text.length === 1) {
                      try {
                        await raceCdpBatch(tabId, 'Input.insertText', { text: keyDef.text });
                      } catch (insertErr) {
                        // Uncertain delivery may already have inserted the text; never
                        // issue the key event fallback in that case or it doubles.
                        if (isCdpOutcomeUncertainError(insertErr)) {
                          throw insertErr;
                        }
                        await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                          type: 'keyDown',
                          key: keyDef.key,
                          code: keyDef.code,
                          text: keyDef.text,
                          windowsVirtualKeyCode: vk,
                        });
                        await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                          type: 'keyUp',
                          key: keyDef.key,
                          code: keyDef.code,
                          windowsVirtualKeyCode: vk,
                        });
                      }
                    } else if (!modifierDefs.length) {
                      // keyDown (not rawKeyDown) so browser default actions fire:
                      // Tab focus traversal, Enter button activation, Escape dialog
                      // dismissal all rely on the keydown default behavior. Enter
                      // additionally needs text='\r' to generate the keypress that
                      // triggers activation (matches Puppeteer semantics).
                      await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                        type: 'keyDown',
                        key: keyDef.key,
                        code: keyDef.code,
                        text: keyDef.key === 'Enter' ? '\r' : undefined,
                        windowsVirtualKeyCode: vk,
                      });
                      await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        key: keyDef.key,
                        code: keyDef.code,
                        windowsVirtualKeyCode: vk,
                      });
                    } else {
                      let heldMask = 0;
                      for (const mod of modifierDefs) {
                        heldMask |= mod.mask;
                        await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                          type: 'rawKeyDown',
                          key: mod.key,
                          code: mod.code,
                          windowsVirtualKeyCode: mod.vk,
                          modifiers: heldMask,
                        });
                      }
                      await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                        type: 'rawKeyDown',
                        key: keyDef.key,
                        code: keyDef.code,
                        windowsVirtualKeyCode: vk,
                        modifiers: modifiersMask,
                      });
                      await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        key: keyDef.key,
                        code: keyDef.code,
                        windowsVirtualKeyCode: vk,
                        modifiers: modifiersMask,
                      });
                      for (let i = modifierDefs.length - 1; i >= 0; i--) {
                        const mod = modifierDefs[i];
                        await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                          type: 'keyUp',
                          key: mod.key,
                          code: mod.code,
                          windowsVirtualKeyCode: mod.vk,
                          modifiers: heldMask,
                        });
                        heldMask &= ~mod.mask;
                      }
                    }
                  });
                  stepOutput = { pressedKey: keyDef.key, modifiers: modifiersMask };
                  break;
                }

                case 'assert': {
                  const condition = item.condition || 'contains';
                  const expected = item.expectedText ?? '';
                  const timeoutMs = typeof item.timeoutMs === 'number' ? item.timeoutMs : 300;
                  const deadline = Date.now() + Math.max(0, timeoutMs);

                  let actualText = '';
                  let isVisible = false;
                  let disabled = false;
                  let ariaDisabled = false;
                  let validity: { valid: boolean } | undefined = undefined;
                  let invalidReason: string | undefined = undefined;
                  let checked: boolean | undefined = undefined;
                  let selected: boolean | undefined = undefined;
                  let passed = false;

                  const targetRef = item.ref ?? item.index;
                  let targetIndex: number | undefined;
                  if (targetRef !== undefined && targetRef !== null) {
                    const parsed = parseElementIndex(targetRef);
                    if (!parsed) {
                      throw new Error(`Invalid index or ref format: ${targetRef}`);
                    }
                    targetIndex = parsed.numericIndex;
                  }

                  while (true) {
                    if (typeof targetIndex === 'number' && targetIndex > 0) {
                      const initialAssertTarget =
                        item.frameId !== undefined
                          ? { tabId, frameIds: [item.frameId] }
                          : { tabId };
                      const res = await executeInPage(
                        initialAssertTarget,
                        'inPageGetElementCoordinates',
                        [targetIndex],
                      );
                      let coords = res?.[0]?.result;
                      if (!coords?.success) {
                        const frameTarget =
                          item.frameId !== undefined
                            ? { tabId, frameIds: [item.frameId] }
                            : { tabId, allFrames: true };
                        const frameResults = await executeInPage(
                          frameTarget,
                          'inPageGetElementCoordinates',
                          [targetIndex],
                        );
                        const match = frameResults.find((r) => r.result?.success);
                        if (match?.result) coords = match.result;
                      }
                      if (coords?.success) {
                        isVisible = true;
                        actualText = String(coords.text ?? coords.value ?? '');
                        disabled = Boolean(coords.disabled);
                        ariaDisabled = Boolean(coords.ariaDisabled);
                        validity = coords.validity;
                        invalidReason = coords.invalidReason;
                        checked = coords.checked;
                        selected = coords.selected;
                      } else {
                        isVisible = false;
                        actualText = '';
                        disabled = false;
                        ariaDisabled = false;
                        validity = undefined;
                        invalidReason = undefined;
                        checked = undefined;
                        selected = undefined;
                      }
                    } else if (
                      item.selector ||
                      Boolean(
                        (item as LocatorBatchActionItem).targetText ||
                        item.text ||
                        (item as LocatorBatchActionItem).role ||
                        (item as LocatorBatchActionItem).label,
                      )
                    ) {
                      if (!item.selector) {
                        const locatorItem = item as LocatorBatchActionItem;
                        const loc = await resolveTargetLocation(tabId, {
                          targetText: locatorItem.targetText,
                          text: item.text,
                          role: locatorItem.role,
                          label: locatorItem.label,
                          exact: locatorItem.exact,
                          frameId: item.frameId,
                          operation: 'locate',
                          signal,
                          deadlineAt:
                            (item as any)?.deadlineAt ??
                            (item as any)?.deadline ??
                            (args as any)?.deadlineAt ??
                            (args as any)?.deadline,
                        } as any);
                        if (loc.success) {
                          isVisible = true;
                          actualText = String(loc.text ?? loc.value ?? '');
                          disabled = Boolean((loc as any).disabled);
                          ariaDisabled = Boolean((loc as any).ariaDisabled);
                          checked = (loc as any).checked;
                          selected = (loc as any).selected;
                        } else if ((loc as any).notFound) {
                          isVisible = false;
                          actualText = '';
                          disabled = false;
                          ariaDisabled = false;
                          checked = undefined;
                          selected = undefined;
                        } else {
                          throw new Error(
                            loc.error || `Action ${i} target locator failed in strict mode`,
                          );
                        }
                      } else {
                        const selFunc = (sel: string) => {
                          function queryDeep(
                            selector: string,
                            root: ParentNode = document,
                          ): Element | null {
                            if (!root || !selector) return null;
                            if (selector.includes('>>>') || selector.includes('/deep/')) {
                              const parts = selector
                                .split(/>>>|\/deep\//)
                                .map((s) => s.trim())
                                .filter(Boolean);
                              let cur: ParentNode[] = [root];
                              for (let i = 0; i < parts.length; i++) {
                                const p = parts[i];
                                const next: Element[] = [];
                                for (const c of cur) {
                                  const res = queryDeep(p, c);
                                  if (res) next.push(res);
                                }
                                if (i === parts.length - 1) return next[0] || null;
                                const nextCtx: ParentNode[] = [];
                                for (const n of next) {
                                  const sr = n.shadowRoot || (n as any).__shadowRoot;
                                  if (sr) nextCtx.push(sr);
                                  else nextCtx.push(n);
                                }
                                cur = nextCtx;
                                if (cur.length === 0) return null;
                              }
                            }
                            try {
                              const direct = root.querySelector(selector);
                              if (direct) return direct;
                            } catch {}
                            const all = root.querySelectorAll('*');
                            for (let i = 0; i < all.length; i++) {
                              const sr = all[i].shadowRoot || (all[i] as any).__shadowRoot;
                              if (sr) {
                                const found = queryDeep(selector, sr);
                                if (found) return found;
                              }
                            }
                            return null;
                          }
                          const el = queryDeep(sel);
                          if (!el) return { found: false };
                          const rect = el.getBoundingClientRect();
                          const visible =
                            rect.width > 0 &&
                            rect.height > 0 &&
                            window.getComputedStyle(el).visibility !== 'hidden' &&
                            window.getComputedStyle(el).display !== 'none';
                          const isAriaInvalid = el.getAttribute('aria-invalid') === 'true';
                          const valObj = (el as any).validity;
                          const validity = valObj
                            ? { valid: isAriaInvalid ? false : Boolean(valObj.valid) }
                            : isAriaInvalid
                              ? { valid: false }
                              : undefined;
                          const invalidReason =
                            (el as any).validationMessage ||
                            (isAriaInvalid ? 'aria-invalid' : undefined);
                          return {
                            found: true,
                            visible,
                            text: (el as HTMLElement).innerText ?? el.textContent ?? '',
                            value: (el as HTMLInputElement).value ?? '',
                            disabled: Boolean((el as any).disabled || el.hasAttribute('disabled')),
                            ariaDisabled: el.getAttribute('aria-disabled') === 'true',
                            validity,
                            invalidReason,
                            checked:
                              typeof (el as any).checked === 'boolean'
                                ? (el as any).checked
                                : el.getAttribute('aria-checked') === 'true'
                                  ? true
                                  : el.getAttribute('aria-checked') === 'false'
                                    ? false
                                    : undefined,
                            selected:
                              typeof (el as any).selected === 'boolean'
                                ? (el as any).selected
                                : el.getAttribute('aria-selected') === 'true'
                                  ? true
                                  : el.getAttribute('aria-selected') === 'false'
                                    ? false
                                    : undefined,
                          };
                        };
                        const initialSelectorTarget =
                          item.frameId !== undefined
                            ? { tabId, frameIds: [item.frameId] }
                            : { tabId };
                        const selRes = await this.safeExecuteScript(tabId, {
                          target: initialSelectorTarget,
                          func: selFunc,
                          args: [item.selector],
                        });
                        let data = selRes?.[0]?.result as any;
                        if (!data?.found) {
                          const frameTarget =
                            item.frameId !== undefined
                              ? { tabId, frameIds: [item.frameId] }
                              : { tabId, allFrames: true };
                          const frameResults = await this.safeExecuteScript(tabId, {
                            target: frameTarget,
                            func: selFunc,
                            args: [item.selector],
                          });
                          const match = frameResults.find((r: any) => r.result?.found);
                          if (match?.result) data = match.result;
                        }
                        if (data?.found) {
                          isVisible = Boolean(data.visible);
                          actualText = String(data.text || data.value || '');
                          disabled = Boolean(data.disabled);
                          ariaDisabled = Boolean(data.ariaDisabled);
                          validity = data.validity;
                          invalidReason = data.invalidReason;
                          checked = data.checked;
                          selected = data.selected;
                        } else {
                          isVisible = false;
                          actualText = '';
                          disabled = false;
                          ariaDisabled = false;
                          validity = undefined;
                          invalidReason = undefined;
                          checked = undefined;
                          selected = undefined;
                        }
                      }
                    }

                    switch (condition) {
                      case 'visible':
                        passed = isVisible;
                        break;
                      case 'not_visible':
                        passed = !isVisible;
                        break;
                      case 'enabled':
                        passed = isVisible && !disabled && !ariaDisabled;
                        break;
                      case 'disabled':
                        passed = disabled || ariaDisabled;
                        break;
                      case 'valid':
                        passed = validity ? validity.valid : !invalidReason;
                        break;
                      case 'invalid':
                        passed = validity ? !validity.valid : Boolean(invalidReason);
                        break;
                      case 'checked':
                        passed = checked !== undefined ? Boolean(checked) : Boolean(selected);
                        break;
                      case 'unchecked':
                        passed = checked !== undefined ? !checked : !selected;
                        break;
                      case 'matches':
                        try {
                          passed = new RegExp(expected).test(actualText);
                        } catch {
                          passed = false;
                        }
                        break;
                      case 'equals':
                        passed = actualText.trim() === expected.trim();
                        break;
                      case 'not_contains':
                        passed = !actualText.includes(expected);
                        break;
                      case 'contains':
                      default:
                        passed = actualText.includes(expected);
                        break;
                    }

                    if (passed || Date.now() >= deadline) break;
                    const remaining = deadline - Date.now();
                    if (remaining <= 0) break;
                    await new Promise((r) => setTimeout(r, Math.min(50, remaining)));
                  }

                  assertions.push({
                    actionIndex: i,
                    passed,
                    condition,
                    error: passed
                      ? undefined
                      : `Assertion failed: expected "${expected}" with condition "${condition}", got "${actualText}" (visible=${isVisible}, disabled=${disabled || ariaDisabled}, valid=${validity ? validity.valid : !invalidReason}, checked=${checked})`,
                  });

                  if (!passed && item.abortOnFailure !== false) {
                    throw new Error(
                      `Assertion failed at action ${i}: condition "${condition}" not met for expected "${expected}". Actual: "${actualText}"`,
                    );
                  }

                  stepOutput = {
                    asserted: true,
                    passed,
                    condition,
                    actualText,
                    isVisible,
                    disabled,
                    ariaDisabled,
                    valid: validity ? validity.valid : !invalidReason,
                    invalidReason,
                    checked,
                    selected,
                  };
                  break;
                }

                case 'extract': {
                  let extractedValue = '';
                  const prop = item.property || 'text';
                  const targetRef = item.ref ?? item.index;
                  let targetIndex: number | undefined;
                  if (targetRef !== undefined && targetRef !== null) {
                    const parsed = parseElementIndex(targetRef);
                    if (!parsed) {
                      throw new Error(`Invalid index or ref format: ${targetRef}`);
                    }
                    targetIndex = parsed.numericIndex;
                  }

                  if (typeof targetIndex === 'number' && targetIndex > 0) {
                    const initialExtractTarget =
                      item.frameId !== undefined ? { tabId, frameIds: [item.frameId] } : { tabId };
                    const res = await executeInPage(
                      initialExtractTarget,
                      'inPageGetElementCoordinates',
                      [targetIndex],
                    );
                    let coords = res?.[0]?.result;
                    if (!coords?.success) {
                      const frameTarget =
                        item.frameId !== undefined
                          ? { tabId, frameIds: [item.frameId] }
                          : { tabId, allFrames: true };
                      const frameResults = await executeInPage(
                        frameTarget,
                        'inPageGetElementCoordinates',
                        [targetIndex],
                      );
                      const match = frameResults.find((r) => r.result?.success);
                      if (match?.result) coords = match.result;
                    }
                    if (coords?.success) {
                      if (prop === 'attribute') {
                        const attrName = item.attributeName || '';
                        const attrs = (coords as any).attributes || {};
                        extractedValue = attrs[attrName] ?? attrs[attrName.toLowerCase()] ?? '';
                      } else if (prop === 'value') {
                        extractedValue = String(coords.value ?? '');
                      } else {
                        extractedValue = String(coords.text ?? '');
                      }
                    }
                  } else if (item.selector) {
                    const extractFunc = (sel: string, p: string, attr?: string) => {
                      function queryDeep(
                        selector: string,
                        root: ParentNode = document,
                      ): Element | null {
                        if (!root || !selector) return null;
                        if (selector.includes('>>>') || selector.includes('/deep/')) {
                          const parts = selector
                            .split(/>>>|\/deep\//)
                            .map((s) => s.trim())
                            .filter(Boolean);
                          let cur: ParentNode[] = [root];
                          for (let i = 0; i < parts.length; i++) {
                            const sub = parts[i];
                            const next: Element[] = [];
                            for (const c of cur) {
                              const res = queryDeep(sub, c);
                              if (res) next.push(res);
                            }
                            if (i === parts.length - 1) return next[0] || null;
                            const nextCtx: ParentNode[] = [];
                            for (const n of next) {
                              const sr = n.shadowRoot || (n as any).__shadowRoot;
                              if (sr) nextCtx.push(sr);
                              else nextCtx.push(n);
                            }
                            cur = nextCtx;
                            if (cur.length === 0) return null;
                          }
                        }
                        try {
                          const direct = root.querySelector(selector);
                          if (direct) return direct;
                        } catch {}
                        const all = root.querySelectorAll('*');
                        for (let i = 0; i < all.length; i++) {
                          const sr = all[i].shadowRoot || (all[i] as any).__shadowRoot;
                          if (sr) {
                            const found = queryDeep(selector, sr);
                            if (found) return found;
                          }
                        }
                        return null;
                      }
                      const el = queryDeep(sel);
                      if (!el) return null;
                      if (p === 'attribute' && attr) return el.getAttribute(attr) ?? '';
                      if (p === 'value') return (el as HTMLInputElement).value ?? '';
                      return (el as HTMLElement).innerText ?? el.textContent ?? '';
                    };
                    const initialExtractSelectorTarget =
                      item.frameId !== undefined ? { tabId, frameIds: [item.frameId] } : { tabId };
                    const selRes = await this.safeExecuteScript(tabId, {
                      target: initialExtractSelectorTarget,
                      func: extractFunc,
                      args: [item.selector, prop, item.attributeName || ''],
                    });
                    let val = selRes?.[0]?.result;
                    if (val === null || val === undefined) {
                      const frameTarget =
                        item.frameId !== undefined
                          ? { tabId, frameIds: [item.frameId] }
                          : { tabId, allFrames: true };
                      const frameResults = await this.safeExecuteScript(tabId, {
                        target: frameTarget,
                        func: extractFunc,
                        args: [item.selector, prop, item.attributeName || ''],
                      });
                      const match = frameResults.find(
                        (r: any) => r.result !== null && r.result !== undefined,
                      );
                      if (match) val = match.result;
                    }
                    extractedValue = String(val ?? '');
                  }

                  const varName = item.variableName || `var_${i}`;
                  extractedData[varName] = extractedValue;
                  stepOutput = {
                    extracted: true,
                    variableName: varName,
                    value: extractedValue,
                    property: prop,
                  };
                  break;
                }

                default:
                  throw new Error(`Unsupported batch action type: ${(item as any).type}`);
              }

              const stepStatus = stepOutput?.status ?? stepOutput?.submitResult?.status;
              stepDispatchedCount = dispatchedCountForOutput(item.type, stepOutput);
              if (stepStatus === 'unknown') {
                itemNetCapture.dispose();
                batchNetCapture.dispose();
                unknownOutcome = true;
                unclassifiedUnknownOutcome = true;
                dispatchedActions += Math.max(1, stepDispatchedCount);
                actionResults.push({
                  actionIndex: i,
                  success: false,
                  status: 'unknown',
                  retry: false,
                  requestDispatched: stepDispatchedCount > 0,
                  error:
                    stepOutput?.message ||
                    stepOutput?.submitResult?.message ||
                    `Action ${i} (${item.type}) outcome unknown`,
                  output: stepOutput,
                });
                interruptedReason = `Action ${i} (${item.type}) outcome unknown; batch stopped to avoid replay`;
                break actionsLoop;
              }

              if (item.waitForNetworkQuiescence) {
                const qTimeout = item.quiescenceTimeoutMs || args.quiescenceTimeoutMs || 2000;
                const netSettled = await waitForNetworkQuiescence(tabId, qTimeout);
                if (typeof stepOutput === 'object' && stepOutput !== null) {
                  stepOutput.networkSettled = netSettled;
                }
              }

              if (item.waitForSettle) {
                const itemSettle = await waitForPageSettle(tabId, {
                  timeoutMs: item.settleTimeoutMs,
                });
                if (typeof stepOutput === 'object' && stepOutput !== null) {
                  stepOutput.settle = itemSettle;
                }
              }

              const itemNetResult = await itemNetCapture.waitForResult();
              if (itemNetResult) {
                stepOutput = {
                  ...(typeof stepOutput === 'object' && stepOutput !== null ? stepOutput : {}),
                  networkResult: itemNetResult,
                };
              }

              actionResults.push({
                actionIndex: i,
                success: stepOutput?.success !== false && stepOutput?.passed !== false,
                status:
                  stepOutput?.success === false || stepOutput?.passed === false
                    ? 'failed'
                    : 'success',
                requestDispatched: stepDispatchedCount > 0,
                output: stepOutput,
              });
              dispatchedActions += stepDispatchedCount;
            } catch (stepErr) {
              itemNetCapture.dispose();
              batchNetCapture.dispose();
              if (stepErr instanceof DialogOpenedError) {
                dialogInterrupt = stepErr;
                const dialogDispatchUnknown = stepErr.dispatchStage !== 'before';
                stepDispatchedCount =
                  isMutatingBatchAction(item.type) && stepErr.dispatchStage !== 'before' ? 1 : 0;
                dispatchedActions += stepDispatchedCount;
                if (dialogDispatchUnknown) unknownOutcome = true;
                actionResults.push({
                  actionIndex: i,
                  success: false,
                  status: dialogDispatchUnknown ? 'unknown' : 'failed',
                  retry: dialogDispatchUnknown ? false : undefined,
                  requestDispatched: stepDispatchedCount > 0,
                  error: `Dialog opened: ${stepErr.dialog.message}`,
                  ...((stepErr as any)?.output ? { output: (stepErr as any).output } : {}),
                });
                interruptedReason = `Dialog opened during action ${i} (${item.type}); batch stopped for handoff`;
                break;
              }
              const uncertain =
                isCdpOutcomeUncertainError(stepErr) ||
                (stepErr as any)?.status === 'unknown' ||
                (stepErr as any)?.status === 'timeout';
              if (uncertain) unknownOutcome = true;
              if (uncertain) unclassifiedUnknownOutcome = true;
              stepDispatchedCount =
                dispatchedCountForOutput(item.type, (stepErr as any)?.output) ||
                (uncertain && isMutatingBatchAction(item.type) ? 1 : 0) ||
                ((stepErr as any)?.committed === true ? 1 : 0);
              dispatchedActions += stepDispatchedCount;
              const locatorDiag = formatLocatorDiagnostics((stepErr as any)?.locator);
              actionResults.push({
                actionIndex: i,
                success: false,
                status: uncertain ? 'unknown' : 'failed',
                retry: uncertain ? false : undefined,
                requestDispatched: stepDispatchedCount > 0,
                error: stepErr instanceof Error ? stepErr.message : String(stepErr),
                ...((stepErr as any)?.output ? { output: (stepErr as any).output } : {}),
                ...locatorDiag,
              });
              interruptedReason = uncertain
                ? `Action ${i} (${item.type}) outcome unknown; batch stopped to avoid replay`
                : `Action ${i} (${item.type}) failed`;
              break;
            }
          }

          let networkSettled: boolean | undefined;
          if (args.waitForNetworkQuiescence) {
            networkSettled = await waitForNetworkQuiescence(
              tabId,
              args.quiescenceTimeoutMs || 2000,
            );
          }

          let batchSettle: any = undefined;
          if (args.waitForSettle) {
            batchSettle = await waitForPageSettle(tabId, { timeoutMs: args.settleTimeoutMs });
          }

          const delta = await captureDeltaIfRequested(tabId, args.includeDelta);

          let currentUrl = initialUrl;
          try {
            const updatedTab = await chrome.tabs.get(tabId);
            currentUrl = updatedTab.url || initialUrl;
          } catch {}
          const urlChanged = Boolean(initialUrl && currentUrl && initialUrl !== currentUrl);

          if (interruptedReason) {
            batchNetCapture.dispose();
          }
          const batchNetResult = await batchNetCapture.waitForResult();

          const postSignature = await executeInPage(
            { tabId },
            'inPageDetectPerceptiveSignature',
            [],
          )
            .then((r) => r?.[0]?.result)
            .catch(() => null);
          const perceptiveDelta = computePerceptiveDelta(preSignature, postSignature);

          const totalCompleted = actionResults.filter((r) => r.success).length;
          const executedActions = actionResults.length;
          const requestedAssertions = actions.filter((action) => action.type === 'assert').length;
          const batchResult: BatchActionResult & {
            spaDriftNotice?: string;
            networkSettled?: boolean;
            perceptiveDelta?: any;
            status?: 'success' | 'partial' | 'unknown';
            partial?: boolean;
            retry?: boolean;
            requestDispatched?: boolean;
            executedActions?: number;
          } = {
            success: totalCompleted === actions.length,
            status: unknownOutcome
              ? 'unknown'
              : totalCompleted === actions.length
                ? 'success'
                : 'partial',
            partial: totalCompleted < actions.length,
            ...(unknownOutcome ? { retry: false } : {}),
            executedActions,
            completedActions: totalCompleted,
            totalActions: actions.length,
            urlChanged,
            previousUrl: initialUrl,
            currentUrl,
            results: actionResults,
            interruptedReason,
            settle: batchSettle,
            spaDriftNotice,
            ...(batchNetResult ? { networkResult: batchNetResult } : {}),
            ...(typeof networkSettled === 'boolean' ? { networkSettled } : {}),
            ...(Object.keys(extractedData).length > 0 ? { extractedData } : {}),
            ...(assertions.length > 0 ? { assertions } : {}),
            ...(delta ? { delta } : {}),
            ...(perceptiveDelta ? { perceptiveDelta } : {}),
            interaction: makeInteractionOutcome(
              unknownOutcome ? 'unknown' : dispatchedActions > 0 ? 'dispatched' : 'not_dispatched',
              requestedAssertions === 0
                ? 'not_requested'
                : assertions.length === requestedAssertions &&
                    assertions.every((assertion) => assertion.passed)
                  ? 'verified'
                  : 'failed',
              interruptedReason,
              dispatchedActions,
            ),
            requestDispatched: dispatchedActions > 0,
            ...(!(totalCompleted === actions.length && !unknownOutcome) ? { retry: false } : {}),
          };

          if (dialogInterrupt) {
            const interruptResult = createDialogInterruptResponse(dialogInterrupt);
            const dialogPayload = JSON.parse((interruptResult.content[0] as any).text);
            const dialogInteraction = dialogPayload.interaction;
            const assertionsIncomplete =
              requestedAssertions > 0 && assertions.length < requestedAssertions;
            const interactionStatus = unknownOutcome
              ? ('unknown' as const)
              : dispatchedActions > 0
                ? ('dispatched' as const)
                : ('not_dispatched' as const);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...batchResult,
                    ...dialogPayload,
                    status: unknownOutcome ? 'unknown' : 'partial',
                    retry: false,
                    requestDispatched:
                      dispatchedActions > 0 || dialogInterrupt.dispatchStage !== 'before',
                    interruptedReason,
                    interaction: {
                      execution: {
                        status: interactionStatus,
                        reason: dialogInteraction?.execution?.reason ?? 'dialog_opened',
                        dispatchedCount: dispatchedActions,
                      },
                      verification: assertionsIncomplete
                        ? {
                            status: 'failed' as const,
                            reason: 'assertions_not_completed',
                          }
                        : (dialogInteraction?.verification ?? {
                            status: 'not_requested' as const,
                          }),
                    },
                  }),
                },
              ],
              isError: false,
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(batchResult),
              },
            ],
            isError: !batchResult.success,
          };
        }),
      );
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      const unknown = mutationAttempted || unclassifiedUnknownOutcome;
      return createInteractionErrorResponse(
        `Error executing chrome_batch_actions: ${error instanceof Error ? error.message : String(error)}`,
        makeInteractionOutcome(
          unknown ? 'unknown' : 'not_dispatched',
          'not_requested',
          unknown ? 'unclassified_batch_error' : 'batch_preparation_failed',
          unknown ? undefined : 0,
        ),
        {
          status: unknown ? 'unknown' : 'blocked',
          requestDispatched: unknown,
          retry: unknown ? false : undefined,
        },
      );
    }
  }
}

export const batchActionsTool = new BatchActionsTool();
