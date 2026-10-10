import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import console from 'node:console';

// Opt-in sync only: never sync externally by default
const syncDirEnv = (process.env.BROWSERPAW_EXTENSION_SYNC_DIR || '').trim();
if (!syncDirEnv) {
  console.log('[SYNC] Skipped: BROWSERPAW_EXTENSION_SYNC_DIR is not set.');
  process.exit(0);
}

const repoRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const SRC = resolve(repoRoot, 'app/chrome-extension/.output/chrome-mv3');

function assertNoSymlink(p) {
  let curr = resolve(p);
  while (true) {
    try {
      if (lstatSync(curr).isSymbolicLink()) {
        throw new Error('Security violation: symlink or junction forbidden: ' + curr);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
}

function resolveRealSafe(p) {
  assertNoSymlink(p);
  let curr = resolve(p);
  while (!existsSync(curr)) {
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  const realBase = existsSync(curr) ? realpathSync(curr) : resolve(curr);
  return resolve(realBase, relative(curr, resolve(p)));
}

const target = resolve(syncDirEnv);
assertNoSymlink(target);

const realRepo = realpathSync(repoRoot);
const realSrc = existsSync(SRC) ? realpathSync(SRC) : SRC;
const realTarget = resolveRealSafe(target);

// Security boundary checks:
// 1. Target cannot be source or inside source (prevents self-copy loop)
const relFromSrcToTarget = relative(realSrc, realTarget);
if (
  realTarget === realSrc ||
  (relFromSrcToTarget !== '' &&
    !relFromSrcToTarget.startsWith('..' + sep) &&
    relFromSrcToTarget !== '..')
) {
  console.error('[SYNC] Error: Target cannot be source or inside source.');
  process.exit(1);
}

// 2. Target cannot be repository root
if (realTarget === realRepo) {
  console.error('[SYNC] Error: Target cannot be repository root.');
  process.exit(1);
}

// 3. Target cannot be an ancestor/parent of repository root
const relFromTargetToRepo = relative(realTarget, realRepo);
if (
  relFromTargetToRepo !== '' &&
  !relFromTargetToRepo.startsWith('..' + sep) &&
  relFromTargetToRepo !== '..'
) {
  console.error('[SYNC] Error: Target cannot be an ancestor/parent of repository root.');
  process.exit(1);
}

// 5. Target cannot be user home directory
try {
  const realHome = realpathSync(os.homedir());
  if (realTarget === realHome) {
    console.error('[SYNC] Error: Target cannot be user home directory.');
    process.exit(1);
  }
} catch {}

// 4. Target cannot be filesystem root
if (realTarget === resolve('/') || realTarget.match(/^[a-zA-Z]:\\?$/)) {
  console.error('[SYNC] Error: Target cannot be filesystem root.');
  process.exit(1);
}

if (!existsSync(SRC)) {
  console.error('[SYNC] Error: extension build output directory does not exist: ' + SRC);
  process.exit(1);
}

if (!existsSync(join(SRC, 'manifest.json'))) {
  console.error('[SYNC] Error: manifest.json missing in source directory: ' + SRC);
  process.exit(1);
}

try {
  function checkTargetTree(dir) {
    assertNoSymlink(dir);
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, item.name);
      assertNoSymlink(child);
      if (item.isDirectory()) checkTargetTree(child);
    }
  }
  checkTargetTree(target);
  mkdirSync(target, { recursive: true });
  for (const sub of ['chunks', 'assets']) {
    const subPath = join(target, sub);
    if (existsSync(subPath)) {
      assertNoSymlink(subPath);
      const realSub = resolveRealSafe(subPath);
      const relSub = relative(realTarget, realSub);
      if (relSub.startsWith('..' + sep) || relSub === '..' || relSub === '') {
        throw new Error('Security boundary violation: target outside sync root: ' + subPath);
      }
      rmSync(subPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    }
  }
  cpSync(SRC, target, { recursive: true, force: true });

  // Hash verification between SRC and target
  function getFiles(dir, base = dir) {
    const out = [];
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) out.push(...getFiles(full, base));
      else if (item.isFile()) out.push(relative(base, full));
    }
    return out;
  }
  function fileHash(p) {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  for (const rel of getFiles(SRC)) {
    const srcFile = join(SRC, rel);
    const targetFile = join(target, rel);
    if (!existsSync(targetFile) || fileHash(srcFile) !== fileHash(targetFile)) {
      console.error('[SYNC] Error: hash verification mismatch for ' + rel);
      process.exit(1);
    }
  }

  console.log('[SYNC] Successfully synced extension build output to: ' + target);
} catch (err) {
  console.error('[SYNC] Failed to sync to ' + target + ':', err.message);
  process.exit(1);
}
