import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { DialogOpenedError, createDialogInterruptResponse } from '@/utils/race-cdp';

export { DialogOpenedError, createDialogInterruptResponse };

interface HandleDialogParams {
  action: 'accept' | 'dismiss';
  promptText?: string;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
  dialogId?: string;
}

/**
 * Handle JavaScript dialogs (alert/confirm/prompt) via CDP Page.handleJavaScriptDialog
 */
class HandleDialogTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DIALOG;

  async execute(args: HandleDialogParams): Promise<ToolResult> {
    const { action, promptText } = args || ({} as HandleDialogParams);
    const dialogId = args?.dialogId;
    if (!action || (action !== 'accept' && action !== 'dismiss')) {
      return createErrorResponse('action must be "accept" or "dismiss"');
    }

    let tabId: number | undefined;
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args?.tabId,
        windowId: args?.windowId,
        sessionId: args?.sessionId || args?.sessionContext,
      });
      if (!tab?.id) return createErrorResponse('No active tab found');
      tabId = tab.id!;
      const pending = cdpSessionManager.getPendingDialogs(tabId);
      if (pending.length > 1 && !dialogId) {
        return createErrorResponse(
          `DIALOG_SELECTION_REQUIRED: multiple pending dialogs. Retry with dialogId. Candidates: ${pending
            .map(
              (dialog) =>
                `${dialog.dialogId} (${dialog.type}, ${dialog.sessionId || 'root'}: "${dialog.message}")`,
            )
            .join('; ')}`,
        );
      }
      const handled = dialogId
        ? pending.find((dialog) => dialog.dialogId === dialogId)
        : pending[pending.length - 1];
      if (dialogId && !handled) {
        return createErrorResponse(
          `DIALOG_NOT_FOUND: ${dialogId}. Candidates: ${
            pending
              .map((dialog) => `${dialog.dialogId} (${dialog.sessionId || 'root'})`)
              .join('; ') || 'none'
          }`,
        );
      }

      // Use shared CDP session manager for safe attach/detach with refcount
      await cdpSessionManager.withSession(tabId, 'dialog', async () => {
        await cdpSessionManager.sendFrameCommand(
          tabId!,
          handled?.sessionId,
          'Page.handleJavaScriptDialog',
          {
            accept: action === 'accept',
            promptText: action === 'accept' ? promptText : undefined,
          },
        );
      });

      if (handled) cdpSessionManager.clearPendingDialog(tabId, handled.dialogId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              action,
              promptText: promptText || null,
              handledDialog: handled
                ? {
                    type: handled.type,
                    dialogId: handled.dialogId,
                    message: handled.message,
                    defaultPrompt: handled.defaultPrompt,
                    sessionId: handled.sessionId,
                    openedAgoMs: Date.now() - handled.openedAtMs,
                  }
                : null,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const pending = tabId !== undefined ? cdpSessionManager.getPendingDialogs(tabId) : [];
      const hint =
        pending.length > 0
          ? ` (pending dialogs: ${pending
              .map((dialog) => `${dialog.dialogId} ${dialog.type} "${dialog.message}"`)
              .join('; ')})`
          : '';
      return createErrorResponse(
        `Failed to handle dialog: ${error instanceof Error ? error.message : String(error)}${hint}`,
      );
    }
  }
}

export const handleDialogTool = new HandleDialogTool();
