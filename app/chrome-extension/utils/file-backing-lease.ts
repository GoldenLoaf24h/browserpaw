export type FileBackingDelivery = 'selected' | 'unknown';

export interface FileBackingHandle {
  assetId: string;
  leaseId: string;
  filePath?: string;
  fileName?: string;
  size?: number;
}

export interface FileBackingConsumer {
  tabId?: number;
  frameId?: number;
  documentId?: string;
  keep?: boolean;
}

export interface FileBackingLease {
  handle: FileBackingHandle;
  assetId: string;
  leaseId: string;
  tabId?: number;
  frameId?: number;
  documentId?: string;
  keep: boolean;
  delivery?: FileBackingDelivery;
  retained: boolean;
  retainAttempted: boolean;
  releasePending?: boolean;
  updatedAt: number;
}

export interface LeaseStorage {
  get(key: string | string[]): Promise<Record<string, any>>;
  set(value: Record<string, any>): Promise<void>;
}

type LeaseSender = (
  message: { type: string; requestId: string; payload: any },
  callback?: (response: any) => void,
) => boolean;

export interface FileBackingLeaseManagerOptions {
  send: LeaseSender;
  storage?: LeaseStorage;
  now?: () => number;
  renewIntervalMs?: number;
  requestTimeoutMs?: number;
  validateConsumer?: (lease: FileBackingLease) => Promise<boolean>;
}

interface NativeActionResult {
  success: boolean;
  sent: boolean;
  payload?: any;
}

const STORAGE_KEY = 'fileBackingLeases.v1';
const DEFAULT_RENEW_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function cloneLease(lease: FileBackingLease): FileBackingLease {
  return { ...lease, handle: { ...lease.handle } };
}

