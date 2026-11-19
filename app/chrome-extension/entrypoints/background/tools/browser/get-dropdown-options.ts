import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';

export interface GetDropdownOptionsParams {
  index?: number;
  selector?: string;
  frameId?: number;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export class GetDropdownOptionsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_DROPDOWN_OPTIONS;

  async execute(args: GetDropdownOptionsParams): Promise<ToolResult> {
    if ((!args?.index || args.index <= 0) && !args?.selector) {
      return createErrorResponse(
        'Either index or selector must be provided to get dropdown options',
      );
    }

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse('No active tab found for chrome_get_dropdown_options');
      }

      const results = await executeInPage(
        args.frameId === undefined
          ? { tabId: tab.id }
          : { tabId: tab.id, frameIds: [args.frameId] },
        'inPageExtractDropdownOptions',
        [args.index, args.selector],
      );

      let outcome = results?.[0]?.result;
      if (args.frameId === undefined && (!outcome || !outcome.success)) {
        const frameResults = await executeInPage(
          { tabId: tab.id, allFrames: true },
          'inPageExtractDropdownOptions',
          [args.index, args.selector],
        );
        const matches = frameResults.filter((r) => r.result?.success);
        if (matches.length > 1)
          return createErrorResponse('Dropdown matches multiple frames. Specify --frame.');
        if (matches.length === 1) outcome = matches[0].result;
      }

      if (!outcome || !outcome.success) {
        return createErrorResponse(outcome?.error || 'Failed to extract dropdown options');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(outcome),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_get_dropdown_options: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const getDropdownOptionsTool = new GetDropdownOptionsTool();
