import { actionHistoryManager } from '@/utils/action-history-manager';
import { type ToolCallContext, ToolResult } from '@/common/tool-handler';
import { throwIfAborted } from '@/utils/action-abort';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { computePerceptiveDelta } from './dom-indexer';
import { waitForPageSettle } from '@/utils/action-watchdog';
import {
  raceCdp,
  DialogOpenedError,
  createDialogInterruptResponse,
  StalePageError,
  createTargetOccludedResponse,
} from '@/utils/race-cdp';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import {
  ensureSnapshotBaseline,
  captureChainedSnapshot,
  captureGoalObservation,
} from '@/utils/delta-helper';
import { tabFaviconManager } from './tab-favicon';
import { computeHumanizedPoints } from '@/utils/mouse-trajectory';
import { performPhysicalFill } from './fill-core';
import { withActionReceipt, attachActionReceipt } from '@/utils/action-receipt';
import {
  createInteractionErrorResponse,
  inferFillInteraction,
  makeInteractionOutcome,
} from '@/utils/interaction-outcome';

export interface FillIndexParams {
  expectedGuard?: unknown[];
  index: number;
  frameId?: number;
  text?: string;
  value?: string;
  clear?: boolean;
  pressEnter?: boolean;
  submit?: boolean;
  submitTarget?: {
    index?: number;
    frameId?: number;
    ref?: string | number;
    selector?: string;
    text?: string;
    role?: string;
    label?: string;
    exact?: boolean;
  };
  tabId?: number;
  windowId?: number;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  includeDelta?: boolean;
  sessionId?: string;
  sessionContext?: string;
}

