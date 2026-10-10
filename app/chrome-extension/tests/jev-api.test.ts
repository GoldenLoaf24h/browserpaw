import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getServerConnection, jevFetch } from '../entrypoints/popup/jev-api';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { STORAGE_KEYS } from '@/common/constants';

describe('Popup Jev API Client Helper (§1 - BUG-13 & W1)', () => {
  const originalFetch = globalThis.fetch;
  let mockStorage: Record<string, any> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = {};
    (globalThis as any).chrome = {
      runtime: {
        lastError: null,
        sendMessage: vi.fn().mockImplementation((msg: any, cb: (res: any) => void) => {
          if (msg.type === BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS) {
            cb({
              success: true,
              serverStatus: {
                isRunning: true,
                port: 19999,
                token: 'mock-test-token-12345678',
              },
            });
          } else {
            cb(null);
          }
        }),
      },
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (keys: string[]) => {
            const out: Record<string, any> = {};
            for (const k of keys) {
              out[k] = mockStorage[k];
            }
            return out;
          }),
        },
      },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('1. Resolves port and token from background GET_SERVER_STATUS message', async () => {
    const conn = await getServerConnection(true);
    expect(conn.port).toBe(19999);
    expect(conn.token).toBe('mock-test-token-12345678');
  });

  it('2. Injects Authorization Bearer token and resolved port into jevFetch requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    });
    globalThis.fetch = fetchMock as any;

    await jevFetch('/jev/model-status');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://127.0.0.1:19999/jev/model-status');
    const headers = new Headers(calledInit?.headers);
    expect(headers.get('Authorization')).toBe('Bearer mock-test-token-12345678');
  });

  it('3. Falls back to chrome.storage.local if background message returns null', async () => {
    (globalThis as any).chrome.runtime.sendMessage = vi.fn().mockImplementation((msg: any, cb: (res: any) => void) => {
      cb(null);
    });
    mockStorage[STORAGE_KEYS.SERVER_STATUS] = {
      port: 18888,
      token: 'storage-fallback-token',
    };

    const conn = await getServerConnection(true);
    expect(conn.port).toBe(18888);
    expect(conn.token).toBe('storage-fallback-token');
  });
});

