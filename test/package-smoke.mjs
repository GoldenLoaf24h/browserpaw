import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  const packDir = join(sandbox, 'pack');
  mkdirSync(packDir);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--json', '--pack-destination', packDir], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BROWSERPAW_EXTENSION_SYNC_DIR: '' },
    shell: process.platform === 'win32',
    timeout: 120000,
  });
  assert.equal(packed.status, 0, `npm pack failed:\n${packed.stdout}\n${packed.stderr}`);
  const packJson = JSON.parse(packed.stdout);
  const packInfo = Array.isArray(packJson) ? packJson[0] : packJson;
  const tarball = join(packDir, packInfo.filename);
  assert.ok(existsSync(tarball), `npm pack did not create ${tarball}`);

  const tarList = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', timeout: 30000 });
  assert.equal(tarList.status, 0, `tar listing failed:\n${tarList.stdout}\n${tarList.stderr}`);
  const entries = new Set(
    tarList.stdout
      .split(/\r?\n/)
      .filter((entry) => entry && !entry.endsWith('/'))
      .map((entry) => entry.replace(/^package\//, '')),
  );
  for (const file of [
    'LICENSE',
    'dist/v5/cli.cjs',
    'dist/v5/host.cjs',
    'dist/v5/cli-files.cjs',
    'dist/v5/run_host.sh',
    'dist/v5/run_host.bat',
    'dist/v5/extension/manifest.json',
    'dist/v5/skill/browserpaw/SKILL.md',
    'dist/v5/skill/browserpaw/references/commands.md',
    'dist/v5/recipes/developer.mozilla.org.md',
    'dist/v5/recipes/github-releases.json',
    'dist/v5/recipes/mdn-search.json',
    'dist/v5/recipes/npm-compare.json',
    'dist/v5/recipes/x-search-thread.json',
    'dist/v5/recipes/x-visible-thread.json',
  ]) {
    assert.ok(entries.has(file), `npm tarball is missing ${file}`);
  }
  for (const file of packInfo.files) {
    assert.ok(entries.has(file.path), `npm pack JSON lists ${file.path}, but the tarball does not`);
  }

  const extractDir = join(sandbox, 'extract');
  mkdirSync(extractDir);
  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', extractDir], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(
    extracted.status,
    0,
    `tar extraction failed:\n${extracted.stdout}\n${extracted.stderr}`,
  );
  const dist = join(extractDir, 'package', 'dist', 'v5');
  const cli = join(dist, 'cli.cjs');
  const work = join(sandbox, 'work');
  mkdirSync(work);
  const browserpawHome = join(sandbox, 'home');
  const env = {
    ...process.env,
    BROWSERPAW_HOME: browserpawHome,
    BROWSERPAW_NO_UPDATE_CHECK: '1',
    BROWSERPAW_TOOL_PREFIX: 'obsolete-prefix',
    CHROME_MCP_TOOL_PREFIX: 'obsolete-prefix',
  };
  const execute = (...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      cwd: work,
      env,
      timeout: 5000,
    });
  assert.equal(execute('--version').trim(), manifest.version);
  assert.match(execute('help'), /task start.*observe/);
  assert.match(execute('help', 'network', 'show'), /recorded ID/);
  assert.match(execute('search', 'network', 'response', 'body'), /browserpaw network show/);
  assert.equal(
    JSON.parse(execute('search', 'network', 'throttling', '--limit', '1', '--json')).data.items[0]
      .name,
    'emulate',
  );
  assert.match(execute('search', 'screenshot', '--', '--full'), /browserpaw screenshot/);
  const discovery = JSON.parse(execute('--json', 'search', '导出书签', '--limit', '1'));
  assert.equal(discovery.command, 'search');
  assert.equal(discovery.data.items.length, 1);
  assert.equal(discovery.data.items[0].name, 'bookmark export');
  assert.deepEqual(
    JSON.parse(execute('search', 'no-matching-command-xyz', '--json')).data.items,
    [],
  );
  assert.throws(
    () => execute('search', '--json'),
    (error) => error.status === 2 && JSON.parse(error.stdout).error.code === 'invalid_arguments',
  );
  const found = JSON.parse(execute('recipe', 'find', '推特搜索', '--all', '--json'));
  assert.equal(found.ok, true);
  assert.equal(found.data.matches[0].id, 'x-search-thread');
  const shown = JSON.parse(execute('recipe', 'show', 'x-search-thread', '--json'));
  assert.equal(shown.ok, true);
  assert.equal(shown.data.command, 'browserpaw recipe run x-search-thread query=<query>');
  const extension = JSON.parse(readFileSync(join(dist, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(extension.version, manifest.version);
  assert.match(readFileSync(join(dist, 'skill/browserpaw/SKILL.md'), 'utf8'), /browserpaw status/);
  for (const file of ['host.cjs', 'run_host.bat', 'run_host.sh', 'recipes/mdn-search.json'])
    assert.ok(readFileSync(join(dist, file)).length > 0);

  const setup = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          `const os = require('node:os'); os.homedir = () => process.cwd(); os.platform = () => 'linux'; require(process.argv[1]);`,
          cli,
          'setup',
          ...args,
          '--json',
        ],
        { encoding: 'utf8', cwd: work, env, timeout: 10000 },
      ),
    ).data;
  const first = setup('--browser', 'chromium', '--skill-scope', 'project');
  assert.equal(first.extensionPrepared, true);
  if (process.platform !== 'win32') {
    assert.notEqual(statSync(join(browserpawHome, 'host', 'run_host.sh')).mode & 0o111, 0);
  }
  const second = setup('--skill-dir', 'custom-skills');
  assert.notEqual(second.skillPath, first.skillPath);
  for (const skillPath of [first.skillPath, second.skillPath]) {
    const markerPath = join(skillPath, '.browserpaw-skill.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    writeFileSync(markerPath, JSON.stringify({ ...marker, version: '4.99.0' }));
    writeFileSync(join(skillPath, 'SKILL.md'), 'Older base Skill');
  }
  const extensionFile = join(first.extension, 'popup.html');
  writeFileSync(extensionFile, 'Manually installed extension');
  const upgrade = setup();
  assert.equal(upgrade.extensionPrepared, false);
  assert.deepEqual(
    new Set(upgrade.updatedSkillPaths),
    new Set([first.skillPath, second.skillPath]),
  );
  assert.equal(readFileSync(extensionFile, 'utf8'), 'Manually installed extension');
  const installation = JSON.parse(readFileSync(join(browserpawHome, 'installation.json'), 'utf8'));
  assert.deepEqual(installation.browsers, ['chromium']);
  assert.equal(
    JSON.parse(readFileSync(join(first.skillPath, '.browserpaw-skill.json'), 'utf8')).scope,
    'project',
  );
  for (const skillPath of upgrade.updatedSkillPaths)
    assert.match(readFileSync(join(skillPath, 'SKILL.md'), 'utf8'), /browserpaw status/);

  const latest = '5000.0.1';
  writeFileSync(
    join(browserpawHome, 'cli-update.json'),
    JSON.stringify({ checkedAt: Date.now(), latest }),
  );
  for (const expected of [true, false]) {
    const notice = spawnSync(process.execPath, [cli, 'recipe', 'list', '--json'], {
      encoding: 'utf8',
      cwd: work,
      env: { ...env, BROWSERPAW_NO_UPDATE_CHECK: '0' },
      timeout: 5000,
    });
    assert.equal(notice.status, 0);
    assert.equal(JSON.parse(notice.stdout).ok, true);
    assert.equal(notice.stderr.includes(`BrowserPaw ${latest} is available`), expected);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
