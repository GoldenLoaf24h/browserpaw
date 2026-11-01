import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadObservation } from 'chrome-mcp-shared';
import { DownloadsWatchdog } from '../entrypoints/background/watchdogs/downloads-watchdog';
import { cdpSessionManager, type CdpEventObserver } from '../utils/cdp-session-manager';

const SAME_URL = 'https://files.example/report.zip?token=SUPERSECRET&x=1';
const SAME_NAME = 'report.zip';

interface ChromeRig {
  store: Record<string, unknown>;
  created: Array<(item: any) => void>;
  changed: Array<(delta: any) => void>;
  detached: Array<(source: { tabId?: number }, reason: string) => void>;
  removed: Array<(tabId: number) => void>;
  search: ReturnType<typeof vi.fn>;
  addCreated: ReturnType<typeof vi.fn>;
  removeCreated: ReturnType<typeof vi.fn>;
  addChanged: ReturnType<typeof vi.fn>;
  removeChanged: ReturnType<typeof vi.fn>;
  addDetach: ReturnType<typeof vi.fn>;
  removeDetach: ReturnType<typeof vi.fn>;
  addRemoved: ReturnType<typeof vi.fn>;
  removeRemoved: ReturnType<typeof vi.fn>;
}

let rig: ChromeRig;
let observers: CdpEventObserver[];
let heldOwners: Set<string>;
let dogs: DownloadsWatchdog[];
let originalChrome: typeof chrome;
const unhandled: unknown[] = [];

function onUnhandled(error: unknown): void {
  unhandled.push(error);
}

function installChrome(): ChromeRig {
  const created: Array<(item: any) => void> = [];
  const changed: Array<(delta: any) => void> = [];
  const detached: Array<(source: { tabId?: number }, reason: string) => void> = [];
  const removed: Array<(tabId: number) => void> = [];
  const store: Record<string, unknown> = {};
  const search = vi.fn(async () => []);
  const addCreated = vi.fn((fn: (item: any) => void) => created.push(fn));
  const removeCreated = vi.fn((fn: (item: any) => void) => {
    const index = created.indexOf(fn);
    if (index >= 0) created.splice(index, 1);
  });
  const addChanged = vi.fn((fn: (delta: any) => void) => changed.push(fn));
  const removeChanged = vi.fn((fn: (delta: any) => void) => {
    const index = changed.indexOf(fn);
    if (index >= 0) changed.splice(index, 1);
  });
  const addDetach = vi.fn((fn: (source: { tabId?: number }, reason: string) => void) =>
    detached.push(fn),
  );
  const removeDetach = vi.fn((fn: (source: { tabId?: number }, reason: string) => void) => {
    const index = detached.indexOf(fn);
    if (index >= 0) detached.splice(index, 1);
  });
  const addRemoved = vi.fn((fn: (tabId: number) => void) => removed.push(fn));
  const removeRemoved = vi.fn((fn: (tabId: number) => void) => {
    const index = removed.indexOf(fn);
    if (index >= 0) removed.splice(index, 1);
  });
  (globalThis as any).chrome = {
    runtime: { id: 'test-ext-id' },
    downloads: {
      search,
      onCreated: { addListener: addCreated, removeListener: removeCreated },
      onChanged: { addListener: addChanged, removeListener: removeChanged },
    },
    debugger: {
      onDetach: { addListener: addDetach, removeListener: removeDetach },
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      onRemoved: { addListener: addRemoved, removeListener: removeRemoved },
    },
    storage: {
      session: {
        get: vi.fn(async (key?: string | string[]) => {
          if (typeof key === 'string') return { [key]: store[key] };
          return { ...store };
        }),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(store, value);
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
  };
  return {
    store,
    created,
    changed,
    detached,
    removed,
    search,
    addCreated,
    removeCreated,
    addChanged,
    removeChanged,
    addDetach,
    removeDetach,
    addRemoved,
    removeRemoved,
  };
}

function dog(): DownloadsWatchdog {
  const created = new DownloadsWatchdog();
  dogs.push(created);
  return created;
}

function emit(
  observer: CdpEventObserver,
  tabId: number,
  method: 'Page.downloadWillBegin' | 'Page.downloadProgress',
  params: Record<string, unknown>,
  sessionId?: string,
): void {
  observer(tabId, method, params, sessionId ? { tabId, sessionId } : { tabId });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  originalChrome = globalThis.chrome;
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  rig = installChrome();
  observers = [];
  heldOwners = new Set();
  dogs = [];
  vi.spyOn(cdpSessionManager, 'addCdpEventObserver').mockImplementation((observer) => {
    observers.push(observer);
  });
  vi.spyOn(cdpSessionManager, 'removeCdpEventObserver').mockImplementation((observer) => {
    const index = observers.indexOf(observer);
    if (index >= 0) observers.splice(index, 1);
  });
  vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, owner, fn) => {
    const key = String(owner);
    const tracked = key.startsWith('source-download:');
    if (tracked) heldOwners.add(key);
    try {
      return await fn();
    } finally {
      if (tracked) heldOwners.delete(key);
    }
  });
  vi.spyOn(cdpSessionManager, 'ensureFrameSessions').mockResolvedValue([]);
});

