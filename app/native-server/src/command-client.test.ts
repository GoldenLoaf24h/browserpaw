import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GITHUB_REPO_URL, isCompatibleExtensionVersion } from 'chrome-mcp-shared';

async function startHttpServer(
  handler: RequestListener,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP port');
  return { server, port: address.port };
}

describe('Extension version compatibility and CLI status reporting', () => {
  let homeDir: string;
  let servers: Server[];

  beforeEach(() => {
    servers = [];
    homeDir = mkdtempSync(join(tmpdir(), 'browserpaw-cmdclient-'));
    jest.replaceProperty(process, 'env', {
      ...process.env,
      BROWSERPAW_HOME: homeDir,
      BROWSERPAW_NO_UPDATE_CHECK: '1',
      BROWSERPAW_NO_AUTO_UPDATE: '1',
    });
  });

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    jest.dontMock('chrome-mcp-shared');
    jest.resetModules();
    jest.restoreAllMocks();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('evaluates isCompatibleExtensionVersion across matching, patch-skew, floor, and major-mismatch pairs', () => {
    expect(isCompatibleExtensionVersion('5.0.0', '5.0.0')).toBe(true);
    expect(isCompatibleExtensionVersion('5.0.1', '5.0.0')).toBe(true);
    expect(isCompatibleExtensionVersion('5.0.0', '5.0.1')).toBe(true);
    expect(isCompatibleExtensionVersion('4.9.0', '5.0.0')).toBe(false);
    expect(isCompatibleExtensionVersion('6.0.0', '5.0.1')).toBe(false);
    expect(isCompatibleExtensionVersion('5.0.0', '6.0.0')).toBe(false);
    expect(isCompatibleExtensionVersion('5.0.0', '5.1.0', '5.1.0')).toBe(false);
    expect(isCompatibleExtensionVersion(undefined, '5.0.0')).toBe(false);
    expect(isCompatibleExtensionVersion('invalid', '5.0.0')).toBe(false);
  });

  it('succeeds in status with a compatible older extension (5.0.0 vs 5.0.1 CLI) and reports extensionUpdateAvailable', async () => {
    const token = 'b'.repeat(64);
    writeFileSync(join(homeDir, 'token'), token, { mode: 0o600 });

    let reportedExtensionVersion = '5.0.0';
    const fakeHost = await startHttpServer((req, res) => {
      if (req.headers['x-browserpaw-token'] !== token) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocol: 1,
            version: '5.0.1',
            connected: true,
            pid: process.pid,
            port: fakeHost.port,
            extension: { manifestVersion: reportedExtensionVersion },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(fakeHost.server);
    writeFileSync(
      join(homeDir, 'host.json'),
      JSON.stringify({ port: fakeHost.port, pid: process.pid, version: '5.0.1', protocol: 1 }),
    );

    const stdout: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.map(String).join(' '));
    });

    const actualShared =
      jest.requireActual<typeof import('chrome-mcp-shared')>('chrome-mcp-shared');
    jest.resetModules();
    jest.doMock('chrome-mcp-shared', () => ({
      ...actualShared,
      CURRENT_VERSION: '5.0.1',
    }));
    const { runCommands } = await import('./command-client');

    const exitCode = await runCommands(['status', '--json']);
    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout[0]!) as {
      ok: boolean;
      data: {
        extensionUpdateAvailable?: boolean;
        extensionLatestVersion?: string;
        extensionReleaseAsset?: string;
      };
    };
    expect(receipt.ok).toBe(true);
    expect(receipt.data.extensionUpdateAvailable).toBe(true);
    expect(receipt.data.extensionLatestVersion).toBe('5.0.1');
    expect(receipt.data.extensionReleaseAsset).toBe(
      `${GITHUB_REPO_URL}/releases/download/v5.0.1/browserpaw-extension.zip`,
    );

    // Incompatible older extension still fails with version_mismatch
    stdout.length = 0;
    reportedExtensionVersion = '4.9.0';
    const mismatchExit = await runCommands(['status', '--json']);
    expect(mismatchExit).toBe(3);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      ok: false,
      error: { code: 'version_mismatch' },
    });
  });
});
