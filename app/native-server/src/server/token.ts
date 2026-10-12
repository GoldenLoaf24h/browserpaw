import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export const TOKEN_DIR = path.join(os.homedir(), '.chrome-mcp');
export const TOKEN_FILE = path.join(TOKEN_DIR, 'bridge-token');

const TOKEN_PATTERN = /^[0-9a-fA-F]{48}$|^[0-9a-fA-F]{64}$/;

export function isValidTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token.trim());
}

let cachedToken: string | null = null;

export async function initializeBridgeToken(): Promise<string> {
  await fs.promises.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });

  try {
    let content = await fs.promises.readFile(TOKEN_FILE, 'utf8');
    if (content.trim().length === 0) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        content = await fs.promises.readFile(TOKEN_FILE, 'utf8');
        if (content.trim().length > 0) break;
      }
    }
    const trimmed = content.trim();
    if (!isValidTokenFormat(trimmed)) {
      throw new Error('Corrupt bridge token in ' + TOKEN_FILE + ': format invalid');
    }
    cachedToken = trimmed;
    return cachedToken;
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  const freshToken = crypto.randomBytes(32).toString('hex');
  try {
    await fs.promises.writeFile(TOKEN_FILE, freshToken, {
      flag: 'wx',
      mode: 0o600,
      encoding: 'utf8',
    });
    cachedToken = freshToken;
    return cachedToken;
  } catch (writeErr: any) {
    if (writeErr.code === 'EEXIST') {
      return await initializeBridgeToken();
    }
    throw writeErr;
  }
}

export function readBridgeToken(): string {
  let content: string;
  try {
    content = fs.readFileSync(TOKEN_FILE, 'utf8');
  } catch (err: any) {
    throw new Error('Bridge token not found or unreadable at ' + TOKEN_FILE + ': ' + err.message);
  }
  const trimmed = content.trim();
  if (!isValidTokenFormat(trimmed)) {
    throw new Error('Corrupt bridge token in ' + TOKEN_FILE + ': format invalid');
  }
  return trimmed;
}

export function getBridgeToken(): string {
  if (!cachedToken) {
    throw new Error('Bridge token not initialized. Native server must initialize the token first.');
  }
  return cachedToken;
}

export function clearBridgeTokenCache(): void {
  cachedToken = null;
}

export function isValidBridgeToken(provided?: string | null): boolean {
  if (!provided || typeof provided !== 'string') return false;
  let expected: string;
  try {
    expected = getBridgeToken();
  } catch {
    return false;
  }
  const pBuf = Buffer.from(provided);
  const eBuf = Buffer.from(expected);
  if (pBuf.length !== eBuf.length) return false;
  return crypto.timingSafeEqual(pBuf, eBuf);
}
