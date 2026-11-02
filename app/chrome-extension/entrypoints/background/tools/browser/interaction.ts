import type { ToolCallContext, ToolResult } from '@/common/tool-handler';
import { throwIfAborted } from '@/utils/action-abort';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, type UnifiedLocatorResult } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { resolveTargetLocation, formatLocatorDiagnostics } from './unified-locator';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import type { PolymorphicCoordinate } from '@/utils/coordinate-parser';
import { attachActionReceipt } from '@/utils/action-receipt';
import {
  createInteractionErrorResponse,
  makeInteractionOutcome,
} from '@/utils/interaction-outcome';
import { interactIndexTool } from './interact-index';
import { performPhysicalFill } from './fill-core';
import { logUnexpectedToolError } from '@/utils/restricted-url';

/**
 * D3 (TESTING-NOTES #19): resolveAffinityTab falls back to the user's ACTIVE
 * tab when no explicit tabId and no session binding matches. The agent never
 * knows its input landed on the page the user was viewing. Resolve the same
 * way here and surface a warning when the fallback path was taken.
 */
async function resolveAffinityWarning(
  args: { tabId?: number; sessionId?: string; sessionContext?: string },
  resolvedTabId: number,
  hadPreexistingBinding: boolean,
): Promise<string | undefined> {
  if (typeof args.tabId === 'number') return undefined;
  const sid = args.sessionId || args.sessionContext;
  // The fallback binding was established by resolveAffinityTab itself; only
  // a binding that existed BEFORE the call proves the session was intentionally
  // pinned to this tab.
  if (!hadPreexistingBinding) {
    return `input routed to active tab (tabId=${resolvedTabId}); pass explicit tabId to target another tab`;
  }
  if (!sid) {
    return `input routed to active tab (tabId=${resolvedTabId}); pass explicit tabId to target another tab`;
  }
  return undefined;
}

function addResultWarning(
  result: ToolResult,
  warning?: string,
  locator?: UnifiedLocatorResult,
): ToolResult {
  if (!warning && !locator) return result;
  const resolution = locator ? formatLocatorDiagnostics(locator) : {};
  const block = result.content.at(-1);
  if (block?.type !== 'text') return result;
  try {
    const parsed = JSON.parse(block.text);
    block.text = JSON.stringify({
      ...parsed,
      ...resolution,
      ...(warning ? { affinityWarning: warning } : {}),
    });
  } catch {
    block.text = JSON.stringify({
      success: !result.isError,
      text: block.text,
      ...resolution,
      ...(warning ? { affinityWarning: warning } : {}),
    });
  }
  return result;
}

function toInteractModifiers(modifiers?: ClickToolParams['modifiers']): string[] | undefined {
  if (!modifiers) return undefined;
  const values = [
    modifiers.altKey ? 'Alt' : undefined,
    modifiers.ctrlKey ? 'Control' : undefined,
    modifiers.metaKey ? 'Meta' : undefined,
    modifiers.shiftKey ? 'Shift' : undefined,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values : undefined;
}

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  exact?: boolean;
  label?: string;
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__mcpElementMap)
  index?: number; // Compact 1-based index from chrome_read_dom
  text?: string; // Match target element by visible text
  role?: string; // Match target element by ARIA role
  coordinate?: Coordinates | PolymorphicCoordinate; // Preferred unified coordinate parameter
  coordinates?: Coordinates | PolymorphicCoordinate; // Alias coordinates to click at (x, y relative to viewport)
  coordinateSpace?: 'viewport' | 'screenshot'; // Space of coordinate/coordinates (default: viewport)
  captureId?: string; // Screenshot identity required when coordinate fallback uses screenshot space
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  sessionId?: string; // session affinity identifier
  sessionContext?: string;
  /** Absolute epoch-ms deadline supplied by a compound caller. */
  expectedDeadlineAt?: number;
  /** Alias accepted by the common locator/executor path. */
  deadlineAt?: number;
}

