import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  validateTemplate,
  validateReleaseNote,
  getReleaseFiles,
  runCheck,
  repoRoot,
  templateFile,
  HISTORICAL_RELEASES,
} from './release-notes.mjs';

const VALID_RELEASE_CONTENT = `# BrowserPaw v4.2.0

- **Tag:** v4.2.0
- **Target:** main
- **Date:** 2026-11-05

BrowserPaw 4.2.0 introduces adaptive viewport budgeting and isolated frame observations.

## Overview

This release delivers adaptive viewport capture budgets, isolated frame observations,
and verified goal execution boundaries across all supported clients.

## Changes

### Viewport & Observation
- Adaptive viewport scaling preserves CSS viewport and device pixel ratio.
- Frame isolation reads main content independently even when child frames fail.

## Upgrade & Compatibility

- **Breaking Changes:** None.
- **Migration Guide:** No changes required for standard automation flows.
- **Compatibility Boundaries:** Chromium 120+, Node.js >= 22.6.0.

## Verification Scope

- **Verification Gate:** \`pnpm verify\` (14/14 steps passed).
- **Automated Tests:** 1789 extension tests passed, 654 native tests passed.
- **CI Status:** Linux & Windows passed: https://github.com/GoldenLoaf24h/browserpaw/actions/runs/123456
- **Loaded Runtime Checks:** Verified live frame isolation on loaded Chrome MV3 extension.
- **Boundaries & Exclusions:** Gmail draft automation was not re-tested in this release.

## Release Assets

Stable release assets with SHA-256 checksums:

| Asset Name | SHA-256 Checksum | Description |
| :--- | :--- | :--- |
| \`browserpaw-extension.zip\` | \`0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\` | Chrome MV3 extension bundle |
| \`browserpaw-skill.zip\` | \`abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\` | Canonical agent skill bundle |

## Diff & Commits

- **Full Changelog:** https://github.com/GoldenLoaf24h/browserpaw/compare/v4.1.2...v4.2.0
`;

test('validateTemplate succeeds on canonical docs/releases/TEMPLATE.md', () => {
  const result = validateTemplate(templateFile);
  assert.equal(result.valid, true, `Template errors: ${result.errors.join(', ')}`);
  assert.equal(result.errors.length, 0);
});

