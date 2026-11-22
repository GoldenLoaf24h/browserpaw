import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CURRENT_VERSION, GITHUB_REPO_URL, isNewerVersion } from 'chrome-mcp-shared';
import { syncInstalledHostFromDist } from './cli-setup';
import { browserPawHome } from './learned-recipes';

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/browserpaw/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILED_CHECK_RETRY_MS = 10 * 60 * 1000;
const METADATA_TIMEOUT_MS = 2500;
const TARBALL_TIMEOUT_MS = 15_000;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;
const MAX_TAR_ENTRIES = 4000;
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+=*)$/;

const REQUIRED_DIST_FILES = [
  'cli.cjs',
  'host.cjs',
  'cli-files.cjs',
  'run_host.bat',
  'run_host.sh',
  join('skill', 'browserpaw', 'SKILL.md'),
] as const;

type UpdateState = {
  checkedAt?: number;
  autoUpdateCheckedAt?: number;
  autoUpdateRetryAfter?: number;
  notifyOnly?: boolean;
  latest?: string;
  activeVersion?: string;
  notified?: string[];
};

type RegistryManifest = {
  version: string;
  tarball?: string;
  integrity?: string;
};

export interface ManagedCliInstall {
  version: string;
  packageDir: string;
  distDir: string;
  cliPath: string;
}

function normalizeRepoUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

function resolveRegistryUrl(): { url: string; isLoopbackOverride: boolean } {
  const override = process.env.BROWSERPAW_UPDATE_REGISTRY_URL?.trim();
  if (override) {
    try {
      const parsed = new URL(override);
      if (
        parsed.protocol === 'http:' &&
        !parsed.username &&
        !parsed.password &&
        (parsed.hostname === '127.0.0.1' ||
          parsed.hostname === 'localhost' ||
          parsed.hostname === '::1')
      ) {
        return { url: parsed.href, isLoopbackOverride: true };
      }
    } catch {
      // Ignore malformed override and fall back to official registry.
    }
  }
  return { url: DEFAULT_REGISTRY_URL, isLoopbackOverride: false };
}

function isAllowedTarballUrl(
  tarballUrl: string,
  registry: { url: string; isLoopbackOverride: boolean },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(tarballUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (!parsed.pathname.endsWith('.tgz')) return false;
  if (registry.isLoopbackOverride) {
    return parsed.origin === new URL(registry.url).origin;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'registry.npmjs.org' &&
    parsed.pathname.startsWith('/browserpaw/-/')
  );
}

function parseOctalOrBase256(buf: Buffer, offset: number, length: number): number {
  const slice = buf.subarray(offset, offset + length);
  if (slice.length > 0 && (slice[0] & 0x80) !== 0) {
    let value = 0;
    for (let i = 1; i < slice.length; i += 1) {
      value = value * 256 + slice[i];
    }
    return value;
  }
  const text = slice.toString('ascii').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`Invalid tar octal field: ${text}`);
  return Number.parseInt(text, 8);
}

function readTarString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  const stop = end === -1 || end >= offset + length ? offset + length : end;
  return buf.subarray(offset, stop).toString('utf8');
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let cursor = 0;
  while (cursor < data.length) {
    const space = data.indexOf(0x20, cursor);
    if (space === -1) break;
    const lenText = data.subarray(cursor, space).toString('ascii');
    const recordLen = Number.parseInt(lenText, 10);
    if (!Number.isInteger(recordLen) || recordLen <= 0 || cursor + recordLen > data.length) {
      throw new Error('Malformed PAX tar header');
    }
    const line = data.subarray(space + 1, cursor + recordLen).toString('utf8');
    const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      records[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    cursor += recordLen;
  }
  return records;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function sanitizeTarEntryPath(rawPath: string): string {
  let normalized = rawPath.replace(/^\.\//, '');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, '');
  if (!normalized) throw new Error('Empty tar entry path');
  if (
    normalized.includes('\0') ||
    normalized.includes('\\') ||
    normalized.includes(':') ||
    normalized.startsWith('/') ||
    hasControlChars(normalized)
  ) {
    throw new Error(`Unsafe tar entry path: ${rawPath}`);
  }
  const segments = normalized.split('/');
  if (segments[0] !== 'package') {
    throw new Error(`Tar entry escapes package root: ${rawPath}`);
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`Unsafe tar path segment: ${rawPath}`);
    }
  }
  return segments.join('/');
}

