#!/usr/bin/env node

/**
 * BrowserPaw (mcp-chrome) System Healthcheck & Auto-Repair Tool
 *
 * Checks all communication layers:
 * 1. Bridge Token (~/.chrome-mcp/bridge-token)
 * 2. Fastify Native Bridge HTTP connectivity (http://127.0.0.1:12306/ping)
 * 3. Token Authentication & Security Guard
 * 4. Chrome Extension Build Output & Synchronization (source checkout only)
 * 5. Chrome Native Messaging Host Registration (Windows Registry / Host Manifest)
 * 6. Live MCP JSON-RPC Handshake (initialize & tools/list)
 *
 * Usage:
 *   node doctor.mjs        # Diagnose only
 *   node doctor.mjs --fix  # Diagnose and auto-repair common defects
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  cpSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve, relative, delimiter, dirname, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AUTO_FIX = process.argv.includes('--fix');
// Same precedence and validation as the daemon and clients: CHROME_MCP_PORT > MCP_HTTP_PORT > 12306.
const PORT = (() => {
  const raw = process.env.CHROME_MCP_PORT || process.env.MCP_HTTP_PORT;
  const parsed = raw ? Number.parseInt(String(raw), 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 12306;
})();
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN_DIR = join(homedir(), '.chrome-mcp');
const TOKEN_PATH = join(TOKEN_DIR, 'bridge-token');
// The repair wrappers cd into scripts/ before invoking doctor, so cwd is not the checkout.
// The canonical copy sits at skills/browserpaw/scripts/, but plugin mirrors sit deeper
// (plugins/<name>/skills/browserpaw/scripts/), so climb to the checkout marker instead of
// assuming a fixed depth; an explicit BROWSERPAW_REPO_ROOT still wins.
function findRepoRoot(start) {
  let dir = start;
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, 'app', 'chrome-extension', 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const scriptDir = dirname(fileURLToPath(import.meta.url));
const configuredRepoRoot = process.env.BROWSERPAW_REPO_ROOT?.trim();
const REPO_ROOT = configuredRepoRoot ? resolve(configuredRepoRoot) : findRepoRoot(scriptDir);
const CHECKOUT_MODE = Boolean(
  REPO_ROOT && existsSync(join(REPO_ROOT, 'app', 'chrome-extension', 'package.json')),
);
const REPAIR_MODE = AUTO_FIX && CHECKOUT_MODE;
const EXT_SRC_OUTPUT = CHECKOUT_MODE
  ? join(REPO_ROOT, 'app', 'chrome-extension', '.output', 'chrome-mv3')
  : null;
// Resolve standalone load directories from environment or explicit arguments instead of hardcoded paths
const STANDALONE_EXT_DIRS = process.env.BROWSERPAW_STANDALONE_DIRS
  ? process.env.BROWSERPAW_STANDALONE_DIRS.split(delimiter)
      .map((d) => d.trim())
      .filter(Boolean)
  : [];

console.log('\n================================================================');
console.log('         BrowserPaw System Healthcheck & Repair');
console.log('================================================================\n');
console.log(
  CHECKOUT_MODE
    ? `Mode: source checkout (${REPO_ROOT})`
    : 'Mode: installed skill (source checkout checks skipped)',
);
if (AUTO_FIX && !CHECKOUT_MODE) {
  console.log('       --fix is unavailable without a BrowserPaw source checkout.');
}
console.log('');

let passCount = 0;
let failCount = 0;

function report(status, title, details = '') {
  if (status) {
    passCount++;
    console.log(`[PASS] ${title}`);
  } else {
    failCount++;
    console.log(`[FAIL] ${title}`);
  }
  if (details) {
    const lines = details.split('\n');
    for (const l of lines) {
      console.log(`       ${l}`);
    }
  }
}

// 1. Environment & Node.js
const nodeVer = process.version;
report(true, `Node.js Environment: ${nodeVer} on ${platform()}`);

// 2. Bridge Token Check
let token = '';
try {
  token = readFileSync(TOKEN_PATH, 'utf8').trim();
  const valid = /^(?:[a-f0-9]{48}|[a-f0-9]{64})$/i.test(token);
  report(
    valid,
    `Bridge Credential: ${TOKEN_PATH}`,
    valid
      ? 'Readable and valid.'
      : 'Invalid format. Native must initialize a valid credential; doctor never rewrites it.',
  );
  if (!valid) token = '';
} catch (e) {
  report(
    false,
    `Bridge Credential Unavailable: ${TOKEN_PATH}`,
    `${e.code || 'READ_ERROR'}. Start the native host to initialize missing credentials; check file permissions for read failures.`,
  );
}

// 3. Fastify HTTP Service Connectivity
let httpOnline = false;
let pingRes = null;
try {
  const res = await fetch(`${BASE_URL}/ping`, { signal: AbortSignal.timeout(2000) });
  if (res.ok) {
    pingRes = await res.json();
    httpOnline = true;
    report(
      true,
      `Native Bridge Server is Listening (Port ${PORT})`,
      `Response: ${JSON.stringify(pingRes)}`,
    );
  } else {
    report(false, `Native Bridge Server returned HTTP ${res.status}`);
  }
} catch (e) {
  report(false, `Native Bridge Server is NOT reachable on ${BASE_URL}`, e.message);
  if (REPAIR_MODE && platform() === 'win32') {
    try {
      const netstat = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' });
      console.log('       Active listeners found on port:', netstat.trim());
    } catch {
      console.log(
        '       Port 12306 is free. Chrome extension will auto-start bridge on browser open.',
      );
    }
  }
}

// 4. Token Authentication Validation
if (httpOnline && token) {
  try {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'doctor', version: '1.0' },
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 401) {
      report(
        false,
        `Token Authentication Failed (401 Unauthorized)`,
        'Token in file does not match server memory. Server restart recommended.',
      );
    } else {
      const body = await res.text();
      const json = body.trim().startsWith('{')
        ? body
        : body
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6);
      const initBody = json ? JSON.parse(json) : null;
      report(
        res.ok && !!initBody?.result?.serverInfo && !initBody?.error,
        `Token Authentication & MCP Initialize`,
        `HTTP ${res.status}`,
      );
      const sessionId = res.headers.get('mcp-session-id');
      if (sessionId)
        await fetch(`${BASE_URL}/mcp`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, 'mcp-session-id': sessionId },
          signal: AbortSignal.timeout(3000),
        });
    }
  } catch (e) {
    report(false, `MCP Handshake Error`, e.message);
  }
}

// 5. Chrome Extension Build Output & Synchronization
let buildOk = false;
if (!CHECKOUT_MODE) {
  console.log('[INFO] Installed skill mode: source build and standalone-directory checks are skipped.');
} else if (
  existsSync(join(EXT_SRC_OUTPUT, 'manifest.json')) &&
  existsSync(join(EXT_SRC_OUTPUT, 'background.js'))
) {
  const manifest = JSON.parse(readFileSync(join(EXT_SRC_OUTPUT, 'manifest.json'), 'utf8'));
  buildOk = true;
  report(
    true,
    `Extension Build Found: ${EXT_SRC_OUTPUT}`,
    `Version: ${manifest.version}, Manifest: V${manifest.manifest_version}`,
  );
} else {
  report(
    false,
    `Extension Build Missing at ${EXT_SRC_OUTPUT}`,
    'Run: pnpm --filter chrome-mcp-server build',
  );
}

// Compare the complete build tree, not a sample: a stale manifest, content script, or
// extra file left by an older build must count as out of sync even when two files match.
function snapshotTree(dir) {
  const files = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(relative(dir, full), readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

function treesMatch(a, b) {
  const left = snapshotTree(a);
  const right = snapshotTree(b);
  if (left.size !== right.size) return false;
  for (const [rel, content] of left) {
    const other = right.get(rel);
    if (!other || !other.equals(content)) return false;
  }
  return true;
}

// cpSync merges into an existing tree, so files dropped from the current build would
// survive and the next run would still be out of sync. Clear the destination first,
// unless the destination contains the build itself (clearing it would delete the source).
function replaceTree(src, dest) {
  // readdirSync/rmSync follow a symlink or junction, so clearing one would erase the
  // real target's contents while the link itself survives and the copy still fails.
  // Reject the link before touching anything, and resolve real paths so a destination
  // that reaches the build through a link is still refused as self-destructive.
  let destStat = null;
  try {
    destStat = lstatSync(dest);
  } catch {}
  if (destStat?.isSymbolicLink()) {
    throw new Error(`Refusing to clear ${dest}: it is a symlink or junction`);
  }
  const realDest = destStat ? realpathSync(dest) : resolve(dest);
  const realSrc = resolve(src);
  const relFromDest = relative(realDest, realSrc);
  const srcInsideDest =
    relFromDest === '' || (!relFromDest.startsWith('..') && !isAbsolute(relFromDest));
  if (srcInsideDest) {
    throw new Error(`Refusing to clear ${dest}: it contains the extension build output`);
  }
  // The reverse nesting corrupts the build the same way: clearing a descendant of
  // the build deletes its files, and the copy then fails with ERR_FS_CP_EINVAL.
  const relFromSrc = relative(realSrc, realDest);
  const destInsideSrc =
    relFromSrc === '' || (!relFromSrc.startsWith('..') && !isAbsolute(relFromSrc));
  if (destInsideSrc) {
    throw new Error(`Refusing to clear ${dest}: it is inside the extension build output`);
  }
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(dest)) {
    rmSync(join(dest, entry), { recursive: true, force: true });
  }
  cpSync(src, dest, { recursive: true });
  return treesMatch(src, dest);
}

// Check Standalone Load Directories. Each directory reports exactly once, so a repair
// that succeeds does not leave the earlier failure counted against the final status.
for (const dir of CHECKOUT_MODE ? STANDALONE_EXT_DIRS : []) {
  if (!existsSync(dir)) {
    if (REPAIR_MODE && buildOk) {
      try {
        replaceTree(EXT_SRC_OUTPUT, dir);
        report(true, `Created and Synced Standalone Directory: ${dir}`);
      } catch (err) {
        report(false, `Failed to create/sync ${dir}`, err.message);
      }
    } else {
      report(false, `Standalone Directory Missing: ${dir}`, 'Directory does not exist');
    }
    continue;
  }
  // A configured path that is a file (or an unreadable directory) would make the tree
  // walk throw ENOTDIR/EACCES and abort every remaining check, so report it as failed.
  // A link is left to replaceTree, which refuses it with the clearer symlink message.
  let stat = null;
  let readable = false;
  try {
    stat = lstatSync(dir);
    // readdirSync is the operation treesMatch will perform; let it surface EACCES here.
    if (stat.isDirectory()) {
      readdirSync(dir);
      readable = true;
    }
  } catch {
    readable = false;
  }
  if (!readable && !stat?.isSymbolicLink()) {
    report(
      false,
      `Standalone Directory Unreadable: ${dir}`,
      'Configured path is not a readable directory',
    );
    continue;
  }
  if (buildOk && treesMatch(EXT_SRC_OUTPUT, dir)) {
    report(true, `Standalone Directory Synced: ${dir}`, `All build files matched.`);
    continue;
  }
  if (!(REPAIR_MODE && buildOk)) {
    report(false, `Standalone Directory Out of Sync: ${dir}`);
    continue;
  }
  try {
    if (!replaceTree(EXT_SRC_OUTPUT, dir)) {
      throw new Error('copy completed but the destination still differs from the build');
    }
    report(true, `Standalone Directory Synced via Auto-Fix: ${dir}`);
  } catch (err) {
    report(false, `Failed to copy build to ${dir}`, err.message);
  }
}

// 6. Chrome Native Messaging Host Registration (Windows Registry Check)
if (platform() === 'win32') {
  try {
    const regQuery = execSync(
      'reg query "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.chromemcp.nativehost" /ve',
      { encoding: 'utf8' },
    );
    const match = regQuery.match(/REG_SZ\s+(.*)/);
    const manifestPath = match ? match[1].trim() : '';
    if (manifestPath && existsSync(manifestPath)) {
      report(true, `Native Messaging Host Registered in Chrome`, `Host Manifest: ${manifestPath}`);
    } else {
      report(false, `Native Messaging Host Manifest File Missing: ${manifestPath}`);
    }
  } catch {
    report(
      false,
      `Native Messaging Host Registry Key Missing`,
      CHECKOUT_MODE
        ? 'Run: node app/native-server/dist/scripts/register.js'
        : 'Reinstall the BrowserPaw Native Messaging Host registration.',
    );
    if (REPAIR_MODE) {
      try {
        const regScript = join(REPO_ROOT, 'app', 'native-server', 'dist', 'scripts', 'register.js');
        if (existsSync(regScript)) {
          execSync(`node "${regScript}"`, { stdio: 'ignore' });
          report(true, `Native Messaging Host Auto-Registered via register.js`);
        }
      } catch (err) {
        console.log('       Auto-register failed:', err.message);
      }
    }
  }
}

// 7. Jev Decision Model & Local Service (Mapika/decider-2b)
const JEV_MODEL_DIR = join(homedir(), '.browserpaw', 'models', 'decider-2b');
const JEV_WEIGHTS_PATH = join(JEV_MODEL_DIR, 'model.safetensors');
const JEV_CONFIG_PATH = join(JEV_MODEL_DIR, 'config.json');

const modelDownloaded = existsSync(JEV_WEIGHTS_PATH) && existsSync(JEV_CONFIG_PATH);
if (modelDownloaded) {
  try {
    const fs = await import('node:fs');
    const sizeMB = Math.round(fs.statSync(JEV_WEIGHTS_PATH).size / (1024 * 1024));
    report(
      true,
      `Jev Decision Model Found: ${JEV_MODEL_DIR}`,
      `Weights: model.safetensors (${sizeMB} MB)`,
    );
  } catch {
    report(true, `Jev Decision Model Found: ${JEV_MODEL_DIR}`);
  }
} else {
  report(
    true,
    `Jev Decision Model (Mapika/decider-2b): Not Downloaded Yet`,
    `Optional: Open extension popup, click "Local" to download (~3.8GB) for offline inference.`,
  );
}

// Check local port 8009 service
const localServiceHint = CHECKOUT_MODE
  ? 'Run scripts/decider/start-local-service.bat'
  : 'Start it from the BrowserPaw local model configuration';
try {
  const localRes = await fetch('http://127.0.0.1:8009/ping', { signal: AbortSignal.timeout(800) });
  if (localRes.ok || localRes.status === 404) {
    report(
      true,
      `Local Jev Decider Service Listening on Port 8009`,
      `Endpoint: http://127.0.0.1:8009/v1/systemone`,
    );
  } else {
    report(
      true,
      `Local Jev Decider Service (Port 8009): Standby / Offline (${localServiceHint})`,
    );
  }
} catch {
  report(
    true,
    `Local Jev Decider Service (Port 8009): Standby / Offline (${localServiceHint})`,
  );
}

console.log('\n----------------------------------------------------------------');
console.log(`Diagnostic Complete: ${passCount} Passed, ${failCount} Failed.`);
if (failCount === 0) {
  console.log('STATUS: [HEALTHY] All BrowserPaw layers are operating normally!\n');
} else {
  console.log('STATUS: [ACTION REQUIRED] Please review the failed items above.');
  console.log(
    CHECKOUT_MODE
      ? 'TIP: Run `node skills/browserpaw/scripts/doctor.mjs --fix` for source-checkout repair.\n'
      : 'TIP: Resolve the failed runtime layer or reinstall BrowserPaw. Source-checkout --fix is unavailable for an installed skill.\n',
  );
  process.exitCode = 1;
}
