import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { getToolDocumentation, TOOL_NAMES, type ToolDocsParams } from 'chrome-mcp-shared';

export class ToolDocsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TOOL_DOCS;

  async execute(args: ToolDocsParams): Promise<ToolResult> {
    try {
      return getToolDocumentation(args).result;
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}

export const toolDocsTool = new ToolDocsTool();
