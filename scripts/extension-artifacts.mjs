import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { resolve, join, relative, dirname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import process from 'node:process';
import os from 'node:os';
import console from 'node:console';

import { REQUIRED_STEP_NAMES, sourceFingerprint } from './verify.mjs';
export { REQUIRED_STEP_NAMES };

export const repoRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
export const defaultOutDir = resolve(repoRoot, 'app/chrome-extension/.output/chrome-mv3');
export const defaultSrcDir = resolve(repoRoot, 'app/chrome-extension');

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

export function scanDirectoryFiles(dir, excludeDirs = new Set(), baseDir = dir) {
  const result = [];
  if (!existsSync(dir)) return result;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) {
        result.push(...scanDirectoryFiles(fullPath, excludeDirs, baseDir));
      }
    } else if (entry.isFile()) {
      const relPath = relative(baseDir, fullPath).split(sep).join('/');
      result.push({ fullPath, relPath });
    }
  }
  return result;
}

export function calculateExtensionSourceFingerprint(root = repoRoot) {
  const extensionDir = resolve(root, 'app/chrome-extension');
  const sharedDir = resolve(root, 'packages/shared/src');
  const scriptFile = resolve(root, 'scripts/extension-artifacts.mjs');

  const excludes = new Set(['node_modules', '.output', '.wxt', 'dist', '.git', 'tests']);
  const files = [];

  if (existsSync(extensionDir)) {
    files.push(...scanDirectoryFiles(extensionDir, excludes, root));
  }
  if (existsSync(sharedDir)) {
    files.push(...scanDirectoryFiles(sharedDir, new Set(['node_modules']), root));
  }
  if (existsSync(scriptFile)) {
    files.push({ fullPath: scriptFile, relPath: 'scripts/extension-artifacts.mjs' });
  }

  for (const rootFile of ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml']) {
    const full = resolve(root, rootFile);
    if (existsSync(full)) {
      files.push({ fullPath: full, relPath: rootFile });
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const sourceInputs = {};
  const hashLines = [];

  for (const file of files) {
    if (/\.md$/i.test(file.relPath)) continue;
    const hash = sha256File(file.fullPath);
    sourceInputs[file.relPath] = hash;
    hashLines.push(`${file.relPath}:${hash}`);
  }

  const sourceHash = sha256Buffer(Buffer.from(hashLines.join('\n'), 'utf-8'));
  return { sourceHash, sourceInputs };
}

export function createBuildInfo(options = {}) {
  const root = options.repoRoot || repoRoot;
  const { sourceHash, sourceInputs } = calculateExtensionSourceFingerprint(root);
  const buildId = `paw-${Date.now().toString(36)}-${sourceHash.slice(0, 8)}`;

  return {
    buildId,
    buildTime: new Date().toISOString(),
    sourceHash,
    sourceInputs,
  };
}

export function writeBuildProvenance(outDir = defaultOutDir, buildInfo) {
  if (!existsSync(outDir)) {
    throw new Error(`Build output directory does not exist: ${outDir}`);
  }

  assertNoSymlinksInTree(outDir);

  const files = scanDirectoryFiles(outDir).filter((f) => f.relPath !== 'browserpaw-build.json');
  const artifacts = {};
  for (const file of files) {
    artifacts[file.relPath] = sha256File(file.fullPath);
  }

  const provenance = {
    buildId: buildInfo.buildId,
    buildTime: buildInfo.buildTime || new Date().toISOString(),
    sourceHash: buildInfo.sourceHash,
    sourceInputs: buildInfo.sourceInputs,
    artifacts,
  };

  const provenancePath = join(outDir, 'browserpaw-build.json');
  writeFileSync(provenancePath, JSON.stringify(provenance, null, 2), 'utf-8');
  return provenance;
}

export function checkBuild(options = {}) {
  const root = options.repoRoot || repoRoot;
  const outDir = options.outDir || defaultOutDir;

  if (!existsSync(outDir)) {
    throw new Error(`Build output directory does not exist: ${outDir}`);
  }
  assertNoSymlinksInTree(outDir);

  const manifestPath = join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json missing in build output: ${outDir}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    throw new Error(`manifest.json is invalid JSON: ${e.message}`);
  }

  if (manifest.manifest_version !== 3) {
    throw new Error(
      `manifest.json must be MV3, got manifest_version: ${manifest.manifest_version}`,
    );
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error('manifest.json must contain a valid string version');
  }
  const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
  if (manifest.version !== packageVersion) {
    throw new Error(
      `Extension manifest version ${manifest.version} does not match package version ${packageVersion}`,
    );
  }

  // Validate referenced files in manifest exist on disk
  if (manifest.background?.service_worker) {
    const swPath = join(outDir, manifest.background.service_worker);
    if (!existsSync(swPath)) {
      throw new Error(
        `Service worker file referenced in manifest does not exist: ${manifest.background.service_worker}`,
      );
    }
  }
  if (manifest.action?.default_popup) {
    const popupPath = join(outDir, manifest.action.default_popup);
    if (!existsSync(popupPath)) {
      throw new Error(
        `Default popup file referenced in manifest does not exist: ${manifest.action.default_popup}`,
      );
    }
  }
  const references = [
    ...Object.values(manifest.icons || {}),
    ...(typeof manifest.action?.default_icon === 'string'
      ? [manifest.action.default_icon]
      : Object.values(manifest.action?.default_icon || {})),
    ...(manifest.content_scripts || []).flatMap((script) => [
      ...(script.js || []),
      ...(script.css || []),
    ]),
  ];
  for (const file of references) {
    if (
      typeof file !== 'string' ||
      isAbsolute(file) ||
      file.split(/[\\/]/).includes('..') ||
      !existsSync(join(outDir, file))
    ) {
      throw new Error(`Invalid or missing manifest reference: ${file}`);
    }
  }

  const provenancePath = join(outDir, 'browserpaw-build.json');
  if (!existsSync(provenancePath)) {
    throw new Error(`browserpaw-build.json missing in build output: ${outDir}`);
  }

  let provenance;
  try {
    provenance = JSON.parse(readFileSync(provenancePath, 'utf-8'));
  } catch (e) {
    throw new Error(`browserpaw-build.json is invalid JSON: ${e.message}`);
  }

  if (!provenance.buildId || !provenance.sourceHash || !provenance.artifacts) {
    throw new Error(
      'browserpaw-build.json is missing required fields (buildId, sourceHash, artifacts)',
    );
  }

  const artifactKeys = Object.keys(provenance.artifacts);
  if (artifactKeys.length === 0) {
    throw new Error('Build artifacts dictionary cannot be empty');
  }

  if (!provenance.artifacts['manifest.json']) {
    throw new Error('manifest.json must be present in build artifacts dictionary');
  }

  // Exact file set check: disk files (excluding provenance itself) must match artifacts list precisely
  const actualFiles = scanDirectoryFiles(outDir).filter(
    (f) => f.relPath !== 'browserpaw-build.json',
  );
  const actualFileSet = new Set(actualFiles.map((f) => f.relPath));
  const expectedFileSet = new Set(artifactKeys);

  for (const rel of artifactKeys) {
    if (/\.md$/i.test(rel)) {
      throw new Error(`Development document must not be packaged: ${rel}`);
    }
    if (isAbsolute(rel) || rel.startsWith('/') || rel.startsWith('\\') || rel.includes('..')) {
      throw new Error(`Invalid artifact path in provenance: ${rel}`);
    }
    if (!actualFileSet.has(rel)) {
      throw new Error(`Artifact listed in provenance is missing on disk: ${rel}`);
    }
    const fullPath = join(outDir, rel);
    const actualHash = sha256File(fullPath);
    if (actualHash !== provenance.artifacts[rel]) {
      throw new Error(
        `Artifact hash mismatch for ${rel}: expected ${provenance.artifacts[rel]}, got ${actualHash}`,
      );
    }
  }

  for (const actualRel of actualFileSet) {
    if (!expectedFileSet.has(actualRel)) {
      throw new Error(`Untracked extraneous artifact found on disk: ${actualRel}`);
    }
  }

  // Verify source fingerprint has not drifted since build
  const { sourceHash } = calculateExtensionSourceFingerprint(root);
  if (sourceHash !== provenance.sourceHash) {
    throw new Error(
      `Source fingerprint mismatch: extension build inputs have changed since build (${sourceHash} !== ${provenance.sourceHash})`,
    );
  }

  return { valid: true, provenance };
}

export function assertNoSymlink(p) {
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

export function assertNoSymlinksInTree(dir) {
  if (!existsSync(dir)) return;
  assertNoSymlink(dir);
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    assertNoSymlink(fullPath);
    if (entry.isDirectory()) {
      assertNoSymlinksInTree(fullPath);
    }
  }
}

export function resolveRealSafe(p) {
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

export function validateSyncTargetBoundaries(target, root = repoRoot, src = defaultOutDir) {
  assertNoSymlink(target);
  const realRepo = realpathSync(root);
  const realSrc = existsSync(src) ? realpathSync(src) : src;
  const realTarget = resolveRealSafe(target);

  const relFromSrcToTarget = relative(realSrc, realTarget);
  if (
    realTarget === realSrc ||
    (relFromSrcToTarget !== '' &&
      !relFromSrcToTarget.startsWith('..' + sep) &&
      relFromSrcToTarget !== '..')
  ) {
    throw new Error('Security boundary violation: Target cannot be source or inside source.');
  }

  if (realTarget === realRepo) {
    throw new Error('Security boundary violation: Target cannot be repository root.');
  }

  const relFromTargetToRepo = relative(realTarget, realRepo);
  if (
    relFromTargetToRepo !== '' &&
    !relFromTargetToRepo.startsWith('..' + sep) &&
    relFromTargetToRepo !== '..'
  ) {
    throw new Error(
      'Security boundary violation: Target cannot be an ancestor/parent of repository root.',
    );
  }

  try {
    const realHome = realpathSync(os.homedir());
    if (realTarget === realHome) {
      throw new Error('Security boundary violation: Target cannot be user home directory.');
    }
  } catch (e) {
    if (e.message && e.message.startsWith('Security boundary')) throw e;
  }

  if (realTarget === resolve('/') || realTarget.match(/^[a-zA-Z]:\\?$/)) {
    throw new Error('Security boundary violation: Target cannot be filesystem root.');
  }

  return { realTarget };
}

export function resolveSyncTarget(options = {}) {
  const envTarget = (process.env.BROWSERPAW_EXTENSION_SYNC_DIR || '').trim();
  const root = options.repoRoot || repoRoot;

  if (envTarget) {
    return isAbsolute(envTarget) ? envTarget : resolve(root, envTarget);
  }

  const configPath = join(root, 'browserpaw.local.json');
  if (existsSync(configPath)) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e) {
      throw new Error(`browserpaw.local.json is invalid JSON: ${e.message}`);
    }

    if (typeof cfg?.extensionSyncDir !== 'string' || !cfg.extensionSyncDir.trim()) {
      throw new Error('browserpaw.local.json missing or invalid extensionSyncDir string');
    }

    const dir = cfg.extensionSyncDir.trim();
    return isAbsolute(dir) ? dir : resolve(root, dir);
  }

  return null;
}

