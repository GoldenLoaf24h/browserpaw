import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type FileLeaseDelivery = 'selected' | 'unknown';

export interface FileLeaseHandle {
  assetId: string;
  leaseId: string;
  filePath: string;
  fileName: string;
  size: number;
}

export interface FileLeaseConsumer {
  tabId?: number;
  frameId?: number;
  documentId?: string;
  keep?: boolean;
}

export interface FileLeaseRecord extends FileLeaseHandle {
  retained: boolean;
  delivery?: FileLeaseDelivery;
  keep: boolean;
  consumer?: FileLeaseConsumer;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface FileLeaseRef {
  assetId?: string;
  leaseId?: string;
}

export interface FileLeaseStoreOptions {
  rootDir: string;
  now?: () => number;
}

export interface FileLeaseRetainOptions extends FileLeaseRef {
  delivery?: FileLeaseDelivery;
  keep?: boolean;
  consumer?: FileLeaseConsumer;
}

export interface FileLeaseReconcileInput {
  leases?: Array<FileLeaseRef & FileLeaseRetainOptions>;
  leaseIds?: string[];
}

export interface FileLeaseOperationResult {
  success: boolean;
  error?: string;
  lease?: FileLeaseRecord;
  handle?: FileLeaseHandle;
  released?: number;
  leases?: FileLeaseRecord[];
}

const METADATA_FILE = '.file-leases.json';
const DEFAULT_PENDING_TTL_MS = 60 * 60 * 1000;

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function cloneLease(record: FileLeaseRecord): FileLeaseRecord {
  return {
    ...record,
    consumer: record.consumer ? { ...record.consumer } : undefined,
  };
}

function handleFromLease(record: FileLeaseRecord): FileLeaseHandle {
  return {
    assetId: record.assetId,
    leaseId: record.leaseId,
    filePath: record.filePath,
    fileName: record.fileName,
    size: record.size,
  };
}

/**
 * Owns the on-disk lease metadata and the files prepared for a browser upload.
 * Metadata is written through a temporary file and renamed, so a process crash
 * cannot leave a partially written lease table.
 */
export class FileLeaseStore {
  readonly rootDir: string;
  readonly metadataPath: string;

  private readonly now: () => number;
  private readonly leases = new Map<string, FileLeaseRecord>();
  private metadataError: string | null = null;

  constructor(options: FileLeaseStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.metadataPath = path.join(this.rootDir, METADATA_FILE);
    this.now = options.now || Date.now;

    fs.mkdirSync(this.rootDir, { recursive: true });
    this.load();
    this.cleanupExpired();
  }

  contains(filePath: string): boolean {
    return this.isInsideRoot(filePath);
  }

  isMetadataPath(filePath: string): boolean {
    return normalizedPath(filePath) === normalizedPath(this.metadataPath);
  }

  getMetadataError(): string | null {
    return this.metadataError;
  }

