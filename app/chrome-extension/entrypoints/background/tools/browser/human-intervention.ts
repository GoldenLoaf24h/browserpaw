import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

export interface HumanInterventionParams {
  reason: string;
  timeoutMs?: number;
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

/**
 * Human-in-the-Loop intervention tool.
 * Enables the agent to request real human assistance (SMS 2FA, drag captcha, payment verification).
 * Displays a non-intrusive floating glassmorphism banner in the webpage and waits for human completion.
 */
export class HumanInterventionTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.REQUEST_HUMAN_INTERVENTION;

  async execute(args: HumanInterventionParams): Promise<ToolResult> {
    if (!args || typeof args.reason !== 'string' || !args.reason.trim()) {
      return createErrorResponse('reason is required and must explain what the user needs to do');
    }

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

    const timeoutMs =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
        ? args.timeoutMs
        : 60000;
    const reason = args.reason.trim();
    const startTime = Date.now();

    try {
      // Send banner request to agent-cursor content script
      const requestPromise = chrome.tabs.sendMessage(tabId, {
        type: 'HUMAN_INTERVENTION_REQUEST',
        reason,
        timeoutMs,
      });

      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          // Tell content script to dismiss banner
          try {
            Promise.resolve(
              chrome.tabs.sendMessage(tabId, { type: 'HUMAN_INTERVENTION_CANCEL' }),
            ).catch(() => {});
          } catch {}
          reject(new Error(`Human intervention timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });

      let response: any;
      try {
        response = (await Promise.race([requestPromise, timeoutPromise])) as any;
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
      if (response && (response.ok === false || response.cancelled)) {
        const cancelReason =
          (typeof response.reason === 'string' && response.reason.trim()) ||
          (typeof response.error === 'string' && response.error.trim()) ||
          'cancelled';
        return createErrorResponse(`Human intervention not completed: ${cancelReason}`);
      }
      const durationMs = Date.now() - startTime;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                resolved: true,
                action: response?.action || 'resumed_by_user',
                durationSeconds: Math.round(durationMs / 1000),
                message: 'Human user completed the requested action. Agent automation resumed.',
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
        `Human intervention not completed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const humanInterventionTool = new HumanInterventionTool();
