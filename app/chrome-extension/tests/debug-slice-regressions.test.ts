import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { networkCaptureTool } from '../entrypoints/background/tools/browser/network-capture';
import {
  networkCaptureStartTool,
  networkCaptureStopTool,
} from '../entrypoints/background/tools/browser/network-capture-web-request';
import { networkDebuggerStartTool } from '../entrypoints/background/tools/browser/network-capture-debugger';
import { consoleBuffer } from '../entrypoints/background/tools/browser/console-buffer';
import { debugTool } from '../entrypoints/background/tools/browser/debug';
import {
  performanceStopTraceTool,
  sessions as performanceSessions,
} from '../entrypoints/background/tools/browser/performance';

const tab = {
  id: 41,
  windowId: 1,
  url: 'https://example.test/',
  title: 'Example',
  width: 1280,
  height: 720,
} as chrome.tabs.Tab;

function text(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.find((block) => block.type === 'text')?.text || '';
}

afterEach(async () => {
  await networkCaptureStartTool.stopCapture(tab.id).catch(() => {});
  await networkDebuggerStartTool.stopCapture(tab.id).catch(() => {});
  networkCaptureStartTool.terminalResults.clear();
  networkDebuggerStartTool.terminalResults.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('debug slice network regressions', () => {
  it('replaces an auto-stopped debugger capture with the new task’s webRequest capture', async () => {
    const target = { ...tab, id: 42 };
    const invoke = (
      action: 'start' | 'list' | 'show' | 'stop' | 'clear',
      sessionId: string,
      args?: { needResponseBody?: boolean; requestId?: string },
    ) => networkCaptureTool.execute({ action, tabId: target.id, sessionId, ...args });
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn().mockResolvedValue(target), query: vi.fn().mockResolvedValue([target]) },
    });
    vi.spyOn(networkDebuggerStartTool, 'execute').mockImplementation(async () => {
      networkDebuggerStartTool.terminalResults.set(target.id!, {
        expiresAt: Date.now() + 30_000,
        result: { requests: [{ requestId: 'old', responseBody: 'fixture private body' }] },
      });
      return { content: [] };
    });
    expect((await invoke('start', 'first', { needResponseBody: true })).isError).not.toBe(true);
    expect(JSON.parse(text(await invoke('list', 'first'))).requests).toHaveLength(1);
    expect((await invoke('show', 'second', { requestId: 'old' })).isError).toBe(true);
    vi.spyOn(networkCaptureStartTool, 'execute').mockImplementation(async () => {
      networkCaptureStartTool.terminalResults.set(target.id!, {
        expiresAt: Date.now() + 30_000,
        result: { requests: [{ requestId: 'new', method: 'GET', url: target.url }] },
      });
      return { content: [] };
    });
    expect((await invoke('start', 'second')).isError).not.toBe(true);
    expect((await invoke('stop', 'second')).isError).toBe(false);
    expect((await invoke('list', 'first')).isError).toBe(true);
    expect(JSON.parse(text(await invoke('list', 'second'))).requests).toMatchObject([
      { id: 'new' },
    ]);
    expect((await invoke('show', 'second', { requestId: 'old' })).isError).toBe(true);
    await invoke('clear', 'second');
    expect(JSON.parse(text(await invoke('list', 'second'))).requests).toHaveLength(0);
  });

  it('lists filtered requests, shows one textual body, and clears only current events', async () => {
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn().mockResolvedValue(tab), query: vi.fn().mockResolvedValue([tab]) },
      webRequest: Object.fromEntries(
        [
          'onBeforeRequest',
          'onSendHeaders',
          'onHeadersReceived',
          'onCompleted',
          'onErrorOccurred',
        ].map((name) => [name, { addListener: vi.fn(), removeListener: vi.fn() }]),
      ),
    });
    const tool = networkCaptureStartTool as any;
    const capture = {
      tabId: tab.id,
      tabUrl: tab.url,
      tabTitle: tab.title,
      startTime: Date.now(),
      requests: {
        one: {
          requestId: 'one',
          url: 'https://api.example.test/items',
          method: 'GET',
          type: 'XHR',
          status: 200,
          mimeType: 'application/json',
          responseBody: '{"ok":true}',
          requestTime: 1,
        },
        two: {
          requestId: '1',
          url: 'https://cdn.example.test/app.js',
          method: 'GET',
          type: 'Script',
          status: 500,
          requestTime: 2,
        },
      },
      maxCaptureTime: 0,
      inactivityTimeout: 0,
      includeStatic: false,
      limitReached: false,
    };
    tool.captureData.set(tab.id, capture);

    const list = await networkCaptureTool.execute({
      action: 'list',
      tabId: tab.id,
      requestUrlPattern: '/api\\.example\\.test/',
      method: 'get',
      status: 200,
    } as any);
    expect(JSON.parse(text(list))).toMatchObject({
      recording: true,
      requests: [{ id: 'one', method: 'GET', status: 200 }],
    });
    const filtered = JSON.parse(
      text(
        await networkCaptureTool.execute({
          action: 'list',
          status: 500,
          tabId: tab.id,
        }),
      ),
    );
    expect(filtered.requests).toHaveLength(1);
    expect(filtered.requests[0].id).toBe('1');
    expect(filtered.requests[0]).not.toHaveProperty('index');
    const exact = await networkCaptureTool.execute({
      action: 'show',
      tabId: tab.id,
      requestId: filtered.requests[0].id,
    });
    expect(JSON.parse(text(exact)).request.url).toBe('https://cdn.example.test/app.js');
    expect(
      (await networkCaptureTool.execute({ action: 'show', tabId: tab.id, requestId: '2' })).isError,
    ).toBe(true);

    const show = await networkCaptureTool.execute({
      action: 'show',
      tabId: tab.id,
      requestId: 'one',
    } as any);
    expect(JSON.parse(text(show)).request).toMatchObject({
      requestId: 'one',
      responseBody: '{"ok":true}',
    });

    const showOut = await networkCaptureTool.execute({
      action: 'show',
      tabId: tab.id,
      requestId: 'one',
      outputPath: 'body.json',
    } as any);
    expect(showOut.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'resource',
          resource: expect.objectContaining({ mimeType: 'application/json' }),
        }),
      ]),
    );
    expect(showOut.structuredContent).toMatchObject({
      file: {
        path: null,
        outputPath: 'body.json',
        mimeType: 'application/json',
        resourceUri: 'browserpaw://network/one/body.txt',
      },
    });

    const clear = await networkCaptureTool.execute({ action: 'clear', tabId: tab.id } as any);
    expect(clear.isError).toBe(false);
    expect(Object.keys(capture.requests)).toHaveLength(0);
  });

  it('decodes textual base64 bodies and omits binary bodies from the capture receipt', async () => {
    const tool = networkDebuggerStartTool as any;
    const capture = {
      startTime: Date.now(),
      requests: {
        json: {
          requestId: 'json',
          url: 'https://example.test/api/json',
          method: 'GET',
          type: 'XHR',
          status: 'complete',
          mimeType: 'application/json',
        },
        binary: {
          requestId: 'binary',
          url: 'https://example.test/api/image',
          method: 'GET',
          type: 'XHR',
          status: 'complete',
          mimeType: 'application/grpc',
        },
      },
      webSockets: {},
      inactivityTimeout: 0,
      includeStatic: false,
    };
    tool.captureData.set(tab.id, capture);
    vi.spyOn(tool, 'getResponseBody').mockImplementation(
      async (_tabId: number, requestId: string) =>
        requestId === 'json'
          ? { body: Buffer.from('{"message":"ok"}').toString('base64'), base64Encoded: true }
          : { body: Buffer.from([0, 1, 2]).toString('base64'), base64Encoded: true },
    );

    await tool.handleLoadingFinished(tab.id, { requestId: 'json', encodedDataLength: 15 });
    await tool.handleLoadingFinished(tab.id, { requestId: 'binary', encodedDataLength: 3 });
    expect(capture.requests.json.responseBody).toBe('{"message":"ok"}');
    expect(capture.requests.json.base64Encoded).toBeUndefined();
    expect(capture.requests.binary.responseBody).toBeUndefined();
    expect(capture.requests.binary.responseBody).toBeUndefined();
  });
});

