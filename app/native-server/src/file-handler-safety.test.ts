import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { FileHandler, safeLookup, isPrivateOrBlockedIp, MAX_DOWNLOAD_SIZE } from './file-handler';

let tempDir: string;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-safety-test-'));
});
afterEach(() => {
  const resolved = path.resolve(tempDir);
  if (
    !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(resolved).startsWith('browserpaw-safety-test-')
  )
    throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
describe('7. File Handler Security & Path Traversal Boundaries', () => {
  it('analyzeTrace rejects traceFilePath traversal outside temp directory', async () => {
    const handler = new FileHandler({ tempDir });
    const escapePath = path.resolve(tempDir, '..', 'traversal.json');

    const res = await handler.handleFileRequest({
      action: 'analyzeTrace',
      traceFilePath: escapePath,
    });

    assert.strictEqual(res.success, false);
    assert.match(res.error, /strictly within the temp directory/i);
  });

  it('analyzeTrace rejects filePath traversal outside temp directory', async () => {
    const handler = new FileHandler({ tempDir });
    const escapePath = path.resolve(tempDir, '..', 'shadow_secrets.json');

    const res = await handler.handleFileRequest({
      action: 'analyzeTrace',
      filePath: escapePath,
    });

    assert.strictEqual(res.success, false);
    assert.match(res.error, /strictly within the temp directory/i);
  });

  it('analyzeTrace rejects missing path with informative error', async () => {
    const handler = new FileHandler({ tempDir });
    const res = await handler.handleFileRequest({
      action: 'analyzeTrace',
    });

    assert.strictEqual(res.success, false);
    assert.match(res.error, /traceFilePath is required/i);
  });

  it('readBase64File and cleanupFile reject traversal outside temp directory', async () => {
    const handler = new FileHandler({ tempDir });
    const escapePath = path.resolve(tempDir, '..', 'evil.txt');

    const readRes = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: escapePath,
    });
    assert.strictEqual(readRes.success, false);
    assert.match(readRes.error, /strictly within the temp directory/i);

    const cleanupRes = await handler.handleFileRequest({
      action: 'cleanupFile',
      filePath: escapePath,
    });
    assert.strictEqual(cleanupRes.success, false);
    assert.match(cleanupRes.error, /strictly within temp directory/i);
  });
});

describe('P0: File Handler TOCTOU DNS Rebinding SSRF & 50MB Download Limit', () => {
  it('safeLookup rejects loopback, private IPv4, and private IPv6 addresses immediately', async () => {
    const testBlocked = (ip: string) =>
      new Promise<void>((resolve, reject) => {
        safeLookup(ip, {} as any, (err) => {
          if (err && /SSRF Protection/i.test(err.message)) {
            resolve();
          } else {
            reject(new Error(`Expected SSRF Protection error for ${ip}, got: ${err?.message}`));
          }
        });
      });

    await testBlocked('127.0.0.1');
    await testBlocked('10.0.0.1');
    await testBlocked('172.16.0.1');
    await testBlocked('192.168.1.100');
    await testBlocked('169.254.169.254');
    await testBlocked('100.64.0.5');
    await testBlocked('::1');
    await testBlocked('0:0:0:0:0:0:0:1');
    await testBlocked('::');
    await testBlocked('::ffff:127.0.0.1');
    await testBlocked('::ffff:7f00:1');
    await testBlocked('0:0:0:0:0:ffff:7f00:1');
    await testBlocked('2002:7f00:0001::');
    await testBlocked('localhost');

    assert.strictEqual(isPrivateOrBlockedIp('2607:f8b0:4005:805::200e'), false);
  });

  it('safeLookup resolves valid public addresses and forwards IP family', async () => {
    await new Promise<void>((resolve, reject) => {
      safeLookup('93.184.216.34', {} as any, (err, addr, family) => {
        if (err) return reject(err);
        assert.strictEqual(addr, '93.184.216.34');
        assert.strictEqual(family, 4);
        resolve();
      });
    });
  });

  it('enforces 50MB MAX_DOWNLOAD_SIZE limit on base64 and streaming downloads', async () => {
    assert.strictEqual(MAX_DOWNLOAD_SIZE, 50 * 1024 * 1024);

    const handler = new FileHandler({ tempDir });
    const hugeBuffer = Buffer.alloc(MAX_DOWNLOAD_SIZE + 1024);
    const hugeBase64 = hugeBuffer.toString('base64');

    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: hugeBase64,
      fileName: 'oversized.bin',
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /50MB/i);
  });
});