export function deploy(options = {}) {
  const root = options.repoRoot || repoRoot;
  const outDir = options.outDir || defaultOutDir;
  const targetDir = options.targetDir || resolveSyncTarget({ repoRoot: root });

  if (!targetDir) {
    throw new Error(
      'Deployment target not configured: BROWSERPAW_EXTENSION_SYNC_DIR env unset and browserpaw.local.json missing extensionSyncDir',
    );
  }

  // 1. Verify source build provenance first
  const { provenance } = checkBuild({ repoRoot: root, outDir });

  // 2. Validate target boundaries & verify existing target tree has no symlinks
  validateSyncTargetBoundaries(targetDir, root, outDir);
  assertNoSymlinksInTree(targetDir);

  // 3. Clear target own namespaces (chunks, assets)
  mkdirSync(targetDir, { recursive: true });
  const previousMetadata = join(targetDir, 'browserpaw-build.json');
  if (existsSync(previousMetadata)) {
    const previous = JSON.parse(readFileSync(previousMetadata, 'utf-8'));
    for (const oldPath of Object.keys(previous.artifacts || {})) {
      if (
        isAbsolute(oldPath) ||
        oldPath.startsWith('\\') ||
        oldPath.split(/[\\/]/).includes('..')
      ) {
        throw new Error(`Invalid previous artifact path: ${oldPath}`);
      }
      if (!(oldPath in provenance.artifacts)) rmSync(join(targetDir, oldPath), { force: true });
    }
  }
  for (const sub of ['chunks', 'assets']) {
    const subPath = join(targetDir, sub);
    if (existsSync(subPath)) {
      assertNoSymlink(subPath);
      const realSub = resolveRealSafe(subPath);
      const realTarget = resolveRealSafe(targetDir);
      const relSub = relative(realTarget, realSub);
      if (relSub.startsWith('..' + sep) || relSub === '..' || relSub === '') {
        throw new Error('Security boundary violation: target outside sync root: ' + subPath);
      }
      rmSync(subPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    }
  }

  // 4. Copy build output
  cpSync(outDir, targetDir, { recursive: true, force: true });

  // 5. Target browserpaw-build.json must match source verbatim
  const sourceProvFile = join(outDir, 'browserpaw-build.json');
  const targetProvFile = join(targetDir, 'browserpaw-build.json');
  if (!existsSync(targetProvFile)) {
    throw new Error('Hash verification failed: target missing browserpaw-build.json');
  }
  if (sha256File(sourceProvFile) !== sha256File(targetProvFile)) {
    throw new Error(
      'Hash verification failed: target browserpaw-build.json does not match source verbatim',
    );
  }

  // 6. Target artifacts hash verification
  for (const [relPath, expectedHash] of Object.entries(provenance.artifacts)) {
    const targetFile = join(targetDir, relPath);
    if (!existsSync(targetFile)) {
      throw new Error(`Hash verification failed: target missing artifact ${relPath}`);
    }
    const targetHash = sha256File(targetFile);
    if (targetHash !== expectedHash) {
      throw new Error(
        `Hash verification failed for ${relPath}: target hash ${targetHash} !== expected ${expectedHash}`,
      );
    }
  }

  return { success: true, targetDir, buildId: provenance.buildId };
}

export function checkDeployment(options = {}) {
  const root = options.repoRoot || repoRoot;
  const outDir = options.outDir || defaultOutDir;
  const targetDir = options.targetDir || resolveSyncTarget({ repoRoot: root });

  if (!targetDir) {
    throw new Error(
      'Deployment target not configured: BROWSERPAW_EXTENSION_SYNC_DIR env unset and browserpaw.local.json missing extensionSyncDir',
    );
  }

  // 1. Check source build provenance & source inputs freshness
  const { provenance: sourceProvenance } = checkBuild({ repoRoot: root, outDir });

  // 2. Target must exist, pass boundaries, and have clean symlink tree
  if (!existsSync(targetDir)) {
    throw new Error(`Deployment target directory does not exist: ${targetDir}`);
  }
  validateSyncTargetBoundaries(targetDir, root, outDir);
  assertNoSymlinksInTree(targetDir);
  const targetFiles = scanDirectoryFiles(targetDir).filter(
    (file) => file.relPath !== 'browserpaw-build.json',
  );
  if (
    targetFiles.length !== Object.keys(sourceProvenance.artifacts).length ||
    targetFiles.some((file) => !(file.relPath in sourceProvenance.artifacts))
  ) {
    throw new Error('Deployment target file set does not match build artifacts');
  }

  const targetManifestPath = join(targetDir, 'manifest.json');
  if (!existsSync(targetManifestPath)) {
    throw new Error(`Deployment target missing manifest.json: ${targetDir}`);
  }

  const sourceProvFile = join(outDir, 'browserpaw-build.json');
  const targetProvFile = join(targetDir, 'browserpaw-build.json');
  if (!existsSync(targetProvFile)) {
    throw new Error(`Deployment target missing browserpaw-build.json: ${targetDir}`);
  }

  if (sha256File(sourceProvFile) !== sha256File(targetProvFile)) {
    throw new Error('Deployment target browserpaw-build.json does not match source verbatim');
  }

  let targetProvenance;
  try {
    targetProvenance = JSON.parse(readFileSync(targetProvFile, 'utf-8'));
  } catch (e) {
    throw new Error(`Deployment target browserpaw-build.json is invalid JSON: ${e.message}`);
  }

  if (targetProvenance.buildId !== sourceProvenance.buildId) {
    throw new Error(
      `Deployment target buildId mismatch: target has ${targetProvenance.buildId}, source has ${sourceProvenance.buildId}`,
    );
  }

  // Check all artifacts hashes
  for (const [relPath, expectedHash] of Object.entries(sourceProvenance.artifacts)) {
    const targetFile = join(targetDir, relPath);
    if (!existsSync(targetFile)) {
      throw new Error(`Deployment target missing artifact: ${relPath}`);
    }
    const actualHash = sha256File(targetFile);
    if (actualHash !== expectedHash) {
      throw new Error(
        `Deployment target artifact hash mismatch for ${relPath}: ${actualHash} !== ${expectedHash}`,
      );
    }
  }

  // 3. Verify .artifacts/verification/latest.json evidence
  const reportPath = join(root, '.artifacts', 'verification', 'latest.json');
  if (!existsSync(reportPath)) {
    throw new Error(`Verification report missing: ${reportPath}`);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  } catch (e) {
    throw new Error(`Verification report is invalid JSON: ${e.message}`);
  }

  if (report.status !== 'passed') {
    throw new Error(`Verification gate failed: status is "${report.status}", expected "passed"`);
  }

  if (!Array.isArray(report.steps)) {
    throw new Error('Verification report missing steps array');
  }

  const passedStepNames = new Set(
    report.steps.filter((s) => s.status === 'passed').map((s) => s.name),
  );

  for (const stepName of REQUIRED_STEP_NAMES) {
    if (!passedStepNames.has(stepName)) {
      throw new Error(`Verification report missing required passed step: ${stepName}`);
    }
  }

  // Verify gate repo fingerprint matches live workspace
  if (
    report.steps.length !== REQUIRED_STEP_NAMES.length ||
    report.steps.some(
      (step) => step.status !== 'passed' || !REQUIRED_STEP_NAMES.includes(step.name),
    )
  ) {
    throw new Error('Verification report must contain exactly the complete passed step set');
  }
  {
    const currentGateFingerprint = sourceFingerprint(root);
    if (report.sourceFingerprint !== currentGateFingerprint) {
      throw new Error(
        `Verification gate sourceFingerprint mismatch: workspace source has changed since verification (${currentGateFingerprint} !== ${report.sourceFingerprint})`,
      );
    }
  }

  return { valid: true, targetDir, buildId: sourceProvenance.buildId };
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error(
      'Usage: node scripts/extension-artifacts.mjs <--check-build | --deploy | --check-deployment>',
    );
    process.exit(1);
  }

  const arg = args[0];
  try {
    if (arg === '--check-build') {
      const res = checkBuild();
      console.log(
        `[CHECK-BUILD] Passed: buildId=${res.provenance.buildId}, artifacts=${Object.keys(res.provenance.artifacts).length}`,
      );
      process.exit(0);
    } else if (arg === '--deploy') {
      const res = deploy();
      console.log(
        `[DEPLOY] Succeeded: synced and verified buildId=${res.buildId} to ${res.targetDir}`,
      );
      process.exit(0);
    } else if (arg === '--check-deployment') {
      const res = checkDeployment();
      console.log(`[CHECK-DEPLOYMENT] Passed: verified buildId=${res.buildId} in ${res.targetDir}`);
      process.exit(0);
    } else {
      console.error(
        `Unknown argument: ${arg}. Usage: node scripts/extension-artifacts.mjs <--check-build | --deploy | --check-deployment>`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`[ARTIFACTS-ERROR] ${err.message}`);
    process.exit(1);
  }
}
