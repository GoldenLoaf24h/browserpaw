import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('regeneration preserves manual development rules and remains idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-agents-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
    const target = path.join(root, 'AGENTS.md');
    const manual =
      '\nDo not overwrite production configuration.\n\n### Local rule\nKeep evidence.\n';
    fs.writeFileSync(target, '# Old index\r\n\r\n## Manual Notes\r\n' + manual);
    const generator = fileURLToPath(new URL('./generate-agents-docs.mjs', import.meta.url));
    const run = () => {
      const result = spawnSync(process.execPath, [generator, '.'], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return fs.readFileSync(target, 'utf8');
    };
    const first = run();
    assert(first.endsWith('## Manual Notes\n' + manual));
    assert.equal(run(), first);
    fs.unlinkSync(target);
    assert.match(run(), /## Manual Notes\n\nNotes under this heading/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool profile descriptions do not hardcode drifting schema counts', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('./generate-agents-docs.mjs', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /all 50 canonical tools|Core \(14\).*Full \(50\)|all 50 BrowserPaw tools/,
  );
});

test('AGENTS generation preserves manual rules and excludes archived and packaged records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-agents-'));
  try {
    const initialized = spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const excluded = [
      'research',
      'releases',
      'docs/archive',
      '.artifacts',
      'skills/browserpaw',
      'plugins/browserpaw',
    ];
    for (const relativePath of [...excluded, 'scratch']) {
      fs.mkdirSync(path.join(directory, relativePath), { recursive: true });
    }
    for (const relativePath of excluded) {
      fs.writeFileSync(
        path.join(directory, relativePath, 'AGENTS.md'),
        'Historical or packaged text.',
      );
    }
    fs.writeFileSync(
      path.join(directory, 'AGENTS.md'),
      '# Existing\n\n## Manual Notes\nKeep this task boundary.\n',
    );
    const generated = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./generate-agents-docs.mjs', import.meta.url))],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const content = fs.readFileSync(path.join(directory, 'AGENTS.md'), 'utf8');
    assert.match(content, /## Manual Notes\nKeep this task boundary\./);
    assert.ok(!content.includes('scratch/AGENTS.md'));
    for (const relativePath of excluded) {
      assert.equal(
        fs.readFileSync(path.join(directory, relativePath, 'AGENTS.md'), 'utf8'),
        'Historical or packaged text.',
      );
    }
    const validated = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./validate-agents-docs.mjs', import.meta.url))],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(validated.status, 0, validated.stdout + validated.stderr);
    assert.match(validated.stdout, /All 4 AGENTS.md files PASSED/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
