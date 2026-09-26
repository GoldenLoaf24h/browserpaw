import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { actionHistoryManager } from '@/utils/action-history-manager';

export interface UndoActionParams {
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

/**
 * Undoes the most recent mutating action performed by the agent on the target tab.
 * Supports reverting form field values and navigating back from mistaken link clicks.
 */
export class UndoLastActionTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.UNDO_LAST_ACTION;

  async execute(args: UndoActionParams = {}): Promise<ToolResult> {
    const sessionId = args.sessionId || args.sessionContext;
    let targetTab: chrome.tabs.Tab;

    try {
      if (typeof args.tabId === 'number') {
        const t = await this.tryGetTab(args.tabId, sessionId);
        if (!t || !t.id) return createErrorResponse(`Tab with ID ${args.tabId} not found`);
        targetTab = t;
      } else {
        targetTab = await this.resolveAffinityTab({ tabId: args.tabId, sessionId });
      }
    } catch (error) {
      return createErrorResponse(
        `Failed to resolve tab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const tabId = targetTab.id;
    if (typeof tabId !== 'number') return createErrorResponse('Invalid target tab ID');

    const lastAction = actionHistoryManager.popAction(tabId);
    if (!lastAction) {
      return createErrorResponse(
        'No undoable action recorded for this tab in current session history.',
      );
    }

    try {
      if (lastAction.type === 'navigate') {
        if (typeof chrome !== 'undefined' && chrome.tabs?.goBack) {
          await chrome.tabs.goBack(tabId);
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  revertedAction: 'navigate',
                  previousUrl: lastAction.prevUrl,
                  message: 'Successfully navigated tab back to previous URL.',
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      }

      if (lastAction.type === 'fill') {
        const revertResult = await this.safeExecuteScript(tabId, {
          target: { tabId },
          func: (targetIdx?: number, targetSelector?: string, restoreValue?: string) => {
            try {
              let el: Element | null = null;
              if (typeof targetIdx === 'number') {
                const isolatedMap =
                  (window as any)[Symbol.for('__browser_use_isolated_index_map__')] ||
                  (window as any)[Symbol.for('BROWSERPAW_ISOLATED_INDEX_MAP')] ||
                  (window as any)[Symbol.for('BROWSERCLAW_ISOLATED_INDEX_MAP')] ||
                  (window as any).__MCP_INDEX_MAP__;
                const raw = isolatedMap?.get(targetIdx);
                el = raw?.deref ? (raw.deref() ?? null) : raw || null;
                if (el && (el as any).isConnected === false) el = null;
                if (!el) {
                  try {
                    el = document.querySelector(`[data-mcp-idx="${targetIdx}"]`);
                  } catch {}
                }
              }
              if (!el && targetSelector) {
                try {
                  el = document.querySelector(targetSelector);
                } catch {}
              }
              if (!el) return { success: false, reason: 'Element no longer in DOM' };

              const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
              const val = restoreValue ?? '';
              inputEl.value = val;
              inputEl.dispatchEvent(new Event('input', { bubbles: true }));
              inputEl.dispatchEvent(new Event('change', { bubbles: true }));
              return { success: true, restoredValue: val };
            } catch (e: any) {
              return { success: false, reason: String(e?.message || e) };
            }
          },
          args: [lastAction.index, lastAction.selector, lastAction.prevValue],
        });

        const outcome = revertResult?.[0]?.result;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: outcome?.success !== false,
                  revertedAction: 'fill',
                  targetIndex: lastAction.index,
                  restoredValue: lastAction.prevValue,
                  message: 'Successfully restored input field to previous value.',
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      }

      return createErrorResponse('Unknown action record type');
    } catch (error) {
      return createErrorResponse(
        `Undo failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const undoLastActionTool = new UndoLastActionTool();
