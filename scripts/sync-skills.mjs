import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ponytail: minimal path.relative boundary + fail-closed on any symlink/junction
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const realRepo = fs.realpathSync(repoRoot);
const rootSkill = path.join(repoRoot, 'skill');

const targets = [
  { dir: path.join(repoRoot, 'skills', 'browserpaw') },
  {
    dir: path.join(repoRoot, 'plugins', 'browserpaw', 'skills', 'browserpaw'),
    isPlugin: true,
    isHermes: true,
  },
  { dir: path.join(repoRoot, 'plugins', 'browserpaw', 'mcp-skills', 'browserpaw') },
  { dir: path.join(repoRoot, 'plugins', 'browserpaw-dsh', 'skills', 'browserpaw'), isPlugin: true },
];

const SCOPE_BANNER_EN =
  '> **Tool Availability Notice**: Standard BrowserPaw MCP exposes the full 50 toolset (under full profile; stdio defaults to core). The optional Hermes plugin exposes 16 curated wrapper tools (`browserpaw_*`). Other tools are not available in the Hermes plugin; use standard MCP.\n\n';

function assertSafePath(targetPath) {
  let curr = path.resolve(targetPath);
  let deepestExisting = null;
  while (true) {
    try {
      if (fs.lstatSync(curr).isSymbolicLink()) {
        throw new Error(`Security violation: symlink or junction forbidden: ${curr}`);
      }
      if (!deepestExisting) deepestExisting = curr;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  const realBase = fs.realpathSync(deepestExisting || repoRoot);
  const rel = path.relative(realRepo, realBase);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Security violation: target outside repository: ${targetPath}`);
  }
}

function copyDir(src, dest, isPlugin = false, isHermes = false) {
  assertSafePath(src);
  assertSafePath(dest);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'HERMES_PLUGIN_SKILL.md') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    assertSafePath(srcPath);
    assertSafePath(destPath);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, isPlugin, isHermes);
    } else if (isHermes && entry.name === 'SKILL.md') {
      const hermesTemplate = path.join(rootSkill, 'HERMES_PLUGIN_SKILL.md');
      assertSafePath(hermesTemplate);
      const text = fs.existsSync(hermesTemplate)
        ? fs.readFileSync(hermesTemplate, 'utf-8')
        : fs
            .readFileSync(srcPath, 'utf-8')
            .replaceAll('chrome_', 'browserpaw_')
            .replaceAll('get_windows_and_tabs', 'browserpaw_get_windows_and_tabs');
      fs.writeFileSync(destPath, Buffer.from(text.replace(/\r\n/g, '\n'), 'utf-8'));
    } else if (isPlugin && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
      let text = fs
        .readFileSync(srcPath, 'utf-8')
        .replaceAll('chrome_', 'browserpaw_')
        .replaceAll('get_windows_and_tabs', 'browserpaw_get_windows_and_tabs');
      const relFromSkill = path.relative(rootSkill, srcPath);
      const isReference = relFromSkill.startsWith('references' + path.sep);
      const isTroubleshooting =
        entry.name.startsWith('TROUBLESHOOTING') && entry.name.endsWith('.md');
      if (isHermes && entry.name.endsWith('.md') && (isReference || isTroubleshooting)) {
        text = SCOPE_BANNER_EN + text;
      }
      fs.writeFileSync(destPath, Buffer.from(text.replace(/\r\n/g, '\n'), 'utf-8'));
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

assertSafePath(rootSkill);
for (const target of targets) {
  assertSafePath(target.dir);
  copyDir(rootSkill, target.dir, target.isPlugin, target.isHermes);
}

console.log('Skill synchronization completed successfully across all targets.');
