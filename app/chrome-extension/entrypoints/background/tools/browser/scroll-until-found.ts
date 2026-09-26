import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  type ScrollUntilFoundOptions,
  type ScrollUntilFoundResult,
} from 'chrome-mcp-shared';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { executeInPage } from './in-page-engine';

export interface ScrollUntilFoundParams {
  query?: string;
  selector?: string;
  isRegex?: boolean;
  maxSteps?: number;
  stepPx?: number;
  direction?: 'down' | 'up';
  timeoutMs?: number;
  containerSelector?: string;
  settleMs?: number;
  scrollDelayMs?: number;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export class ScrollUntilFoundTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCROLL_UNTIL_FOUND;

  async execute(args: ScrollUntilFoundParams): Promise<ToolResult> {
    const query = args?.query?.trim();
    const selector = args?.selector?.trim();

    if (!query && !selector) {
      return createErrorResponse(
        'Either query or selector is required for chrome_scroll_until_found',
      );
    }

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });

      if (!tab?.id) {
        return createErrorResponse('No active tab found for chrome_scroll_until_found');
      }

      const tabId = tab.id;
      const timeoutMs = Math.min(Math.max(1000, args.timeoutMs ?? 15000), 60000);

      const inPageOptions: ScrollUntilFoundOptions = {
        query: args.query,
        selector: args.selector,
        isRegex: args.isRegex,
        maxSteps: args.maxSteps,
        stepPx: args.stepPx,
        direction: args.direction,
        timeoutMs,
        containerSelector: args.containerSelector,
        settleMs: args.settleMs ?? args.scrollDelayMs,
      };

      const results = await executeInPage<ScrollUntilFoundResult>(
        { tabId },
        'inPageScrollUntilFound',
        [inPageOptions],
        timeoutMs + 3000,
      );

      const res = results?.[0]?.result;
      if (!res) {
        return createErrorResponse('Failed to execute scroll_until_found in active tab');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res, null, 2),
          },
        ],
        isError: !res.found,
      };
    } catch (error) {
      return createErrorResponse(
        'Error executing chrome_scroll_until_found: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

export const scrollUntilFoundTool = new ScrollUntilFoundTool();
