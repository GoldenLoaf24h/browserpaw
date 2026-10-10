import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, '..');

// Fixed complete required step names exported for artifacts agent evidence checking
export const REQUIRED_STEP_NAMES = Object.freeze([
  'node-version-check',
  'scripts-syntax-check',
  'prepare-shared-and-types',
  'typecheck-root',
  'typecheck-extension',
  'lint',
  'root-script-tests',
  'extension-vitest',
  'native-jest',
  'build',
  'simulated-e2e',
  'plugin-pytest',
  'validate-docs',
  'extension-artifacts-check',
]);

// 1. Argument validation: strictly reject all arguments to prevent filter bypass (e.g. accidental 'run')
export function validateArguments(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    throw new Error(
      `Unknown arguments: [${argv.join(', ')}]. scripts/verify.mjs strictly rejects all arguments to prevent filtered test bypass.`,
    );
  }
}

// 2. Node.js version check (>= 22.6.0 for --experimental-strip-types)
export function checkNodeVersion(currentVersion = process.version) {
  const clean = currentVersion.replace(/^v/, '');
  const [major, minor] = clean.split('.').map(Number);
  if (major < 22 || (major === 22 && (minor || 0) < 6)) {
    throw new Error(
      `Node.js >= 22.6.0 is required for --experimental-strip-types, current version is ${currentVersion}`,
    );
  }
  return true;
}

// 3. Fallback directory walker for source fingerprint when git is unavailable
function walkDirFallback(dir, rootDir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (
        [
          'node_modules',
          '.artifacts',
          '.output',
          '.git',
          'dist',
          'research',
          '.pytest_cache',
          '.vscode',
        ].includes(entry.name)
      ) {
        continue;
      }
      results.push(...walkDirFallback(full, rootDir));
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
  return results;
}

// 4. Source fingerprint calculation: includes .github, scripts, configs, docs, unstaged files; excludes .artifacts, dist, node_modules, research
// Failclosed: file read errors are never swallowed.
export function sourceFingerprint(root = repoRoot) {
  let files = [];
  try {
    const res = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (res.status === 0 && res.stdout) {
      files = res.stdout.split('\0').filter(Boolean);
    }
  } catch {}

  if (files.length === 0) {
    files = walkDirFallback(root, root);
  }

  const ignoredExactSegments = [
    'node_modules',
    '.artifacts',
    '.output',
    '.git',
    'dist',
    'research',
    '.pytest_cache',
    '.vscode',
  ];
  const validFiles = files
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => {
      const parts = f.split('/');
      return !parts.some((p) => ignoredExactSegments.includes(p));
    })
    .sort();

  const hash = createHash('sha256');
  for (const rel of validFiles) {
    const fullPath = path.resolve(root, rel);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) continue;
    // Do NOT swallow file read error
    const content = fs.readFileSync(fullPath);
    hash.update(`path:${rel}\0`);
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

// 5. Cross-platform pnpm runner with pnpm 12 executable support
export function runPnpm(args, options = {}) {
  const isWin = process.platform === 'win32';
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    if (npmExecPath.endsWith('.exe')) {
      return spawnSync(npmExecPath, args, {
        ...options,
        encoding: 'utf-8',
      });
    }
    if (
      npmExecPath.endsWith('.js') ||
      npmExecPath.endsWith('.mjs') ||
      npmExecPath.endsWith('.cjs')
    ) {
      return spawnSync(process.execPath, [npmExecPath, ...args], {
        ...options,
        encoding: 'utf-8',
      });
    }
  }
  const cmd = isWin ? 'pnpm.cmd' : 'pnpm';
  return spawnSync(cmd, args, {
    ...options,
    shell: isWin,
    encoding: 'utf-8',
  });
}

export function needsIsolatedPytest(probe, explicitPython = process.env.PYTHON) {
  return (
    !explicitPython &&
    (probe.error?.code === 'ENOENT' || /No module named ['"]?pytest['"]?/.test(probe.stderr || ''))
  );
}

// 6. Find scripts for node --check
export function findScriptsForSyntaxCheck(root = repoRoot) {
  const files = [];
  const scriptsDir = path.resolve(root, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!['node_modules', '.artifacts', '.output', 'dist'].includes(e.name)) walk(full);
        } else if (e.isFile() && /\.(mjs|cjs|js)$/.test(e.name)) {
          files.push(full);
        }
      }
    };
    walk(scriptsDir);
  }
  const binCli = path.resolve(root, 'bin/browserpaw.cjs');
  if (fs.existsSync(binCli)) {
    files.push(binCli);
  }
  return files.sort();
}

