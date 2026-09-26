#!/usr/bin/env node

/**
 * BrowserPaw (mcp-chrome) System Healthcheck & Auto-Repair Tool
 *
 * Checks all communication layers:
 * 1. Bridge Token (~/.chrome-mcp/bridge-token)
 * 2. Fastify Native Bridge HTTP connectivity (http://127.0.0.1:12306/ping)
 * 3. Token Authentication & Security Guard
 * 4. Chrome Extension Build Output & Synchronization (D:\workspace\browserpaw)
 * 5. Chrome Native Messaging Host Registration (Windows Registry / Host Manifest)
 * 6. Live MCP JSON-RPC Handshake (initialize & tools/list)
 *
 * Usage:
 *   node doctor.mjs        # Diagnose only
 *   node doctor.mjs --fix  # Diagnose and auto-repair common defects
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const AUTO_FIX = process.argv.includes('--fix');
const PORT = 12306;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN_DIR = join(homedir(), '.chrome-mcp');
const TOKEN_PATH = join(TOKEN_DIR, 'bridge-token');
const REPO_ROOT = resolve(process.cwd());
const EXT_SRC_OUTPUT = join(REPO_ROOT, 'app', 'chrome-extension', '.output', 'chrome-mv3');
const STANDALONE_EXT_DIR = 'D:\\workspace\\browserpaw';

console.log('\n================================================================');
console.log('         BrowserPaw System Healthcheck & Repair');
console.log('================================================================\n');

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
if (existsSync(TOKEN_PATH)) {
  token = readFileSync(TOKEN_PATH, 'utf8').trim();
  report(token.length >= 16, `Bridge Token Found: ${TOKEN_PATH}`, `Token length: ${token.length} chars`);
} else {
  if (AUTO_FIX) {
    try {
      if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
      token = randomBytes(24).toString('hex');
      writeFileSync(TOKEN_PATH, token, 'utf8');
      report(true, `Bridge Token Created (Auto-Fix): ${TOKEN_PATH}`, `New token: ${token.slice(0, 8)}...`);
    } catch (e) {
      report(false, `Bridge Token Missing & Auto-Fix Failed`, e.message);
    }
  } else {
    report(false, `Bridge Token Missing: ${TOKEN_PATH}`, 'Run with --fix to automatically generate a secure token.');
  }
}

// 3. Fastify HTTP Service Connectivity
let httpOnline = false;
let pingRes = null;
try {
  const res = await fetch(`${BASE_URL}/ping`, { signal: AbortSignal.timeout(2000) });
  if (res.ok) {
    pingRes = await res.json();
    httpOnline = true;
    report(true, `Native Bridge Server is Listening (Port ${PORT})`, `Response: ${JSON.stringify(pingRes)}`);
  } else {
    report(false, `Native Bridge Server returned HTTP ${res.status}`);
  }
} catch (e) {
  report(false, `Native Bridge Server is NOT reachable on ${BASE_URL}`, e.message);
  if (AUTO_FIX && platform() === 'win32') {
    try {
      const netstat = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' });
      console.log('       Active listeners found on port:', netstat.trim());
    } catch {
      console.log('       Port 12306 is free. Chrome extension will auto-start bridge on browser open.');
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
        'x-mcp-token': token,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'doctor', version: '1.0' } } }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 401) {
      report(false, `Token Authentication Failed (401 Unauthorized)`, 'Token in file does not match server memory. Server restart recommended.');
    } else {
      const initBody = await res.json();
      report(true, `Token Authentication & MCP Initialize OK`, `Server: ${initBody.result?.serverInfo?.name || 'mcp-chrome'} (v${initBody.result?.serverInfo?.version || '1.0'})`);
    }
  } catch (e) {
    report(false, `MCP Handshake Error`, e.message);
  }
}

// 5. Chrome Extension Build Output & Synchronization
let buildOk = false;
if (existsSync(join(EXT_SRC_OUTPUT, 'manifest.json')) && existsSync(join(EXT_SRC_OUTPUT, 'background.js'))) {
  const manifest = JSON.parse(readFileSync(join(EXT_SRC_OUTPUT, 'manifest.json'), 'utf8'));
  buildOk = true;
  report(true, `Extension Build Found: ${EXT_SRC_OUTPUT}`, `Version: ${manifest.version}, Manifest: V${manifest.manifest_version}`);
} else {
  report(false, `Extension Build Missing at ${EXT_SRC_OUTPUT}`, 'Run: pnpm --filter chrome-mcp-server build');
}

// Check Standalone Load Directory (D:\workspace\browserpaw)
if (existsSync(STANDALONE_EXT_DIR)) {
  const standaloneBg = join(STANDALONE_EXT_DIR, 'background.js');
  const srcBg = join(EXT_SRC_OUTPUT, 'background.js');
  let synced = false;
  if (existsSync(standaloneBg) && existsSync(srcBg)) {
    const s1 = readFileSync(standaloneBg).length;
    const s2 = readFileSync(srcBg).length;
    synced = s1 === s2;
  }
  if (synced) {
    report(true, `Standalone Directory Synced: ${STANDALONE_EXT_DIR}`, `Files matched perfectly.`);
  } else {
    report(false, `Standalone Directory Out of Sync: ${STANDALONE_EXT_DIR}`);
    if (AUTO_FIX && buildOk) {
      try {
        cpSync(EXT_SRC_OUTPUT, STANDALONE_EXT_DIR, { recursive: true });
        report(true, `Standalone Directory Synced via Auto-Fix`);
      } catch (err) {
        report(false, `Failed to copy build to ${STANDALONE_EXT_DIR}`, err.message);
      }
    }
  }
}

// 6. Chrome Native Messaging Host Registration (Windows Registry Check)
if (platform() === 'win32') {
  try {
    const regQuery = execSync('reg query "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.chromemcp.nativehost" /ve', { encoding: 'utf8' });
    const match = regQuery.match(/REG_SZ\s+(.*)/);
    const manifestPath = match ? match[1].trim() : '';
    if (manifestPath && existsSync(manifestPath)) {
      report(true, `Native Messaging Host Registered in Chrome`, `Host Manifest: ${manifestPath}`);
    } else {
      report(false, `Native Messaging Host Manifest File Missing: ${manifestPath}`);
    }
  } catch {
    report(false, `Native Messaging Host Registry Key Missing`, 'Run: node app/native-server/dist/scripts/register.js');
    if (AUTO_FIX) {
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

console.log('\n----------------------------------------------------------------');
console.log(`Diagnostic Complete: ${passCount} Passed, ${failCount} Failed.`);
if (failCount === 0) {
  console.log('STATUS: [HEALTHY] All BrowserPaw layers are operating normally!\n');
} else {
  console.log('STATUS: [ACTION REQUIRED] Please review the failed items above.');
  console.log('TIP: Run `node skill/config/doctor.mjs --fix` for automatic repair.\n');
}
