import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CURRENT_VERSION, GITHUB_REPO_URL, type CallToolResult } from 'chrome-mcp-shared';
import {
  checkForCliUpdate,
  downloadTarballBytes,
  ensureOnDemandCliUpdate,
  extractVerifiedPackageTgz,
  maybeDelegateToManagedCli,
  resolveActiveManagedCli,
} from './cli-update';
import { createBrowserServices } from './browser-services';
import { createDomExtractionStep, DOM_EXTRACTION_OUTPUT_SCHEMA } from './skill-read-program';

function createTarEntry(
  name: string,
  content: Buffer | string,
  typeflag: '0' | '2' | '5' = '0',
  linkname = '',
): Buffer {
  const data =
    typeflag === '0'
      ? Buffer.isBuffer(content)
        ? content
        : Buffer.from(content)
      : Buffer.alloc(0);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(typeflag === '5' ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0') + '\0',
    136,
    12,
    'ascii',
  );
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  if (linkname) header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (let i = 0; i < 512; i += 1) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  if (data.length === 0) return header;
  const padLen = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(padLen, 0)]);
}

function buildTgz(
  entries: Array<{
    name: string;
    content?: Buffer | string;
    type?: '0' | '2' | '5';
    linkname?: string;
  }>,
): {
  tgz: Buffer;
  integrity: string;
} {
  const chunks = entries.map((e) =>
    createTarEntry(e.name, e.content ?? '', e.type ?? '0', e.linkname),
  );
  chunks.push(Buffer.alloc(1024, 0));
  const tgz = gzipSync(Buffer.concat(chunks));
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  return { tgz, integrity };
}

function buildFakeReleaseTgz(version: string, markerFile?: string) {
  const cliScript = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const payload = { version: ${JSON.stringify(version)}, args, delegated: process.env.BROWSERPAW_CLI_DELEGATED === '1' };
${markerFile ? `fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(payload));` : ''}
if (args[0] === '--version') console.log(${JSON.stringify(version)});
else console.log(JSON.stringify({ ok: true, ...payload }));
`;
  return buildTgz([
    {
      name: 'package/package.json',
      content: JSON.stringify({
        name: 'browserpaw',
        version,
        repository: { type: 'git', url: `git+${GITHUB_REPO_URL}.git` },
        bin: { browserpaw: './dist/v5/cli.cjs' },
      }),
    },
    { name: 'package/dist/v5/cli.cjs', content: cliScript },
    { name: 'package/dist/v5/host.cjs', content: `// host ${version}\n` },
    { name: 'package/dist/v5/cli-files.cjs', content: 'module.exports = {};\n' },
    { name: 'package/dist/v5/run_host.bat', content: '@echo off\r\n' },
    { name: 'package/dist/v5/run_host.sh', content: '#!/bin/sh\n' },
    {
      name: 'package/dist/v5/skill/browserpaw/SKILL.md',
      content: `---\nname: browserpaw\ndescription: BrowserPaw ${version}\n---\n# BrowserPaw ${version}\n`,
    },
    {
      name: 'package/dist/v5/recipes/demo-recipe.json',
      content: JSON.stringify({ id: 'demo-recipe', version }),
    },
  ]);
}

async function startHttpServer(
  handler: RequestListener,
): Promise<{ server: Server; url: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP port');
  return { server, url: `http://127.0.0.1:${address.port}`, port: address.port };
}

