import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadSiteNote, getBuiltinRecipesDir } from './site-notes';
import { createReplMcpClient } from './repl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

describe('Site Notes Built-in Pure Loader', () => {
  const recipesDir = getBuiltinRecipesDir();
  const mdnFile = path.join(recipesDir, 'developer.mozilla.org.md');
  let previous: Buffer | undefined;
  beforeAll(() => {
    previous = fs.existsSync(mdnFile) ? fs.readFileSync(mdnFile) : undefined;
    fs.mkdirSync(recipesDir, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '../../../skills/browserpaw/assets/recipes/developer.mozilla.org.md'),
      mdnFile,
    );
  });
  afterAll(() => {
    if (previous) fs.writeFileSync(mdnFile, previous);
    else fs.unlinkSync(mdnFile);
  });
  describe('Protocol and Hostname Strict Boundaries', () => {
    it('accepts valid http and https URLs and normalizes hostname', async () => {
      const resHttp = await loadSiteNote('http://developer.mozilla.org/en-US/docs');
      expect(resHttp.hostname).toBe('developer.mozilla.org');
      expect(resHttp.found).toBe(true);

      const resHttps = await loadSiteNote('https://DEVELOPER.mozilla.org/path?q=1#hash');
      expect(resHttps.hostname).toBe('developer.mozilla.org');
      expect(resHttps.found).toBe(true);
    });

    it('rejects non-http/https protocols such as file:// and ftp://', async () => {
      const resFile = await loadSiteNote('file:///etc/passwd');
      expect(resFile.found).toBe(false);
      expect(resFile.warning).toContain('Only http/https URLs allowed');

      const resFtp = await loadSiteNote('ftp://example.com/file');
      expect(resFtp.found).toBe(false);
      expect(resFtp.warning).toContain('Only http/https URLs allowed');
    });

    it('rejects bare paths, scheme-less inputs, or malicious traversal hostnames', async () => {
      expect((await loadSiteNote('')).found).toBe(false);
      expect((await loadSiteNote('   ')).found).toBe(false);
      expect((await loadSiteNote('evil/name')).found).toBe(false);
      expect((await loadSiteNote('../evil.com')).found).toBe(false);
      expect((await loadSiteNote('https://../evil')).found).toBe(false);
      expect((await loadSiteNote('https://evil..com')).found).toBe(false);
      expect((await loadSiteNote('https://evil$name.com')).found).toBe(false);
    });
  });

  describe('Real dist recipe reachability & verified MDN playbook', () => {
    it('loads real developer.mozilla.org.md from dist/recipes and verifies verified facts', async () => {
      const res = await loadSiteNote('https://developer.mozilla.org/zh-CN/docs/Web/API');
      expect(res.found).toBe(true);
      expect(res.hostname).toBe('developer.mozilla.org');
      expect(res.source).toBe('local recipe');
      expect(res.truncated).toBe(false);
      expect(res.isStale).toBe(false);
      expect(res.warning).toBeUndefined();

      // Verify confirmed interactive facts in recipe
      expect(res.content).toContain('display: contents');
      expect(res.content).toContain('iframe.interactive');
      expect(res.content).toContain('Stale Ref Invalidation');
      expect(res.content).toContain('No Hardcoded Indexes or IDs');
    });

    it('returns found: false for unmapped domains without error', async () => {
      const res = await loadSiteNote('https://non-existent-domain-xyz.net');
      expect(res.found).toBe(false);
      expect(res.hostname).toBe('non-existent-domain-xyz.net');
      expect(res.content).toBeUndefined();
    });
  });

  describe('Stale Detection (missing, invalid date, or >90d)', () => {
    it('marks recipe stale when Last Verified date is absent or malformed', async () => {
      const builtinDir = getBuiltinRecipesDir();
      const testFile = path.join(builtinDir, 'test-stale-malformed.com.md');
      fs.writeFileSync(testFile, '# Test Site\nLast Verified: invalid-date\nSome content.');

      try {
        const res = await loadSiteNote('https://test-stale-malformed.com');
        expect(res.found).toBe(true);
        expect(res.isStale).toBe(true);
        expect(res.warning).toContain('Recipe may be stale or unverified');
      } finally {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
      }
    });

    it('marks recipe stale when Last Verified date is older than 90 days', async () => {
      const builtinDir = getBuiltinRecipesDir();
      const testFile = path.join(builtinDir, 'test-stale-old.com.md');
      fs.writeFileSync(testFile, '# Old Site\nLast Verified: 2021-01-01\nOld selectors.');

      try {
        const res = await loadSiteNote('https://test-stale-old.com');
        expect(res.found).toBe(true);
        expect(res.isStale).toBe(true);
        expect(res.warning).toContain('Recipe may be stale or unverified');
      } finally {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
      }
    });
  });

  describe('Byte Budget & UTF-8 character boundary preservation', () => {
    it('truncates files >4KiB and avoids broken multi-byte characters at cut point', async () => {
      const builtinDir = getBuiltinRecipesDir();
      const testFile = path.join(builtinDir, 'test-large-multibyte.com.md');

      // Create content with ASCII header and repeated 3-byte Chinese characters
      const header = '# Last Verified: 2026-10-22\n';
      const repeatedChar = '测'; // 3 bytes in UTF-8: E6 B5 8B
      const targetLength = 5000;
      const count = Math.ceil(targetLength / 3);
      const largeContent = header + repeatedChar.repeat(count);
      fs.writeFileSync(testFile, largeContent, 'utf8');

      try {
        const res = await loadSiteNote('https://test-large-multibyte.com');
        expect(res.found).toBe(true);
        expect(res.truncated).toBe(true);
        expect(Buffer.byteLength(res.content || '', 'utf8')).toBeLessThanOrEqual(4096);
        // Verify no replacement character (\uFFFD) caused by broken multi-byte sequence
        expect(res.content).not.toContain('\uFFFD');
      } finally {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
      }
    });
  });

  describe('Symlink rejection within recipes directory', () => {
    it('refuses to read symbolic link file', async () => {
      const builtinDir = getBuiltinRecipesDir();
      const symlinkFile = path.join(builtinDir, 'test-symlink.com.md');
      const target = path.join(builtinDir, 'developer.mozilla.org.md');

      try {
        fs.symlinkSync(target, symlinkFile);
      } catch {
        // Skip on environments without symlink privileges
        return;
      }

      try {
        const res = await loadSiteNote('https://test-symlink.com');
        expect(res.found).toBe(false);
        expect(res.warning).toContain('Symbolic links and non-files are prohibited');
      } finally {
        try {
          fs.unlinkSync(symlinkFile);
        } catch {}
      }
    });
  });

  describe('REPL Integration via mcp.notes(url)', () => {
    it('prefers an active skill summary without loading the full recipe code', async () => {
      const mockCallTool = jest.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              {
                id: 'mdn-live',
                version: 3,
                status: 'active',
                name: 'MDN Live',
                description: 'Use the verified locator recipe.',
                domains: ['developer.mozilla.org'],
                keywords: ['mdn'],
                verifiedAt: '2026-10-20',
              },
            ]),
          },
        ],
      });
      const fakeClient = {
        callTool: mockCallTool,
        listTools: jest.fn(),
        close: (jest.fn() as any).mockResolvedValue(undefined),
      } as unknown as Client;

      const { mcp } = await createReplMcpClient({ client: fakeClient });
      expect(typeof mcp.notes).toBe('function');

      const res = await mcp.notes('https://developer.mozilla.org');
      expect(res.found).toBe(true);
      expect(res.hostname).toBe('developer.mozilla.org');
      expect(res.source).toBe('skill:mdn-live@3');
      expect(res.content).toContain('Use the verified locator recipe.');
      expect(res.content).toContain("mcp.skills.get('mdn-live', 3)");
      expect(res.content).not.toContain('steps');
      expect(mockCallTool).toHaveBeenCalledWith(
        {
          name: 'chrome_skill',
          arguments: { action: 'find', url: 'https://developer.mozilla.org' },
        },
        undefined,
        undefined,
      );
      expect(fakeClient.listTools).not.toHaveBeenCalled();
    });

    it('preserves the static site note when no active skill matches', async () => {
      const mockCallTool = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: '[]' }],
      });
      const fakeClient = {
        callTool: mockCallTool,
        listTools: jest.fn(),
        close: (jest.fn() as any).mockResolvedValue(undefined),
      } as unknown as Client;
      const { mcp } = await createReplMcpClient({ client: fakeClient });

      const res = await mcp.notes('https://developer.mozilla.org');

      expect(res.found).toBe(true);
      expect(res.source).toBe('local recipe');
      expect(res.warning).toBeUndefined();
    });

    it('falls back to the static note with an explicit warning when MCP skill lookup fails', async () => {
      const mockCallTool = jest.fn().mockRejectedValue(new Error('chrome_skill unsupported'));
      const fakeClient = {
        callTool: mockCallTool,
        listTools: jest.fn(),
        close: (jest.fn() as any).mockResolvedValue(undefined),
      } as unknown as Client;
      const { mcp } = await createReplMcpClient({ client: fakeClient });

      const res = await mcp.notes('https://developer.mozilla.org');

      expect(res.found).toBe(true);
      expect(res.source).toBe('local recipe');
      expect(res.warning).toContain('MCP skill lookup failed');
      expect(res.warning).toContain('chrome_skill unsupported');
    });
  });
});
