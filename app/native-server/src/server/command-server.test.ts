import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { commandHelp, parseCommand } from 'chrome-mcp-shared';

const directory = mkdtempSync(join(tmpdir(), 'browserpaw-command-test-'));
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  homedir: () => directory,
}));

import { Server, getBridgeToken } from './index';
import type { NativeMessagingHost } from '../native-messaging-host';
import { dispatchCommand } from '../command-dispatch';
import { BrowserTaskManager, type BrowserCall } from '../browser-tasks';
import { runCommands } from '../command-client';
import { writeFileSync } from 'node:fs';

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

  it('normalizes numeric tab locks so 01 and 1 serialize together', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatch.mockClear();
    dispatch.mockImplementationOnce(async () => {
      entered();
      await pending;
      return { content: [] };
    });
    const first = post(['click', '4', '--tab', '01']);
    try {
      await started;
      expect((await post(['click', '4', '--tab', '1'])).status).toBe(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
  });

  it('parses inline option values and keeps unknown or boolean flags rejected', () => {
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
    expect(parseCommand(['console', '--level', 'error']).options.level).toBe('error');
    expect(() => parseCommand(['click', '4', '--json=true'])).toThrow('does not take a value');
    expect(() => parseCommand(['click', '4', '--unknown=value'])).toThrow('Unknown option');
  });

  it('documents command-specific filter semantics', () => {
    expect(commandHelp('console')).toContain('--level error');
    expect(commandHelp('open')).toContain('--foreground applies only to non-task opens');
    expect(commandHelp('network start')).toContain('--filter matches captured request URLs');
  });

  it('stops the host server after reload_extension and retries transient EADDRINUSE on startup', async () => {
    const holder = new Server();
    const sendRequestToExtensionAndWait = jest.fn(async () => ({ status: 'success' }));
    const holderHost = {
      isConnected: true,
      sendRequestToExtensionAndWait,
    } as unknown as NativeMessagingHost;
    await holder.start(0, holderHost);
    const port = holder.port!;

    const replacement = new Server();
    const replacementStart = replacement.start(port, host);
    const restartResponse = await fetch(`http://127.0.0.1:${port}/v1/restart`, {
      method: 'POST',
      headers: { 'x-browserpaw-token': getBridgeToken() },
    });
    expect(restartResponse.status).toBe(202);

    await replacementStart;
    try {
      expect(sendRequestToExtensionAndWait).toHaveBeenCalledWith({}, 'reload_extension', 2000);
      expect(holder.isRunning).toBe(false);
      expect(replacement.isRunning).toBe(true);
      expect(replacement.port).toBe(port);
    } finally {
      await replacement.stop();
      await holder.stop();
    }
  });

  it('keeps CLI task list compact inline without leaking page or download URLs', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'browserpaw-cli-task-list-'));
    const tasks: Record<string, Record<string, unknown>> = {};
    for (let i = 1; i <= 35; i++) {
      tasks[`task-${i}`] = {
        id: `task-${i}`,
        name: `Task ${i}`,
        status: i === 1 ? 'active' : 'finished',
        maxPages: 8,
        currentTabId: 100 + i,
        createdAt: i * 10,
        updatedAt: i * 10,
        ...(i === 1 ? {} : { finishedAt: i * 10 }),
        pages: [
          {
            tabId: 100 + i,
            url: `https://oauth.example.test/cb?access_token=secret-${i}-${'x'.repeat(200)}`,
            documentId: `doc-${i}`,
            browserInstanceId: 'browser-1',
            ownership: 'owned',
            state: i === 1 ? 'active' : 'closed',
            openedAt: i * 10,
            lastVerifiedAt: i * 10,
          },
        ],
        pendingCreations: [],
        downloads: [
          {
            downloadId: i,
            url: `https://dl.example.test/file-${i}.zip?token=dl-secret-${i}`,
            filename: `file-${i}.zip`,
            state: 'complete',
            browserInstanceId: 'browser-1',
          },
        ],
      };
    }
    writeFileSync(join(storageDir, 'tasks.json'), JSON.stringify({ version: 1, tasks }, null, 2));

    const manager = new BrowserTaskManager({ call: jest.fn<BrowserCall>(), storageDir });
    dispatch.mockImplementationOnce(async () => {
      const listed = await manager.execute({ action: 'list' });
      return { content: [{ type: 'text', text: JSON.stringify(listed) }], isError: !listed.ok };
    });

    const prevHome = process.env.BROWSERPAW_HOME;
    const prevPort = process.env.BROWSERPAW_PORT;
    const prevNoUpdate = process.env.BROWSERPAW_NO_UPDATE_CHECK;
    process.env.BROWSERPAW_HOME = join(directory, '.browserpaw');
    process.env.BROWSERPAW_PORT = String(server.port);
    process.env.BROWSERPAW_NO_UPDATE_CHECK = '1';
    const stdout: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.map(String).join(' '));
    });
    try {
      const code = await runCommands(['task', 'list', '--json']);
      expect(code).toBe(0);
      expect(stdout).toHaveLength(1);
      const raw = stdout[0]!;
      expect(raw.length).toBeLessThan(8000);
      expect(raw).not.toContain('access_token=');
      expect(raw).not.toContain('dl-secret-');
      const receipt = JSON.parse(raw) as {
        ok: boolean;
        data: { tasks?: Array<Record<string, unknown>>; resultPath?: string };
      };
      expect(receipt.ok).toBe(true);
      expect(receipt.data.resultPath).toBeUndefined();
      expect(receipt.data.tasks).toHaveLength(31);
      expect(receipt.data.tasks?.[0]).not.toHaveProperty('pages');
      expect(receipt.data.tasks?.[0]).not.toHaveProperty('downloads');
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.BROWSERPAW_HOME;
      else process.env.BROWSERPAW_HOME = prevHome;
      if (prevPort === undefined) delete process.env.BROWSERPAW_PORT;
      else process.env.BROWSERPAW_PORT = prevPort;
      if (prevNoUpdate === undefined) delete process.env.BROWSERPAW_NO_UPDATE_CHECK;
      else process.env.BROWSERPAW_NO_UPDATE_CHECK = prevNoUpdate;
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