function blockedInteraction(message: string, reason: string): ToolResult {
  return createInteractionErrorResponse(
    message,
    makeInteractionOutcome('not_dispatched', 'not_requested', reason, 0),
    { status: 'blocked', requestDispatched: false },
  );
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams, context?: ToolCallContext): Promise<ToolResult> {
    const coordinates = args.coordinate || args.coordinates;
    const {
      selector,
      selectorType = 'css',
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      modifiers,
    } = args;
    const expectedDeadlineAt = args.expectedDeadlineAt ?? args.deadlineAt;

    const hasRef = Boolean(args.ref || args.index !== undefined);
    const hasSelector = Boolean(selector);
    const hasTextOrRole = Boolean(args.text || args.role || args.label);
    const hasCoords = Boolean(coordinates);

    if (!hasRef && !hasSelector && !hasTextOrRole && !hasCoords) {
      return blockedInteraction(
        ERROR_MESSAGES.INVALID_PARAMETERS +
          ': Provide ref, index, selector, text/role, or coordinate',
        'invalid_target',
      );
    }

    let actionAttempted = false;
    try {
      throwIfAborted(context?.signal, 'before click');
      const clickHadPreexistingBinding = sessionTabAffinity.hasBinding(
        args.sessionId || (args as any).sessionContext,
      );
      // Resolve tab
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || (args as any).sessionContext,
      });
      if (!tab.id) {
        return blockedInteraction(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
          'no_active_tab',
        );
      }
      const tabId = tab.id;

      const clickAffinityWarning = await resolveAffinityWarning(
        args,
        tabId,
        clickHadPreexistingBinding,
      );

      let finalRef = args.ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tabId,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return blockedInteraction(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
              'xpath_resolution_failed',
            );
          }
        } catch (error) {
          return blockedInteraction(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
            'xpath_resolution_failed',
          );
        }
      }

      // Unified locator & CDP Input click dispatch (P1-4)
      const loc = await resolveTargetLocation(tabId, {
        ref: finalRef,
        index: args.index,
        selector: finalSelector,
        selectorType,
        text: args.text,
        exact: args.exact,
        label: args.label,
        role: args.role,
        coordinate: coordinates,
        coordinateSpace: (args as any).coordinateSpace,
        captureId: (args as any).captureId,
        frameId,
        operation: 'click',
        taskId: context?.taskId,
        signal: context?.signal,
        deadlineAt: expectedDeadlineAt,
      });

      if (!loc.success) {
        return addResultWarning(
          blockedInteraction(loc.error || 'Target not found', 'target_not_found'),
          clickAffinityWarning,
          loc,
        );
      }

      throwIfAborted(context?.signal, 'before click action');
      const action = args.double ? 'double_click' : button === 'right' ? 'right_click' : 'click';
      const usedCoordinateFallback = loc.resolutionPath === 'coordinate';
      actionAttempted = true;
      const delegated = await interactIndexTool.execute(
        {
          tabId,
          ...(usedCoordinateFallback
            ? {
                coordinate: coordinates,
                coordinateSpace: (args as any).coordinateSpace,
                captureId: (args as any).captureId,
              }
            : {
                index: loc.index,
                coordinate: loc.index === undefined ? { x: loc.x, y: loc.y } : undefined,
                frameId: loc.index === undefined ? undefined : (loc.frameId ?? frameId),
              }),
          action,
          button: button ?? 'left',
          modifiers: toInteractModifiers(modifiers),
          waitForSettle: waitForNavigation === true,
          settleTimeoutMs: waitForNavigation ? timeout : undefined,
          includeDelta: false,
          ...(typeof expectedDeadlineAt === 'number' ? { expectedDeadlineAt } : {}),
          sessionId: args.sessionId,
          sessionContext: args.sessionContext,
        },
        context,
      );
      return addResultWarning(delegated, clickAffinityWarning, loc);
    } catch (error) {
      logUnexpectedToolError('Error in click operation:', error);
      const status = actionAttempted ? 'unknown' : 'blocked';
      return attachActionReceipt(
        createInteractionErrorResponse(
          `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
          makeInteractionOutcome(
            actionAttempted ? 'unknown' : 'not_dispatched',
            'not_requested',
            actionAttempted ? 'dispatch_unknown' : 'click_preparation_failed',
            actionAttempted ? 1 : 0,
          ),
          {
            status,
            requestDispatched: actionAttempted,
            retry: actionAttempted ? false : true,
          },
        ),
        (error as any)?.receipt,
      );
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  exact?: boolean;
  label?: string;
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  index?: number; // Compact 1-based index from chrome_read_dom
  targetText?: string; // Target element by label or visible text
  role?: string; // Target element by ARIA role
  coordinate?: Coordinates | PolymorphicCoordinate; // Preferred unified coordinate parameter
  coordinates?: Coordinates | PolymorphicCoordinate; // Alias coordinates to click and focus before typing
  coordinateSpace?: 'viewport' | 'screenshot'; // Space of coordinate/coordinates (default: viewport)
  captureId?: string; // Screenshot identity required when coordinate fallback uses screenshot space
  // Unified text parameter (alias for value)
  text?: string;
  // Accept string | number | boolean for broader form input coverage
  value?: string | number | boolean;
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  sessionId?: string; // session affinity identifier
  sessionContext?: string;
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams, context?: ToolCallContext): Promise<ToolResult> {
    const coordinates = args.coordinate || args.coordinates;
    const value = args.value !== undefined ? args.value : args.text;
    const targetText = args.targetText || (args.value !== undefined ? args.text : undefined);
    const { selector, selectorType = 'css', ref, frameId } = args;

    const hasRef = Boolean(ref || args.index !== undefined);
    const hasSelector = Boolean(selector);
    const hasTargetTextOrRole = Boolean(targetText || args.role || args.label);
    const hasCoords = Boolean(coordinates);

    if (!hasRef && !hasSelector && !hasTargetTextOrRole && !hasCoords) {
      return blockedInteraction(
        ERROR_MESSAGES.INVALID_PARAMETERS +
          ': Provide ref, index, selector, targetText/role, or coordinate',
        'invalid_target',
      );
    }

    if (value === undefined || value === null) {
      return blockedInteraction(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Text or value must be provided',
        'missing_value',
      );
    }

    let actionAttempted = false;
    try {
      throwIfAborted(context?.signal, 'before fill');
      const fillHadPreexistingBinding = sessionTabAffinity.hasBinding(
        args.sessionId || (args as any).sessionContext,
      );
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || (args as any).sessionContext,
      });
      if (!tab.id) {
        return blockedInteraction(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
          'no_active_tab',
        );
      }
      const tabId = tab.id;

      const fillAffinityWarning = await resolveAffinityWarning(
        args,
        tabId,
        fillHadPreexistingBinding,
      );

      let finalRef = ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tabId,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return blockedInteraction(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
              'xpath_resolution_failed',
            );
          }
        } catch (error) {
          return blockedInteraction(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
            'xpath_resolution_failed',
          );
        }
      }

      // Unified locator & CDP Input fill dispatch (P1-4)
      const loc = await resolveTargetLocation(tabId, {
        ref: finalRef,
        index: args.index,
        selector: finalSelector,
        selectorType,
        targetText,
        exact: args.exact,
        label: args.label,
        text: targetText,
        role: args.role,
        coordinate: coordinates,
        coordinateSpace: (args as any).coordinateSpace,
        captureId: (args as any).captureId,
        frameId,
        operation: 'fill',
        taskId: context?.taskId,
        signal: context?.signal,
        deadlineAt: (args as any)?.deadlineAt ?? (args as any)?.deadline,
      });

      if (!loc.success) {
        return addResultWarning(
          blockedInteraction(loc.error || 'Target not found', 'target_not_found'),
          fillAffinityWarning,
          loc,
        );
      }

      throwIfAborted(context?.signal, 'before fill action');
      actionAttempted = true;
      const fillResult = await performPhysicalFill({
        tabId,
        target: loc.index ?? '',
        coordinate:
          loc.index === undefined ? { x: Math.round(loc.x), y: Math.round(loc.y) } : undefined,
        frameId: loc.index === undefined ? frameId : (loc.frameId ?? frameId),
        text: String(value),
        clear: true,
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
        return attachActionReceipt(
          {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...fillResult,
                  success: false,
                  status,
                  retry: status === 'unknown' ? false : undefined,
                  error:
                    fillResult.error ||
                    fillResult.diagnostics ||
                    `Failed to fill element [${loc.index}]`,
                  ...formatLocatorDiagnostics(loc),
                }),
              },
            ],
            isError: true,
          },
          fillResult.receipt,
        );
      }

      const payload = {
        ...fillResult,
        ...formatLocatorDiagnostics(loc),
        ...(fillAffinityWarning ? { affinityWarning: fillAffinityWarning } : {}),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      };
    } catch (error) {
      logUnexpectedToolError('Error in fill operation:', error);
      const status = actionAttempted ? 'unknown' : 'blocked';
      return attachActionReceipt(
        createInteractionErrorResponse(
          `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
          makeInteractionOutcome(
            actionAttempted ? 'unknown' : 'not_dispatched',
            'not_requested',
            actionAttempted ? 'dispatch_unknown' : 'fill_preparation_failed',
            actionAttempted ? 1 : 0,
          ),
          {
            status,
            requestDispatched: actionAttempted,
            retry: actionAttempted ? false : true,
          },
        ),
        (error as any)?.receipt,
      );
    }
  }
}

export const fillTool = new FillTool();
