import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
import { HOST_NAME, CURRENT_VERSION, GITHUB_REPO_URL, type ParsedCommand } from 'chrome-mcp-shared';
import { BrowserType, getBrowserConfig } from './scripts/browser-config';
import { installSkill, upgradeInstalledSkill, type InstalledSkillScope } from './skill-install';
import { loadLearnedWorkflows, syncLearnedRouting } from './learned-recipes';
import type { requestHost as hostRequest } from './command-client';

const installationRoot = () =>
  resolve(process.env.BROWSERPAW_HOME || join(homedir(), '.browserpaw'));
const files = ['host.cjs', 'run_host.bat', 'run_host.sh'];
type SkillMode = 'managed' | 'disabled' | 'plugin';

interface Installation {
  version: string;
  browsers: BrowserType[];
  skillMode?: SkillMode;
  skillPath?: string;
  skillScope?: InstalledSkillScope;
  skillPaths?: string[];
  extensionId: string;
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

function installHost(
  destination: string,
  sourceDir: string = __dirname,
  version: string = CURRENT_VERSION,
) {
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
    const source = join(sourceDir, file);
    replace(file, readFileSync(source), statSync(source).mode & 0o777);
    if (file === 'run_host.sh' && process.platform !== 'win32')
      chmodSync(join(destination, file), 0o755);
  }
  replace('node_path.txt', Buffer.from(process.execPath + '\n'), 0o600);
  replace('host-version.txt', Buffer.from(version + '\n'), 0o600);
  replaceDirectory(join(destination, 'recipes'), (staging) =>
    cpSync(join(sourceDir, 'recipes'), staging, { recursive: true }),
  );
}

export function syncInstalledHostFromDist(
  root: string,
  sourceDistDir: string,
  version: string,
): boolean {
  const recordPath = join(root, 'installation.json');
  const previous: Installation | undefined = readJson(recordPath);
  if (!previous) return false;
  for (const file of files) {
    if (!existsSync(join(sourceDistDir, file))) return false;
  }
  if (!existsSync(join(sourceDistDir, 'recipes'))) return false;
  const { acquireLock, assertNoLinks } = require('./cli-files.cjs');
  assertNoLinks(root);
  const unlock = acquireLock(join(root, '.installation.lock'));
  try {
    const current: Installation | undefined = readJson(recordPath);
    if (!current) return false;
    installHost(join(root, 'host'), sourceDistDir, version);
    const skillSourceDir = join(sourceDistDir, 'skill', 'browserpaw');
    const skillPaths = new Set<string>([
      ...(Array.isArray(current.skillPaths) ? current.skillPaths : []),
      ...(current.skillPath ? [current.skillPath] : []),
    ]);
    if (current.skillMode === 'managed' && existsSync(join(skillSourceDir, 'SKILL.md'))) {
      for (const candidate of skillPaths) {
        try {
          upgradeInstalledSkill(candidate, { sourceDir: skillSourceDir, version });
        } catch {
          // Non-fatal: keep existing managed skill copy if a path is unavailable.
        }
      }
    }
    try {
      syncLearnedRouting(root, [...skillPaths]);
    } catch {
      // Non-fatal: routing will re-sync on the next recipe or setup command.
    }
    writeJson(recordPath, {
      ...current,
      version,
    });
    return true;
  } finally {
    unlock();
  }
}

