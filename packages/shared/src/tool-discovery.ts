import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import { normalizeIncomingToolName, TOOL_SCHEMAS } from './tools';
import { TOOL_CATEGORIES } from './tool-profiles';

export interface ToolDocsParams {
  category?: string;
  names?: string[];
  activateForSession?: boolean;
}

/** Validate the entire request before a transport changes its visible tools. */
export function getToolDocumentation(args: ToolDocsParams): {
  result: { content: TextContent[]; isError: false };
  selection?: string[];
} {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Tool documentation arguments must be an object');
  }
  const { category, names, activateForSession } = args;
  if (activateForSession !== undefined && typeof activateForSession !== 'boolean') {
    throw new Error('activateForSession must be boolean');
  }
  if (category !== undefined && names !== undefined) {
    throw new Error('Use category or names, not both');
  }
  let payload: unknown;
  let selection: string[] | undefined;
  if (category !== undefined) {
    if (
      typeof category !== 'string' ||
      !Object.prototype.hasOwnProperty.call(TOOL_CATEGORIES, category)
    ) {
      throw new Error(`Unknown category. Valid: ${Object.keys(TOOL_CATEGORIES).join(', ')}`);
    }
    const tools = TOOL_CATEGORIES[category].split(' ');
    if (activateForSession) {
      throw new Error(
        `Category activation was replaced by explicit names. Use names: ${JSON.stringify(tools)} with activateForSession: true; this replaces the temporary selection.`,
      );
    }
    payload = {
      category,
      tools: TOOL_SCHEMAS.filter((tool) => tools.includes(tool.name)).map((tool) => ({
        name: tool.name,
        description: tool.description?.split('\n')[0],
      })),
    };
  } else if (names !== undefined) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name)) {
      throw new Error('names must be an array of tool names');
    }
    const normalized = [
      ...new Set(names.map((name) => normalizeIncomingToolName(name).canonicalBackendName)),
    ];
    const unknown = normalized.filter((name) => !TOOL_SCHEMAS.some((tool) => tool.name === name));
    if (unknown.length) throw new Error(`Unknown tools: ${unknown.join(', ')}`);
    payload = { tools: TOOL_SCHEMAS.filter((tool) => normalized.includes(tool.name)) };
    if (activateForSession) selection = normalized;
  } else {
    if (activateForSession) {
      throw new Error('activateForSession requires names; use names: [] to reset the selection');
    }
    payload = {
      categories: Object.fromEntries(
        Object.entries(TOOL_CATEGORIES).map(([name, tools]) => [name, tools.split(' ').length]),
      ),
      usage:
        'Inspect category for names, then names for complete schemas. names + activateForSession:true replaces temporary tools; names:[] resets. Known hidden tools remain callable without expanding the list.',
    };
  }
  return {
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false },
    ...(selection !== undefined ? { selection } : {}),
  };
}

export function getVisibleToolSchemas(
  base: Tool[],
  selection: ReadonlySet<string>,
  jevAvailable: boolean,
): Tool[] {
  const visible = new Set([...base.map((tool) => tool.name), ...selection]);
  return TOOL_SCHEMAS.filter(
    (tool) => visible.has(tool.name) && (tool.name !== 'chrome_act_toward_goal' || jevAvailable),
  );
}

export function sameToolSelection(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name));
}
