import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const syncScriptPath = path.join(repoRoot, 'scripts', 'sync-extension-dist.mjs');

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-extsync-'));
  const src = path.join(root, 'app', 'chrome-extension', '.output', 'chrome-mv3');
  fs.mkdirSync(path.join(src, 'chunks'), { recursive: true });
  fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), '{"name":"test"}');
  fs.writeFileSync(path.join(src, 'chunks', 'bundle.js'), 'console.log("chunk");');
  fs.writeFileSync(path.join(src, 'assets', 'icon.png'), 'fake-png');

  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(syncScriptPath, path.join(root, 'scripts', 'sync-extension-dist.mjs'));
  return { root, src };
}

const runScript = (sandboxRoot, env = {}, cwd = sandboxRoot) =>
  spawnSync(process.execPath, [path.join(sandboxRoot, 'scripts', 'sync-extension-dist.mjs')], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });

// 1. Default behavior: when env is unset, default must NEVER sync externally
{
  const { root } = createSandbox();
  const externalProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-target-'));
  try {
    const res = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: '' });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(
      res.stdout.includes('Skipped') || res.stdout.includes('not set'),
      'Output must confirm sync was skipped when env is unset',
    );
    assert.strictEqual(fs.readdirSync(externalProbe).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalProbe, { recursive: true, force: true });
  }
}

// 2. Foreign cwd: executing from an outside cwd resolves SRC via repoRoot without breakage
{
  const { root } = createSandbox();
  const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-outside-cwd-'));
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-target-cwd-'));
  try {
    const res = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: targetDir }, outsideCwd);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(targetDir, 'manifest.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideCwd, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

// 3. Boundary validations: reject repo root, SRC itself, and SRC descendant (prevent self-copy loop)
{
  const { root, src } = createSandbox();
  try {
    // 3a. Target is repo root
    const resRoot = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: root });
    assert.notStrictEqual(resRoot.status, 0, 'Must reject repo root');

    // 3b. Target is SRC itself
    const resSrc = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: src });
    assert.notStrictEqual(resSrc.status, 0, 'Must reject source directory');

    // 3c. Target is a descendant inside SRC
    const insideSrc = path.join(src, 'nested-dist');
    const resDesc = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: insideSrc });
    assert.notStrictEqual(resDesc.status, 0, 'Must reject descendant inside source');

    // 3d. Target is an ancestor/parent of repo root (tested inside temp sandbox)
    const parentDir = path.dirname(root);
    const resParent = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: parentDir });
    assert.notStrictEqual(resParent.status, 0, 'Must reject ancestor of repo root');

// 3e. Target is user home directory
    const resHome = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: os.homedir() });
    assert.notStrictEqual(resHome.status, 0, 'Must reject user home directory');

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 4. Junction / symlink alias boundary defense (reject aliasing repo or source)
{
  const { root, src } = createSandbox();
  const linkContainer = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-link-box-'));
  const junctionToRepo = path.join(linkContainer, 'j-repo');
  const junctionToSrc = path.join(linkContainer, 'j-src');
  try {
    fs.symlinkSync(root, junctionToRepo, 'junction');
    fs.symlinkSync(src, junctionToSrc, 'junction');

    const resJRepo = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: junctionToRepo });
    assert.notStrictEqual(resJRepo.status, 0, 'Must reject junction pointing to repo root');

    const resJSrc = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: junctionToSrc });
    assert.notStrictEqual(resJSrc.status, 0, 'Must reject junction pointing to source');
  } finally {
    try {
      fs.unlinkSync(junctionToRepo);
    } catch {}
    try {
      fs.unlinkSync(junctionToSrc);
    } catch {}
    fs.rmSync(linkContainer, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 5. Valid opt-in sync: clean copy and clean file replacement
{
  const { root } = createSandbox();
  const validTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-valid-sync-'));
  try {
    const res = runScript(root, { BROWSERPAW_EXTENSION_SYNC_DIR: validTarget });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(validTarget, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(validTarget, 'chunks', 'bundle.js')));
    assert.ok(fs.existsSync(path.join(validTarget, 'assets', 'icon.png')));
    assert.strictEqual(
      fs.readFileSync(path.join(validTarget, 'manifest.json'), 'utf-8'),
      '{"name":"test"}',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(validTarget, { recursive: true, force: true });
  }
}

console.log('INFRA-07 enhanced sync-extension-dist verification passed.');
