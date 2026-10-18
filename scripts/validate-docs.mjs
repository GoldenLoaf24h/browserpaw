import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Strips code fences and inline code blocks from markdown to avoid false-positive links.
 */
export function stripCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
}

/**
 * Extracts relative local markdown links from text.
 * Returns array of { raw, link, pathPart, hashPart }
 */
export function extractLocalLinks(content) {
  const stripped = stripCodeBlocks(content);
  const links = [];
  const mdRegex = /\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = mdRegex.exec(stripped)) !== null) {
    const target = match[2].trim();
    if (isCandidateLocalLink(target)) {
      links.push(parseLinkTarget(target));
    }
  }

  const hrefRegex = /href=["']([^"']+)["']/g;
  while ((match = hrefRegex.exec(stripped)) !== null) {
    const target = match[1].trim();
    if (isCandidateLocalLink(target)) {
      links.push(parseLinkTarget(target));
    }
  }

  return links;
}

function isCandidateLocalLink(target) {
  if (!target || target.startsWith('#')) return false;
  if (/^(https?:|mailto:|chrome:|edge:|file:|vscode:|codex:)/i.test(target)) return false;
  return true;
}

function parseLinkTarget(target) {
  const hashIdx = target.indexOf('#');
  const pathPart = hashIdx !== -1 ? target.substring(0, hashIdx) : target;
  const hashPart = hashIdx !== -1 ? target.substring(hashIdx) : '';
  return { raw: target, pathPart, hashPart };
}

/**
 * Checks if target file exists relative to source file directory or repo root.
 */
export function resolveLocalLink(sourceFilePath, linkPath, repoRoot) {
  const ignoredConfigTargets = [
    'browserpaw.local.json',
    'claude_desktop_config.json',
    '.cursor/mcp.json',
    '.env',
  ];
  const basename = path.basename(linkPath);
  if (ignoredConfigTargets.includes(basename)) {
    return { exists: true, isIgnoredConfig: true };
  }

  if (linkPath.includes('.artifacts/') || linkPath.includes('.artifacts\\')) {
    return { exists: false, isArtifactLeak: true };
  }

  const sourceDir = path.dirname(sourceFilePath);
  const resolved = path.resolve(sourceDir, linkPath);
  const relativeTarget = path.relative(repoRoot, resolved);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    return { exists: false, resolvedPath: resolved };
  }

  if (fs.existsSync(resolved)) {
    return { exists: true, resolvedPath: resolved };
  }

  return { exists: false, resolvedPath: resolved };
}

/**
 * Verifies version consistency across package manifests.
 */
export function checkPackageVersions(repoRoot) {
  const results = { matched: true, versions: {}, errors: [] };
  const manifests = [
    { name: 'root', file: 'package.json' },
    { name: 'native-server', file: 'app/native-server/package.json' },
    { name: 'shared', file: 'packages/shared/package.json' },
    { name: 'chrome-extension', file: 'app/chrome-extension/package.json' },
    { name: 'codex-plugin', file: 'plugins/browserpaw/.codex-plugin/plugin.json' },
    { name: 'claude-plugin', file: 'plugins/browserpaw-claude/.claude-plugin/plugin.json' },
  ];

  let canonicalVersion = null;
  for (const m of manifests) {
    const fullPath = path.join(repoRoot, m.file);
    if (!fs.existsSync(fullPath)) {
      results.errors.push(`Manifest missing: ${m.file}`);
      results.matched = false;
      continue;
    }
    try {
      const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const ver = json.version;
      results.versions[m.name] = ver;
      if (!canonicalVersion) {
        canonicalVersion = ver;
      } else if (canonicalVersion !== ver) {
        results.matched = false;
        results.errors.push(
          `Version mismatch in ${m.file}: ${ver} != canonical ${canonicalVersion}`,
        );
      }
    } catch (err) {
      results.matched = false;
      results.errors.push(`Failed to parse ${m.file}: ${err.message}`);
    }
  }

  results.canonicalVersion = canonicalVersion;
  return results;
}