describe('debug slice console filters', () => {
  it('applies level selection and regex filtering together', async () => {
    vi.spyOn(consoleBuffer, 'ensureStarted').mockResolvedValue();
    vi.spyOn(consoleBuffer, 'read').mockImplementation((_tabId, options) => {
      const entries = [
        { timestamp: 1, level: 'log', text: 'ordinary' },
        { timestamp: 2, level: 'warning', text: 'slow response' },
        { timestamp: 3, level: 'error', text: 'failed request' },
      ].filter(
        (entry) =>
          options.levels?.includes(entry.level) &&
          (!options.pattern || options.pattern.test(entry.text)),
      );
      return {
        tabId: 41,
        tabUrl: tab.url,
        tabTitle: tab.title,
        captureStartTime: 1,
        captureEndTime: 2,
        totalDurationMs: 1,
        messages: entries,
        exceptions: [],
        totalBufferedMessages: 3,
        totalBufferedExceptions: 0,
        messageCount: entries.length,
        exceptionCount: 0,
        messageLimitReached: false,
        droppedMessageCount: 0,
        droppedExceptionCount: 0,
      };
    });
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn().mockResolvedValue(tab) },
    });
    const { consoleTool } = await import('../entrypoints/background/tools/browser/console');
    const result = await consoleTool.execute({
      tabId: tab.id,
      mode: 'buffer',
      levels: ['warning', 'error'],
      pattern: 'request',
    });
    expect(JSON.parse(text(result)).messages).toEqual([
      expect.objectContaining({ level: 'error', text: 'failed request' }),
    ]);
  });
});

