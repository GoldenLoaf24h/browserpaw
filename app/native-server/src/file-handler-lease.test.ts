import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileHandler } from './file-handler';
import { METADATA_FILE } from './file-lease-store';

describe('backing file leases', () => {
  let root: string;
  let now: number;
  let clock: () => number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'browserpaw-file-lease-'));
    now = Date.UTC(2026, 9, 27, 12);
    clock = () => now;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createHandler() {
    return new FileHandler({ tempDir: root, now: clock });
  }

  async function prepare(handler: FileHandler, name = 'notes.txt', content = 'lease data') {
    return handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from(content).toString('base64'),
      fileName: name,
    });
  }

  it('returns an asset and lease handle for prepared temporary files', async () => {
    const handler = createHandler();
    const prepared = await prepare(handler);

    expect(prepared.success).toBe(true);
    expect(prepared.assetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.readFileSync(prepared.filePath, 'utf8')).toBe('lease data');
  });

  it('keeps selected and unknown deliveries past one hour while retained', async () => {
    const handler = createHandler();
    const selected = await prepare(handler, 'selected.txt');
    const unknown = await prepare(handler, 'unknown.txt');

    for (const [prepared, delivery] of [
      [selected, 'selected'],
      [unknown, 'unknown'],
    ] as const) {
      const retained = await handler.handleFileRequest({
        action: 'retainFileLease',
        assetId: prepared.assetId,
        leaseId: prepared.leaseId,
        delivery,
        tabId: 7,
        documentId: 'doc-7',
      });
      expect(retained.success).toBe(true);
      expect(retained.lease.delivery).toBe(delivery);
    }

    now += 61 * 60 * 1000;
    handler.cleanupOldFiles();

    expect(fs.existsSync(selected.filePath)).toBe(true);
    expect(fs.existsSync(unknown.filePath)).toBe(true);
  });

  it('restores active metadata beyond 24 hours and renews after reconcile', async () => {
    const first = createHandler();
    const prepared = await prepare(first, 'restart.txt');
    await first.handleFileRequest({
      action: 'retainFileLease',
      assetId: prepared.assetId,
      leaseId: prepared.leaseId,
      delivery: 'selected',
      tabId: 3,
      documentId: 'doc-3',
    });

    now += 25 * 60 * 60 * 1000;
    const restarted = createHandler();

    expect(fs.existsSync(prepared.filePath)).toBe(true);
    const reconciled = await restarted.handleFileRequest({
      action: 'reconcileFileLeases',
      leases: [
        {
          assetId: prepared.assetId,
          leaseId: prepared.leaseId,
          delivery: 'selected',
          consumer: { tabId: 3, documentId: 'doc-3' },
        },
      ],
    });
    expect(reconciled.success).toBe(true);
    const renewed = await restarted.handleFileRequest({
      action: 'renewFileLease',
      assetId: prepared.assetId,
      leaseId: prepared.leaseId,
    });
    expect(renewed.success).toBe(true);
    expect(renewed.lease.filePath).toBe(path.resolve(prepared.filePath));
  });

  it('isolates concurrent files with the same name and rejects crossed lease identities', async () => {
    const handler = createHandler();
    const [first, second] = await Promise.all([
      prepare(handler, 'same.txt', 'first'),
      prepare(handler, 'same.txt', 'second'),
    ]);

    expect(first.filePath).not.toBe(second.filePath);
    expect(fs.readFileSync(first.filePath, 'utf8')).toBe('first');
    expect(fs.readFileSync(second.filePath, 'utf8')).toBe('second');

    const crossed = await handler.handleFileRequest({
      action: 'retainFileLease',
      assetId: first.assetId,
      leaseId: second.leaseId,
      delivery: 'selected',
    });
    expect(crossed.success).toBe(false);
    expect(fs.existsSync(first.filePath)).toBe(true);
    expect(fs.existsSync(second.filePath)).toBe(true);
  });

  it('releases the lease and backing file by identity', async () => {
    const handler = createHandler();
    const prepared = await prepare(handler);

    const released = await handler.handleFileRequest({
      action: 'releaseFileLease',
      assetId: prepared.assetId,
      leaseId: prepared.leaseId,
    });

    expect(released.success).toBe(true);
    expect(fs.existsSync(prepared.filePath)).toBe(false);
    const renewed = await handler.handleFileRequest({
      action: 'renewFileLease',
      leaseId: prepared.leaseId,
    });
    expect(renewed.success).toBe(false);
  });

  it('does not reclaim pending prepares that are absent from a reconcile snapshot', async () => {
    const handler = createHandler();
    const pending = await prepare(handler, 'pending.txt');
    const retained = await prepare(handler, 'retained.txt');
    await handler.handleFileRequest({
      action: 'retainFileLease',
      assetId: retained.assetId,
      leaseId: retained.leaseId,
      delivery: 'selected',
      tabId: 9,
      documentId: 'doc-9',
    });

    const result = await handler.handleFileRequest({
      action: 'reconcileFileLeases',
      leases: [
        {
          assetId: retained.assetId,
          leaseId: retained.leaseId,
          delivery: 'selected',
          consumer: { tabId: 9, documentId: 'doc-9' },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.released).toBe(0);
    expect(fs.existsSync(pending.filePath)).toBe(true);
    expect(fs.existsSync(retained.filePath)).toBe(true);
  });

  it('expires only undelivered pending files by TTL', async () => {
    const first = createHandler();
    const pending = await prepare(first, 'pending-ttl.txt');

    now += 61 * 60 * 1000;
    const restarted = createHandler();

    expect(fs.existsSync(pending.filePath)).toBe(false);
    const renewed = await restarted.handleFileRequest({
      action: 'renewFileLease',
      assetId: pending.assetId,
      leaseId: pending.leaseId,
    });
    expect(renewed.success).toBe(false);
  });

  it('reconciles a reconnect list and reclaims leases no longer consumed', async () => {
    const handler = createHandler();
    const kept = await prepare(handler, 'kept.txt');
    const stale = await prepare(handler, 'stale.txt');
    for (const prepared of [kept, stale]) {
      await handler.handleFileRequest({
        action: 'retainFileLease',
        assetId: prepared.assetId,
        leaseId: prepared.leaseId,
        delivery: 'selected',
        tabId: 9,
        documentId: 'doc-9',
      });
    }

    const result = await handler.handleFileRequest({
      action: 'reconcileFileLeases',
      leases: [
        {
          assetId: kept.assetId,
          leaseId: kept.leaseId,
          delivery: 'selected',
          tabId: 9,
          documentId: 'doc-9',
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.released).toBe(1);
    expect(fs.existsSync(kept.filePath)).toBe(true);
    expect(fs.existsSync(stale.filePath)).toBe(false);
  });

  it('does not delete retained files from an over-one-hour directory mtime scan', async () => {
    const handler = createHandler();
    const prepared = await prepare(handler, 'long-lived.txt');
    await handler.handleFileRequest({
      action: 'retainFileLease',
      assetId: prepared.assetId,
      leaseId: prepared.leaseId,
      delivery: 'selected',
      keep: true,
      tabId: 12,
      documentId: 'keep-doc',
    });

    const directory = path.dirname(prepared.filePath);
    const old = new Date(now - 2 * 60 * 60 * 1000);
    fs.utimesSync(directory, old, old);
    now += 25 * 60 * 60 * 1000;
    handler.cleanupOldFiles();

    expect(fs.existsSync(prepared.filePath)).toBe(true);
  });

  it('rejects lease paths outside the managed temporary root', async () => {
    const handler = createHandler();
    const outside = path.join(os.tmpdir(), `browserpaw-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'outside');
    try {
      const result = await handler.handleFileRequest({
        action: 'cleanupFile',
        filePath: outside,
      });
      expect(result.success).toBe(false);
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it('does not issue a lease when preparation fails', async () => {
    const handler = createHandler();
    const failed = await handler.handleFileRequest({
      action: 'prepareFile',
    });

    expect(failed.success).toBe(false);
    expect(failed.assetId).toBeUndefined();
    expect(failed.leaseId).toBeUndefined();
  });

  it('blocks automatic cleanup when lease metadata is corrupt', async () => {
    const handler = createHandler();
    const prepared = await prepare(handler, 'recoverable.txt');
    const metadataPath = path.join(root, METADATA_FILE);
    fs.writeFileSync(metadataPath, '{not-json', 'utf8');

    const restarted = createHandler();
    restarted.cleanupOldFiles();

    expect(fs.existsSync(prepared.filePath)).toBe(true);
    expect(restarted.getLeaseRecoveryError()).toContain('metadata');
  });
});