/**
 * Checks that git tags have corresponding release files.
 */
export function checkTagReleaseRecords(repoRoot) {
  const results = { valid: true, missingRecords: [], tagCount: 0, error: null };
  let tags = [];
  try {
    tags = execSync('git tag -l', { cwd: repoRoot, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (err) {
    results.valid = false;
    results.error = `git tag query failed: ${err.message}`;
    return results;
  }

  results.tagCount = tags.length;
  if (tags.length === 0) {
    return results;
  }

  const releasesDir = path.join(repoRoot, 'docs', 'releases');
  for (const tag of tags) {
    const recordFile = path.join(releasesDir, `${tag}.md`);
    if (!fs.existsSync(recordFile)) {
      results.valid = false;
      results.missingRecords.push(tag);
    }
  }

  return results;
}

/**
 * Checks docs/README.md index coverage for canonical active documentation.
 */
export function checkDocsIndexCoverage(repoRoot) {
  const indexFile = path.join(repoRoot, 'docs', 'README.md');
  const results = { valid: true, missingEntries: [] };
  if (!fs.existsSync(indexFile)) {
    return { valid: false, missingEntries: ['docs/README.md missing'] };
  }

  const content = fs.readFileSync(indexFile, 'utf8');
  const requiredEntries = [
    'QUALITY.md',
    'DOCUMENTATION.md',
    'ARCHITECTURE.md',
    'MAP.md',
    'TOOLS.md',
    'TROUBLESHOOTING.md',
    'CONTRIBUTING.md',
    'releases/README.md',
  ];

  for (const entry of requiredEntries) {
    if (!content.includes(entry)) {
      results.valid = false;
      results.missingEntries.push(entry);
    }
  }

  return results;
}

/**
 * Discovers markdown files tracked or untracked in git.
 */
export function getActiveMarkdownFiles(repoRoot) {
  let tracked = [];
  try {
    const raw = execSync('git ls-files -z --cached --others --exclude-standard', {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    tracked = raw.split('\0').filter((f) => /\.md$/i.test(f));
  } catch (err) {
    throw new Error(`Failed to discover repository markdown files: ${err.message}`);
  }

  const uniqueFiles = Array.from(new Set(tracked));
  return uniqueFiles.filter((file) => {
    const normalized = file.replace(/\\/g, '/');
    if (normalized.startsWith('docs/archive/') && !normalized.endsWith('README.md')) {
      return false;
    }
    if (normalized.startsWith('research/')) {
      return false;
    }
    return true;
  });
}

/**
 * Checks markdown file text integrity (illegal control characters, literal escaped newlines, and unexpected CJK in English docs).
 */
export function checkTextIntegrity(relPath, content) {
  const issues = [];
  let hasIllegalControlChars = false;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      hasIllegalControlChars = true;
      break;
    }
  }
  if (hasIllegalControlChars) {
    issues.push('Contains illegal ASCII control characters');
  }

  const realLines = content.split(/\r?\n/).length;
  const literalSlashNCount = content.split('\\n').length - 1;
  if (literalSlashNCount > 5 && realLines < 10) {
    issues.push('Unexpanded literal newline escapes detected');
  }

  const normalized = relPath.replace(/\\/g, '/');
  const isEnDoc =
    !normalized.endsWith('.zh-CN.md') &&
    !normalized.startsWith('docs/archive/') &&
    !normalized.startsWith('research/') &&
    !normalized.startsWith('.agents/');

  if (isEnDoc) {
    const stripped = stripCodeBlocks(content);
    if (/[\u4e00-\u9fff]/.test(stripped)) {
      issues.push('Unexpected Chinese characters in canonical English documentation');
    }
  }

  return issues;
}

/**
 * Full documentation audit runner.
 */
export function validateDocs(repoRoot) {
  const root = repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = {
    valid: true,
    brokenLinks: [],
    textIssues: [],
    packageVersionResult: null,
    tagRecordsResult: null,
    indexCoverageResult: null,
    totalFilesChecked: 0,
    totalLinksChecked: 0,
  };

  report.packageVersionResult = checkPackageVersions(root);
  if (!report.packageVersionResult.matched) {
    report.valid = false;
  }

  const currentVer = report.packageVersionResult.canonicalVersion;
  if (currentVer) {
    const verFile = path.join(root, 'docs', 'releases', `v${currentVer}.md`);
    if (!fs.existsSync(verFile)) {
      report.valid = false;
      report.brokenLinks.push({
        source: 'package.json',
        link: `docs/releases/v${currentVer}.md`,
        reason: `Missing version record for active package version ${currentVer}`,
      });
    }
  }

  report.tagRecordsResult = checkTagReleaseRecords(root);
  if (!report.tagRecordsResult.valid) {
    report.valid = false;
  }

  report.indexCoverageResult = checkDocsIndexCoverage(root);
  if (!report.indexCoverageResult.valid) {
    report.valid = false;
  }

  const activeFiles = getActiveMarkdownFiles(root);
  report.totalFilesChecked = activeFiles.length;

  for (const relFile of activeFiles) {
    const fullPath = path.join(root, relFile);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');

    const textProblems = checkTextIntegrity(relFile, content);
    for (const prob of textProblems) {
      report.valid = false;
      report.textIssues.push({ source: relFile, issue: prob });
    }

    const links = extractLocalLinks(content);
    report.totalLinksChecked += links.length;

    for (const item of links) {
      if (!item.pathPart) continue;
      const res = resolveLocalLink(fullPath, item.pathPart, root);
      if (!res.exists) {
        report.valid = false;
        report.brokenLinks.push({
          source: relFile,
          link: item.raw,
          resolvedTarget: res.resolvedPath,
          reason: res.isArtifactLeak ? 'Ephemeral artifact leak' : 'Target file does not exist',
        });
      }
    }
  }

  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  if (process.argv.length > 2) {
    console.error('❌ Error: validate-docs does not accept extra arguments.');
    process.exit(1);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log('🔍 Running BrowserPaw Documentation Governance Validator...');
  const report = validateDocs(repoRoot);

  console.log(`📦 Active markdown files scanned: ${report.totalFilesChecked}`);
  console.log(`🔗 Local links verified: ${report.totalLinksChecked}`);
  console.log(`🏷️  Local git tags verified: ${report.tagRecordsResult?.tagCount || 0}`);
  console.log(
    `🔢 Package version consistency: ${report.packageVersionResult?.matched ? '✅ PASS (' + report.packageVersionResult.canonicalVersion + ')' : '❌ FAIL'}`,
  );
  console.log(
    `📑 Docs index coverage: ${report.indexCoverageResult?.valid ? '✅ PASS' : '❌ FAIL'}`,
  );

  if (report.brokenLinks.length > 0) {
    console.error('\n❌ Broken Links Found:');
    for (const err of report.brokenLinks) {
      console.error(`   - [${err.source}] -> "${err.link}" (${err.reason})`);
    }
  }

  if (report.textIssues.length > 0) {
    console.error('\n❌ Text Integrity Issues Found:');
    for (const err of report.textIssues) {
      console.error(`   - [${err.source}] ${err.issue}`);
    }
  }

  if (report.packageVersionResult?.errors?.length > 0) {
    console.error('\n❌ Package Version Errors:');
    for (const err of report.packageVersionResult.errors) {
      console.error(`   - ${err}`);
    }
  }

  if (report.tagRecordsResult?.missingRecords?.length > 0) {
    console.error('\n❌ Missing Tag Release Records:');
    for (const tag of report.tagRecordsResult.missingRecords) {
      console.error(`   - ${tag} (missing docs/releases/${tag}.md)`);
    }
  }

  if (!report.valid) {
    console.error('\n❌ Documentation validation failed.');
    process.exit(1);
  } else {
    console.log('\n✅ All documentation governance gates passed.');
  }
}
