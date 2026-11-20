import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeMessageType } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { consoleTool } from '../entrypoints/background/tools/browser/console';
import {
  getIsolatedIndexMap,
  inPageGetIndexCropRect,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import {
  networkDebuggerStartTool,
  networkDebuggerStopTool,
} from '../entrypoints/background/tools/browser/network-capture-debugger';
import {
  networkCaptureStartTool,
  networkCaptureStopTool,
} from '../entrypoints/background/tools/browser/network-capture-web-request';
import { screenshotTool } from '../entrypoints/background/tools/browser/screenshot';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as raceCdpModule from '@/utils/race-cdp';
import { handleCallTool } from '../entrypoints/background/tools';

vi.mock('../entrypoints/background/tools', () => ({
  handleCallTool: vi.fn(),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeNativePort() {
  const messageListeners: Array<(message: any) => Promise<void> | void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((listener) => messageListeners.push(listener)),
      removeListener: vi.fn(),
    },
    onDisconnect: {
      addListener: vi.fn((listener) => disconnectListeners.push(listener)),
      removeListener: vi.fn(),
    },
    messageListeners,
    disconnectListeners,
  };
}

function stubNativeChrome(connectNative: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      connectNative,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      get: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      onRemoved: { addListener: vi.fn() },
      onCreated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
  });
}

describe('native-host port ownership and handshake recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.mocked(handleCallTool).mockReset();
  });

  it('ignores a delayed disconnect from a replaced port and keeps active calls alive', async () => {
    const oldPort = makeNativePort();
    const newPort = makeNativePort();
    const connectNative = vi.fn().mockReturnValueOnce(oldPort).mockReturnValueOnce(newPort);
    let finishPing!: (value: any) => void;
    const ping = new Promise((resolve) => {
      finishPing = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(ping));
    stubNativeChrome(connectNative);

    const activeTool = deferred<any>();
    let activeSignal: AbortSignal | undefined;
    vi.mocked(handleCallTool).mockImplementation(async (_payload, context) => {
      activeSignal = context?.signal;
      return activeTool.promise;
    });

    const nativeHost = await import('../entrypoints/background/native-host');
    expect(nativeHost.connectNativeHost(9011)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await nativeHost.ensureNativeConnected('test_replacement', 9011)).toBe(true);
    expect(oldPort.disconnect).toHaveBeenCalledTimes(1);
    expect(connectNative).toHaveBeenCalledTimes(2);

    const handleNewMessage = newPort.messageListeners[0];
    const activeCall = handleNewMessage({
      type: NativeMessageType.CALL_TOOL,
      requestId: 'active-call',
      payload: { name: 'test', args: {} },
    });
    await Promise.resolve();
    expect(activeSignal).toBeDefined();

    oldPort.disconnectListeners[0]();
    expect(activeSignal?.aborted).toBe(false);

    activeTool.resolve({ success: true });
    await activeCall;
    expect(newPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ responseToRequestId: 'active-call' }),
    );

    finishPing({ ok: false, status: 503, json: vi.fn() });
    await Promise.resolve();
  });

  it('disconnects a port that never completes SERVER_STARTED when /ping also fails', async () => {
    const wedgedPort = makeNativePort();
    const replacementPort = makeNativePort();
    const connectNative = vi
      .fn()
      .mockReturnValueOnce(wedgedPort)
      .mockReturnValueOnce(replacementPort);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: vi.fn() }));
    stubNativeChrome(connectNative);

    const nativeHost = await import('../entrypoints/background/native-host');
    expect(nativeHost.connectNativeHost(9012)).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(wedgedPort.disconnect).toHaveBeenCalledTimes(1);
    expect(nativeHost.connectNativeHost(9012)).toBe(true);
    expect(connectNative).toHaveBeenCalledTimes(2);
  });
});

