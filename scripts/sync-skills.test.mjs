import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const syncScript = path.join(repoRoot, 'scripts', 'sync-skills.mjs');
const scriptSource = fs.readFileSync(syncScript, 'utf-8');

// 1. 静态阻断：禁止硬编码外部路径、Hermes 同步及 managed hash（严禁实跑旧脚本）
assert.ok(
  !scriptSource.includes('hermesPluginDir') && !scriptSource.includes('.browserpaw-managed.json'),
);
assert.ok(!scriptSource.includes('C:/Users') && !scriptSource.includes('D:/workspace/browserpaw'));

const canonicalSkill =
  '# browserpaw\nUse chrome_interact_index & chrome_fill_index with get_windows_and_tabs.\n';
const canonicalRecipe = 'Run chrome_fill_index to write text.\n';
const expectedPluginSkill =
  '# browserpaw\nUse browserpaw_interact_index & browserpaw_fill_index with browserpaw_get_windows_and_tabs.\n';
const expectedPluginRecipe = 'Run browserpaw_fill_index to write text.\n';

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-box-'));
  fs.mkdirSync(path.join(root, 'skill', 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skill', 'SKILL.md'), canonicalSkill);
  fs.writeFileSync(path.join(root, 'skill', 'recipes', 'act.md'), canonicalRecipe);
  fs.copyFileSync(syncScript, path.join(root, 'scripts', 'sync-skills.mjs'));
  return root;
}
const runScript = (sandbox, cwd = sandbox) =>
  spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'sync-skills.mjs')], {
    cwd,
    encoding: 'utf-8',
  });