test('validateTemplate detects missing sections and missing stable assets', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-tmpl-'));
  try {
    const badTemplate = path.join(tempDir, 'TEMPLATE.md');
    fs.writeFileSync(badTemplate, '# BrowserPaw v<VERSION>\n\n- **Tag:** v<VERSION>\n');
    const result = validateTemplate(badTemplate);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('missing required section')));
    assert.ok(result.errors.some((e) => e.includes('missing stable asset')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('validateReleaseNote succeeds on valid release note content', () => {
  const result = validateReleaseNote(VALID_RELEASE_CONTENT, 'v4.2.0.md');
  assert.equal(result.valid, true, `Validation errors: ${result.errors.join(', ')}`);
  assert.equal(result.errors.length, 0);
});

test('release format rejects realistic publication mistakes', () => {
  const malformed = [
    VALID_RELEASE_CONTENT.replace('**Tag:** v4.2.0', '**Tag:** v4.1.2'),
    VALID_RELEASE_CONTENT.replace('2026-11-05', '2026-02-30'),
    VALID_RELEASE_CONTENT.replace('2026-11-05', '2026-11-05garbage'),
    VALID_RELEASE_CONTENT.replace('## Overview', '## Summary'),
    VALID_RELEASE_CONTENT.replace(/## Overview[\s\S]*?(?=## Changes)/, '## Overview\n\n'),
    VALID_RELEASE_CONTENT.replace('## Changes', '## Overview\nDuplicate\n\n## Changes'),
    VALID_RELEASE_CONTENT.replace('## Overview', '## Changes').replace(
      '## Changes\n\n###',
      '## Overview\n\n###',
    ),
    '```markdown\n' + VALID_RELEASE_CONTENT + '\n```',
    VALID_RELEASE_CONTENT.replace('Chromium 120+', '<Supported browser versions>'),
    VALID_RELEASE_CONTENT.replace('Chromium 120+', 'tbd'),
    VALID_RELEASE_CONTENT.replace(/- \*\*Boundaries & Exclusions:\*\*[^\n]+/, ''),
    VALID_RELEASE_CONTENT.replace('compare/v4.1.2...v4.2.0', 'compare/v4.1.2...v4.3.0'),
    VALID_RELEASE_CONTENT.replace('browserpaw/compare/', 'another-project/compare/'),
    VALID_RELEASE_CONTENT.replace('- **Tag:** v4.2.0', '- **Tag:** v4.2.0\n- **Tag:** v4.1.2'),
  ];
  for (const [index, content] of malformed.entries()) {
    assert.equal(
      validateReleaseNote(content, 'v4.2.0.md').valid,
      false,
      `Malformed case ${index} passed`,
    );
  }
  assert.equal(validateReleaseNote(VALID_RELEASE_CONTENT, 'v4.3.0.md').valid, false);
  assert.equal(
    validateReleaseNote(VALID_RELEASE_CONTENT.replaceAll('v4.2.0', 'v4.2.0-rc.1'), 'v4.2.0-rc.1.md')
      .valid,
    true,
  );
});

test('CLI rejects missing option values and unknown options', () => {
  for (const args of [['--file'], ['--typo'], ['--file', '--help']]) {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/release-notes.mjs'), ...args],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

test('validateReleaseNote rejects malformed title', () => {
  const badTitle = VALID_RELEASE_CONTENT.replace(/^# BrowserPaw v4.2.0[^\n]*/m, '# Invalid Title');
  const result = validateReleaseNote(badTitle, 'v4.2.0.md');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Title must match')));
});

test('validateReleaseNote rejects missing metadata', () => {
  const missingTag = VALID_RELEASE_CONTENT.replace(/-\s+\*\*Tag:\*\*[^\n]*/, '');
  const result = validateReleaseNote(missingTag, 'v4.2.0.md');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Missing or malformed metadata: Tag')));
});

test('validateReleaseNote rejects missing required sections', () => {
  const missingScope = VALID_RELEASE_CONTENT.replace(
    /## Verification Scope[\s\S]*?(?=## Release Assets)/,
    '',
  );
  const result = validateReleaseNote(missingScope, 'v4.2.0.md');
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.includes('Missing required section: ## Verification Scope')),
  );
});

test('validateReleaseNote rejects missing required stable skill asset', () => {
  const missingAsset = VALID_RELEASE_CONTENT.replace(
    /`browserpaw-skill\.zip`/g,
    '`other-skill.zip`',
  );
  const result = validateReleaseNote(missingAsset, 'v4.2.0.md');
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.includes('Missing required stable asset: "browserpaw-skill.zip"')),
  );
});

test('validateReleaseNote allows omitting browserpaw-extension.zip when extension is unchanged', () => {
  const cliOnlyRelease = VALID_RELEASE_CONTENT.replace(
    /\| `browserpaw-extension\.zip`[^\n]*\r?\n/,
    '',
  );
  const result = validateReleaseNote(cliOnlyRelease, 'v4.2.0.md');
  assert.equal(result.valid, true, `Validation errors: ${result.errors.join(', ')}`);
  assert.equal(result.errors.length, 0);
});

test('validateReleaseNote rejects versioned extension or skill archive filenames', () => {
  const versionedAsset = VALID_RELEASE_CONTENT.replace(
    '`browserpaw-extension.zip`',
    '`browserpaw-extension-v4.2.0.zip`',
  );
  const result = validateReleaseNote(versionedAsset, 'v4.2.0.md');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must use stable filenames')));
});

test('validateReleaseNote rejects unexpanded placeholders in real release note', () => {
  const withPlaceholder = VALID_RELEASE_CONTENT.replace(
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    '<SHA256_HASH_FOR_EXTENSION_ZIP>',
  );
  const result = validateReleaseNote(withPlaceholder, 'v4.2.0.md');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Contains unresolved placeholder')));
});

test('validateReleaseNote rejects TODO or TBD markers', () => {
  const withTodo = VALID_RELEASE_CONTENT.replace('Chromium 120+', 'TODO: check versions');
  const result = validateReleaseNote(withTodo, 'v4.2.0.md');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Contains unresolved placeholder: "TODO"')));
});

test('validateReleaseNote rejects missing compare or commit link', () => {
  const noCompare = VALID_RELEASE_CONTENT.replace(
    /https:\/\/github\.com\/[^\s)]+\/compare\/[^\s)]+/g,
    'None',
  );
  const result = validateReleaseNote(noCompare, 'v4.2.0.md');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Missing GitHub compare/commit link')));
});

test('getReleaseFiles correctly partitions historical releases', () => {
  const files = getReleaseFiles();
  assert.ok(files.length >= 35, `Expected at least 35 release files, got ${files.length}`);
  for (const item of files) {
    if (HISTORICAL_RELEASES.has(item.filename)) {
      assert.equal(item.isHistorical, true);
    }
  }
});

test('runCheck passes on repository baseline without errors', () => {
  const report = runCheck();
  assert.equal(report.valid, true, `Report errors: ${report.errors.join(', ')}`);
  assert.equal(report.templateValid, true);
  assert.equal(report.releasingDocExists, true);
  assert.ok(report.historicalReleasesSkipped >= 35);
});

test('runCheck requires the root package version and its release ledger entry', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-release-ledger-'));
  const releasesDir = path.join(tempDir, 'docs', 'releases');
  try {
    fs.mkdirSync(releasesDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '5.0.0' }));
    fs.writeFileSync(
      path.join(releasesDir, 'v5.0.0.md'),
      VALID_RELEASE_CONTENT.replaceAll('v4.2.0', 'v5.0.0'),
    );
    fs.writeFileSync(path.join(releasesDir, 'README.md'), '# Release Ledger\n');

    const missingLink = runCheck({
      repoRoot: tempDir,
      releasesDir,
      templateFile,
      releasingFile: path.join(repoRoot, 'docs', 'releases', 'RELEASING.md'),
    });
    assert.equal(missingLink.valid, false);
    assert.ok(missingLink.errors.some((error) => error.includes('must link to v5.0.0.md')));

    fs.writeFileSync(path.join(releasesDir, 'README.md'), '[v5.0.0](./v5.0.0.md)\n');
    const linked = runCheck({
      repoRoot: tempDir,
      releasesDir,
      templateFile,
      releasingFile: path.join(repoRoot, 'docs', 'releases', 'RELEASING.md'),
    });
    assert.equal(linked.valid, true, linked.errors.join(', '));

    fs.rmSync(path.join(releasesDir, 'v5.0.0.md'));
    const missingNote = runCheck({
      repoRoot: tempDir,
      releasesDir,
      templateFile,
      releasingFile: path.join(repoRoot, 'docs', 'releases', 'RELEASING.md'),
    });
    assert.equal(missingNote.valid, false);
    assert.ok(missingNote.errors.some((error) => error.includes('has no docs/releases/v5.0.0.md')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI execution exits 0 on valid repository check', () => {
  const res = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'release-notes.mjs')], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  assert.equal(res.status, 0, `CLI output:\n${res.stdout}\n${res.stderr}`);
  assert.ok(res.stdout.includes('Release notes specification check passed'));
});

test('CLI execution exits non-zero on invalid file check', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-cli-'));
  try {
    const badFile = path.join(tempDir, 'v9.9.9.md');
    fs.writeFileSync(badFile, '# Invalid Note\n');
    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'release-notes.mjs'), '--file', badFile],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
      },
    );
    assert.notEqual(res.status, 0, 'Expected non-zero exit status for invalid release note');
    assert.ok(res.stderr.includes('Release notes specification check failed'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