export async function manageInstallation(command: ParsedCommand, requestHost: typeof hostRequest) {
  const root = installationRoot();
  const recordPath = join(root, 'installation.json');
  const previous: Installation | undefined = readJson(recordPath);
  if (command.name === 'uninstall') {
    if (!previous) return { installed: false };
    for (const browser of previous.browsers) unregister(root, browser, previous.extensionId);
    const managedSkills = new Set<string>([
      ...(Array.isArray(previous.skillPaths) ? previous.skillPaths : []),
      ...(previous.skillPath ? [previous.skillPath] : []),
    ]);
    for (const candidate of managedSkills) {
      const marker = readJson(join(candidate, '.browserpaw-skill.json'));
      if (marker?.name === 'browserpaw') rmSync(candidate, { recursive: true, force: true });
    }
    for (const target of ['host', 'extension'])
      rmSync(join(root, target), { recursive: true, force: true });
    rmSync(recordPath, { force: true });
    if (command.options.purge) {
      for (const target of [
        'tasks.json',
        'skills',
        'recipes',
        'learned-index.json',
        'out',
        'logs',
        'token',
        'host.json',
        'cli-versions',
        'cli-update.json',
      ])
        rmSync(join(root, target), { recursive: true, force: true });
    }
    return { installed: false, dataPreserved: !command.options.purge };
  }
  if (command.name === 'doctor') {
    if (command.options.fix && !previous) throw new Error('Run browserpaw setup first.');
    if (command.options.fix && previous) {
      for (const browser of previous.browsers) register(root, browser, previous.extensionId);
      syncLearnedRouting(root);
    }
    const installedHost = existsSync(join(root, 'host', 'host.cjs'));
    const extension = join(root, 'extension');
    const host = await requestHost('status', undefined, 4000)
      .then(async (response) => (response.ok ? await response.json() : undefined))
      .catch(() => undefined);
    const learnedCount = loadLearnedWorkflows(root, { includeCandidates: false }).length;
    return {
      installed: previous?.version,
      hostPresent: installedHost,
      extension,
      extensionPresent: existsSync(join(extension, 'manifest.json')),
      ...(previous?.skillPath
        ? {
            skillPath: previous.skillPath,
            skillScope: previous.skillScope ?? 'user',
            skillPresent: existsSync(join(previous.skillPath, 'SKILL.md')),
          }
        : {}),
      learnedHome: root,
      learnedCount,
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
  const browser = command.options.browser;
  if (browser !== undefined && browser !== 'chrome' && browser !== 'chromium' && browser !== 'all')
    throw new Error('Use --browser chrome, chromium, or all.');
  const browsers =
    browser === 'all'
      ? [BrowserType.CHROME, BrowserType.CHROMIUM]
      : browser
        ? [browser as BrowserType]
        : (previous?.browsers ?? [BrowserType.CHROME]);
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
    const managedArtifactDirectory = (name: 'host' | 'extension') => {
      const directory = join(root, name);
      if (name === 'host') return files.some((file) => existsSync(join(directory, file)));
      try {
        return readJson(join(directory, 'manifest.json'))?.name === 'browserpaw';
      } catch {
        return false;
      }
    };
    for (const name of ['host', 'extension'] as const) {
      const entry = lstatSync(join(root, name), { throwIfNoEntry: false });
      if (
        entry &&
        (!entry.isDirectory() ||
          entry.isSymbolicLink() ||
          (!previous && !managedArtifactDirectory(name)))
      )
        throw new Error(
          `Existing directory is outside the managed installation: ${join(root, name)}`,
        );
    }
    let skillPath = previous?.skillPath;
    let skillScope = previous?.skillScope;
    const skillPaths = new Set<string>([
      ...(Array.isArray(previous?.skillPaths) ? previous.skillPaths : []),
      ...(previous?.skillPath ? [previous.skillPath] : []),
    ]);
    const updatedSkillPaths: string[] = [];
    const requestedScope =
      typeof command.options['skill-scope'] === 'string'
        ? command.options['skill-scope']
        : undefined;
    const requestedDir =
      typeof command.options['skill-dir'] === 'string' ? command.options['skill-dir'] : undefined;
    if (command.options['no-skill'] && (requestedScope || requestedDir)) {
      throw new Error('Do not combine --no-skill with --skill-scope or --skill-dir.');
    }
    const usesPluginSkill = previous?.skillMode === 'plugin' && !requestedScope && !requestedDir;
    let skillMode: SkillMode = command.options['no-skill']
      ? 'disabled'
      : usesPluginSkill
        ? 'plugin'
        : 'managed';
    if (!command.options['no-skill'] && !usesPluginSkill) {
      const installedSkill = installSkill({
        force: true,
        version: CURRENT_VERSION,
        ...(requestedScope ? { scope: requestedScope } : {}),
        ...(requestedDir
          ? { targetRoot: requestedDir }
          : !requestedScope && skillPath
            ? { targetRoot: dirname(skillPath) }
            : {}),
      });
      skillPath = installedSkill.installedPath;
      skillScope =
        requestedScope || requestedDir
          ? installedSkill.scope
          : (previous?.skillScope ?? installedSkill.scope);
      skillMode = 'managed';
      skillPaths.add(skillPath);
      updatedSkillPaths.push(skillPath);
      for (const candidate of skillPaths) {
        if (
          candidate !== skillPath &&
          upgradeInstalledSkill(candidate, { version: CURRENT_VERSION })
        ) {
          updatedSkillPaths.push(candidate);
        }
      }
    }
    const extensionTarget = join(root, 'extension');
    const manifestPath = join(extensionTarget, 'manifest.json');
    let hasValidManifest = false;
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          name?: unknown;
        };
        hasValidManifest =
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof parsed.name === 'string' &&
          parsed.name.trim().length > 0;
      } catch {
        hasValidManifest = false;
      }
    }
    const extensionPrepared = !previous || !hasValidManifest;
    if (extensionPrepared) {
      replaceDirectory(extensionTarget, (target) =>
        cpSync(extensionSource, target, { recursive: true }),
      );
    }
    installHost(join(root, 'host'));
    for (const browser of browsers) register(root, browser, extensionId);
    for (const browser of previous?.browsers ?? []) {
      if (!browsers.includes(browser)) unregister(root, browser, previous!.extensionId);
    }
    const routing = syncLearnedRouting(root, [...skillPaths]);
    writeJson(recordPath, {
      version: CURRENT_VERSION,
      browsers,
      skillMode,
      skillPath,
      skillScope,
      skillPaths: [...skillPaths],
      extensionId,
    });
    const releaseAsset = `${GITHUB_REPO_URL}/releases/download/v${CURRENT_VERSION}/browserpaw-extension.zip`;
    return {
      installed: true,
      extension: join(root, 'extension'),
      extensionId,
      skillPath,
      updatedSkillPaths,
      ...(skillScope ? { skillScope } : {}),
      learnedHome: root,
      learnedCount: routing.workflowCount,
      extensionPrepared,
      ...(previous && !extensionPrepared ? { releaseAsset } : {}),
      next: extensionPrepared
        ? 'Open chrome://extensions, enable Developer mode, then load the installed extension directory.'
        : 'If the extension version differs, download and unpack the release ZIP from releaseAsset. Load it in chrome://extensions or reload after replacing the files in the loaded directory. Reload an already matching extension to reconnect the host, then run browserpaw status.',
    };
  } finally {
    unlock();
  }
}
