import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const batPath = resolve(process.cwd(), 'scripts/decider/start-local-service.bat');
const serveDaemonPath = resolve(process.cwd(), 'scripts/decider/serve_daemon.py');

const FAKE_UVICORN = [
  'import json, os',
  '',
  'def run(app, host=None, port=None, log_level=None):',
  "    with open(os.environ['FAKE_UVICORN_RECORD'], 'w', encoding='utf-8') as f:",
  "        json.dump({'app': app, 'host': host, 'port': port, 'env': dict(os.environ)}, f)",
  '',
].join('\n');

const FAKE_PYTHON_CMD = [
  '@echo off',
  'if not defined DECIDER_DEVICE goto :undefined',
  'echo %DECIDER_DEVICE% > "%DECIDER_DEVICE_DUMP%"',
  'exit /b 0',
  ':undefined',
  'echo UNDEFINED > "%DECIDER_DEVICE_DUMP%"',
  'exit /b 0',
  '',
].join('\r\n');

function resolvePython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  candidates.push(['python3', []], ['python', []]);
  if (process.platform === 'win32') candidates.push(['py', ['-3']]);
  for (const [cmd, prefix] of candidates) {
    const res = spawnSync(cmd, [...prefix, '--version'], { encoding: 'utf8' });
    if (res.status === 0) return { cmd, prefix };
  }
  return null;
}

// Runs serve_daemon.py against a stub `uvicorn` module and returns the environment
// the daemon handed to uvicorn.run(). This exercises the real script, not its text.
function runServeDaemon({ home, device }) {
  const python = resolvePython();
  assert.ok(python, 'a python interpreter is required to exercise scripts/decider/serve_daemon.py');

  const sandbox = mkdtempSync(join(tmpdir(), 'decider-daemon-'));
  const stubDir = join(sandbox, 'stub');
  const recordFile = join(sandbox, 'record.json');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'uvicorn.py'), FAKE_UVICORN, 'utf8');

  const env = { ...process.env, BROWSERPAW_HOME: home, PYTHONPATH: stubDir, FAKE_UVICORN_RECORD: recordFile };
  delete env.DECIDER_DEVICE;
  delete env.DECIDER_MODEL;
  delete env.DECIDER_WARMUP;
  if (device !== undefined) env.DECIDER_DEVICE = device;

  const res = spawnSync(python.cmd, [...python.prefix, serveDaemonPath], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : null;
  rmSync(sandbox, { recursive: true, force: true });
  return { res, record };
}

// Runs start-local-service.bat with a stub `python` on PATH that dumps DECIDER_DEVICE.
function runBat({ home, device }) {
  const sandbox = mkdtempSync(join(tmpdir(), 'decider-bat-'));
  const stubDir = join(sandbox, 'stub');
  const dumpFile = join(sandbox, 'device.txt');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'python.cmd'), FAKE_PYTHON_CMD, 'utf8');

  const env = { ...process.env, BROWSERPAW_HOME: home, PATH: `${stubDir};${process.env.PATH}`, DECIDER_DEVICE_DUMP: dumpFile };
  delete env.DECIDER_DEVICE;
  if (device !== undefined) env.DECIDER_DEVICE = device;

  const res = spawnSync('cmd.exe', ['/c', batPath], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const dumped = existsSync(dumpFile) ? readFileSync(dumpFile, 'utf8').trim() : null;
  rmSync(sandbox, { recursive: true, force: true });
  return { res, dumped, dumpFile };
}

