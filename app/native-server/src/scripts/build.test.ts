import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { copyHostWrapperScripts, cleanDistDir } from './build';

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
});
