import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as token from '../server/token';
import { checkBridgeCredentials } from './doctor';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('doctor credentials', () => {
  it('reports missing credentials without making a request or initializing them', async () => {
    jest.spyOn(token, 'readBridgeToken').mockImplementation(() => {
      throw new Error('credential missing');
    });
    const initialize = jest.spyOn(token, 'initializeBridgeToken');
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const checks = await checkBridgeCredentials();
    expect(checks[0].status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it.each([401, 500])(
    'rejects HTTP %s without reporting a successful handshake',
    async (status) => {
      const secret = 'a'.repeat(64);
      jest.spyOn(token, 'readBridgeToken').mockReturnValue(secret);
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{"error":"rejected"}', { status }));
      const checks = await checkBridgeCredentials();
      expect(checks[1].status).toBe('error');
      expect(JSON.stringify(checks)).not.toContain(secret);
    },
  );

  it('accepts an SSE handshake and cleans up the diagnostic session', async () => {
    jest.spyOn(token, 'readBridgeToken').mockReturnValue('a'.repeat(64));
    const request = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('event: message\ndata: {"result":{"serverInfo":{"name":"BrowserPaw"}}}\n\n', {
          headers: { 'mcp-session-id': 'doctor-session' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const checks = await checkBridgeCredentials();
    expect(checks.every((check) => check.status === 'ok')).toBe(true);
    expect(request.mock.calls[1][1]?.method).toBe('DELETE');
  });
});
