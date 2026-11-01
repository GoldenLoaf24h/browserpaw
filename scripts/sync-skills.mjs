import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const canonicalDir = 'skills/browserpaw';
const hermesTemplateDir = 'plugins/browserpaw-hermes/skill-template';
const targets = {
  portable: 'plugins/browserpaw/skills/browserpaw',
  claude: 'plugins/browserpaw-claude/skills/browserpaw',
  dsh: 'plugins/browserpaw-dsh/skills/browserpaw',
  hermes: 'plugins/browserpaw-hermes/skills/browserpaw',
};

const clientLeak = /\b(?:Hermes|Claude|Codex|ChatGPT|DSH)\b|mcp__|\.codex-plugin|mcp-skills/;
const aliasLeak = /\bbrowserpaw_[a-z]/;
const excludedNames = new Set(['AGENTS.md', 'HERMES_PLUGIN_SKILL.md']);
const textExtensions = new Set([
  '.md',
  '.json',
  '.mjs',
  '.js',
  '.cjs',
  '.ps1',
  '.bat',
  '.txt',
  '.yml',
  '.yaml',
]);

function normalize(root, relativePath) {
  return path.resolve(root, relativePath);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNoLinks(root, target) {
  let current = path.resolve(target);
  while (inside(root, current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Symlink or junction forbidden: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readTree(root, target, { includeExcluded = false } = {}) {
  const absolute = normalize(root, target);
  if (!inside(root, absolute)) throw new Error(`Path escapes repository: ${target}`);
  assertNoLinks(root, absolute);
  const files = new Map();
  if (!fs.existsSync(absolute)) return files;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!includeExcluded && excludedNames.has(entry.name)) continue;
      assertNoLinks(root, full);
      const relative = path.relative(absolute, full).replaceAll(path.sep, '/');
      if (entry.isDirectory()) {
        files.set(relative, null);
        walk(full);
      } else if (entry.isFile()) {
        files.set(relative, fs.readFileSync(full));
      } else {
        throw new Error(`Unsupported file type: ${full}`);
      }
    }
  };
  walk(absolute);
  return files;
}

function excludedFiles(root, target) {
  const absolute = normalize(root, target);
  if (!inside(root, absolute)) throw new Error(`Path escapes repository: ${target}`);
  assertNoLinks(root, absolute);
  const files = [];
  if (!fs.existsSync(absolute)) return files;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      assertNoLinks(root, full);
      const relative = path.relative(absolute, full).replaceAll(path.sep, '/');
      if (excludedNames.has(entry.name)) files.push(relative);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(absolute);
  return files;
}

function compareTrees(expected, actual) {
  const problems = [];
  for (const file of actual.keys()) {
    if (!expected.has(file)) {
      problems.push(`Orphan: ${file}`);
    } else if ((actual.get(file) === null) !== (expected.get(file) === null)) {
      problems.push(`File type mismatch: ${file}`);
    }
  }
  for (const [file, content] of expected) {
    if (!actual.has(file)) {
      problems.push(`Missing: ${file}`);
    } else if (content !== null) {
      const installed = actual.get(file);
      if (!Buffer.isBuffer(installed) || !content.equals(installed)) {
        problems.push(`Content drift: ${file}`);
      }
    }
  }
  return problems;
}

function frontmatter(text) {
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? '';
}

function assertCanonical(root) {
  const skillPath = path.join(root, canonicalDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) throw new Error('Canonical skills/browserpaw/SKILL.md is missing');
  if (!/^name:\s*browserpaw\s*$/m.test(frontmatter(fs.readFileSync(skillPath, 'utf8')))) {
    throw new Error('Canonical SKILL.md frontmatter must declare name: browserpaw');
  }
  for (const name of ['references', 'scripts', 'assets/recipes']) {
    const full = path.join(root, canonicalDir, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      throw new Error(`Canonical directory missing: ${name}`);
    }
  }

  const tree = readTree(root, canonicalDir);
  const forbidden = excludedFiles(root, canonicalDir);
  if (forbidden.length) {
    throw new Error(`Canonical development file must be removed: ${forbidden[0]}`);
  }
  for (const [file, content] of tree) {
    if (content === null) continue;
    if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
    const text = content.toString('utf8');
    if (clientLeak.test(text)) throw new Error(`Canonical client-specific leak: ${file}`);
    if (aliasLeak.test(text)) throw new Error(`Canonical unavailable alias leak: ${file}`);
  }

  for (const [file, content] of tree) {
    if (content === null || path.extname(file).toLowerCase() !== '.md') continue;
    const base = path.join(root, canonicalDir);
    const text = content.toString('utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1];
      if (/^(?:https?:|mailto:|#|\/)/i.test(link)) continue;
      const destination = path.resolve(path.dirname(path.join(base, file)), link.split('#')[0]);
      if (!inside(base, destination) || !fs.existsSync(destination)) {
        throw new Error(`Broken canonical reference: ${file} -> ${link}`);
      }
    }
  }
}

function assertPackageIdentity(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  for (const manifest of [
    'plugins/browserpaw/plugin.json',
    'plugins/browserpaw-claude/.claude-plugin/plugin.json',
  ]) {
    const actual = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8')).version;
    if (actual !== version)
      throw new Error(`${manifest} version ${actual} does not match ${version}`);
  }
  const yaml = fs.readFileSync(path.join(root, 'plugins/browserpaw-hermes/plugin.yaml'), 'utf8');
  const hermesVersion = yaml.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1];
  if (hermesVersion !== version) {
    throw new Error(`Hermes plugin version ${hermesVersion} does not match ${version}`);
  }

  const provides = [...yaml.matchAll(/^\s*-\s*(browserpaw_[a-z0-9_]+)\s*$/gm)].map((m) => m[1]);
  const init = fs.readFileSync(path.join(root, 'plugins/browserpaw-hermes/__init__.py'), 'utf8');
  const definitions = [...init.matchAll(/^\s*["'](browserpaw_[a-z0-9_]+)["']\s*:/gm)].map(
    (m) => m[1],
  );
  const expectedTools = [...new Set(provides)].sort();
  const definedTools = [...new Set(definitions)].sort();
  if (expectedTools.length === 0) {
    throw new Error('Hermes plugin.yaml must declare at least one browserpaw_* wrapper');
  }
  if (JSON.stringify(expectedTools) !== JSON.stringify(definedTools)) {
    throw new Error('Hermes provides_tools does not match browserpaw_* definitions');
  }
  return { version, hermesTools: expectedTools };
}

export function syncSkills(root = repoRoot, { check = false } = {}) {
  const absoluteRoot = path.resolve(root);
  assertCanonical(absoluteRoot);
  const identity = assertPackageIdentity(absoluteRoot);
  const canonicalTree = readTree(absoluteRoot, canonicalDir);
  const hermesTree = readTree(absoluteRoot, hermesTemplateDir);
  const hermesForbidden = excludedFiles(absoluteRoot, hermesTemplateDir);
  if (hermesForbidden.length) {
    throw new Error(`Hermes skill development file must be removed: ${hermesForbidden[0]}`);
  }
  const hermesSkill = hermesTree.get('SKILL.md');
  if (!Buffer.isBuffer(hermesSkill)) {
    throw new Error('Hermes skill template SKILL.md is missing');
  }
  for (const [file, content] of hermesTree) {
    if (content !== null && textExtensions.has(path.extname(file).toLowerCase())) {
      if (/chrome_/.test(content.toString('utf8'))) {
        throw new Error(`Hermes skill must use browserpaw_* wrapper names only: ${file}`);
      }
    }
  }
  const expected = {
    portable: canonicalTree,
    claude: canonicalTree,
    dsh: canonicalTree,
    hermes: hermesTree,
    native: canonicalTree,
  };
  const nativeTarget = 'app/native-server/dist/skill/browserpaw';
  assertNoLinks(absoluteRoot, path.join(absoluteRoot, nativeTarget));
  const activeTargets = { ...targets };
  if (fs.existsSync(path.join(absoluteRoot, 'app/native-server/dist'))) {
    activeTargets.native = nativeTarget;
  }

  const collectProblems = () =>
    Object.entries(activeTargets).flatMap(([name, target]) =>
      [
        ...excludedFiles(absoluteRoot, target).map((file) => `Excluded: ${file}`),
        ...compareTrees(expected[name], readTree(absoluteRoot, target, { includeExcluded: true })),
      ].map((problem) => `${name}: ${problem}`),
    );

  const initialProblems = collectProblems();
  if (check || initialProblems.length === 0) {
    return { problems: initialProblems, identity };
  }

  for (const [name, target] of Object.entries(activeTargets)) {
    const targetPath = normalize(absoluteRoot, target);
    assertNoLinks(absoluteRoot, targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.mkdirSync(targetPath, { recursive: true });
    for (const [file, content] of expected[name]) {
      const destination = path.join(targetPath, file);
      if (content === null) {
        fs.mkdirSync(destination, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
      }
    }
  }
  return { problems: collectProblems(), identity };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/sync-skills.mjs [--check]');
  }
  const { problems } = syncSkills(repoRoot, { check: args[0] === '--check' });
  if (problems.length) {
    console.error(`${problems.join('\n')}\nRun node scripts/sync-skills.mjs to update mirrors.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    args[0] === '--check' ? 'Skill mirrors are synchronized.' : 'Skill synchronization completed.',
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
