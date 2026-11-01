import type { DownloadObservation } from 'chrome-mcp-shared';
import type { ToolResult } from '@/common/tool-handler';
import { downloadsWatchdog } from '../../watchdogs';

export interface WaitForDownloadOptions {
  filenameContains?: string;
  waitForComplete?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DownloadDetails {
  id: number;
  filename?: string;
  url?: string;
  mime?: string;
  fileSize?: number;
  state: string;
  danger?: string;
  startTime?: string;
  endTime?: string;
  exists?: boolean;
}

export async function waitForDownload(opts: WaitForDownloadOptions): Promise<DownloadDetails> {
  const filenameContains = String(opts.filenameContains || '').trim();
  const waitForComplete = opts.waitForComplete !== false;
  const timeoutMs = Math.max(10, Math.min(Number(opts.timeoutMs ?? 60000), 300000));
  const callTime = Date.now();

  return new Promise<DownloadDetails>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('Download wait aborted'));
      return;
    }
    let timer: any = null;
    let isSettled = false;
    const onAbort = () => onError(new Error('Download wait aborted'));

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        chrome.downloads.onCreated.removeListener(onCreated);
      } catch {}
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch {}
    };

    const onError = (err: any) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const matches = (item: chrome.downloads.DownloadItem) => {
      if (!item) return false;
      if (!filenameContains) return true;
      const name = (item.filename || '').split(/[/\\]/).pop() || '';
      return name.includes(filenameContains) || (item.url || '').includes(filenameContains);
    };

    const fulfill = async (item: chrome.downloads.DownloadItem) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();

      try {
        const [found] = await chrome.downloads.search({ id: item.id });
        const out = found || item;
        resolve({
          id: out.id,
          filename: out.filename,
          url: out.url,
          mime: (out as any).mime || undefined,
          fileSize: out.fileSize ?? out.totalBytes ?? undefined,
          state: out.state,
          danger: out.danger,
          startTime: out.startTime,
          endTime: (out as any).endTime || undefined,
          exists: (out as any).exists,
        });
      } catch {
        resolve({ id: item.id, filename: item.filename, url: item.url, state: item.state });
      }
    };

    const onCreated = (item: chrome.downloads.DownloadItem) => {
      try {
        if (isSettled || !matches(item)) return;
        if (item.state === 'interrupted') {
          onError(new Error(`Download interrupted: ${item.error || 'interrupted'}`));
          return;
        }
        if (!waitForComplete || item.state === 'complete') {
          fulfill(item);
        }
      } catch {}
    };

    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      try {
        if (isSettled || !delta || typeof delta.id !== 'number') return;
        chrome.downloads
          .search({ id: delta.id })
          .then((arr) => {
            if (isSettled) return;
            const item = arr && arr[0];
            if (!item || !matches(item)) return;
            if (item.state === 'interrupted' || delta.state?.current === 'interrupted') {
              onError(
                new Error(
                  `Download interrupted: ${item.error || delta.error?.current || 'interrupted'}`,
                ),
              );
              return;
            }
            if (waitForComplete) {
              if (item.state === 'complete') fulfill(item);
            } else {
              fulfill(item);
            }
          })
          .catch(() => {});
      } catch {}
    };

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort);
      if (opts.signal.aborted) onAbort();
    }
    timer = setTimeout(() => onError(new Error('Download wait timed out')), timeoutMs);

    // Initial check: search for already-running (in_progress) or recently completed matching downloads
    // Lookback window: 30s when filename specified, 5s when unspecified to prevent capturing stale downloads
    const lookbackMs = filenameContains ? 30000 : 5000;
    const searchStartTime = callTime - lookbackMs;

    chrome.downloads
      .search({ orderBy: ['-startTime'], limit: 30 })
      .then((arr) => {
        if (isSettled) return;
        const matching = (arr || []).filter((d) => {
          if (!matches(d)) return false;
          const itemStartTime = d.startTime ? new Date(d.startTime).getTime() : 0;
          const itemEndTime = (d as any).endTime ? new Date((d as any).endTime).getTime() : 0;
          const latestActivityTime = Math.max(itemStartTime, itemEndTime);
          return !isNaN(latestActivityTime) && latestActivityTime >= searchStartTime;
        });
        if (matching.length === 0) return;

        if (waitForComplete) {
          const completeHit = matching.find((d) => d.state === 'complete');
          if (completeHit) {
            fulfill(completeHit);
            return;
          }

          // If recently interrupted with no in_progress alternative, fail early
          const interruptedHit = matching.find((d) => d.state === 'interrupted');
          const inProgressHit = matching.find((d) => d.state === 'in_progress');
          if (interruptedHit && !inProgressHit) {
            onError(new Error(`Download interrupted: ${interruptedHit.error || 'interrupted'}`));
            return;
          }
        } else {
          const hit = matching.find((d) => d.state === 'in_progress' || d.state === 'complete');
          if (hit) {
            fulfill(hit);
            return;
          }
        }
      })
      .catch(() => {});
  });
}

