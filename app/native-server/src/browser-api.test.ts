import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';
import { RAW_TOOL_SCHEMAS } from '../../../packages/shared/src/tools';
import { createBrowserApi, type BrowserApiCall } from './browser-api';
import { BrowserTaskManager, type BrowserCall } from './browser-tasks';

function result(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError,
  };
}

function taskResult(task: Record<string, unknown>, action = 'status') {
  return result({ ok: true, action, task });
}

describe('browser-api', () => {
  let call: jest.MockedFunction<BrowserApiCall>;

  it('routes download triggers through one task-bound call and preserves the explicit frame', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Download' });
    const page = await task.open('https://example.com/');
    call.mockClear();
    await (page.frame(7) as any).download({ clickTargetIndex: 19, waitForComplete: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toEqual([
      'chrome_handle_download',
      {
        taskId: task.id,
        tabId: page.tabId,
        frameId: 7,
        clickTargetIndex: 19,
        waitForComplete: false,
      },
    ]);
    expect((await api.help('page.download')).tool).toBe('chrome_handle_download');
    await expect((page as any).download({ guid: 'g', clickTargetIndex: 19 })).rejects.toThrow();
    await expect((page as any).download({ filenameContains: 'report' })).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    call = jest.fn<BrowserApiCall>(async (name, rawArgs = {}) => {
      const args = rawArgs;
      if (name === 'chrome_task') {
        const action = args.action;
        if (action === 'start') {
          return taskResult({ id: 'task-1', name: args.name, status: 'active' }, 'start');
        }
        if (action === 'open') {
          return taskResult(
            { id: 'task-1', status: 'active', currentTabId: 55, pages: [{ tabId: 55 }] },
            'open',
          );
        }
        if (action === 'borrow') {
          return taskResult(
            { id: 'task-1', status: 'active', currentTabId: 66, pages: [{ tabId: 66 }] },
            'borrow',
          );
        }
        if (action === 'list') return result({ ok: true, action, tasks: [] });
        if (action === 'resume') {
          return taskResult({ id: args.taskId, status: 'active' }, 'resume');
        }
        return taskResult({ id: args.taskId, status: 'active' });
      }
      if (name === 'chrome_skill') {
        return result({ ok: true, action: args.action });
      }
      if (name === 'chrome_javascript') {
        return result({
          success: true,
          result: JSON.stringify({ title: String(args.code), source: 'native-js' }),
        });
      }
      return result({ ok: true, tool: name });
    });
  });

  it('fills replace by default and accept empty or whitespace values without changing them', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Fill semantics' });
    const page = await task.open('https://example.com/');
    await page.locator('#query').fill('');
    expect(call).toHaveBeenLastCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      actions: [{ type: 'fill', selector: '#query', value: '', clear: true }],
    });
    await page.locator('#query').fill('  ', { clear: false });
    expect(call).toHaveBeenLastCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      actions: [{ type: 'fill', selector: '#query', value: '  ', clear: false }],
    });
    await expect(page.locator('#query').fill(7 as any)).rejects.toThrow('string');
  });

  it('binds task lifecycle methods to chrome_task without inventing handles', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Task A', goal: 'Goal A' });

    expect(task.id).toBe('task-1');
    expect(call).toHaveBeenCalledWith('chrome_task', {
      action: 'start',
      name: 'Task A',
      goal: 'Goal A',
    });

    const page = await task.open('https://example.com/');
    expect(page).toEqual(expect.objectContaining({ tabId: 55, taskId: 'task-1' }));
    expect(call).toHaveBeenCalledWith('chrome_task', {
      action: 'open',
      taskId: 'task-1',
      url: 'https://example.com/',
    });

    const borrowed = await task.borrow(66);
    expect(borrowed).toEqual(expect.objectContaining({ tabId: 66, taskId: 'task-1' }));
    expect(call).toHaveBeenCalledWith('chrome_task', {
      action: 'borrow',
      taskId: 'task-1',
      tabId: 66,
    });

    await task.status();
    await task.handOff(55);
    await task.finish({ keep: [55] });
    await task.cancel();

    expect(call).toHaveBeenCalledWith('chrome_task', { action: 'status', taskId: 'task-1' });
    expect(call).toHaveBeenCalledWith('chrome_task', {
      action: 'handOff',
      taskId: 'task-1',
      tabId: 55,
    });
    expect(call).toHaveBeenCalledWith('chrome_task', {
      action: 'finish',
      taskId: 'task-1',
      keep: [55],
    });
    expect(call).toHaveBeenCalledWith('chrome_task', { action: 'cancel', taskId: 'task-1' });
  });

  it('requires adopt to be explicit when resuming a pending source document', async () => {
    const api = createBrowserApi(call);

    await api.task.resume('task-1');
    await api.task.resume('task-1', { adopt: true });

    expect(call).toHaveBeenNthCalledWith(1, 'chrome_task', {
      action: 'resume',
      taskId: 'task-1',
    });
    expect(call).toHaveBeenNthCalledWith(2, 'chrome_task', {
      action: 'resume',
      taskId: 'task-1',
      adopt: true,
    });
    await expect(api.task.resume('task-1', { adopt: 'yes' } as any)).rejects.toThrow(
      /adopt must be boolean/i,
    );
  });

  it('requires explicit confirmation to take over a task from another connection', async () => {
    const api = createBrowserApi(call);

    await api.task.takeOver('task-1', { confirm: true });
    expect(call).toHaveBeenCalledWith('chrome_task', {
      action: 'takeOver',
      taskId: 'task-1',
      confirm: true,
    });
    await expect(api.task.takeOver('task-1', { confirm: false } as any)).rejects.toThrow(
      /confirm: true/i,
    );
  });

  it('never auto-adopts a pending document after navigation or replays the mutation', async () => {
    const base = call.getMockImplementation()!;
    let navigated = false;
    call.mockImplementation(async (name, args = {}) => {
      if (name === 'chrome_navigate') {
        navigated = true;
        return result({ success: true, tabId: 55 });
      }
      if (name === 'chrome_batch_actions' && navigated) {
        return result(
          {
            success: false,
            error:
              'Tab 55 failed browser/document identity verification; run resume with adopt: true',
            retry: false,
          },
          true,
        );
      }
      return base(name, args);
    });

    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Task A2' });
    const page = await task.open('https://example.com/');
    await page.goto('https://example.com/next');

    await expect(page.locator('#stale').click()).rejects.toThrow(/resume with adopt: true/i);
    expect(
      call.mock.calls.filter(([name, args]) => name === 'chrome_task' && args?.action === 'resume'),
    ).toHaveLength(0);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_batch_actions')).toHaveLength(1);
  });

  it('routes page and frame operations to existing chrome tools with task and tab identity', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Task B' });
    const page = await task.open('https://example.com/');

    await page.goto('https://example.com/next');
    await page.observe({ format: 'compact', viewportOnly: true });
    await page.screenshot({ fullPage: true, format: 'png' });
    const evaluated = await page.evaluate('return document.title', { timeoutMs: 1000 });
    await page.frame(7).evaluate('return document.body.textContent');

    expect(call).toHaveBeenCalledWith('chrome_navigate', {
      url: 'https://example.com/next',
      taskId: 'task-1',
      tabId: 55,
    });
    expect(call).toHaveBeenCalledWith('chrome_read_dom', {
      taskId: 'task-1',
      tabId: 55,
      format: 'compact',
      viewportOnly: true,
    });
    expect(call).toHaveBeenCalledWith('chrome_screenshot', {
      taskId: 'task-1',
      tabId: 55,
      fullPage: true,
      format: 'png',
    });
    expect(call).toHaveBeenCalledWith('chrome_javascript', {
      taskId: 'task-1',
      tabId: 55,
      code: 'return document.title',
      timeoutMs: 1000,
    });
    expect(evaluated.data).toEqual({
      success: true,
      result: { title: 'return document.title', source: 'native-js' },
    });
    expect(evaluated.text).toContain('"result":"{\\"title\\"');
    expect(call).toHaveBeenCalledWith('chrome_javascript', {
      taskId: 'task-1',
      tabId: 55,
      code: 'return document.body.textContent',
      frameId: 7,
    });
    expect(page.frame(7).tabId).toBe(55);
    expect(page.frame(7).taskId).toBe('task-1');
  });

  it('uses chrome_batch_actions and chrome_keyboard for locator actions', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Task C' });
    const framePage = (await task.open('https://example.com/')).frame(9);

    const bySelector = framePage.locator('#query');
    const byRef = framePage.locator(12);

    await bySelector.click();
    await bySelector.fill('hello', { clear: false });
    await bySelector.press('Enter', { delay: 5 });
    await bySelector.waitFor({ state: 'visible', timeoutMs: 250 });
    await byRef.click({ clickCount: 2 });

    expect(call).toHaveBeenCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      frameId: 9,
      actions: [{ type: 'click', selector: '#query', frameId: 9 }],
    });
    expect(call).toHaveBeenCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      frameId: 9,
      actions: [{ type: 'fill', selector: '#query', value: 'hello', clear: false, frameId: 9 }],
    });
    expect(call).toHaveBeenCalledWith('chrome_keyboard', {
      taskId: 'task-1',
      tabId: 55,
      frameId: 9,
      selector: '#query',
      keys: 'Enter',
      delay: 5,
    });
    expect(call).toHaveBeenCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      frameId: 9,
      actions: [
        {
          type: 'assert',
          selector: '#query',
          condition: 'visible',
          timeoutMs: 250,
          abortOnFailure: true,
          frameId: 9,
        },
      ],
    });
    expect(call).toHaveBeenCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      frameId: 9,
      actions: [{ type: 'double_click', ref: 12, frameId: 9 }],
    });
    expect(byRef.ref).toBe(12);
  });

  it('exposes executable getByText/getByRole/getByLabel locators over existing tools', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Task D' });
    const page = await task.open('https://example.com/');

    const byText = page.getByText('Submit', { exact: true });
    const byRole = page.getByRole('button', { name: 'Submit', exact: true });
    const byLabel = page.getByLabel('Email address', { exact: true });

    expect(byText.text).toBe('Submit');
    expect(byRole.role).toBe('button');
    expect(byRole.text).toBe('Submit');
    expect(byLabel.label).toBe('Email address');

    await byText.click();
    await byText.fill('hello');
    await byRole.press('Enter');
    await byLabel.fill('person@example.com', { clear: true });
    await byRole.waitFor({ state: 'visible', timeoutMs: 250 });

    expect(call).toHaveBeenCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      actions: [{ type: 'click', text: 'Submit', exact: true }],
    });
    expect(call).toHaveBeenCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      actions: [{ type: 'fill', targetText: 'Submit', exact: true, value: 'hello', clear: true }],
    });
    expect(call).toHaveBeenCalledWith('chrome_keyboard', {
      taskId: 'task-1',
      tabId: 55,
      role: 'button',
      text: 'Submit',
      exact: true,
      keys: 'Enter',
    });
    expect(call).toHaveBeenCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      actions: [
        {
          type: 'fill',
          label: 'Email address',
          exact: true,
          value: 'person@example.com',
          clear: true,
        },
      ],
    });
    expect(call).toHaveBeenCalledWith('chrome_batch_actions', {
      taskId: 'task-1',
      tabId: 55,
      actions: [
        {
          type: 'assert',
          role: 'button',
          text: 'Submit',
          exact: true,
          condition: 'visible',
          timeoutMs: 250,
          abortOnFailure: true,
        },
      ],
    });
  });

  it('rejects unsupported role subsets and unknown getBy options', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Task D2' });
    const page = await task.open('https://example.com/');

    expect(() => page.getByRole('div')).toThrow(/unsupported role/i);
    expect(() => page.getByText('Submit', { force: true } as any)).toThrow(/unknown option/i);
    expect(() => page.getByLabel('Email', { exact: 'yes' } as any)).toThrow(/boolean/i);
  });

  it('rejects unknown options before dispatching any tool call', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Task E' });
    const page = await task.open('https://example.com/');
    await call.mockClear();

    await expect(page.goto('https://example.com/', { newWindow: true } as any)).rejects.toThrow(
      /unknown option/i,
    );
    await expect(page.observe({ madeUp: true } as any)).rejects.toThrow(/unknown option/i);
    await expect(page.locator('#x').click({ force: true } as any)).rejects.toThrow(
      /unknown option/i,
    );
    await expect(task.finish({ keepAll: true } as any)).rejects.toThrow(/unknown option/i);
    await expect(api.task.start({ name: 'Task E2', browser: 'chrome' } as any)).rejects.toThrow(
      /unknown option/i,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('stops exactly once on isError or unknown outcomes and preserves the raw result', async () => {
    const failure = result({ error: 'Element is stale' }, true);
    call.mockResolvedValueOnce(failure);
    const api = createBrowserApi(call);

    const error = await api.task.start({ name: 'Task F' }).catch((value: any) => value);
    expect(error.message).toContain('Element is stale');
    expect(error.result).toBe(failure);
    expect(call).toHaveBeenCalledTimes(1);

    const unknown = result({ success: false, status: 'unknown', retry: false });
    call.mockReset();
    call.mockResolvedValueOnce(unknown);
    const unknownError = await api.skills.list().catch((value: any) => value);
    expect(unknownError.message).toMatch(/outcome unknown/i);
    expect(unknownError.result).toBe(unknown);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('passes the full skill contract through unchanged', async () => {
    const api = createBrowserApi(call);
    const definition = {
      id: 'example-skill',
      name: 'Example',
      description: 'Example skill',
      source: { type: 'agent' as const, urls: ['https://example.com/docs'] },
      domains: ['example.com'],
      keywords: ['example'],
      startUrl: 'https://example.com/?q={{query}}',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      steps: [{ tool: 'chrome_read_dom', args: {} }],
      verification: { tool: 'chrome_read_dom' as const, args: {}, resultPath: '/title' },
      tests: [
        { inputs: { query: 'a' }, expect: { type: 'object' }, observe: { type: 'object' } },
        { inputs: { query: 'b' }, expect: { type: 'object' }, observe: { type: 'object' } },
      ],
    };

    await api.skills.propose(definition);
    await api.skills.validate('example-skill', 1);
    await api.skills.run(
      'example-skill',
      { query: 'a' },
      { taskId: 'task-1', version: 1, definitionHash: 'abc' },
    );
    const signal = new AbortController().signal;
    await api.skills.validate('example-skill', 1, { signal });
    await api.skills.run('example-skill', { query: 'a' }, { taskId: 'task-1', signal });
    await api.skills.rollback('example-skill', 1);

    expect(call).toHaveBeenCalledWith('chrome_skill', {
      action: 'propose',
      definition,
    });
    expect(call).toHaveBeenCalledWith('chrome_skill', {
      action: 'validate',
      id: 'example-skill',
      version: 1,
    });
    expect(call).toHaveBeenCalledWith('chrome_skill', {
      action: 'run',
      id: 'example-skill',
      inputs: { query: 'a' },
      taskId: 'task-1',
      version: 1,
      definitionHash: 'abc',
    });
    expect(call).toHaveBeenCalledWith(
      'chrome_skill',
      {
        action: 'validate',
        id: 'example-skill',
        version: 1,
      },
      { signal },
    );
    expect(call).toHaveBeenCalledWith(
      'chrome_skill',
      {
        action: 'run',
        id: 'example-skill',
        inputs: { query: 'a' },
        taskId: 'task-1',
      },
      { signal },
    );
    expect(call).toHaveBeenCalledWith('chrome_skill', {
      action: 'rollback',
      id: 'example-skill',
      version: 1,
    });
  });

  it('provides on-demand method help with the real underlying tool schema', async () => {
    const api = createBrowserApi(call);

    expect(api.help().map((item) => item.method)).toContain('locator.waitFor');
    const help = await api.help('page.observe');
    expect(help.tool).toBe('chrome_read_dom');
    expect(help.source).toBe('chrome_read_dom');
    expect(help.schema).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({ format: expect.any(Object) }),
      }),
    );
    const gotoHelp = await api.help('page.goto');
    expect(gotoHelp.description).toMatch(
      /inspect task status and fresh browser inventory.*task\.resume\(taskId, \{ adopt: true \}\).*recorded pending identity/i,
    );
    await expect(api.help('page.fake')).rejects.toThrow(/unsupported/i);
    expect(call).not.toHaveBeenCalled();
  });

  it('publishes keepUnknownPages only together with confirm', async () => {
    const api = createBrowserApi(call);
    const task = await api.task.start({ name: 'Finish unknown' });
    await expect(task.finish({ keepUnknownPages: true })).rejects.toThrow('confirm: true');
    expect(call).not.toHaveBeenCalledWith(
      'chrome_task',
      expect.objectContaining({ action: 'finish' }),
    );
    await task.finish({ keepUnknownPages: true, confirm: true });
    expect(call).toHaveBeenCalledWith('chrome_task', {
      action: 'finish',
      taskId: 'task-1',
      keepUnknownPages: true,
      confirm: true,
    });
    const help = await api.help('task.finish');
    expect(help.description).toContain('keepUnknownPages:true');
    expect(help.description).toContain('confirm:true');
    expect(help.description).toContain('unverified');
    const schema = RAW_TOOL_SCHEMAS.find((tool) => tool.name === 'chrome_task')?.inputSchema;
    expect(schema).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          keepUnknownPages: expect.objectContaining({ type: 'boolean' }),
          confirm: expect.objectContaining({
            description: expect.stringContaining('keepUnknownPages'),
          }),
        }),
      }),
    );
  });

  it('shows retained unknown receipts from the real task.finish result', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-api-finish-'));
    const receipt = { hasReceipt: true, marker: 'unpinned' };
    const image = { type: 'image' as const, data: 'eeee', mimeType: 'image/png' };
    const browserCall: BrowserCall = async (name, args) => {
      if (name === 'chrome_navigate') {
        const failure: CallToolResult = {
          isError: true,
          content: [
            { type: 'text', text: 'diagnostic: navigation reported no tab' },
            image,
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                status: 'unknown',
                outcome: 'unknown',
                receipt,
                error: 'navigation outcome unknown',
              }),
            },
          ],
        };
        throw Object.assign(new Error('Request timed out after 5ms'), {
          requestDispatched: true,
          result: failure,
        });
      }
      if (name === 'get_windows_and_tabs') {
        return result({
          browserInstanceId: 'browser-1',
          windowCount: 1,
          tabCount: 1,
          windows: [
            {
              windowId: 1,
              tabs: [{ tabId: 10, url: 'https://user.example/', documentId: 'doc-10' }],
            },
          ],
        });
      }
      throw new Error('unexpected ' + name);
    };
    const manager = new BrowserTaskManager({ call: browserCall, storageDir });
    call.mockImplementation(async (name, args = {}) => {
      if (name !== 'chrome_task') return result({ ok: true });
      const value = await manager.execute(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        isError: value.ok === false,
      };
    });
    const api = createBrowserApi(call);
    const handle = await api.task.start({ name: 'Facade retain' });
    await expect(handle.open('https://unknown.example/')).rejects.toThrow();
    const finished = await handle.finish({ keepUnknownPages: true, confirm: true });
    expect(finished.isError).not.toBe(true);
    expect(finished.data).toEqual(
      expect.objectContaining({
        ok: true,
        warning: expect.stringContaining('not closed'),
        handedOverUnknown: [
          expect.objectContaining({
            unknownId: expect.stringMatching(/^unknown:/),
            receipt,
            retained: true,
          }),
        ],
        task: expect.objectContaining({ status: 'finished' }),
      }),
    );
    expect(JSON.parse(finished.text || '')).toEqual(
      expect.objectContaining({
        warning: expect.stringContaining('not claimed'),
      }),
    );
    expect(call).toHaveBeenCalledWith('chrome_task', {
      action: 'finish',
      taskId: handle.id,
      keepUnknownPages: true,
      confirm: true,
    });
  });

  it('answers known method help locally without an extra docs or tools round-trip', async () => {
    const listTools = jest.fn(async () => [
      {
        name: 'chrome_read_dom',
        description: 'dynamic schema',
        inputSchema: { type: 'object' as const, properties: { dynamic: { type: 'boolean' } } },
      },
    ]);
    const api = createBrowserApi(call, listTools);

    const help = await api.help('page.observe');

    expect(call).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
    expect(help.schema).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({ format: expect.any(Object) }),
      }),
    );
  });

  it('aligns method help with the JS arguments that runtime actually accepts', async () => {
    const listTools = jest.fn(async () => []);
    const api = createBrowserApi(call, listTools);
    const methods = [
      'task.start',
      'task.list',
      'task.resume',
      'task.takeOver',
      'task.get',
      'task.open',
      'task.borrow',
      'task.finish',
      'task.cancel',
      'task.status',
      'task.handOff',
      'page.goto',
      'page.observe',
      'page.screenshot',
      'page.download',
      'page.evaluate',
      'page.frame',
      'page.locator',
      'page.getByText',
      'page.getByRole',
      'page.getByLabel',
      'locator.click',
      'locator.fill',
      'locator.press',
      'locator.waitFor',
      'skills.find',
      'skills.list',
      'skills.get',
      'skills.propose',
      'skills.validate',
      'skills.run',
      'skills.disable',
      'skills.rollback',
    ];
    const signatureOf = (entry: object): string =>
      String((entry as { signature?: string }).signature ?? '');
    const index = api.help();
    const listed = JSON.stringify(index);
    const taskTool = RAW_TOOL_SCHEMAS.find((tool) => tool.name === 'chrome_task');
    const skillTool = RAW_TOOL_SCHEMAS.find((tool) => tool.name === 'chrome_skill');
    const taskProps = taskTool?.inputSchema.properties as {
      action?: { enum?: string[] };
      keepUnknownPages?: { description?: string };
    };
    const skillProps = skillTool?.inputSchema.properties as { action?: { enum?: string[] } };
    const taskActions = JSON.stringify(taskProps?.action?.enum);
    const skillActions = JSON.stringify(skillProps?.action?.enum);
    const receiptMarker = taskProps?.keepUnknownPages?.description?.slice(0, 48) ?? '';

    expect(receiptMarker.length).toBeGreaterThan(20);
    expect(index.map((item) => item.method).sort()).toEqual([...methods].sort());
    expect(listed).not.toContain(receiptMarker);
    expect(listed).not.toContain(taskActions);
    expect(listed.length).toBeLessThan(
      JSON.stringify(taskTool?.inputSchema).length * methods.length,
    );
    for (const item of index) {
      expect(item).not.toHaveProperty('schema');
      expect(signatureOf(item).startsWith(item.method + '(')).toBe(true);
      expect(item.source.length).toBeGreaterThan(0);
      expect(item.tool.length).toBeGreaterThan(0);
      expect(item.category.length).toBeGreaterThan(0);
    }
    expect(signatureOf(index.find((item) => item.method === 'task.start') ?? {})).not.toMatch(
      /\burl\b/,
    );
    expect(signatureOf(index.find((item) => item.method === 'page.frame') ?? {})).toContain(
      'frameId',
    );
    expect(signatureOf(index.find((item) => item.method === 'page.locator') ?? {})).toContain(
      'selectorOrRef',
    );
    expect(call).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
    const start = await api.help('task.start');
    const clickHelp = await api.help('locator.click');
    const fillHelp = await api.help('locator.fill');
    const pressHelp = await api.help('locator.press');
    const gotoHelp = await api.help('page.goto');
    const resumeHelp = await api.help('task.resume');
    const runHelp = await api.help('skills.run');
    const roleHelp = await api.help('page.getByRole');
    const waitHelp = await api.help('locator.waitFor');
    const finishHelp = await api.help('task.finish');
    const startSchema = start.schema as any;
    const clickSchema = clickHelp.schema as any;
    const fillSchema = fillHelp.schema as any;
    const pressSchema = pressHelp.schema as any;
    const gotoSchema = gotoHelp.schema as any;
    const resumeSchema = resumeHelp.schema as any;
    const runSchema = runHelp.schema as any;
    const roleSchema = roleHelp.schema as any;
    const waitSchema = waitHelp.schema as any;
    const finishSchema = finishHelp.schema as any;

    expect(call).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
    expect(Object.keys(startSchema.properties).sort()).toEqual(['goal', 'name']);
    expect(startSchema.additionalProperties).toBe(false);
    expect(startSchema.required).toEqual(['name']);
    expect(startSchema.properties.url).toBeUndefined();
    expect(startSchema.properties.action).toBeUndefined();
    expect(JSON.stringify(finishSchema)).toContain(receiptMarker);
    expect(finishSchema.properties.action).toBeUndefined();
    expect(Object.keys(finishSchema.properties).sort()).toEqual([
      'confirm',
      'keep',
      'keepUnknownPages',
    ]);
    expect(signatureOf(clickHelp)).toBe(
      'locator.click(options?: { button?: "left" | "right", clickCount?: 1 | 2 })',
    );
    expect(Object.keys(clickSchema.properties).sort()).toEqual(['button', 'clickCount']);
    expect(clickSchema.additionalProperties).toBe(false);
    expect(clickSchema.properties.button.enum).toEqual(['left', 'right']);
    expect(clickSchema.properties.clickCount.enum).toEqual([1, 2]);
    expect(clickSchema.not.properties).toEqual({
      button: { const: 'right' },
      clickCount: { const: 2 },
    });
    expect(signatureOf(fillHelp)).toBe(
      'locator.fill(value: string, options?: { clear?: boolean })',
    );
    expect(fillSchema.type).toBe('array');
    expect(fillSchema.properties).toBeUndefined();
    expect(fillSchema.minItems).toBe(1);
    expect(fillSchema.maxItems).toBe(2);
    expect(fillSchema.items[0]).toEqual(expect.objectContaining({ type: 'string' }));
    expect(fillSchema.items[1].additionalProperties).toBe(false);
    expect(Object.keys(fillSchema.items[1].properties)).toEqual(['clear']);
    expect(signatureOf(pressHelp)).toBe(
      'locator.press(keys: string, options?: { delay?: number })',
    );
    expect(pressSchema.type).toBe('array');
    expect(pressSchema.properties).toBeUndefined();
    expect(pressSchema.minItems).toBe(1);
    expect(pressSchema.items[0]).toEqual(expect.objectContaining({ type: 'string' }));
    expect(pressSchema.items[1].additionalProperties).toBe(false);
    expect(Object.keys(pressSchema.items[1].properties)).toEqual(['delay']);
    expect(signatureOf(gotoHelp)).toContain('page.goto(url: string, options?)');
    expect(gotoSchema.type).toBe('array');
    expect(gotoSchema.properties).toBeUndefined();
    expect(gotoSchema.items[0]).toEqual(expect.objectContaining({ type: 'string' }));
    expect(gotoSchema.items[1].additionalProperties).toBe(false);
    expect(gotoSchema.items[1].properties.newWindow).toBeUndefined();
    expect(gotoSchema.items[1].properties.newTab).toBeUndefined();
    expect(gotoSchema.items[1].properties.background).toBeUndefined();
    expect(gotoSchema.items[1].properties.refresh).toEqual(expect.any(Object));
    expect(signatureOf(resumeHelp)).toContain('task.resume(taskId: string, options?)');
    expect(resumeSchema.type).toBe('array');
    expect(resumeSchema.properties).toBeUndefined();
    expect(resumeSchema.items[1].properties.adopt).toEqual(expect.any(Object));
    expect(resumeSchema.items[1].properties.url).toBeUndefined();
    expect(signatureOf(runHelp)).toBe(
      'skills.run(id: string, inputs?: object, options?: { taskId?: string, signal?: AbortSignal, version?: number, definitionHash?: string })',
    );
    expect(runSchema.type).toBe('array');
    expect(runSchema.properties).toBeUndefined();
    expect(runSchema.items[0]).toEqual(expect.objectContaining({ type: 'string' }));
    expect(runSchema.items[1]).toEqual(expect.objectContaining({ type: 'object' }));
    expect(Object.keys(runSchema.items[2].properties).sort()).toEqual([
      'definitionHash',
      'signal',
      'taskId',
      'version',
    ]);
    expect(waitSchema.type).toBe('object');
    expect(waitSchema.properties.state.enum).toEqual(['visible', 'hidden']);
    expect(JSON.stringify(waitSchema.properties.state)).not.toContain('not_contains');
    expect(roleSchema.type).toBe('array');
    expect(roleSchema.items[0].enum).toEqual([
      'button',
      'link',
      'textbox',
      'combobox',
      'searchbox',
      'checkbox',
      'radio',
      'heading',
      'option',
      'tab',
      'menuitem',
      'switch',
    ]);
    expect(roleSchema.items[1].properties.name.type).toBe('string');
    expect(signatureOf(roleHelp)).toContain('name?: string');
    const proposeHelp = await api.help('skills.propose');
    const proposeSchema = proposeHelp.schema as any;
    const sharedDefinition = (skillTool?.inputSchema.properties as { definition?: object })
      .definition;
    expect(signatureOf(proposeHelp)).toBe('skills.propose(definition)');
    expect(proposeSchema).toEqual(sharedDefinition);
    expect(proposeSchema.properties?.definition).toBeUndefined();
    expect(proposeSchema.type).toBe('object');
    for (const method of methods) {
      const detail = await api.help(method);
      const raw = JSON.stringify(detail.schema);
      expect(raw).not.toContain(taskActions);
      expect(raw).not.toContain(skillActions);
      expect(typeof detail.schema).toBe('object');
    }
    await expect(api.help('page.fake')).rejects.toThrow(/unsupported/i);
    expect(call).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();

    await expect(
      api.skills.propose({ id: 'example-skill', definition: { name: 'Wrapped' } } as any),
    ).rejects.toThrow(/definition object itself/i);
    expect(call).not.toHaveBeenCalled();

    await expect(
      api.task.start({ name: 'Help', url: 'https://example.com/' } as any),
    ).rejects.toThrow('Unknown option "url" for task.start');
    expect(call).not.toHaveBeenCalled();

    const task = await api.task.start({ name: 'Help' });
    const page = await task.open('https://example.com/');
    call.mockClear();
    await expect(page.locator('#x').click({ force: true } as any)).rejects.toThrow(
      /unknown option/i,
    );
    await expect(page.locator('#x').click({ button: 'middle' } as any)).rejects.toThrow(
      /left" or "right/i,
    );
    await expect(page.locator('#x').click({ clickCount: 3 } as any)).rejects.toThrow(/1 or 2/i);
    await expect(page.locator('#x').click({ button: 'right', clickCount: 2 })).rejects.toThrow(
      /not supported/i,
    );
    await expect(page.locator('#x').fill('abc', { submit: true } as any)).rejects.toThrow(
      /unknown option/i,
    );
    await expect(page.locator('#x').press('Enter', { selector: '#y' } as any)).rejects.toThrow(
      /unknown option/i,
    );
    expect(call).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
  });

  it('does not let a mutated help schema change the next help result or TOOL_SCHEMAS', async () => {
    const api = createBrowserApi(call);
    const taskTool = TOOL_SCHEMAS.find((tool) => tool.name === 'chrome_task');
    const keep = taskTool?.inputSchema.properties?.keep as
      { description?: string; items?: { type?: string; minimum?: number } } | undefined;
    if (!keep?.items) throw new Error('chrome_task keep schema missing');
    const original = structuredClone(keep);
    const first = await api.help('task.finish');
    const returned = first.schema as {
      properties: { keep: { description?: string; items: { type?: string; minimum?: number } } };
    };
    returned.properties.keep.description = 'mutated by help caller';
    returned.properties.keep.items.minimum = 99;
    returned.properties.keep.items.type = 'mutated';
    try {
      const second = await api.help('task.finish');
      const nextKeep = (second.schema as { properties: { keep: { items: { minimum?: number } } } })
        .properties.keep;
      expect(nextKeep).toEqual(original);
      expect(keep).toEqual(original);
      expect(returned.properties.keep).not.toBe(keep);
      expect(returned.properties.keep.items).not.toBe(keep.items);
    } finally {
      keep.description = original.description;
      keep.items.type = original.items?.type;
      keep.items.minimum = original.items?.minimum;
    }
  });

  it('describes skills.get as reading a stored version, including a candidate', () => {
    const entry = createBrowserApi(call)
      .help()
      .find((item) => item.method === 'skills.get');
    expect(entry?.description).toBe('Read a stored skill version, including a candidate');
  });
});