export function extractVerifiedPackageTgz(
  tgzBytes: Buffer,
  integrity: string,
  destinationDir: string,
): void {
  const match = SHA512_INTEGRITY.exec(integrity);
  if (!match) throw new Error('Tarball integrity must be a valid sha512 SRI string');
  const expectedDigest = Buffer.from(match[1], 'base64');
  const actualDigest = createHash('sha512').update(tgzBytes).digest();
  if (
    expectedDigest.length !== actualDigest.length ||
    !timingSafeEqual(expectedDigest, actualDigest)
  ) {
    throw new Error('Tarball SHA-512 integrity verification failed');
  }

  const tar = gunzipSync(tgzBytes, { maxOutputLength: MAX_EXTRACTED_BYTES });
  const { assertNoLinks } = require('./cli-files.cjs');
  assertNoLinks(destinationDir);
  const rootAbs = resolve(destinationDir);

  let offset = 0;
  let entries = 0;
  let totalBytes = 0;
  let nextPax: Record<string, string> | undefined;
  let nextGnuLongName: string | undefined;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;

    const typeByte = header[156];
    const typeFlag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const rawSize = parseOctalOrBase256(header, 124, 12);
    const size =
      nextPax?.size && /^\d+$/.test(nextPax.size) ? Number.parseInt(nextPax.size, 10) : rawSize;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) {
      throw new Error('Truncated or invalid tar entry size');
    }
    const content = tar.subarray(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    if (typeFlag === 'x') {
      nextPax = parsePaxRecords(content);
      continue;
    }
    if (typeFlag === 'g') {
      continue;
    }
    if (typeFlag === 'L') {
      nextGnuLongName = content.toString('utf8').replace(/\0.*$/, '');
      continue;
    }

    const namePart = readTarString(header, 0, 100);
    const prefixPart = readTarString(header, 345, 155);
    const combinedName =
      nextPax?.path ?? nextGnuLongName ?? (prefixPart ? `${prefixPart}/${namePart}` : namePart);
    nextPax = undefined;
    nextGnuLongName = undefined;

    if (typeFlag !== '0' && typeFlag !== '5') {
      throw new Error(`Unsupported tar entry type '${typeFlag}' for ${combinedName}`);
    }

    entries += 1;
    if (entries > MAX_TAR_ENTRIES) {
      throw new Error('Tarball exceeds maximum allowed file count');
    }

    const safeRel = sanitizeTarEntryPath(combinedName);
    const targetPath = resolve(rootAbs, safeRel);
    if (targetPath !== rootAbs && !targetPath.startsWith(rootAbs + sep)) {
      throw new Error(`Tar entry escapes destination: ${safeRel}`);
    }

    if (typeFlag === '5') {
      mkdirSync(targetPath, { recursive: true, mode: 0o700 });
      continue;
    }

    totalBytes += size;
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new Error('Tarball exceeds maximum allowed extracted size');
    }
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    writeFileSync(targetPath, content, { flag: 'wx', mode: 0o600 });
  }
}

function assertNoSymlinksInTree(rootDir: string): void {
  const stat = lstatSync(rootDir, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Invalid directory tree: ${rootDir}`);
  }
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const entryStat = lstatSync(full);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Symlink forbidden in managed CLI package: ${full}`);
      }
      if (entryStat.isDirectory()) {
        stack.push(full);
      } else if (!entryStat.isFile()) {
        throw new Error(`Unsupported file type in managed CLI package: ${full}`);
      }
    }
  }
}