export interface WaitForScopedDownloadOptions {
  tabId: number;
  guid?: string;
  filenameContains?: string;
  waitForComplete?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called once, after source tracking is ready and listeners are installed. */
  trigger?: () => Promise<ToolResult>;
}

export type ScopedDownloadStatus =
  | { kind: 'observed'; download: DownloadObservation; trigger?: ToolResult }
  | { kind: 'trigger-stopped'; result: ToolResult };

type DownloadMachineStatus = 'blocked' | 'cancelled' | 'failed' | 'unknown';

export class ScopedDownloadError extends Error {
  readonly status: DownloadMachineStatus;
  readonly outcome?: 'unknown' | 'canceled';
  readonly dispatched?: boolean;
  readonly requestDispatched?: boolean;
  readonly retry = false as const;
  readonly source?: DownloadObservation['state'];
  readonly guids: string[];
  readonly downloads: DownloadObservation[];
  readonly receipt?: unknown;
  readonly result?: ToolResult;

  constructor(
    message: string,
    init: {
      status: DownloadMachineStatus;
      outcome?: 'unknown' | 'canceled';
      dispatched?: boolean;
      requestDispatched?: boolean;
      source?: DownloadObservation['state'];
      guids: string[];
      downloads: DownloadObservation[];
      receipt?: unknown;
      result?: ToolResult;
    },
  ) {
    super(message);
    this.name = 'ScopedDownloadError';
    this.status = init.status;
    this.outcome = init.outcome;
    this.dispatched = init.dispatched;
    this.requestDispatched = init.requestDispatched;
    this.source = init.source;
    this.guids = init.guids;
    this.downloads = init.downloads;
    this.receipt = init.receipt;
    this.result = init.result;
  }
}

function payloadOf(result: ToolResult): Record<string, any> | undefined {
  const blocks = result?.content || [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i] as { type?: string; text?: string };
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Plain text is not a machine payload.
    }
  }
  return undefined;
}

function triggerStopped(result: ToolResult): boolean {
  if (!result || result.isError) return true;
  const parsed = payloadOf(result);
  if (!parsed) return true;
  if (parsed.status === 'unknown' || parsed.outcome === 'unknown') return true;
  if (typeof parsed.error === 'string' && /outcome unknown/i.test(parsed.error)) return true;
  return parsed.success !== true;
}

function carriedResult(error: unknown): ToolResult | undefined {
  const result = (error as { result?: ToolResult } | null)?.result;
  return result && Array.isArray(result.content) ? result : undefined;
}

function classify(item: DownloadObservation, waitForComplete: boolean): 'ok' | 'wait' | 'bad' {
  if (item.state === 'canceled' || item.state === 'unknown') return 'bad';
  if (item.state === 'completed' || !waitForComplete) return 'ok';
  return item.state === 'inProgress' ? 'wait' : 'bad';
}

function nameMatches(item: DownloadObservation, filter?: string): boolean {
  if (!filter) return true;
  return item.suggestedFilename.includes(filter) || item.url.includes(filter);
}

