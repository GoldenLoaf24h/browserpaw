import { createErrorResponse, type ToolCallContext } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { formatErrorForAgent, TOOL_SCHEMAS } from 'chrome-mcp-shared';
import * as browserTools from './browser';
import { tabFaviconManager } from './browser/tab-favicon';
import { logUnexpectedToolError } from '@/utils/restricted-url';

const tools = { ...browserTools } as any;
// Only schemas declared in TOOL_SCHEMAS are callable. Some modules export
// internal-only instances — network capture start/stop are invoked directly by
// network-capture.ts, and userscript/inject-script register page listeners
// without being extension bridge entry points.
const declaredToolNames = new Set(TOOL_SCHEMAS.map((t) => t.name));
const toolSchemasMap = new Map(TOOL_SCHEMAS.map((t) => [t.name, t]));
const toolsMap = new Map(
  Object.values(tools)
    .filter((tool: any) => tool && declaredToolNames.has(tool.name))
    .map((tool: any) => [tool.name, tool]),
);

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
  sessionId?: string;
}

/**
 * Handle tool execution
 */
function coerceArgsWithSchema(argsObj: Record<string, any>, properties: Record<string, any>): void {
  if (!argsObj || typeof argsObj !== 'object' || !properties) return;
  for (const key of Object.keys(argsObj)) {
    const val = argsObj[key];
    const prop = properties[key];
    if (!prop) continue;

    if (typeof val === 'string') {
      const trimmed = val.trim();
      const lower = trimmed.toLowerCase();
      if (prop.type === 'boolean') {
        if (lower === 'true') {
          argsObj[key] = true;
        } else if (lower === 'false') {
          argsObj[key] = false;
        }
      } else if (prop.type === 'integer' && /^-?\d+$/.test(trimmed)) {
        argsObj[key] = parseInt(trimmed, 10);
      } else if (prop.type === 'number' && /^-?\d+(\.\d+)?$/.test(trimmed)) {
        argsObj[key] = Number(trimmed);
      }
    } else if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      (prop.type === 'object' || prop.properties)
    ) {
      coerceArgsWithSchema(val, prop.properties || {});
    }
  }
}

export const handleCallTool = async (param: ToolCallParam, context?: ToolCallContext) => {
  try {
    const session = await chrome.storage.session.get('agentControlEnabled');
    if (session?.agentControlEnabled === false) {
      return createErrorResponse(
        'Agent control is currently paused by the user via the extension popup switch. Please enable the switch in the extension popup to resume browser automation.',
      );
    }
  } catch {
    return createErrorResponse(
      'Agent control state could not be verified due to storage failure. Actions are blocked to prevent unauthorized automation.',
    );
  }

  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  const schema = toolSchemasMap.get(param.name);
  const schemaProperties = (schema?.inputSchema as any)?.properties || {};

  try {
    const args = param.args ?? {};
    // Strict schema-driven argument coercion: only coerce when explicitly declared as boolean or number/integer
    coerceArgsWithSchema(args, schemaProperties);

    if (param.sessionId) {
      args.sessionId = param.sessionId;
      args.sessionContext = param.sessionId;
    }

    const result = await tool.execute(args, context);
    let targetTabId = typeof args.tabId === 'number' && args.tabId > 0 ? args.tabId : undefined;
    if (!targetTabId && result && typeof result === 'object') {
      if (typeof (result as any).tabId === 'number') {
        targetTabId = (result as any).tabId;
      } else if (
        Array.isArray((result as any).content) &&
        (result as any).content[0]?.type === 'text'
      ) {
        try {
          const parsed = JSON.parse((result as any).content[0].text);
          if (typeof parsed?.tabId === 'number' && parsed.tabId > 0) {
            targetTabId = parsed.tabId;
          }
        } catch {}
      }
    }
    if (targetTabId) {
      tabFaviconManager.markTabActive(targetTabId);
    }
    return result;
  } catch (error) {
    logUnexpectedToolError(`Tool execution failed for ${param.name}:`, error);
    // Keep a bounded stack so an unexpected failure can be located without
    // reproducing it under a debugger.
    return createErrorResponse(
      error instanceof Error
        ? formatErrorForAgent(error, { context: `Tool ${param.name} failed` })
        : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
};
