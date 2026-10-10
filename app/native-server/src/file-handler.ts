import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import fetch from 'node-fetch';

import * as dns from 'dns';
import { mediaAssetStore } from './media-asset-store';
import { getChromeMcpPort, SERVER_CONFIG } from './constant';

/**
 * Parses IPv6 address into 8 16-bit numeric blocks, supporting compression (::)
 * and embedded IPv4 notations (::ffff:127.0.0.1 or ::ffff:7f00:1).
 */
function parseIpv6Blocks(ip: string): number[] | null {
  const norm = ip.toLowerCase();
  const doubleColon = norm.indexOf('::');
  const leftParts =
    doubleColon !== -1 ? norm.slice(0, doubleColon).split(':').filter(Boolean) : norm.split(':');
  const rightParts =
    doubleColon !== -1
      ? norm
          .slice(doubleColon + 2)
          .split(':')
          .filter(Boolean)
      : [];

  // Handle embedded IPv4 (e.g., ::ffff:127.0.0.1)
  const lastPart =
    rightParts.length > 0 ? rightParts[rightParts.length - 1] : leftParts[leftParts.length - 1];
  let embeddedV4: number[] | null = null;
  if (lastPart && lastPart.includes('.')) {
    if (net.isIPv4(lastPart)) {
      const v4Bytes = lastPart.split('.').map((p) => Number.parseInt(p, 10));
      embeddedV4 = [(v4Bytes[0] << 8) | v4Bytes[1], (v4Bytes[2] << 8) | v4Bytes[3]];
      if (rightParts.length > 0) rightParts.pop();
      else leftParts.pop();
    } else {
      return null;
    }
  }

  const leftNums = leftParts.map((p) => Number.parseInt(p, 16));
  const rightNums = rightParts.map((p) => Number.parseInt(p, 16));
  if (leftNums.some(isNaN) || rightNums.some(isNaN)) return null;
  if (embeddedV4) rightNums.push(...embeddedV4);

  const missing = 8 - (leftNums.length + rightNums.length);
  if (missing < 0) return null;
  if (doubleColon === -1 && missing !== 0) return null;
  const middle = new Array(missing).fill(0);
  return [...leftNums, ...middle, ...rightNums];
}

/**
 * Check whether an IP string belongs to private, loopback, or link-local ranges.
 */
export function isPrivateOrBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return true;

    // 0.0.0.0/8 (Current network)
    if (parts[0] === 0) return true;
    // 10.0.0.0/8 (Private RFC 1918)
    if (parts[0] === 10) return true;
    // 100.64.0.0/10 (Shared Address Space / CGNAT RFC 6598)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (Link-Local & Cloud Metadata e.g. 169.254.169.254)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12 (Private RFC 1918)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
    // 192.168.0.0/16 (Private RFC 1918)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 198.18.0.0/15 (Network Benchmark Tests)
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
    // 224.0.0.0/4 (Multicast/Reserved 224-255, including broadcast)
    if (parts[0] >= 224) return true;

    return false;
  }

  if (net.isIPv6(ip)) {
    const blocks = parseIpv6Blocks(ip);
    if (!blocks) return true; // Malformed IPv6 representation: fail-safe block

    // Unspecified :: (all 0)
    if (blocks.every((b) => b === 0)) return true;

    // Loopback ::1
    if (blocks.every((b, i) => (i === 7 ? b === 1 : b === 0))) return true;

    // IPv4-mapped IPv6 (::ffff:w.x.y.z or ::ffff:hex:hex)
    if (
      blocks[0] === 0 &&
      blocks[1] === 0 &&
      blocks[2] === 0 &&
      blocks[3] === 0 &&
      blocks[4] === 0 &&
      blocks[5] === 0xffff
    ) {
      const v4 = `${(blocks[6] >> 8) & 0xff}.${blocks[6] & 0xff}.${(blocks[7] >> 8) & 0xff}.${blocks[7] & 0xff}`;
      return isPrivateOrBlockedIp(v4);
    }

    // 6to4 encapsulation (2002::/16) - embeds IPv4 in blocks 1 and 2
    if (blocks[0] === 0x2002) {
      const v4 = `${(blocks[1] >> 8) & 0xff}.${blocks[1] & 0xff}.${(blocks[2] >> 8) & 0xff}.${blocks[2] & 0xff}`;
      if (isPrivateOrBlockedIp(v4)) return true;
    }

    // Unique local address fc00::/7 (0xfc00 - 0xfdff)
    if ((blocks[0] & 0xfe00) === 0xfc00) return true;

    // Link-local unicast fe80::/10 (0xfe80 - 0xfebf)
    if ((blocks[0] & 0xffc0) === 0xfe80) return true;

    // Discard-only 100::/64 (RFC 6666)
    if (blocks[0] === 0x0100 && blocks[1] === 0 && blocks[2] === 0 && blocks[3] === 0) return true;

    // Documentation 2001:db8::/32 (RFC 3849)
    if (blocks[0] === 0x2001 && blocks[1] === 0x0db8) return true;

    // Multicast ff00::/8
    if ((blocks[0] & 0xff00) === 0xff00) return true;

    return false;
  }

  return false;
}