// 7. Find root test scripts (*.test.{mjs,cjs})
export function findScriptTestFiles(root = repoRoot) {
  const scriptsDir = path.resolve(root, 'scripts');
  if (!fs.existsSync(scriptsDir)) return [];
  return fs
    .readdirSync(scriptsDir)
    .filter((f) => /\.test\.(mjs|cjs)$/.test(f))
    .map((f) => path.resolve(scriptsDir, f))
    .sort();
}

// 8. Find extension test files (tests/**/*.test.ts)
export function findExtensionTestFiles(root = repoRoot) {
  const dir = path.resolve(root, 'app/chrome-extension/tests');
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.test.ts')) {
        files.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(dir);
  return files.sort();
}

// 9. Find native test files (src/**/*.test.ts)
export function findNativeTestFiles(root = repoRoot) {
  const dir = path.resolve(root, 'app/native-server/src');
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.test.ts')) {
        files.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(dir);
  return files.sort();
}

// 10. Parse & validate Vitest JSON test report
export function parseVitestReport(jsonStr, expectedFiles = [], root = repoRoot) {
  const data = JSON.parse(jsonStr);
  const actualFiles = (data.testResults || [])
    .map((r) => {
      const rel = path.isAbsolute(r.name) ? path.relative(root, r.name) : r.name;
      return rel.replace(/\\/g, '/');
    })
    .sort();

  const total =
    data.numTotalTests ??
    (data.testResults || []).reduce((acc, r) => acc + (r.assertionResults?.length || 0), 0);
  const failed =
    data.numFailedTests ??
    (data.testResults || []).reduce((acc, r) => acc + (r.status === 'failed' ? 1 : 0), 0);
  const pending = data.numPendingTests ?? 0;
  const todo = data.numTodoTests ?? 0;

  if (expectedFiles.length > 0) {
    const expectedSet = new Set(expectedFiles);
    const actualSet = new Set(actualFiles);
    const missing = expectedFiles.filter((f) => !actualSet.has(f));
    const unexpected = actualFiles.filter((f) => !expectedSet.has(f));
    if (missing.length > 0) {
      throw new Error(
        `Vitest report missing ${missing.length} expected test files: ${missing.join(', ')}`,
      );
    }
    if (unexpected.length > 0) {
      throw new Error(`Vitest report contained unexpected test files: ${unexpected.join(', ')}`);
    }
  }

  if (total === 0) {
    throw new Error('Vitest report reported 0 tests executed');
  }
  if (failed > 0) {
    throw new Error(`Vitest report reported ${failed} failed tests`);
  }
  if (pending > 0 || todo > 0) {
    throw new Error(
      `Vitest report reported skipped/pending/todo tests (pending: ${pending}, todo: ${todo})`,
    );
  }

  return { total, failed, passed: total - failed, pending, actualFiles };
}

// 11. Parse & validate Jest JSON test report
export function parseJestReport(jsonStr, expectedFiles = [], root = repoRoot) {
  const data = JSON.parse(jsonStr);
  const actualFiles = (data.testResults || [])
    .map((r) => {
      const rel = path.isAbsolute(r.name) ? path.relative(root, r.name) : r.name;
      return rel.replace(/\\/g, '/');
    })
    .sort();

  const total = data.numTotalTests ?? 0;
  const failed = data.numFailedTests ?? 0;
  const pending = data.numPendingTests ?? 0;
  const todo = data.numTodoTests ?? 0;

  if (expectedFiles.length > 0) {
    const expectedSet = new Set(expectedFiles);
    const actualSet = new Set(actualFiles);
    const missing = expectedFiles.filter((f) => !actualSet.has(f));
    const unexpected = actualFiles.filter((f) => !expectedSet.has(f));
    if (missing.length > 0) {
      throw new Error(
        `Jest report missing ${missing.length} expected test files: ${missing.join(', ')}`,
      );
    }
    if (unexpected.length > 0) {
      throw new Error(`Jest report contained unexpected test files: ${unexpected.join(', ')}`);
    }
  }

  if (total === 0) {
    throw new Error('Jest report reported 0 tests executed');
  }
  if (failed > 0) {
    throw new Error(`Jest report reported ${failed} failed tests`);
  }
  if (pending > 0 || todo > 0) {
    throw new Error(
      `Jest report reported skipped/pending tests (pending: ${pending}, todo: ${todo})`,
    );
  }

  return { total, failed, passed: total - failed, pending, actualFiles };
}

