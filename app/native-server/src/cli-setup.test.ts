import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseCommand } from 'chrome-mcp-shared';
import { BrowserType, getBrowserConfig } from './scripts/browser-config';
import { installSkill, syncInstalledSkillRouting, upgradeInstalledSkill } from './skill-install';
import { manageInstallation } from './cli-setup';

jest.mock('./skill-install', () => {
  const actual = jest.requireActual<typeof import('./skill-install')>('./skill-install');
  return {
    ...actual,
    installSkill: jest.fn(),
    syncInstalledSkillRouting: jest.fn(),
    upgradeInstalledSkill: jest.fn(),
  };
});

jest.mock('./scripts/browser-config', () => {
  const actual = jest.requireActual<typeof import('./scripts/browser-config')>(
    './scripts/browser-config',
  );
  return { ...actual, getBrowserConfig: jest.fn() };
});

const mockedInstallSkill = jest.mocked(installSkill);
const mockedSyncInstalledSkillRouting = jest.mocked(syncInstalledSkillRouting);
const mockedUpgradeInstalledSkill = jest.mocked(upgradeInstalledSkill);
const mockedGetBrowserConfig = jest.mocked(getBrowserConfig);
const requestHost = jest.fn(async () => new Response()) as unknown as Parameters<
  typeof manageInstallation
>[1];

