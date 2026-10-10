import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  REQUIRED_STEP_NAMES,
  validateArguments,
  checkNodeVersion,
  sourceFingerprint,
  parseVitestReport,
  parseJestReport,
  parsePytestJunit,
  writeLatestReport,
  findScriptsForSyntaxCheck,
  findScriptTestFiles,
  findExtensionTestFiles,
  findNativeTestFiles,
  repoRoot,
  needsIsolatedPytest,
} from './verify.mjs';

it('selects isolated pytest only for unavailable default dependencies', () => {
  assert.equal(
    needsIsolatedPytest({ stderr: "ModuleNotFoundError: No module named 'pytest'" }, false),
    true,
  );
  assert.equal(needsIsolatedPytest({ error: { code: 'ENOENT' } }, false), true);
  assert.equal(needsIsolatedPytest({ stderr: 'test failed' }, false), false);
  assert.equal(needsIsolatedPytest({ stderr: "No module named 'pytest'" }, 'chosen-python'), false);
});

describe('Verification Runner Core Contract', () => {
  describe('1. Argument validation boundary', () => {
    it('accepts empty arguments', () => {
      assert.doesNotThrow(() => validateArguments([]));
    });

    it('rejects filtering argument e.g. "run" to prevent 3-test bypass', () => {
      assert.throws(
        () => validateArguments(['run']),
        /scripts\/verify\.mjs strictly rejects all arguments/,
      );
    });

    it('rejects test filter options --filter, -t, etc.', () => {
      assert.throws(
        () => validateArguments(['--filter', 'foo']),
        /scripts\/verify\.mjs strictly rejects all arguments/,
      );
      assert.throws(
        () => validateArguments(['-t', 'test-name']),
        /scripts\/verify\.mjs strictly rejects all arguments/,
      );
    });
  });

  describe('2. Node version gate', () => {
    it('passes for Node >= 22.6.0', () => {
      assert.strictEqual(checkNodeVersion('v22.6.0'), true);
      assert.strictEqual(checkNodeVersion('v22.14.0'), true);
      assert.strictEqual(checkNodeVersion('v23.0.0'), true);
    });

    it('rejects for Node < 22.6.0', () => {
      assert.throws(() => checkNodeVersion('v22.5.0'), /Node\.js >= 22\.6\.0 is required/);
      assert.throws(() => checkNodeVersion('v20.12.0'), /Node\.js >= 22\.6\.0 is required/);
      assert.throws(() => checkNodeVersion('v18.0.0'), /Node\.js >= 22\.6\.0 is required/);
    });
  });

  describe('3. Source fingerprint calculation', () => {
    it('generates a valid 64-char sha256 hex string', () => {
      const fp = sourceFingerprint(repoRoot);
      assert.strictEqual(typeof fp, 'string');
      assert.strictEqual(fp.length, 64);
      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it('is stable across repeated invocations', () => {
      const fp1 = sourceFingerprint(repoRoot);
      const fp2 = sourceFingerprint(repoRoot);
      assert.strictEqual(fp1, fp2);
    });
  });

  describe('4. Vitest report validation gate', () => {
    const expected = [
      'app/chrome-extension/tests/a.test.ts',
      'app/chrome-extension/tests/b.test.ts',
    ];

    it('accepts full matching suite without skips or failures', () => {
      const validJson = JSON.stringify({
        numTotalTests: 10,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/a.test.ts'),
            status: 'passed',
          },
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/b.test.ts'),
            status: 'passed',
          },
        ],
      });
      const parsed = parseVitestReport(validJson, expected, repoRoot);
      assert.strictEqual(parsed.total, 10);
      assert.strictEqual(parsed.failed, 0);
      assert.strictEqual(parsed.pending, 0);
    });

    it('rejects missing expected test suite (under-testing / filtering)', () => {
      const missingJson = JSON.stringify({
        numTotalTests: 5,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/a.test.ts'),
            status: 'passed',
          },
        ],
      });
      assert.throws(
        () => parseVitestReport(missingJson, expected, repoRoot),
        /Vitest report missing 1 expected test files/,
      );
    });

    it('rejects unexpected test suite', () => {
      const extraJson = JSON.stringify({
        numTotalTests: 15,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/a.test.ts'),
            status: 'passed',
          },
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/b.test.ts'),
            status: 'passed',
          },
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/c.test.ts'),
            status: 'passed',
          },
        ],
      });
      assert.throws(
        () => parseVitestReport(extraJson, expected, repoRoot),
        /Vitest report contained unexpected test files/,
      );
    });

    it('rejects reports with 0 tests executed', () => {
      const zeroJson = JSON.stringify({
        numTotalTests: 0,
        numFailedTests: 0,
        testResults: [],
      });
      assert.throws(() => parseVitestReport(zeroJson, [], repoRoot), /0 tests executed/);
    });

    it('rejects reports with failed tests', () => {
      const failedJson = JSON.stringify({
        numTotalTests: 10,
        numFailedTests: 1,
        testResults: [
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/a.test.ts'),
            status: 'failed',
          },
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/b.test.ts'),
            status: 'passed',
          },
        ],
      });
      assert.throws(() => parseVitestReport(failedJson, expected, repoRoot), /1 failed tests/);
    });

    it('rejects reports with skipped or pending tests', () => {
      const skipJson = JSON.stringify({
        numTotalTests: 10,
        numFailedTests: 0,
        numPendingTests: 2,
        testResults: [
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/a.test.ts'),
            status: 'passed',
          },
          {
            name: path.resolve(repoRoot, 'app/chrome-extension/tests/b.test.ts'),
            status: 'passed',
          },
        ],
      });
      assert.throws(
        () => parseVitestReport(skipJson, expected, repoRoot),
        /skipped\/pending\/todo tests/,
      );
    });
  });

  describe('5. Jest report validation gate', () => {
    const expected = ['app/native-server/src/foo.test.ts'];

    it('accepts full matching suite', () => {
      const validJson = JSON.stringify({
        numTotalTests: 6,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [
          { name: path.resolve(repoRoot, 'app/native-server/src/foo.test.ts'), status: 'passed' },
        ],
      });
      const parsed = parseJestReport(validJson, expected, repoRoot);
      assert.strictEqual(parsed.total, 6);
      assert.strictEqual(parsed.passed, 6);
    });

    it('rejects missing test suite', () => {
      const emptyJson = JSON.stringify({
        numTotalTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [],
      });
      assert.throws(
        () => parseJestReport(emptyJson, expected, repoRoot),
        /Jest report missing 1 expected test files/,
      );
    });

    it('rejects pending/skipped tests in native jest', () => {
      const skipJson = JSON.stringify({
        numTotalTests: 5,
        numFailedTests: 0,
        numPendingTests: 1,
        testResults: [
          { name: path.resolve(repoRoot, 'app/native-server/src/foo.test.ts'), status: 'passed' },
        ],
      });
      assert.throws(() => parseJestReport(skipJson, expected, repoRoot), /skipped\/pending tests/);
    });
  });

  describe('6. Pytest JUnit XML parser', () => {
    it('parses successful run with 22 passed and 1 allowed test_display_integration Hermes skip', () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="23" errors="0" failures="0" skipped="1">
    <testcase classname="test_bridge" name="test_token" time="0.01" />
    <testcase classname="test_display" name="test_display_integration" time="0.02">
      <skipped message="Hermes host not attached" type="pytest.skip" />
    </testcase>
  </testsuite>
</testsuites>`;
      const parsed = parsePytestJunit(xml);
      assert.strictEqual(parsed.total, 23);
      assert.strictEqual(parsed.passed, 22);
      assert.strictEqual(parsed.skipped, 1);
      assert.strictEqual(parsed.failures, 0);
      assert.strictEqual(parsed.errors, 0);
      assert.strictEqual(parsed.skippedCases.length, 1);
      assert.strictEqual(parsed.skippedCases[0].reason, 'Hermes host not attached');
    });

    it('rejects unexpected skip in pytest tests other than display integration', () => {
      const xmlWithUnapprovedSkip = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="23" errors="0" failures="0" skipped="1">
    <testcase classname="test_bridge" name="test_token" time="0.01">
      <skipped message="unauthorized skip" type="pytest.skip" />
    </testcase>
  </testsuite>
</testsuites>`;
      assert.throws(
        () => parsePytestJunit(xmlWithUnapprovedSkip),
        /Unexpected test skip in pytest: test_token/,
      );
    });

    it('rejects pytest reports with failures', () => {
      const failXml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="23" errors="0" failures="2" skipped="0">
  </testsuite>
</testsuites>`;
      assert.throws(() => parsePytestJunit(failXml), /2 failures, 0 errors/);
    });

    it('rejects unrelated tests even when the skip reason mentions Hermes', () => {
      const xml =
        '<testsuite tests="1" errors="0" failures="0" skipped="1"><testcase name="test_token"><skipped message="Hermes host not attached" /></testcase></testsuite>';
      assert.throws(() => parsePytestJunit(xml), /Unexpected test skip/);
    });

    it('rejects skips missing from testcase details', () => {
      const xml = '<testsuite tests="1" errors="0" failures="0" skipped="1"></testsuite>';
      assert.throws(() => parsePytestJunit(xml), /allowed Hermes integration skip/);
    });

    it('rejects empty pytest suite', () => {
      const emptyXml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="0" errors="0" failures="0" skipped="0">
  </testsuite>
</testsuites>`;
      assert.throws(() => parsePytestJunit(emptyXml), /0 tests/);
    });
  });

  describe('7. Report generation and schema compliance', () => {
    it('writes latest.json adhering to top-level status, sourceFingerprint, steps schema', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-rep-test-'));
      try {
        const payload = {
          status: 'passed',
          sourceFingerprint: 'abc1234567890abcdef',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 1234,
          steps: [
            {
              name: 'node-version-check',
              status: 'passed',
              command: 'checkNodeVersion()',
              durationMs: 5,
            },
          ],
          summary: { totalSteps: 1, passedSteps: 1, failedSteps: 0 },
        };
        const p = writeLatestReport(payload, tmp);
        assert.strictEqual(fs.existsSync(p), true);
        const readBack = JSON.parse(fs.readFileSync(p, 'utf-8'));
        assert.strictEqual(readBack.status, 'passed');
        assert.strictEqual(readBack.sourceFingerprint, 'abc1234567890abcdef');
        assert.strictEqual(Array.isArray(readBack.steps), true);
        assert.strictEqual(readBack.steps[0].name, 'node-version-check');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('exports REQUIRED_STEP_NAMES containing all 14 fixed steps', () => {
      assert.strictEqual(REQUIRED_STEP_NAMES.length, 14);
      assert.ok(REQUIRED_STEP_NAMES.includes('node-version-check'));
      assert.ok(REQUIRED_STEP_NAMES.includes('prepare-shared-and-types'));
      assert.ok(REQUIRED_STEP_NAMES.includes('extension-vitest'));
      assert.ok(REQUIRED_STEP_NAMES.includes('extension-artifacts-check'));
    });
  });

  describe('8. Project directory enumeration helpers', () => {
    it('finds script syntax check targets including bin/browserpaw.cjs', () => {
      const list = findScriptsForSyntaxCheck(repoRoot);
      assert.ok(list.length > 0, 'Should find scripts for syntax check');
      assert.ok(list.some((f) => f.includes('browserpaw.cjs')));
      assert.ok(list.some((f) => f.includes('verify.mjs')));
    });

    it('finds script test files in scripts/', () => {
      const list = findScriptTestFiles(repoRoot);
      assert.ok(list.length > 0, 'Should find at least 1 script test file');
      assert.ok(list.some((f) => f.includes('verify.test.mjs')));
    });

    it('finds extension test files', () => {
      const list = findExtensionTestFiles(repoRoot);
      assert.ok(list.length > 0, 'Should find extension test files');
      assert.ok(list.every((f) => f.endsWith('.test.ts')));
    });

    it('finds native server test files', () => {
      const list = findNativeTestFiles(repoRoot);
      assert.ok(list.length > 0, 'Should find native server test files');
      assert.ok(list.every((f) => f.endsWith('.test.ts')));
    });
  });
});
