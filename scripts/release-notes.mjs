#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, '..');
export const releasesDir = path.join(repoRoot, 'docs', 'releases');
export const templateFile = path.join(releasesDir, 'TEMPLATE.md');
export const releasingFile = path.join(releasesDir, 'RELEASING.md');
export const HISTORICAL_RELEASES = Object.freeze(
  new Set([
    'v2.0.0.md',
    'v2.1.0.md',
    'v2.2.0.md',
    'v2.2.1.md',
    'v2.3.0.md',
    'v2.3.7.md',
    'v2.3.8.md',
    'v2.3.9.md',
    'v2.4.0.md',
    'v2.4.1.md',
    'v2.4.2.md',
    'v2.5.0.md',
    'v2.5.1.md',
    'v2.5.2.md',
    'v2.6.0.md',
    'v2.6.1.md',
    'v2.6.2.md',
    'v2.7.0.md',
    'v2.7.1.md',
    'v2.8.0.md',
    'v2.8.1.md',
    'v2.8.2.md',
    'v2.8.3.md',
    'v2.9.0.md',
    'v2.9.1.md',
    'v2.9.2.md',
    'v2.9.3.md',
    'v3.0.0.md',
    'v3.1.0.md',
    'v3.2.0.md',
    'v3.2.7.md',
    'v3.3.0.md',
    'v4.0.0.md',
    'v4.1.0.md',
    'v4.1.1.md',
    'v4.1.2.md',
  ]),
);

export const REQUIRED_SECTIONS = Object.freeze([
  { name: '## Overview' },
  { name: '## Changes' },
  { name: '## Upgrade & Compatibility' },
  { name: '## Verification Scope' },
  { name: '## Release Assets' },
  { name: '## Diff & Commits' },
]);

export const REQUIRED_STABLE_ASSETS = Object.freeze(['browserpaw-skill.zip']);
export const OPTIONAL_STABLE_ASSETS = Object.freeze(['browserpaw-extension.zip']);
export const STABLE_ASSETS = Object.freeze([...OPTIONAL_STABLE_ASSETS, ...REQUIRED_STABLE_ASSETS]);

const PLACEHOLDER_PATTERNS = Object.freeze([
  /<[^>\r\n]+>/,
  /\b(?:TODO|TBD|FIXME)\b/i,
  /\[(?:REPLACE|INSERT)[^\]]*\]/i,
]);

