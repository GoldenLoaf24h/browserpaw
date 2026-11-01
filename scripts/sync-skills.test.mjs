import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSkills } from './sync-skills.mjs';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tools(count = 18) {
  return Array.from({ length: count }, (_, index) => `browserpaw_tool_${index + 1}`);
}

function fixture({ toolCount = 18 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-sync-'));
  write(
    path.join(root, 'skills/browserpaw/SKILL.md'),
    '---\nname: browserpaw\ndescription: neutral skill\n---\n\n# BrowserPaw\n\n[Tools](references/tools.md)\n',
  );
  write(path.join(root, 'skills/browserpaw/references/tools.md'), '# Tools\n\nchrome_navigate\n');
  write(path.join(root, 'skills/browserpaw/scripts/doctor.mjs'), 'console.log("ok");\n');
  write(path.join(root, 'skills/browserpaw/assets/recipes/example.json'), '{"id":"x"}\n');
  write(
    path.join(root, 'plugins/browserpaw-hermes/skill-template/SKILL.md'),
    '---\nname: browserpaw\ndescription: wrapper skill\n---\n\nbrowserpaw_navigate\n',
  );
  write(
    path.join(root, 'plugins/browserpaw-hermes/skill-template/references/tool-matrix.md'),
    '# Wrapper tools\n\nbrowserpaw_navigate\n',
  );
  const names = tools(toolCount);
  write(
    path.join(root, 'plugins/browserpaw-hermes/plugin.yaml'),
    `manifest_version: 1\nname: browserpaw\nversion: '4.0.0'\nprovides_tools:\n${names.map((name) => `  - ${name}`).join('\n')}\n`,
  );
  write(
    path.join(root, 'plugins/browserpaw-hermes/__init__.py'),
    names.map((name) => `    "${name}": {},`).join('\n'),
  );
  write(path.join(root, 'package.json'), '{"version":"4.0.0"}\n');
  write(path.join(root, 'plugins/browserpaw/plugin.json'), '{"version":"4.0.0"}\n');
  write(
    path.join(root, 'plugins/browserpaw-claude/.claude-plugin/plugin.json'),
    '{"version":"4.0.0"}\n',
  );
  return root;
}

const root = fixture();
try {
  assert.deepEqual(syncSkills(root).problems, []);
  for (const target of [
    'plugins/browserpaw/skills/browserpaw',
    'plugins/browserpaw-claude/skills/browserpaw',
    'plugins/browserpaw-dsh/skills/browserpaw',
  ]) {
    assert.equal(
      fs.readFileSync(path.join(root, target, 'SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(root, 'skills/browserpaw/SKILL.md'), 'utf8'),
    );
    assert.equal(fs.existsSync(path.join(root, target, 'assets/recipes/example.json')), true);
  }
  assert.equal(
    fs.readFileSync(
      path.join(root, 'plugins/browserpaw-hermes/skills/browserpaw/SKILL.md'),
      'utf8',
    ),
    fs.readFileSync(path.join(root, 'plugins/browserpaw-hermes/skill-template/SKILL.md'), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(
      path.join(root, 'plugins/browserpaw-hermes/skills/browserpaw/references/tool-matrix.md'),
      'utf8',
    ),
    '# Wrapper tools\n\nbrowserpaw_navigate\n',
  );
  assert.deepEqual(syncSkills(root, { check: true }).problems, []);

  const nativeSkill = path.join(root, 'app/native-server/dist/skill/browserpaw');
  fs.mkdirSync(path.dirname(path.dirname(nativeSkill)), { recursive: true });
  syncSkills(root);
  assert.equal(fs.existsSync(path.join(nativeSkill, 'SKILL.md')), true);
  fs.appendFileSync(path.join(nativeSkill, 'SKILL.md'), 'drift\n');
  write(path.join(nativeSkill, 'orphan.md'), 'orphan\n');
  assert.match(syncSkills(root, { check: true }).problems.join('\n'), /native: Content drift/);
  assert.match(syncSkills(root, { check: true }).problems.join('\n'), /native: Orphan/);
  assert.deepEqual(syncSkills(root).problems, []);
  fs.rmSync(nativeSkill, { recursive: true, force: true });
  assert.match(
    syncSkills(root, { check: true }).problems.join('\n'),
    /native: Missing: SKILL\.md/,
  );
  assert.deepEqual(syncSkills(root).problems, []);

  const portableSkill = path.join(root, 'plugins/browserpaw/skills/browserpaw/SKILL.md');
  fs.appendFileSync(portableSkill, 'drift\n');
  assert.match(syncSkills(root, { check: true }).problems.join('\n'), /Content drift: SKILL\.md/);
  write(path.join(root, 'plugins/browserpaw/skills/browserpaw/retired/orphan.md'), 'orphan\n');
  assert.match(syncSkills(root, { check: true }).problems.join('\n'), /Orphan: retired\/orphan\.md/);
  write(path.join(root, 'plugins/browserpaw/skills/browserpaw/AGENTS.md'), 'internal\n');
  assert.match(syncSkills(root, { check: true }).problems.join('\n'), /Excluded: AGENTS\.md/);
  fs.appendFileSync(
    path.join(root, 'plugins/browserpaw-hermes/skills/browserpaw/references/tool-matrix.md'),
    'drift\n',
  );
  assert.match(
    syncSkills(root, { check: true }).problems.join('\n'),
    /hermes: Content drift: references\/tool-matrix\.md/,
  );
  fs.rmSync(path.join(root, 'plugins/browserpaw-claude/skills/browserpaw/scripts'), {
    recursive: true,
  });
  assert.match(syncSkills(root, { check: true }).problems.join('\n'), /Missing: scripts/);
  assert.deepEqual(syncSkills(root).problems, []);

  fs.appendFileSync(path.join(root, 'skills/browserpaw/references/tools.md'), 'Claude install\n');
  assert.throws(() => syncSkills(root, { check: true }), /client-specific leak/);
  fs.writeFileSync(
    path.join(root, 'skills/browserpaw/references/tools.md'),
    '# Tools\n\nchrome_navigate\nbrowserpaw_navigate\n',
  );
  assert.throws(() => syncSkills(root, { check: true }), /unavailable alias leak/);
  fs.writeFileSync(
    path.join(root, 'skills/browserpaw/references/tools.md'),
    '# Tools\n\nchrome_navigate\n',
  );

  fs.writeFileSync(
    path.join(root, 'skills/browserpaw/SKILL.md'),
    '---\nname: browserpaw\n---\n\n[Missing](references/missing.md)\n',
  );
  assert.throws(() => syncSkills(root, { check: true }), /Broken canonical reference/);

  const badVersionRoot = fixture();
  try {
    fs.writeFileSync(
      path.join(badVersionRoot, 'plugins/browserpaw/plugin.json'),
      '{"version":"3.0.0"}\n',
    );
    assert.throws(() => syncSkills(badVersionRoot, { check: true }), /does not match 4\.0\.0/);
  } finally {
    fs.rmSync(badVersionRoot, { recursive: true, force: true });
  }

  const badToolsRoot = fixture({ toolCount: 17 });
  try {
    const names = tools(16);
    write(
      path.join(badToolsRoot, 'plugins/browserpaw-hermes/plugin.yaml'),
      `manifest_version: 1\nname: browserpaw\nversion: '4.0.0'\nprovides_tools:\n${names.map((name) => `  - ${name}`).join('\n')}\n`,
    );
    assert.throws(() => syncSkills(badToolsRoot, { check: true }), /does not match browserpaw_\* definitions/);
  } finally {
    fs.rmSync(badToolsRoot, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const linkRoot = fixture();
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-outside-'));
try {
  write(path.join(outside, 'sentinel.txt'), 'untouched\n');
  const target = path.join(linkRoot, 'plugins/browserpaw/skills/browserpaw');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    console.log('[SKIP] target junction test requires platform link privileges');
  }
  if (fs.existsSync(target)) {
    assert.throws(() => syncSkills(linkRoot, { check: true }), /Symlink or junction forbidden/);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'untouched\n');
  }
} finally {
  fs.rmSync(linkRoot, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

const brokenLinkRoot = fixture();
try {
  const target = path.join(brokenLinkRoot, 'plugins/browserpaw/skills/browserpaw');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.symlinkSync(path.join(brokenLinkRoot, 'missing-target'), target, 'dir');
    assert.throws(() => syncSkills(brokenLinkRoot, { check: true }), /Symlink or junction forbidden/);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      console.log('[SKIP] broken symlink test requires platform link privileges');
    } else {
      throw error;
    }
  }
} finally {
  fs.rmSync(brokenLinkRoot, { recursive: true, force: true });
}

console.log('Skill synchronization regression passed.');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.deepEqual(syncSkills(repoRoot, { check: true }).problems, []);
console.log('Repository skill mirrors are synchronized.');
