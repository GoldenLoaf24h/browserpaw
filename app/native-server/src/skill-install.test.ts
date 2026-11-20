import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultSkillTargetRoot,
  installSkill,
  projectSkillTargetRoot,
  resolveSkillTargetRoot,
  syncInstalledSkillRouting,
  upgradeInstalledSkill,
} from './skill-install';

function sourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-source-'));
  fs.mkdirSync(path.join(root, 'references'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets', 'recipes'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'SKILL.md'),
    '---\nname: browserpaw\ndescription: neutral\n---\n\n# BrowserPaw\n',
  );
  fs.writeFileSync(path.join(root, 'references', 'tools.md'), '# Tools\n');
  fs.writeFileSync(path.join(root, 'scripts', 'doctor.mjs'), 'console.log("ok");\n');
  fs.writeFileSync(path.join(root, 'assets', 'recipes', 'site.json'), '{"id":"site"}\n');
  return root;
}

describe('BrowserPaw neutral skill installer', () => {
  it('refreshes an older managed project Skill in place and skips a newer or unmanaged Skill', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-upgrade-'));
    const sourceDir = sourceFixture();
    try {
      const { installedPath } = installSkill({
        sourceDir,
        scope: 'project',
        cwd: project,
        version: '5.0.0',
      });
      fs.writeFileSync(path.join(sourceDir, 'references', 'tools.md'), '# New commands\n');
      expect(upgradeInstalledSkill(installedPath, { sourceDir, version: '5.1.0' })).toMatchObject({
        installedPath,
        scope: 'project',
        version: '5.1.0',
      });
      expect(fs.readFileSync(path.join(installedPath, 'references', 'tools.md'), 'utf8')).toBe(
        '# New commands\n',
      );
      expect(upgradeInstalledSkill(installedPath, { sourceDir, version: '5.0.0' })).toBeUndefined();
      fs.unlinkSync(path.join(installedPath, '.browserpaw-skill.json'));
      expect(upgradeInstalledSkill(installedPath, { sourceDir, version: '5.2.0' })).toBeUndefined();
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('rejects malformed Learned Workflows marker blocks without rewriting the Skill', () => {
    const sourceDir = sourceFixture();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-markers-'));
    const start = '<!-- browserpaw:learned:start -->';
    const end = '<!-- browserpaw:learned:end -->';
    try {
      const installed = installSkill({ sourceDir, targetRoot, version: '5.0.0' });
      const skillFile = path.join(installed.installedPath, 'SKILL.md');
      const original = fs.readFileSync(skillFile, 'utf8');
      const entries = [
        {
          id: 'example',
          kind: 'recipe' as const,
          name: 'Example',
          description: 'Example workflow',
          domains: ['example.com'],
          command: 'browserpaw recipe run example',
        },
      ];

      for (const suffix of [
        `\n${start}\n`,
        `\n${end}\n`,
        `\n${end}\n${start}\n`,
        `\n${start}\n${end}\n${start}\n${end}\n`,
      ]) {
        fs.writeFileSync(skillFile, `${original.trimEnd()}${suffix}`);
        expect(() => syncInstalledSkillRouting(installed.installedPath, entries)).toThrow(
          /Malformed BrowserPaw Learned Workflows markers.*run setup again/,
        );
        expect(fs.readFileSync(skillFile, 'utf8')).toBe(`${original.trimEnd()}${suffix}`);
      }
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('uses ~/.agents/skills/browserpaw by default and supports custom skills roots', () => {
    expect(defaultSkillTargetRoot()).toBe(path.join(os.homedir(), '.agents', 'skills'));
    const sourceDir = sourceFixture();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-install-'));
    try {
      const result = installSkill({ sourceDir, targetRoot, version: '4.0.0' });
      expect(result.installedPath).toBe(path.join(targetRoot, 'browserpaw'));
      expect(fs.existsSync(path.join(result.installedPath, 'references', 'tools.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.installedPath, 'scripts', 'doctor.mjs'))).toBe(true);
      const marker = JSON.parse(
        fs.readFileSync(path.join(result.installedPath, '.browserpaw-skill.json'), 'utf8'),
      );
      expect(marker).toMatchObject({
        name: 'browserpaw',
        version: '4.0.0',
        scope: 'custom',
        source: 'bundled:skills/browserpaw',
        baseDescription: 'neutral',
      });
      expect(fs.readdirSync(targetRoot).filter((name) => name.includes('staging'))).toEqual([]);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('supports standard user/project scopes and syncs learned routing idempotently', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-project-'));
    const sourceDir = sourceFixture();
    try {
      expect(projectSkillTargetRoot(projectRoot)).toBe(path.join(projectRoot, '.agents', 'skills'));
      expect(resolveSkillTargetRoot({ scope: 'global' })).toEqual({
        targetRoot: defaultSkillTargetRoot(),
        scope: 'user',
      });
      expect(resolveSkillTargetRoot({ scope: 'project', cwd: projectRoot })).toEqual({
        targetRoot: path.join(projectRoot, '.agents', 'skills'),
        scope: 'project',
      });
      expect(() => resolveSkillTargetRoot({ scope: 'project', targetRoot: projectRoot })).toThrow(
        /not both/,
      );
      expect(() => resolveSkillTargetRoot({ scope: 'workspace' })).toThrow(/user or project/);

      const installed = installSkill({
        sourceDir,
        scope: 'project',
        cwd: projectRoot,
        version: '5.0.0',
      });
      expect(installed.scope).toBe('project');
      expect(installed.installedPath).toBe(
        path.join(projectRoot, '.agents', 'skills', 'browserpaw'),
      );

      const entries = [
        {
          id: 'x-search-thread',
          kind: 'skill' as const,
          name: 'X search results reader',
          description: 'Read visible X search results',
          domains: ['x.com', 'twitter.com'],
          command: 'browserpaw recipe run x-search-thread query=<query>',
        },
      ];
      expect(syncInstalledSkillRouting(installed.installedPath, entries)).toBe(true);
      const firstSync = fs.readFileSync(path.join(installed.installedPath, 'SKILL.md'), 'utf8');
      expect(firstSync).toContain('x-search-thread (x.com/twitter.com)');
      expect(firstSync).toContain('browserpaw recipe run x-search-thread query=<query>');

      expect(syncInstalledSkillRouting(installed.installedPath, entries)).toBe(true);
      const secondSync = fs.readFileSync(path.join(installed.installedPath, 'SKILL.md'), 'utf8');
      expect(secondSync).toBe(firstSync);

      expect(syncInstalledSkillRouting(installed.installedPath, [])).toBe(true);
      const cleared = fs.readFileSync(path.join(installed.installedPath, 'SKILL.md'), 'utf8');
      expect(cleared).not.toContain('x-search-thread');
      expect(cleared).toContain('description: "neutral"');

      const unmarked = path.join(projectRoot, 'unmarked');
      fs.mkdirSync(unmarked, { recursive: true });
      fs.writeFileSync(
        path.join(unmarked, 'SKILL.md'),
        '---\nname: custom\ndescription: keep\n---\n',
      );
      expect(syncInstalledSkillRouting(unmarked, entries)).toBe(false);
      expect(fs.readFileSync(path.join(unmarked, 'SKILL.md'), 'utf8')).toContain(
        'description: keep',
      );
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('refuses an existing unmarked directory and only replaces marked installs with force', () => {
    const sourceDir = sourceFixture();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-existing-'));
    const destination = path.join(targetRoot, 'browserpaw');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'user-file.txt'), 'keep\n');
    try {
      expect(() => installSkill({ sourceDir, targetRoot, force: true })).toThrow(
        /installation marker/,
      );
      expect(fs.readFileSync(path.join(destination, 'user-file.txt'), 'utf8')).toBe('keep\n');
      fs.writeFileSync(
        path.join(destination, '.browserpaw-skill.json'),
        JSON.stringify({ name: 'browserpaw', version: '3.0.0' }),
      );
      expect(() => installSkill({ sourceDir, targetRoot })).toThrow(/use --force/);
      installSkill({ sourceDir, targetRoot, force: true, version: '4.0.0' });
      expect(fs.existsSync(path.join(destination, 'user-file.txt'))).toBe(false);
      expect(fs.existsSync(path.join(destination, 'references', 'tools.md'))).toBe(true);
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('restores the previous marked install if the final rename fails', () => {
    const sourceDir = sourceFixture();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-rename-'));
    const destination = path.join(targetRoot, 'browserpaw');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(
      path.join(destination, '.browserpaw-skill.json'),
      JSON.stringify({ name: 'browserpaw', version: '3.0.0' }),
    );
    fs.writeFileSync(path.join(destination, 'old.txt'), 'old\n');
    const originalRename = fs.renameSync.bind(fs);
    let destinationMoves = 0;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.resolve(String(to)) === path.resolve(destination)) {
        destinationMoves += 1;
        if (destinationMoves === 1) throw new Error('simulated rename failure');
      }
      return originalRename(from, to);
    });
    try {
      expect(() => installSkill({ sourceDir, targetRoot, force: true, version: '4.0.0' })).toThrow(
        /simulated rename failure/,
      );
      expect(fs.readFileSync(path.join(destination, 'old.txt'), 'utf8')).toBe('old\n');
      expect(fs.existsSync(path.join(destination, 'references'))).toBe(false);
    } finally {
      spy.mockRestore();
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('removes staging when moving the previous install aside fails', () => {
    const sourceDir = sourceFixture();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-backup-'));
    const destination = path.join(targetRoot, 'browserpaw');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(
      path.join(destination, '.browserpaw-skill.json'),
      JSON.stringify({ name: 'browserpaw', version: '3.0.0' }),
    );
    fs.writeFileSync(path.join(destination, 'old.txt'), 'old\n');
    const originalRename = fs.renameSync.bind(fs);
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.resolve(String(from)) === path.resolve(destination)) {
        throw new Error('simulated backup failure');
      }
      return originalRename(from, to);
    });
    try {
      expect(() => installSkill({ sourceDir, targetRoot, force: true, version: '4.0.0' })).toThrow(
        /simulated backup failure/,
      );
      expect(fs.readFileSync(path.join(destination, 'old.txt'), 'utf8')).toBe('old\n');
      expect(fs.readdirSync(targetRoot).filter((name) => name.includes('staging'))).toEqual([]);
    } finally {
      spy.mockRestore();
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('rejects symlinked targets and symlinked packaged content', () => {
    const sourceDir = sourceFixture();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-skill-outside-'));
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'untouched\n');
    const linkedRoot = path.join(targetRoot, 'linked-skills');
    try {
      try {
        fs.symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        console.log('[SKIP] junction test requires platform link privileges');
      }
      if (fs.existsSync(linkedRoot)) {
        expect(() => installSkill({ sourceDir, targetRoot: linkedRoot })).toThrow(
          /symlink or junction/,
        );
        expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched\n');
      }

      const brokenRoot = path.join(targetRoot, 'broken-skills');
      try {
        fs.symlinkSync(path.join(targetRoot, 'missing-target'), brokenRoot, 'dir');
        expect(() => installSkill({ sourceDir, targetRoot: brokenRoot })).toThrow(
          /symlink or junction/,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        console.log('[SKIP] broken symlink test requires platform link privileges');
      }

      const sourceLink = path.join(sourceDir, 'linked-assets');
      try {
        fs.symlinkSync(outside, sourceLink, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        console.log('[SKIP] source junction test requires platform link privileges');
      }
      if (fs.existsSync(sourceLink)) {
        expect(() => installSkill({ sourceDir, targetRoot })).toThrow(
          /Bundled skill contains a symlink/,
        );
      }
    } finally {
      if (fs.existsSync(linkedRoot) || fs.lstatSync(linkedRoot, { throwIfNoEntry: false })) {
        fs.rmSync(linkedRoot, { force: true });
      }
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(targetRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
