import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The bundled repair wrappers cd into skill/config before invoking doctor, so these cases
// run doctor from that directory inside a sandbox checkout and assert the paths it resolves.
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const doctorSource = path.join(repoRoot, 'skill', 'config', 'doctor.mjs');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-doctor-'));
  write(path.join(root, 'skill/config/doctor.mjs'), fs.readFileSync(doctorSource));
  // The checkout marker doctor climbs to; the build output lives below it.
  write(path.join(root, 'app/chrome-extension/package.json'), '{"name":"chrome-mcp-server"}');
  write(
    path.join(root, 'app/chrome-extension/.output/chrome-mv3/manifest.json'),
    '{"version":"4.0.0"}',
  );
  write(path.join(root, 'app/chrome-extension/.output/chrome-mv3/background.js'), 'build-bg');
  write(
    path.join(root, 'app/chrome-extension/.output/chrome-mv3/popup.html'),
    '<html>build</html>',
  );

  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const preload = path.join(root, 'preload.mjs');
  write(
    preload,
    [
      "import os from 'node:os';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'os.homedir = () => process.env.TEST_TEMP_HOME;',
      "os.platform = () => 'linux';",
      'syncBuiltinESMExports();',
      "globalThis.fetch = async (url) => { throw new Error('offline: ' + url); };",
    ].join('\n'),
  );
  return { root, home, preload };
}

function runDoctor(sandbox, args = [], env = {}) {
  const tokenDir = path.join(sandbox.home, '.chrome-mcp');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'bridge-token'), 'a'.repeat(48));
  return spawnSync(
    process.execPath,
    ['--import', pathToFileURL(sandbox.preload).href, 'doctor.mjs', ...args],
    {
      cwd: path.join(sandbox.root, 'skill/config'),
      env: {
        ...process.env,
        TEST_TEMP_HOME: sandbox.home,
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        BROWSERPAW_STANDALONE_DIRS: '',
        ...env,
      },
      encoding: 'utf8',
      timeout: 15000,
    },
  );
}

