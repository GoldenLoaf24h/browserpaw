import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * E-14: the `forward_to_native` handler must surface safePostMessage's boolean
 * result instead of unconditionally reporting `success: true`. These tests drive
 * the REAL onMessage listener registered by initNativeHostListener and the REAL
 * safePostMessage helper (never mocked) against a connected native port.
 */

type MessageListener = (
  message: any,
  sender: any,
  sendResponse: (response: any) => void,
) => unknown;

let nativeHost: typeof import('../entrypoints/background/native-host');

function makePort(overrides: Record<string, any> = {}) {
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    ...overrides,
  } as any;
}

async function loadListener(port: any, connect: boolean): Promise<MessageListener> {
  const runtime = chrome.runtime as any;
  runtime.connectNative = vi.fn().mockReturnValue(port);
  if (connect) {
    nativeHost.connectNativeHost(12345);
    port.postMessage.mockClear(); // Drop the START handshake sent on connect
  }
  (chrome.runtime.onMessage.addListener as any).mockClear();
  nativeHost.initNativeHostListener();
  const calls = (chrome.runtime.onMessage.addListener as any).mock.calls;
  return calls[calls.length - 1][0] as MessageListener;
}

// A sender that passes the trust boundary at native-host.ts:717-721.
const trustedSender = () => ({ id: chrome.runtime.id });

describe('E-14: forward_to_native reports the real delivery outcome', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.resetModules();
    const runtime = chrome.runtime as any;
    runtime.onStartup ??= { addListener: vi.fn(), removeListener: vi.fn() };
    runtime.onInstalled ??= { addListener: vi.fn(), removeListener: vi.fn() };
    // Background graph loading is setup; delivery assertions below are synchronous.
    nativeHost = await import('../entrypoints/background/native-host');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports success: true only when the message is actually posted', async () => {
    const port = makePort();
    const listener = await loadListener(port, true);
    const sendResponse = vi.fn();

    const returned = listener(
      { type: 'forward_to_native', message: { hello: 'world' } },
      trustedSender(),
      sendResponse,
    );

    expect(returned).toBe(true);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('does not dispatch a semantic request when the mirrored mode is off', async () => {
    const port = makePort();
    await loadListener(port, true);
    vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({ jevEngineMode: 'off' });
    const result = await nativeHost.sendJevMatchToNative({ query: 'Email', candidates: [] });
    expect(result).toMatchObject({ success: false, reason: 'jev_disabled' });
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('mirrors an authoritative automatic-off notification into extension storage', async () => {
    const port = makePort();
    await loadListener(port, true);
    const set = vi.spyOn(chrome.storage.local, 'set').mockResolvedValue();
    const listener = port.onMessage.addListener.mock.calls[0][0];
    const state = {
      activeMode: 'off',
      revision: 8,
      disabledReason: 'network_error',
      changedAt: 100,
    };
    await listener({ type: 'jev_mode_state', payload: state });
    expect(set).toHaveBeenCalledWith({ jevModeState: state, jevEngineMode: 'off' });
  });

  it('allows a new semantic request after cooldown but never overrides manual off', async () => {
    vi.setSystemTime(1000);
    const port = makePort();
    await loadListener(port, true);
    const listener = port.onMessage.addListener.mock.calls[0][0];
    const state = { activeMode: 'off', requestedMode: 'remote', retryAfter: 1100, revision: 8 };
    vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({ jevModeState: state });
    await listener({ type: 'jev_mode_state', payload: state });
    expect(nativeHost.isJevSemanticEnabled()).toBe(false);
    vi.advanceTimersByTime(100);
    expect(nativeHost.isJevSemanticEnabled()).toBe(true);
    const controller = new AbortController();
    const pending = nativeHost.sendJevMatchToNative(
      { query: 'Email', candidates: [{ id: 'a', text: 'Email' }] },
      1500,
      { signal: controller.signal },
    );
    await Promise.resolve();
    expect(port.postMessage.mock.calls.some(([m]: any[]) => m.type === 'jev_semantic_match')).toBe(
      true,
    );
    controller.abort();
    await pending;
    await listener({
      type: 'jev_mode_state',
      payload: { ...state, requestedMode: 'off', revision: 9 },
    });
    expect(nativeHost.isJevSemanticEnabled()).toBe(false);
  });

  it('cancels a semantic request once and ignores its late successful reply', async () => {
    const port = makePort();
    await loadListener(port, true);
    vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({ jevEngineMode: 'remote' });
    const controller = new AbortController();
    const pending = nativeHost.sendJevMatchToNative(
      { query: 'Email', candidates: [{ id: 'a', text: 'Email' }] },
      1500,
      { signal: controller.signal },
    );
    await Promise.resolve();
    const request = port.postMessage.mock.calls.find(
      ([msg]: any[]) => msg.type === 'jev_semantic_match',
    )?.[0];
    expect(request).toBeTruthy();
    controller.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', success: false });
    vi.spyOn(chrome.runtime, 'sendMessage').mockResolvedValue(undefined);
    const listener = port.onMessage.addListener.mock.calls[0][0];
    await listener({
      type: 'file_operation_response',
      responseToRequestId: request.requestId,
      payload: { success: true, matchedId: 'a' },
    });
    expect(
      port.postMessage.mock.calls.filter(
        ([msg]: any[]) => msg.type === 'cancel_jev_semantic_match',
      ),
    ).toHaveLength(1);
  });

  it('reports success: false when the port is disconnected (postMessage throws)', async () => {
    const port = makePort({
      postMessage: vi.fn(() => {
        throw new Error('Attempting to use a disconnected port object');
      }),
    });
    const listener = await loadListener(port, true);
    const sendResponse = vi.fn();

    listener(
      { type: 'forward_to_native', message: { hello: 'world' } },
      trustedSender(),
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ success: false });
    expect(sendResponse.mock.calls[0][0].error).toBeTruthy();
  });

  it('reports success: false when the message fails serialization', async () => {
    const port = makePort();
    const listener = await loadListener(port, true);
    const sendResponse = vi.fn();

    // BigInt is not JSON-serializable: safePostMessage returns false at its catch.
    listener({ type: 'forward_to_native', message: { huge: 1n } }, trustedSender(), sendResponse);

    expect(port.postMessage).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0][0]).toMatchObject({ success: false });
    expect(sendResponse.mock.calls[0][0].error).toBeTruthy();
  });

  it('reports success: false when no native port is connected', async () => {
    const listener = await loadListener(makePort(), false);
    const sendResponse = vi.fn();

    listener(
      { type: 'forward_to_native', message: { hello: 'world' } },
      trustedSender(),
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Native host not connected',
    });
  });

  it('keeps the _sender.id / _sender.tab trust boundary (no relaxation)', async () => {
    const port = makePort();
    const listener = await loadListener(port, true);

    const fromContentScript = vi.fn();
    expect(
      listener(
        { type: 'forward_to_native', message: { hello: 'world' } },
        { id: chrome.runtime.id, tab: { id: 7 } },
        fromContentScript,
      ),
    ).toBe(false);
    expect(fromContentScript).not.toHaveBeenCalled();

    const fromForeignExtension = vi.fn();
    expect(
      listener(
        { type: 'forward_to_native', message: { hello: 'world' } },
        { id: 'someone-else' },
        fromForeignExtension,
      ),
    ).toBe(false);
    expect(fromForeignExtension).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});
