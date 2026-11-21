import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';

export interface GetMarkdownParams {
  includeLinks?: boolean;
  /** Content-only mode: strip nav/header/footer/aside/form and scope to the main region */
  fit?: boolean;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export class GetMarkdownTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_MARKDOWN;

  async execute(args: GetMarkdownParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse('No active tab found for chrome_get_markdown');
      }

      const results = await executeInPage<string>({ tabId: tab.id }, 'inPageExtractMarkdown', [
        args.includeLinks ?? true,
        args.fit ?? false,
      ]);

      const rawResult = results?.[0]?.result as unknown;
      if (
        rawResult &&
        typeof rawResult === 'object' &&
        (rawResult as { isErrorPage?: boolean }).isErrorPage
      ) {
        const errMessage =
          (rawResult as { error?: string }).error || 'Frame is showing Chrome error page';
        return createErrorResponse(`Cannot extract markdown from error page: ${errMessage}`);
      }

      const markdown =
        typeof rawResult === 'string'
          ? rawResult
          : rawResult == null
            ? ''
            : JSON.stringify(rawResult);

      return {
        content: [
          {
            type: 'text',
            text: markdown,
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_get_markdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const getMarkdownTool = new GetMarkdownTool();
