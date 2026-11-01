import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createBrowserServices } from './browser-services';
import { BrowserSkillStore } from './browser-skills';
import { createDomExtractionStep, DOM_EXTRACTION_OUTPUT_SCHEMA } from './skill-read-program';

describe('Native task and skill entry points', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-services-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const payload = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });
  const data = (value: { content: Array<{ type: string; text?: string }> }) =>
    JSON.parse(value.content[0].text!);

  it.each(['open-with-id', 'open-without-id', 'step'])(
    'keeps unknown delivery and non-text content through skill validation (%s)',
    async (phase) => {
      const receipt = { event: 'original-delivery-evidence' };
      const image = { type: 'image' as const, mimeType: 'image/png', data: 'dGVzdA==' };
      const uncertain: CallToolResult = {
        ...payload({
          success: false,
          status: 'unknown',
          outcome: 'unknown',
          retry: false,
          receipt,
          ...(phase === 'open-with-id' ? { created: true, tabId: 9 } : {}),
        }),
        isError: true,
      };
      uncertain.content.unshift(image);
      uncertain.content.unshift({ type: 'text', text: 'Original transport diagnostic' });
      const tabs: Array<Record<string, unknown>> = [];
      const call = jest.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'get_windows_and_tabs')
          return payload({ browserInstanceId: 'browser-1', windows: [{ windowId: 1, tabs }] });
        if (name === 'chrome_navigate') {
          if (phase !== 'step') return uncertain;
          tabs.push({ tabId: 9, url: args.url, documentId: 'doc-1', isAgentManaged: true });
          return payload({ success: true, created: true, tabId: 9 });
        }
        if (name === 'chrome_javascript') return uncertain;
        if (name === 'chrome_close_tabs') {
          tabs.length = 0;
          return payload({ success: true, closedTabIds: [9] });
        }
        throw new Error(`Unexpected browser call: ${name}`);
      });
      const service = createBrowserServices(call, root);
      await service.skills.propose({
        id: 'delivery-read',
        name: 'Delivery read',
        description: 'Read a source-linked heading',
        source: { type: 'agent', urls: ['https://example.com/'] },
        domains: ['example.com'],
        keywords: ['read'],
        startUrl: 'https://example.com/?q={{query}}',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        outputSchema: DOM_EXTRACTION_OUTPUT_SCHEMA,
        steps: [
          createDomExtractionStep({ fields: [{ name: 'title', selector: 'h1', value: 'text' }] }),
        ],
        verification: { tool: 'chrome_read_dom', args: { format: 'compact' } },
        tests: ['alpha', 'beta'].map((query) => ({
          inputs: { query },
          expect: { type: 'object', required: ['success'] },
          observe: { type: 'object', properties: { text: { const: query } }, required: ['text'] },
        })),
      });
      const result = await service.execute('chrome_skill', {
        action: 'validate',
        id: 'delivery-read',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'unknown', retry: false, receipt });
      expect(result.content).toContainEqual(image);
      expect(result.content).toContainEqual({
        type: 'text',
        text: 'Original transport diagnostic',
      });
      expect(call.mock.calls.filter(([name]) => name === 'chrome_navigate')).toHaveLength(1);
      if (phase !== 'step')
        expect(call.mock.calls.filter(([name]) => name === 'chrome_javascript')).toHaveLength(0);
    },
  );

  it('discovers bundled skills in source mode without an extension connection', async () => {
    const call = jest.fn(async () => {
      throw new Error('disconnected');
    });
    const service = createBrowserServices(call, root);
    const bundled = data(
      await service.execute('chrome_skill', { action: 'get', id: 'mdn-search' }),
    );
    expect(bundled.definition.id).toBe('mdn-search');
    expect(bundled.status).toBe('candidate');
    expect(call).not.toHaveBeenCalled();
  });

  it('retries only bundled loading after a rejected initialization', async () => {
    const service = createBrowserServices(jest.fn(), root);
    const load = jest
      .spyOn(BrowserSkillStore.prototype, 'loadBundledSkills')
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValue(undefined);
    try {
      await expect(service.execute('chrome_skill', { action: 'list' })).rejects.toThrow(
        'temporary read failure',
      );
      await expect(service.execute('chrome_skill', { action: 'list' })).resolves.toBeDefined();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      load.mockRestore();
    }
  });

  it('uses canonical recipes when source and dist recipe directories are absent', async () => {
    const exists = fs.existsSync;
    const unavailable = new Set([
      path.join(__dirname, 'recipes'),
      path.join(__dirname, '..', 'dist', 'recipes'),
    ]);
    const probe = jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((file) => !unavailable.has(String(file)) && exists(file));
    try {
      const service = createBrowserServices(jest.fn(), root);
      const bundled = data(
        await service.execute('chrome_skill', { action: 'get', id: 'mdn-search' }),
      );
      expect(bundled.definition.id).toBe('mdn-search');
    } finally {
      probe.mockRestore();
    }
  });

  it('aborts a real task-scoped skill call and retains its receipt while cleaning up', async () => {
    const tabs: Array<Record<string, unknown>> = [];
    const receipt = { event: 'cancelled-read' };
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'dGVzdA==' };
    let stepStarted!: (signal: AbortSignal | undefined) => void;
    const entered = new Promise<AbortSignal | undefined>((resolve) => {
      stepStarted = resolve;
    });
    let finishStep!: () => void;
    const call = jest.fn(
      async (
        name: string,
        args: Record<string, unknown>,
        _sessionId?: string,
        signal?: AbortSignal,
      ): Promise<CallToolResult> => {
        if (name === 'get_windows_and_tabs')
          return payload({ browserInstanceId: 'browser-1', windows: [{ windowId: 1, tabs }] });
        if (name === 'chrome_navigate') {
          tabs.push({ tabId: 9, url: args.url, documentId: 'doc-1', isAgentManaged: true });
          return payload({ success: true, created: true, tabId: 9 });
        }
        if (name === 'chrome_javascript')
          return new Promise((resolve) => {
            finishStep = () =>
              resolve({
                content: [
                  image,
                  ...payload({ success: false, status: 'cancelled', retry: false, receipt })
                    .content,
                ],
                isError: true,
              });
            stepStarted(signal);
          });
        if (name === 'chrome_close_tabs') {
          tabs.length = 0;
          return payload({ success: true, closedTabIds: [9] });
        }
        return payload({ success: true });
      },
    );
    const service = createBrowserServices(call, root);
    const step = createDomExtractionStep({
      fields: [{ name: 'title', selector: 'h1', value: 'text' }],
    });
    await service.skills.propose({
      id: 'cancel-read',
      name: 'Cancel read',
      description: 'Read a verified heading',
      source: { type: 'agent', urls: ['https://example.com/'] },
      domains: ['example.com'],
      keywords: ['read'],
      startUrl: 'https://example.com/?q={{query}}',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      outputSchema: DOM_EXTRACTION_OUTPUT_SCHEMA,
      steps: [step, step],
      verification: { tool: 'chrome_read_dom', args: { format: 'compact' } },
      tests: ['alpha', 'beta'].map((query) => ({
        inputs: { query },
        expect: { type: 'object', required: ['success'] },
        observe: { type: 'object', properties: { text: { const: query } }, required: ['text'] },
      })),
    });
    const controller = new AbortController();
    const pending = service.execute(
      'chrome_skill',
      { action: 'validate', id: 'cancel-read' },
      'owner',
      controller.signal,
    );
    const nativeSignal = await entered;
    controller.abort();
    const wasAborted = nativeSignal?.aborted;
    finishStep();
    const result = await pending;
    expect(wasAborted).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'cancelled', retry: false, receipt });
    expect(result.content).toContainEqual(image);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_javascript')).toHaveLength(1);
    expect(call.mock.calls.filter(([name]) => name === 'chrome_close_tabs')).toHaveLength(1);
    expect(tabs).toHaveLength(0);
    expect(service.skills.list()).toEqual([]);
  });

  it('preserves a failed skill business result for the calling Agent', async () => {
    const service = createBrowserServices(jest.fn(), root);
    const output = { success: false, status: 'requires_auth', requiresLogin: true };
    jest
      .spyOn(service.skills, 'validate')
      .mockRejectedValueOnce(
        Object.assign(new Error('Skill result is not successful'), { status: 'blocked', output }),
      );
    const result = await service.execute('chrome_skill', {
      action: 'validate',
      id: 'x-search-thread',
    });
    expect(result.isError).toBe(true);
    expect(data(result)).toMatchObject({ status: 'blocked', retry: false, output });
  });

  it('creates and closes only proven task pages through the same browser call path', async () => {
    const tabs = [
      { tabId: 8, url: 'https://example.com/user', documentId: 'user-doc', isAgentManaged: false },
    ];
    const call = jest.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_windows_and_tabs')
        return payload({ browserInstanceId: 'browser-1', windows: [{ windowId: 1, tabs }] });
      if (name === 'chrome_navigate') {
        tabs.push({
          tabId: 9,
          url: String(args.url),
          documentId: 'task-doc',
          isAgentManaged: true,
        });
        return payload({ success: true, created: true, tabId: 9, windowId: 1, url: args.url });
      }
      if (name === 'chrome_close_tabs')
        return payload({ success: true, closedTabIds: args.tabIds });
      return payload({ success: true });
    });
    const service = createBrowserServices(call, root);
    const started = data(
      await service.execute('chrome_task', { action: 'start', name: 'Read documentation' }),
    );
    const taskId = started.task.id;
    const opened = data(
      await service.execute('chrome_task', {
        action: 'open',
        taskId,
        url: 'https://example.com/docs',
      }),
    );
    expect(opened.task.currentTabId).toBe(9);
    await expect(service.tasks.callTool(taskId, 'chrome_read_dom', { tabId: 8 })).rejects.toThrow();
    await service.tasks.callTool(taskId, 'chrome_read_dom', { tabId: 9 });
    expect(call).toHaveBeenCalledWith(
      'chrome_read_dom',
      expect.objectContaining({ tabId: 9 }),
      undefined,
      expect.any(AbortSignal),
    );
    const finished = await service.execute('chrome_task', { action: 'finish', taskId });
    expect(finished.isError).toBe(false);
    expect(call).toHaveBeenCalledWith(
      'chrome_close_tabs',
      expect.objectContaining({
        tabIds: [9],
        expectedTabs: [
          {
            tabId: 9,
            documentId: 'task-doc',
            browserInstanceId: 'browser-1',
          },
        ],
      }),
      undefined,
      undefined,
    );
    expect(call.mock.calls.filter(([name]) => name === 'chrome_close_tabs')).toHaveLength(1);
  });

  it('supports version and definitionHash options on chrome_skill run', async () => {
    const tabs: Array<Record<string, unknown>> = [];
    const call = jest.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_windows_and_tabs')
        return payload({ browserInstanceId: 'browser-1', windows: [{ windowId: 1, tabs }] });
      if (name === 'chrome_navigate') {
        tabs.push({ tabId: 10, url: args.url, documentId: 'doc-1', isAgentManaged: true });
        return payload({ success: true, created: true, tabId: 10 });
      }
      if (name === 'chrome_read_dom') {
        const query = String(tabs[0]?.url || '').includes('beta') ? 'beta' : 'alpha';
        return payload({ text: query });
      }
      if (name === 'chrome_javascript') {
        const query = String(tabs[0]?.url || '').includes('beta') ? 'beta' : 'alpha';
        return payload({
          success: true,
          result: JSON.stringify({
            success: true,
            fields: { title: query },
            sources: { page: 'https://example.com/' },
          }),
        });
      }
      if (name === 'chrome_close_tabs') {
        tabs.length = 0;
        return payload({ success: true, closedTabIds: [10] });
      }
      throw new Error('Unexpected call: ' + name);
    });
    const service = createBrowserServices(call, root);
    const def = {
      id: 'versioned-run',
      name: 'Versioned run',
      description: 'Run with explicit version/hash check',
      source: { type: 'agent' as const, urls: ['https://example.com/'] },
      domains: ['example.com'],
      keywords: ['run'],
      startUrl: 'https://example.com/?q={{query}}',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      outputSchema: DOM_EXTRACTION_OUTPUT_SCHEMA,
      steps: [
        createDomExtractionStep({ fields: [{ name: 'title', selector: 'h1', value: 'text' }] }),
      ],
      verification: { tool: 'chrome_read_dom' as const, args: { format: 'compact' } },
      tests: ['alpha', 'beta'].map((query) => ({
        inputs: { query },
        expect: { type: 'object', required: ['success'] },
        observe: { type: 'object', properties: { text: { const: query } }, required: ['text'] },
      })),
    };
    await service.skills.propose(def);
    const validated = await service.skills.validate('versioned-run');
    const hash = (validated as any).hash || (validated as any).definitionHash;
    expect(hash).toBeDefined();

    // Mismatched version returns MCP isError with status: blocked
    const versionMismatchResult = await service.execute('chrome_skill', {
      action: 'run',
      id: 'versioned-run',
      inputs: { query: 'alpha' },
      version: 99,
    });
    expect(versionMismatchResult.isError).toBe(true);
    expect(versionMismatchResult.structuredContent).toMatchObject({
      success: false,
      status: 'blocked',
      requestDispatched: false,
      retry: false,
      error: expect.stringMatching(/version.*not match/i),
    });

    // Mismatched definitionHash returns MCP isError with status: blocked
    const hashMismatchResult = await service.execute('chrome_skill', {
      action: 'run',
      id: 'versioned-run',
      inputs: { query: 'alpha' },
      definitionHash: '0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect(hashMismatchResult.isError).toBe(true);
    expect(hashMismatchResult.structuredContent).toMatchObject({
      success: false,
      status: 'blocked',
      requestDispatched: false,
      retry: false,
      error: expect.stringMatching(/definition hash.*not match/i),
    });

    // Matching run succeeds
    const successResult = await service.execute('chrome_skill', {
      action: 'run',
      id: 'versioned-run',
      inputs: { query: 'alpha' },
      version: 1,
      definitionHash: hash,
    });
    expect(successResult.isError).not.toBe(true);
    const textContent = successResult.content.find((item) => item.type === 'text') as
      { type: 'text'; text: string } | undefined;
    const parsed = JSON.parse(textContent?.text || '{}');
    expect(parsed.version).toBe(1);
    expect(parsed.hash).toBe(hash);
    expect(parsed.definitionHash).toBeUndefined();
  });
});
