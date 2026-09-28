import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';

interface GetLinksParams {
  tabId?: number;
  windowId?: number;
  selector?: string;
  sameOriginOnly?: boolean;
  includeEmptyHref?: boolean;
  sessionId?: string;
  sessionContext?: string;
}

/** Extract all crawlable links on the page (absolute URL, text, internal/external, nofollow). */
export class GetLinksTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_LINKS;

  async execute(args: GetLinksParams): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) return createErrorResponse('No active tab found for chrome_get_links');

      const results = await executeInPage(
        { tabId: tab.id },
        'inPageGetLinks',
        [
          {
            selector: args.selector,
            sameOriginOnly: args.sameOriginOnly ?? false,
            includeEmptyHref: args.includeEmptyHref ?? false,
          },
        ],
      );

      const links = results?.[0]?.result ?? [];
      const internal = links.filter((l: any) => l.internal).length;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, total: links.length, internal, external: links.length - internal, links }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_get_links: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const getLinksTool = new GetLinksTool();
