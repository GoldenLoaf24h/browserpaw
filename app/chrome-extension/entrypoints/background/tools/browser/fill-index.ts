import { actionHistoryManager } from '@/utils/action-history-manager';
import { createErrorResponse, type ToolCallContext, ToolResult } from '@/common/tool-handler';
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

export interface FillIndexParams {
  expectedGuard?: unknown[];
  index: number;
  frameId?: number;
  text?: string;
  value?: string;
  clear?: boolean;
  pressEnter?: boolean;
  submit?: boolean;
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
      return createErrorResponse('Index parameter must be a positive 1-based integer');
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
        return createErrorResponse(`No active tab found for ${resolveToolName('fill_index')}`);
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
              retry: status === 'unknown' ? false : undefined,
              committed: fillResult.committed,
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

          const outcome: any = { ...fillResult };

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

          (outcome as any).pressEnter = Boolean(
            args.pressEnter || (args.submit && (outcome as any).submitMethod === 'pressEnter'),
          );
          if (
            !submitOutcomeUnknown &&
            outcome.submitted === true &&
            outcome.submitMethod === 'pressEnter'
          ) {
            (outcome as any).pressEnterDispatched = true;
          } else if (submitOutcomeUnknown) {
            (outcome as any).pressEnterDispatched = false;
          }

          if (
            outcome.submitButtonState?.found &&
            typeof (outcome.submitButtonState as any).index === 'number'
          ) {
            const btnIdx = (outcome.submitButtonState as any).index;
            const btnTxt = outcome.submitButtonState.text || 'Submit';
            (outcome as any).submitButtonIndex = btnIdx;
            (outcome as any).submitButtonText = btnTxt;
            if (!args.submit && !outcome.submitted) {
              (outcome as any).nextActionHint =
                `Submit button detected at index [${btnIdx}] ("${btnTxt}"). 1-Turn Optimal Paradigm: Use ${resolveToolName('fill_index')}({ index: ${args.index}, text: '...', submit: true }), pass pressEnter: true, or use ${resolveToolName('batch_actions')}([{type: 'fill', index: ${args.index}, text: '...'}, {type: 'click', index: ${btnIdx}}]) to eliminate extra turns.`;
            }
          } else if (!args.pressEnter && !args.submit && !outcome.submitted) {
            (outcome as any).nextActionHint =
              `1-Turn Optimal Paradigm: Pass submit: true or pressEnter: true to ${resolveToolName('fill_index')}, or use ${resolveToolName('batch_actions')} to pipeline fill and submit in 1 turn.`;
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
        createErrorResponse(
          `Error executing ${resolveToolName('fill_index')}: ${error instanceof Error ? error.message : String(error)}`,
        ),
        (error as any)?.receipt,
      );
    }
  }
}

export const fillIndexTool = new FillIndexTool();
