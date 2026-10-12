import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';

export function scanContentForCredentials(content) {
  const lines = content.split(/\r?\n/);
  const violations = [];

  // Pattern 1: Direct Bearer literal with 32-64 hex chars
  const bearerPattern = /Bearer\s+([0-9a-fA-F]{32,64})/i;

  // Pattern 2: Assignment to variable named TOKEN/AUTH/SECRET/API_KEY/CREDENTIAL with 32-64 hex chars
  const assignPattern =
    /(?:const|let|var|readonly)\s+[A-Za-z0-9_]*(?:TOKEN|AUTH|SECRET|API_?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*['"]([0-9a-fA-F]{32,64})['"]/i;

  // Pattern 3: Object property token/auth/secret/apiKey with 32-64 hex chars
  const propPattern =
    /['"]?(?:token|secret|apiKey|api_key|bridge_token)['"]?\s*:\s*['"]([0-9a-fA-F]{32,64})['"]/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip purely commented lines
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }
    if (bearerPattern.test(line) || assignPattern.test(line) || propPattern.test(line)) {
      violations.push({ line: i + 1 });
    }
  }
  return violations;
}

describe('Standalone doctor.mjs offline credential behavior', () => {
  let tempHome;
  let tokenDir;
  let tokenPath;
  let preloadUrl;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-doc-cred-test-'));
    tokenDir = path.join(tempHome, '.chrome-mcp');
    tokenPath = path.join(tokenDir, 'bridge-token');

    // Create temporary preload script within tempHome to isolate doctor offline
    const preloadPath = path.join(tempHome, 'preload.mjs');
    const preloadCode = `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

os.homedir = () => process.env.TEST_TEMP_HOME;
os.platform = () => 'linux';
syncBuiltinESMExports();

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes(':12306/ping')) {
    return new Response(JSON.stringify({ status: 'ok', message: 'pong' }), { status: 200 });
  }
  if (u.includes(':12306/mcp')) {
    return new Response(JSON.stringify({ result: { serverInfo: { name: 'mock', version: '1.0' } } }), { status: 200 });
  }
  if (u.includes(':8009/ping')) {
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
};
`;
    fs.writeFileSync(preloadPath, preloadCode, 'utf8');
    preloadUrl = pathToFileURL(preloadPath).href;
  });

  afterEach(() => {
    try {
      if (tempHome && fs.existsSync(tempHome)) {
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    } catch {}
  });

  function runDoctor(args = []) {
    const env = {
      ...process.env,
      TEST_TEMP_HOME: tempHome,
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: tempHome,
      LOCALAPPDATA: tempHome,
      BROWSERPAW_STANDALONE_DIRS: '',
    };
    delete env.CHROME_MCP_TOKEN;
    delete env.BROWSERPAW_MCP_TOKEN;
    delete env.CHROME_MCP_TOKEN_DIR;

    return spawnSync(
      process.execPath,
      ['--import', preloadUrl, 'skill/config/doctor.mjs', ...args],
      {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
  }

  it('missing token: --fix does not generate or rewrite token and never leaks credentials', () => {
    assert.strictEqual(fs.existsSync(tokenPath), false);

    const proc = runDoctor(['--fix']);
    const output = (proc.stdout || '') + (proc.stderr || '');

    // Behavioral assertion: file must still not exist
    assert.strictEqual(fs.existsSync(tokenPath), false);
    assert.ok(output.includes('Bridge Credential Unavailable'));
    assert.ok(output.includes('ENOENT'));

    // Security assertion: no 48 or 64 hex token generated or printed
    assert.strictEqual(/[0-9a-fA-F]{48,64}/.test(output), false);
  });

  it('corrupt token: --fix refuses to overwrite or delete corrupt token and never prints content', () => {
    fs.mkdirSync(tokenDir, { recursive: true });
    const corruptContent = 'corrupt-malformed-token-xyz';
    fs.writeFileSync(tokenPath, corruptContent, 'utf8');

    const proc = runDoctor(['--fix']);
    const output = (proc.stdout || '') + (proc.stderr || '');

    // Behavioral assertion: file content preserved untouched
    assert.strictEqual(fs.readFileSync(tokenPath, 'utf8'), corruptContent);
    assert.ok(output.includes('Invalid format'));
    assert.ok(output.includes('doctor never rewrites it'));

    // Security assertion: corrupt token content must never be leaked
    assert.strictEqual(output.includes(corruptContent), false);
  });

  it('valid 48-hex token: recognized as valid without leaking token value', () => {
    fs.mkdirSync(tokenDir, { recursive: true });
    const valid48 = 'a'.repeat(48);
    fs.writeFileSync(tokenPath, valid48, 'utf8');

    const proc = runDoctor([]);
    const output = (proc.stdout || '') + (proc.stderr || '');

    assert.ok(output.includes('Readable and valid'));
    assert.strictEqual(output.includes(valid48), false);
  });

  it('valid 64-hex token: recognized as valid without leaking token value', () => {
    fs.mkdirSync(tokenDir, { recursive: true });
    const valid64 = 'b'.repeat(64);
    fs.writeFileSync(tokenPath, valid64, 'utf8');

    const proc = runDoctor([]);
    const output = (proc.stdout || '') + (proc.stderr || '');

    assert.ok(output.includes('Readable and valid'));
    assert.strictEqual(output.includes(valid64), false);
  });
});

describe('Static regression scan for hardcoded high-entropy credentials', () => {
  it('scanner detects previous bug patterns in fixture text (const TOKEN followed by Bearer)', () => {
    const syntheticToken = 'a'.repeat(64);
    const fixture1 = [
      '// benchmark sample',
      `const TOKEN = '${syntheticToken}';`,
      'headers["Authorization"] = `Bearer ${TOKEN}`;',
    ].join('\n');

    const violations1 = scanContentForCredentials(fixture1);
    assert.strictEqual(violations1.length, 1);
    assert.strictEqual(violations1[0].line, 2);

    const fixture2 = [
      "export const API_SECRET = '0123456789abcdef0123456789abcdef';",
      'fetch(url, { headers: { "x-secret": API_SECRET } });',
    ].join('\n');

    const violations2 = scanContentForCredentials(fixture2);
    assert.strictEqual(violations2.length, 1);
    assert.strictEqual(violations2[0].line, 1);

    // Negative assertions: non-credential hashes and placeholders are not flagged
    const benignFixture = [
      `const gitCommitSha = '${syntheticToken}';`,
      "const buildHash = 'abcdef0123456789abcdef0123456789';",
      'headers["Authorization"] = "Bearer <TOKEN_PLACEHOLDER>";',
    ].join('\n');

    const benignViolations = scanContentForCredentials(benignFixture);
    assert.strictEqual(benignViolations.length, 0);
  });

  it('source files and benchmark do not contain hardcoded high-entropy credentials', () => {
    const rawFiles = execSync('git ls-files', { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

    const targetFiles = rawFiles.filter((f) => {
      // Exclude test suites, test fixtures, dist, and output
      if (
        f.includes('test') ||
        f.includes('node_modules') ||
        f.includes('.output') ||
        f.includes('dist/')
      ) {
        return false;
      }
      return /\.(ts|js|mjs|cjs|json|py)$/.test(f);
    });

    const fileViolations = [];
    for (const file of targetFiles) {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const v = scanContentForCredentials(content);
      for (const item of v) {
        // Only report filepath:line, never leak credential
        fileViolations.push(`${file}:${item.line}`);
      }
    }

    assert.strictEqual(
      fileViolations.length,
      0,
      `Found hardcoded credentials in source files (reporting paths only): ${fileViolations.join(', ')}`,
    );
  });
});