describe('interaction outcome and contextmenu fallback', () => {
  const tabId = 9101;
  const tab = {
    id: tabId,
    windowId: 1,
    active: true,
    url: 'https://example.com/test',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension-id' },
      tabs: {
        get: vi.fn().mockResolvedValue(tab),
        query: vi.fn().mockResolvedValue([tab]),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
      },
    });
    vi.spyOn(interactIndexTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined);
  });

  it('reports an unknown non-retryable outcome after a sequence fails on point two', async () => {
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetScrollState') {
          return [
            { result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 } },
          ] as any;
        }
        if (fnName === 'inPageGetViewportCoordinates') {
          return [{ result: { x: 0, y: 0, width: 1280, height: 800 } }] as any;
        }
        return [{ result: { success: true, armed: true, delivered: true, missing: false } }] as any;
      },
    );

    let presses = 0;
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, _method, params: any) => {
      if (params?.type === 'mousePressed' && ++presses === 2) {
        throw new Error('CDP_DISPATCH_TIMEOUT');
      }
      return {} as any;
    });

    const execution = interactIndexTool.execute({
      tabId,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      intervalMs: 5,
      includeDelta: false,
      skipLock: true,
    });
    await vi.runAllTimersAsync();
    const result = await execution;
    const payload = JSON.parse(result.content[0].text as string);

    expect(payload).toMatchObject({
      status: 'unknown',
      requestDispatched: true,
      retry: false,
      action: 'click_sequence',
      pointsDispatched: 1,
    });
  });

  it.each([
    [true, 0],
    [false, 1],
  ])(
    'only synthesizes contextmenu when CDP delivery is %s-delivered',
    async (delivered, expectedSyntheticCalls) => {
      let syntheticCalls = 0;
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (_target: any, fnName: string) => {
          if (fnName === 'inPageGetScrollState') {
            return [
              { result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 } },
            ] as any;
          }
          if (fnName === 'inPageReadDeliveryProbe') {
            return [
              { result: { delivered, hits: delivered ? ['contextmenu'] : [], missing: false } },
            ] as any;
          }
          if (fnName === 'inPageDispatchSyntheticClick') syntheticCalls += 1;
          return [{ result: { success: true, armed: true } }] as any;
        },
      );
      vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);

      const execution = interactIndexTool.execute({
        tabId,
        coordinate: { x: 120, y: 140 },
        action: 'right_click',
        autoSnap: false,
        includeDelta: false,
        skipLock: true,
      });
      await vi.runAllTimersAsync();
      const result = await execution;

      expect(result.isError).toBe(false);
      expect(syntheticCalls).toBe(expectedSyntheticCalls);
    },
  );
});

describe('DOM crop geometry', () => {
  it('keeps a subframe element width when its top-level offset exceeds the subframe width', () => {
    const element = document.createElement('button');
    const frameElement = document.createElement('iframe');
    const fakeParent = { getComputedStyle: vi.fn().mockReturnValue({}) } as any;
    fakeParent.top = fakeParent;
    const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
    for (const key of ['innerWidth', 'top', 'parent', 'frameElement']) {
      originalDescriptors.set(key, Object.getOwnPropertyDescriptor(window, key));
    }

    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
      Object.defineProperty(window, 'top', { configurable: true, value: fakeParent });
      Object.defineProperty(window, 'parent', { configurable: true, value: fakeParent });
      Object.defineProperty(window, 'frameElement', { configurable: true, value: frameElement });
      element.scrollIntoView = vi.fn();
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        x: 350,
        y: 120,
        left: 350,
        top: 120,
        right: 410,
        bottom: 160,
        width: 60,
        height: 40,
        toJSON: () => ({}),
      });
      vi.spyOn(frameElement, 'getBoundingClientRect').mockReturnValue({
        x: 500,
        y: 300,
        left: 500,
        top: 300,
        right: 800,
        bottom: 600,
        width: 300,
        height: 300,
        toJSON: () => ({}),
      });
      getIsolatedIndexMap().set(1, element);
      document.body.appendChild(element);

      const result = inPageGetIndexCropRect(1);
      expect(result.rect).toMatchObject({ x: 850, width: 50 });
    } finally {
      for (const [key, descriptor] of originalDescriptors) {
        if (descriptor) Object.defineProperty(window, key, descriptor);
        else delete (window as any)[key];
      }
    }
  });
});

