import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBackingLeaseManager } from '../utils/file-backing-lease';

function makeStorage(initial: Record<string, any> = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(
        keys.filter((name) => name in data).map((name) => [name, data[name]]),
      );
    },
    async set(value: Record<string, any>) {
      Object.assign(data, value);
    },
  };
}

function makeSender(nativeLeases: any[] = [], options: { failReconcileRead?: boolean } = {}) {
  const nativeState = nativeLeases.map((lease) => ({ ...lease }));
  const messages: Array<{ action: string; payload: any }> = [];
  const send = vi.fn((message: any, callback?: (response: any) => void) => {
    const request = message.payload;
    messages.push({ action: request?.action, payload: request });
    if (request?.action === 'retain') {
      const record = {
        ...request.handle,
        assetId: request.assetId,
        leaseId: request.leaseId,
        retained: true,
        delivery: request.delivery,
        keep: Boolean(request.keep || request.consumer?.keep),
        consumer: { ...request.consumer },
        createdAt: 1,
        updatedAt: 2,
      };
      const index = nativeState.findIndex((lease) => lease.leaseId === request.leaseId);
      if (index >= 0) nativeState[index] = record;
      else nativeState.push(record);
    } else if (request?.action === 'release') {
      const index = nativeState.findIndex((lease) => lease.leaseId === request.leaseId);
      if (index >= 0) nativeState.splice(index, 1);
    } else if (request?.action === 'reconcile' && Array.isArray(request.leases)) {
      const active = new Set(request.leases.map((lease: any) => lease.leaseId));
      for (let index = nativeState.length - 1; index >= 0; index--) {
        const record = nativeState[index];
        if (record.retained && !record.keep && !active.has(record.leaseId)) {
          nativeState.splice(index, 1);
        }
      }
    }
    if (request?.action === 'reconcile' && !Array.isArray(request.leases)) {
      queueMicrotask(() =>
        callback?.({
          payload: options.failReconcileRead
            ? { success: false, error: 'native lease enumeration failed' }
            : { success: true, leases: nativeState },
        }),
      );
      return true;
    }
    queueMicrotask(() => callback?.({ payload: { success: true, ...message.payload } }));
    return true;
  });
  return { send, messages, nativeLeases: nativeState };
}

function authoritativeReconciles(messages: Array<{ action: string; payload: any }>) {
  return messages.filter(
    (message) => message.action === 'reconcile' && Array.isArray(message.payload.leases),
  );
}

