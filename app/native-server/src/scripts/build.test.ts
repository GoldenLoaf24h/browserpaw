import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { copyHostWrapperScripts } from './build';

describe('QUAL-01: build script fail-fast verification', () => {
  it('throws explicitly when required run_host.sh or run_host.bat is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'));
    const srcDir = path.join(tmpDir, 'src');
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });

    try {
      // Empty srcDir: missing both run_host.sh and run_host.bat
      expect(() => {
        copyHostWrapperScripts(srcDir, distDir);
      }).toThrow(/Required macOS wrapper script missing/i);

      // Provide only run_host.sh, still missing run_host.bat
      fs.writeFileSync(path.join(srcDir, 'run_host.sh'), '#!/bin/sh');
      expect(() => {
        copyHostWrapperScripts(srcDir, distDir);
      }).toThrow(/Required Windows wrapper script missing/i);

      // Provide both: now must succeed cleanly
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
});