// 12. Parse Pytest JUnit XML test report: only test_display_integration skip allowed
export function parsePytestJunit(xmlContent) {
  const testsuiteMatch = xmlContent.match(/<testsuite\b[^>]*>/i);
  if (!testsuiteMatch) {
    throw new Error('Invalid pytest JUnit XML: <testsuite> tag not found');
  }
  const tag = testsuiteMatch[0];
  const getAttr = (name) => {
    const m = tag.match(new RegExp(`${name}="([^"]+)"`, 'i'));
    return m ? Number(m[1]) : 0;
  };

  const total = getAttr('tests');
  const failures = getAttr('failures');
  const errors = getAttr('errors');
  const skipped = getAttr('skipped');

  if (total === 0) {
    throw new Error('pytest JUnit reported 0 tests');
  }
  if (failures > 0 || errors > 0) {
    throw new Error(`pytest reported ${failures} failures, ${errors} errors`);
  }

  const skippedCases = [];
  const caseMatches = xmlContent.matchAll(
    /<testcase [^>]*name="([^"]+)"[^>]*(?<!\/)>([\s\S]*?)<\/testcase>/gi,
  );
  for (const cm of caseMatches) {
    const caseName = cm[1];
    const caseBody = cm[2];
    if (/<skipped/i.test(caseBody)) {
      const msgMatch = caseBody.match(/message="([^"]*)"/i);
      const reason = msgMatch ? msgMatch[1] : 'skipped';
      skippedCases.push({ name: caseName, reason, body: caseBody });
    }
  }

  for (const sc of skippedCases) {
    const isAllowed =
      ['test_display_integration', 'plugins.browserpaw.tests.test_display_integration'].includes(
        sc.name,
      ) && /Hermes host (environment|not attached)/.test(sc.body);
    if (!isAllowed) {
      throw new Error(
        `Unexpected test skip in pytest: ${sc.name} (${sc.reason}). Only test_display_integration Hermes skip is allowed.`,
      );
    }
  }
  if (skipped !== skippedCases.length || skipped > 1) {
    throw new Error(`Expected at most 1 allowed Hermes integration skip, got ${skipped}`);
  }

  return {
    total,
    passed: total - skipped - failures - errors,
    skipped,
    failures,
    errors,
    skippedCases,
  };
}

