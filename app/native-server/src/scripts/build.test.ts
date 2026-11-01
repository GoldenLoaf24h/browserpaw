import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  assertRequiredRecipeFiles,
  copyHostWrapperScripts,
  cleanDistDir,
  copyRecipeDataFiles,
  copyPortableSkill,
} from './build';

describe('QUAL-01: build script fail-fast verification', () => {
  it('throws explicitly when required run_host.sh or run_host.bat is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'));
    const srcDir = path.join(tmpDir, 'src');
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });

    try {
      expect(() => {
        copyHostWrapperScripts(srcDir, distDir);
      }).toThrow(/Required macOS wrapper script missing/i);

      fs.writeFileSync(path.join(srcDir, 'run_host.sh'), '#!/bin/sh');
      expect(() => {
        copyHostWrapperScripts(srcDir, distDir);
      }).toThrow(/Required Windows wrapper script missing/i);

      fs.writeFileSync(path.join(srcDir, 'run_host.bat'), '@echo off');
      expect(() => {
        copyHostWrapperScripts(srcDir, distDir);
      }).not.toThrow();

      expect(fs.existsSync(path.join(distDir, 'run_host.sh'))).toBe(true);
      expect(fs.existsSync(path.join(distDir, 'run_host.bat'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('cleanDistDir: contents-only cleaning and fail-fast locking semantics', () => {
    it('cleans directory contents while preserving root, even when cwd is pinned to it', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-cwd-'));
      const subFile = path.join(tmpDir, 'bundle.js');
      const subDir = path.join(tmpDir, 'logs');
      fs.writeFileSync(subFile, 'console.log(1);');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'out.log'), 'test log');

      const originalCwd = process.cwd();
      try {
        // Pin process.cwd to tmpDir (in Windows, rmdir on cwd throws EBUSY)
        process.chdir(tmpDir);

        expect(() => cleanDistDir(tmpDir)).not.toThrow();
        expect(fs.existsSync(tmpDir)).toBe(true);
        expect(fs.readdirSync(tmpDir)).toEqual([]);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('gracefully handles non-existent directory without throwing', () => {
      const nonexistent = path.join(os.tmpdir(), 'does-not-exist-' + Date.now());
      expect(() => cleanDistDir(nonexistent)).not.toThrow();
    });

    it('propagates failure and fails fast when a file inside dist is locked', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-locked-'));
      fs.writeFileSync(path.join(tmpDir, 'locked.bin'), 'locked data');

      const spy = jest.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
        const err: any = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      });

      try {
        expect(() => cleanDistDir(tmpDir)).toThrow(/EBUSY/i);
      } finally {
        spy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
  describe('copyRecipeDataFiles: copies markdown and executable JSON recipes', () => {
    it('copies developer.mozilla.org.md and JSON definitions while skipping meta files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-build-test-'));
      const srcDir = path.join(tmpDir, 'canonical');
      const destDir = path.join(tmpDir, 'dist', 'recipes');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(path.join(srcDir, 'AGENTS.md'), '# Agents');
      fs.writeFileSync(path.join(srcDir, 'README.md'), '# Readme');
      fs.writeFileSync(path.join(srcDir, 'template.md'), '# Template');
      fs.writeFileSync(path.join(srcDir, 'developer.mozilla.org.md'), '# MDN Playbook');
      fs.writeFileSync(
        path.join(srcDir, 'mdn-search.json'),
        JSON.stringify({ id: 'mdn-search', source: { type: 'builtin' } }),
      );
      fs.writeFileSync(path.join(srcDir, 'ignore.txt'), 'ignore me');

      try {
        copyRecipeDataFiles(srcDir, destDir);

        expect(fs.existsSync(path.join(destDir, 'developer.mozilla.org.md'))).toBe(true);
        expect(fs.readFileSync(path.join(destDir, 'developer.mozilla.org.md'), 'utf8')).toBe(
          '# MDN Playbook',
        );
        expect(JSON.parse(fs.readFileSync(path.join(destDir, 'mdn-search.json'), 'utf8'))).toEqual({
          id: 'mdn-search',
          source: { type: 'builtin' },
        });

        expect(fs.existsSync(path.join(destDir, 'AGENTS.md'))).toBe(false);
        expect(fs.existsSync(path.join(destDir, 'README.md'))).toBe(false);
        expect(fs.existsSync(path.join(destDir, 'template.md'))).toBe(false);
        expect(fs.existsSync(path.join(destDir, 'ignore.txt'))).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('gracefully handles missing canonical recipes directory without error', () => {
      const nonexistent = path.join(os.tmpdir(), 'no-recipes-' + Date.now());
      const destDir = path.join(os.tmpdir(), 'dest-recipes-' + Date.now());
      expect(() => copyRecipeDataFiles(nonexistent, destDir)).not.toThrow();
      expect(fs.existsSync(destDir)).toBe(false);
    });

    it('makes all bundled executable JSON recipes reachable in the npm dist/recipes layout', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-recipes-test-'));
      const canonicalDir = path.resolve(__dirname, '../../../../skills/browserpaw/assets/recipes');
      const distRecipesDir = path.join(tmpDir, 'dist', 'recipes');
      const expected = [
        'mdn-search.json',
        'github-releases.json',
        'npm-compare.json',
        'x-search-thread.json',
        'x-visible-thread.json',
      ];

      try {
        copyRecipeDataFiles(canonicalDir, distRecipesDir);
        expect(fs.existsSync(path.join(distRecipesDir, 'developer.mozilla.org.md'))).toBe(true);
        for (const filename of expected) {
          const definition = JSON.parse(
            fs.readFileSync(path.join(distRecipesDir, filename), 'utf8'),
          );
          expect(definition.id).toBe(filename.slice(0, -5));
          expect(definition.source.type).toBe('builtin');
          expect(definition.source.urls.length).toBeGreaterThan(0);
          expect(definition.tests).toHaveLength(2);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails the production build when any required bundled recipe is missing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'required-recipes-test-'));
      try {
        expect(() => assertRequiredRecipeFiles(tmpDir)).toThrow(/required bundled recipe/i);
        for (const filename of [
          'developer.mozilla.org.md',
          'mdn-search.json',
          'github-releases.json',
          'npm-compare.json',
          'x-search-thread.json',
          'x-visible-thread.json',
        ]) {
          fs.writeFileSync(path.join(tmpDir, filename), '{}');
        }
        expect(() => assertRequiredRecipeFiles(tmpDir)).not.toThrow();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('copyPortableSkill: packages the neutral Agent Skill', () => {
    it('copies SKILL.md, references, scripts and assets while excluding development files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-skill-build-'));
      const source = path.join(tmpDir, 'skills', 'browserpaw');
      const destination = path.join(tmpDir, 'dist', 'skill', 'browserpaw');
      try {
        fs.mkdirSync(path.join(source, 'references'), { recursive: true });
        fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(source, 'assets', 'recipes'), { recursive: true });
        fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: browserpaw\n---\n');
        fs.writeFileSync(path.join(source, 'references', 'tools.md'), '# Tools\n');
        fs.writeFileSync(path.join(source, 'scripts', 'doctor.mjs'), 'console.log("ok");\n');
        fs.writeFileSync(path.join(source, 'assets', 'recipes', 'site.json'), '{"id":"site"}\n');
        fs.writeFileSync(path.join(source, 'AGENTS.md'), '# removed\n');
        fs.writeFileSync(path.join(source, 'HERMES_PLUGIN_SKILL.md'), '# removed\n');

        copyPortableSkill(source, destination);

        expect(fs.existsSync(path.join(destination, 'SKILL.md'))).toBe(true);
        expect(fs.readFileSync(path.join(destination, 'references', 'tools.md'), 'utf8')).toBe(
          '# Tools\n',
        );
        expect(fs.existsSync(path.join(destination, 'scripts', 'doctor.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(destination, 'assets', 'recipes', 'site.json'))).toBe(true);
        expect(fs.existsSync(path.join(destination, 'AGENTS.md'))).toBe(false);
        expect(fs.existsSync(path.join(destination, 'HERMES_PLUGIN_SKILL.md'))).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('fails when the canonical skill is missing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-skill-missing-'));
      try {
        expect(() =>
          copyPortableSkill(path.join(tmpDir, 'missing'), path.join(tmpDir, 'dist')),
        ).toThrow(/Canonical BrowserPaw skill is missing/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
