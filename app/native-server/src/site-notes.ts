import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SiteNoteResult {
  hostname: string;
  found: boolean;
  source?: string;
  content?: string;
  truncated?: boolean;
  isStale?: boolean;
  warning?: string;
}

function extractValidHostname(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const p = new URL(rawUrl.trim());
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    const h = (p.hostname || '').toLowerCase().replace(/\.$/, '');
    return !h ||
      h.includes('..') ||
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)
      ? null
      : h;
  } catch {
    return null;
  }
}

function safeUtf8Slice(buf: Buffer): string {
  let drop = 0;
  for (let i = 1; i <= Math.min(4, buf.length); i++) {
    const b = buf[buf.length - i];
    if ((b & 0x80) === 0) break;
    if ((b & 0xc0) === 0xc0) {
      let needed = 2;
      if ((b & 0xf0) === 0xe0) needed = 3;
      else if ((b & 0xf8) === 0xf0) needed = 4;
      if (i < needed) drop = i;
      break;
    }
  }
  return buf.subarray(0, buf.length - drop).toString('utf8');
}

export function getBuiltinRecipesDir(): string {
  const c1 = path.join(__dirname, 'recipes');
  return fs.existsSync(c1) ? c1 : path.join(__dirname, '..', 'dist', 'recipes');
}

export async function loadSiteNote(url: string): Promise<SiteNoteResult> {
  const hostname = extractValidHostname(url);
  if (!hostname) return { hostname: '', found: false, warning: 'Only http/https URLs allowed.' };
  const recipesDir = getBuiltinRecipesDir();
  if (!fs.existsSync(recipesDir)) return { hostname, found: false };

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(recipesDir);
  } catch {
    return { hostname, found: false };
  }

  const targetFile = path.join(realRoot, `${hostname}.md`);
  if (!fs.existsSync(targetFile)) return { hostname, found: false };

  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(targetFile);
  } catch {
    return { hostname, found: false };
  }
  if (lstat.isSymbolicLink() || !lstat.isFile())
    return { hostname, found: false, warning: 'Symbolic links and non-files are prohibited.' };

  try {
    if (!fs.realpathSync(targetFile).startsWith(realRoot + path.sep))
      return { hostname, found: false, warning: 'Path containment check failed.' };
  } catch {
    return { hostname, found: false };
  }

  const isTruncated = lstat.size > 4096;
  const bytesToRead = isTruncated ? 4096 : lstat.size;
  const buf = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(targetFile, 'r');
  try {
    fs.readSync(fd, buf, 0, bytesToRead, 0);
  } finally {
    fs.closeSync(fd);
  }

  const content = safeUtf8Slice(buf);
  const match = content.match(/Last Verified[^:\d\n]*[:：]\s*(\d{4}-\d{2}-\d{2})/i);
  const d = match ? new Date(match[1]) : null;
  const isStale = !d || Number.isNaN(d.getTime()) || Date.now() - d.getTime() > 90 * 86400 * 1000;

  return {
    hostname,
    found: true,
    source: 'local recipe',
    content,
    truncated: isTruncated,
    isStale,
    ...(isStale
      ? { warning: 'Recipe may be stale or unverified (missing, invalid, or >90d). Confirm live.' }
      : {}),
  };
}
