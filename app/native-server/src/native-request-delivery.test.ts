import { describe, expect, jest, test } from '@jest/globals';
import { NativeMessagingHost } from './native-messaging-host';

describe('Native request delivery evidence', () => {
  test('disconnected requests are rejected before sending', async () => {
    const host = new NativeMessagingHost();
    const send = jest.spyOn(host, 'sendMessage').mockImplementation(() => undefined);
    await expect(host.sendRequestToExtensionAndWait({})).rejects.toMatchObject({
      requestDispatched: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('an already cancelled request is rejected before sending', async () => {
    const host = new NativeMessagingHost();
    host.isConnected = true;
    const send = jest.spyOn(host, 'sendMessage').mockImplementation(() => undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.sendRequestToExtensionAndWait({}, 'call_tool', 1000, controller.signal),
    ).rejects.toMatchObject({ requestDispatched: false });
    expect(send).not.toHaveBeenCalled();
  });

  test('unserializable requests are rejected before sending', async () => {
    const host = new NativeMessagingHost();
    host.isConnected = true;
    const send = jest.spyOn(host, 'sendMessage').mockImplementation(() => undefined);
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    await expect(host.sendRequestToExtensionAndWait(payload)).rejects.toMatchObject({
      requestDispatched: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('a response timeout proves one request attempt, not a physical action', async () => {
    jest.useFakeTimers();
    try {
      const host = new NativeMessagingHost();
      host.isConnected = true;
      const send = jest.spyOn(host, 'sendMessage').mockImplementation(() => undefined);
      const rejected = host
        .sendRequestToExtensionAndWait({}, 'call_tool', 1000)
        .catch((error: unknown) => error);
      jest.advanceTimersByTime(1000);
      const error = await rejected;
      expect(error).toMatchObject({ requestDispatched: true });
      expect(error).not.toHaveProperty('dispatched');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
