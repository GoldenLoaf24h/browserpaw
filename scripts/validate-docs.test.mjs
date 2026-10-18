import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import {
  stripCodeBlocks,
  extractLocalLinks,
  resolveLocalLink,
  checkPackageVersions,
  checkTagReleaseRecords,
  checkDocsIndexCoverage,
  checkTextIntegrity,
  validateDocs,
} from './validate-docs.mjs';

test('stripCodeBlocks removes fenced code and inline code', () => {
  const md = [
    '# Test',
    'Here is [active link](./real.md)',
    '```markdown',
    '[ignored link](./fake.md)',
    '```',
    'And inline `[ignored](./also-fake.md)` code.',
  ].join('\n');

  const stripped = stripCodeBlocks(md);
  assert.ok(stripped.includes('[active link](./real.md)'));
  assert.ok(!stripped.includes('./fake.md'));
  assert.ok(!stripped.includes('./also-fake.md'));
});

test('extractLocalLinks extracts markdown and html links while ignoring external', () => {
  const content = [
    'Check [docs](docs/README.md) and <a href="docs/QUALITY.md">Quality</a>.',
    'External: [GitHub](https://github.com)',
    'Anchor only: [Top](#heading)',
    'Chrome UI: [Extensions](chrome://extensions)',
  ].join('\n');

  const links = extractLocalLinks(content);
  assert.equal(links.length, 2);
  assert.equal(links[0].pathPart, 'docs/README.md');
  assert.equal(links[1].pathPart, 'docs/QUALITY.md');
});

test('resolveLocalLink detects existing files, handles hashes, and rejects missing', () => {
  const repoRoot = process.cwd();
  const sourceFile = path.join(repoRoot, 'README.md');

  const validRes = resolveLocalLink(sourceFile, 'docs/README.md', repoRoot);
  assert.equal(validRes.exists, true);

  const missingRes = resolveLocalLink(sourceFile, 'docs/non-existent-file-xyz.md', repoRoot);
  assert.equal(missingRes.exists, false);

  const artifactRes = resolveLocalLink(sourceFile, '.artifacts/verification/report.json', repoRoot);
  assert.equal(artifactRes.exists, false);
  assert.equal(artifactRes.isArtifactLeak, true);

  const configRes = resolveLocalLink(sourceFile, 'browserpaw.local.json', repoRoot);
  assert.equal(configRes.exists, true);
  assert.equal(configRes.isIgnoredConfig, true);
});

test('checkTextIntegrity rejects illegal control characters, literal newlines, and unexpected CJK', () => {
  const ctrlIssues = checkTextIntegrity('docs/test.md', 'Hello\x1bWorld');
  assert.ok(ctrlIssues.some((i) => i.includes('control characters')));

  const unexpandedIssues = checkTextIntegrity(
    'docs/test.md',
    'Single line\\n\\nwith literal\\n\\nescapes\\n\\nmultiple times\\n\\n',
  );
  assert.ok(unexpandedIssues.some((i) => i.includes('Unexpanded literal newline')));

  const cjkIssues = checkTextIntegrity('docs/test.md', 'English document with 中文 characters');
  assert.ok(cjkIssues.some((i) => i.includes('Unexpected Chinese characters')));

  const zhIssues = checkTextIntegrity('docs/test.zh-CN.md', '中文镜像文档允许正常汉字');
  assert.equal(zhIssues.length, 0);
});

test('checkPackageVersions verifies consistency across monorepo packages', () => {
  const repoRoot = process.cwd();
  const res = checkPackageVersions(repoRoot);
  assert.equal(res.matched, true);
  assert.equal(res.canonicalVersion, '4.0.0');
  assert.equal(res.versions.root, '4.0.0');
  assert.equal(res.versions['native-server'], '4.0.0');
  assert.equal(res.versions.shared, '4.0.0');
  assert.equal(res.versions['chrome-extension'], '4.0.0');
  assert.equal(res.versions['codex-plugin'], '4.0.0');
  assert.equal(res.versions['claude-plugin'], '4.0.0');
});

test('checkTagReleaseRecords asserts all local git tags have release notes', () => {
  const repoRoot = process.cwd();
  const res = checkTagReleaseRecords(repoRoot);
  assert.equal(res.valid, true);
  const actualTags = execSync('git tag -l', { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
  assert.equal(res.tagCount, actualTags);
  assert.equal(res.missingRecords.length, 0);
});

test('checkDocsIndexCoverage verifies canonical documents in docs/README.md', () => {
  const repoRoot = process.cwd();
  const res = checkDocsIndexCoverage(repoRoot);
  assert.equal(res.valid, true);
  assert.equal(res.missingEntries.length, 0);
});

test('validateDocs full run on current repository succeeds', () => {
  const repoRoot = process.cwd();
  const report = validateDocs(repoRoot);
  assert.equal(report.valid, true, JSON.stringify(report, null, 2));
  assert.equal(report.brokenLinks.length, 0);
  assert.equal(report.textIssues.length, 0);
  assert.ok(report.totalFilesChecked > 30);
  assert.ok(report.totalLinksChecked > 50);
});