function inspectSections(content, errors) {
  const prose = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const headings = [...prose.matchAll(/^## [^\r\n]+/gm)];
  if (
    headings.map((heading) => heading[0]).join('|') !==
    REQUIRED_SECTIONS.map((section) => section.name).join('|')
  ) {
    errors.push('Required sections must appear exactly once, in template order');
  }
  const bodies = new Map();
  for (const [index, heading] of headings.entries()) {
    const body = prose.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim();
    bodies.set(heading[0], body);
    if (!body.replace(/^### .*$/gm, '').trim()) errors.push(`Empty section: ${heading[0]}`);
  }
  return bodies;
}

/**
 * Validates TEMPLATE.md structure.
 * Placeholders are explicitly permitted in TEMPLATE.md.
 */
export function validateTemplate(filePath = templateFile) {
  const errors = [];
  if (!fs.existsSync(filePath)) {
    return { valid: false, errors: [`Template file not found: ${filePath}`] };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (content.split(/\r?\n/)[0] !== '# BrowserPaw v<VERSION>') {
    errors.push('Template title must start with "# BrowserPaw v<VERSION>"');
  }
  const requiredMetadata = ['Tag:', 'Target:', 'Date:'];
  for (const meta of requiredMetadata) {
    if (!new RegExp(`\\*\\*${meta}\\*\\*`, 'i').test(content)) {
      errors.push(`Template missing metadata field: **${meta}**`);
    }
  }
  const bodies = inspectSections(content, errors);
  for (const section of REQUIRED_SECTIONS) {
    if (!bodies.has(section.name)) {
      errors.push(`Template missing required section: ${section.name}`);
    }
  }
  for (const asset of STABLE_ASSETS) {
    if (!bodies.get('## Release Assets')?.includes(asset)) {
      errors.push(`Template missing stable asset mention: "${asset}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates an actual release note file (vX.Y.Z.md).
 * Disallows unexpanded placeholders and enforces full section and asset requirements.
 */
export function validateReleaseNote(content, filename = 'release-note.md') {
  const errors = [];
  const titleMatch = content
    .split(/\r?\n/)[0]
    .match(/^# BrowserPaw (v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  if (!titleMatch) {
    errors.push(`${filename}: Title must match "# BrowserPaw vX.Y.Z"`);
  }
  if (titleMatch && filename !== `${titleMatch[1]}.md`)
    errors.push('Title version must match filename');
  const tag = content.match(/^- \*\*Tag:\*\* (v[^\s]+)\r?$/m)?.[1];
  if (titleMatch && tag !== titleMatch[1]) errors.push('Tag must match title version');
  const date = content.match(/^- \*\*Date:\*\* (\d{4}-\d{2}-\d{2})\r?$/m)?.[1];
  if (
    date &&
    (!Number.isFinite(Date.parse(date)) || !new Date(date).toISOString().startsWith(date))
  )
    errors.push('Invalid release date');
  const requiredMetadata = [
    { label: 'Tag', pattern: /^- \*\*Tag:\*\* v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\r?$/m },
    { label: 'Target', pattern: /^- \*\*Target:\*\* \S+\r?$/m },
    { label: 'Date', pattern: /^- \*\*Date:\*\* \d{4}-\d{2}-\d{2}\r?$/m },
  ];
  for (const meta of requiredMetadata) {
    const header = content.split(/^## /m)[0];
    if (!meta.pattern.test(header)) {
      errors.push(`${filename}: Missing or malformed metadata: ${meta.label}`);
    }
    if (header.split(`- **${meta.label}:**`).length > 2)
      errors.push(`Duplicate metadata: ${meta.label}`);
  }
  const bodies = inspectSections(content, errors);
  for (const section of REQUIRED_SECTIONS) {
    if (!bodies.has(section.name)) {
      errors.push(`${filename}: Missing required section: ${section.name}`);
    }
  }
  const releaseAssetsBody = bodies.get('## Release Assets') || '';
  for (const asset of REQUIRED_STABLE_ASSETS) {
    if (!releaseAssetsBody.includes('`' + asset + '`')) {
      errors.push(`${filename}: Missing required stable asset: "${asset}"`);
    }
  }
  if (/\bbrowserpaw-(?:extension|skill)-v?\d/i.test(releaseAssetsBody)) {
    errors.push(
      `${filename}: Release assets must use stable filenames ("browserpaw-extension.zip", "browserpaw-skill.zip"), not versioned ZIP names`,
    );
  }
  const comparisons = [
    ...(bodies.get('## Diff & Commits') || '').matchAll(
      /https:\/\/github\.com\/GoldenLoaf24h\/browserpaw\/compare\/(v[\w.-]+)\.\.\.(v[\w.-]+)(?=[\s)]|$)/g,
    ),
  ];
  const hasCompareLink = comparisons.some((match) => match[1] !== tag && match[2] === tag);
  if (!hasCompareLink) {
    errors.push(`${filename}: Missing GitHub compare/commit link in Diff & Commits section`);
  }
  for (const label of [
    'Verification Gate',
    'Automated Tests',
    'CI Status',
    'Loaded Runtime Checks',
    'Boundaries & Exclusions',
  ]) {
    const prefix = `- **${label}:** `;
    const line = bodies
      .get('## Verification Scope')
      ?.split(/\r?\n/)
      .find((entry) => entry.startsWith(prefix));
    if (!line?.slice(prefix.length).trim()) errors.push(`Missing verification field: ${label}`);
  }
  for (const placeholder of PLACEHOLDER_PATTERNS) {
    const match = content.match(placeholder);
    if (match) {
      errors.push(`${filename}: Contains unresolved placeholder: "${match[0]}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Finds all release notes and splits into historical vs new.
 */
export function getReleaseFiles(targetDir = releasesDir) {
  if (!fs.existsSync(targetDir)) return [];
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^v.*\.md$/.test(entry.name))
    .map((e) => ({
      filename: e.name,
      fullPath: path.join(targetDir, e.name),
      isHistorical: HISTORICAL_RELEASES.has(e.name),
    }));
}

/**
 * Main check routine.
 */
export function runCheck(options = {}) {
  const root = options.repoRoot || repoRoot;
  const targetReleasesDir = options.releasesDir || path.join(root, 'docs', 'releases');
  const targetTemplate = options.templateFile || path.join(targetReleasesDir, 'TEMPLATE.md');
  const targetReleasing = options.releasingFile || path.join(targetReleasesDir, 'RELEASING.md');
  const packageFile = path.join(root, 'package.json');
  const ledgerFile = path.join(targetReleasesDir, 'README.md');

  const report = {
    valid: true,
    templateValid: true,
    releasingDocExists: true,
    newReleasesChecked: 0,
    historicalReleasesSkipped: 0,
    errors: [],
  };
  let version;
  try {
    version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
  } catch (error) {
    report.valid = false;
    report.errors.push(`Unable to read root package version: ${error.message}`);
  }
  if (version) {
    const releaseFile = `v${version}.md`;
    if (!fs.existsSync(path.join(targetReleasesDir, releaseFile))) {
      report.valid = false;
      report.errors.push(`Root package version ${version} has no docs/releases/${releaseFile}`);
    }
    const ledger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '';
    const escapedReleaseFile = releaseFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ledgerLink = new RegExp(
      `\\[[^\\]\\r\\n]+\\]\\((?:<)?(?:\\./)?${escapedReleaseFile}(?:#[^)>\\s]+)?>?\\)`,
    );
    if (!ledgerLink.test(ledger)) {
      report.valid = false;
      report.errors.push(
        `docs/releases/README.md must link to ${releaseFile} for root package version ${version}`,
      );
    }
  }
  if (!fs.existsSync(targetReleasing)) {
    report.valid = false;
    report.releasingDocExists = false;
    report.errors.push(
      `Missing release governance document: ${path.relative(root, targetReleasing)}`,
    );
  }
  const templateResult = validateTemplate(targetTemplate);
  if (!templateResult.valid) {
    report.valid = false;
    report.templateValid = false;
    report.errors.push(...templateResult.errors);
  }
  if (options.file) {
    const targetPath = path.resolve(root, options.file);
    if (!fs.existsSync(targetPath)) {
      report.valid = false;
      report.errors.push(`Specified file does not exist: ${options.file}`);
    } else {
      const content = fs.readFileSync(targetPath, 'utf8');
      const noteResult = validateReleaseNote(content, path.basename(targetPath));
      if (!noteResult.valid) {
        report.valid = false;
        report.errors.push(...noteResult.errors);
      }
      report.newReleasesChecked = 1;
    }
    return report;
  }
  const releaseFiles = getReleaseFiles(targetReleasesDir);
  for (const item of releaseFiles) {
    if (item.isHistorical) {
      report.historicalReleasesSkipped += 1;
      continue;
    }
    const content = fs.readFileSync(item.fullPath, 'utf8');
    const noteResult = validateReleaseNote(content, item.filename);
    report.newReleasesChecked += 1;
    if (!noteResult.valid) {
      report.valid = false;
      report.errors.push(...noteResult.errors);
    }
  }

  return report;
}
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const args = process.argv.slice(2);
  if (
    args.length &&
    !(args.length === 2 && args[0] === '--file' && !args[1].startsWith('-')) &&
    !(args.length === 1 && args[0] === '--help')
  ) {
    console.error('Usage: node scripts/release-notes.mjs [--file <path>]');
    process.exit(1);
  }
  if (args[0] === '--help') {
    console.log('Usage: node scripts/release-notes.mjs [--file <path>]');
    process.exit(0);
  }
  const result = runCheck({ file: args[1] });
  if (result.valid) {
    console.log('✅ Release notes specification check passed:');
    console.log('   - docs/releases/RELEASING.md present');
    console.log('   - docs/releases/TEMPLATE.md valid');
    console.log('   - docs/releases/README.md links the root package version');
    if (result.newReleasesChecked > 0) {
      console.log(`   - Verified ${result.newReleasesChecked} new release note(s)`);
    } else {
      console.log(
        `   - No new release notes beyond historical baseline (${result.historicalReleasesSkipped} preserved)`,
      );
    }
    process.exit(0);
  } else {
    console.error('❌ Release notes specification check failed:');
    for (const err of result.errors) {
      console.error(`   - ${err}`);
    }
    process.exit(1);
  }
}