function verifyExtractedRelease(packageDir: string, expectedVersion: string): ManagedCliInstall {
  const { assertNoLinks } = require('./cli-files.cjs');
  assertNoLinks(packageDir);
  assertNoSymlinksInTree(packageDir);

  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) throw new Error('Extracted package is missing package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
    repository?: { url?: unknown };
    bin?: Record<string, unknown>;
  };
  if (pkg.name !== 'browserpaw') throw new Error('Extracted package name mismatch');
  if (pkg.version !== expectedVersion) throw new Error('Extracted package version mismatch');
  if (normalizeRepoUrl(pkg.repository?.url) !== GITHUB_REPO_URL) {
    throw new Error('Extracted package repository mismatch');
  }
  if (pkg.bin?.browserpaw !== './dist/v5/cli.cjs') {
    throw new Error('Extracted package bin entry mismatch');
  }

  const distDir = join(packageDir, 'dist', 'v5');
  for (const rel of REQUIRED_DIST_FILES) {
    const full = join(distDir, rel);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
      throw new Error(`Extracted package is missing required file: ${rel}`);
    }
  }

  const recipesDir = join(distDir, 'recipes');
  const recipesStat = lstatSync(recipesDir, { throwIfNoEntry: false });
  if (
    !recipesStat ||
    recipesStat.isSymbolicLink() ||
    !recipesStat.isDirectory() ||
    !readdirSync(recipesDir).some((name) => /^[a-z][a-z0-9-]*\.json$/.test(name))
  ) {
    throw new Error('Extracted package is missing bundled recipes');
  }

  return {
    version: expectedVersion,
    packageDir,
    distDir,
    cliPath: join(distDir, 'cli.cjs'),
  };
}

function versionsRoot(homeDir: string): string {
  return join(homeDir, 'cli-versions');
}

function validateManagedInstallDir(
  homeDir: string,
  version: string,
): ManagedCliInstall | undefined {
  if (!STABLE_VERSION.test(version)) return undefined;
  const packageDir = join(versionsRoot(homeDir), version);
  try {
    const { assertNoLinks } = require('./cli-files.cjs');
    assertNoLinks(packageDir);
    const pkgStat = lstatSync(packageDir, { throwIfNoEntry: false });
    if (!pkgStat || pkgStat.isSymbolicLink() || !pkgStat.isDirectory()) return undefined;
    const distDir = join(packageDir, 'dist', 'v5');
    const cliPath = join(distDir, 'cli.cjs');
    const hostPath = join(distDir, 'host.cjs');
    const pkgPath = join(packageDir, 'package.json');
    for (const file of [cliPath, hostPath, pkgPath]) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return undefined;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (pkg.name !== 'browserpaw' || pkg.version !== version) return undefined;
    return { version, packageDir, distDir, cliPath };
  } catch {
    return undefined;
  }
}

export function resolveActiveManagedCli(
  homeDir = browserPawHome(),
  currentVersion = CURRENT_VERSION,
): ManagedCliInstall | undefined {
  try {
    const { readJson } = require('./cli-files.cjs');
    const state = readJson(join(homeDir, 'cli-update.json')) as UpdateState | undefined;
    const activeVersion = state?.activeVersion;
    if (typeof activeVersion !== 'string' || !STABLE_VERSION.test(activeVersion)) return undefined;
    if (!isNewerVersion(activeVersion, currentVersion)) return undefined;
    return validateManagedInstallDir(homeDir, activeVersion);
  } catch {
    return undefined;
  }
}

function readStateWithCorruptRecovery(statePath: string): UpdateState | undefined {
  const { readJson } = require('./cli-files.cjs');
  try {
    return readJson(statePath) as UpdateState | undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backup = `${statePath}.corrupt.${Date.now()}-${process.pid}`;
    renameSync(statePath, backup);
    console.error(
      `BrowserPaw update state was corrupt; moved it to ${backup} and started from empty state.`,
    );
    return undefined;
  }
}