describe('screenshot tab binding', () => {
  it('uses target-bound CDP when the active tab changes before capture', async () => {
    const captureVisibleTab = vi.fn().mockResolvedValue('data:image/png;base64,visible');
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 2 }]),
        captureVisibleTab,
      },
    });
    const { cdpSessionManager: currentCdpSessionManager } =
      await import('@/utils/cdp-session-manager');
    vi.spyOn(currentCdpSessionManager, 'withSession').mockImplementation(
      async (_tabId, _caller, fn) => fn({} as any),
    );
    const sendCommand = vi
      .spyOn(currentCdpSessionManager, 'sendCommand')
      .mockResolvedValue({ data: 'target-bound' } as any);

    const dataUrl = await (screenshotTool as any).captureTabPng({
      id: 1,
      active: true,
      windowId: 7,
    });

    expect(dataUrl).toBe('data:image/png;base64,target-bound');
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledWith(1, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
  });
});

describe('network capture filters, retained results, and WebSocket caps', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
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
  });

  it('filters requestUrlPattern in both webRequest and debugger capture paths', () => {
    const webTool = networkCaptureStartTool as any;
    const debuggerTool = networkDebuggerStartTool as any;
    const webTabId = 9201;
    const debuggerTabId = 9202;
    const capture = {
      tabUrl: 'https://example.com',
      tabTitle: 'Example',
      startTime: Date.now(),
      requests: {},
      maxCaptureTime: 0,
      inactivityTimeout: 0,
      includeStatic: false,
      requestUrlPattern: '/\\/api\\//',
      limitReached: false,
    };

    webTool.captureData.set(webTabId, { ...capture, requests: {} });
    webTool.requestCounters.set(webTabId, 0);
    webTool.setupListeners(webTabId);
    const onBeforeRequest = (chrome.webRequest.onBeforeRequest.addListener as any).mock.calls[0][0];
    onBeforeRequest({
      tabId: webTabId,
      requestId: 'web-match',
      url: 'https://example.com/api/items',
      method: 'GET',
      type: 'xmlhttprequest',
      timeStamp: 1,
    });
    onBeforeRequest({
      tabId: webTabId,
      requestId: 'web-miss',
      url: 'https://example.com/public',
      method: 'GET',
      type: 'xmlhttprequest',
      timeStamp: 2,
    });

    debuggerTool.captureData.set(debuggerTabId, {
      ...capture,
      requests: {},
      webSockets: {},
      webSocketFrameCount: 0,
    });
    debuggerTool.handleRequestWillBeSent(debuggerTabId, {
      requestId: 'debugger-match',
      request: { url: 'https://example.com/api/items', method: 'GET', headers: {} },
      timestamp: 1,
      type: 'XHR',
    });
    debuggerTool.handleRequestWillBeSent(debuggerTabId, {
      requestId: 'debugger-miss',
      request: { url: 'https://example.com/public', method: 'GET', headers: {} },
      timestamp: 2,
      type: 'XHR',
    });

    expect(Object.keys(webTool.captureData.get(webTabId).requests)).toEqual(['web-match']);
    expect(Object.keys(debuggerTool.captureData.get(debuggerTabId).requests)).toEqual([
      'debugger-match',
    ]);
    webTool.cleanupCapture(webTabId);
    debuggerTool.cleanupCapture(debuggerTabId);
  });

  it.each(['web', 'debugger'])(
    'lets stop consume an auto-stopped terminal result once for %s capture',
    async (kind) => {
      const tabId = kind === 'web' ? 9211 : 9212;
      const tool =
        kind === 'web' ? (networkCaptureStartTool as any) : (networkDebuggerStartTool as any);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      tool.captureData.set(tabId, {
        tabUrl: 'https://example.com',
        tabTitle: 'Example',
        startTime: Date.now() - 10,
        requests: {
          request: {
            requestId: 'request',
            url: 'https://example.com/api/items',
            method: 'GET',
            type: 'XHR',
            requestTime: 1,
            status: 'complete',
          },
        },
        maxCaptureTime: 100,
        inactivityTimeout: 100,
        includeStatic: false,
        limitReached: false,
        webSockets: {},
        webSocketFrameCount: 0,
      });
      tool.requestCounters.set(tabId, 1);

      if (kind === 'web') {
        await tool.stopCapture(tabId, 'inactivity_timeout');
      } else {
        await tool.stopCapture(tabId, true, 'max_capture_time');
      }

      const stopTool = kind === 'web' ? networkCaptureStopTool : networkDebuggerStopTool;
      const first = await stopTool.execute({ tabId });
      const firstPayload = JSON.parse(first.content[0].text as string);
      const second = await stopTool.execute({ tabId });

      expect(first.isError).toBe(false);
      expect(firstPayload).toMatchObject({
        success: true,
        requestCount: 1,
        autoStopped: true,
        stoppedReason: kind === 'web' ? 'inactivity_timeout' : 'max_capture_time',
      });
      expect(second.isError).toBe(true);
    },
  );

  it('enforces global WebSocket connection and frame caps', () => {
    const tool = networkDebuggerStartTool as any;
    const tabId = 9221;
    tool.captureData.set(tabId, {
      startTime: Date.now(),
      requests: {},
      webSockets: {},
      webSocketFrameCount: 0,
      webSocketFramesTruncated: 0,
      webSocketConnectionsTruncated: 0,
      inactivityTimeout: 0,
      includeStatic: false,
      limitReached: false,
    });

    for (let i = 0; i < 105; i++) {
      tool.handleWebSocketCreated(tabId, {
        requestId: `ws-${i}`,
        url: `wss://example.com/${i}`,
      });
    }
    expect(Object.keys(tool.captureData.get(tabId).webSockets)).toHaveLength(100);
    expect(tool.captureData.get(tabId).webSocketConnectionsTruncated).toBe(5);

    for (let connection = 0; connection < 100; connection++) {
      for (let frame = 0; frame < 20; frame++) {
        tool.handleWebSocketFrame(
          tabId,
          {
            requestId: `ws-${connection}`,
            response: { opcode: 1, payloadData: `${connection}:${frame}` },
            timestamp: frame,
          },
          'received',
        );
      }
    }
    tool.handleWebSocketFrame(
      tabId,
      { requestId: 'ws-0', response: { opcode: 1, payloadData: 'overflow' } },
      'received',
    );

    const capture = tool.captureData.get(tabId);
    expect(capture.webSocketFrameCount).toBe(2000);
    expect(capture.webSocketFramesTruncated).toBe(1);
    expect(capture.webSockets['ws-0'].framesTruncated).toBe(true);
    tool.cleanupCapture(tabId);
  });
});

