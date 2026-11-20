import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { NativeMessageType, commandLockKey, parseCommand } from 'chrome-mcp-shared';
import { callToolInternal } from './browser-dispatch';
import nativeHost, { NativeMessagingHost } from './native-messaging-host';

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('native messaging cancellation', () => {
  it('sends CANCEL_TOOL before timing out and removes the pending request', async () => {
    jest.useFakeTimers();
    const host = new NativeMessagingHost();
    host.isConnected = true;
    const send = jest.spyOn(host, 'sendMessage').mockImplementation(() => undefined);
    const rejected = host
      .sendRequestToExtensionAndWait({}, NativeMessageType.CALL_TOOL, 1000)
      .catch((error: unknown) => error);

    jest.advanceTimersByTime(1000);
    const error = await rejected;

    expect(error).toMatchObject({ requestDispatched: true });
    expect(send.mock.calls.map(([message]) => message.type)).toEqual([
      NativeMessageType.CALL_TOOL,
      NativeMessageType.CANCEL_TOOL,
    ]);
    const requestId = send.mock.calls[0][0].requestId;
    expect(send.mock.calls[1][0].payload).toEqual({ requestId });
    expect((host as any).pendingRequests.size).toBe(0);
  });

  it('bounds post-dispatch cancellation acknowledgement to five seconds', async () => {
    jest.useFakeTimers();
    const host = new NativeMessagingHost();
    host.isConnected = true;
    const controller = new AbortController();
    const send = jest.spyOn(host, 'sendMessage').mockImplementation(() => undefined);
    const rejected = host
      .sendRequestToExtensionAndWait({}, NativeMessageType.CALL_TOOL, 120000, controller.signal)
      .catch((error: unknown) => error);

    controller.abort();
    jest.advanceTimersByTime(4999);
    expect((host as any).pendingRequests.size).toBe(1);
    jest.advanceTimersByTime(1);
    const error = await rejected;

    expect(error).toMatchObject({
      requestDispatched: true,
      code: 'cancellation_unacknowledged',
    });
    expect(send.mock.calls.map(([message]) => message.type)).toEqual([
      NativeMessageType.CALL_TOOL,
      NativeMessageType.CANCEL_TOOL,
    ]);
    expect((host as any).pendingRequests.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the grace timer when Chrome acknowledges cancellation', async () => {
    jest.useFakeTimers();
    const host = new NativeMessagingHost();
    host.isConnected = true;
    const controller = new AbortController();
    const send = jest.spyOn(host, 'sendMessage').mockImplementation(() => undefined);
    const response = host.sendRequestToExtensionAndWait(
      {},
      NativeMessageType.CALL_TOOL,
      120000,
      controller.signal,
    );

    controller.abort();
    const requestId = send.mock.calls[0][0].requestId;
    await (host as any).handleMessage({
      responseToRequestId: requestId,
      error: 'cancelled',
    });

    await expect(response).rejects.toThrow('cancelled');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('browser transport timeout stretching', () => {
  it('honors explicit timeout and timeoutMs values up to the 300s cap', async () => {
    const wasConnected = nativeHost.isConnected;
    nativeHost.isConnected = true;
    const send = jest
      .spyOn(nativeHost, 'sendRequestToExtensionAndWait')
      .mockResolvedValue({ status: 'success', data: { content: [] } });

    await callToolInternal('chrome_javascript', { code: '1', timeout: 180000 }, undefined, 120000);
    expect(send.mock.calls[0][2]).toBe(210000);

    await callToolInternal(
      'chrome_request_human_intervention',
      { reason: 'Continue', timeoutMs: 300000 },
      undefined,
      120000,
    );
    expect(send.mock.calls[1][2]).toBe(330000);

    nativeHost.isConnected = wasConnected;
  });
});

it('normalizes numeric tab lock keys', () => {
  expect(commandLockKey(parseCommand(['click', '4', '--tab', '01']).options)).toBe('tab:1');
  expect(commandLockKey(parseCommand(['click', '4', '--tab', '1']).options)).toBe('tab:1');
});

it('parses inline option values without consuming option-like values as flags', () => {
  const parsed = parseCommand([
    'fetch',
    'https://example.com',
    '--method=POST',
    '--body=--literal',
    '--tab=01',
  ]);

  expect(parsed.options).toMatchObject({
    method: 'POST',
    body: '--literal',
    tab: '01',
  });
});