  create(filePath: string, fileName: string, size: number): FileLeaseRecord {
    this.assertHealthy();
    this.assertManagedPath(filePath);
    const timestamp = this.now();
    const record: FileLeaseRecord = {
      assetId: crypto.randomUUID(),
      leaseId: crypto.randomUUID(),
      filePath: path.resolve(filePath),
      fileName,
      size,
      retained: false,
      keep: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.leases.set(record.leaseId, record);
    try {
      this.persist();
    } catch (error) {
      this.leases.delete(record.leaseId);
      throw error;
    }
    return cloneLease(record);
  }

  get(ref: FileLeaseRef): FileLeaseRecord | null {
    const record = this.find(ref);
    return record ? cloneLease(record) : null;
  }

  list(): FileLeaseRecord[] {
    return Array.from(this.leases.values(), cloneLease);
  }

  retain(options: FileLeaseRetainOptions): FileLeaseOperationResult {
    if (this.metadataError) return this.unhealthyResult();
    const record = this.find(options);
    if (!record) return { success: false, error: 'Lease not found' };
    if (options.delivery && options.delivery !== 'selected' && options.delivery !== 'unknown') {
      return { success: false, error: 'delivery must be selected or unknown' };
    }

    record.retained = true;
    record.delivery = options.delivery || record.delivery;
    record.keep = Boolean(options.keep || record.keep);
    if (options.consumer) record.consumer = { ...options.consumer };
    record.updatedAt = this.now();
    record.expiresAt = undefined;
    this.persist();
    return { success: true, lease: cloneLease(record), handle: handleFromLease(record) };
  }

  renew(ref: FileLeaseRef): FileLeaseOperationResult {
    if (this.metadataError) return this.unhealthyResult();
    const record = this.find(ref);
    if (!record) return { success: false, error: 'Lease not found' };
    record.updatedAt = this.now();
    record.expiresAt = undefined;
    this.persist();
    return { success: true, lease: cloneLease(record), handle: handleFromLease(record) };
  }

  release(ref: FileLeaseRef): FileLeaseOperationResult {
    if (this.metadataError) return this.unhealthyResult();
    const record = this.find(ref);
    if (!record) return { success: false, error: 'Lease not found' };
    this.releaseRecord(record);
    this.persist();
    return {
      success: true,
      released: 1,
      lease: cloneLease(record),
      handle: handleFromLease(record),
    };
  }

  releaseByPath(filePath: string): FileLeaseOperationResult {
    if (this.metadataError) return this.unhealthyResult();
    if (!this.contains(filePath) || this.isMetadataPath(filePath)) {
      return { success: false, error: 'Path is outside the managed temporary directory' };
    }
    const target = normalizedPath(filePath);
    const record = Array.from(this.leases.values()).find(
      (candidate) => normalizedPath(candidate.filePath) === target,
    );
    if (!record) {
      this.removeFileAndDirectory(filePath);
      return { success: true, released: 0 };
    }
    this.releaseRecord(record);
    this.persist();
    return {
      success: true,
      released: 1,
      lease: cloneLease(record),
      handle: handleFromLease(record),
    };
  }

  reconcile(input: FileLeaseReconcileInput = {}): FileLeaseOperationResult {
    if (this.metadataError) return this.unhealthyResult();
    const hasActiveList = Array.isArray(input.leases) || Array.isArray(input.leaseIds);
    if (!hasActiveList) return { success: true, leases: this.list() };

    const active = new Map<string, FileLeaseRetainOptions>();
    for (const entry of input.leases || []) {
      if (!entry?.leaseId) continue;
      const current = this.leases.get(entry.leaseId);
      if (!current || (entry.assetId && current.assetId !== entry.assetId)) continue;
      active.set(entry.leaseId, entry);
    }
    for (const leaseId of input.leaseIds || []) {
      if (leaseId) active.set(leaseId, { leaseId });
    }

    let released = 0;
    for (const record of Array.from(this.leases.values())) {
      const update = active.get(record.leaseId);
      if (update) {
        const hasRetainedEvidence =
          update.delivery === 'selected' || update.delivery === 'unknown' || record.retained;
        if (!hasRetainedEvidence) continue;
        record.retained = true;
        if (update.delivery === 'selected' || update.delivery === 'unknown') {
          record.delivery = update.delivery;
        }
        record.keep = Boolean(update.keep || update.consumer?.keep || record.keep);
        if (update.consumer) record.consumer = { ...update.consumer };
        record.updatedAt = this.now();
        record.expiresAt = undefined;
        continue;
      }
      if (record.retained && !record.keep) {
        this.releaseRecord(record);
        released++;
      }
    }
    this.persist();
    return { success: true, released, leases: this.list() };
  }

  cleanupExpired(): void {
    if (this.metadataError) return;
    let changed = false;
    const now = this.now();
    for (const record of Array.from(this.leases.values())) {
      const expired = !record.retained && now - record.updatedAt > DEFAULT_PENDING_TTL_MS;
      if (expired) {
        this.releaseRecord(record);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.metadataPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8')) as {
        leases?: FileLeaseRecord[];
      };
      if (!Array.isArray(raw.leases)) {
        throw new Error('Lease metadata does not contain a leases array');
      }
      for (const candidate of raw.leases || []) {
        if (
          !candidate?.leaseId ||
          !candidate?.assetId ||
          !candidate?.filePath ||
          typeof candidate.retained !== 'boolean'
        ) {
          throw new Error('Lease metadata contains an invalid record');
        }
        if (!this.isInsideRoot(candidate.filePath) || this.isMetadataPath(candidate.filePath)) {
          throw new Error('Lease metadata contains an out-of-root path');
        }
        if (!fs.existsSync(candidate.filePath)) continue;
        try {
          if (!fs.statSync(candidate.filePath).isFile()) continue;
        } catch {
          continue;
        }
        this.leases.set(candidate.leaseId, {
          ...candidate,
          filePath: path.resolve(candidate.filePath),
          retained: Boolean(candidate.retained),
          keep: Boolean(candidate.keep),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metadataError = `Lease metadata recovery blocked: ${message}`;
      console.error('Failed to load file lease metadata:', error);
    }
  }

  private persist(): void {
    this.assertHealthy();
    const payload = JSON.stringify({ version: 1, leases: this.list() }, null, 2);
    const temporaryPath = `${this.metadataPath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.metadataPath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
      throw error;
    }
  }

  private find(ref: FileLeaseRef): FileLeaseRecord | null {
    if (!ref?.leaseId && !ref?.assetId) return null;
    let record = ref.leaseId ? this.leases.get(ref.leaseId) : undefined;
    if (!record && ref.assetId) {
      record = Array.from(this.leases.values()).find(
        (candidate) => candidate.assetId === ref.assetId,
      );
    }
    if (!record) return null;
    if (ref.leaseId && record.leaseId !== ref.leaseId) return null;
    if (ref.assetId && record.assetId !== ref.assetId) return null;
    return record;
  }

  private releaseRecord(record: FileLeaseRecord): void {
    this.leases.delete(record.leaseId);
    this.removeFileAndDirectory(record.filePath);
  }

  private removeFileAndDirectory(filePath: string): void {
    if (!this.contains(filePath) || this.isMetadataPath(filePath)) return;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
    const parent = path.dirname(path.resolve(filePath));
    if (normalizedPath(parent) === normalizedPath(this.rootDir)) return;
    try {
      fs.rmdirSync(parent);
    } catch {}
  }

  private assertManagedPath(filePath: string): void {
    if (!this.contains(filePath) || this.isMetadataPath(filePath)) {
      throw new Error('Lease path must be inside the managed temporary directory');
    }
  }

  private assertHealthy(): void {
    if (this.metadataError)
      throw new Error(`File lease metadata unavailable: ${this.metadataError}`);
  }

  private unhealthyResult(): FileLeaseOperationResult {
    return {
      success: false,
      error: `File lease metadata unavailable: ${this.metadataError}`,
    };
  }

  private isInsideRoot(filePath: string): boolean {
    const candidate = normalizedPath(filePath);
    const root = normalizedPath(this.rootDir);
    return candidate !== root && candidate.startsWith(root + path.sep);
  }
}

export { METADATA_FILE };
