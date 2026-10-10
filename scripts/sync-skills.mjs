import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ponytail: minimal path.relative boundary + fail-closed on any symlink/junction
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const realRepo = fs.realpathSync(repoRoot);
const rootSkill = path.join(repoRoot, 'skill');

const targets = [
  { dir: path.join(repoRoot, 'skills', 'browserpaw') },
  { dir: path.join(repoRoot, 'plugins', 'browserpaw', 'skills', 'browserpaw'), isPlugin: true },
];

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

function copyDir(src, dest, isPlugin = false) {
  assertSafePath(src);
  assertSafePath(dest);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    assertSafePath(srcPath);
    assertSafePath(destPath);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, isPlugin);
    } else if (isPlugin && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
      const text = fs.readFileSync(srcPath, 'utf-8')
        .replaceAll('chrome_', 'browserpaw_')
        .replaceAll('get_windows_and_tabs', 'browserpaw_get_windows_and_tabs');
      fs.writeFileSync(destPath, text, 'utf-8');
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

assertSafePath(rootSkill);
for (const target of targets) {
  assertSafePath(target.dir);
  copyDir(rootSkill, target.dir, target.isPlugin);
}

console.log('Skill synchronization completed successfully across all targets.');