function machineFor(
  kind: string,
  dispatch: 'none' | 'requested' | 'acked',
  physical = false,
): Pick<ScopedDownloadError, 'status' | 'outcome' | 'dispatched' | 'requestDispatched'> {
  const inflight = dispatch === 'requested';
  if (kind === 'abort') {
    if (inflight) return { status: 'cancelled', outcome: 'unknown', requestDispatched: true };
    if (dispatch === 'acked') return { status: 'cancelled', dispatched: physical };
    return { status: 'cancelled', dispatched: false };
  }
  if (kind === 'timeout') {
    if (inflight) return { status: 'unknown', outcome: 'unknown', requestDispatched: true };
    if (dispatch === 'acked') return { status: 'failed', dispatched: physical };
    return { status: 'failed', dispatched: false };
  }
  if (kind === 'missing' || kind === 'unavailable' || kind === 'prepare') {
    return { status: 'blocked', dispatched: false };
  }
  if (kind === 'canceled') return { status: 'failed', outcome: 'canceled', dispatched: physical };
  if (kind === 'unknown-source' || kind === 'ended' || kind === 'trigger-unknown') {
    return {
      status: 'unknown',
      outcome: 'unknown',
      ...(inflight ? { requestDispatched: true } : { dispatched: physical }),
    };
  }
  return { status: 'failed', dispatched: dispatch === 'none' ? false : physical };
}

