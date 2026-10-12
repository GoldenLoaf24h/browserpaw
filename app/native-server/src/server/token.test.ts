import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

const TEST_ISO_DIR = path.join(os.tmpdir(), 'browserpaw-token-test-' + Date.now());
fs.mkdirSync(TEST_ISO_DIR, { recursive: true });

jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os') as any;
  return {
    ...actual,
    homedir: () => TEST_ISO_DIR,
  };
});
jest.mock('os', () => {
  const actual = jest.requireActual('os') as any;
  return {
    ...actual,
    homedir: () => TEST_ISO_DIR,
  };
});

import { describe, expect, it, beforeEach, afterAll, jest } from '@jest/globals';
import {
  initializeBridgeToken,
  readBridgeToken,
  getBridgeToken,
  isValidBridgeToken,
  clearBridgeTokenCache,
  isValidTokenFormat,
  TOKEN_DIR,
  TOKEN_FILE,
} from './token';

describe('token: Native Bridge credentials lifecycle & isolation', () => {
  beforeEach(() => {
    clearBridgeTokenCache();
    delete process.env.CHROME_MCP_TOKEN;
    delete process.env.BROWSERPAW_MCP_TOKEN;
    delete process.env.CHROME_MCP_TOKEN_DIR;
    try {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
      if (fs.existsSync(TOKEN_DIR)) fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
    } catch {}
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_ISO_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('initializeBridgeToken creates fresh 64-hex token when absent', async () => {
    const token = await initializeBridgeToken();
    expect(token).toBeDefined();
    expect(token.length).toBe(64);
    expect(isValidTokenFormat(token)).toBe(true);
    expect(fs.existsSync(TOKEN_FILE)).toBe(true);
    expect(fs.readFileSync(TOKEN_FILE, 'utf8').trim()).toBe(token);
  });

  it('ignores CHROME_MCP_TOKEN, BROWSERPAW_MCP_TOKEN, CHROME_MCP_TOKEN_DIR and does not write back to env', async () => {
    process.env.CHROME_MCP_TOKEN = 'ignored-env-token-1122334455667788';
    process.env.BROWSERPAW_MCP_TOKEN = 'ignored-browserpaw-token-99887766';
    process.env.CHROME_MCP_TOKEN_DIR = path.join(TEST_ISO_DIR, 'wrong-dir');

    const token = await initializeBridgeToken();
    expect(token).not.toBe(process.env.CHROME_MCP_TOKEN);
    expect(token.length).toBe(64);
    expect(fs.existsSync(TOKEN_FILE)).toBe(true);
    expect(fs.existsSync(path.join(TEST_ISO_DIR, 'wrong-dir', 'bridge-token'))).toBe(false);
    expect(process.env.CHROME_MCP_TOKEN).toBe('ignored-env-token-1122334455667788');
  });

  it('initializeBridgeToken preserves existing valid 48-hex token without overwriting', async () => {
    const existing48 = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, existing48, { encoding: 'utf8', mode: 0o600 });

    const token = await initializeBridgeToken();
    expect(token).toBe(existing48);
    expect(fs.readFileSync(TOKEN_FILE, 'utf8').trim()).toBe(existing48);
  });

  it('initializeBridgeToken preserves existing valid 64-hex token without overwriting', async () => {
    const existing64 = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, existing64, { encoding: 'utf8', mode: 0o600 });

    const token = await initializeBridgeToken();
    expect(token).toBe(existing64);
    expect(fs.readFileSync(TOKEN_FILE, 'utf8').trim()).toBe(existing64);
  });

  it('readBridgeToken does not create directory or file when missing', () => {
    expect(() => readBridgeToken()).toThrow(/not found or unreadable/i);
    expect(fs.existsSync(TOKEN_DIR)).toBe(false);
    expect(fs.existsSync(TOKEN_FILE)).toBe(false);
  });

  it('readBridgeToken does not mutate cachedToken', () => {
    const existing64 = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, existing64, { encoding: 'utf8', mode: 0o600 });

    const readVal = readBridgeToken();
    expect(readVal).toBe(existing64);
    expect(() => getBridgeToken()).toThrow(/not initialized/i);
  });

  it('getBridgeToken throws if server has not initialized token', () => {
    expect(() => getBridgeToken()).toThrow(/not initialized/i);
  });

  it('concurrent initializeBridgeToken calls resolve to the identical token value', async () => {
    const [t1, t2] = await Promise.all([initializeBridgeToken(), initializeBridgeToken()]);
    expect(t1).toBe(t2);
    expect(fs.readFileSync(TOKEN_FILE, 'utf8').trim()).toBe(t1);
  });

  it('fails explicitly on corrupt token and does not fall back to ephemeral memory token', async () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, 'corrupt_short_token', 'utf8');

    await expect(initializeBridgeToken()).rejects.toThrow(/Corrupt bridge token/i);
    expect(() => readBridgeToken()).toThrow(/Corrupt bridge token/i);
  });

  it('fails explicitly on permission error and does not fall back to memory token', async () => {
    const writeSpy = jest
      .spyOn(fs.promises, 'writeFile')
      .mockRejectedValueOnce({ code: 'EACCES', message: 'permission denied' } as any);
    try {
      await expect(initializeBridgeToken()).rejects.toMatchObject({ code: 'EACCES' });
      expect(() => getBridgeToken()).toThrow(/not initialized/i);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('handles transient empty file during concurrent creation', async () => {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, '', 'utf8');

    const delayedToken = crypto.randomBytes(32).toString('hex');
    setTimeout(() => {
      fs.writeFileSync(TOKEN_FILE, delayedToken, 'utf8');
    }, 25);

    const token = await initializeBridgeToken();
    expect(token).toBe(delayedToken);
  });

  it('readBridgeToken reads rotated/updated token without setting cache', () => {
    const token1 = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token1, 'utf8');
    expect(readBridgeToken()).toBe(token1);

    const token2 = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token2, 'utf8');
    expect(readBridgeToken()).toBe(token2);
    expect(() => getBridgeToken()).toThrow(/not initialized/i);
  });

  it('isValidBridgeToken validates token matching using timingSafeEqual', async () => {
    const token = await initializeBridgeToken();
    expect(isValidBridgeToken(token)).toBe(true);
    expect(
      isValidBridgeToken('wrong-token-value-with-same-length-01234567890123456789012345678912'),
    ).toBe(false);
    expect(isValidBridgeToken('short')).toBe(false);
    expect(isValidBridgeToken('')).toBe(false);
    expect(isValidBridgeToken(null as any)).toBe(false);
  });
});
