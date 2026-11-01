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