// shortcut: CDP guid and chrome.downloads id are different namespaces, do not correlate them unless the browser grows one shared id.
export async function waitForScopedDownload(
  opts: WaitForScopedDownloadOptions,
): Promise<ScopedDownloadStatus> {
  const filter = opts.filenameContains?.trim() || undefined;
  if (opts.signal?.aborted) {
    throw new ScopedDownloadError('Download wait aborted', {
      status: 'cancelled',
      dispatched: false,
      guids: [],
      downloads: [],
    });
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 60000);
  let phase: 'prepare' | 'observe' | 'settled' = 'prepare';
  let prepareFailure: ScopedDownloadError | undefined;
  let prepareTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectPrepare: (error: ScopedDownloadError) => void = () => {};
  const prepareBarrier = new Promise<never>((_, reject) => {
    rejectPrepare = reject;
  });
  const clearPrepare = () => {
    if (prepareTimer) clearTimeout(prepareTimer);
    prepareTimer = undefined;
    opts.signal?.removeEventListener('abort', onPrepareAbort);
  };
  const failPrepare = (error: ScopedDownloadError) => {
    if (phase !== 'prepare') return;
    prepareFailure = error;
    phase = 'settled';
    clearPrepare();
    rejectPrepare(error);
  };
  const onPrepareAbort = () => {
    failPrepare(
      new ScopedDownloadError('Download wait aborted', {
        status: 'cancelled',
        dispatched: false,
        guids: [],
        downloads: [],
      }),
    );
  };
  prepareTimer = setTimeout(
    () => {
      failPrepare(
        new ScopedDownloadError('Download wait timed out', {
          status: 'failed',
          dispatched: false,
          guids: [],
          downloads: [],
        }),
      );
    },
    Math.max(0, deadline - Date.now()),
  );
  if (opts.signal) {
    opts.signal.addEventListener('abort', onPrepareAbort);
    if (opts.signal.aborted) onPrepareAbort();
  }

  try {
    await Promise.race([downloadsWatchdog.ensureReady(), prepareBarrier]);
    if (opts.signal?.aborted) onPrepareAbort();
    if (Date.now() >= deadline) {
      failPrepare(
        new ScopedDownloadError('Download wait timed out', {
          status: 'failed',
          dispatched: false,
          guids: [],
          downloads: [],
        }),
      );
    }
    if (prepareFailure) throw prepareFailure;
    if (downloadsWatchdog.sourceTrackingAvailable !== true) {
      throw new ScopedDownloadError('Source download tracking is unavailable', {
        status: 'blocked',
        dispatched: false,
        guids: [],
        downloads: [],
      });
    }

    if (opts.guid && !opts.trigger) {
      const cached = downloadsWatchdog.getPageDownload(opts.tabId, opts.guid);
      const exact =
        cached && cached.tabId === opts.tabId && cached.guid === opts.guid ? cached : undefined;
      if (!exact) {
        throw new ScopedDownloadError(`Source download guid not observed: ${opts.guid}`, {
          status: 'blocked',
          dispatched: false,
          guids: [],
          downloads: [],
        });
      }
      if (!nameMatches(exact, filter)) {
        throw new ScopedDownloadError(
          `Source download guid does not match filenameContains: ${opts.guid}`,
          {
            status: 'failed',
            dispatched: false,
            source: exact.state,
            guids: [exact.guid],
            downloads: [exact],
          },
        );
      }
      if (
        exact.state === 'completed' ||
        (exact.state === 'inProgress' && opts.waitForComplete === false)
      ) {
        return { kind: 'observed', download: exact };
      }
      if (exact.state === 'canceled' || exact.state === 'unknown') {
        throw new ScopedDownloadError(`Source download ${exact.state}: ${exact.guid}`, {
          status: exact.state === 'canceled' ? 'failed' : 'unknown',
          outcome: exact.state === 'canceled' ? 'canceled' : 'unknown',
          dispatched: false,
          source: exact.state,
          guids: [exact.guid],
          downloads: [exact],
        });
      }
    }

    const tracked = downloadsWatchdog
      .withSourceTracking(opts.tabId, () => {
        if (phase !== 'prepare')
          throw prepareFailure || new Error('Download source preparation already ended');
        clearPrepare();
        const remaining = deadline - Date.now();
        if (opts.signal?.aborted || remaining <= 0) {
          phase = 'settled';
          return Promise.reject(
            opts.signal?.aborted
              ? new ScopedDownloadError('Download wait aborted', {
                  status: 'cancelled',
                  dispatched: false,
                  guids: [],
                  downloads: [],
                })
              : new ScopedDownloadError('Download wait timed out', {
                  status: 'failed',
                  dispatched: false,
                  guids: [],
                  downloads: [],
                }),
          );
        }
        phase = 'observe';
        return observeScopedDownload(opts, filter, remaining);
      })
      .catch((error: unknown) => {
        if (error instanceof ScopedDownloadError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new ScopedDownloadError(message, {
          status: phase === 'observe' ? 'unknown' : 'blocked',
          ...(phase === 'observe'
            ? { outcome: 'unknown', requestDispatched: Boolean(opts.trigger) }
            : { dispatched: false }),
          guids: [],
          downloads: [],
        });
      });

    return await Promise.race([tracked, prepareBarrier]);
  } catch (error) {
    if (error instanceof ScopedDownloadError) throw error;
    throw new ScopedDownloadError(error instanceof Error ? error.message : String(error), {
      status: 'blocked',
      dispatched: false,
      guids: [],
      downloads: [],
    });
  } finally {
    clearPrepare();
  }
}

function observeScopedDownload(
  opts: WaitForScopedDownloadOptions,
  filter: string | undefined,
  timeoutMs: number,
): Promise<ScopedDownloadStatus> {
  const tabId = opts.tabId;
  const guid = opts.guid;
  const waitForComplete = opts.waitForComplete !== false;
  return new Promise<ScopedDownloadStatus>((resolve, reject) => {
    let settled = false;
    let armed = Boolean(guid);
    let decide = Boolean(guid);
    let dispatch: 'none' | 'requested' | 'acked' = 'none';
    let physicalDispatched = false;
    let triggerResult: ToolResult | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let offUpdated = () => {};
    let offEnded = () => {};
    const fresh = new Map<string, DownloadObservation>();
    const preexisting = new Set<string>();
    let clickReceipt: unknown;
    const onAbort = () => fail('Download wait aborted', undefined, 'abort');

    const ordered = () => [...fresh.values()];

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      offUpdated();
      offEnded();
      opts.signal?.removeEventListener('abort', onAbort);
      settle();
    };

    const fail = (
      message: string,
      source: DownloadObservation['state'] | undefined,
      kind: string,
      downloads = ordered(),
    ) => {
      const machine = machineFor(kind, dispatch, physicalDispatched);
      finish(() =>
        reject(
          new ScopedDownloadError(message, {
            ...machine,
            ...(source ? { source } : {}),
            guids: downloads.map((item) => item.guid),
            downloads,
            receipt: clickReceipt,
            result: triggerResult,
          }),
        ),
      );
    };

    const succeed = (download: DownloadObservation, trigger?: ToolResult) => {
      finish(() => resolve({ kind: 'observed', download, ...(trigger ? { trigger } : {}) }));
    };

    const consider = () => {
      if (settled || !decide) return;
      const downloads = ordered();
      if (!guid && downloads.length > 1) {
        fail(
          'Multiple source downloads started; refusing to guess',
          undefined,
          'ambiguous',
          downloads,
        );
        return;
      }
      const current = guid ? fresh.get(guid) : downloads[0];
      if (!current) return;
      const verdict = classify(current, waitForComplete);
      if (verdict === 'bad') {
        fail(
          `Source download ${current.state}: ${current.guid}`,
          current.state,
          current.state === 'canceled' ? 'canceled' : 'unknown-source',
          [current],
        );
        return;
      }
      if (verdict === 'ok') succeed(current, triggerResult);
    };

    const take = (item: DownloadObservation) => {
      if (!armed || settled || !item || item.tabId !== tabId || !item.guid) return;
      if (typeof item.sequence !== 'number' || !Number.isFinite(item.sequence)) return;
      const seen = fresh.has(item.guid);
      if (guid) {
        if (item.guid !== guid) return;
      } else if (preexisting.has(item.guid)) {
        return;
      } else if (!seen && !nameMatches(item, filter)) {
        return;
      }
      const prev = fresh.get(item.guid);
      if (prev && prev.sequence >= item.sequence) return;
      fresh.set(item.guid, item);
      consider();
    };

    offUpdated = downloadsWatchdog.on('source-download-updated', take);
    offEnded = downloadsWatchdog.on('source-download-ended', (data: { tabId?: number }) => {
      if (!settled && data?.tabId === tabId)
        fail('Source download tracking ended', 'unknown', 'ended');
    });
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort);
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
    }
    timer = setTimeout(() => {
      const downloads = ordered();
      const source = downloads.length === 1 ? downloads[0].state : undefined;
      fail('Download wait timed out', source, 'timeout', downloads);
    }, timeoutMs);

    if (guid) {
      const found = downloadsWatchdog.getPageDownload(tabId, guid);
      if (!found || found.tabId !== tabId || found.guid !== guid) {
        fail(`Source download guid not observed: ${guid}`, undefined, 'missing', []);
        return;
      }
      if (!nameMatches(found, filter)) {
        fail(
          `Source download guid does not match filenameContains: ${guid}`,
          found.state,
          'filter',
          [found],
        );
        return;
      }
      take(found);
      return;
    }

    for (const item of downloadsWatchdog.getPageDownloads(tabId) || []) {
      if (item?.tabId === tabId && item.guid) preexisting.add(item.guid);
    }
    if (opts.signal?.aborted) {
      fail('Download wait aborted', undefined, 'abort', []);
      return;
    }
    if (!opts.trigger) {
      fail('clickTargetIndex trigger is required', undefined, 'missing', []);
      return;
    }
    void Promise.resolve()
      .then(() => {
        if (settled || opts.signal?.aborted) return undefined;
        armed = true;
        dispatch = 'requested';
        return opts.trigger!();
      })
      .then((result) => {
        if (settled || !result) return;
        triggerResult = result;
        const parsed = payloadOf(result);
        clickReceipt = parsed?.receipt;
        if (triggerStopped(result)) {
          finish(() => resolve({ kind: 'trigger-stopped', result }));
          return;
        }
        dispatch = 'acked';
        physicalDispatched = typeof parsed?.dispatched === 'boolean' ? parsed.dispatched : true;
        decide = true;
        consider();
      })
      .catch((error) => {
        if (settled) return;
        const result = carriedResult(error);
        if (result) {
          finish(() => resolve({ kind: 'trigger-stopped', result }));
          return;
        }
        if ((error as { receipt?: unknown })?.receipt !== undefined) {
          clickReceipt = (error as { receipt?: unknown }).receipt;
        }
        const message = error instanceof Error ? error.message : String(error);
        fail(message, undefined, 'trigger-unknown');
      });
  });
}

/**
 * Polls chrome.downloads.search to resolve the full disk filepath of a download item.
 * Avoids returning a temporary or relative filename before Chrome has determined the target path.
 */
export async function resolveDownloadedFilePath(
  downloadId: number,
  fallbackFilename: string,
  maxWaitMs = 1500,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item?.filename && item.filename.length > 0) {
        return item.filename;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.filename) return item.filename;
  } catch {}
  return fallbackFilename;
}
