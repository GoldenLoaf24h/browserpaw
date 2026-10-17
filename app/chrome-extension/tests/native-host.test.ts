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
  vi.resetModules();
  const runtime = chrome.runtime as any;
  runtime.connectNative = vi.fn().mockReturnValue(port);
  // The shared vitest setup does not stub these lifecycle events.
  runtime.onStartup ??= { addListener: vi.fn(), removeListener: vi.fn() };
  runtime.onInstalled ??= { addListener: vi.fn(), removeListener: vi.fn() };
  const mod = await import('../entrypoints/background/native-host');
  if (connect) {
    mod.connectNativeHost(12345);
    port.postMessage.mockClear(); // Drop the START handshake sent on connect
  }
  (chrome.runtime.onMessage.addListener as any).mockClear();
  mod.initNativeHostListener();
  const calls = (chrome.runtime.onMessage.addListener as any).mock.calls;
  return calls[calls.length - 1][0] as MessageListener;
}

// A sender that passes the trust boundary at native-host.ts:717-721.
const trustedSender = () => ({ id: chrome.runtime.id });

describe('E-14: forward_to_native reports the real delivery outcome', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
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