// 13. Step runner with timing, logging, and failclosed exception propagation
export async function executeSteps(root = repoRoot) {
  const steps = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-verify-'));
  const testCounts = {};

  const recordStep = (name, command, runFn) => {
    const stepIdx = steps.length + 1;
    console.log(`[verify] Step ${stepIdx}/${REQUIRED_STEP_NAMES.length}: ${name} ...`);
    const t0 = Date.now();
    try {
      const details = runFn();
      const durationMs = Date.now() - t0;
      console.log(
        `[verify] Step ${stepIdx}/${REQUIRED_STEP_NAMES.length}: ${name} PASSED (${durationMs}ms)`,
      );
      steps.push({
        name,
        status: 'passed',
        command,
        durationMs,
        details: details || {},
      });
      return details;
    } catch (err) {
      const durationMs = Date.now() - t0;
      console.error(
        `[verify] Step ${stepIdx}/${REQUIRED_STEP_NAMES.length}: ${name} FAILED (${durationMs}ms): ${err.message}`,
      );
      steps.push({
        name,
        status: 'failed',
        command,
        durationMs,
        error: err.message,
      });
      const errorWithContext = new Error(err.message);
      errorWithContext.steps = steps;
      errorWithContext.testCounts = testCounts;
      throw errorWithContext;
    }
  };

  try {
    // Step 1: Check Node version
    recordStep('node-version-check', 'checkNodeVersion()', () => {
      checkNodeVersion();
      return { version: process.version };
    });

    // Step 2: Node scripts syntax check
    recordStep('scripts-syntax-check', 'node --check <scripts>', () => {
      const scriptFiles = findScriptsForSyntaxCheck(root);
      for (const file of scriptFiles) {
        const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
        if (res.status !== 0) {
          throw new Error(`Syntax check failed for ${file}: ${res.stdout + res.stderr}`);
        }
      }
      return { checkedFiles: scriptFiles.length };
    });

    // Step 3: Prepare shared dist & types (fixes cold clone build)
    recordStep(
      'prepare-shared-and-types',
      'pnpm --filter chrome-mcp-shared build && pnpm --dir app/chrome-extension exec wxt prepare',
      () => {
        const cleanEnv = { ...process.env };
        delete cleanEnv.BROWSERPAW_EXTENSION_SYNC_DIR;
        const resShared = runPnpm(['--filter', 'chrome-mcp-shared', 'build'], {
          cwd: root,
          env: cleanEnv,
        });
        if (resShared.status !== 0) {
          throw new Error(`Shared package build failed: ${resShared.stdout + resShared.stderr}`);
        }
        const resWxt = runPnpm(['--dir', 'app/chrome-extension', 'exec', 'wxt', 'prepare'], {
          cwd: root,
          env: cleanEnv,
        });
        if (resWxt.status !== 0) {
          throw new Error(`Extension wxt prepare failed: ${resWxt.stdout + resWxt.stderr}`);
        }
        return { status: 0 };
      },
    );

    // Step 4: Typecheck root
    recordStep('typecheck-root', 'pnpm -r --filter="!browserpaw" exec tsc --noEmit', () => {
      const res = runPnpm(['-r', '--filter=!browserpaw', 'exec', 'tsc', '--noEmit'], { cwd: root });
      if (res.status !== 0) {
        throw new Error(`Root tsc failed (exit ${res.status}): \n${res.stdout + res.stderr}`);
      }
      return { status: 0 };
    });

    // Step 5: Typecheck extension
    recordStep('typecheck-extension', 'pnpm --dir app/chrome-extension compile', () => {
      const res = runPnpm(['--dir', 'app/chrome-extension', 'compile'], { cwd: root });
      if (res.status !== 0) {
        throw new Error(
          `Extension vue-tsc compile failed (exit ${res.status}): \n${res.stdout + res.stderr}`,
        );
      }
      return { status: 0 };
    });

    // Step 6: Lint
    recordStep('lint', 'pnpm lint', () => {
      const res = runPnpm(['lint'], { cwd: root });
      if (res.status !== 0) {
        throw new Error(`Lint failed (exit ${res.status}): \n${res.stdout + res.stderr}`);
      }
      return { status: 0 };
    });

    // Step 7: Root script tests (disallows new skips)
    recordStep('root-script-tests', 'node --test <scripts/*.test.{mjs,cjs}>', () => {
      const testFiles = findScriptTestFiles(root);
      if (testFiles.length === 0) {
        throw new Error('No script test files found matching scripts/*.test.{mjs,cjs}');
      }
      const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
        cwd: root,
        encoding: 'utf-8',
      });
      if (res.status !== 0) {
        throw new Error(
          `Root script tests failed (exit ${res.status}): \n${res.stdout + res.stderr}`,
        );
      }
      const out = (res.stdout || '') + (res.stderr || '');
      const skippedMatch = out.match(/#\s*skipped\s+(\d+)/i);
      if (skippedMatch && Number(skippedMatch[1]) > 0) {
        throw new Error(`Root script tests contained unexpected skipped tests: ${skippedMatch[1]}`);
      }
      testCounts.scripts = testFiles.length;
      return { suiteFiles: testFiles.length };
    });

    // Step 8: Extension Vitest (exec vitest run directly, exit 0 check even if report exists)
    recordStep(
      'extension-vitest',
      'pnpm --dir app/chrome-extension exec vitest run --reporter=json --outputFile=<tmp>',
      () => {
        const expectedFiles = findExtensionTestFiles(root);
        const jsonReportPath = path.join(tempDir, 'vitest-report.json');
        const res = runPnpm(
          [
            '--dir',
            'app/chrome-extension',
            'exec',
            'vitest',
            'run',
            '--reporter=json',
            `--outputFile=${jsonReportPath}`,
          ],
          { cwd: root },
        );
        if (res.error) {
          throw new Error(`Failed to spawn vitest: ${res.error.message}`);
        }
        if (res.status !== 0) {
          throw new Error(
            `Vitest exited with non-zero code ${res.status}: \n${res.stdout + res.stderr}`,
          );
        }
        if (!fs.existsSync(jsonReportPath)) {
          throw new Error(`Vitest succeeded with exit 0 but failed to produce report file`);
        }
        const rawJson = fs.readFileSync(jsonReportPath, 'utf-8');
        const parsed = parseVitestReport(rawJson, expectedFiles, root);
        testCounts.extension = parsed;
        return parsed;
      },
    );

    // Step 9: Native Jest (exit 0 check even if report exists)
    recordStep(
      'native-jest',
      'pnpm --dir app/native-server exec jest --runInBand --json --outputFile=<tmp>',
      () => {
        const expectedFiles = findNativeTestFiles(root);
        const jsonReportPath = path.join(tempDir, 'jest-report.json');
        const res = runPnpm(
          [
            '--dir',
            'app/native-server',
            'exec',
            'jest',
            '--runInBand',
            '--json',
            `--outputFile=${jsonReportPath}`,
          ],
          { cwd: root },
        );
        if (res.error) {
          throw new Error(`Failed to spawn jest: ${res.error.message}`);
        }
        if (res.status !== 0) {
          throw new Error(
            `Jest exited with non-zero code ${res.status}: \n${res.stdout + res.stderr}`,
          );
        }
        if (!fs.existsSync(jsonReportPath)) {
          throw new Error(`Jest succeeded with exit 0 but failed to produce report file`);
        }
        const rawJson = fs.readFileSync(jsonReportPath, 'utf-8');
        const parsed = parseJestReport(rawJson, expectedFiles, root);
        testCounts.native = parsed;
        return parsed;
      },
    );

    // Step 10: Build without deployment env side-effects. The simulated E2E suite
    // validates the native distribution produced by this build.
    recordStep('build', 'pnpm build (clean env)', () => {
      const cleanEnv = { ...process.env };
      delete cleanEnv.BROWSERPAW_EXTENSION_SYNC_DIR;
      const res = runPnpm(['build'], { cwd: root, env: cleanEnv });
      if (res.error) throw new Error(`Failed to spawn pnpm build: ${res.error.message}`);
      if (res.status !== 0) {
        throw new Error(`pnpm build failed (exit ${res.status}): \n${res.stdout + res.stderr}`);
      }
      return { status: 0 };
    });

    // Step 11: Simulated E2E Runner (mock, not live)
    recordStep('simulated-e2e', 'node --experimental-strip-types test/e2e/runner.ts', () => {
      const res = spawnSync(
        process.execPath,
        ['--experimental-strip-types', 'test/e2e/runner.ts'],
        {
          cwd: root,
          encoding: 'utf-8',
        },
      );
      if (res.error) {
        throw new Error(`Failed to spawn simulated e2e runner: ${res.error.message}`);
      }
      if (res.status !== 0) {
        throw new Error(
          `Simulated E2E runner failed (exit ${res.status}): \n${res.stdout + res.stderr}`,
        );
      }
      testCounts.e2e = { mode: 'mock-simulated', exitCode: 0 };
      return { mode: 'mock-simulated', exitCode: 0 };
    });

    // Step 12: Python pytest (only fallback to uv on command ENOENT, disallow retry on test failure)
    recordStep('plugin-pytest', 'pytest plugins/browserpaw/tests --junitxml=<tmp>', () => {
      const junitXmlPath = path.join(tempDir, 'pytest-junit.xml');
      const pyCmd = process.env.PYTHON || 'python';
      const pyArgs = ['-m', 'pytest', 'plugins/browserpaw/tests', `--junitxml=${junitXmlPath}`];
      const probe = spawnSync(pyCmd, ['-c', 'import pytest'], { cwd: root, encoding: 'utf-8' });
      const useUv = needsIsolatedPytest(probe);
      if (!useUv && (probe.error || probe.status !== 0)) {
        throw new Error(
          `Python pytest dependency check failed: ${probe.error?.message || probe.stdout + probe.stderr}`,
        );
      }
      // Choose a prepared interpreter before executing tests; never retry a failed suite.
      const res = useUv
        ? spawnSync(
            'uv',
            [
              'run',
              '--with',
              'pytest',
              'pytest',
              'plugins/browserpaw/tests',
              `--junitxml=${junitXmlPath}`,
            ],
            { cwd: root, encoding: 'utf-8' },
          )
        : spawnSync(pyCmd, pyArgs, { cwd: root, encoding: 'utf-8' });
      if (res.error) {
        throw new Error(`Failed to spawn pytest: ${res.error.message}`);
      }
      if (res.status !== 0) {
        throw new Error(`pytest exited with code ${res.status}: \n${res.stdout + res.stderr}`);
      }
      if (!fs.existsSync(junitXmlPath)) {
        throw new Error(`pytest succeeded with exit 0 but failed to produce junit xml file`);
      }
      const rawXml = fs.readFileSync(junitXmlPath, 'utf-8');
      const parsed = parsePytestJunit(rawXml);
      testCounts.python = parsed;
      return {
        ...parsed,
        hermesSkipReason: 'Hermes known module integration skip (host not attached)',
      };
    });

    // Step 13: Validate docs
    recordStep('validate-docs', 'node scripts/validate-docs.mjs', () => {
      const scriptPath = path.resolve(root, 'scripts/validate-docs.mjs');
      const res = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf-8' });
      if (res.error) throw new Error(`Failed to spawn validate-docs: ${res.error.message}`);
      if (res.status !== 0) {
        throw new Error(
          `validate-docs.mjs failed (exit ${res.status}): \n${res.stdout + res.stderr}`,
        );
      }
      return { status: 0 };
    });

    // Step 14: Extension artifacts check
    recordStep(
      'extension-artifacts-check',
      'node scripts/extension-artifacts.mjs --check-build',
      () => {
        const scriptPath = path.resolve(root, 'scripts/extension-artifacts.mjs');
        const res = spawnSync(process.execPath, [scriptPath, '--check-build'], {
          cwd: root,
          encoding: 'utf-8',
        });
        if (res.error)
          throw new Error(`Failed to spawn extension-artifacts.mjs: ${res.error.message}`);
        if (res.status !== 0) {
          throw new Error(
            `extension-artifacts.mjs failed (exit ${res.status}): \n${res.stdout + res.stderr}`,
          );
        }
        return { status: 0 };
      },
    );

    return { status: 'passed', steps, testCounts };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// 14. Report generator: writes .artifacts/verification/latest.json
export function writeLatestReport(reportData, root = repoRoot) {
  const artifactDir = path.resolve(root, '.artifacts/verification');
  fs.mkdirSync(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, 'latest.json');
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf-8');
  return reportPath;
}

// 15. Main runner entrypoint
export async function main(root = repoRoot) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let startFingerprint = '';
  try {
    validateArguments();
    startFingerprint = sourceFingerprint(root);
  } catch (err) {
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const reportData = {
      status: 'failed',
      sourceFingerprint: startFingerprint || 'unknown',
      startedAt,
      endedAt,
      durationMs,
      steps: [
        {
          name: 'initialization',
          status: 'failed',
          command: 'validateArguments()',
          durationMs,
          error: err.message,
        },
      ],
      summary: { totalSteps: 1, passedSteps: 0, failedSteps: 1 },
    };
    writeLatestReport(reportData, root);
    console.error(`Verification initialization failed: ${err.message}`);
    process.exit(1);
  }

  // Invalidate any old passed report immediately by writing running status
  writeLatestReport(
    {
      status: 'running',
      sourceFingerprint: startFingerprint,
      startedAt,
      steps: [],
      summary: { status: 'running' },
    },
    root,
  );

  let status = 'passed';
  let steps = [];
  let testCounts = {};
  let failureError = null;

  try {
    const result = await executeSteps(root);
    steps = result.steps;
    testCounts = result.testCounts;
  } catch (err) {
    status = 'failed';
    failureError = err;
    steps = err.steps || [];
    testCounts = err.testCounts || {};
  }

  // End-time concurrency drift detection: verify fingerprint did not mutate
  const endFingerprint = sourceFingerprint(root);
  if (status === 'passed' && endFingerprint !== startFingerprint) {
    status = 'failed';
    failureError = new Error(
      `Source fingerprint mutated during verification (start: ${startFingerprint}, end: ${endFingerprint}). Concurrent source modification detected.`,
    );
  }

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;
  const passedSteps = steps.filter((s) => s.status === 'passed').length;
  const failedSteps = steps.filter((s) => s.status === 'failed').length;

  const reportData = {
    status,
    sourceFingerprint: startFingerprint,
    startedAt,
    endedAt,
    durationMs,
    steps,
    summary: {
      totalSteps: steps.length,
      passedSteps,
      failedSteps,
      testCounts,
      failure: failureError ? failureError.message : null,
    },
  };

  const reportPath = writeLatestReport(reportData, root);
  console.log(`Verification completed with status: ${status}`);
  console.log(`Report written to: ${reportPath}`);

  if (status !== 'passed') {
    if (failureError) {
      console.error(`Verification gate failed: ${failureError.message}`);
    }
    process.exit(1);
  }
}

// Only run automatically when executed directly
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error('Fatal verification runner error:', err);
    process.exit(1);
  });
}
