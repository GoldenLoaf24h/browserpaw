import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import nativeHost from '../native-messaging-host';
import { callToolInternal } from './register-tools';

jest.mock('../native-messaging-host', () => ({
  __esModule: true,
  default: { sendRequestToExtensionAndWait: jest.fn() },
}));

const send = jest.mocked(nativeHost.sendRequestToExtensionAndWait);
const response = (payload: unknown) => ({
  status: 'success',
  data: {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  },
});

describe('atomic download source compatibility', () => {
  beforeEach(() => {
    send.mockReset();
  });

  it('checks the extension capability before forwarding a compound click', async () => {
    send.mockResolvedValue(response({ browserInstanceId: 'old', windows: [] }));
    await expect(
      callToolInternal('chrome_handle_download', { tabId: 31, clickTargetIndex: 7 }),
    ).rejects.toMatchObject({ requestDispatched: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ name: 'get_windows_and_tabs' });
  });

  it('rejects an unscoped reply after a capability check without repeating the trigger', async () => {
    send
      .mockResolvedValueOnce(response({ capabilities: { sourceDownloads: true } }))
      .mockResolvedValueOnce(
        response({ success: true, download: { id: 999, filename: 'user.txt' } }),
      );
    const result = await callToolInternal('chrome_handle_download', {
      tabId: 31,
      clickTargetIndex: 7,
    });
    expect(result.isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).toContain('unknown');
    expect(JSON.stringify(result)).toContain('user.txt');
  });

  it('keeps explicitly browser-wide legacy callers compatible', async () => {
    send.mockResolvedValue(response({ success: true, download: { id: 4 } }));
    const result = await callToolInternal('chrome_handle_download', { filenameContains: 'legacy' });
    expect(result.isError).not.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
