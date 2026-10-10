import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
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
  console.log('[SYNC] Skipped: extension build output directory does not exist.');
  process.exit(0);
}

try {
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
  console.log('[SYNC] Successfully synced extension build output to: ' + target);
} catch (err) {
  console.error('[SYNC] Failed to sync to ' + target + ':', err.message);
  process.exit(1);
}