export class FillIndexTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL_INDEX;

  async execute(args: FillIndexParams, context?: ToolCallContext): Promise<ToolResult> {
    if (typeof args?.index !== 'number' || args.index <= 0) {
      return createInteractionErrorResponse(
        'Index parameter must be a positive 1-based integer',
        makeInteractionOutcome('not_dispatched', 'not_requested', 'invalid_index', 0),
        { status: 'blocked', requestDispatched: false },
      );
    }
    if (args.submit === true && !args.submitTarget) {
      return createInteractionErrorResponse(
        'submit:true requires an explicit submitTarget with a resolved field or control; no field mutation was dispatched',
        makeInteractionOutcome('not_dispatched', 'not_requested', 'missing_submit_target', 0),
        { status: 'blocked', requestDispatched: false, submitted: false },
      );
    }
    if (args.submit === true && args.pressEnter === true) {
      return createInteractionErrorResponse(
        'pressEnter:true and submit:true are conflicting submit actions; no field mutation was dispatched',
        makeInteractionOutcome('not_dispatched', 'not_requested', 'conflicting_submit_actions', 0),
        { status: 'blocked', requestDispatched: false, submitted: false },
      );
    }

    const textToFill = args.text ?? args.value ?? '';

    // D3: snapshot BEFORE resolveAffinityTab — its active-tab fallback binds
    // the fallback tab, so a post-resolution check would always see a
    // "valid" binding and never warn (verified by live testing).
    const sidForWarning = args.sessionId || args.sessionContext;
    const hadPreexistingBinding = sessionTabAffinity.hasBinding(sidForWarning);

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createInteractionErrorResponse(
          `No active tab found for ${resolveToolName('fill_index')}`,
          makeInteractionOutcome('not_dispatched', 'not_requested', 'no_active_tab', 0),
          { status: 'blocked', requestDispatched: false },
        );
      }
      const targetTabId: number = tab.id;

      return await sessionTabAffinity.runSerialized(targetTabId, () =>
        withActionReceipt(targetTabId, async () => {
          throwIfAborted(context?.signal, 'before fill index');
          const previousUrl = tab.url || '';
          tabFaviconManager.markTabActive(targetTabId);

          const preSignature = await executeInPage(
            { tabId: targetTabId },
            'inPageDetectPerceptiveSignature',
            [],
          )
            .then((r) => r?.[0]?.result)
            .catch(() => null);

          await ensureSnapshotBaseline(
            targetTabId,
            !args.expectedGuard && args.includeDelta !== false,
          );

          // D3 (TESTING-NOTES #19): surface active-tab fallback in the response.
          const fillIdxAffinityWarning =
            typeof args.tabId === 'number'
              ? undefined
              : hadPreexistingBinding
                ? undefined
                : `input routed to active tab (tabId=${targetTabId}); pass explicit tabId to target another tab`;

          const fillResult = await performPhysicalFill({
            expectedGuard: args.expectedGuard,
            tabId: targetTabId,
            target: args.index,
            frameId: args.frameId,
            text: textToFill,
            clear: args.clear,
            pressEnter: args.pressEnter,
            submit: args.submit,
            submitTarget: args.submitTarget,
            taskId: context?.taskId,
            sessionId: args.sessionId,
            sessionContext: args.sessionContext,
            signal: context?.signal,
            deadlineAt: (args as any)?.deadlineAt ?? (args as any)?.deadline,
          });

          if (!fillResult.success || fillResult.committed === false) {
            const status =
              fillResult.status === 'unknown' || fillResult.submitResult?.status === 'unknown'
                ? 'unknown'
                : fillResult.status === 'timeout'
                  ? 'timeout'
                  : 'failed';
            const payload = {
              ...fillResult,
              success: false,
              status,
              ...(fillResult.committed === true
                ? { partial: true, completedSteps: 1, failedStep: 'follow_up_action' }
                : {}),
              retry: status === 'unknown' ? false : undefined,
              committed: fillResult.committed,
              interaction: fillResult.interaction ?? inferFillInteraction(fillResult),
              error:
                fillResult.error ||
                fillResult.diagnostics ||
                `Failed to commit text into element with index [${args.index}]`,
            };
            return attachActionReceipt(
              {
                content: [{ type: 'text', text: JSON.stringify(payload) }],
                isError: true,
              },
              fillResult.receipt,
            );
          }

          const outcome: any = {
            ...fillResult,
            interaction: fillResult.interaction ?? inferFillInteraction(fillResult),
          };

          const shouldWaitSettle =
            args.waitForSettle ||
            (args.pressEnter === true && args.waitForSettle !== false) ||
            (args.submit === true && args.waitForSettle !== false);
          if (shouldWaitSettle) {
            const settleResult = await waitForPageSettle(targetTabId, {
              timeoutMs: args.settleTimeoutMs,
              action: { kind: 'fill', node: args.index },
            });
            (outcome as any).settle = settleResult;
          }

          if (fillIdxAffinityWarning) {
            (outcome as any).affinityWarning = fillIdxAffinityWarning;
          }

          const observation =
            !args.expectedGuard && args.includeDelta !== false
              ? await captureChainedSnapshot(targetTabId, previousUrl, {
                  maxItems: 10,
                  delayMs: 80,
                  frameId: args.frameId,
                })
              : undefined;
          const chainedSnapshot = observation?.summary;
          const delta = args.includeDelta === true ? observation?.delta : undefined;
          if (chainedSnapshot) {
            (outcome as any).chainedSnapshot = chainedSnapshot;
          }
          if (delta) {
            (outcome as any).delta = delta;
          }

          let currentUrl = previousUrl;
          try {
            const updatedTab = await chrome.tabs.get(targetTabId);
            currentUrl = updatedTab.url || previousUrl;
          } catch {}
          const urlChanged = Boolean(previousUrl && currentUrl && previousUrl !== currentUrl);

          // Submission belongs to fill-core; an unchanged URL does not prove Enter failed.
          const submitOutcomeUnknown =
            outcome.submitResult?.status === 'unknown' || outcome.status === 'unknown';

          (outcome as any).urlChanged = urlChanged;
          (outcome as any).previousUrl = previousUrl;
          (outcome as any).currentUrl = currentUrl;

          const postSignature = await executeInPage(
            { tabId: targetTabId },
            'inPageDetectPerceptiveSignature',
            [],
          )
            .then((r) => r?.[0]?.result)
            .catch(() => null);
          const perceptiveDelta = computePerceptiveDelta(preSignature, postSignature);
          if (perceptiveDelta) {
            (outcome as any).perceptiveDelta = perceptiveDelta;
          }
          if (args.expectedGuard) {
            outcome.goalObservation = await captureGoalObservation(
              targetTabId,
              args.sessionId || args.sessionContext,
            );
          }

          (outcome as any).pressEnter = args.pressEnter === true;
          if (args.pressEnter === true) {
            (outcome as any).pressEnterDispatched =
              outcome.pressEnterDispatched === true &&
              !submitOutcomeUnknown &&
              outcome.submitResult?.status !== 'blocked';
          }

          if (
            outcome.submitButtonState?.found &&
            typeof (outcome.submitButtonState as any).index === 'number'
          ) {
            const btnIdx = (outcome.submitButtonState as any).index;
            const btnTxt = outcome.submitButtonState.text;
            (outcome as any).submitButtonIndex = btnIdx;
            if (btnTxt) {
              (outcome as any).submitButtonText = btnTxt;
            }
          }

          const seen = new WeakSet();
          const safeText = JSON.stringify(outcome, (_key, value) => {
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return '[Circular]';
              seen.add(value);
            }
            return value;
          });

          return {
            content: [
              {
                type: 'text',
                text: safeText,
              },
            ],
            isError: false,
          };
        }),
      );
    } catch (error) {
      if ((error as any)?.status === 'blocked' && (error as any)?.requestDispatched === false) {
        return attachActionReceipt(
          {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  status: 'blocked',
                  requestDispatched: false,
                  interaction: makeInteractionOutcome(
                    'not_dispatched',
                    'not_requested',
                    'fill_preparation_failed',
                    0,
                  ),
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          },
          (error as any)?.receipt,
        );
      }
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      if (error instanceof StalePageError || (error as any)?.code === 'target_occluded') {
        return createTargetOccludedResponse(error as any);
      }
      return attachActionReceipt(
        createInteractionErrorResponse(
          `Error executing ${resolveToolName('fill_index')}: ${error instanceof Error ? error.message : String(error)}`,
          makeInteractionOutcome('unknown', 'not_requested', 'unclassified_fill_error'),
          { status: 'unknown', retry: false },
        ),
        (error as any)?.receipt,
      );
    }
  }
}

export const fillIndexTool = new FillIndexTool();
