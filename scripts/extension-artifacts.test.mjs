import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { sourceFingerprint } from './verify.mjs';

import {
  createBuildInfo,
  writeBuildProvenance,
  checkBuild,
  resolveSyncTarget,
  deploy,
  checkDeployment,
  calculateExtensionSourceFingerprint,
  REQUIRED_STEP_NAMES,
} from './extension-artifacts.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptPath = path.join(repoRoot, 'scripts', 'extension-artifacts.mjs');

function createFixtureSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-artifacts-test-'));
  const extSrc = path.join(root, 'app', 'chrome-extension');
  const sharedSrc = path.join(root, 'packages', 'shared', 'src');
  const outDir = path.join(extSrc, '.output', 'chrome-mv3');
  const scriptsDir = path.join(root, 'scripts');

  fs.mkdirSync(path.join(extSrc, 'entrypoints'), { recursive: true });
  fs.mkdirSync(sharedSrc, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'chunks'), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  fs.writeFileSync(path.join(extSrc, 'entrypoints', 'main.ts'), 'console.log("hello");');
  fs.writeFileSync(path.join(sharedSrc, 'types.ts'), 'export type Foo = string;');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', version: '1.0.0' }),
  );
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfile: true');
  fs.writeFileSync(path.join(scriptsDir, 'extension-artifacts.mjs'), '// script');

  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'browserpaw',
      version: '1.0.0',
      background: { service_worker: 'chunks/main.js' },
    }),
  );
  fs.writeFileSync(path.join(outDir, 'chunks', 'main.js'), 'console.log("built");');

  return { root, extSrc, outDir };
}