describe('doctor.mjs repair behaviour', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  it('resolves the checkout from its own location, not the config working directory', () => {
    const proc = runDoctor(sandbox);
    const output = (proc.stdout || '') + (proc.stderr || '');
    const expected = path.join(sandbox.root, 'app', 'chrome-extension', '.output', 'chrome-mv3');

    assert.ok(output.includes(expected), `doctor should report ${expected}\n${output}`);
    assert.ok(
      !output.includes(path.join('skill', 'config', 'app')),
      'doctor must not resolve the build under config/',
    );
  });

  it('resolves the checkout from a plugin mirror nested four levels deep', () => {
    const mirrorDir = path.join(sandbox.root, 'plugins/browserpaw-claude/skills/browserpaw/config');
    write(path.join(mirrorDir, 'doctor.mjs'), fs.readFileSync(doctorSource));
    const proc = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(sandbox.preload).href, 'doctor.mjs'],
      {
        cwd: mirrorDir,
        env: {
          ...process.env,
          TEST_TEMP_HOME: sandbox.home,
          HOME: sandbox.home,
          USERPROFILE: sandbox.home,
          BROWSERPAW_STANDALONE_DIRS: '',
          BROWSERPAW_REPO_ROOT: '',
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    const output = (proc.stdout || '') + (proc.stderr || '');
    const expected = path.join(sandbox.root, 'app', 'chrome-extension', '.output', 'chrome-mv3');

    assert.ok(output.includes(`Extension Build Found: ${expected}`), output);
    assert.ok(!output.includes(path.join('skills', 'app')), output);
  });

  it('--fix creates a missing standalone directory instead of reporting a ReferenceError', () => {
    const standalone = path.join(sandbox.root, 'load-dir');
    const proc = runDoctor(sandbox, ['--fix'], { BROWSERPAW_STANDALONE_DIRS: standalone });
    const output = (proc.stdout || '') + (proc.stderr || '');

    assert.ok(output.includes('Created and Synced Standalone Directory'), output);
    assert.strictEqual(fs.readFileSync(path.join(standalone, 'background.js'), 'utf8'), 'build-bg');
  });

  it('compares the whole tree: a same-length stale background.js is still out of sync', () => {
    const standalone = path.join(sandbox.root, 'load-dir');
    write(path.join(standalone, 'background.js'), 'stale-bg');
    write(path.join(standalone, 'popup.html'), '<html>build</html>');

    const dry = runDoctor(sandbox, [], { BROWSERPAW_STANDALONE_DIRS: standalone });
    assert.ok(
      ((dry.stdout || '') + (dry.stderr || '')).includes('Standalone Directory Out of Sync'),
      'a same-length but different background.js must not count as synced',
    );

    const fixed = runDoctor(sandbox, ['--fix'], { BROWSERPAW_STANDALONE_DIRS: standalone });
    const output = (fixed.stdout || '') + (fixed.stderr || '');
    assert.ok(output.includes('Synced via Auto-Fix'), output);
    assert.strictEqual(fs.readFileSync(path.join(standalone, 'background.js'), 'utf8'), 'build-bg');
    // Only the offline bridge may fail; a repaired directory must not stay counted.
    assert.match(output, /Diagnostic Complete: \d+ Passed, 1 Failed\./);
  });

  it('probes the bridge port from CHROME_MCP_PORT/MCP_HTTP_PORT, not a hardcoded 12306', () => {
    const fromChromePort = runDoctor(sandbox, [], { CHROME_MCP_PORT: '23456' });
    const chromeOutput = (fromChromePort.stdout || '') + (fromChromePort.stderr || '');
    assert.ok(chromeOutput.includes('127.0.0.1:23456'), chromeOutput);

    const fromMcpPort = runDoctor(sandbox, [], {
      CHROME_MCP_PORT: '',
      MCP_HTTP_PORT: '34567',
    });
    const mcpOutput = (fromMcpPort.stdout || '') + (fromMcpPort.stderr || '');
    assert.ok(mcpOutput.includes('127.0.0.1:34567'), mcpOutput);

    // Invalid values fall back to the documented default instead of a bogus port.
    const invalid = runDoctor(sandbox, [], { CHROME_MCP_PORT: '70000' });
    const invalidOutput = (invalid.stdout || '') + (invalid.stderr || '');
    assert.ok(invalidOutput.includes('127.0.0.1:12306'), invalidOutput);
  });

  it('--fix refuses a symlinked or junctioned standalone directory without touching its target', () => {
    const realTarget = path.join(sandbox.root, 'real-target');
    write(path.join(realTarget, 'user-data.txt'), 'keep-me');
    const standalone = path.join(sandbox.root, 'load-dir');
    fs.symlinkSync(realTarget, standalone, process.platform === 'win32' ? 'junction' : 'dir');

    const proc = runDoctor(sandbox, ['--fix'], { BROWSERPAW_STANDALONE_DIRS: standalone });
    const output = (proc.stdout || '') + (proc.stderr || '');

    assert.match(output, /symlink or junction/, output);
    assert.strictEqual(
      fs.readFileSync(path.join(realTarget, 'user-data.txt'), 'utf8'),
      'keep-me',
      'the link target must not be cleared',
    );
    assert.ok(fs.lstatSync(standalone).isSymbolicLink(), 'the link itself must survive');
  });

  it('--fix removes files that no longer exist in the current build', () => {
    const standalone = path.join(sandbox.root, 'load-dir');
    write(path.join(standalone, 'background.js'), 'build-bg');
    write(path.join(standalone, 'popup.html'), '<html>build</html>');
    write(path.join(standalone, 'removed-chunk.js'), 'old-build-only');

    const proc = runDoctor(sandbox, ['--fix'], { BROWSERPAW_STANDALONE_DIRS: standalone });
    const output = (proc.stdout || '') + (proc.stderr || '');
    assert.ok(output.includes('Standalone Directory Synced via Auto-Fix'), output);
    assert.ok(
      !fs.existsSync(path.join(standalone, 'removed-chunk.js')),
      'a file dropped from the build must not survive a repair',
    );
  });

  it('reports a repaired directory once, leaving no stale failure behind', () => {
    const standalone = path.join(sandbox.root, 'load-dir');
    write(path.join(standalone, 'background.js'), 'stale-bg');
    write(path.join(standalone, 'popup.html'), '<html>old</html>');

    const proc = runDoctor(sandbox, ['--fix'], { BROWSERPAW_STANDALONE_DIRS: standalone });
    const output = (proc.stdout || '') + (proc.stderr || '');

    assert.ok(output.includes('Synced via Auto-Fix'), output);
    assert.ok(
      !output.includes('[FAIL] Standalone Directory'),
      'a repaired directory must not be reported as failed',
    );
  });
});