async function fetchRegistryManifest(): Promise<RegistryManifest | undefined> {
  const registry = resolveRegistryUrl();
  try {
    const response = await fetch(registry.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const manifest = (await response.json()) as {
      name?: unknown;
      version?: unknown;
      repository?: { url?: unknown };
      dist?: { tarball?: unknown; integrity?: unknown };
    };
    if (
      manifest?.name !== 'browserpaw' ||
      normalizeRepoUrl(manifest?.repository?.url) !== GITHUB_REPO_URL
    ) {
      return undefined;
    }
    const version = manifest.version;
    if (typeof version !== 'string' || !STABLE_VERSION.test(version)) return undefined;
    const rawTarball = manifest.dist?.tarball;
    const rawIntegrity = manifest.dist?.integrity;
    const tarball =
      typeof rawTarball === 'string' && isAllowedTarballUrl(rawTarball, registry)
        ? rawTarball
        : undefined;
    const integrity =
      typeof rawIntegrity === 'string' && SHA512_INTEGRITY.test(rawIntegrity)
        ? rawIntegrity
        : undefined;
    return {
      version,
      ...(tarball && integrity ? { tarball, integrity } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function downloadTarballBytes(
  url: string,
  maxBytes = MAX_TARBALL_BYTES,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TARBALL_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Tarball download failed with HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Tarball exceeds maximum allowed download size');
    }
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > maxBytes) {
        throw new Error('Tarball size is outside allowed bounds');
      }
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new Error('Tarball exceeds maximum allowed download size');
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } finally {
      reader.releaseLock();
    }
    if (total === 0) {
      throw new Error('Tarball size is outside allowed bounds');
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

function pruneOldManagedVersions(root: string, keepVersion: string): void {
  const dir = versionsRoot(root);
  if (!existsSync(dir)) return;
  const installed = readdirSync(dir)
    .filter((name) => STABLE_VERSION.test(name))
    .sort((left, right) => {
      if (left === right) return 0;
      return isNewerVersion(left, right) ? -1 : 1;
    });
  const keep = new Set<string>([keepVersion]);
  for (const version of installed) {
    if (keep.size >= 2) break;
    keep.add(version);
  }
  for (const version of installed) {
    if (keep.has(version)) continue;
    try {
      rmSync(join(dir, version), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of old versions.
    }
  }
}

async function installManagedRelease(
  homeDir: string,
  manifest: Required<RegistryManifest>,
): Promise<ManagedCliInstall> {
  const { ensureDirectory } = require('./cli-files.cjs');
  const root = versionsRoot(homeDir);
  ensureDirectory(root);
  const staging = join(root, `.staging-${randomUUID()}`);
  const backup = join(root, `.backup-${randomUUID()}`);
  const target = join(root, manifest.version);
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  let removeBackup = false;
  try {
    const tgzBytes = await downloadTarballBytes(manifest.tarball);
    extractVerifiedPackageTgz(tgzBytes, manifest.integrity, staging);
    const extractedPkgDir = join(staging, 'package');
    verifyExtractedRelease(extractedPkgDir, manifest.version);
    if (process.platform !== 'win32') {
      for (const executable of ['cli.cjs', 'host.cjs', 'run_host.sh']) {
        chmodSync(join(extractedPkgDir, 'dist', 'v5', executable), 0o755);
      }
    }
    const existed = existsSync(target);
    if (existed) renameSync(target, backup);
    try {
      renameSync(extractedPkgDir, target);
      removeBackup = true;
    } catch (error) {
      if (existed && existsSync(backup)) {
        try {
          renameSync(backup, target);
          removeBackup = true;
        } catch {
          // Preserve backup if restore fails.
        }
      }
      throw error;
    }
    const installed = verifyExtractedRelease(target, manifest.version);
    pruneOldManagedVersions(homeDir, manifest.version);
    try {
      syncInstalledHostFromDist(homeDir, installed.distDir, installed.version);
    } catch {
      // Non-fatal: host will re-sync on next setup or command.
    }
    return installed;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (removeBackup) {
      rmSync(backup, { recursive: true, force: true });
    }
  }
}

export async function ensureOnDemandCliUpdate(
  options: { currentVersion?: string } = {},
): Promise<{ activeVersion?: string; updated: boolean; latest?: string }> {
  const currentVersion = options.currentVersion ?? CURRENT_VERSION;
  const root = browserPawHome();
  const existingActive = resolveActiveManagedCli(root, currentVersion)?.version;
  if (process.env.BROWSERPAW_NO_UPDATE_CHECK === '1') {
    return { activeVersion: existingActive, updated: false };
  }
  const statePath = join(root, 'cli-update.json');
  const { ensureDirectory, acquireLock, atomicWrite } = require('./cli-files.cjs');
  try {
    ensureDirectory(root);
    const unlock = acquireLock(join(root, '.cli-update.lock'));
    try {
      const state = readStateWithCorruptRecovery(statePath);
      const notified = Array.isArray(state?.notified) ? state.notified : [];
      const currentActive =
        typeof state?.activeVersion === 'string' &&
        isNewerVersion(state.activeVersion, currentVersion) &&
        validateManagedInstallDir(root, state.activeVersion)
          ? state.activeVersion
          : undefined;
      const effectiveVersion =
        currentActive && isNewerVersion(currentActive, currentVersion)
          ? currentActive
          : currentVersion;
      const now = Date.now();
      const lastAutoCheck =
        typeof state?.autoUpdateCheckedAt === 'number'
          ? state.autoUpdateCheckedAt
          : state?.notifyOnly
            ? NaN
            : (state?.checkedAt ?? NaN);
      const age = now - lastAutoCheck;
      const retryAfter =
        typeof state?.autoUpdateRetryAfter === 'number' ? state.autoUpdateRetryAfter : undefined;
      const due =
        retryAfter !== undefined ? now >= retryAfter : !(age >= 0 && age < CHECK_INTERVAL_MS);
      if (!due) {
        return {
          activeVersion: currentActive,
          updated: false,
          latest: state?.latest,
        };
      }

      const manifest = await fetchRegistryManifest();
      let activeVersion = currentActive;
      let updated = false;
      let installFailed = false;
      const latest = manifest?.version ?? state?.latest;

      if (
        manifest &&
        isNewerVersion(manifest.version, effectiveVersion) &&
        manifest.tarball &&
        manifest.integrity
      ) {
        try {
          const installed = await installManagedRelease(root, {
            version: manifest.version,
            tarball: manifest.tarball,
            integrity: manifest.integrity,
          });
          activeVersion = installed.version;
          updated = true;
        } catch {
          installFailed = true;
        }
      }

      const nextNotified =
        updated && activeVersion && !notified.includes(activeVersion)
          ? [...notified, activeVersion]
          : notified;
      const transientFailure = !manifest || installFailed;
      atomicWrite(
        statePath,
        JSON.stringify({
          checkedAt: transientFailure ? (state?.checkedAt ?? now) : now,
          ...(transientFailure
            ? {
                ...(typeof state?.autoUpdateCheckedAt === 'number'
                  ? { autoUpdateCheckedAt: state.autoUpdateCheckedAt }
                  : {}),
                autoUpdateRetryAfter: now + FAILED_CHECK_RETRY_MS,
              }
            : { autoUpdateCheckedAt: now }),
          latest,
          ...(activeVersion ? { activeVersion } : {}),
          notified: nextNotified,
        }) + '\n',
      );
      return { activeVersion, updated, latest };
    } finally {
      unlock();
    }
  } catch {
    return { activeVersion: existingActive, updated: false };
  }
}

export async function checkForCliUpdate(): Promise<string | undefined> {
  if (process.env.BROWSERPAW_NO_UPDATE_CHECK === '1') return;
  const root = browserPawHome();
  const statePath = join(root, 'cli-update.json');
  const { ensureDirectory, acquireLock, atomicWrite } = require('./cli-files.cjs');
  try {
    ensureDirectory(root);
    const unlock = acquireLock(join(root, '.cli-update.lock'));
    try {
      const state = readStateWithCorruptRecovery(statePath);
      const notified = Array.isArray(state?.notified) ? state.notified : [];
      const activeVersion =
        typeof state?.activeVersion === 'string' && STABLE_VERSION.test(state.activeVersion)
          ? state.activeVersion
          : undefined;
      const now = Date.now();
      const age = now - (state?.checkedAt ?? NaN);
      const check = !(age >= 0 && age < CHECK_INTERVAL_MS);
      let latest = state?.latest;
      if (check) {
        const manifest = await fetchRegistryManifest();
        latest = manifest?.version;
      }
      const shouldNotify =
        typeof latest === 'string' &&
        STABLE_VERSION.test(latest) &&
        isNewerVersion(latest, CURRENT_VERSION) &&
        activeVersion !== latest &&
        !notified.includes(latest);
      if (check || shouldNotify) {
        atomicWrite(
          statePath,
          JSON.stringify({
            checkedAt: check ? now : state?.checkedAt,
            ...(typeof state?.autoUpdateCheckedAt === 'number'
              ? { autoUpdateCheckedAt: state.autoUpdateCheckedAt }
              : check || state?.notifyOnly
                ? { notifyOnly: true }
                : {}),
            ...(typeof state?.autoUpdateRetryAfter === 'number'
              ? { autoUpdateRetryAfter: state.autoUpdateRetryAfter }
              : {}),
            latest,
            ...(activeVersion ? { activeVersion } : {}),
            notified: shouldNotify ? [...notified, latest] : notified,
          }) + '\n',
        );
      }
      return shouldNotify ? latest : undefined;
    } finally {
      unlock();
    }
  } catch {
    return undefined;
  }
}

function firstCommandToken(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg === '--') return undefined;
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

function skipsAutoUpdateCheck(argv: readonly string[]): boolean {
  if (!argv.length) return true;
  if (argv[0] === '--version' || argv[0] === '-V') return true;
  const terminator = argv.indexOf('--');
  const flags = argv.slice(0, terminator < 0 ? undefined : terminator);
  return flags.includes('--help') || flags.includes('-h') || argv[0] === 'help';
}

export async function maybeDelegateToManagedCli(
  argv: readonly string[],
): Promise<number | undefined> {
  if (
    process.env.BROWSERPAW_NO_AUTO_UPDATE === '1' ||
    process.env.BROWSERPAW_CLI_DELEGATED === '1'
  ) {
    return undefined;
  }
  const commandToken = firstCommandToken(argv);
  if (commandToken === 'uninstall') return undefined;

  const root = browserPawHome();
  if (process.env.BROWSERPAW_NO_UPDATE_CHECK !== '1' && !skipsAutoUpdateCheck(argv)) {
    await ensureOnDemandCliUpdate({ currentVersion: CURRENT_VERSION });
  }
  const managed = resolveActiveManagedCli(root, CURRENT_VERSION);
  if (!managed) return undefined;

  try {
    const currentScript = process.argv[1] ? resolve(process.argv[1]) : undefined;
    if (currentScript && resolve(managed.cliPath) === currentScript) return undefined;
    if (!statSync(managed.cliPath).isFile()) return undefined;
  } catch {
    return undefined;
  }

  return await new Promise<number | undefined>((resolveExit) => {
    const child = spawn(process.execPath, [managed.cliPath, ...argv], {
      stdio: 'inherit',
      env: {
        ...process.env,
        BROWSERPAW_CLI_DELEGATED: '1',
        BROWSERPAW_NO_UPDATE_CHECK: '1',
      },
    });
    const forwardSigint = () => {
      if (process.platform === 'win32') return;
      try {
        child.kill('SIGINT');
      } catch {
        // Ignore if child already exited.
      }
    };
    const forwardSigterm = () => {
      if (process.platform === 'win32') return;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore if child already exited.
      }
    };
    process.on('SIGINT', forwardSigint);
    process.on('SIGTERM', forwardSigterm);
    const cleanup = () => {
      process.removeListener('SIGINT', forwardSigint);
      process.removeListener('SIGTERM', forwardSigterm);
    };
    child.once('error', () => {
      cleanup();
      resolveExit(undefined);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolveExit(typeof code === 'number' ? code : signal ? 1 : 0);
    });
  });
}