describe('On-demand CLI auto-update, delegation, and host version compatibility', () => {
  let homeDir: string;
  let servers: Server[];

  beforeEach(() => {
    servers = [];
    homeDir = mkdtempSync(join(tmpdir(), 'browserpaw-autoupdate-'));
    jest.replaceProperty(process, 'env', {
      ...process.env,
      BROWSERPAW_HOME: homeDir,
      BROWSERPAW_NO_UPDATE_CHECK: '0',
      BROWSERPAW_NO_AUTO_UPDATE: '0',
      BROWSERPAW_CLI_DELEGATED: '',
    });
  });

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    jest.restoreAllMocks();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('rejects tampered SHA-512 integrity, symlinks, and traversal entries during tarball extraction', () => {
    const valid = buildFakeReleaseTgz('5000.1.0');
    const outOk = join(homeDir, 'extract-ok');
    mkdirSync(outOk);
    extractVerifiedPackageTgz(valid.tgz, valid.integrity, outOk);
    expect(existsSync(join(outOk, 'package', 'dist', 'v5', 'cli.cjs'))).toBe(true);

    const outBadHash = join(homeDir, 'extract-bad-hash');
    mkdirSync(outBadHash);
    const badIntegrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
    expect(() => extractVerifiedPackageTgz(valid.tgz, badIntegrity, outBadHash)).toThrow(
      /SHA-512 integrity/i,
    );

    const symlinkTar = buildTgz([
      { name: 'package/dist/v5/evil', type: '2', linkname: '/etc/passwd' },
    ]);
    const outSymlink = join(homeDir, 'extract-symlink');
    mkdirSync(outSymlink);
    expect(() =>
      extractVerifiedPackageTgz(symlinkTar.tgz, symlinkTar.integrity, outSymlink),
    ).toThrow(/Unsupported tar entry type/i);

    const traversalTar = buildTgz([{ name: 'package/../../escape.txt', content: 'nope' }]);
    const outTraversal = join(homeDir, 'extract-traversal');
    mkdirSync(outTraversal);
    expect(() =>
      extractVerifiedPackageTgz(traversalTar.tgz, traversalTar.integrity, outTraversal),
    ).toThrow(/Unsafe tar path segment/i);
  });

  it('enforces tarball byte limits while streaming chunked responses without Content-Length', async () => {
    let chunksSent = 0;
    let streamAborted = false;
    const oversizedServer = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      const chunk = Buffer.alloc(1024, 0x61);
      const timer = setInterval(() => {
        if (res.destroyed || chunksSent >= 256) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        chunksSent += 1;
        res.write(chunk);
      }, 5);
      res.once('close', () => {
        streamAborted = true;
        clearInterval(timer);
      });
    });
    servers.push(oversizedServer.server);

    await expect(
      downloadTarballBytes(`${oversizedServer.url}/oversized.tgz`, 4096),
    ).rejects.toThrow(/exceeds maximum allowed download size/i);
    expect(chunksSent).toBeLessThan(64);
    expect(streamAborted || chunksSent < 64).toBe(true);
  });

  it('installs a verified release on-demand, syncs host/skill, delegates actual commands even offline, and never downgrades newer local builds', async () => {
    const invocationRecord = join(homeDir, 'delegated-run.json');
    const releaseV1 = buildFakeReleaseTgz('5000.1.0', invocationRecord);
    const releaseV2 = buildFakeReleaseTgz('5000.2.0', invocationRecord);
    const currentRelease = { version: '5000.1.0', ...releaseV1 };
    let metadataRequests = 0;

    const registry = await startHttpServer((req, res) => {
      if (req.url === '/browserpaw/latest') {
        metadataRequests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: 'browserpaw',
            version: currentRelease.version,
            repository: { url: `git+${GITHUB_REPO_URL}.git` },
            dist: {
              tarball: `${registry.url}/browserpaw/-/browserpaw-${currentRelease.version}.tgz`,
              integrity: currentRelease.integrity,
            },
          }),
        );
        return;
      }
      if (req.url === `/browserpaw/-/browserpaw-${currentRelease.version}.tgz`) {
        res.writeHead(200, { 'content-type': 'application/gzip' });
        res.end(currentRelease.tgz);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(registry.server);
    process.env.BROWSERPAW_UPDATE_REGISTRY_URL = `${registry.url}/browserpaw/latest`;

    // Seed an existing installation (host + managed skill) to verify automatic host/skill refresh
    const skillDir = join(homeDir, 'managed-skills', 'browserpaw');
    mkdirSync(join(homeDir, 'host', 'recipes'), { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(homeDir, 'host', 'host.cjs'), '// old host 5.0.0\n');
    writeFileSync(join(homeDir, 'host', 'host-version.txt'), '5.0.0\n');
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: browserpaw\ndescription: Old\n---\n# Old\n',
    );
    writeFileSync(
      join(skillDir, '.browserpaw-skill.json'),
      JSON.stringify({ name: 'browserpaw', version: '5.0.0', scope: 'custom' }),
    );
    writeFileSync(
      join(homeDir, 'installation.json'),
      JSON.stringify({
        version: '5.0.0',
        browsers: ['chrome'],
        skillMode: 'managed',
        skillPath: skillDir,
        skillScope: 'custom',
        skillPaths: [skillDir],
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    );

    // 1. On-demand update installs 5000.1.0, syncs host + recipes + managed skill
    const first = await ensureOnDemandCliUpdate({ currentVersion: '5.0.0' });
    expect(first).toMatchObject({ activeVersion: '5000.1.0', updated: true });
    expect(metadataRequests).toBe(1);
    expect(readFileSync(join(homeDir, 'host', 'host.cjs'), 'utf8')).toContain('host 5000.1.0');
    expect(readFileSync(join(homeDir, 'host', 'host-version.txt'), 'utf8').trim()).toBe('5000.1.0');
    expect(existsSync(join(homeDir, 'host', 'recipes', 'demo-recipe.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(homeDir, 'installation.json'), 'utf8')).version).toBe(
      '5000.1.0',
    );
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toContain('BrowserPaw 5000.1.0');

    // 2. Within 24h throttle, second check performs 0 network requests
    const second = await ensureOnDemandCliUpdate({ currentVersion: '5.0.0' });
    expect(second).toMatchObject({ activeVersion: '5000.1.0', updated: false });
    expect(metadataRequests).toBe(1);

    // 3. Shut down registry (offline!) and verify original entry shim still delegates actual commands
    await new Promise<void>((resolve) => registry.server.close(() => resolve()));
    servers = servers.filter((s) => s !== registry.server);

    const exitCode = await maybeDelegateToManagedCli(['recipe', 'list', '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(invocationRecord, 'utf8'))).toEqual({
      version: '5000.1.0',
      args: ['recipe', 'list', '--json'],
      delegated: true,
    });

    // 4. Newer local/dev CLI never downgrades to an older managed install
    expect(resolveActiveManagedCli(homeDir, '5000.9.0')).toBeUndefined();

    // 5. After 24h expiry, a newer upstream 5000.2.0 fails cleanly when tampered and preserves 5000.1.0
    const badRegistry = await startHttpServer((req, res) => {
      if (req.url === '/browserpaw/latest') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: 'browserpaw',
            version: '5000.2.0',
            repository: { url: `git+${GITHUB_REPO_URL}.git` },
            dist: {
              tarball: `${badRegistry.url}/browserpaw/-/browserpaw-5000.2.0.tgz`,
              integrity: `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(releaseV2.tgz);
    });
    servers.push(badRegistry.server);
    process.env.BROWSERPAW_UPDATE_REGISTRY_URL = `${badRegistry.url}/browserpaw/latest`;
    const statePath = join(homeDir, 'cli-update.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...state, checkedAt: 0, autoUpdateCheckedAt: 0 }));

    const tampered = await ensureOnDemandCliUpdate({ currentVersion: '5.0.0' });
    expect(tampered).toMatchObject({ activeVersion: '5000.1.0', updated: false });
    expect(resolveActiveManagedCli(homeDir, '5.0.0')?.version).toBe('5000.1.0');
  });

  it('keeps --help/--version offline and still auto-installs on the next normal command even after a notify-only check wrote checkedAt', async () => {
    const invocationRecord = join(homeDir, 'ordered-delegated-run.json');
    const release = buildFakeReleaseTgz('5000.3.0', invocationRecord);
    let metadataRequests = 0;
    let tarballRequests = 0;

    const registry = await startHttpServer((req, res) => {
      if (req.url === '/browserpaw/latest') {
        metadataRequests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: 'browserpaw',
            version: '5000.3.0',
            repository: { url: `git+${GITHUB_REPO_URL}.git` },
            dist: {
              tarball: `${registry.url}/browserpaw/-/browserpaw-5000.3.0.tgz`,
              integrity: release.integrity,
            },
          }),
        );
        return;
      }
      if (req.url === '/browserpaw/-/browserpaw-5000.3.0.tgz') {
        tarballRequests += 1;
        res.writeHead(200, { 'content-type': 'application/gzip' });
        res.end(release.tgz);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(registry.server);
    process.env.BROWSERPAW_UPDATE_REGISTRY_URL = `${registry.url}/browserpaw/latest`;

    const stdoutSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.resetModules();
    const { runCommands } = await import('./command-client');

    // 1. --help and --version make zero network requests and do not write cli-update.json
    expect(await runCommands(['--help'])).toBe(0);
    expect(await runCommands(['--version'])).toBe(0);
    expect(metadataRequests).toBe(0);
    expect(tarballRequests).toBe(0);
    expect(existsSync(join(homeDir, 'cli-update.json'))).toBe(false);

    // 2. Notify-only invocation (BROWSERPAW_NO_AUTO_UPDATE=1) writes checkedAt + latest without installing
    process.env.BROWSERPAW_NO_AUTO_UPDATE = '1';
    expect(await runCommands(['recipe', 'list', '--json'])).toBe(0);
    expect(metadataRequests).toBe(1);
    expect(tarballRequests).toBe(0);
    expect(resolveActiveManagedCli(homeDir, CURRENT_VERSION)).toBeUndefined();
    const afterNotify = JSON.parse(readFileSync(join(homeDir, 'cli-update.json'), 'utf8'));
    expect(typeof afterNotify.checkedAt).toBe('number');
    expect(afterNotify.autoUpdateCheckedAt).toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('5000.3.0'));

    // 3. Subsequent normal command still installs and delegates instead of being throttled by checkedAt
    process.env.BROWSERPAW_NO_AUTO_UPDATE = '0';
    expect(await runCommands(['recipe', 'list', '--json'])).toBe(0);
    expect(tarballRequests).toBe(1);
    expect(resolveActiveManagedCli(homeDir, CURRENT_VERSION)?.version).toBe('5000.3.0');
    expect(JSON.parse(readFileSync(invocationRecord, 'utf8'))).toEqual({
      version: '5000.3.0',
      args: ['recipe', 'list', '--json'],
      delegated: true,
    });

    // 4. After installation, --version delegates cleanly to the managed CLI without extra downloads
    stdoutSpy.mockClear();
    expect(await runCommands(['--version'])).toBe(0);
    expect(tarballRequests).toBe(1);
    expect(JSON.parse(readFileSync(invocationRecord, 'utf8'))).toEqual({
      version: '5000.3.0',
      args: ['--version'],
      delegated: true,
    });
  });

  it('requests a graceful restart when an older local host is running and keeps an un-restarted old host safe from incompatible recipe reloads', async () => {
    // 1. Live older host restart flow via runCommands(['status', '--json'])
    const token = 'a'.repeat(64);
    writeFileSync(join(homeDir, 'token'), token, { mode: 0o600 });
    let hostVersion = '4.9.0';
    let restartCalls = 0;

    const fakeHost = await startHttpServer((req, res) => {
      if (req.headers['x-browserpaw-token'] !== token) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/restart') {
        restartCalls += 1;
        hostVersion = CURRENT_VERSION;
        writeFileSync(
          join(homeDir, 'host.json'),
          JSON.stringify({
            port: fakeHost.port,
            pid: process.pid,
            version: hostVersion,
            protocol: 1,
          }),
        );
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reloadRequested: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocol: 1,
            version: hostVersion,
            connected: true,
            pid: process.pid,
            port: fakeHost.port,
            extension: { manifestVersion: CURRENT_VERSION },
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
      JSON.stringify({ port: fakeHost.port, pid: process.pid, version: hostVersion, protocol: 1 }),
    );
    process.env.BROWSERPAW_NO_UPDATE_CHECK = '1';
    const stdoutSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.resetModules();
    const { runCommands } = await import('./command-client');

    // 1a. When new host files have NOT been staged (and cannot sync), do NOT disrupt the running older host
    const noStageExit = await runCommands(['status', '--json']);
    expect(noStageExit).toBe(3);
    expect(restartCalls).toBe(0);
    expect(hostVersion).toBe('4.9.0');

    // 1b. Once new host files ARE staged (host-version.txt === CURRENT_VERSION), request graceful restart
    mkdirSync(join(homeDir, 'host'), { recursive: true });
    writeFileSync(join(homeDir, 'host', 'host-version.txt'), `${CURRENT_VERSION}\n`);
    const statusExit = await runCommands(['status', '--json']);
    expect(statusExit).toBe(0);
    expect(restartCalls).toBe(1);
    expect(hostVersion).toBe(CURRENT_VERSION);
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining(`"version":"${CURRENT_VERSION}"`),
    );

    // 2. Running host reloads recipes when host-version.txt matches, and skips incompatible newer-version recipes when mismatched
    const hostDir = join(homeDir, 'simulated-host');
    const recipesDir = join(hostDir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    writeFileSync(join(hostDir, 'host-version.txt'), `${CURRENT_VERSION}\n`);
    const sampleSkill = {
      id: 'sample-dom-skill',
      name: 'Sample DOM skill',
      description: 'Read heading',
      source: { type: 'builtin', urls: ['https://example.com/'] },
      domains: ['example.com'],
      keywords: ['sample'],
      startUrl: 'https://example.com/?q={{query}}',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 } },
        required: ['query'],
        additionalProperties: false,
      },
      outputSchema: DOM_EXTRACTION_OUTPUT_SCHEMA,
      steps: [
        createDomExtractionStep({
          fields: [{ name: 'title', selector: 'h1', value: 'text' }],
        }),
      ],
      verification: {
        tool: 'chrome_read_dom',
        args: { format: 'compact', selector: 'main' },
        resultPath: '/treeString',
      },
      tests: [
        {
          inputs: { query: 'one' },
          expect: {
            type: 'object',
            properties: { success: { const: true } },
            required: ['success'],
          },
          observe: { type: 'string', pattern: 'one' },
        },
        {
          inputs: { query: 'two' },
          expect: {
            type: 'object',
            properties: { success: { const: true } },
            required: ['success'],
          },
          observe: { type: 'string', pattern: 'two' },
        },
      ],
    };
    writeFileSync(join(recipesDir, 'sample-dom-skill.json'), JSON.stringify(sampleSkill));

    const mockBrowserCall = jest.fn(async (): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: '{}' }],
      isError: false,
    }));
    const service = createBrowserServices(mockBrowserCall, homeDir, recipesDir);
    const loaded = await service.execute('chrome_skill', { action: 'get', id: 'sample-dom-skill' });
    expect(loaded.isError).toBe(false);

    // Simulate a newer CLI writing a newer host-version.txt and a recipe whose JS hash is NOT in this older host's allowlist
    writeFileSync(join(hostDir, 'host-version.txt'), '5000.1.0\n');
    writeFileSync(
      join(recipesDir, 'future-js-skill.json'),
      JSON.stringify({
        ...sampleSkill,
        id: 'future-js-skill',
        steps: [
          {
            tool: 'chrome_javascript',
            args: { code: 'return { success: true, sources: { page: location.href } };' },
            resultPath: '/result',
          },
        ],
      }),
    );

    // The older still-running host does NOT crash on incompatible newer recipes and keeps serving existing skills cleanly
    const stillHealthy = await service.execute('chrome_skill', {
      action: 'get',
      id: 'sample-dom-skill',
    });
    expect(stillHealthy.isError).toBe(false);
    expect(stillHealthy.content[0].type === 'text' && stillHealthy.content[0].text).toContain(
      'sample-dom-skill',
    );
  });

  it('sets a short autoUpdateRetryAfter backoff on metadata or tarball failure, preserves prior autoUpdateCheckedAt, and retries once expired', async () => {
    const invocationRecord = join(homeDir, 'retry-delegated-run.json');
    const release = buildFakeReleaseTgz('5000.4.0', invocationRecord);
    let metadataMode: 'fail' | 'ok' = 'fail';
    let tarballMode: 'fail' | 'ok' = 'fail';
    let metadataRequests = 0;
    let tarballRequests = 0;

    const registry = await startHttpServer((req, res) => {
      if (req.url === '/browserpaw/latest') {
        metadataRequests += 1;
        if (metadataMode === 'fail') {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: 'browserpaw',
            version: '5000.4.0',
            repository: { url: `git+${GITHUB_REPO_URL}.git` },
            dist: {
              tarball: `${registry.url}/browserpaw/-/browserpaw-5000.4.0.tgz`,
              integrity: release.integrity,
            },
          }),
        );
        return;
      }
      if (req.url === '/browserpaw/-/browserpaw-5000.4.0.tgz') {
        tarballRequests += 1;
        if (tarballMode === 'fail') {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/gzip' });
        res.end(release.tgz);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(registry.server);
    process.env.BROWSERPAW_UPDATE_REGISTRY_URL = `${registry.url}/browserpaw/latest`;

    const statePath = join(homeDir, 'cli-update.json');
    const retryMs = 10 * 60 * 1000;

    // 1. Metadata fetch failure sets ~10 min autoUpdateRetryAfter without setting autoUpdateCheckedAt
    const beforeMetaFail = Date.now();
    const metaFailResult = await ensureOnDemandCliUpdate({ currentVersion: '5.0.0' });
    const afterMetaFail = Date.now();
    expect(metaFailResult).toMatchObject({ updated: false });
    expect(metadataRequests).toBe(1);
    const afterMetaState = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(afterMetaState.autoUpdateCheckedAt).toBeUndefined();
    expect(afterMetaState.autoUpdateRetryAfter).toBeGreaterThanOrEqual(beforeMetaFail + retryMs);
    expect(afterMetaState.autoUpdateRetryAfter).toBeLessThanOrEqual(afterMetaFail + retryMs);

    // Within retry backoff window, no new network call is made
    await ensureOnDemandCliUpdate({ currentVersion: '5.0.0' });
    expect(metadataRequests).toBe(1);

    // 2. Tarball install failure preserves prior autoUpdateCheckedAt and sets autoUpdateRetryAfter
    const priorAutoCheckedAt = Date.now() - 48 * 60 * 60 * 1000;
    metadataMode = 'ok';
    writeFileSync(
      statePath,
      JSON.stringify({
        checkedAt: priorAutoCheckedAt,
        autoUpdateCheckedAt: priorAutoCheckedAt,
        notified: [],
      }),
    );
    const beforeTarballFail = Date.now();
    const tarballFailResult = await ensureOnDemandCliUpdate({ currentVersion: '5.0.0' });
    const afterTarballFail = Date.now();
    expect(tarballFailResult).toMatchObject({ updated: false, latest: '5000.4.0' });
    expect(metadataRequests).toBe(2);
    expect(tarballRequests).toBe(1);
    const afterTarballState = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(afterTarballState.autoUpdateCheckedAt).toBe(priorAutoCheckedAt);
    expect(afterTarballState.autoUpdateRetryAfter).toBeGreaterThanOrEqual(
      beforeTarballFail + retryMs,
    );
    expect(afterTarballState.autoUpdateRetryAfter).toBeLessThanOrEqual(afterTarballFail + retryMs);

    // Still throttled before autoUpdateRetryAfter passes
    await ensureOnDemandCliUpdate({ currentVersion: '5.0.0' });
    expect(metadataRequests).toBe(2);

    // 3. Once autoUpdateRetryAfter expires, retry runs and clears autoUpdateRetryAfter on success
    tarballMode = 'ok';
    writeFileSync(
      statePath,
      JSON.stringify({
        ...afterTarballState,
        checkedAt: Date.now(),
        autoUpdateRetryAfter: Date.now() - 1000,
      }),
    );
    const beforeRetrySuccess = Date.now();
    const retrySuccess = await ensureOnDemandCliUpdate({ currentVersion: '5.0.0' });
    expect(retrySuccess).toMatchObject({ activeVersion: '5000.4.0', updated: true });
    expect(metadataRequests).toBe(3);
    expect(tarballRequests).toBe(2);
    const finalState = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(finalState.autoUpdateRetryAfter).toBeUndefined();
    expect(finalState.autoUpdateCheckedAt).toBeGreaterThanOrEqual(beforeRetrySuccess);
  });

  it('preserves autoUpdateRetryAfter when checkForCliUpdate writes cli-update.json', async () => {
    let remoteVersion = '5000.5.0';
    const registry = await startHttpServer((req, res) => {
      if (req.url === '/browserpaw/latest') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: 'browserpaw',
            version: remoteVersion,
            repository: { url: `git+${GITHUB_REPO_URL}.git` },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(registry.server);
    process.env.BROWSERPAW_UPDATE_REGISTRY_URL = `${registry.url}/browserpaw/latest`;

    const statePath = join(homeDir, 'cli-update.json');
    const retryAfter = Date.now() + 5 * 60 * 1000;
    writeFileSync(
      statePath,
      JSON.stringify({
        checkedAt: 0,
        autoUpdateCheckedAt: 11111,
        autoUpdateRetryAfter: retryAfter,
        notified: [],
      }),
    );

    expect(await checkForCliUpdate()).toBe('5000.5.0');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      autoUpdateCheckedAt: 11111,
      autoUpdateRetryAfter: retryAfter,
      latest: '5000.5.0',
    });

    // Also preserve autoUpdateRetryAfter when autoUpdateCheckedAt was not set
    remoteVersion = '5000.6.0';
    writeFileSync(
      statePath,
      JSON.stringify({
        checkedAt: 0,
        autoUpdateRetryAfter: retryAfter,
        notified: ['5000.5.0'],
      }),
    );

    expect(await checkForCliUpdate()).toBe('5000.6.0');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      notifyOnly: true,
      autoUpdateRetryAfter: retryAfter,
      latest: '5000.6.0',
    });
  });
});