const handle = {
  assetId: '11111111-1111-4111-8111-111111111111',
  leaseId: '22222222-2222-4222-8222-222222222222',
  filePath: 'C:\\temp\\file.txt',
  fileName: 'file.txt',
  size: 12,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FileBackingLeaseManager', () => {
  it('retains an unknown delivery once and exposes an inspectable handle', async () => {
    const { send, messages } = makeSender();
    const manager = new FileBackingLeaseManager({
      send,
      storage: makeStorage(),
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
      validateConsumer: async () => true,
    });
    await manager.start();
    manager.track(handle, { tabId: 7, documentId: 'doc-7' });

    const retained = await manager.retain(handle, 'unknown', {
      tabId: 7,
      documentId: 'doc-7',
    });
    await manager.retain(handle, 'unknown', { tabId: 7, documentId: 'doc-7' });

    expect(retained.delivery).toBe('unknown');
    expect(retained.handle).toEqual(handle);
    expect(messages.filter((message) => message.action === 'retain')).toHaveLength(1);
    expect(manager.list()).toHaveLength(1);
  });

  it('renews retained leases periodically', async () => {
    vi.useFakeTimers();
    const { send, messages } = makeSender();
    const manager = new FileBackingLeaseManager({
      send,
      storage: makeStorage(),
      requestTimeoutMs: 100,
      renewIntervalMs: 1000,
      validateConsumer: async () => true,
    });
    await manager.start();
    manager.track(handle, { tabId: 7, documentId: 'doc-7' });
    await manager.retain(handle, 'selected', { tabId: 7, documentId: 'doc-7' });

    await vi.advanceTimersByTimeAsync(1000);

    expect(messages.some((message) => message.action === 'renew')).toBe(true);
    manager.stop();
  });

  it('releases closed tab and replaced document consumers but preserves keep leases', async () => {
    const { send, messages } = makeSender();
    const manager = new FileBackingLeaseManager({
      send,
      storage: makeStorage(),
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
      validateConsumer: async () => true,
    });
    const second = {
      ...handle,
      assetId: '33333333-3333-4333-8333-333333333333',
      leaseId: '44444444-4444-4444-8444-444444444444',
    };
    await manager.start();
    manager.track(handle, { tabId: 7, documentId: 'doc-7' });
    manager.track(second, { tabId: 8, documentId: 'doc-8', keep: true });
    await manager.retain(handle, 'selected', { tabId: 7, documentId: 'doc-7' });
    await manager.retain(second, 'selected', { tabId: 8, documentId: 'doc-8', keep: true });

    await manager.onTabRemoved(7);
    await manager.onTabRemoved(8);
    await manager.onDocumentCommitted(8, 'new-document');

    expect(messages.filter((message) => message.action === 'release')).toHaveLength(1);
    expect(manager.list().map((lease) => lease.leaseId)).toEqual([second.leaseId]);
  });

  it('release removes the local record and sends exactly one native release', async () => {
    const { send, messages } = makeSender();
    const manager = new FileBackingLeaseManager({
      send,
      storage: makeStorage(),
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
      validateConsumer: async () => true,
    });
    await manager.start();
    manager.track(handle, { tabId: 7, documentId: 'doc-7' });

    await manager.release(handle);

    expect(manager.list()).toEqual([]);
    expect(messages.filter((message) => message.action === 'release')).toHaveLength(1);
  });

  it('keeps unprepared leases out of the authoritative reconcile list', async () => {
    const { send, messages } = makeSender();
    const manager = new FileBackingLeaseManager({
      send,
      storage: makeStorage(),
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
      validateConsumer: async () => true,
    });
    await manager.start();
    messages.length = 0;
    manager.track(handle, { tabId: 7, documentId: 'doc-7' });

    await manager.reconcile();

    const reconcile = authoritativeReconciles(messages)[0];
    expect(reconcile?.payload.leases).toEqual([]);
    expect(manager.list()).toHaveLength(1);
  });

  it('restores persisted consumers and reconciles after a service worker restart', async () => {
    const storage = makeStorage();
    const first = makeSender();
    const manager = new FileBackingLeaseManager({
      send: first.send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
      validateConsumer: async () => true,
    });
    await manager.start();
    manager.track(handle, { tabId: 7, documentId: 'doc-7' });
    await manager.retain(handle, 'selected', { tabId: 7, documentId: 'doc-7' });
    manager.stop();

    const second = makeSender();
    const restarted = new FileBackingLeaseManager({
      send: second.send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
      validateConsumer: async () => true,
    });
    await restarted.reconcile();

    const reconcile = authoritativeReconciles(second.messages)[0];
    expect(reconcile?.payload.leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: handle.assetId,
          leaseId: handle.leaseId,
          tabId: 7,
          documentId: 'doc-7',
        }),
      ]),
    );
    restarted.stop();
  });

  it('does not send an authoritative empty reconciliation when persisted consumers cannot be read', async () => {
    const { send, messages } = makeSender();
    const storage = makeStorage();
    vi.spyOn(storage, 'get').mockRejectedValueOnce(new Error('storage unavailable'));
    const manager = new FileBackingLeaseManager({ send, storage, renewIntervalMs: 0 });
    await expect(manager.reconcile()).rejects.toThrow('storage unavailable');
    expect(messages).toEqual([]);
    await manager.reconcile();
    expect(authoritativeReconciles(messages).length).toBeGreaterThan(0);
    manager.stop();
  });

  it('restores Native-only retained child-frame leases instead of deleting them', async () => {
    const nativeLease = {
      ...handle,
      retained: true,
      delivery: 'selected',
      keep: false,
      consumer: {
        tabId: 7,
        frameId: 23,
        documentId: 'doc-child',
        keep: false,
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const storage = makeStorage();
    const { send, messages } = makeSender([nativeLease]);
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({ id: 7 } as any);
    (chrome.webNavigation as any).getFrame = vi.fn().mockResolvedValue({ documentId: 'doc-child' });
    const manager = new FileBackingLeaseManager({
      send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
    });

    await manager.start();

    expect(messages.filter((message) => message.action === 'release')).toHaveLength(0);
    expect(authoritativeReconciles(messages)[0]?.payload.leases).toEqual([
      expect.objectContaining({
        assetId: handle.assetId,
        leaseId: handle.leaseId,
        delivery: 'selected',
        handle,
        consumer: {
          tabId: 7,
          frameId: 23,
          documentId: 'doc-child',
          keep: false,
        },
      }),
    ]);
    expect(manager.get(handle.assetId, handle.leaseId)).toMatchObject({
      retained: true,
      frameId: 23,
      documentId: 'doc-child',
    });
    expect((storage.data as any)['fileBackingLeases.v1']).toHaveLength(1);
    manager.stop();
  });

  it('does not send an authoritative reconcile when Native lease enumeration fails', async () => {
    const { send, messages } = makeSender([], { failReconcileRead: true });
    const manager = new FileBackingLeaseManager({
      send,
      storage: makeStorage(),
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
    });

    await expect(manager.reconcile()).rejects.toThrow('Native lease enumeration failed');

    expect(authoritativeReconciles(messages)).toEqual([]);
    manager.stop();
  });

  it('retains the selected Native lease before surfacing an extension storage failure', async () => {
    const storage = makeStorage();
    vi.spyOn(storage, 'set').mockRejectedValue(new Error('storage write failed'));
    const { send, messages, nativeLeases } = makeSender();
    const consumer = {
      tabId: 7,
      frameId: 23,
      documentId: 'doc-child',
      keep: false,
    };
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({ id: 7 } as any);
    (chrome.webNavigation as any).getFrame = vi.fn().mockResolvedValue({ documentId: 'doc-child' });
    const manager = new FileBackingLeaseManager({
      send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
    });

    await expect(manager.retain(handle, 'selected', consumer)).rejects.toThrow(
      'storage write failed',
    );

    const retains = messages.filter((message) => message.action === 'retain');
    expect(retains).toHaveLength(1);
    expect(retains[0].payload).toMatchObject({
      delivery: 'selected',
      consumer,
    });
    expect(nativeLeases).toEqual([
      expect.objectContaining({
        assetId: handle.assetId,
        leaseId: handle.leaseId,
        retained: true,
        delivery: 'selected',
        consumer,
      }),
    ]);
    await expect(manager.reconcile()).rejects.toThrow('storage write failed');
    expect(authoritativeReconciles(messages)).toEqual([]);
    manager.stop();
  });

  it('releases a restored lease only after Chrome confirms its document is dead', async () => {
    const stale = {
      ...handle,
      retained: true,
      delivery: 'selected',
      keep: false,
      consumer: {
        tabId: 7,
        frameId: 23,
        documentId: 'old-document',
        keep: false,
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const { send, messages } = makeSender([stale]);
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({ id: 7 } as any);
    (chrome.webNavigation as any).getFrame = vi
      .fn()
      .mockResolvedValue({ documentId: 'new-document' });
    const manager = new FileBackingLeaseManager({
      send,
      storage: makeStorage(),
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
    });

    await manager.start();

    const releases = messages.filter((message) => message.action === 'release');
    expect(releases).toHaveLength(1);
    expect(releases[0].payload).toMatchObject({
      assetId: handle.assetId,
      leaseId: handle.leaseId,
      consumer: {
        tabId: 7,
        frameId: 23,
        documentId: 'old-document',
        keep: false,
      },
    });
    expect(manager.list()).toEqual([]);
    manager.stop();
  });

  it('stops before an authoritative reconcile when persistence fails', async () => {
    const storage = makeStorage();
    vi.spyOn(storage, 'set').mockRejectedValue(new Error('storage write failed'));
    const { send, messages } = makeSender();
    const manager = new FileBackingLeaseManager({
      send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
    });

    await expect(manager.reconcile()).rejects.toThrow('storage write failed');

    expect(authoritativeReconciles(messages)).toEqual([]);
    manager.stop();
  });

  it('reclaims a reused tab id only when the document GUID changed', async () => {
    const storage = makeStorage();
    const first = makeSender();
    const manager = new FileBackingLeaseManager({
      send: first.send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
      validateConsumer: async () => true,
    });
    await manager.start();
    manager.track(handle, { tabId: 7, documentId: 'doc-7' });
    await manager.retain(handle, 'selected', { tabId: 7, documentId: 'doc-7' });
    manager.stop();

    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({ id: 7 } as any);
    (chrome.webNavigation as any).getFrame = vi
      .fn()
      .mockResolvedValue({ documentId: 'different-document' });
    const second = makeSender();
    const restarted = new FileBackingLeaseManager({
      send: second.send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
    });
    await restarted.start();

    expect(second.messages.filter((message) => message.action === 'release')).toHaveLength(1);
    expect(restarted.list()).toEqual([]);
    restarted.stop();
  });

  it('preserves a retained lease when the tab and document GUID still match', async () => {
    const storage = makeStorage();
    const first = makeSender();
    const manager = new FileBackingLeaseManager({
      send: first.send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
      validateConsumer: async () => true,
    });
    await manager.start();
    manager.track(handle, { tabId: 7, documentId: 'doc-7' });
    await manager.retain(handle, 'selected', { tabId: 7, documentId: 'doc-7' });
    manager.stop();

    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({ id: 7 } as any);
    (chrome.webNavigation as any).getFrame = vi.fn().mockResolvedValue({
      documentId: 'doc-7',
    });
    const second = makeSender();
    const restarted = new FileBackingLeaseManager({
      send: second.send,
      storage,
      requestTimeoutMs: 100,
      renewIntervalMs: 0,
    });
    await restarted.start();

    expect(second.messages.filter((message) => message.action === 'release')).toHaveLength(0);
    expect(restarted.list()).toHaveLength(1);
    restarted.stop();
  });
});
