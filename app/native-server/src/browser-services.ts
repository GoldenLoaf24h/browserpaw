import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';
import {
  BrowserTaskManager,
  tryParseCallResult,
  withStructuredPayload,
  type BrowserCall,
} from './browser-tasks';
import { BrowserSkillStore, type SkillDefinition } from './browser-skills';
import { clearSemanticTask } from './jev/semantic-match';

function resolveBundledRecipesDir(): string {
  const candidates = [
    path.join(__dirname, 'recipes'),
    path.join(__dirname, '..', 'dist', 'recipes'),
    path.resolve(__dirname, '..', '..', '..', 'skills', 'browserpaw', 'assets', 'recipes'),
  ];
  const directory = candidates.find((candidate) => fs.existsSync(candidate));
  if (!directory) throw new Error('Bundled BrowserPaw recipes are missing');
  return directory;
}

export function createBrowserServices(call: BrowserCall, storageDir?: string) {
  const validator = new AjvJsonSchemaValidator();
  const tasks = new BrowserTaskManager({ call, storageDir });
  const requireTask = async (
    action: string,
    args: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ) => {
    const result = await tasks.execute({ action, ...args }, sessionId, signal);
    if (['finish', 'cancel'].includes(action) && typeof args.taskId === 'string')
      clearSemanticTask(args.taskId);
    if (!result.ok || !result.task) {
      const { content, ...state } = result;
      throw Object.assign(new Error(result.error || 'Task operation returned no task'), state, {
        result: withStructuredPayload(content ? { content } : undefined, state),
      });
    }
    return result.task;
  };
  const skills = new BrowserSkillStore({
    ...(storageDir ? { root: path.join(storageDir, 'skills') } : {}),
    browser: {
      start: async (name, sessionId, signal) => ({
        taskId: (await requireTask('start', { name }, sessionId, signal)).id,
      }),
      open: async (taskId, url, sessionId, signal) => {
        const task = await requireTask('open', { taskId, url }, sessionId, signal);
        if (!task.currentTabId) throw new Error('Opened task returned no current page');
        return { tabId: task.currentTabId };
      },
      call: (taskId, name, args, sessionId, signal) =>
        tasks.callTool(taskId, name, args, sessionId, signal),
      finish: async (taskId, sessionId) => {
        await requireTask('finish', { taskId }, sessionId);
      },
    },
  });
  let ready: Promise<void> | undefined;

  async function execute(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const schema = TOOL_SCHEMAS.find((tool) => tool.name === name)?.inputSchema;
    if (!schema) throw new Error(`Unknown Native browser service: ${name}`);
    const publicArgs = { ...args };
    for (const internal of ['sessionId', 'sessionContext', '_meta', 'definitionHash'])
      delete publicArgs[internal];
    const valid = validator.getValidator(schema)(publicArgs);
    if (!valid.valid) throw new Error(`Invalid ${name} arguments: ${valid.errorMessage}`);
    let value: unknown;
    if (name === 'chrome_task') {
      const taskResult = await tasks.execute(args, sessionId, signal);
      if (['finish', 'cancel'].includes(String(args.action)) && typeof args.taskId === 'string')
        clearSemanticTask(args.taskId);
      if (!taskResult.ok) {
        const { content, ...state } = taskResult;
        return withStructuredPayload(content ? { content } : undefined, state);
      }
      value = taskResult;
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        isError: !(value as { ok: boolean }).ok,
      };
    }
    await (ready ||= skills.loadBundledSkills(resolveBundledRecipesDir()).catch((error) => {
      ready = undefined;
      throw error;
    }));
    const id = typeof args.id === 'string' ? args.id : '';
    const version = typeof args.version === 'number' ? args.version : undefined;
    try {
      switch (args.action) {
        case 'find':
          value = await skills.find(
            String(args.url || ''),
            String(args.intent || ''),
            signal ? { signal } : undefined,
          );
          break;
        case 'list':
          value = skills.list();
          break;
        case 'get':
          value = skills.get(id, version);
          break;
        case 'propose':
          value = await skills.propose(args.definition as SkillDefinition);
          break;
        case 'validate':
          value = await skills.validate(id, version, signal, sessionId);
          break;
        case 'run':
          value = await skills.run(
            id,
            (args.inputs || {}) as Record<string, unknown>,
            typeof args.taskId === 'string' ? args.taskId : undefined,
            signal,
            sessionId,
            {
              version: typeof args.version === 'number' ? args.version : undefined,
              definitionHash:
                typeof args.definitionHash === 'string' ? args.definitionHash : undefined,
            },
          );
          break;
        case 'disable':
          value = await skills.disable(id);
          break;
        case 'rollback':
          if (version === undefined) throw new Error('rollback requires version');
          value = await skills.rollback(id, version);
          break;
        default:
          throw new Error('Unknown skill action');
      }
    } catch (error) {
      const detail = error instanceof Error ? error : new Error(String(error));
      const result = (detail as Error & { result?: CallToolResult }).result;
      const attached = result && Array.isArray(result.content) ? result : undefined;
      const original = attached ? tryParseCallResult(attached) || {} : {};
      return withStructuredPayload(attached, {
        ...original,
        success: false,
        status:
          typeof original.status === 'string'
            ? original.status
            : (detail as Error & { status?: string }).status || 'failed',
        retry: false,
        ...('requestDispatched' in detail &&
        typeof detail.requestDispatched === 'boolean' &&
        typeof original.requestDispatched !== 'boolean'
          ? { requestDispatched: detail.requestDispatched }
          : {}),
        error: typeof original.error === 'string' ? original.error : detail.message,
        ...('output' in detail ? { output: detail.output } : {}),
        ...('cleanupError' in detail ? { cleanupFailed: true } : {}),
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
  }
  return { tasks, skills, execute };
}
