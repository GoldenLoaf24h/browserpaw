import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'browserpaw-command-test-'));
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  homedir: () => directory,
}));

import { Server, getBridgeToken } from './index';
import type { NativeMessagingHost } from '../native-messaging-host';
import { dispatchCommand } from '../command-dispatch';

jest.mock('../command-dispatch', () => ({
  ...jest.requireActual<typeof import('../command-dispatch')>('../command-dispatch'),
  dispatchCommand: jest.fn(),
}));

const dispatch = jest.mocked(dispatchCommand);

describe('CLI host transport', () => {
  const server = new Server();
  const host = { isConnected: true } as NativeMessagingHost;
  const post = (argv: string[], requestId = randomUUID()) =>
    fetch(`http://127.0.0.1:${server.port}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-browserpaw-token': getBridgeToken() },
      body: JSON.stringify({ requestId, argv }),
    });

  beforeAll(async () => server.start(0, host));
  afterAll(async () => {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it('requires the local token and exposes no MCP transport', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(base + '/ping')).status).toBe(200);
    expect((await fetch(base + '/v1/status')).status).toBe(401);
    for (const route of ['/mcp', '/sse', '/messages', '/eval', '/call-tool']) {
      expect(
        (await fetch(base + route, { headers: { 'x-browserpaw-token': getBridgeToken() } })).status,
      ).toBe(404);
    }
    expect((await post(['chrome_navigate'])).status).toBe(400);
  });

  it('preserves uncertain outcomes and rejects a concurrent command on the same page', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatch.mockImplementationOnce(async () => {
      entered();
      await pending;
      return { content: [], structuredContent: { status: 'unknown', retry: false }, isError: true };
    });
    const first = post(['click', '4', '--tab', '9']);
    try {
      await started;
      expect((await post(['click', '4', '--tab', '9'])).status).toBe(409);
    } finally {
      release();
    }
    expect(await (await first).json()).toMatchObject({
      result: { isError: true, structuredContent: { status: 'unknown', retry: false } },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