/**
 * Validate URL to prevent SSRF against internal/cloud metadata addresses (synchronous format check).
 */
export function assertSafeUrl(fileUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw new Error(`Invalid file URL: ${fileUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `SSRF Protection: Disallowed protocol '${parsed.protocol}'. Only http: and https: are permitted.`,
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const cleanHost =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (
    cleanHost === 'localhost' ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local') ||
    cleanHost.endsWith('.internal') ||
    cleanHost.endsWith('.localdomain')
  ) {
    throw new Error(`SSRF Protection: Access to local domain '${hostname}' is forbidden.`);
  }

  if (isPrivateOrBlockedIp(cleanHost)) {
    throw new Error(
      `SSRF Protection: Access to private/internal IP address '${hostname}' is forbidden.`,
    );
  }

  return parsed;
}

/**
 * Validate URL and asynchronously resolve hostname to block DNS-rebinding and domain-cloaked SSRF.
 */
export async function assertSafeUrlAsync(fileUrl: string): Promise<URL> {
  const parsed = assertSafeUrl(fileUrl);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const cleanHost =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (!net.isIP(cleanHost)) {
    try {
      const addresses = await dns.promises.lookup(cleanHost, { all: true });
      for (const record of addresses) {
        if (isPrivateOrBlockedIp(record.address)) {
          throw new Error(
            `SSRF Protection: Hostname '${cleanHost}' resolves to private/internal IP address '${record.address}'.`,
          );
        }
      }
    } catch (err: any) {
      if (err.message?.includes('SSRF Protection:')) {
        throw err;
      }
      throw new Error(`SSRF Protection: Could not resolve hostname '${cleanHost}': ${err.message}`);
    }
  }

  return parsed;
}

/**
 * Maximum download / file upload size limit (50MB).
 */
export const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;

/**
 * Custom DNS lookup for HTTP/HTTPS agents that validates resolved IP addresses
 * immediately when the TCP connection is initiated, eliminating TOCTOU DNS rebinding windows.
 */
export function safeLookup(
  hostname: string,
  options: dns.LookupOptions | number,
  callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void,
): void {
  const cb = typeof options === 'function' ? options : callback;
  const opts =
    typeof options === 'function'
      ? {}
      : typeof options === 'number'
        ? { family: options }
        : options || {};

  const cleanHost = hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (
    cleanHost === 'localhost' ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local') ||
    cleanHost.endsWith('.internal') ||
    cleanHost.endsWith('.localdomain')
  ) {
    cb(
      new Error(`SSRF Protection: Access to local domain '${hostname}' is forbidden.`),
      '' as any,
      4,
    );
    return;
  }
  if (net.isIP(cleanHost) && isPrivateOrBlockedIp(cleanHost)) {
    cb(
      new Error(
        `SSRF Protection: Access to private/internal IP address '${hostname}' is forbidden.`,
      ),
      '' as any,
      4,
    );
    return;
  }

  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) {
      cb(err, '' as any, 4);
      return;
    }
    const records = Array.isArray(addresses) ? addresses : [addresses];
    if (!records || records.length === 0) {
      const notFoundErr: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      notFoundErr.code = 'ENOTFOUND';
      cb(notFoundErr, '' as any, 4);
      return;
    }
    for (const record of records) {
      const addr = typeof record === 'string' ? record : record?.address;
      if (!addr || isPrivateOrBlockedIp(addr)) {
        cb(
          new Error(
            `SSRF Protection: Hostname '${hostname}' resolves to private/internal IP address '${addr || 'unknown'}'.`,
          ),
          '' as any,
          4,
        );
        return;
      }
    }
    if (opts && typeof opts === 'object' && (opts as any).all) {
      cb(null, addresses as any, 4);
      return;
    }
    const first = records[0];
    const addr = typeof first === 'string' ? first : first?.address;
    const fam = typeof first === 'string' ? 4 : first?.family || 4;
    cb(null, addr, fam);
  });
}

const safeHttpAgent = new http.Agent({ lookup: safeLookup, keepAlive: false });
const safeHttpsAgent = new https.Agent({ lookup: safeLookup, keepAlive: false });

export function getSafeAgent(parsedUrl: URL): http.Agent | https.Agent {
  return parsedUrl.protocol === 'https:' ? safeHttpsAgent : safeHttpAgent;
}

/**
 * File handler for managing file uploads through the native messaging host
 */
export class FileHandler {
  private tempDir: string;

  constructor() {
    // Create a temp directory for file operations
    this.tempDir = path.join(os.tmpdir(), 'chrome-mcp-uploads');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    // Clean up old temporary files upon startup and schedule periodic cleanup
    try {
      this.cleanupOldFiles();
    } catch {}
    const cleanupTimer = setInterval(() => this.cleanupOldFiles(), 30 * 60 * 1000);
    cleanupTimer.unref();
  }

  /**
   * Helper to compute safe destination path inside this.tempDir, forbidding path traversal
   */
  private getSafeTempFilePath(
    fileName?: string,
    defaultPrefix = 'upload',
  ): { filePath: string; fileName: string } {
    let rawName = fileName;
    if (rawName) {
      // Normalize both POSIX and Windows separators for cross-platform traversal prevention
      const sanitized = rawName.trim().replace(/\\/g, '/');
      rawName = path.basename(sanitized);
    }
    if (!rawName || rawName === '.' || rawName === '..') {
      rawName = `${defaultPrefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`;
    }

    const resolvedTempDir = path.resolve(this.tempDir);
    // Isolate each request inside its own unique subdirectory using randomUUID
    // to preserve the original filename/extension on disk without collision across concurrent requests.
    const requestDir = path.join(resolvedTempDir, crypto.randomUUID());
    fs.mkdirSync(requestDir, { recursive: true });

    const resolvedPath = path.resolve(requestDir, rawName);

    const normTempDir =
      process.platform === 'win32' ? resolvedTempDir.toLowerCase() : resolvedTempDir;
    const normPath = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;

    if (!normPath.startsWith(normTempDir + path.sep)) {
      throw new Error(
        'Access denied: target path must reside strictly within the temporary directory',
      );
    }

    return { filePath: resolvedPath, fileName: rawName };
  }

  /**
   * Handle file preparation request from the extension
   */
  async handleFileRequest(request: any): Promise<any> {
    const { action, fileUrl, base64Data, fileName, filePath, traceFilePath, insightName } = request;

    try {
      switch (action) {
        case 'prepareFile':
          if (fileUrl) {
            return await this.downloadFile(fileUrl, fileName);
          } else if (base64Data) {
            return await this.saveBase64File(base64Data, fileName);
          } else if (filePath) {
            return await this.verifyFile(filePath);
          }
          break;

        case 'readBase64File': {
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.readBase64File(filePath);
        }

        case 'readMediaFile': {
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.readMediaFile(filePath);
        }

        case 'cleanupFile':
          return await this.cleanupFile(filePath);

        case 'analyzeTrace': {
          const targetPath = traceFilePath || filePath;
          if (!targetPath) {
            return { success: false, error: 'traceFilePath is required' };
          }
          const resolvedPath = path.resolve(targetPath);
          const resolvedTempDir = path.resolve(this.tempDir);
          const normalizedPath =
            process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
          const normalizedTempDir =
            process.platform === 'win32' ? resolvedTempDir.toLowerCase() : resolvedTempDir;
          if (!normalizedPath.startsWith(normalizedTempDir + path.sep)) {
            return {
              success: false,
              error: 'Access denied: traceFilePath must be strictly within the temp directory',
            };
          }
          try {
            // With tsconfig moduleResolution=NodeNext, relative ESM imports need explicit .js extension
            const { analyzeTraceFile } = await import('./trace-analyzer.js');
            const res = await analyzeTraceFile(resolvedPath, insightName);
            return { success: true, ...res };
          } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
          }
        }

        default:
          return {
            success: false,
            error: `Unknown file action: ${action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Download a file from URL and save to temp directory
   */
  private async downloadFile(fileUrl: string, fileName?: string): Promise<any> {
    try {
      let currentUrl = fileUrl;
      const MAX_REDIRECTS = 5;
      let redirectCount = 0;
      let response: any;

      while (true) {
        await assertSafeUrlAsync(currentUrl);
        const parsed = new URL(currentUrl);
        response = await fetch(currentUrl, {
          redirect: 'manual',
          agent: getSafeAgent(parsed),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          try {
            response.body?.destroy?.();
          } catch {
            // ignore cleanup error
          }
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            throw new Error(`Too many redirects (limit ${MAX_REDIRECTS})`);
          }
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`Redirect status ${response.status} missing Location header`);
          }
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        break;
      }

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      // Early Content-Length check if provided by upstream server
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > MAX_DOWNLOAD_SIZE) {
          throw new Error(`File size exceeds limit of ${MAX_DOWNLOAD_SIZE} bytes (50MB)`);
        }
      }

      const candidateName = fileName || this.generateFileName(currentUrl);
      const { filePath, fileName: finalFileName } = this.getSafeTempFilePath(
        candidateName,
        'download',
      );

      // Stream response to disk with running size counter to avoid OOM and event loop blocking
      const fileStream = fs.createWriteStream(filePath);
      let downloadedBytes = 0;

      try {
        await new Promise<void>((resolve, reject) => {
          let aborted = false;

          response.body.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (downloadedBytes > MAX_DOWNLOAD_SIZE) {
              aborted = true;
              response.body.destroy();
              fileStream.destroy();
              reject(
                new Error(
                  `Download exceeded maximum allowed size of ${MAX_DOWNLOAD_SIZE} bytes (50MB)`,
                ),
              );
            }
          });

          response.body.on('error', (err: Error) => {
            if (!aborted) {
              fileStream.destroy();
              reject(err);
            }
          });

          fileStream.on('error', (err: Error) => {
            if (!aborted) {
              response.body.destroy();
              reject(err);
            }
          });

          fileStream.on('finish', () => {
            if (!aborted) {
              resolve();
            }
          });

          response.body.pipe(fileStream);
        });
      } catch (streamErr) {
        try {
          if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
          }
        } catch {
          // ignore cleanup errors
        }
        throw streamErr;
      }

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: downloadedBytes,
      };
    } catch (error) {
      throw new Error(
        `Failed to download file from URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Save base64 data as a file
   */
  private async saveBase64File(base64Data: string, fileName?: string): Promise<any> {
    try {
      // Remove data URL prefix if present
      const base64Content = base64Data.replace(/^data:.*?;base64,/, '');

      // Early fast rejection before allocating large buffers in memory
      const estimatedSize = Math.floor((base64Content.length * 3) / 4);
      if (estimatedSize > MAX_DOWNLOAD_SIZE + 1024) {
        throw new Error(`File size exceeds limit of ${MAX_DOWNLOAD_SIZE} bytes (50MB)`);
      }

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Content, 'base64');
      if (buffer.length > MAX_DOWNLOAD_SIZE) {
        throw new Error(`File size exceeds limit of ${MAX_DOWNLOAD_SIZE} bytes (50MB)`);
      }

      const candidateName =
        fileName || `upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`;
      const { filePath, fileName: finalFileName } = this.getSafeTempFilePath(
        candidateName,
        'upload',
      );

      // Save to file asynchronously to prevent blocking the event loop
      await fs.promises.writeFile(filePath, buffer);

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(
        `Failed to save base64 file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Verify that a file exists and is accessible
   */
  private async verifyFile(filePath: string): Promise<any> {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Get file stats
      const stats = fs.statSync(filePath);

      // Check if it's actually a file
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }

      // Check if file is readable
      fs.accessSync(filePath, fs.constants.R_OK);

      return {
        success: true,
        filePath: filePath,
        fileName: path.basename(filePath),
        size: stats.size,
      };
    } catch (error) {
      throw new Error(`Failed to verify file: ${error}`);
    }
  }

  /**
   * Read media file from local disk (images, videos, documents)
   * Supports files up to MAX_DOWNLOAD_SIZE (50MB).
   */
  async readMediaFile(filePath: string): Promise<any> {
    try {
      const resolvedPath = path.resolve(filePath);
      // Reject traversal into sensitive user configuration or key stores
      if (/([/\\])(\.ssh|\.aws|\.gnupg|\.config|\.chrome-mcp|\.env)([/\\]|$)/i.test(resolvedPath)) {
        throw new Error('Access to sensitive directories is prohibited');
      }
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Media file does not exist: ${filePath}`);
      }
      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }
      if (stats.size > MAX_DOWNLOAD_SIZE) {
        throw new Error(`File size (${stats.size} bytes) exceeds limit of 50MB`);
      }
      const ext = path.extname(resolvedPath).toLowerCase();
      const MEDIA_MIMES: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.pdf': 'application/pdf',
      };
      const mimeType = MEDIA_MIMES[ext];
      if (!mimeType) {
        throw new Error(
          `Unsupported media file extension: ${ext}. Only image, video, and PDF files are allowed.`,
        );
      }

      if (stats.size > 650 * 1024) {
        const assetId = crypto.randomUUID();
        mediaAssetStore.set(assetId, {
          filePath: resolvedPath,
          mimeType,
          fileName: path.basename(resolvedPath),
        });
        const port = getChromeMcpPort();
        return {
          success: true,
          filePath: resolvedPath,
          fileName: path.basename(resolvedPath),
          size: stats.size,
          mimeType,
          mediaUrl: `http://${SERVER_CONFIG.HOST}:${port}/media-asset/${assetId}`,
        };
      }

      const buf = await fs.promises.readFile(resolvedPath);
      const base64 = buf.toString('base64');

      return {
        success: true,
        filePath: resolvedPath,
        fileName: path.basename(resolvedPath),
        size: stats.size,
        mimeType,
        base64Data: base64,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read media file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Read file content and return as base64 string
   */
  private async readBase64File(filePath: string): Promise<any> {
    try {
      const resolvedPath = path.resolve(filePath);
      const resolvedTempDir = path.resolve(this.tempDir);
      const normalizedPath =
        process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
      const normalizedTempDir =
        process.platform === 'win32' ? resolvedTempDir.toLowerCase() : resolvedTempDir;
      if (!normalizedPath.startsWith(normalizedTempDir + path.sep)) {
        return {
          success: false,
          error: 'Access denied: filePath must be strictly within the temp directory',
        };
      }

      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }
      if (stats.size > MAX_DOWNLOAD_SIZE) {
        throw new Error(`File size exceeds limit of ${MAX_DOWNLOAD_SIZE} bytes (50MB)`);
      }
      // Chrome Native Messaging pipe ceiling is 1MB. Base64 encoding inflates binary by 33%.
      // Files > 700KB produce > 933KB Base64 + JSON metadata > 1MB, which will crash the Native Messaging pipe.
      const MAX_PIPE_BASE64_BYTES = 700 * 1024;
      if (stats.size > MAX_PIPE_BASE64_BYTES) {
        throw new Error(
          `File size (${stats.size} bytes) exceeds limit of 700KB for native messaging base64 pipe. Access directly via filePath: "${resolvedPath}"`,
        );
      }
      const buf = await fs.promises.readFile(resolvedPath);
      const base64 = buf.toString('base64');
      return {
        success: true,
        filePath: resolvedPath,
        fileName: path.basename(resolvedPath),
        size: stats.size,
        base64Data: base64,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Clean up a temporary file
   */
  private async cleanupFile(filePath: string): Promise<any> {
    try {
      // Only allow cleanup of files strictly inside our temp directory
      const resolvedPath = path.resolve(filePath);
      const resolvedTempDir = path.resolve(this.tempDir);
      const normalizedPath =
        process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
      const normalizedTempDir =
        process.platform === 'win32' ? resolvedTempDir.toLowerCase() : resolvedTempDir;
      if (!normalizedPath.startsWith(normalizedTempDir + path.sep)) {
        return {
          success: false,
          error: 'Can only cleanup files strictly within temp directory',
        };
      }

      if (fs.existsSync(resolvedPath)) {
        await fs.promises.unlink(resolvedPath);
      }
      const parentDir = path.dirname(resolvedPath);
      if (parentDir !== resolvedTempDir) {
        const normParent = process.platform === 'win32' ? parentDir.toLowerCase() : parentDir;
        if (normParent.startsWith(normalizedTempDir + path.sep)) {
          // Only remove empty directory using rmdir; preserves any sibling files
          await fs.promises.rmdir(parentDir).catch(() => {});
        }
      }

      return {
        success: true,
        message: 'File cleaned up successfully',
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup file: ${error}`,
      };
    }
  }

  /**
   * Generate a filename from URL or create a unique one
   */
  private generateFileName(url?: string): string {
    if (url) {
      try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const basename = path.basename(pathname);
        if (basename && basename !== '/') {
          // Add random suffix to avoid collisions
          const ext = path.extname(basename);
          const name = path.basename(basename, ext);
          const randomSuffix = crypto.randomBytes(4).toString('hex');
          return `${name}-${randomSuffix}${ext}`;
        }
      } catch {
        // Invalid URL, fall through to generate random name
      }
    }

    // Generate random filename
    return `upload-${crypto.randomBytes(8).toString('hex')}.bin`;
  }

  /**
   * Clean up old temporary files (older than 1 hour)
   */
  cleanupOldFiles(): void {
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      const entries = fs.readdirSync(this.tempDir);
      for (const entry of entries) {
        const entryPath = path.join(this.tempDir, entry);
        try {
          const lstats = fs.lstatSync(entryPath);
          if (lstats.isSymbolicLink()) {
            continue;
          }
          if (now - lstats.mtimeMs > oneHour) {
            const isUuidDir =
              lstats.isDirectory() &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry);
            if (isUuidDir) {
              fs.rmSync(entryPath, { recursive: true, force: true });
            } else if (lstats.isFile()) {
              fs.unlinkSync(entryPath);
            }
          }
        } catch {}
      }
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}

export default new FileHandler();