describe('BrowserPaw setup transaction', () => {
  const originalPlatform = process.platform;
  let homeDir: string;
  let previousHome: string | undefined;
  let extensionFails: boolean;
  let readFileSync: ReturnType<typeof jest.spyOn>;
  let existsSync: ReturnType<typeof jest.spyOn>;
  let statSync: ReturnType<typeof jest.spyOn>;
  let cpSync: ReturnType<typeof jest.spyOn>;
  let chmodSync: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    previousHome = process.env.BROWSERPAW_HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-setup-'));
    process.env.BROWSERPAW_HOME = homeDir;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    extensionFails = false;

    const virtual = new Map<string, Buffer>([
      [path.join(__dirname, 'host.cjs'), Buffer.from('host\n')],
      [path.join(__dirname, 'run_host.bat'), Buffer.from('bat\n')],
      [path.join(__dirname, 'run_host.sh'), Buffer.from('sh\n')],
      [
        path.join(__dirname, 'extension', 'manifest.json'),
        Buffer.from(
          JSON.stringify({
            name: 'browserpaw',
            version: '5.0.0',
            key: Buffer.from('browserpaw-test-key').toString('base64'),
          }),
        ),
      ],
    ]);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    readFileSync = jest.spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      options?: unknown,
    ) => {
      const bundled = virtual.get(String(file));
      if (bundled) return bundled;
      return (originalReadFileSync as (...args: unknown[]) => unknown)(file, options);
    }) as typeof fs.readFileSync);
    const originalExistsSync = fs.existsSync.bind(fs);
    existsSync = jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((file) => virtual.has(String(file)) || originalExistsSync(file));
    const originalStatSync = fs.statSync.bind(fs);
    statSync = jest.spyOn(fs, 'statSync').mockImplementation(((
      file: fs.PathLike,
      options?: unknown,
    ) => {
      if (virtual.has(String(file))) return { mode: 0o644 } as fs.Stats;
      return (originalStatSync as (...args: unknown[]) => unknown)(file, options) as fs.Stats;
    }) as typeof fs.statSync);
    const originalCpSync = fs.cpSync.bind(fs);
    cpSync = jest.spyOn(fs, 'cpSync').mockImplementation(((
      source: fs.PathLike,
      destination: fs.PathLike,
    ) => {
      const from = String(source);
      const to = String(destination);
      if (from === path.join(__dirname, 'extension')) {
        if (extensionFails) throw new Error('simulated extension copy failure');
        fs.writeFileSync(
          path.join(to, 'manifest.json'),
          JSON.stringify({ name: 'browserpaw', version: '5.0.0' }),
        );
        fs.writeFileSync(path.join(to, 'popup.html'), 'packaged\n');
        return;
      }
      if (from === path.join(__dirname, 'recipes')) {
        fs.writeFileSync(path.join(to, 'example.json'), '{}\n');
        return;
      }
      return (originalCpSync as (...args: unknown[]) => unknown)(source, destination);
    }) as typeof fs.cpSync);
    const originalChmodSync = fs.chmodSync.bind(fs);
    chmodSync = jest
      .spyOn(fs, 'chmodSync')
      .mockImplementation(((file: fs.PathLike, mode: fs.Mode) =>
        originalChmodSync(file, mode)) as typeof fs.chmodSync);

    mockedGetBrowserConfig.mockImplementation((browser) => ({
      type: browser,
      displayName: browser,
      userManifestPath: path.join(homeDir, 'browsers', `${browser}.json`),
      systemManifestPath: path.join(homeDir, 'system', `${browser}.json`),
    }));
    mockedInstallSkill.mockImplementation((options = {}) => {
      const installedPath = path.join(homeDir, 'managed-skill', 'browserpaw');
      fs.mkdirSync(installedPath, { recursive: true });
      fs.writeFileSync(path.join(installedPath, 'SKILL.md'), '# BrowserPaw\n');
      return {
        installedPath,
        version: String(options.version ?? '5.0.0'),
        scope: 'custom',
      };
    });
    mockedSyncInstalledSkillRouting.mockReturnValue(true);
    mockedUpgradeInstalledSkill.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.BROWSERPAW_HOME;
    else process.env.BROWSERPAW_HOME = previousHome;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    jest.restoreAllMocks();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('records Skill mode after setup and preserves a complete extension during upgrades', async () => {
    const first = await manageInstallation(
      parseCommand(['setup', '--browser', 'chromium', '--no-skill']),
      requestHost,
    );
    const recordPath = path.join(homeDir, 'installation.json');
    expect(first).toMatchObject({ extensionPrepared: true });
    expect(mockedInstallSkill).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toMatchObject({
      skillMode: 'disabled',
      browsers: [BrowserType.CHROMIUM],
    });

    const extensionFile = path.join(homeDir, 'extension', 'popup.html');
    fs.writeFileSync(extensionFile, 'user extension\n');
    const second = await manageInstallation(parseCommand(['setup']), requestHost);
    expect(second).toMatchObject({ extensionPrepared: false });
    expect(mockedInstallSkill).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(extensionFile, 'utf8')).toBe('user extension\n');
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).skillMode).toBe('managed');

    chmodSync.mockClear();
    await manageInstallation(parseCommand(['setup']), requestHost);
    expect(chmodSync).toHaveBeenCalledWith(path.join(homeDir, 'host', 'run_host.sh'), 0o755);
  });

  it('does not write an installation record before extension preparation succeeds', async () => {
    extensionFails = true;
    await expect(
      manageInstallation(parseCommand(['setup', '--no-skill']), requestHost),
    ).rejects.toThrow(/extension copy failure/);
    expect(fs.existsSync(path.join(homeDir, 'installation.json'))).toBe(false);

    extensionFails = false;
    await expect(
      manageInstallation(parseCommand(['setup', '--no-skill']), requestHost),
    ).resolves.toMatchObject({ extensionPrepared: true });
  });

  it('repairs a missing extension and preserves explicit plugin Skill ownership', async () => {
    await manageInstallation(
      parseCommand(['setup', '--browser', 'chromium', '--no-skill']),
      requestHost,
    );
    const recordPath = path.join(homeDir, 'installation.json');
    const installation = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { extensionId: string };
    fs.writeFileSync(
      recordPath,
      JSON.stringify({
        version: '5.0.0',
        browsers: ['chromium'],
        skillMode: 'plugin',
        extensionId: installation.extensionId,
      }),
    );
    fs.rmSync(path.join(homeDir, 'extension'), { recursive: true, force: true });
    mockedInstallSkill.mockClear();

    const repaired = await manageInstallation(parseCommand(['setup']), requestHost);
    expect(repaired).toMatchObject({ extensionPrepared: true });
    expect(mockedInstallSkill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(homeDir, 'extension', 'manifest.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).skillMode).toBe('plugin');
  });
});
