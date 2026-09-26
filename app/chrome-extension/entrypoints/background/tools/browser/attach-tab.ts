import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import type { AttachTabParams, DetachTabParams } from 'chrome-mcp-shared';

/**
 * Attach Tab Tool
 *
 * Explicitly attaches CDP debugger and session affinity to a specific tab or the user's active tab.
 * Required by P0-1: attaching user's active tab requires explicit invocation with documented side effects.
 */
export class AttachTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.ATTACH_TAB;

  async execute(args: AttachTabParams = {}): Promise<ToolResult> {
    try {
      const sessionId = args.sessionId || args.sessionContext;
      let targetTab: chrome.tabs.Tab;

      if (typeof args.tabId === 'number') {
        const t = await this.tryGetTab(args.tabId, sessionId);
        if (!t || !t.id) {
          return createErrorResponse(`Tab with ID ${args.tabId} not found`);
        }
        targetTab = t;
      } else {
        // User foreground active tab
        targetTab = await this.getActiveTabOrThrow();
      }

      const tabId = targetTab.id!;

      // Attach CDP debugger session
      await cdpSessionManager.attachDebugger(tabId);

      // Bind affinity if sessionId provided
      if (sessionId) {
        sessionTabAffinity.setAffinity(sessionId, tabId);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Successfully attached debugger to tab ID: ${tabId}`,
                tabId,
                url: targetTab.url,
                title: targetTab.title,
                warning:
                  "ATTACHED TO USER TAB: Chrome displays a yellow debugging banner ('browserpaw is debugging this browser'). Any navigation, DOM interaction, or closing of this tab directly affects the user's session.",
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Failed to attach tab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Detach Tab Tool
 *
 * Explicitly detaches CDP debugger and releases session affinity.
 */
export class DetachTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DETACH_TAB;

  async execute(args: DetachTabParams = {}): Promise<ToolResult> {
    try {
      const sessionId = args.sessionId || args.sessionContext;
      let tabId = args.tabId;

      if (typeof tabId !== 'number' && sessionId) {
        tabId = sessionTabAffinity.getAffinity(sessionId);
      }

      if (typeof tabId !== 'number') {
        const active = await this.getActiveTabInWindow();
        tabId = active?.id;
      }

      if (typeof tabId !== 'number') {
        return createErrorResponse('No target tab ID identified to detach');
      }

      // Detach debugger session
      await cdpSessionManager.detachDebugger(tabId);

      // Release session affinity
      if (sessionId) {
        sessionTabAffinity.removeAffinity(sessionId);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Successfully detached debugger and released session affinity for tab ID: ${tabId}`,
                tabId,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Failed to detach tab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const attachTabTool = new AttachTabTool();
export const detachTabTool = new DetachTabTool();