afterEach(() => {
  for (const item of dogs) item.stop();
  process.off('unhandledRejection', onUnhandled);
  (globalThis as any).chrome = originalChrome;
  vi.restoreAllMocks();
});

describe('DownloadsWatchdog source tracking', () => {
  it('does not persist provider-specific signed query values or fragment credentials', async () => {
    const wd = dog();
    await wd.ensureReady();
    emit(observers[0], 7, 'Page.downloadWillBegin', {
      guid: 'signed-file',
      frameId: 'frame-7',
      suggestedFilename: 'report.txt',
      url: 'https://user:password@files.example/report.txt?X-Amz-Signature=signed-secret&jwt=bearer-secret&fileId=opaque-secret#access_token=fragment-secret',
    });
    await settle();
    const record = wd.getPageDownload(7, 'signed-file')!;
    expect(record.url).toBe(
      'https://files.example/report.txt?X-Amz-Signature=REDACTED&jwt=REDACTED&fileId=REDACTED',
    );
    expect(JSON.stringify(rig.store)).not.toMatch(
      /signed-secret|bearer-secret|opaque-secret|fragment-secret|password/,
    );
  });

  it.each([
    { name: 'root then child', sessions: [undefined, 'child'], alive: [] },
    { name: 'child then root', sessions: ['child', undefined], alive: [] },
    { name: 'child then live ancestor', sessions: ['child', 'ancestor'], alive: ['ancestor'] },
    { name: 'live ancestor then child', sessions: ['ancestor', 'child'], alive: ['ancestor'] },
  ])(
    'keeps a download observable through another confirmed reporter: $name',
    async ({ sessions, alive }) => {
      const wd = dog();
      await wd.ensureReady();
      const observer = observers[0];
      for (const session of sessions)
        emit(
          observer,
          7,
          'Page.downloadWillBegin',
          {
            guid: 'shared-guid',
            frameId: 'frame-7',
            url: SAME_URL,
            suggestedFilename: SAME_NAME,
          },
          session,
        );
      vi.spyOn(cdpSessionManager, 'getKnownFrameSessions').mockReturnValue(
        alive.map((sessionId) => ({ sessionId, targetId: `target-${sessionId}` })),
      );
      observer(7, 'Target.detachedFromTarget', { sessionId: 'child' }, { tabId: 7 });
      expect(wd.getPageDownload(7, 'shared-guid')?.state).toBe('inProgress');
      emit(
        observer,
        7,
        'Page.downloadProgress',
        { guid: 'shared-guid', state: 'completed', receivedBytes: 4, totalBytes: 4 },
        sessions.find((session) => session !== 'child'),
      );
      await settle();
      expect(wd.getPageDownload(7, 'shared-guid')?.state).toBe('completed');
      expect(heldOwners.has('source-download:shared-guid')).toBe(false);
    },
  );

  it('keeps same url and filename on separate tabs and ignores numeric downloads', async () => {
    const wd = dog();
    expect(wd.sourceTrackingAvailable).toBe(false);
    await wd.ensureReady();
    expect(wd.sourceTrackingAvailable).toBe(true);
    const observer = observers[0];

    emit(
      observer,
      1,
      'Page.downloadWillBegin',
      {
        frameId: 'frame-1',
        guid: 'guid-a',
        url: SAME_URL,
        suggestedFilename: SAME_NAME,
      },
      'session-1',
    );
    emit(
      observer,
      2,
      'Page.downloadWillBegin',
      {
        frameId: 'frame-2',
        guid: 'guid-b',
        url: `data:application/octet-stream;base64,AAAAPAYLOAD`,
        suggestedFilename: SAME_NAME,
      },
      'session-2',
    );
    emit(
      observer,
      1,
      'Page.downloadProgress',
      {
        guid: 'guid-a',
        totalBytes: 100,
        receivedBytes: 10,
        state: 'inProgress',
      },
      'session-1',
    );
    emit(
      observer,
      2,
      'Page.downloadProgress',
      {
        guid: 'guid-b',
        totalBytes: 100,
        receivedBytes: 90,
        state: 'inProgress',
      },
      'session-2',
    );

    rig.created[0]({
      id: 7,
      url: SAME_URL,
      filename: SAME_NAME,
      totalBytes: 100,
      bytesReceived: 10,
      state: 'in_progress',
    });

    const first = wd.getPageDownloads(1);
    const second = wd.getPageDownloads(2);
    expect(first.map((item) => item.guid)).toEqual(['guid-a']);
    expect(second.map((item) => item.guid)).toEqual(['guid-b']);
    expect(wd.getPageDownload(1, 'guid-b')).toBeUndefined();
    expect(wd.getPageDownload(2, 'guid-a')).toBeUndefined();
    expect(first[0]).toMatchObject({
      tabId: 1,
      frameId: 'frame-1',
      sessionId: 'session-1',
      url: 'https://files.example/report.zip?token=REDACTED&x=REDACTED',
      suggestedFilename: SAME_NAME,
      state: 'inProgress',
      receivedBytes: 10,
      totalBytes: 100,
    } satisfies Partial<DownloadObservation>);
    expect(second[0].url).toBe('data:');
    expect(second[0].suggestedFilename).toBe(SAME_NAME);
    await settle();
    const stored = JSON.stringify(rig.store);
    expect(stored).toContain('token=REDACTED');
    expect(stored).not.toContain('SUPERSECRET');
    expect(stored).not.toContain('AAAAPAYLOAD');
    expect(wd.getDownload(7)?.id).toBe(7);
    expect(wd.getActiveDownloads().map((item) => item.id)).toEqual([7]);
    expect('filename' in first[0]).toBe(false);

    const snapshot = wd.getPageDownloads(1)[0];
    snapshot.receivedBytes = -1;
    snapshot.state = 'completed';
    expect(wd.getPageDownload(1, 'guid-a')).toMatchObject({
      receivedBytes: 10,
      state: 'inProgress',
    });

    emit(observer, 1, 'Page.downloadWillBegin', {
      frameId: 'frame-late',
      guid: 'guid-c',
      url: SAME_URL,
      suggestedFilename: 'second.zip',
    });
    expect(wd.getPageDownloads(1).map((item) => item.guid)).toEqual(['guid-a', 'guid-c']);
  });

  it('does not bind an unknown guid, a missing begin, or a progress event from the wrong tab', async () => {
    const wd = dog();
    await wd.ensureReady();
    const observer = observers[0];
    emit(observer, 1, 'Page.downloadWillBegin', {
      guid: 'no-frame',
      url: SAME_URL,
      suggestedFilename: SAME_NAME,
    });
    emit(observer, 1, 'Page.downloadProgress', {
      guid: 'ghost',
      totalBytes: 5,
      receivedBytes: 1,
      state: 'inProgress',
    });
    emit(
      observer,
      1,
      'Page.downloadWillBegin',
      {
        frameId: 'frame-1',
        guid: 'guid-a',
        url: SAME_URL,
        suggestedFilename: SAME_NAME,
      },
      'session-1',
    );
    emit(
      observer,
      2,
      'Page.downloadWillBegin',
      {
        frameId: 'frame-other',
        guid: 'guid-a',
        url: SAME_URL,
        suggestedFilename: 'other.zip',
      },
      'session-other',
    );
    emit(
      observer,
      2,
      'Page.downloadProgress',
      {
        guid: 'guid-a',
        totalBytes: 100,
        receivedBytes: 77,
        state: 'inProgress',
      },
      'session-other',
    );
    emit(
      observer,
      1,
      'Page.downloadWillBegin',
      {
        frameId: 'frame-wrong',
        guid: 'guid-a',
        url: 'https://evil.example/changed.bin',
        suggestedFilename: 'changed.bin',
      },
      'session-wrong',
    );
    expect(wd.getPageDownload(1, 'guid-a')).toMatchObject({
      frameId: 'frame-1',
      url: 'https://files.example/report.zip?token=REDACTED&x=REDACTED',
      suggestedFilename: SAME_NAME,
      sessionId: 'session-1',
    });
    emit(
      observer,
      1,
      'Page.downloadProgress',
      {
        guid: 'guid-a',
        totalBytes: 100,
        receivedBytes: 40,
        state: 'inProgress',
      },
      'session-2',
    );

    expect(wd.getPageDownloads(1).map((item) => item.guid)).toEqual(['guid-a']);
    expect(wd.getPageDownloads(2)).toEqual([]);
    expect(wd.getPageDownload(1, 'ghost')).toBeUndefined();
    expect(wd.getPageDownload(1, 'guid-a')).toMatchObject({
      tabId: 1,
      frameId: 'frame-1',
      sessionId: 'session-2',
      suggestedFilename: SAME_NAME,
      receivedBytes: 40,
    });
  });

  it('applies progress through completion and ignores a late inProgress', async () => {
    const wd = dog();
    const updates: DownloadObservation[] = [];
    wd.on('source-download-updated', (item) => updates.push(item));
    await wd.ensureReady();
    const observer = observers[0];
    emit(observer, 4, 'Page.downloadWillBegin', {
      frameId: 'frame-4',
      guid: 'guid-done',
      url: 'https://files.example/done.bin',
      suggestedFilename: 'done.bin',
    });
    emit(observer, 4, 'Page.downloadProgress', {
      guid: 'guid-done',
      totalBytes: 80,
      receivedBytes: 20,
      state: 'inProgress',
    });
    emit(observer, 4, 'Page.downloadProgress', {
      guid: 'guid-done',
      totalBytes: 80,
      receivedBytes: 80,
      state: 'completed',
    });
    const completed = wd.getPageDownload(4, 'guid-done')!;
    emit(observer, 4, 'Page.downloadProgress', {
      guid: 'guid-done',
      totalBytes: 80,
      receivedBytes: 1,
      state: 'inProgress',
    });
    emit(observer, 4, 'Page.downloadProgress', {
      guid: 'guid-done',
      totalBytes: 80,
      receivedBytes: 0,
      state: 'canceled',
    });

    const current = wd.getPageDownload(4, 'guid-done')!;
    expect(current).toMatchObject({
      state: 'completed',
      receivedBytes: 80,
      totalBytes: 80,
      epoch: completed.epoch,
      sequence: completed.sequence,
    });
    expect(updates.map((item) => item.state)).toEqual(['inProgress', 'inProgress', 'completed']);
    expect(current.sequence).toBeGreaterThan(updates[0].sequence);
    await settle();
    expect(heldOwners.has('source-download:guid-done')).toBe(false);

    emit(observer, 4, 'Page.downloadWillBegin', {
      frameId: 'frame-4',
      guid: 'guid-stop',
      url: 'https://files.example/stop.bin',
      suggestedFilename: 'stop.bin',
    });
    emit(observer, 4, 'Page.downloadProgress', {
      guid: 'guid-stop',
      totalBytes: 10,
      receivedBytes: 3,
      state: 'canceled',
    });
    emit(observer, 4, 'Page.downloadProgress', {
      guid: 'guid-stop',
      totalBytes: 10,
      receivedBytes: 9,
      state: 'inProgress',
    });
    expect(wd.getPageDownload(4, 'guid-stop')).toMatchObject({
      state: 'canceled',
      receivedBytes: 3,
    });
  });

  it('marks the source unknown and releases its owner when the source is lost', async () => {
    const wd = dog();
    const ended: Array<{ tabId: number; reason: string }> = [];
    wd.on('source-download-ended', (event) => ended.push(event));
    await wd.ensureReady();
    const observer = observers[0];
    emit(observer, 8, 'Page.downloadWillBegin', {
      frameId: 'frame-8',
      guid: 'guid-live',
      url: 'https://files.example/live.bin',
      suggestedFilename: 'live.bin',
    });
    expect(heldOwners.has('source-download:guid-live')).toBe(true);

    rig.detached[0]({ tabId: 8 }, 'target_closed');
    await settle();
    expect(wd.getPageDownload(8, 'guid-live')).toMatchObject({
      state: 'unknown',
      tabId: 8,
      frameId: 'frame-8',
      reason: 'debugger-detached',
    });
    expect(heldOwners.has('source-download:guid-live')).toBe(false);
    expect(ended).toEqual([{ tabId: 8, reason: 'debugger-detached' }]);

    emit(observer, 8, 'Page.downloadProgress', {
      guid: 'guid-live',
      totalBytes: 10,
      receivedBytes: 10,
      state: 'completed',
    });
    expect(wd.getPageDownload(8, 'guid-live')?.state).toBe('unknown');

    emit(observer, 9, 'Page.downloadWillBegin', {
      frameId: 'frame-9',
      guid: 'guid-tab',
      url: 'https://files.example/tab.bin',
      suggestedFilename: 'tab.bin',
    });
    rig.removed[0](9);
    await settle();
    expect(wd.getPageDownload(9, 'guid-tab')).toMatchObject({
      state: 'unknown',
      reason: 'tab-removed',
    });
    expect(heldOwners.has('source-download:guid-tab')).toBe(false);

    await wd.withSourceTracking(10, async () => undefined);
    emit(observer, 10, 'Page.downloadWillBegin', {
      frameId: 'frame-10',
      guid: 'guid-end',
      url: 'https://files.example/end.bin',
      suggestedFilename: 'end.bin',
    });
    wd.endSourceTracking(10, 'caller-closed');
    await settle();
    expect(wd.getPageDownload(10, 'guid-end')).toMatchObject({
      state: 'unknown',
      reason: 'caller-closed',
    });
    expect(ended).toContainEqual({ tabId: 10, reason: 'caller-closed' });
    wd.endSourceTracking(10, 'caller-closed');
    expect(ended.filter((event) => event.tabId === 10)).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it('fails an owner attach without an unhandled rejection or numeric fallback', async () => {
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, owner, fn) => {
      if (String(owner).startsWith('source-download:')) throw new Error('attach failed');
      return fn();
    });
    const wd = dog();
    await wd.ensureReady();
    emit(observers[0], 3, 'Page.downloadWillBegin', {
      frameId: 'frame-3',
      guid: 'guid-orphan',
      url: 'https://files.example/orphan.bin',
      suggestedFilename: 'orphan.bin',
    });
    await settle();
    expect(wd.getPageDownload(3, 'guid-orphan')).toMatchObject({
      state: 'unknown',
      reason: 'source-owner-lost',
    });
    expect(rig.search).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('restores unfinished downloads as unknown and keeps a newer memory event', async () => {
    const first = dog();
    await first.ensureReady();
    const oldEpoch = first.getPageDownload(1, 'missing');
    expect(oldEpoch).toBeUndefined();
    emit(observers[0], 1, 'Page.downloadWillBegin', {
      frameId: 'frame-old',
      guid: 'guid-old',
      url: 'https://files.example/old.bin',
      suggestedFilename: 'old.bin',
    });
    emit(observers[0], 1, 'Page.downloadProgress', {
      guid: 'guid-old',
      totalBytes: 50,
      receivedBytes: 10,
      state: 'inProgress',
    });
    emit(observers[0], 1, 'Page.downloadWillBegin', {
      frameId: 'frame-finished',
      guid: 'guid-finished',
      url: 'https://files.example/finished.bin',
      suggestedFilename: 'finished.bin',
    });
    emit(observers[0], 1, 'Page.downloadProgress', {
      guid: 'guid-finished',
      totalBytes: 4,
      receivedBytes: 4,
      state: 'completed',
    });
    await settle();
    const saved = structuredClone(rig.store);
    const previous = first.getPageDownload(1, 'guid-old')!;
    first.stop();

    let releaseRestore: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let waitForRestore = false;
    vi.mocked(chrome.storage.session.get).mockImplementation(async () => {
      if (waitForRestore) await gate;
      return structuredClone(saved);
    });

    waitForRestore = true;
    const restarted = dog();
    const ready = restarted.ensureReady();
    await Promise.resolve();
    const observer = observers[observers.length - 1];
    emit(observer, 1, 'Page.downloadWillBegin', {
      frameId: 'frame-old',
      guid: 'guid-old',
      url: 'https://files.example/old.bin',
      suggestedFilename: 'old.bin',
    });
    emit(observer, 1, 'Page.downloadProgress', {
      guid: 'guid-old',
      totalBytes: 50,
      receivedBytes: 80,
      state: 'inProgress',
    });
    releaseRestore();
    await ready;

    const live = restarted.getPageDownload(1, 'guid-old')!;
    expect(live).toMatchObject({
      state: 'inProgress',
      receivedBytes: 80,
      frameId: 'frame-old',
    });
    expect(live.epoch).not.toBe(previous.epoch);
    expect(restarted.getPageDownload(1, 'guid-finished')).toMatchObject({
      state: 'completed',
      receivedBytes: 4,
      epoch: first.getPageDownload(1, 'guid-finished')?.epoch,
    });

    restarted.stop();
    vi.mocked(chrome.storage.session.get).mockImplementation(async () => structuredClone(saved));
    const restored = dog();
    await restored.ensureReady();
    const unfinished = restored.getPageDownload(1, 'guid-old')!;
    expect(unfinished).toMatchObject({
      state: 'unknown',
      reason: 'worker-restart',
      receivedBytes: 10,
      epoch: previous.epoch,
      sequence: previous.sequence,
      frameId: 'frame-old',
    });
    expect(restored.getPageDownload(1, 'guid-finished')).toMatchObject({ state: 'completed' });
    expect(heldOwners.has('source-download:guid-old')).toBe(false);

    emit(observers[observers.length - 1], 1, 'Page.downloadProgress', {
      guid: 'guid-old',
      totalBytes: 50,
      receivedBytes: 50,
      state: 'completed',
    });
    expect(restored.getPageDownload(1, 'guid-old')).toMatchObject({
      state: 'completed',
      receivedBytes: 50,
    });
    expect(restored.getPageDownload(1, 'guid-old')!.epoch).not.toBe(previous.epoch);
  });

  it('starts and stops without stacking listeners, and does not retry source setup', async () => {
    const wd = dog();
    const steps: string[] = [];
    vi.mocked(chrome.storage.session.get).mockImplementation(async () => {
      steps.push('storage');
      return {};
    });
    vi.mocked(cdpSessionManager.withSession).mockImplementation(async (_tabId, owner, fn) => {
      steps.push(`session:${String(owner)}`);
      return fn();
    });
    vi.mocked(cdpSessionManager.ensureFrameSessions).mockImplementation(async (tabId) => {
      steps.push(`frames:${tabId}`);
      return [];
    });

    expect(wd.sourceTrackingAvailable).toBe(false);
    wd.start();
    wd.start();
    expect(observers).toHaveLength(1);
    expect(rig.addCreated).toHaveBeenCalledTimes(1);
    expect(rig.addChanged).toHaveBeenCalledTimes(1);
    expect(rig.addDetach).toHaveBeenCalledTimes(1);
    expect(rig.addRemoved).toHaveBeenCalledTimes(1);

    await wd.withSourceTracking(5, async () => {
      steps.push('run');
      return 'done';
    });
    expect(steps).toEqual(['storage', 'session:source-tracking:5', 'frames:5', 'run']);

    vi.mocked(cdpSessionManager.ensureFrameSessions).mockRejectedValueOnce(
      new Error('child page failed'),
    );
    const run = vi.fn(async () => 'again');
    await expect(wd.withSourceTracking(5, run)).rejects.toThrow('child page failed');
    expect(run).not.toHaveBeenCalled();
    expect(vi.mocked(cdpSessionManager.ensureFrameSessions)).toHaveBeenCalledTimes(2);

    const observer = observers[0];
    emit(observer, 5, 'Page.downloadWillBegin', {
      frameId: 'frame-5',
      guid: 'guid-stop',
      url: 'https://files.example/stop.bin',
      suggestedFilename: 'stop.bin',
    });
    wd.stop();
    wd.stop();
    expect(observers).toHaveLength(0);
    expect(rig.created).toHaveLength(0);
    expect(rig.changed).toHaveLength(0);
    expect(rig.detached).toHaveLength(0);
    expect(rig.removed).toHaveLength(0);
    expect(rig.removeCreated).toHaveBeenCalledTimes(1);
    expect(rig.removeDetach).toHaveBeenCalledTimes(1);
    expect(wd.sourceTrackingAvailable).toBe(false);
    expect(wd.getPageDownload(5, 'guid-stop')).toMatchObject({
      state: 'unknown',
      reason: 'stopped',
    });
    emit(observer, 5, 'Page.downloadWillBegin', {
      frameId: 'frame-5',
      guid: 'guid-after-stop',
      url: 'https://files.example/after.bin',
      suggestedFilename: 'after.bin',
    });
    expect(wd.getPageDownload(5, 'guid-after-stop')).toBeUndefined();
    expect(rig.search).not.toHaveBeenCalled();

    vi.spyOn(cdpSessionManager, 'addCdpEventObserver').mockImplementation(() => {
      throw new Error('observer rejected');
    });
    const failed = dog();
    await expect(failed.ensureReady()).rejects.toThrow(/unavailable/i);
    expect(failed.sourceTrackingAvailable).toBe(false);
    expect(rig.search).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('keeps terminal history while any same-tab scope is active, then caps it', async () => {
    const wd = dog();
    await wd.ensureReady();
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const scopeA = wd.withSourceTracking(
      1,
      () =>
        new Promise<void>((resolve) => {
          releaseA = resolve;
        }),
    );
    const scopeB = wd.withSourceTracking(
      1,
      () =>
        new Promise<void>((resolve) => {
          releaseB = resolve;
        }),
    );
    await settle();
    const observer = observers[0];
    emit(observer, 3, 'Page.downloadWillBegin', {
      frameId: 'frame-3',
      guid: 'still-live',
      url: 'https://files.example/live.bin',
      suggestedFilename: 'live.bin',
    });
    for (let index = 0; index < 40; index += 1) {
      emit(observer, 1, 'Page.downloadWillBegin', {
        frameId: 'frame-1',
        guid: 'keep-' + index,
        url: 'https://files.example/keep.bin',
        suggestedFilename: 'keep.bin',
      });
      emit(observer, 1, 'Page.downloadProgress', {
        guid: 'keep-' + index,
        totalBytes: 1,
        receivedBytes: 1,
        state: 'completed',
      });
    }
    expect(wd.getPageDownloads(1)).toHaveLength(40);

    releaseA();
    await scopeA;
    expect(wd.getPageDownloads(1)).toHaveLength(40);
    expect(wd.getPageDownload(1, 'keep-0')?.state).toBe('completed');

    releaseB();
    await scopeB;
    expect(wd.getPageDownloads(1).length).toBeLessThanOrEqual(32);
    expect(wd.getPageDownloads(1).length).toBeGreaterThan(0);
    expect(wd.getPageDownload(1, 'keep-0')).toBeUndefined();
    expect(wd.getPageDownload(3, 'still-live')).toMatchObject({ state: 'inProgress' });
    expect(heldOwners.has('source-download:still-live')).toBe(true);
  });

  it('drops restored records that fail the source identity check', async () => {
    const first = dog();
    await first.ensureReady();
    emit(observers[0], 4, 'Page.downloadWillBegin', {
      frameId: 'frame-ok',
      guid: 'guid-ok',
      url: 'https://files.example/ok.bin',
      suggestedFilename: 'ok.bin',
    });
    emit(observers[0], 4, 'Page.downloadProgress', {
      guid: 'guid-ok',
      totalBytes: 2,
      receivedBytes: 2,
      state: 'completed',
    });
    await settle();
    const saved = structuredClone(rig.store) as Record<string, { items: any[] }>;
    const key = Object.keys(saved)[0];
    const sample = saved[key].items[0];
    saved[key].items.push(
      { ...sample, guid: '' },
      { ...sample, guid: 'g'.repeat(129) },
      { ...sample, guid: 'tab-zero', tabId: 0 },
      { ...sample, guid: 'tab-fraction', tabId: 1.5 },
      { ...sample, guid: 'frame-empty', frameId: '' },
      { ...sample, guid: 'time-nan', startedAt: Number.NaN },
      { ...sample, guid: 'time-inf', updatedAt: Number.POSITIVE_INFINITY },
      { ...sample, guid: 'seq-nan', sequence: Number.NaN },
      { ...sample, guid: 'seq-inf', sequence: Number.POSITIVE_INFINITY },
    );
    first.stop();
    vi.mocked(chrome.storage.session.get).mockImplementation(async () => structuredClone(saved));
    const restored = dog();
    await restored.ensureReady();
    expect(restored.getPageDownload(4, 'guid-ok')).toMatchObject({ state: 'completed' });
    expect(restored.getPageDownload(4, '')).toBeUndefined();
    expect(restored.getPageDownload(4, 'g'.repeat(129))).toBeUndefined();
    expect(restored.getPageDownload(4, 'frame-empty')).toBeUndefined();
    expect(restored.getPageDownload(4, 'time-nan')).toBeUndefined();
    expect(restored.getPageDownload(4, 'time-inf')).toBeUndefined();
    expect(restored.getPageDownload(4, 'seq-nan')).toBeUndefined();
    expect(restored.getPageDownload(4, 'seq-inf')).toBeUndefined();
    expect(restored.getPageDownload(0, 'tab-zero')).toBeUndefined();
    expect(restored.getPageDownload(1, 'tab-fraction')).toBeUndefined();
  });

  it('persists a progress burst as one latest snapshot', async () => {
    const wd = dog();
    await wd.ensureReady();
    const writes: number[] = [];
    let releaseWrite: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let held = false;
    vi.mocked(chrome.storage.session.set).mockImplementation(async (value: Record<string, any>) => {
      const payload = value[Object.keys(value)[0]];
      const hit = payload.items.find((item: { guid: string }) => item.guid === 'guid-burst');
      writes.push(hit?.receivedBytes ?? -1);
      if (!held) {
        held = true;
        await gate;
      }
      Object.assign(rig.store, value);
    });
    const observer = observers[0];
    emit(observer, 6, 'Page.downloadWillBegin', {
      frameId: 'frame-6',
      guid: 'guid-burst',
      url: 'https://files.example/burst.bin',
      suggestedFilename: 'burst.bin',
    });
    for (let index = 1; index <= 20; index += 1) {
      emit(observer, 6, 'Page.downloadProgress', {
        guid: 'guid-burst',
        totalBytes: 20,
        receivedBytes: index,
        state: 'inProgress',
      });
    }
    await Promise.resolve();
    expect(writes).toEqual([20]);
    releaseWrite();
    await settle();
    expect(writes).toEqual([20]);
    expect(wd.getPageDownload(6, 'guid-burst')?.receivedBytes).toBe(20);
  });

  it('strips URL userinfo, scrubs query secrets, and bounds descriptive fields', async () => {
    const wd = dog();
    await wd.ensureReady();
    const observer = observers[0];
    const longName = `${'n'.repeat(600)}.bin`;
    const longUrl = `https://alice:s3cret@files.example/${'b'.repeat(3000)}/report.zip?token=SUPERSECRET`;
    emit(observer, 4, 'Page.downloadWillBegin', {
      frameId: 'frame-4',
      guid: 'guid-secret',
      url: 'https://alice:s3cret@files.example/report.zip?token=SUPERSECRET&x=1',
      suggestedFilename: longName,
    });
    emit(observer, 4, 'Page.downloadWillBegin', {
      frameId: 'frame-long',
      guid: 'guid-long',
      url: longUrl,
      suggestedFilename: 'short.bin',
    });

    const secret = wd.getPageDownload(4, 'guid-secret')!;
    expect(secret).toMatchObject({
      guid: 'guid-secret',
      tabId: 4,
      frameId: 'frame-4',
      url: 'https://files.example/report.zip?token=REDACTED&x=REDACTED',
    });
    expect(secret.suggestedFilename).toHaveLength(512);
    expect(secret.suggestedFilename.endsWith('\u2026')).toBe(true);
    const long = wd.getPageDownload(4, 'guid-long')!;
    expect(long).toMatchObject({ guid: 'guid-long', tabId: 4, frameId: 'frame-long' });
    expect(long.url).toHaveLength(2048);
    expect(long.url.endsWith('\u2026')).toBe(true);
    expect(long.url).not.toContain('alice');
    expect(long.url).not.toContain('s3cret');
    expect(long.url).not.toContain('SUPERSECRET');
    await settle();
    const stored = JSON.stringify(rig.store);
    expect(stored).not.toContain('alice');
    expect(stored).not.toContain('s3cret');
    expect(stored).not.toContain('SUPERSECRET');
  });

  it('does not advertise source tracking when restore fails', async () => {
    vi.mocked(chrome.storage.session.get).mockRejectedValueOnce(new Error('session down'));
    const wd = dog();
    await expect(wd.ensureReady()).rejects.toThrow(/unavailable/i);
    expect(wd.sourceTrackingAvailable).toBe(false);
    expect(rig.search).not.toHaveBeenCalled();
    await expect(wd.ensureReady()).rejects.toThrow(/unavailable/i);
    expect(wd.sourceTrackingAvailable).toBe(false);
  });

  it('releases only the child session that detached', async () => {
    const wd = dog();
    const ended: Array<{ tabId: number; reason: string }> = [];
    wd.on('source-download-ended', (event) => ended.push(event));
    const known = vi
      .spyOn(cdpSessionManager, 'getKnownFrameSessions')
      .mockReturnValue([{ sessionId: 'session-b', targetId: 'target-b' }]);
    await wd.ensureReady();
    const observer = observers[0];
    emit(
      observer,
      7,
      'Page.downloadWillBegin',
      {
        frameId: 'frame-a',
        guid: 'guid-a',
        url: 'https://files.example/a.bin',
        suggestedFilename: 'a.bin',
      },
      'session-a',
    );
    emit(
      observer,
      7,
      'Page.downloadWillBegin',
      {
        frameId: 'frame-g',
        guid: 'guid-g',
        url: 'https://files.example/g.bin',
        suggestedFilename: 'g.bin',
      },
      'session-g',
    );
    emit(
      observer,
      7,
      'Page.downloadWillBegin',
      {
        frameId: 'frame-b',
        guid: 'guid-b',
        url: 'https://files.example/b.bin',
        suggestedFilename: 'b.bin',
      },
      'session-b',
    );
    emit(observer, 7, 'Page.downloadWillBegin', {
      frameId: 'frame-root',
      guid: 'guid-root',
      url: 'https://files.example/root.bin',
      suggestedFilename: 'root.bin',
    });
    expect(heldOwners.has('source-download:guid-a')).toBe(true);
    expect(heldOwners.has('source-download:guid-g')).toBe(true);
    expect(heldOwners.has('source-download:guid-b')).toBe(true);

    observer(7, 'Target.detachedFromTarget', {}, { tabId: 7, sessionId: 'session-a' });
    expect(wd.getPageDownload(7, 'guid-a')?.state).toBe('inProgress');
    expect(wd.getPageDownload(7, 'guid-b')?.state).toBe('inProgress');
    observer(
      7,
      'Target.detachedFromTarget',
      { sessionId: 'session-a' },
      { tabId: 7, sessionId: 'root-session' },
    );
    await settle();

    expect(wd.getPageDownload(7, 'guid-a')).toMatchObject({
      state: 'unknown',
      reason: 'session-detached',
      frameId: 'frame-a',
      sessionId: 'session-a',
    });
    expect(heldOwners.has('source-download:guid-a')).toBe(false);
    expect(wd.getPageDownload(7, 'guid-g')).toMatchObject({
      state: 'unknown',
      reason: 'session-detached',
      frameId: 'frame-g',
      sessionId: 'session-g',
    });
    expect(heldOwners.has('source-download:guid-g')).toBe(false);
    expect(wd.getPageDownload(7, 'guid-b')).toMatchObject({
      state: 'inProgress',
      frameId: 'frame-b',
      sessionId: 'session-b',
    });
    expect(heldOwners.has('source-download:guid-b')).toBe(true);
    expect(wd.getPageDownload(7, 'guid-root')).toMatchObject({
      state: 'inProgress',
      frameId: 'frame-root',
    });
    expect(wd.getPageDownload(7, 'guid-root')?.sessionId).toBeUndefined();
    expect(known).toHaveBeenCalledWith(7);
    expect(ended).toEqual([]);

    emit(
      observer,
      7,
      'Page.downloadProgress',
      {
        guid: 'guid-b',
        totalBytes: 8,
        receivedBytes: 8,
        state: 'completed',
      },
      'session-b',
    );
    emit(
      observer,
      7,
      'Page.downloadProgress',
      {
        guid: 'guid-a',
        totalBytes: 8,
        receivedBytes: 8,
        state: 'completed',
      },
      'session-b',
    );
    await settle();
    expect(wd.getPageDownload(7, 'guid-b')).toMatchObject({ state: 'completed', receivedBytes: 8 });
    expect(wd.getPageDownload(7, 'guid-a')?.state).toBe('unknown');
    expect(wd.getPageDownload(7, 'guid-g')?.state).toBe('unknown');
    expect(wd.getPageDownload(7, 'guid-root')?.state).toBe('inProgress');
    expect(heldOwners.has('source-download:guid-b')).toBe(false);
    expect(ended).toEqual([]);
  });
});