describe('Decider Startup Scripts Contract (JEV-P2-02)', () => {
  const shPath = resolve(process.cwd(), 'scripts/decider/start-local-service.sh');

  it('verifies start-local-service.sh launches uvicorn with decider.serve:app', () => {
    assert.strictEqual(existsSync(shPath), true, 'start-local-service.sh should exist');
    const content = readFileSync(shPath, 'utf8');
    assert.match(content, /uvicorn decider\.serve:app/, 'Should invoke uvicorn decider.serve:app');
    assert.match(content, /--port "\${PORT}"|--port 8009/, 'Should bind to PORT');
    assert.match(content, /export DECIDER_MODEL=/, 'Should export DECIDER_MODEL');
    assert.match(content, /PYTHONPATH.*DECIDER_REPO_DIR/, 'Should setup PYTHONPATH bootstrap');
    assert.doesNotMatch(content, /-m decider\.serve --model/, 'Should not use invalid cli flags');
  });

  it('verifies start-local-service.bat aligns bootstrap environment with native manager', () => {
    assert.strictEqual(existsSync(batPath), true, 'start-local-service.bat should exist');
    const content = readFileSync(batPath, 'utf8');
    assert.match(content, /uvicorn decider\.serve:app/, 'Should invoke uvicorn decider.serve:app');
    assert.match(content, /PYTHONPATH=%DECIDER_REPO_DIR%/, 'Should configure PYTHONPATH for decider-repo');
  });
});

describe('Decider startup device & home resolution (B-06)', () => {
  it('serve_daemon.py preserves a user-provided DECIDER_DEVICE and only defaults to auto when unset', () => {
    const home = mkdtempSync(join(tmpdir(), 'decider-home-'));
    try {
      const preset = runServeDaemon({ home, device: 'cpu' });
      assert.strictEqual(preset.res.status, 0, `serve_daemon.py failed: ${preset.res.stderr}`);
      assert.ok(preset.record, 'uvicorn.run() should have been reached');
      assert.strictEqual(preset.record.env.DECIDER_DEVICE, 'cpu', 'user-provided device must be preserved');

      const unset = runServeDaemon({ home, device: undefined });
      assert.strictEqual(unset.res.status, 0, `serve_daemon.py failed: ${unset.res.stderr}`);
      assert.ok(unset.record, 'uvicorn.run() should have been reached');
      assert.strictEqual(unset.record.env.DECIDER_DEVICE, 'auto', 'unset device must default to auto');
      assert.strictEqual(unset.record.env.DECIDER_WARMUP, '0');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('serve_daemon.py resolves model and log paths from BROWSERPAW_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'decider-home-'));
    try {
      const { res, record } = runServeDaemon({ home, device: undefined });
      assert.strictEqual(res.status, 0, `serve_daemon.py failed: ${res.stderr}`);
      assert.ok(record, 'uvicorn.run() should have been reached');
      assert.strictEqual(record.env.DECIDER_MODEL, join(home, 'models', 'decider-2b'));
      assert.strictEqual(existsSync(join(home, 'decider-service.log')), true, 'log must live under BROWSERPAW_HOME');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('start-local-service.bat preserves a user-provided DECIDER_DEVICE and defaults to auto when unset', () => {
    const home = mkdtempSync(join(tmpdir(), 'decider-bat-home-'));
    try {
      mkdirSync(join(home, 'models', 'decider-2b'), { recursive: true });
      writeFileSync(join(home, 'models', 'decider-2b', 'model.safetensors'), 'stub', 'utf8');

      if (process.platform !== 'win32') {
        // cmd.exe cannot run on this platform, so the .bat can only be checked structurally here.
        // The behavioural assertion below runs on the Windows CI leg.
        const content = readFileSync(batPath, 'utf8');
        assert.match(content, /if not defined DECIDER_DEVICE/, 'bat must guard on an unset DECIDER_DEVICE');
        assert.match(content, /set "DECIDER_DEVICE=auto"/, 'bat must default to auto');
        assert.doesNotMatch(content, /set "DECIDER_DEVICE=cuda"/, 'bat must not force cuda');
        return;
      }

      const preset = runBat({ home, device: 'cpu' });
      assert.strictEqual(preset.dumped, 'cpu', `expected cpu, got ${preset.dumped}: ${preset.res.stdout}${preset.res.stderr}`);

      const unset = runBat({ home, device: undefined });
      assert.strictEqual(unset.dumped, 'auto', `expected auto, got ${unset.dumped}: ${unset.res.stdout}${unset.res.stderr}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
