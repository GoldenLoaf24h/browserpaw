import type { DownloadObservation } from 'chrome-mcp-shared';
import { cdpSessionManager, type CdpEventObserver } from '@/utils/cdp-session-manager';
import { BaseWatchdog } from './base-watchdog';

// GUID and chrome.downloads ids are different namespaces; never join them.
const SOURCE_STORAGE_KEY = 'browserpaw.sourceDownloads';
// shortcut: terminal cache keeps 32 unprotected records, raise it if one task must retain more history.
const MAX_TERMINAL = 32;
const MAX_GUID_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_FILENAME_LENGTH = 512;

export interface DownloadTrackItem {
  id: number;
  url: string;
  filename?: string;
  totalBytes: number;
  bytesReceived: number;
  state: 'in_progress' | 'interrupted' | 'complete';
  danger?: string;
  paused: boolean;
  startTime: number;
  endTime?: number;
  error?: string;
}

type CdpDownloadState = 'inProgress' | 'completed' | 'canceled';

interface SourceDownload extends DownloadObservation {
  sealed: boolean;
  reporters: Set<string | undefined>;
}

interface StoredSourceDownloads {
  items: DownloadObservation[];
}

function limitText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}\u2026`;
}

function cleanDownloadUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^data:/i.test(trimmed)) return 'data:';
  let cleaned = trimmed;
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, 'REDACTED');
    url.hash = '';
    cleaned = url.toString();
  } catch {
    return '';
  }
  return limitText(cleaned, MAX_URL_LENGTH);
}

function bytesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function isCdpDownloadState(value: unknown): value is CdpDownloadState {
  return value === 'inProgress' || value === 'completed' || value === 'canceled';
}

/**
 * Downloads Watchdog
 * Numeric chrome.downloads tracking stays global. Page-source tracking follows CDP
 * downloadWillBegin / downloadProgress only, keyed by tabId + guid.
 */
export class DownloadsWatchdog extends BaseWatchdog {
  public readonly name = 'downloads';
  public readonly listensTo = [
    'chrome.downloads.onCreated',
    'chrome.downloads.onChanged',
    'Page.downloadWillBegin',
    'Page.downloadProgress',
    'debugger.onDetach',
    'tabs.onRemoved',
  ];

  private downloads = new Map<number, DownloadTrackItem>();
  private onCreatedListener: ((item: any) => void) | null = null;
  private onChangedListener: ((delta: any) => void) | null = null;
  private readonly epoch = globalThis.crypto.randomUUID();
  private sequence = 0;
  private sourceObserver: CdpEventObserver | null = null;
  private onDetachListener: ((source: chrome.debugger.Debuggee, reason: string) => void) | null =
    null;
  private onTabRemovedListener: ((tabId: number) => void) | null = null;
  private byGuid = new Map<string, SourceDownload>();
  private order: string[] = [];
  private gates = new Map<string, () => void>();
  private consumers = new Map<number, number>();
  private openTabs = new Set<number>();
  private ready: Promise<void> | null = null;
  private restoreTicket = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private persistScheduled = false;
  private persistRunning = false;
  private sourceFailed = false;
  private sourceReady = false;

  public get sourceTrackingAvailable(): boolean {
    return this.isRunning && this.sourceObserver !== null && this.sourceReady && !this.sourceFailed;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.sourceFailed = false;
    this.sourceReady = false;
    this.attachNumericDownloads();
    this.attachSourceTracking();
    this.ready = this.restoreSource();
  }

  public async ensureReady(): Promise<void> {
    this.start();
    if (this.sourceFailed || !this.sourceObserver) {
      throw new Error('Download source tracking is unavailable');
    }
    await this.ready;
    if (!this.sourceTrackingAvailable) {
      throw new Error('Download source tracking is unavailable');
    }
  }

  public getPageDownloads(tabId: number): DownloadObservation[] {
    return this.order
      .map((guid) => this.byGuid.get(guid))
      .filter((item): item is SourceDownload => item?.tabId === tabId)
      .map((item) => this.snapshot(item));
  }

  public getPageDownload(tabId: number, guid: string): DownloadObservation | undefined {
    const item = this.byGuid.get(guid);
    if (!item || item.tabId !== tabId) return undefined;
    return this.snapshot(item);
  }

  public async withSourceTracking<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    await this.ensureReady();
    this.consumers.set(tabId, (this.consumers.get(tabId) || 0) + 1);
    this.openTabs.add(tabId);
    try {
      return await cdpSessionManager.withSession(tabId, `source-tracking:${tabId}`, async () => {
        await cdpSessionManager.ensureFrameSessions(tabId);
        return run();
      });
    } finally {
      this.releaseConsumer(tabId);
    }
  }

  public endSourceTracking(tabId: number, reason = 'source-ended'): void {
    this.closeTab(tabId, reason);
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.detachNumericDownloads();
    this.detachSourceTracking();
    const tabs = new Set<number>(this.openTabs);
    for (const item of this.byGuid.values()) {
      if (item.state === 'inProgress') tabs.add(item.tabId);
    }
    for (const tabId of tabs) this.closeTab(tabId, 'stopped');
    this.downloads.clear();
    this.consumers.clear();
    this.evictTerminal();
    this.ready = null;
    this.restoreTicket += 1;
  }

  public getActiveDownloads(): DownloadTrackItem[] {
    return Array.from(this.downloads.values()).filter((item) => item.state === 'in_progress');
  }

  public getDownload(id: number): DownloadTrackItem | undefined {
    return this.downloads.get(id);
  }

  private attachNumericDownloads(): void {
    if (
      typeof chrome === 'undefined' ||
      !chrome.downloads?.onCreated ||
      !chrome.downloads?.onChanged
    ) {
      return;
    }
    this.onCreatedListener = (item: any) => {
      const track: DownloadTrackItem = {
        id: item.id,
        url: item.url,
        filename: item.filename,
        totalBytes: item.totalBytes || 0,
        bytesReceived: item.bytesReceived || 0,
        state: item.state || 'in_progress',
        danger: item.danger,
        paused: Boolean(item.paused),
        startTime: Date.now(),
      };
      this.downloads.set(item.id, track);
      this.emit('download-created', track);
    };
    this.onChangedListener = (delta: any) => {
      const existing = this.downloads.get(delta.id);
      if (!existing) return;
      if (delta.filename) existing.filename = delta.filename.current;
      if (delta.state) existing.state = delta.state.current;
      if (delta.totalBytes) existing.totalBytes = delta.totalBytes.current;
      if (delta.error) existing.error = delta.error.current;
      if (delta.paused) existing.paused = delta.paused.current;
      this.emit('download-changed', { id: delta.id, delta, item: existing });
      if (delta.state?.current === 'complete') {
        existing.endTime = Date.now();
        this.emit('download-complete', existing);
      } else if (delta.state?.current === 'interrupted') {
        existing.endTime = Date.now();
        this.emit('download-interrupted', existing);
      }
    };
    try {
      chrome.downloads.onCreated.addListener(this.onCreatedListener);
      chrome.downloads.onChanged.addListener(this.onChangedListener);
    } catch {
      this.onCreatedListener = null;
      this.onChangedListener = null;
    }
  }

  private detachNumericDownloads(): void {
    if (typeof chrome === 'undefined' || !chrome.downloads) return;
    if (this.onCreatedListener && chrome.downloads.onCreated) {
      try {
        chrome.downloads.onCreated.removeListener(this.onCreatedListener);
      } catch {}
      this.onCreatedListener = null;
    }
    if (this.onChangedListener && chrome.downloads.onChanged) {
      try {
        chrome.downloads.onChanged.removeListener(this.onChangedListener);
      } catch {}
      this.onChangedListener = null;
    }
  }

  private attachSourceTracking(): void {
    this.sourceObserver = (tabId, method, params, source) => {
      if (!this.isRunning || typeof tabId !== 'number') return;
      if (source && typeof source.tabId === 'number' && source.tabId !== tabId) return;
      try {
        if (method === 'Target.detachedFromTarget') this.onChildSessionDetached(tabId, params);
        else if (method === 'Page.downloadWillBegin')
          this.onDownloadWillBegin(tabId, params, source);
        else if (method === 'Page.downloadProgress') this.onDownloadProgress(tabId, params, source);
      } catch {}
    };
    try {
      cdpSessionManager.addCdpEventObserver(this.sourceObserver);
    } catch {
      this.sourceObserver = null;
      this.failSource();
    }
    if (typeof chrome === 'undefined') return;
    if (chrome.debugger?.onDetach?.addListener) {
      this.onDetachListener = (source) => {
        if (!this.isRunning || typeof source?.tabId !== 'number') return;
        this.closeTab(source.tabId, 'debugger-detached');
      };
      try {
        chrome.debugger.onDetach.addListener(this.onDetachListener);
      } catch {
        this.onDetachListener = null;
      }
    }
    if (chrome.tabs?.onRemoved?.addListener) {
      this.onTabRemovedListener = (tabId) => {
        if (!this.isRunning || typeof tabId !== 'number') return;
        this.closeTab(tabId, 'tab-removed');
      };
      try {
        chrome.tabs.onRemoved.addListener(this.onTabRemovedListener);
      } catch {
        this.onTabRemovedListener = null;
      }
    }
  }

  private detachSourceTracking(): void {
    if (this.sourceObserver) {
      try {
        cdpSessionManager.removeCdpEventObserver(this.sourceObserver);
      } catch {}
      this.sourceObserver = null;
    }
    if (this.onDetachListener && chrome.debugger?.onDetach?.removeListener) {
      try {
        chrome.debugger.onDetach.removeListener(this.onDetachListener);
      } catch {}
      this.onDetachListener = null;
    }
    if (this.onTabRemovedListener && chrome.tabs?.onRemoved?.removeListener) {
      try {
        chrome.tabs.onRemoved.removeListener(this.onTabRemovedListener);
      } catch {}
      this.onTabRemovedListener = null;
    }
  }

  private onDownloadWillBegin(
    tabId: number,
    params: any,
    source?: chrome.debugger.Debuggee & { sessionId?: string },
  ): void {
    const guid = typeof params?.guid === 'string' ? params.guid : '';
    const frameId = typeof params?.frameId === 'string' ? params.frameId : '';
    if (!guid || guid.length > MAX_GUID_LENGTH || !frameId) return;
    const sessionId = this.sessionIdOf(source);
    const existing = this.byGuid.get(guid);
    if (existing) {
      if (existing.tabId !== tabId || existing.frameId !== frameId || existing.sealed) return;
      if (existing.state === 'completed' || existing.state === 'canceled') return;
      existing.url = cleanDownloadUrl(params?.url);
      existing.suggestedFilename = this.filenameOf(params?.suggestedFilename);
      existing.reporters.add(sessionId);
      if (sessionId) existing.sessionId = sessionId;
      if (existing.state !== 'inProgress') existing.state = 'inProgress';
      this.touch(existing);
      this.openTabs.add(tabId);
      this.arm(tabId, guid);
      this.publish(existing);
      return;
    }
    const now = Date.now();
    const created: SourceDownload = {
      guid,
      tabId,
      frameId,
      ...(sessionId ? { sessionId } : {}),
      url: cleanDownloadUrl(params?.url),
      suggestedFilename: this.filenameOf(params?.suggestedFilename),
      state: 'inProgress',
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: now,
      updatedAt: now,
      epoch: this.epoch,
      sequence: ++this.sequence,
      sealed: false,
      reporters: new Set([sessionId]),
    };
    this.byGuid.set(guid, created);
    this.order.push(guid);
    this.openTabs.add(tabId);
    this.arm(tabId, guid);
    this.publish(created);
  }

  private onDownloadProgress(
    tabId: number,
    params: any,
    source?: chrome.debugger.Debuggee & { sessionId?: string },
  ): void {
    const guid = typeof params?.guid === 'string' ? params.guid : '';
    const item = guid ? this.byGuid.get(guid) : undefined;
    if (!item || item.tabId !== tabId || !isCdpDownloadState(params?.state)) return;
    if (item.sealed || item.state === 'completed' || item.state === 'canceled') return;
    const sessionId = this.sessionIdOf(source);
    item.reporters.add(sessionId);
    if (sessionId) item.sessionId = sessionId;
    item.receivedBytes = bytesOf(params?.receivedBytes);
    item.totalBytes = bytesOf(params?.totalBytes);
    item.state = params.state;
    this.touch(item);
    if (item.state === 'inProgress') this.arm(item.tabId, item.guid);
    else {
      item.sealed = true;
      this.release(item.guid);
    }
    this.publish(item);
  }

  private publish(item: SourceDownload): void {
    this.evictTerminal();
    this.emit('source-download-updated', this.snapshot(item));
    this.schedulePersist();
  }

  private closeTab(tabId: number, reason: string): void {
    const wasOpen = this.openTabs.delete(tabId);
    let lost = false;
    for (const item of this.byGuid.values()) {
      if (item.tabId !== tabId) continue;
      item.sealed = true;
      this.release(item.guid);
      if (item.state !== 'inProgress') continue;
      item.state = 'unknown';
      item.reason = reason;
      this.touch(item);
      this.emit('source-download-updated', this.snapshot(item));
      lost = true;
    }
    if (!wasOpen && !lost) return;
    this.evictTerminal();
    this.schedulePersist();
    this.emit('source-download-ended', { tabId, reason });
  }

  private arm(tabId: number, guid: string): void {
    if (this.gates.has(guid) || !this.isRunning) return;
    let resolve = () => {};
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    this.gates.set(guid, resolve);
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(
        cdpSessionManager.withSession(tabId, `source-download:${guid}`, () => gate),
      );
    } catch {
      pending = Promise.reject(new Error('source owner failed'));
    }
    void pending.catch(() => {
      this.loseOwner(guid);
    });
  }

  private loseOwner(guid: string): void {
    if (!this.gates.has(guid)) return;
    const item = this.byGuid.get(guid);
    this.release(guid);
    if (!item || item.sealed || item.state !== 'inProgress') return;
    item.sealed = true;
    item.state = 'unknown';
    item.reason = 'source-owner-lost';
    this.touch(item);
    this.emit('source-download-updated', this.snapshot(item));
    this.schedulePersist();
  }

  private release(guid: string): void {
    const resolve = this.gates.get(guid);
    if (!resolve) return;
    this.gates.delete(guid);
    resolve();
  }

  private async restoreSource(): Promise<void> {
    const ticket = ++this.restoreTicket;
    const session = typeof chrome === 'undefined' ? undefined : chrome.storage?.session;
    if (!session || typeof session.get !== 'function') {
      this.failSource();
      return;
    }
    let bag: any;
    try {
      bag = await session.get(SOURCE_STORAGE_KEY);
    } catch {
      if (ticket === this.restoreTicket && this.isRunning) this.failSource();
      return;
    }
    if (ticket !== this.restoreTicket || !this.isRunning) return;
    const items = bag?.[SOURCE_STORAGE_KEY]?.items;
    if (!Array.isArray(items)) {
      this.markSourceReady(ticket);
      return;
    }
    for (const raw of items) {
      if (!this.restorable(raw) || this.byGuid.has(raw.guid)) continue;
      const state = raw.state === 'completed' || raw.state === 'canceled' ? raw.state : 'unknown';
      const restored: SourceDownload = {
        guid: raw.guid,
        tabId: raw.tabId,
        frameId: raw.frameId,
        ...(typeof raw.sessionId === 'string' && raw.sessionId ? { sessionId: raw.sessionId } : {}),
        url: cleanDownloadUrl(raw.url),
        suggestedFilename: this.filenameOf(raw.suggestedFilename),
        state,
        receivedBytes: bytesOf(raw.receivedBytes),
        totalBytes: bytesOf(raw.totalBytes),
        startedAt: raw.startedAt,
        updatedAt: raw.updatedAt,
        epoch: typeof raw.epoch === 'string' && raw.epoch ? raw.epoch : this.epoch,
        sequence: raw.sequence,
        sealed: state !== 'unknown',
        reporters: new Set([typeof raw.sessionId === 'string' ? raw.sessionId : undefined]),
        ...(state === 'unknown'
          ? { reason: 'worker-restart' }
          : typeof raw.reason === 'string' && raw.reason
            ? { reason: raw.reason }
            : {}),
      };
      this.byGuid.set(restored.guid, restored);
      this.order.push(restored.guid);
    }
    this.evictTerminal();
    this.schedulePersist();
    this.markSourceReady(ticket);
  }

  private markSourceReady(ticket: number): void {
    if (
      ticket !== this.restoreTicket ||
      !this.isRunning ||
      this.sourceFailed ||
      !this.sourceObserver
    ) {
      return;
    }
    this.sourceReady = true;
  }

  private failSource(): void {
    this.sourceFailed = true;
    this.sourceReady = false;
  }

  private onChildSessionDetached(tabId: number, params: any): void {
    if (typeof params?.sessionId !== 'string' || !params.sessionId) return;
    let live: Array<{ sessionId?: string }>;
    try {
      live = cdpSessionManager.getKnownFrameSessions(tabId);
    } catch {
      return;
    }
    const alive = new Set(
      live.map((session) => session.sessionId).filter((id): id is string => !!id),
    );
    for (const item of this.byGuid.values()) {
      if (item.tabId !== tabId || item.state !== 'inProgress') continue;
      if ([...item.reporters].some((sessionId) => sessionId === undefined || alive.has(sessionId)))
        continue;
      item.sealed = true;
      item.state = 'unknown';
      item.reason = 'session-detached';
      this.touch(item);
      this.release(item.guid);
      this.emit('source-download-updated', this.snapshot(item));
      this.schedulePersist();
    }
  }

  private evictTerminal(): void {
    const terminals = this.order.filter((guid) => {
      const item = this.byGuid.get(guid);
      return !!item && item.state !== 'inProgress';
    });
    let overflow = terminals.length - MAX_TERMINAL;
    if (overflow <= 0) return;
    for (const guid of terminals) {
      if (overflow <= 0) break;
      const item = this.byGuid.get(guid);
      if (!item || (this.consumers.get(item.tabId) || 0) > 0) continue;
      this.release(guid);
      this.byGuid.delete(guid);
      const index = this.order.indexOf(guid);
      if (index >= 0) this.order.splice(index, 1);
      overflow -= 1;
    }
  }

  private releaseConsumer(tabId: number): void {
    const left = (this.consumers.get(tabId) || 0) - 1;
    if (left > 0) {
      this.consumers.set(tabId, left);
      return;
    }
    this.consumers.delete(tabId);
    this.evictTerminal();
  }

  private restorable(raw: any): boolean {
    return (
      !!raw &&
      typeof raw.guid === 'string' &&
      raw.guid.length > 0 &&
      raw.guid.length <= MAX_GUID_LENGTH &&
      Number.isSafeInteger(raw.tabId) &&
      raw.tabId > 0 &&
      typeof raw.frameId === 'string' &&
      raw.frameId.length > 0 &&
      typeof raw.startedAt === 'number' &&
      Number.isFinite(raw.startedAt) &&
      typeof raw.updatedAt === 'number' &&
      Number.isFinite(raw.updatedAt) &&
      typeof raw.sequence === 'number' &&
      Number.isFinite(raw.sequence)
    );
  }

  private schedulePersist(): void {
    this.persistScheduled = true;
    if (this.persistRunning) return;
    this.persistRunning = true;
    this.persistChain = this.persistChain
      .then(() => this.flushPersist())
      .catch(() => undefined)
      .finally(() => {
        this.persistRunning = false;
        if (this.persistScheduled) this.schedulePersist();
      });
  }

  private async flushPersist(): Promise<void> {
    while (this.persistScheduled) {
      this.persistScheduled = false;
      const snap: StoredSourceDownloads = {
        items: this.order
          .map((guid) => this.byGuid.get(guid))
          .filter((item): item is SourceDownload => !!item)
          .map((item) => this.snapshot(item)),
      };
      try {
        await chrome.storage?.session?.set?.({ [SOURCE_STORAGE_KEY]: snap });
      } catch {
        // Memory still has the latest record; the next mutation schedules one write.
      }
    }
  }

  private touch(item: SourceDownload): void {
    item.updatedAt = Date.now();
    item.epoch = this.epoch;
    item.sequence = ++this.sequence;
  }

  private snapshot(item: SourceDownload): DownloadObservation {
    return {
      guid: item.guid,
      tabId: item.tabId,
      frameId: item.frameId,
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      url: item.url,
      suggestedFilename: item.suggestedFilename,
      state: item.state,
      receivedBytes: item.receivedBytes,
      totalBytes: item.totalBytes,
      startedAt: item.startedAt,
      updatedAt: item.updatedAt,
      epoch: item.epoch,
      sequence: item.sequence,
      ...(item.reason ? { reason: item.reason } : {}),
    };
  }

  private sessionIdOf(source?: { sessionId?: string }): string | undefined {
    return typeof source?.sessionId === 'string' && source.sessionId ? source.sessionId : undefined;
  }

  private filenameOf(value: unknown): string {
    return typeof value === 'string' ? limitText(value, MAX_FILENAME_LENGTH) : '';
  }
}

export const downloadsWatchdog = new DownloadsWatchdog();
