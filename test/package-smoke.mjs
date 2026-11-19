import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('app/native-server');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'browserpaw');
assert.deepEqual(Object.keys(manifest.bin), ['browserpaw']);
assert.deepEqual(manifest.dependencies ?? {}, {});
assert.equal(manifest.scripts.postinstall, undefined);
execFileSync(process.execPath, [join(root, 'scripts/pack-assets.cjs')]);
const sandbox = mkdtempSync(join(tmpdir(), 'browserpaw-package-'));
try {
  const dist = join(sandbox, 'v5');
  cpSync(join(root, 'dist/v5'), dist, { recursive: true });
  const execute = (...args) =>
    execFileSync(process.execPath, [join(dist, 'cli.cjs'), ...args], {
      encoding: 'utf8',
      cwd: sandbox,
      timeout: 5000,
    });
  assert.equal(execute('--version').trim(), manifest.version);
  assert.match(execute('help'), /task start.*observe/);
  assert.match(execute('help', 'network', 'show'), /captured network events/);
  const extension = JSON.parse(readFileSync(join(dist, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(extension.version, manifest.version);
  assert.match(readFileSync(join(dist, 'skill/browserpaw/SKILL.md'), 'utf8'), /browserpaw status/);
  for (const file of ['host.cjs', 'run_host.bat', 'run_host.sh', 'recipes/mdn-search.json'])
    assert.ok(readFileSync(join(dist, file)).length > 0);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
