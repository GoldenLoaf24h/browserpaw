import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export const TOKEN_DIR = process.env.CHROME_MCP_TOKEN_DIR
  ? process.env.CHROME_MCP_TOKEN_DIR
  : path.join(os.homedir(), '.chrome-mcp');
export const TOKEN_FILE = path.join(TOKEN_DIR, 'bridge-token');

let cachedToken: string | null = null;

/**
 * Resolves or generates the high-entropy bridge token.
 * Priority:
 * 1. process.env.CHROME_MCP_TOKEN
 * 2. ~/.chrome-mcp/bridge-token file
 * 3. Fresh crypto random hex token persisted to ~/.chrome-mcp/bridge-token with 0600 permissions
 */
export function resolveBridgeToken(): string {
  if (cachedToken) {
    return cachedToken;
  }

  // 1. Environment variable override
  if (process.env.CHROME_MCP_TOKEN && process.env.CHROME_MCP_TOKEN.trim().length > 0) {
    cachedToken = process.env.CHROME_MCP_TOKEN.trim();
    return cachedToken;
  }

  // 2. File lookup in ~/.chrome-mcp/bridge-token
  try {
    if (!fs.existsSync(TOKEN_DIR)) {
      fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    }

    if (fs.existsSync(TOKEN_FILE)) {
      const content = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (content.length >= 16) {
        cachedToken = content;
        process.env.CHROME_MCP_TOKEN = cachedToken;
        return cachedToken;
      }
    }

    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, generated, { encoding: 'utf8', mode: 0o600 });
    cachedToken = generated;
    process.env.CHROME_MCP_TOKEN = cachedToken;
    return cachedToken;
  } catch {
    // If disk write fails (e.g. read-only fs), generate in-memory token
    const ephemeral = crypto.randomBytes(32).toString('hex');
    cachedToken = ephemeral;
    process.env.CHROME_MCP_TOKEN = cachedToken;
    return cachedToken;
  }
}

export function getBridgeToken(): string {
  if (!cachedToken) {
    return resolveBridgeToken();
  }
  return cachedToken;
}

export function clearBridgeTokenCache(): void {
  cachedToken = null;
}

/**
 * Validates a provided token against the active bridge token using timing-safe comparison.
 */
export function isValidBridgeToken(provided?: string | null): boolean {
  if (!provided || typeof provided !== 'string') return false;
  const expected = getBridgeToken();
  const pBuf = Buffer.from(provided);
  const eBuf = Buffer.from(expected);
  if (pBuf.length !== eBuf.length) return false;
  return crypto.timingSafeEqual(pBuf, eBuf);
}
