import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BrowserTaskManager, type BrowserCall } from '../../native-server/src/browser-tasks';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as raceCdpModule from '../utils/race-cdp';
import { cdpSessionManager } from '../utils/cdp-session-manager';

const TAB_ID = 77;
const SESSION_ID = 'task-cancel-session';
const PAGE_URL = 'https://example.com/form';

function result(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError: false,
  };
}

describe('task cancellation bridge', () => {
  const tempDirs: string[] = [];
  let mouseReleased = 0;
  let fillTargets: unknown[] = [];

  beforeEach(() => {
    mouseReleased = 0;
    fillTargets = [];

    vi.stubGlobal('chrome', {
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: 'linux' })),
      },
      tabs: {
        get: vi.fn(async () => ({ id: TAB_ID, url: PAGE_URL })),
        onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: undefined }]),
      },
      webNavigation: {
        onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: TAB_ID,
      url: PAGE_URL,
    });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, run) =>
      run({} as any),
    );
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        mouseReleased++;
      }
      return {} as any;
    });
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [
          {
            frameId: 0,
            result: {
              success: true,
              x: 200,
              y: 300,
              tagName: 'button',
              text: 'Submit',
              value: '',
            },
          },
        ] as any;
      }
      if (fnName === 'inPageWaitForActionable') {
        return [{ frameId: 0, result: { success: true, x: 200, y: 300 } }] as any;
      }
      if (fnName === 'inPageCheckInterception') {
        return [{ frameId: 0, result: { intercepted: false } }] as any;
      }
      if (fnName === 'inPageDetectPerceptiveSignature') {
        return [{ frameId: 0, result: { alerts: [] } }] as any;
      }
      return [{ frameId: 0, result: { success: true } }] as any;
    });
    vi.spyOn(fillCore, 'performPhysicalFill').mockImplementation(async (options: any) => {
      fillTargets.push(options.target);
      return {
        success: true,
        committed: true,
        status: 'success',
        index: options.target,
      } as any;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops an undispatched batch step after task.cancel wins between actions', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-cancel-bridge-'));
    tempDirs.push(storageDir);

    const executeBatch = batchActionsTool.execute.bind(batchActionsTool) as (
      args: Record<string, unknown>,
      context?: { signal?: AbortSignal },
    ) => Promise<CallToolResult>;

    const call: BrowserCall = async (name, args, _sessionId, signal?: AbortSignal) => {
      if (name === 'chrome_navigate') {
        return result({
          success: true,
          message: 'Opened URL in new tab in existing window',
          tabId: TAB_ID,
          windowId: 1,
          url: args.url,
        });
      }
      if (name === 'get_windows_and_tabs') {
        return result({
          browserInstanceId: 'browser-1',
          windows: [
            {
              windowId: 1,
              tabs: [
                {
                  tabId: TAB_ID,
                  url: PAGE_URL,
                  documentId: 'doc-77',
                  browserInstanceId: 'browser-1',
                  isAgentManaged: true,
                },
              ],
            },
          ],
        });
      }
      if (name === 'browserpaw_set_owned_viewport') {
        return result({
          success: true,
          viewport: { status: 'native', width: 1280, height: 720, dpr: 1.5 },
        });
      }
      if (name === 'chrome_batch_actions') {
        return executeBatch(args, { signal });
      }
      throw new Error(`Unexpected browser call: ${name}`);
    };

    const manager = new BrowserTaskManager({ call, storageDir });
    const started = await manager.execute(
      { action: 'start', name: 'Cancellation bridge regression' },
      SESSION_ID,
    );
    const taskId = started.task!.id;
    const opened = await manager.execute({ action: 'open', taskId, url: PAGE_URL }, SESSION_ID);
    expect(opened.ok).toBe(true);

    const batchPromise = manager.callTool(
      taskId,
      'chrome_batch_actions',
      {
        actions: [
          { type: 'click', index: 1 },
          {
            type: 'fill',
            index: 2,
            value: 'must-not-run-after-cancel',
            at: Date.now() + 1000,
          },
        ],
      },
      SESSION_ID,
    );

    await vi.waitFor(() => expect(mouseReleased).toBe(1));
    const cancelled = await manager.execute({ action: 'cancel', taskId }, SESSION_ID);
    expect(cancelled.ok).toBe(true);
    const cancelledResult = await batchPromise;
    expect(cancelledResult.isError).toBe(true);
    expect(cancelledResult.structuredContent).toEqual(
      expect.objectContaining({
        success: false,
        partial: true,
        cancelled: true,
        taskStatus: 'cancelled',
        retry: false,
        cancellation: expect.objectContaining({
          status: 'cancelled',
          retry: false,
          requestDispatched: true,
          reason: 'task',
          tool: 'chrome_batch_actions',
        }),
      }),
    );
    expect((cancelledResult.structuredContent as any).results[0]).toEqual(
      expect.objectContaining({ actionIndex: 0, success: true, status: 'success' }),
    );
    expect(fillTargets).toEqual([]);
  });

  it('refuses to start a form mutation when the request was already cancelled', async () => {
    vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: TAB_ID,
      url: PAGE_URL,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await formPipelineTool.execute(
      { fields: [{ query: 'Email', value: 'must-not-run' }], tabId: TAB_ID },
      { signal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as { text: string }).text).toContain('Task cancelled');
    expect(fillTargets).toEqual([]);
  });
});