describe('debug slice CDP actions', () => {
  it('resets all emulation and writes PDF bytes to Native file output', async () => {
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn().mockResolvedValue(tab) },
      debugger: {
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
        getTargets: vi.fn().mockResolvedValue([]),
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue({}),
      },
    });
    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue();
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue();
    const send = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

    const reset = await debugTool.execute({ action: 'emulate_reset', tabId: tab.id });
    expect(reset.isError).toBe(false);
    expect(send.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        'Emulation.clearDeviceMetricsOverride',
        'Emulation.setEmulatedMedia',
        'Emulation.setTimezoneOverride',
        'Emulation.setLocaleOverride',
        'Emulation.setUserAgentOverride',
        'Emulation.setCPUThrottlingRate',
        'Network.emulateNetworkConditions',
      ]),
    );

    send.mockImplementation(async (_tabId, method) => {
      if (method === 'Emulation.setTimezoneOverride') {
        throw new Error(
          '{"code":-32000,"message":"Timezone override is only available to trusted clients"}',
        );
      }
      return {};
    });
    const resetWithRestrictedTimezone = await debugTool.execute({
      action: 'emulate_reset',
      tabId: tab.id,
    });
    expect(resetWithRestrictedTimezone.isError).toBe(false);
  });

  it('prints PDF to a file-shaped result and exposes bytes only through Native output', async () => {
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn().mockResolvedValue(tab) },
    });
    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue();
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue();
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) =>
      method === 'Page.printToPDF' ? { data: Buffer.from('%PDF-test').toString('base64') } : {},
    );
    const native = await import('../entrypoints/background/native-host');
    vi.spyOn(native, 'sendFileOperationToNative').mockImplementation((_message, callback) => {
      callback({
        payload: { success: true, filePath: 'C:\\temp\\page.pdf', fileName: 'page.pdf', size: 9 },
      });
      return true;
    });

    const result = await debugTool.execute({
      action: 'pdf',
      tabId: tab.id,
      outputPath: 'report.pdf',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      file: { path: 'C:\\temp\\page.pdf', mimeType: 'application/pdf', outputPath: 'report.pdf' },
    });
    expect(text(result)).not.toContain('%PDF-test');
  });

  it('returns trace file metadata on stop when --out was requested', async () => {
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn().mockResolvedValue(tab) },
      debugger: {
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    const listener = vi.fn();
    performanceSessions.set(tab.id, {
      recording: true,
      completed: false,
      events: [{ name: 'RunTask', args: {} }],
      startedAt: Date.now() - 10,
      pageUrl: tab.url,
      listener,
    });
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue();
    const native = await import('../entrypoints/background/native-host');
    vi.spyOn(native, 'sendFileOperationToNative').mockImplementation((_message, callback) => {
      callback({
        payload: {
          success: true,
          filePath: 'C:\\temp\\performance_trace.json',
          fileName: 'performance_trace.json',
          size: 28,
        },
      });
      return true;
    });

    const result = await performanceStopTraceTool.execute({
      tabId: tab.id,
      saveToDownloads: false,
      outputPath: 'trace.json',
    });
    expect(result.structuredContent).toMatchObject({
      tracingCompleted: false,
      traceBytes: expect.any(Number),
      file: {
        path: 'C:\\temp\\performance_trace.json',
        bytes: expect.any(Number),
        mimeType: 'application/json',
        outputPath: 'trace.json',
      },
    });
  });
});