describe('console snapshot truncation', () => {
  it('enforces maxMessages during waitMs and reports dropped entries', async () => {
    vi.useFakeTimers();
    const tabId = 9301;
    const addListener = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: tabId,
          url: 'https://example.com',
          title: 'Example',
        }),
      },
      debugger: {
        onEvent: { addListener, removeListener: vi.fn() },
      },
    });
    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);
    vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);

    const capture = (consoleTool as any).captureConsoleMessages(tabId, {
      includeExceptions: true,
      maxMessages: 2,
      waitMs: 100,
    });
    for (let turn = 0; turn < 10 && addListener.mock.calls.length === 0; turn++) {
      await Promise.resolve();
    }
    const listener = addListener.mock.calls[0][0];
    for (let index = 0; index < 4; index++) {
      listener(
        { tabId },
        'Log.entryAdded',
        {
          entry: {
            timestamp: index,
            level: 'log',
            text: `message-${index}`,
            source: 'javascript',
          },
        },
        {},
      );
    }

    await vi.advanceTimersByTimeAsync(100);
    const result = await capture;

    expect(result).toMatchObject({
      messageCount: 2,
      droppedMessageCount: 2,
      messageLimitReached: true,
      truncated: true,
    });
  });
});

afterEach(() => {
  getIsolatedIndexMap().clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
