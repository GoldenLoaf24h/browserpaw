import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  lstatSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HOST_NAME, CURRENT_VERSION, type ParsedCommand } from 'chrome-mcp-shared';
import { BrowserType, getBrowserConfig } from './scripts/browser-config';
import { installSkill } from './skill-install';
import type { requestHost as hostRequest } from './command-client';

const installationRoot = () =>
  resolve(process.env.BROWSERPAW_HOME || join(homedir(), '.browserpaw'));
const files = ['host.cjs', 'run_host.bat', 'run_host.sh'];

interface Installation {
  version: string;
  browsers: BrowserType[];
  skillPath?: string;
  extensionId: string;
  buildId?: string;
}

function readJson(path: string) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function manifestFor(root: string, extensionId: string) {
  return {
    name: HOST_NAME,
    description: 'BrowserPaw Native Messaging host',
    path: join(root, 'host', process.platform === 'win32' ? 'run_host.bat' : 'run_host.sh'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

function register(root: string, browser: BrowserType, extensionId: string) {
  const config = getBrowserConfig(browser);
  const manifest = manifestFor(root, extensionId);
  const existing = readJson(config.userManifestPath);
  if (existing && existing.path !== manifest.path)
    throw new Error(
      `BrowserPaw is already registered from another installation: ${config.userManifestPath}`,
    );
  mkdirSync(dirname(config.userManifestPath), { recursive: true });
  writeJson(config.userManifestPath, manifest);
  if (config.registryKey)
    execFileSync('reg.exe', [
      'add',
      config.registryKey,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      config.userManifestPath,
      '/f',
    ]);
}

function unregister(root: string, browser: BrowserType, extensionId: string) {
  const config = getBrowserConfig(browser);
  const manifest = readJson(config.userManifestPath);
  if (!manifest || manifest.path !== manifestFor(root, extensionId).path) return;
  if (config.registryKey) {
    let value = '';
    try {
      value = execFileSync('reg.exe', ['query', config.registryKey, '/ve'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
    }
    const registeredPath = /REG_SZ\s+(.+)\s*$/.exec(value.trim())?.[1];
    if (registeredPath === config.userManifestPath)
      execFileSync('reg.exe', ['delete', config.registryKey, '/ve', '/f']);
  }
  rmSync(config.userManifestPath);
}

function replaceDirectory(destination: string, prepare: (staging: string) => void) {
  const staging = destination + '.staging-' + randomUUID();
  const backup = destination + '.backup-' + randomUUID();
  mkdirSync(staging);
  try {
    prepare(staging);
    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(staging, destination);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function installHost(destination: string) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const replace = (file: string, bytes: Buffer, mode: number) => {
    const target = join(destination, file);
    if (existsSync(target) && readFileSync(target).equals(bytes)) return;
    const staging = target + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(staging, bytes, { flag: 'wx', mode });
      renameSync(staging, target);
    } finally {
      rmSync(staging, { force: true });
    }
  };
  for (const file of files) {
    const source = join(__dirname, file);
    replace(file, readFileSync(source), statSync(source).mode & 0o777);
  }
  replace('node_path.txt', Buffer.from(process.execPath + '\n'), 0o600);
  replaceDirectory(join(destination, 'recipes'), (staging) =>
    cpSync(join(__dirname, 'recipes'), staging, { recursive: true }),
  );
}

export async function manageInstallation(command: ParsedCommand, requestHost: typeof hostRequest) {
  const root = installationRoot();
  const recordPath = join(root, 'installation.json');
  const previous: Installation | undefined = readJson(recordPath);
  if (command.name === 'uninstall') {
    if (!previous) return { installed: false };
    for (const browser of previous.browsers) unregister(root, browser, previous.extensionId);
    if (previous.skillPath) {
      const marker = readJson(join(previous.skillPath, '.browserpaw-skill.json'));
      if (marker?.name === 'browserpaw')
        rmSync(previous.skillPath, { recursive: true, force: true });
    }
    for (const target of ['host', 'extension'])
      rmSync(join(root, target), { recursive: true, force: true });
    rmSync(recordPath, { force: true });
    if (command.options.purge) {
      for (const target of ['tasks.json', 'skills', 'recipes', 'out', 'logs', 'token', 'host.json'])
        rmSync(join(root, target), { recursive: true, force: true });
    }
    return { installed: false, dataPreserved: !command.options.purge };
  }
  if (command.name === 'doctor') {
    if (command.options.fix && !previous) throw new Error('Run browserpaw setup first.');
    if (command.options.fix && previous)
      for (const browser of previous.browsers) register(root, browser, previous.extensionId);
    const installedHost = existsSync(join(root, 'host', 'host.cjs'));
    const extension = join(root, 'extension');
    const host = await requestHost('status', undefined, 4000)
      .then(async (response) => (response.ok ? await response.json() : undefined))
      .catch(() => undefined);
    return {
      installed: previous?.version,
      hostPresent: installedHost,
      extension,
      extensionPresent: existsSync(join(extension, 'manifest.json')),
      host,
      registeredBrowsers:
        previous?.browsers.map((browser) => {
          const path = getBrowserConfig(browser).userManifestPath;
          return {
            browser,
            path,
            registered: readJson(path)?.path === manifestFor(root, previous.extensionId).path,
          };
        }) ?? [],
      next: !installedHost
        ? 'Run browserpaw setup.'
        : !host?.connected
          ? 'Load the installed directory in chrome://extensions.'
          : 'Run browserpaw status.',
    };
  }
  const browser = command.options.browser ?? 'chrome';
  if (browser !== 'chrome' && browser !== 'chromium' && browser !== 'all')
    throw new Error('Use --browser chrome, chromium, or all.');
  const browsers =
    browser === 'all' ? [BrowserType.CHROME, BrowserType.CHROMIUM] : [browser as BrowserType];
  const extensionSource = join(__dirname, 'extension');
  const extension = readJson(join(extensionSource, 'manifest.json'));
  if (typeof extension?.key !== 'string')
    throw new Error('Packaged extension is missing its public key.');
  const extensionId = createHash('sha256')
    .update(Buffer.from(extension.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[\da-f]/g, (char) => String.fromCharCode(97 + Number.parseInt(char, 16)));
  for (const browser of browsers) {
    const config = getBrowserConfig(browser);
    const oldManifest = readJson(config.userManifestPath);
    if (oldManifest && oldManifest.path !== manifestFor(root, extensionId).path)
      throw new Error(`A different installation owns ${config.userManifestPath}.`);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const { acquireLock, assertNoLinks } = require('./cli-files.cjs');
  assertNoLinks(root);
  const unlock = acquireLock(join(root, '.installation.lock'));
  try {
    for (const name of ['host', 'extension']) {
      const entry = lstatSync(join(root, name), { throwIfNoEntry: false });
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || !previous))
        throw new Error(
          `Existing directory is outside the managed installation: ${join(root, name)}`,
        );
    }
    let skillPath = previous?.skillPath;
    if (!command.options['no-skill'])
      skillPath = installSkill({
        force: true,
        targetRoot:
          typeof command.options['skill-dir'] === 'string'
            ? command.options['skill-dir']
            : skillPath
              ? dirname(skillPath)
              : undefined,
      }).installedPath;
    const build = readJson(join(extensionSource, 'browserpaw-build.json'));
    const priorPid = previous ? readJson(join(root, 'host.json'))?.pid : undefined;
    writeJson(recordPath, {
      version: CURRENT_VERSION,
      browsers,
      skillPath,
      extensionId,
      buildId: build?.buildId,
    });
    installHost(join(root, 'host'));
    replaceDirectory(join(root, 'extension'), (target) =>
      cpSync(extensionSource, target, { recursive: true }),
    );
    for (const browser of browsers) register(root, browser, extensionId);
    for (const browser of previous?.browsers ?? []) {
      if (!browsers.includes(browser)) unregister(root, browser, previous!.extensionId);
    }
    const restart = previous
      ? await requestHost('restart', {}, 4000).catch(() => undefined)
      : undefined;
    let reconnected = false;
    if (restart?.ok) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const status = await requestHost('status', undefined, 700)
          .then((response) => (response.ok ? response.json() : undefined))
          .catch(() => undefined);
        if (
          status?.connected &&
          status.pid !== priorPid &&
          status.extension?.buildId === build?.buildId
        ) {
          reconnected = true;
          break;
        }
        await delay(200);
      }
    }
    return {
      installed: true,
      extension: join(root, 'extension'),
      extensionId,
      skillPath,
      reloadRequested: restart?.ok ?? false,
      reconnected,
      next: reconnected
        ? 'BrowserPaw is connected. Run browserpaw status to inspect the loaded build.'
        : 'Open chrome://extensions, enable Developer mode, then load the installed extension directory or reload it if already loaded.',
    };
  } finally {
    unlock();
  }
}