function randomId(prefix: string): string {
  const value =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${value}`;
}

/**
 * Tracks temporary upload files after they have been handed to Chrome.
 * The native process owns the bytes; this manager only owns consumer and
 * renewal metadata, so it never reads a user's local file.
 */
export class FileBackingLeaseManager {
  private readonly send: LeaseSender;
  private readonly storage?: LeaseStorage;
  private readonly now: () => number;
  private readonly renewIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly validateConsumer?: (lease: FileBackingLease) => Promise<boolean>;
  private readonly leases = new Map<string, FileBackingLease>();
  private operationQueue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private startPromise: Promise<void> | null = null;
  private tabRemovedListener: ((tabId: number) => void) | null = null;
  private documentCommittedListener: ((details: any) => void) | null = null;

  constructor(options: FileBackingLeaseManagerOptions) {
    this.send = options.send;
    this.storage = options.storage;
    this.now = options.now || Date.now;
    this.renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.validateConsumer = options.validateConsumer;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    await this.load();
    this.installLifecycleListeners();
    if (this.renewIntervalMs > 0) {
      this.timer = setInterval(
        () =>
          void this.heartbeat().catch((error) => {
            console.warn('File backing lease heartbeat failed:', error);
          }),
        this.renewIntervalMs,
      );
      (this.timer as any)?.unref?.();
    }
    await this.enqueue(() => this.reconcileInternal()).catch((error) => {
      console.warn('File backing lease reconcile failed:', error);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (
      typeof chrome !== 'undefined' &&
      this.tabRemovedListener &&
      chrome.tabs?.onRemoved?.removeListener
    ) {
      chrome.tabs.onRemoved.removeListener(this.tabRemovedListener);
    }
    if (
      typeof chrome !== 'undefined' &&
      this.documentCommittedListener &&
      chrome?.webNavigation?.onCommitted?.removeListener
    ) {
      chrome.webNavigation.onCommitted.removeListener(this.documentCommittedListener);
    }
    this.tabRemovedListener = null;
    this.documentCommittedListener = null;
    this.startPromise = null;
  }

  track(
    handle: FileBackingHandle,
    consumer: FileBackingConsumer = {},
    delivery?: FileBackingDelivery,
  ): FileBackingLease {
    const existing = this.leases.get(handle.leaseId);
    const lease: FileBackingLease = {
      handle: { ...handle },
      assetId: handle.assetId,
      leaseId: handle.leaseId,
      tabId: consumer.tabId ?? existing?.tabId,
      frameId: consumer.frameId ?? existing?.frameId,
      documentId: consumer.documentId ?? existing?.documentId,
      keep: Boolean(consumer.keep || existing?.keep),
      delivery: delivery || existing?.delivery,
      retained: existing?.retained || false,
      retainAttempted: existing?.retainAttempted || false,
      releasePending: existing?.releasePending || false,
      updatedAt: this.now(),
    };
    this.leases.set(lease.leaseId, lease);
    void this.persist().catch((error) => {
      console.warn('File backing lease persistence failed:', error);
    });
    return cloneLease(lease);
  }

  get(assetId: string, leaseId: string): FileBackingLease | null {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.assetId !== assetId) return null;
    return cloneLease(lease);
  }

  list(): FileBackingLease[] {
    return Array.from(this.leases.values(), cloneLease);
  }

  async retain(
    handle: FileBackingHandle,
    delivery: FileBackingDelivery,
    consumer: FileBackingConsumer = {},
  ): Promise<FileBackingLease> {
    return this.enqueue(() => this.retainInternal(handle, delivery, consumer));
  }

  private async retainInternal(
    handle: FileBackingHandle,
    delivery: FileBackingDelivery,
    consumer: FileBackingConsumer,
  ): Promise<FileBackingLease> {
    const lease = this.track(handle, consumer, delivery);
    const stored = this.leases.get(lease.leaseId)!;
    stored.retained = true;
    stored.delivery = delivery;
    stored.keep = Boolean(consumer.keep || stored.keep);
    stored.tabId = consumer.tabId ?? stored.tabId;
    stored.frameId = consumer.frameId ?? stored.frameId;
    stored.documentId = consumer.documentId ?? stored.documentId;
    stored.updatedAt = this.now();

    if (!stored.retainAttempted) {
      stored.retainAttempted = true;
      const result = await this.sendAction('retain', this.payloadFor(stored));
      if (!result.success) {
        stored.retainAttempted = false;
        await this.persist();
        throw new Error(result.payload?.error || 'Native retain failed');
      }
    }
    await this.persist();
    return cloneLease(stored);
  }

  async renewNow(): Promise<void> {
    return this.enqueue(() => this.renewInternal());
  }

  private async renewInternal(): Promise<void> {
    for (const lease of this.leases.values()) {
      if (!lease.retained) continue;
      lease.updatedAt = this.now();
      await this.sendAction('renew', {
        assetId: lease.assetId,
        leaseId: lease.leaseId,
      });
    }
    await this.persist();
  }

  async release(handle: Pick<FileBackingHandle, 'assetId' | 'leaseId'>): Promise<void> {
    return this.enqueue(() => this.releaseInternal(handle));
  }

  private async releaseInternal(
    handle: Pick<FileBackingHandle, 'assetId' | 'leaseId'>,
  ): Promise<void> {
    const lease = this.leases.get(handle.leaseId);
    if (lease) {
      lease.releasePending = true;
      lease.updatedAt = this.now();
    }
    await this.persist();
    const result = await this.sendAction('release', {
      assetId: handle.assetId,
      leaseId: handle.leaseId,
      consumer: lease
        ? {
            tabId: lease.tabId,
            frameId: lease.frameId,
            documentId: lease.documentId,
            keep: lease.keep,
          }
        : undefined,
    });
    if (result.success || !lease) {
      this.leases.delete(handle.leaseId);
      await this.persist();
    } else if (lease) {
      lease.releasePending = false;
      lease.updatedAt = this.now();
      await this.persist();
      throw new Error(result.payload?.error || 'Native release failed');
    }
  }

  async reconcile(): Promise<void> {
    await this.start();
    return this.enqueue(() => this.reconcileInternal());
  }

  private async reconcileInternal(): Promise<void> {
    const snapshot = await this.sendAction('reconcile', {});
    if (!snapshot.success || !Array.isArray(snapshot.payload?.leases)) {
      throw new Error('Native lease enumeration failed');
    }
    this.mergeNativeLeases(snapshot.payload.leases);

    const dead = new Set<string>();
    for (const lease of this.list()) {
      if (lease.releasePending) {
        try {
          await this.releaseInternal(lease.handle);
        } catch {}
      }
    }
    for (const lease of this.list()) {
      if (lease.retained && !lease.keep && !(await this.consumerAlive(lease))) {
        dead.add(lease.leaseId);
        await this.releaseInternal(lease.handle);
      }
    }
    const active = this.list().filter((lease) => lease.retained && !dead.has(lease.leaseId));
    await this.persist();
    const result = await this.sendAction('reconcile', {
      leases: active.map((lease) => this.payloadFor(lease)),
    });
    if (result.success) {
      for (const lease of this.list()) {
        if (lease.releasePending) this.leases.delete(lease.leaseId);
      }
      await this.persist();
    }
  }

  private mergeNativeLeases(records: any[]): void {
    for (const record of records) {
      if (!record?.retained || !record.assetId || !record.leaseId) continue;
      const existing = this.leases.get(record.leaseId);
      if (existing && existing.assetId !== record.assetId) continue;
      const consumer = record.consumer || {};
      const lease: FileBackingLease = existing || {
        handle: { assetId: record.assetId, leaseId: record.leaseId },
        assetId: record.assetId,
        leaseId: record.leaseId,
        keep: false,
        retained: true,
        retainAttempted: true,
        updatedAt: this.now(),
      };
      this.leases.set(lease.leaseId, {
        ...lease,
        handle: {
          ...lease.handle,
          filePath: lease.handle.filePath ?? record.filePath,
          fileName: lease.handle.fileName ?? record.fileName,
          size: lease.handle.size ?? record.size,
        },
        tabId: lease.tabId ?? consumer.tabId ?? record.tabId,
        frameId: lease.frameId ?? consumer.frameId,
        documentId: lease.documentId ?? consumer.documentId ?? record.documentId,
        keep: Boolean(lease.keep || record.keep || consumer.keep),
        delivery: lease.delivery ?? record.delivery,
        retained: true,
        retainAttempted: true,
        updatedAt: lease.updatedAt ?? record.updatedAt ?? this.now(),
      });
    }
  }

  async onTabRemoved(tabId: number): Promise<void> {
    const tabLeases = this.list().filter((lease) => lease.tabId === tabId && !lease.keep);
    for (const lease of tabLeases) {
      await this.release(lease.handle);
    }
  }

  async onDocumentCommitted(tabId: number, documentId?: string, frameId = 0): Promise<void> {
    if (!documentId) return;
    const stale = this.list().filter(
      (lease) =>
        lease.tabId === tabId &&
        (lease.frameId ?? 0) === frameId &&
        lease.documentId &&
        lease.documentId !== documentId &&
        !lease.keep,
    );
    for (const lease of stale) {
      await this.release(lease.handle);
    }
  }

  private async heartbeat(): Promise<void> {
    await this.reconcile();
    await this.renewNow();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(work, work);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async consumerAlive(lease: FileBackingLease): Promise<boolean> {
    if (lease.keep) return true;
    if (lease.tabId === undefined) return true;
    if (this.validateConsumer) return this.validateConsumer(lease);
    if (typeof chrome === 'undefined') return true;
    try {
      await chrome.tabs.get(lease.tabId);
    } catch {
      return false;
    }
    if (lease.documentId && chrome.webNavigation?.getFrame) {
      try {
        const frame = await chrome.webNavigation.getFrame({
          tabId: lease.tabId,
          frameId: lease.frameId ?? 0,
        });
        if (frame?.documentId && frame.documentId !== lease.documentId) return false;
      } catch {}
    }
    return true;
  }

  private payloadFor(lease: FileBackingLease): any {
    return {
      assetId: lease.assetId,
      leaseId: lease.leaseId,
      delivery: lease.delivery,
      keep: lease.keep,
      tabId: lease.tabId,
      documentId: lease.documentId,
      consumer: {
        tabId: lease.tabId,
        frameId: lease.frameId,
        documentId: lease.documentId,
        keep: lease.keep,
      },
      handle: lease.handle,
    };
  }

  private async load(): Promise<void> {
    if (!this.storage) return;
    const stored = await this.storage.get(STORAGE_KEY);
    const entries = stored?.[STORAGE_KEY];
    if (entries === undefined) return;
    if (!Array.isArray(entries)) throw new Error('Persisted file leases are invalid');
    for (const candidate of entries) {
      if (
        !candidate?.assetId ||
        !candidate?.leaseId ||
        !candidate?.handle?.assetId ||
        !candidate?.handle?.leaseId
      ) {
        throw new Error('Persisted file lease identity is invalid');
      }
      this.leases.set(candidate.leaseId, cloneLease(candidate));
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    await this.storage.set({ [STORAGE_KEY]: this.list() });
  }

  private async sendAction(action: string, payload: any): Promise<NativeActionResult> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: NativeActionResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => finish({ success: false, sent: false }), this.requestTimeoutMs)
          : null;

      const requestId = randomId(action);
      let posted = false;
      try {
        posted = this.send(
          {
            type: 'file_operation',
            requestId,
            payload: { action, ...payload },
          },
          (response: any) => {
            finish({
              success: Boolean(response?.payload?.success),
              sent: true,
              payload: response?.payload,
            });
          },
        );
      } catch (error) {
        console.warn('File backing lease native send failed:', error);
      }
      if (!posted) finish({ success: false, sent: false });
    });
  }

  private installLifecycleListeners(): void {
    if (typeof chrome === 'undefined') return;
    if (chrome.tabs?.onRemoved?.addListener) {
      this.tabRemovedListener = (tabId) =>
        void this.onTabRemoved(tabId).catch((error) => {
          console.warn('File backing lease tab cleanup failed:', error);
        });
      chrome.tabs.onRemoved.addListener(this.tabRemovedListener);
    }
    if (chrome.webNavigation?.onCommitted?.addListener) {
      this.documentCommittedListener = (details) => {
        if (typeof details?.frameId === 'number') {
          void this.onDocumentCommitted(details.tabId, details.documentId, details.frameId).catch(
            (error) => {
              console.warn('File backing lease document cleanup failed:', error);
            },
          );
        }
      };
      chrome.webNavigation.onCommitted.addListener(this.documentCommittedListener);
    }
  }
}