// 2. 异 cwd 运行与两个镜像 exact equal 完整内容校验
const sandbox = createSandbox();
const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-out-'));
try {
  const res = runScript(sandbox, outsideCwd);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(fs.readdirSync(outsideCwd).length, 0);

  const m1Skill = fs.readFileSync(path.join(sandbox, 'skills', 'browserpaw', 'SKILL.md'), 'utf-8');
  const m1Recipe = fs.readFileSync(
    path.join(sandbox, 'skills', 'browserpaw', 'recipes', 'act.md'),
    'utf-8',
  );
  assert.strictEqual(m1Skill, canonicalSkill);
  assert.strictEqual(m1Recipe, canonicalRecipe);

  const m2Skill = fs.readFileSync(
    path.join(sandbox, 'plugins', 'browserpaw', 'skills', 'browserpaw', 'SKILL.md'),
    'utf-8',
  );
  const m2Recipe = fs.readFileSync(
    path.join(sandbox, 'plugins', 'browserpaw', 'skills', 'browserpaw', 'recipes', 'act.md'),
    'utf-8',
  );
  assert.strictEqual(m2Skill, expectedPluginSkill);
  assert.strictEqual(m2Recipe, expectedPluginRecipe);

  // 2b. Verify scope banner on plugin references and TROUBLESHOOTING files
  const testRef = '# Reference\nDetailed tool guide.\n';
  const testTrouble = '# Troubleshooting\nFAQ.\n';
  fs.mkdirSync(path.join(sandbox, 'skill', 'references'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'skill', 'config'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'skill', 'references', 'tools.md'), testRef);
  fs.writeFileSync(path.join(sandbox, 'skill', 'config', 'TROUBLESHOOTING.md'), testTrouble);
  fs.writeFileSync(path.join(sandbox, 'skill', 'config', 'TROUBLESHOOTING.zh-CN.md'), testTrouble);
  const testJson = '{"tool": "chrome_navigate"}';
  fs.writeFileSync(path.join(sandbox, 'skill', 'config', 'test.json'), testJson);
  const res2 = runScript(sandbox);
  assert.strictEqual(res2.status, 0, res2.stderr);

  // Standard target: NO banner
  const m1Ref = fs.readFileSync(
    path.join(sandbox, 'skills', 'browserpaw', 'references', 'tools.md'),
    'utf-8',
  );
  assert.strictEqual(m1Ref, testRef);

  // Plugin target: EN banner on references and TROUBLESHOOTING.md, ZH banner on .zh-CN.md
  const m2Ref = fs.readFileSync(
    path.join(sandbox, 'plugins', 'browserpaw', 'skills', 'browserpaw', 'references', 'tools.md'),
    'utf-8',
  );
  assert.ok(m2Ref.includes('not available in the Hermes plugin; use standard MCP'));
  assert.ok(m2Ref.includes(testRef));
  const m2Trouble = fs.readFileSync(
    path.join(
      sandbox,
      'plugins',
      'browserpaw',
      'skills',
      'browserpaw',
      'config',
      'TROUBLESHOOTING.md',
    ),
    'utf-8',
  );
  assert.ok(m2Trouble.includes('not available in the Hermes plugin; use standard MCP'));
  const m2TroubleZh = fs.readFileSync(
    path.join(
      sandbox,
      'plugins',
      'browserpaw',
      'skills',
      'browserpaw',
      'config',
      'TROUBLESHOOTING.zh-CN.md',
    ),
    'utf-8',
  );
  assert.ok(m2TroubleZh.includes('工具可用性说明'));
  assert.ok(m2TroubleZh.includes('not available in the Hermes plugin; use standard MCP'));

  // JSON files must NEVER receive markdown banners and must remain valid JSON
  const m2Json = fs.readFileSync(
    path.join(sandbox, 'plugins', 'browserpaw', 'skills', 'browserpaw', 'config', 'test.json'),
    'utf-8',
  );
  assert.strictEqual(JSON.parse(m2Json).tool, 'browserpaw_navigate');

  // 2c. Verify HERMES_PLUGIN_SKILL.md takes precedence for plugin SKILL.md and is not copied to mirrors
  const hermesCustomSkill = '# browserpaw hermes 16 curated tools\n';
  fs.writeFileSync(path.join(sandbox, 'skill', 'HERMES_PLUGIN_SKILL.md'), hermesCustomSkill);
  const res3 = runScript(sandbox);
  assert.strictEqual(res3.status, 0, res3.stderr);
  assert.strictEqual(
    fs.readFileSync(
      path.join(sandbox, 'plugins', 'browserpaw', 'mcp-skills', 'browserpaw', 'SKILL.md'),
      'utf-8',
    ),
    canonicalSkill,
  );
  assert.strictEqual(
    fs.readFileSync(
      path.join(sandbox, 'plugins', 'browserpaw-dsh', 'skills', 'browserpaw', 'SKILL.md'),
      'utf-8',
    ),
    expectedPluginSkill,
  );

  // Standard target: still canonical skill, HERMES_PLUGIN_SKILL.md not copied
  assert.strictEqual(
    fs.readFileSync(path.join(sandbox, 'skills', 'browserpaw', 'SKILL.md'), 'utf-8'),
    canonicalSkill,
  );
  assert.strictEqual(
    fs.existsSync(path.join(sandbox, 'skills', 'browserpaw', 'HERMES_PLUGIN_SKILL.md')),
    false,
  );

  // Plugin target: uses HERMES_PLUGIN_SKILL.md, not copied as separate file
  assert.strictEqual(
    fs.readFileSync(
      path.join(sandbox, 'plugins', 'browserpaw', 'skills', 'browserpaw', 'SKILL.md'),
      'utf-8',
    ),
    hermesCustomSkill,
  );
  assert.strictEqual(
    fs.existsSync(
      path.join(sandbox, 'plugins', 'browserpaw', 'skills', 'browserpaw', 'HERMES_PLUGIN_SKILL.md'),
    ),
    false,
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(outsideCwd, { recursive: true, force: true });
}

// 3. 目标端：外部 directory junction 与 dangling link fail-closed 拦截
const jBox = createSandbox();
const extProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-ext-'));
const sentinel = path.join(extProbe, 'probe.txt');
fs.writeFileSync(sentinel, 'untouched');
const jLink = path.join(jBox, 'skills', 'browserpaw');
fs.mkdirSync(path.dirname(jLink), { recursive: true });
fs.symlinkSync(extProbe, jLink, 'junction');
try {
  const res = runScript(jBox);
  assert.notStrictEqual(res.status, 0);
  assert.strictEqual(fs.readFileSync(sentinel, 'utf-8'), 'untouched');
  assert.ok(!fs.existsSync(path.join(extProbe, 'SKILL.md')));
} finally {
  fs.unlinkSync(jLink);
}
const dangLink = path.join(jBox, 'skills', 'browserpaw');
fs.symlinkSync(path.join(extProbe, 'non-existent'), dangLink, 'junction');
try {
  const res = runScript(jBox);
  assert.notStrictEqual(res.status, 0);
} finally {
  fs.unlinkSync(dangLink);
  fs.rmSync(extProbe, { recursive: true, force: true });
  fs.rmSync(jBox, { recursive: true, force: true });
}

// 4. 源端 (source)：skill 内部 directory junction 与文件 symlink 指向仓外凭据防御
const srcBox = createSandbox();
const srcSecretProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-src-secret-'));
const secretDir = path.join(srcSecretProbe, 'creds');
fs.mkdirSync(secretDir, { recursive: true });
fs.writeFileSync(path.join(secretDir, 'id_rsa'), 'SECRET_KEY');
const srcJunction = path.join(srcBox, 'skill', 'secret_dir');
fs.symlinkSync(secretDir, srcJunction, 'junction');
try {
  const res = runScript(srcBox);
  assert.notStrictEqual(res.status, 0, 'FAIL: script should reject source directory junction');
  assert.ok(!fs.existsSync(path.join(srcBox, 'skills', 'browserpaw', 'secret_dir')));
} finally {
  fs.unlinkSync(srcJunction);
}
let srcFileSymlinkCreated = false;
const srcFileLink = path.join(srcBox, 'skill', 'secret.md');
try {
  fs.symlinkSync(path.join(secretDir, 'id_rsa'), srcFileLink, 'file');
  srcFileSymlinkCreated = true;
} catch {
  console.log('[SKIP] Source file symlink test skipped due to Windows privilege');
}
try {
  if (srcFileSymlinkCreated) {
    const res = runScript(srcBox);
    assert.notStrictEqual(res.status, 0, 'FAIL: script should reject source file symlink');
    assert.ok(!fs.existsSync(path.join(srcBox, 'skills', 'browserpaw', 'secret.md')));
  }
} finally {
  if (srcFileSymlinkCreated) fs.unlinkSync(srcFileLink);
  fs.rmSync(srcSecretProbe, { recursive: true, force: true });
  fs.rmSync(srcBox, { recursive: true, force: true });
}

// 5. 内部 canonical link 循环/覆写防御
const canBox = createSandbox();
const canLink = path.join(canBox, 'skills', 'browserpaw');
fs.mkdirSync(path.dirname(canLink), { recursive: true });
fs.symlinkSync(path.join(canBox, 'skill'), canLink, 'junction');
try {
  const res = runScript(canBox);
  assert.notStrictEqual(res.status, 0);
} finally {
  fs.unlinkSync(canLink);
  fs.rmSync(canBox, { recursive: true, force: true });
}

// 6. 前缀欺骗：真实执行生产 script 验证拦截同名前缀伪装目录
const prefBox = createSandbox();
const spoofDir = prefBox + '-fake';
fs.mkdirSync(spoofDir, { recursive: true });
const spoofLink = path.join(prefBox, 'skills', 'browserpaw');
fs.mkdirSync(path.dirname(spoofLink), { recursive: true });
fs.symlinkSync(spoofDir, spoofLink, 'junction');
try {
  const res = runScript(prefBox);
  assert.notStrictEqual(res.status, 0);
  assert.strictEqual(fs.readdirSync(spoofDir).length, 0);
} finally {
  fs.unlinkSync(spoofLink);
  fs.rmSync(spoofDir, { recursive: true, force: true });
  fs.rmSync(prefBox, { recursive: true, force: true });
}

console.log('QUAL-03 regression passed: all security boundaries verified.');
