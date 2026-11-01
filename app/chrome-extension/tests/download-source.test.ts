import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadObservation } from 'chrome-mcp-shared';
import { handleDownloadTool } from '../entrypoints/background/tools/browser/download';
import { waitForDownload } from '../entrypoints/background/tools/browser/download-waiter';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { downloadsWatchdog } from '../entrypoints/background/watchdogs';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { sessionTabAffinity } from '../utils/session-tab-affinity';

function obs(
  partial: Partial<DownloadObservation> & Pick<DownloadObservation, 'guid' | 'tabId'>,
): DownloadObservation {
  return {
    frameId: 'F1',
    url: 'https://example.com/files/a.pdf',
    suggestedFilename: 'a.pdf',
    state: 'inProgress',
    receivedBytes: 1,
    totalBytes: 10,
    startedAt: 10,
    updatedAt: 11,
    epoch: 'epoch-1',
    sequence: 1,
    ...partial,
  };
}

function payloadOf(result: { content?: Array<{ type?: string; text?: string }> }) {
  const text = result.content?.find((block) => block.type === 'text')?.text || '';
  return JSON.parse(text);
}

describe('scoped download production chain', () => {
  let pageDownloads: DownloadObservation[];
  let order: string[];
  let activeListeners: number;
  let clickCount: number;
  let unhandled: unknown[];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };

  beforeEach(() => {
    pageDownloads = [];
    order = [];
    activeListeners = 0;
    clickCount = 0;
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    downloadsWatchdog.removeAllListeners();

    const originalOn = downloadsWatchdog.on.bind(downloadsWatchdog);
    vi.spyOn(downloadsWatchdog, 'on').mockImplementation((event: string, handler: any) => {
      if (event === 'source-download-updated' || event === 'source-download-ended') {
        order.push('listen');
        activeListeners += 1;
      }
      const off = originalOn(event, handler);
      return () => {
        if (event === 'source-download-updated' || event === 'source-download-ended') {
          activeListeners -= 1;
        }
        off();
      };
    });

    vi.spyOn(downloadsWatchdog, 'sourceTrackingAvailable', 'get').mockReturnValue(true);
    vi.spyOn(downloadsWatchdog, 'ensureReady').mockResolvedValue(undefined);
    vi.spyOn(downloadsWatchdog, 'getPageDownloads').mockImplementation((tabId: number) =>
      pageDownloads.filter((item) => item.tabId === tabId),
    );
    vi.spyOn(downloadsWatchdog, 'getPageDownload').mockImplementation(
      (tabId: number, guid: string) =>
        pageDownloads.find((item) => item.tabId === tabId && item.guid === guid),
    );
    vi.spyOn(downloadsWatchdog, 'withSourceTracking').mockImplementation(
      async (_tabId: number, run: () => Promise<any>) => {
        order.push('ready');
        return run();
      },
    );

    vi.spyOn(interactIndexTool, 'execute').mockImplementation(async () => {
      clickCount += 1;
      order.push('click');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              receipt: { hasReceipt: true, dialog: { type: 'alert', message: 'clicked' } },
            }),
          },
        ],
        isError: false,
      };
    });

    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      downloads: {
        search: vi.fn(async () => [
          {
            id: 99,
            filename: 'C:/Users/Lenovo/Downloads/a.pdf',
            url: 'https://example.com/files/a.pdf',
            state: 'complete',
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
          },
        ]),
        cancel: vi.fn(async () => {}),
        download: vi.fn(async () => 99),
        onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    downloadsWatchdog.removeAllListeners();
    vi.restoreAllMocks();
  });

  async function noLeaks() {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
    expect(activeListeners).toBe(0);
    expect((globalThis as any).chrome.downloads.cancel).not.toHaveBeenCalled();
  }

  it('keeps the legacy filename waiter and does not require a page scope', async () => {
    const result = await waitForDownload({ filenameContains: 'a.pdf', timeoutMs: 1000 });
    expect(result).toMatchObject({
      id: 99,
      state: 'complete',
      filename: 'C:/Users/Lenovo/Downloads/a.pdf',
    });

    const tool = await handleDownloadTool.execute({ filenameContains: 'a.pdf', timeoutMs: 1000 });
    expect(payloadOf(tool)).toMatchObject({ success: true, download: { id: 99 } });
    expect(clickCount).toBe(0);
  });

  it('does not let another tab with the same filename satisfy a scoped click', async () => {
    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      order.push('click');
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({
          guid: 'other-tab',
          tabId: 8,
          state: 'completed',
          sequence: 4,
          suggestedFilename: 'a.pdf',
        }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    });

    const result = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 3,
      filenameContains: 'a.pdf',
      timeoutMs: 50,
    });

    expect(result.isError).toBe(true);
    expect(payloadOf(result).download?.id).not.toBe(99);
    expect(payloadOf(result).guids).not.toContain('other-tab');
    expect((globalThis as any).chrome.downloads.search).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.downloads.onCreated.addListener).not.toHaveBeenCalled();
    await noLeaks();
  });

  it('installs source tracking and the update listener before the single click', async () => {
    const seen: string[] = [];
    vi.mocked(interactIndexTool.execute).mockImplementation(async (args: any) => {
      clickCount += 1;
      seen.push(...order);
      order.push('click');
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'new-1', tabId: args.tabId, state: 'inProgress', sequence: 2 }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    });

    const result = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 4,
      frameId: 2,
      waitForComplete: false,
      timeoutMs: 1000,
    });

    expect(seen.indexOf('ready')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('ready')).toBeLessThan(seen.indexOf('listen'));
    expect(clickCount).toBe(1);
    expect(interactIndexTool.execute).toHaveBeenCalledWith({
      tabId: 7,
      index: 4,
      frameId: 2,
      action: 'click',
      includeDelta: false,
    });
    expect(payloadOf(result)).toMatchObject({
      success: true,
      started: true,
      browserCompleted: false,
      verifiedPath: false,
      download: { guid: 'new-1', tabId: 7, state: 'inProgress' },
    });
    expect(JSON.stringify(payloadOf(result))).not.toContain('C:/Users');
    await noLeaks();
  });

  it('does not take the tab mutex around interact', async () => {
    let depth = 0;
    vi.spyOn(sessionTabAffinity, 'runSerialized').mockImplementation(
      async (_key: string | number, op: () => Promise<any>) => {
        if (depth > 0) throw new Error('reentrant tab lock');
        depth += 1;
        try {
          return await op();
        } finally {
          depth -= 1;
        }
      },
    );
    vi.mocked(interactIndexTool.execute).mockImplementation(async (args: any) => {
      clickCount += 1;
      return sessionTabAffinity.runSerialized(args.tabId, async () => {
        downloadsWatchdog.emit(
          'source-download-updated',
          obs({ guid: 'locked', tabId: args.tabId, state: 'completed', sequence: 1 }),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
          isError: false,
        };
      });
    });

    const result = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 1,
      waitForComplete: true,
      timeoutMs: 1000,
    });
    expect(result.isError).toBe(false);
    expect(payloadOf(result).download.guid).toBe('locked');
    expect(clickCount).toBe(1);
    await noLeaks();
  });

  it('returns the original trigger result once when the click outcome is unknown or an error', async () => {
    const unknown = {
      content: [
        {
          type: 'text',
          text: 'CDP Input.dispatchMouseEvent outcome unknown: connection lost after dispatch',
        },
      ],
      isError: true,
    };
    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'maybe', tabId: 7, state: 'completed', sequence: 1 }),
      );
      return unknown;
    });

    const result = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 2,
      timeoutMs: 1000,
    });
    expect(result).toBe(unknown);
    expect(clickCount).toBe(1);
    await noLeaks();
  });

  it('keeps acknowledged trigger content and structured data when the download later times out', async () => {
    const image = { type: 'image' as const, data: 'image-data', mimeType: 'image/png' };
    vi.mocked(interactIndexTool.execute).mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify({ success: true, textMarker: 'original-text' }) },
        image,
      ],
      structuredContent: { structuredMarker: 'original-structured' },
      isError: false,
    });
    const response = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 1,
      timeoutMs: 50,
    });
    expect(response.isError).toBe(true);
    expect(response.content).toContainEqual(image);
    expect(payloadOf(response)).toMatchObject({
      success: false,
      textMarker: 'original-text',
      structuredMarker: 'original-structured',
    });
    expect(response.structuredContent).toMatchObject({
      success: false,
      structuredMarker: 'original-structured',
    });
  });

  it('queries an observed guid exactly and does not wait for the same filename', async () => {
    pageDownloads = [
      obs({ guid: 'ready', tabId: 7, state: 'completed', sequence: 5, suggestedFilename: 'a.pdf' }),
      obs({
        guid: 'same-name',
        tabId: 8,
        state: 'completed',
        sequence: 6,
        suggestedFilename: 'a.pdf',
      }),
    ];

    const found = await handleDownloadTool.execute({
      tabId: 7,
      guid: 'ready',
      filenameContains: 'a.pdf',
      timeoutMs: 5000,
    });
    expect(clickCount).toBe(0);
    expect(payloadOf(found)).toMatchObject({
      success: true,
      browserCompleted: true,
      verifiedPath: false,
      download: { guid: 'ready', state: 'completed' },
    });
    expect(downloadsWatchdog.withSourceTracking).not.toHaveBeenCalled();

    const started = Date.now();
    const missing = await handleDownloadTool.execute({
      tabId: 7,
      guid: 'missing',
      filenameContains: 'a.pdf',
      timeoutMs: 5000,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(missing.isError).toBe(true);
    expect(payloadOf(missing)).toMatchObject({
      success: false,
      status: 'blocked',
      dispatched: false,
      retry: false,
      guids: [],
    });
    expect(payloadOf(missing).error).toMatch(/not observed/i);
    expect((globalThis as any).chrome.downloads.search).not.toHaveBeenCalled();
    expect(downloadsWatchdog.withSourceTracking).not.toHaveBeenCalled();
    await noLeaks();
  });

  it('returns an in-progress guid without waiting, and waits only on that guid until completed', async () => {
    pageDownloads = [obs({ guid: 'live', tabId: 7, state: 'inProgress', sequence: 2 })];
    const started = await handleDownloadTool.execute({
      tabId: 7,
      guid: 'live',
      waitForComplete: false,
      timeoutMs: 5000,
    });
    expect(payloadOf(started)).toMatchObject({
      started: true,
      browserCompleted: false,
      download: { guid: 'live', state: 'inProgress' },
    });
    expect(downloadsWatchdog.withSourceTracking).not.toHaveBeenCalled();

    pageDownloads = [obs({ guid: 'live', tabId: 7, state: 'inProgress', sequence: 2 })];
    const pending = handleDownloadTool.execute({
      tabId: 7,
      guid: 'live',
      waitForComplete: true,
      timeoutMs: 1000,
    });
    await vi.waitFor(() => expect(order).toContain('ready'));
    downloadsWatchdog.emit(
      'source-download-updated',
      obs({ guid: 'live', tabId: 7, state: 'canceled', sequence: 1 }),
    );
    downloadsWatchdog.emit(
      'source-download-updated',
      obs({ guid: 'other', tabId: 7, state: 'completed', sequence: 3 }),
    );
    downloadsWatchdog.emit(
      'source-download-updated',
      obs({ guid: 'live', tabId: 7, state: 'completed', sequence: 4 }),
    );
    expect(payloadOf(await pending)).toMatchObject({
      browserCompleted: true,
      verifiedPath: false,
      download: { guid: 'live', sequence: 4, state: 'completed' },
    });
    await noLeaks();
  });

  it('reports unknown and canceled guids without guessing a filename match', async () => {
    pageDownloads = [obs({ guid: 'bad', tabId: 7, state: 'unknown', sequence: 1 })];
    const unknown = payloadOf(
      await handleDownloadTool.execute({
        tabId: 7,
        guid: 'bad',
        filenameContains: 'a.pdf',
        timeoutMs: 1000,
      }),
    );
    expect(unknown).toMatchObject({
      success: false,
      status: 'unknown',
      outcome: 'unknown',
      source: 'unknown',
      dispatched: false,
      retry: false,
      guids: ['bad'],
    });

    pageDownloads = [
      obs({ guid: 'stopped', tabId: 7, state: 'canceled', sequence: 2, reason: 'user' }),
    ];
    const canceled = payloadOf(
      await handleDownloadTool.execute({ tabId: 7, guid: 'stopped', timeoutMs: 1000 }),
    );
    expect(canceled).toMatchObject({
      success: false,
      status: 'failed',
      outcome: 'canceled',
      source: 'canceled',
      dispatched: false,
      retry: false,
      guids: ['stopped'],
    });
    expect(clickCount).toBe(0);
    expect(downloadsWatchdog.withSourceTracking).not.toHaveBeenCalled();
    await noLeaks();
  });

  it('rejects ambiguous new guids and ignores downloads that already existed', async () => {
    pageDownloads = [obs({ guid: 'old', tabId: 7, state: 'inProgress', sequence: 1 })];
    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'old', tabId: 7, state: 'completed', sequence: 8 }),
      );
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'b', tabId: 7, state: 'inProgress', sequence: 1 }),
      );
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'a', tabId: 7, state: 'completed', sequence: 2 }),
      );
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'b', tabId: 7, state: 'completed', sequence: 9 }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    });

    const ambiguous = payloadOf(
      await handleDownloadTool.execute({ tabId: 7, clickTargetIndex: 1, timeoutMs: 1000 }),
    );
    expect(ambiguous).toMatchObject({
      success: false,
      status: 'failed',
      dispatched: true,
      retry: false,
    });
    expect(ambiguous.outcome).toBeUndefined();
    expect(ambiguous.guids).toEqual(['b', 'a']);
    expect(ambiguous.download).toBeUndefined();
    expect(clickCount).toBe(1);

    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'old', tabId: 7, state: 'completed', sequence: 9 }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    });
    const onlyOld = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 1,
      timeoutMs: 50,
    });
    expect(onlyOld.isError).toBe(true);
    expect(payloadOf(onlyOld).guids).not.toContain('old');
    await noLeaks();
  });

  it('clears listeners on abort and timeout and does not click twice or cancel the browser download', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const pre = await handleDownloadTool.execute(
      { tabId: 7, clickTargetIndex: 1, timeoutMs: 1000 },
      { signal: ctrl.signal },
    );
    expect(pre.isError).toBe(true);
    expect(payloadOf(pre)).toMatchObject({ status: 'cancelled', dispatched: false, retry: false });
    expect(payloadOf(pre).outcome).toBeUndefined();
    expect(clickCount).toBe(0);
    expect((downloadsWatchdog as any).withSourceTracking).not.toHaveBeenCalled();

    const during = new AbortController();
    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      during.abort();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              receipt: { hasReceipt: true, dialog: { type: 'alert', message: 'sent' } },
            }),
          },
        ],
        isError: false,
      };
    });
    const aborted = payloadOf(
      await handleDownloadTool.execute(
        { tabId: 7, clickTargetIndex: 1, timeoutMs: 1000 },
        { signal: during.signal },
      ),
    );
    expect(aborted).toMatchObject({
      success: false,
      status: 'cancelled',
      outcome: 'unknown',
      retry: false,
      requestDispatched: true,
    });
    expect(aborted.dispatched).not.toBe(true);
    expect(clickCount).toBe(1);

    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'slow', tabId: 7, state: 'inProgress', sequence: 2 }),
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              receipt: { hasReceipt: true, fileChooser: { mode: 'selectSingle' } },
            }),
          },
        ],
        isError: false,
      };
    });
    const timedOut = payloadOf(
      await handleDownloadTool.execute({ tabId: 7, clickTargetIndex: 1, timeoutMs: 50 }),
    );
    expect(timedOut).toMatchObject({
      success: false,
      status: 'failed',
      dispatched: true,
      retry: false,
      source: 'inProgress',
      guids: ['slow'],
      receipt: { hasReceipt: true, fileChooser: { mode: 'selectSingle' } },
    });
    expect(timedOut.outcome).toBeUndefined();
    expect(clickCount).toBe(2);
    await noLeaks();
  });

  it('stops when source tracking ends and rejects a scoped call before dispatch when tracking is unavailable', async () => {
    pageDownloads = [obs({ guid: 'live', tabId: 7, state: 'inProgress', sequence: 1 })];
    const pending = handleDownloadTool.execute({ tabId: 7, guid: 'live', timeoutMs: 1000 });
    await vi.waitFor(() => expect(activeListeners).toBeGreaterThan(0));
    downloadsWatchdog.emit('source-download-ended', { tabId: 8, reason: 'elsewhere' });
    downloadsWatchdog.emit('source-download-ended', { tabId: 7, reason: 'detached' });
    const ended = payloadOf(await pending);
    expect(ended).toMatchObject({
      success: false,
      status: 'unknown',
      outcome: 'unknown',
      retry: false,
      dispatched: false,
    });
    expect(activeListeners).toBe(0);

    vi.spyOn(downloadsWatchdog, 'sourceTrackingAvailable', 'get').mockReturnValue(false);
    const blocked = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 5,
      timeoutMs: 1000,
    });
    expect(blocked.isError).toBe(true);
    expect(payloadOf(blocked).error).toMatch(/unavailable/i);
    expect(payloadOf(blocked)).toMatchObject({
      status: 'blocked',
      dispatched: false,
      retry: false,
    });
    expect(clickCount).toBe(0);
    expect((downloadsWatchdog as any).withSourceTracking).toHaveBeenCalledTimes(1);
    await noLeaks();
  });

  it('rejects invalid scope before any listener or click', async () => {
    const cases = [
      [{ tabId: 1.5, clickTargetIndex: 1 }, /tabId/i],
      [{ guid: 'abc', clickTargetIndex: 1, tabId: 7 }, /exclusive/i],
      [{ frameId: 1, tabId: 7, guid: 'abc' }, /frameId/i],
      [{ clickTargetIndex: 1 }, /tabId/i],
      [{ guid: 'abc' }, /tabId/i],
      [{ tabId: 7, clickTargetIndex: 1, timeoutMs: Number.POSITIVE_INFINITY }, /timeoutMs/i],
      [{ tabId: 7, clickTargetIndex: 1, timeoutMs: 49 }, /timeoutMs/i],
      [{ tabId: 7, clickTargetIndex: 1, timeoutMs: 1.5 }, /timeoutMs/i],
      [{ tabId: 7, clickTargetIndex: 1, waitForComplete: 'yes' }, /waitForComplete/i],
      [{ tabId: 7, clickTargetIndex: 1, filenameContains: 1 }, /filenameContains/i],
      [{ tabId: 7 }, /guid|clickTargetIndex/i],
    ] as const;

    for (const [args, pattern] of cases) {
      const result = await handleDownloadTool.execute(args as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(pattern);
      expect(JSON.parse(result.content[0].text as string)).toMatchObject({
        status: 'blocked',
        dispatched: false,
        retry: false,
      });
    }
    expect(clickCount).toBe(0);
    expect(order).not.toContain('listen');
    expect((globalThis as any).chrome.downloads.onCreated.addListener).not.toHaveBeenCalled();
  });

  it('filters filenameContains inside the confirmed guid or new trigger guids only', async () => {
    pageDownloads = [
      obs({
        guid: 'ready',
        tabId: 7,
        state: 'completed',
        sequence: 4,
        suggestedFilename: 'report.pdf',
        url: 'https://example.com/report.pdf',
      }),
    ];
    const mismatch = payloadOf(
      await handleDownloadTool.execute({
        tabId: 7,
        guid: 'ready',
        filenameContains: 'other.bin',
        timeoutMs: 5000,
      }),
    );
    expect(mismatch).toMatchObject({
      success: false,
      status: 'failed',
      dispatched: false,
      retry: false,
      guids: ['ready'],
    });
    expect(mismatch.error).toMatch(/filenameContains/i);
    expect((globalThis as any).chrome.downloads.search).not.toHaveBeenCalled();
    expect(downloadsWatchdog.withSourceTracking).not.toHaveBeenCalled();

    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({
          guid: 'skip',
          tabId: 7,
          state: 'completed',
          sequence: 1,
          suggestedFilename: 'skip.bin',
          url: 'https://example.com/skip.bin',
        }),
      );
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({
          guid: 'keep',
          tabId: 7,
          state: 'inProgress',
          sequence: 8,
          suggestedFilename: 'keep.pdf',
          url: 'https://example.com/keep.pdf',
        }),
      );
      return {
        content: [
          { type: 'text', text: JSON.stringify({ success: true, receipt: { hasReceipt: true } }) },
        ],
        isError: false,
      };
    });
    const matched = payloadOf(
      await handleDownloadTool.execute({
        tabId: 7,
        clickTargetIndex: 2,
        filenameContains: 'keep.pdf',
        waitForComplete: false,
        timeoutMs: 1000,
      }),
    );
    expect(matched).toMatchObject({
      success: true,
      download: { guid: 'keep', tabId: 7 },
      verifiedPath: false,
    });
    expect(clickCount).toBe(1);
    await noLeaks();
  });

  it('keeps the trigger content and receipt when the source download starts', async () => {
    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'shot', tabId: 7, state: 'completed', sequence: 2 }),
      );
      return {
        content: [
          { type: 'image', data: 'img-bytes', mimeType: 'image/png' },
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              clicked: 1,
              receipt: { hasReceipt: true, dialog: { type: 'alert', message: 'go' } },
            }),
          },
        ],
        isError: false,
      };
    });
    const result = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 1,
      timeoutMs: 1000,
    });
    expect(result.content[0]).toEqual({ type: 'image', data: 'img-bytes', mimeType: 'image/png' });
    const body = JSON.parse(result.content[1].text as string);
    expect(body).toMatchObject({
      success: true,
      clicked: 1,
      browserCompleted: true,
      verifiedPath: false,
      download: { guid: 'shot', state: 'completed', tabId: 7 },
      receipt: { hasReceipt: true, dialog: { message: 'go' } },
    });
    expect(result.structuredContent).toMatchObject({
      download: { guid: 'shot' },
      receipt: { hasReceipt: true },
    });
    await noLeaks();
  });

  it('returns a thrown trigger result unchanged', async () => {
    const original = {
      content: [
        { type: 'text', text: 'trigger failed' },
        { type: 'image', data: 'kept', mimeType: 'image/png' },
      ],
      isError: true,
    };
    vi.mocked(interactIndexTool.execute).mockImplementation(async () => {
      clickCount += 1;
      const error = new Error('boom');
      (error as any).result = original;
      (error as any).receipt = { hasReceipt: true };
      throw error;
    });
    const result = await handleDownloadTool.execute({
      tabId: 7,
      clickTargetIndex: 1,
      timeoutMs: 1000,
    });
    expect(result).toBe(original);
    expect(clickCount).toBe(1);
    await noLeaks();
  });

  it('spends the deadline during source preparation and does not trigger after abort', async () => {
    vi.mocked(downloadsWatchdog.withSourceTracking).mockImplementation(
      async (_tabId: number, run: () => Promise<unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return run();
      },
    );
    const timed = payloadOf(
      await handleDownloadTool.execute({ tabId: 7, clickTargetIndex: 1, timeoutMs: 50 }),
    );
    expect(clickCount).toBe(0);
    expect(timed).toMatchObject({ status: 'failed', dispatched: false, retry: false });
    expect(timed.outcome).toBeUndefined();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(downloadsWatchdog.withSourceTracking).mockImplementation(
      async (_tabId: number, run: () => Promise<unknown>) => {
        await gate;
        return run();
      },
    );
    const ctrl = new AbortController();
    const pending = handleDownloadTool.execute(
      { tabId: 7, clickTargetIndex: 1, timeoutMs: 1000 },
      { signal: ctrl.signal },
    );
    await vi.waitFor(() => expect(downloadsWatchdog.withSourceTracking).toHaveBeenCalled());
    ctrl.abort();
    release();
    const aborted = payloadOf(await pending);
    expect(clickCount).toBe(0);
    expect(aborted).toMatchObject({ status: 'cancelled', dispatched: false, retry: false });
    expect(aborted.outcome).toBeUndefined();
    await noLeaks();
  });

  it('legacy abort clears only this waiter and does not cancel the browser download', async () => {
    const early = new AbortController();
    early.abort();
    await expect(
      waitForDownload({ filenameContains: 'a.pdf', timeoutMs: 1000, signal: early.signal }),
    ).rejects.toThrow(/aborted/);
    expect((globalThis as any).chrome.downloads.onCreated.addListener).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.downloads.cancel).not.toHaveBeenCalled();

    const during = new AbortController();
    const pending = handleDownloadTool.execute(
      { filenameContains: 'missing-file', timeoutMs: 5000 },
      { signal: during.signal },
    );
    await vi.waitFor(() =>
      expect((globalThis as any).chrome.downloads.onCreated.addListener).toHaveBeenCalled(),
    );
    during.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toMatch(/aborted/);
    expect((globalThis as any).chrome.downloads.onCreated.removeListener).toHaveBeenCalled();
    expect((globalThis as any).chrome.downloads.onChanged.removeListener).toHaveBeenCalled();
    expect((globalThis as any).chrome.downloads.cancel).not.toHaveBeenCalled();
  });

  it('returns at the prepare deadline before a hung source owner finishes', async () => {
    vi.useFakeTimers();
    try {
      let owners = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(downloadsWatchdog.withSourceTracking).mockImplementation(
        async (_tabId: number, run: () => Promise<unknown>) => {
          owners += 1;
          try {
            await gate;
            return await run();
          } finally {
            owners -= 1;
          }
        },
      );
      const pending = handleDownloadTool.execute({ tabId: 7, clickTargetIndex: 1, timeoutMs: 50 });
      const settled = vi.fn();
      void pending.then(settled, settled);
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toHaveBeenCalled();
      const timed = payloadOf(await pending);
      expect(timed).toMatchObject({ status: 'failed', dispatched: false, retry: false });
      expect(timed.outcome).toBeUndefined();
      expect(clickCount).toBe(0);
      release();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(clickCount).toBe(0);
      expect(owners).toBe(0);

      owners = 0;
      let releaseAbort: () => void = () => {};
      const abortGate = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      vi.mocked(downloadsWatchdog.withSourceTracking).mockImplementation(
        async (_tabId: number, run: () => Promise<unknown>) => {
          owners += 1;
          try {
            await abortGate;
            return await run();
          } finally {
            owners -= 1;
          }
        },
      );
      const ctrl = new AbortController();
      const aborting = handleDownloadTool.execute(
        { tabId: 7, clickTargetIndex: 1, timeoutMs: 1000 },
        { signal: ctrl.signal },
      );
      const abortSettled = vi.fn();
      void aborting.then(abortSettled, abortSettled);
      await Promise.resolve();
      ctrl.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(abortSettled).toHaveBeenCalled();
      const aborted = payloadOf(await aborting);
      expect(aborted).toMatchObject({ status: 'cancelled', dispatched: false, retry: false });
      expect(aborted.outcome).toBeUndefined();
      expect(clickCount).toBe(0);
      releaseAbort();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(clickCount).toBe(0);
      expect(owners).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the timeout error when readiness resolves exactly at the deadline before the timer runs', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(downloadsWatchdog.withSourceTracking).mockImplementation(async (_tab, run) => {
        await gate;
        return run();
      });
      const pending = handleDownloadTool.execute({ tabId: 7, clickTargetIndex: 1, timeoutMs: 50 });
      vi.setSystemTime(Date.now() + 50);
      release();
      const response = payloadOf(await pending);
      expect(response).toMatchObject({
        success: false,
        status: 'failed',
        dispatched: false,
        retry: false,
      });
      expect(response.error).toContain('timed out');
      expect(clickCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat an in-flight trigger as a physical click when the deadline wins', async () => {
    vi.useFakeTimers();
    try {
      let finishTrigger: (result: unknown) => void = () => {};
      const original = {
        content: [
          { type: 'image', data: 'late-image', mimeType: 'image/png' },
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              receipt: { hasReceipt: true, dialog: { type: 'alert', message: 'late' } },
            }),
          },
        ],
        isError: false,
      };
      vi.mocked(interactIndexTool.execute).mockImplementation(() => {
        clickCount += 1;
        return new Promise((resolve) => {
          finishTrigger = resolve;
        }) as Promise<any>;
      });
      const pending = handleDownloadTool.execute({ tabId: 7, clickTargetIndex: 1, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      const timed = await pending;
      const body = payloadOf(timed);
      expect(body).toMatchObject({
        success: false,
        status: 'unknown',
        outcome: 'unknown',
        retry: false,
        requestDispatched: true,
      });
      expect(body.dispatched).not.toBe(true);
      expect(clickCount).toBe(1);
      finishTrigger(original);
      downloadsWatchdog.emit(
        'source-download-updated',
        obs({ guid: 'late', tabId: 7, state: 'completed', sequence: 3 }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(clickCount).toBe(1);
      expect(timed).toMatchObject({ isError: true });
      expect(payloadOf(timed)).toEqual(body);
      expect(JSON.stringify(payloadOf(timed))).not.toContain('late-image');
      expect(body.receipt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a source prepare failure as blocked before any click', async () => {
    vi.mocked(downloadsWatchdog.withSourceTracking).mockRejectedValue(
      new Error('cdp attach failed'),
    );
    const failed = payloadOf(
      await handleDownloadTool.execute({ tabId: 7, clickTargetIndex: 1, timeoutMs: 1000 }),
    );
    expect(failed).toMatchObject({
      success: false,
      status: 'blocked',
      dispatched: false,
      retry: false,
    });
    expect(failed.error).toMatch(/cdp attach failed/);
    expect(String(failed.error)).not.toMatch(/^Handle download failed/);
    expect(clickCount).toBe(0);
  });
});

describe('real tracker and waiter owner', () => {
  function payloadOf(result: { content?: Array<{ type?: string; text?: string }> }) {
    const text = result.content?.find((block) => block.type === 'text')?.text || '';
    return JSON.parse(text);
  }

  beforeEach(() => {
    downloadsWatchdog.stop();
    (globalThis as any).chrome = {
      runtime: { id: 'test-ext-id' },
      storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      downloads: {
        search: vi.fn(async () => []),
        cancel: vi.fn(async () => undefined),
        onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand: vi.fn(async () => ({})),
        getTargets: vi.fn(async () => []),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      tabs: {
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
  });

  afterEach(async () => {
    downloadsWatchdog.stop();
    vi.restoreAllMocks();
    await cdpSessionManager.detachDebugger(7).catch(() => undefined);
  });

  function begin(guid: string, filename = 'a.pdf') {
    cdpSessionManager.handleCdpEvent({ tabId: 7 }, 'Page.downloadWillBegin', {
      guid,
      frameId: '1.2',
      url: `https://example.com/${filename}`,
      suggestedFilename: filename,
    });
  }

  function finish(guid: string) {
    cdpSessionManager.handleCdpEvent({ tabId: 7 }, 'Page.downloadProgress', {
      guid,
      state: 'completed',
      receivedBytes: 10,
      totalBytes: 10,
    });
  }

  it.each(['guid', 'trigger'] as const)(
    'waits for worker restoration before %s lookup',
    async (mode) => {
      let restore!: (value: unknown) => void;
      vi.mocked(chrome.storage.session.get).mockImplementation(
        () =>
          new Promise((resolve) => {
            restore = resolve;
          }) as any,
      );
      const owner = vi.spyOn(downloadsWatchdog, 'withSourceTracking');
      vi.spyOn(interactIndexTool, 'execute').mockImplementation(async () => {
        begin('fresh');
        finish('fresh');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      });
      downloadsWatchdog.start();
      const settled = vi.fn();
      const pending = handleDownloadTool.execute({
        tabId: 7,
        timeoutMs: 1000,
        ...(mode === 'guid' ? { guid: 'restored' } : { clickTargetIndex: 1 }),
      });
      void pending.then(settled);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(interactIndexTool.execute).not.toHaveBeenCalled();
      restore({
        'browserpaw.sourceDownloads': {
          items: [
            obs({
              guid: 'restored',
              tabId: 7,
              state: 'completed',
            }),
          ],
        },
      });
      const response = await pending;
      expect(response.isError).toBe(false);
      expect(payloadOf(response).download.guid).toBe(mode === 'guid' ? 'restored' : 'fresh');
      expect(owner).toHaveBeenCalledTimes(mode === 'guid' ? 0 : 1);
    },
  );

  it.each(['timeout', 'abort'] as const)(
    'bounds restoration by %s without a late click',
    async (mode) => {
      let restore!: (value: unknown) => void;
      vi.mocked(chrome.storage.session.get).mockImplementation(
        () =>
          new Promise((resolve) => {
            restore = resolve;
          }) as any,
      );
      const click = vi.spyOn(interactIndexTool, 'execute');
      const controller = new AbortController();
      downloadsWatchdog.start();
      const pending = handleDownloadTool.execute(
        { tabId: 7, clickTargetIndex: 1, timeoutMs: 50 },
        { signal: controller.signal },
      );
      if (mode === 'abort') controller.abort();
      expect(payloadOf(await pending)).toMatchObject({
        status: mode === 'abort' ? 'cancelled' : 'failed',
        dispatched: false,
        retry: false,
      });
      restore({});
      await downloadsWatchdog.ensureReady();
      expect(click).not.toHaveBeenCalled();
    },
  );

  it('keeps a started download observable for a later guid query', async () => {
    await downloadsWatchdog.ensureReady();
    vi.spyOn(interactIndexTool, 'execute').mockImplementation(async () => {
      begin('live-guid');
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    });
    const started = payloadOf(
      await handleDownloadTool.execute({
        tabId: 7,
        clickTargetIndex: 1,
        waitForComplete: false,
        timeoutMs: 1000,
      }),
    );
    expect(started).toMatchObject({
      success: true,
      browserCompleted: false,
      download: { guid: 'live-guid', state: 'inProgress', tabId: 7 },
    });
    finish('live-guid');
    const later = payloadOf(
      await handleDownloadTool.execute({ tabId: 7, guid: 'live-guid', timeoutMs: 1000 }),
    );
    expect(later).toMatchObject({
      success: true,
      browserCompleted: true,
      verifiedPath: false,
      download: { guid: 'live-guid', state: 'completed', tabId: 7 },
    });
    expect((globalThis as any).chrome.downloads.cancel).not.toHaveBeenCalled();
  });

  it('does not end another wait when one wait is cancelled', async () => {
    await downloadsWatchdog.ensureReady();
    begin('shared-guid');
    const ctrl = new AbortController();
    const first = handleDownloadTool.execute(
      { tabId: 7, guid: 'shared-guid', timeoutMs: 1000 },
      { signal: ctrl.signal },
    );
    const second = handleDownloadTool.execute({ tabId: 7, guid: 'shared-guid', timeoutMs: 1000 });
    await vi.waitFor(() =>
      expect(downloadsWatchdog.getPageDownload(7, 'shared-guid')?.state).toBe('inProgress'),
    );
    ctrl.abort();
    const cancelled = payloadOf(await first);
    expect(cancelled).toMatchObject({ status: 'cancelled', dispatched: false, retry: false });
    expect(cancelled.outcome).toBeUndefined();
    finish('shared-guid');
    const kept = payloadOf(await second);
    expect(kept).toMatchObject({
      success: true,
      download: { guid: 'shared-guid', state: 'completed', tabId: 7 },
    });
  });
});