function createPassingVerificationReport(root, fingerprint = 'mock-fp') {
  const repDir = path.join(root, '.artifacts', 'verification');
  fs.mkdirSync(repDir, { recursive: true });
  const report = {
    status: 'passed',
    sourceFingerprint: fingerprint,
    steps: REQUIRED_STEP_NAMES.map((name) => ({
      name,
      status: 'passed',
      durationMs: 10,
    })),
  };
  fs.writeFileSync(path.join(repDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf-8');
}

// 1. Source fingerprint calculation covers extension, shared, root manifest/lock, and scripts
{
  const { root, extSrc } = createFixtureSandbox();
  try {
    const fp1 = calculateExtensionSourceFingerprint(root);
    assert.ok(fp1.sourceInputs['app/chrome-extension/entrypoints/main.ts']);
    assert.ok(fp1.sourceInputs['packages/shared/src/types.ts']);
    assert.ok(fp1.sourceInputs['package.json']);
    assert.ok(fp1.sourceInputs['pnpm-lock.yaml']);
    assert.ok(fp1.sourceInputs['scripts/extension-artifacts.mjs']);

    const info1 = createBuildInfo({ repoRoot: root });
    assert.strictEqual(info1.sourceHash, fp1.sourceHash);

    // Modifying shared source must alter sourceHash
    fs.writeFileSync(
      path.join(root, 'packages', 'shared', 'src', 'types.ts'),
      'export type Bar = number;',
    );
    const fp2 = calculateExtensionSourceFingerprint(root);
    assert.notStrictEqual(fp1.sourceHash, fp2.sourceHash);

    // Modifying extension source must alter sourceHash
    fs.writeFileSync(path.join(extSrc, 'entrypoints', 'main.ts'), 'console.log("changed");');
    const fp3 = calculateExtensionSourceFingerprint(root);
    assert.notStrictEqual(fp2.sourceHash, fp3.sourceHash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 2. Provenance write and checkBuild strict validations
{
  const { root, outDir } = createFixtureSandbox();
  try {
    const buildInfo = createBuildInfo({ repoRoot: root });
    const provenance = writeBuildProvenance(outDir, buildInfo);
    assert.ok(provenance.artifacts['manifest.json']);
    assert.ok(provenance.artifacts['chunks/main.js']);

    const checkRes = checkBuild({ repoRoot: root, outDir });
    assert.strictEqual(checkRes.valid, true);

    fs.writeFileSync(path.join(outDir, 'AGENTS.md'), '# Engineering instructions');
    writeBuildProvenance(outDir, buildInfo);
    assert.throws(
      () => checkBuild({ repoRoot: root, outDir }),
      /Development document must not be packaged/,
    );
    fs.rmSync(path.join(outDir, 'AGENTS.md'));
    fs.writeFileSync(path.join(outDir, 'browserpaw-build.json'), JSON.stringify(provenance));

    // Empty artifacts rejection
    const emptyProv = { ...provenance, artifacts: {} };
    fs.writeFileSync(path.join(outDir, 'browserpaw-build.json'), JSON.stringify(emptyProv));
    assert.throws(() => checkBuild({ repoRoot: root, outDir }), /cannot be empty/);

    // Missing manifest.json in artifacts dictionary
    const noManifestProv = {
      ...provenance,
      artifacts: { 'chunks/main.js': provenance.artifacts['chunks/main.js'] },
    };
    fs.writeFileSync(path.join(outDir, 'browserpaw-build.json'), JSON.stringify(noManifestProv));
    assert.throws(() => checkBuild({ repoRoot: root, outDir }), /manifest.json must be present/);

    // Missing referenced service worker on disk
    fs.writeFileSync(path.join(outDir, 'browserpaw-build.json'), JSON.stringify(provenance));
    fs.rmSync(path.join(outDir, 'chunks', 'main.js'), { force: true });
    assert.throws(
      () => checkBuild({ repoRoot: root, outDir }),
      /Service worker file referenced in manifest does not exist/,
    );

    // Restore chunks/main.js then add untracked file on disk
    fs.writeFileSync(path.join(outDir, 'chunks', 'main.js'), 'console.log("built");');
    fs.writeFileSync(path.join(outDir, 'untracked.js'), 'rogue');
    assert.throws(
      () => checkBuild({ repoRoot: root, outDir }),
      /Untracked extraneous artifact found on disk/,
    );
    fs.rmSync(path.join(outDir, 'untracked.js'), { force: true });

    // Path traversal in artifacts list
    const traversalProv = {
      ...provenance,
      artifacts: { ...provenance.artifacts, '../escape.js': 'hash' },
    };
    fs.writeFileSync(path.join(outDir, 'browserpaw-build.json'), JSON.stringify(traversalProv));
    assert.throws(
      () => checkBuild({ repoRoot: root, outDir }),
      /Invalid artifact path in provenance/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 3. Stale workspace inputs detection
{
  const { root, outDir } = createFixtureSandbox();
  try {
    const buildInfo = createBuildInfo({ repoRoot: root });
    writeBuildProvenance(outDir, buildInfo);

    fs.writeFileSync(
      path.join(root, 'app', 'chrome-extension', 'entrypoints', 'main.ts'),
      'console.log("drift");',
    );
    assert.throws(() => checkBuild({ repoRoot: root, outDir }), /Source fingerprint mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 4. resolveSyncTarget: env, relative config resolution, and config parse errors
{
  const { root } = createFixtureSandbox();
  try {
    const prevEnv = process.env.BROWSERPAW_EXTENSION_SYNC_DIR;
    delete process.env.BROWSERPAW_EXTENSION_SYNC_DIR;

    assert.strictEqual(resolveSyncTarget({ repoRoot: root }), null);

    // Invalid JSON error must NOT be swallowed
    fs.writeFileSync(path.join(root, 'browserpaw.local.json'), '{ malformed json');
    assert.throws(() => resolveSyncTarget({ repoRoot: root }), /invalid JSON/);

    // Relative path must resolve relative to repo root
    fs.writeFileSync(
      path.join(root, 'browserpaw.local.json'),
      JSON.stringify({ extensionSyncDir: 'dist/local-target' }),
    );
    assert.strictEqual(
      resolveSyncTarget({ repoRoot: root }),
      path.resolve(root, 'dist/local-target'),
    );

    // Env overrides config
    const envTarget = path.resolve(root, 'env', 'custom');
    process.env.BROWSERPAW_EXTENSION_SYNC_DIR = envTarget;
    assert.strictEqual(resolveSyncTarget({ repoRoot: root }), envTarget);

    if (prevEnv) process.env.BROWSERPAW_EXTENSION_SYNC_DIR = prevEnv;
    else delete process.env.BROWSERPAW_EXTENSION_SYNC_DIR;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 5. Deploy & CheckDeployment with verification gate evidence checks and negative counterexamples
{
  const { root, outDir } = createFixtureSandbox();
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-deploy-target-'));
  try {
    const buildInfo = createBuildInfo({ repoRoot: root });
    writeBuildProvenance(outDir, buildInfo);

    // Negative: target tree with symlink must be rejected during deploy
    const symlinkChild = path.join(targetDir, 'unsafe-link');
    try {
      fs.symlinkSync(root, symlinkChild, 'junction');
      assert.throws(() => deploy({ repoRoot: root, outDir, targetDir }), /Security violation/);
    } finally {
      try {
        fs.unlinkSync(symlinkChild);
      } catch {}
    }

    // Successful deploy
    const deployRes = deploy({ repoRoot: root, outDir, targetDir });
    assert.strictEqual(deployRes.success, true);
    assert.strictEqual(deployRes.buildId, buildInfo.buildId);

    const retiredMetadataPath = path.join(targetDir, 'browserpaw-build.json');
    const retiredMetadata = JSON.parse(fs.readFileSync(retiredMetadataPath, 'utf-8'));
    retiredMetadata.artifacts['retired.md'] = 'previous-build-owned-file';
    fs.writeFileSync(path.join(targetDir, 'retired.md'), '# Retired build document');
    fs.writeFileSync(retiredMetadataPath, JSON.stringify(retiredMetadata));
    deploy({ repoRoot: root, outDir, targetDir });
    assert.ok(!fs.existsSync(path.join(targetDir, 'retired.md')));

    // Negative: target browserpaw-build.json altered
    const targetProvPath = path.join(targetDir, 'browserpaw-build.json');
    const originalProvContent = fs.readFileSync(targetProvPath, 'utf-8');
    fs.writeFileSync(
      targetProvPath,
      JSON.stringify({ ...JSON.parse(originalProvContent), buildId: 'hacked' }),
    );
    assert.throws(
      () => checkDeployment({ repoRoot: root, outDir, targetDir }),
      /browserpaw-build.json does not match source verbatim/,
    );
    fs.writeFileSync(targetProvPath, originalProvContent, 'utf-8');

    // Negative: missing verification report (.artifacts/verification/latest.json)
    assert.throws(
      () => checkDeployment({ repoRoot: root, outDir, targetDir }),
      /Verification report missing/,
    );

    // Negative: verification report status failed
    createPassingVerificationReport(root, 'mock-fp');
    const repPath = path.join(root, '.artifacts', 'verification', 'latest.json');
    fs.writeFileSync(repPath, JSON.stringify({ status: 'failed', steps: [] }));
    assert.throws(
      () => checkDeployment({ repoRoot: root, outDir, targetDir }),
      /Verification gate failed: status is "failed"/,
    );

    // Negative: verification report missing required steps
    fs.writeFileSync(
      repPath,
      JSON.stringify({ status: 'passed', steps: [{ name: 'lint', status: 'passed' }] }),
    );
    assert.throws(
      () => checkDeployment({ repoRoot: root, outDir, targetDir }),
      /Verification report missing required passed step/,
    );
    createPassingVerificationReport(root, sourceFingerprint(root));
    assert.strictEqual(checkDeployment({ repoRoot: root, outDir, targetDir }).valid, true);

    const unownedFile = path.join(targetDir, 'unowned.md');
    fs.writeFileSync(unownedFile, '# Unowned document');
    assert.throws(
      () => checkDeployment({ repoRoot: root, outDir, targetDir }),
      /file set does not match/,
    );
    assert.ok(fs.existsSync(unownedFile), 'Unknown files are rejected without deletion');
    fs.rmSync(unownedFile);

    const validReport = JSON.parse(fs.readFileSync(repPath, 'utf-8'));
    fs.writeFileSync(
      repPath,
      JSON.stringify({ ...validReport, steps: [...validReport.steps, validReport.steps[0]] }),
    );
    assert.throws(
      () => checkDeployment({ repoRoot: root, outDir, targetDir }),
      /exactly the complete passed step set/,
    );

    fs.writeFileSync(repPath, JSON.stringify(validReport));
    fs.writeFileSync(path.join(root, 'new-source.mjs'), 'export const changed = true;');
    assert.throws(
      () => checkDeployment({ repoRoot: root, outDir, targetDir }),
      /sourceFingerprint mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

// 6. CLI strict argument validation: reject extra arguments
{
  const resExtra = spawnSync(process.execPath, [scriptPath, '--deploy', 'extra-arg'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  assert.strictEqual(resExtra.status, 1, 'CLI must reject extra argument');

  const resUnknown = spawnSync(process.execPath, [scriptPath, '--unknown'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  assert.strictEqual(resUnknown.status, 1, 'CLI must reject unknown argument');
}

console.log('All enhanced extension-artifacts.test.mjs checks passed.');
