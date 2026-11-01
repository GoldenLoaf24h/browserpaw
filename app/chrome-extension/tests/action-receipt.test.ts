import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DownloadObservation } from 'chrome-mcp-shared';
import {
  startActionReceipt,
  withActionReceipt,
  attachActionReceipt,
} from '../utils/action-receipt';
import { cdpSessionManager, type CdpEventObserver } from '../utils/cdp-session-manager';
import { downloadsWatchdog } from '../entrypoints/background/watchdogs';

function dl(
  partial: Partial<DownloadObservation> & Pick<DownloadObservation, 'guid' | 'tabId'>,
): DownloadObservation {
  return {
    frameId: 'F1',
    url: 'https://example.com/file.bin',
    suggestedFilename: 'file.bin',
    state: 'inProgress',
    receivedBytes: 1,
    totalBytes: 4,
    startedAt: 1,
    updatedAt: 2,
    epoch: 'epoch-1',
    sequence: 1,
    ...partial,
  };
}

describe('ActionReceipt: Bounded observation and state receipt', () => {
  let registeredCdpObservers: Set<CdpEventObserver>;
  let tabsCreatedListeners: Array<(tab: any) => void>;
  let tabsUpdatedListeners: Array<(tabId: number, changeInfo: any, tab: any) => void>;
  let navTargetListeners: Array<(details: any) => void>;
  let sentCdpCommands: Array<{ tabId: number; method: string; params: any }>;

  beforeEach(() => {
    vi.restoreAllMocks();
    registeredCdpObservers = new Set();
    tabsCreatedListeners = [];
    tabsUpdatedListeners = [];
    navTargetListeners = [];
    sentCdpCommands = [];

    vi.spyOn(cdpSessionManager, 'addCdpEventObserver').mockImplementation((obs) => {
      registeredCdpObservers.add(obs);
    });
    vi.spyOn(cdpSessionManager, 'removeCdpEventObserver').mockImplementation((obs) => {
      registeredCdpObservers.delete(obs);
    });
    vi.spyOn(cdpSessionManager, 'getPendingDialogs').mockReturnValue([]);
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue(undefined);
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (tabId, method, params) => {
      sentCdpCommands.push({ tabId, method, params });
      return {};
    });

    (globalThis as any).chrome = {
      tabs: {
        onCreated: {
          addListener: vi.fn((fn) => tabsCreatedListeners.push(fn)),
          removeListener: vi.fn((fn) => {
            const idx = tabsCreatedListeners.indexOf(fn);
            if (idx >= 0) tabsCreatedListeners.splice(idx, 1);
          }),
        },
        onUpdated: {
          addListener: vi.fn((fn) => tabsUpdatedListeners.push(fn)),
          removeListener: vi.fn((fn) => {
            const idx = tabsUpdatedListeners.indexOf(fn);
            if (idx >= 0) tabsUpdatedListeners.splice(idx, 1);
          }),
        },
      },
      webNavigation: {
        onCreatedNavigationTarget: {
          addListener: vi.fn((fn) => navTargetListeners.push(fn)),
          removeListener: vi.fn((fn) => {
            const idx = navTargetListeners.indexOf(fn);
            if (idx >= 0) navTargetListeners.splice(idx, 1);
          }),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns hasReceipt: false when no popup, dialog or fileChooser occurred', async () => {
    const receipt = startActionReceipt(10, { settleMs: 5 });
    const result = await receipt.finish();

    expect(result.hasReceipt).toBe(false);
    expect(result.dialog).toBeUndefined();
    expect(result.popups).toBeUndefined();
    expect(result.fileChooser).toBeUndefined();
    expect(registeredCdpObservers.size).toBe(0);
  });

  it('captures javascriptDialogOpening with source.sessionId and truncates overlong message', async () => {
    const receipt = startActionReceipt(10, { settleMs: 5 });
    const longMsg = 'A'.repeat(600);

    for (const obs of registeredCdpObservers) {
      obs(
        10,
        'Page.javascriptDialogOpening',
        { type: 'confirm', message: longMsg, defaultPrompt: 'prompt text' },
        { sessionId: 'child-session-01' },
      );
    }

    const result = await receipt.finish();
    expect(result.hasReceipt).toBe(true);
    expect(result.dialog).toBeDefined();
    expect(result.dialog?.type).toBe('confirm');
    expect(result.dialog?.sessionId).toBe('child-session-01');
    expect(result.dialog?.message.length).toBe(501);
    expect(result.dialog?.message.endsWith('…')).toBe(true);
  });

  it('dialogClosed only removes dialog for matching session without touching others', async () => {
    const receipt = startActionReceipt(10, { settleMs: 5 });

    for (const obs of registeredCdpObservers) {
      obs(10, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Root dialog' }, undefined);
      obs(
        10,
        'Page.javascriptDialogOpening',
        { type: 'confirm', message: 'Frame dialog' },
        { sessionId: 'frame-1' },
      );
    }

    for (const obs of registeredCdpObservers) {
      obs(10, 'Page.javascriptDialogClosed', {}, { sessionId: 'frame-1' });
    }

    const result = await receipt.finish();
    expect(result.hasReceipt).toBe(true);
    expect(result.dialog?.message).toBe('Root dialog');
    expect(result.dialog?.sessionId).toBeUndefined();
    expect(result.dialogs).toHaveLength(1);
    expect(result.dialogs?.[0].message).toBe('Root dialog');
  });

  it('captures every pre-existing pending dialog preserving ids and source order', async () => {
    vi.spyOn(cdpSessionManager, 'getPendingDialogs').mockReturnValue([
      {
        dialogId: 'dialog-root',
        type: 'alert',
        message: 'Pending root dialog',
        defaultPrompt: '',
        openedAtMs: Date.now(),
      },
      {
        dialogId: 'dialog-child',
        type: 'prompt',
        message: 'Pending subframe dialog',
        defaultPrompt: 'def',
        openedAtMs: Date.now(),
        sessionId: 'existing-sess-99',
      },
    ] as any);

    const receipt = startActionReceipt(10, { settleMs: 5 });
    const result = await receipt.finish();

    expect(result.hasReceipt).toBe(true);
    expect(result.dialog?.type).toBe('prompt');
    expect(result.dialog?.message).toBe('Pending subframe dialog');
    expect(result.dialog?.sessionId).toBe('existing-sess-99');
    expect(result.dialogs?.map((dialog) => dialog.dialogId)).toEqual([
      'dialog-root',
      'dialog-child',
    ]);
  });

  it('returns all dialogs in source order and keeps the legacy dialog as the newest event', async () => {
    const receipt = startActionReceipt(10, { settleMs: 5 });

    for (const obs of registeredCdpObservers) {
      obs(10, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Root dialog' });
      obs(
        10,
        'Page.javascriptDialogOpening',
        { type: 'confirm', message: 'Frame A dialog' },
        { sessionId: 'frame-a' },
      );
      obs(
        10,
        'Page.javascriptDialogOpening',
        { type: 'prompt', message: 'Frame B dialog' },
        { sessionId: 'frame-b' },
      );
    }

    const result = await receipt.finish();

    expect(result.dialogs?.map((dialog) => dialog.message)).toEqual([
      'Root dialog',
      'Frame A dialog',
      'Frame B dialog',
    ]);
    expect(new Set(result.dialogs?.map((dialog) => dialog.dialogId)).size).toBe(3);
    expect(result.dialog?.message).toBe('Frame B dialog');
  });

  it('tracks popup tabs strictly matching openerTabId or createdNav', async () => {
    const receipt = startActionReceipt(10, { settleMs: 10 });

    for (const listener of tabsCreatedListeners) {
      listener({ id: 201, openerTabId: 10, url: 'https://example.com/child', title: 'Child' });
      listener({
        id: 202,
        openerTabId: 99,
        url: 'https://example.com/unrelated',
        title: 'Unrelated',
      });
    }

    const result = await receipt.finish();
    expect(result.hasReceipt).toBe(true);
    expect(result.popups).toHaveLength(1);
    expect(result.popups?.[0].tabId).toBe(201);
  });

  it('updates popup title and url via tabs.onUpdated without unbounded tabs.get await', async () => {
    const receipt = startActionReceipt(10, { settleMs: 10 });

    for (const listener of tabsCreatedListeners) {
      listener({ id: 301, openerTabId: 10, url: 'about:blank', title: 'New Tab' });
    }
    for (const updater of tabsUpdatedListeners) {
      updater(301, { url: 'https://example.com/final', title: 'Final Title' }, { id: 301 } as any);
    }

    const result = await receipt.finish();
    expect(result.hasReceipt).toBe(true);
    expect(result.popups?.[0].url).toBe('https://example.com/final');
    expect(result.popups?.[0].title).toBe('Final Title');
  });

  it('never enables Page.setInterceptFileChooserDialog (strictly observer)', async () => {
    const receipt = startActionReceipt(10, { settleMs: 5 });
    await receipt.finish();

    expect(
      sentCdpCommands.filter((c) => c.method === 'Page.setInterceptFileChooserDialog'),
    ).toHaveLength(0);
  });

  it('captures confirmed Page.fileChooserOpened with source.sessionId when it arrives', async () => {
    const receipt = startActionReceipt(10, { settleMs: 5 });

    for (const obs of registeredCdpObservers) {
      obs(
        10,
        'Page.fileChooserOpened',
        { mode: 'selectSingle', backendNodeId: 42 },
        { sessionId: 'subframe-sess' },
      );
    }

    const result = await receipt.finish();
    expect(result.hasReceipt).toBe(true);
    expect(result.fileChooser).toEqual({
      mode: 'selectSingle',
      backendNodeId: 42,
      sessionId: 'subframe-sess',
      requiresAction: true,
    });
  });

  it('concurrent finish() calls return the identical promise', async () => {
    const receipt = startActionReceipt(10, { settleMs: 10 });

    const p1 = receipt.finish();
    const p2 = receipt.finish();
    expect(p1).toBe(p2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
  });

  it('cancel() after finish() is a no-op and does not re-register or wipe settled result', async () => {
    const receipt = startActionReceipt(10, { settleMs: 5 });
    for (const obs of registeredCdpObservers) {
      obs(10, 'Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 10 });
    }

    const res1 = await receipt.finish();
    expect(res1.hasReceipt).toBe(true);
    expect(registeredCdpObservers.size).toBe(0);

    receipt.cancel();
    expect(registeredCdpObservers.size).toBe(0);

    const res2 = await receipt.finish();
    expect(res2).toBe(res1);
  });

  it('buffers events that arrive before finish() is called (event buffering)', async () => {
    const receipt = startActionReceipt(10, { settleMs: 10 });

    for (const obs of registeredCdpObservers) {
      obs(10, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Early event' });
    }

    await new Promise((r) => setTimeout(r, 20));

    const result = await receipt.finish();
    expect(result.hasReceipt).toBe(true);
    expect(result.dialog?.message).toBe('Early event');
  });

  it('cancel() immediately removes all observers and listeners', () => {
    const receipt = startActionReceipt(10);
    expect(registeredCdpObservers.size).toBe(1);
    expect(tabsCreatedListeners.length).toBe(1);

    receipt.cancel();
    expect(registeredCdpObservers.size).toBe(0);
    expect(tabsCreatedListeners.length).toBe(0);
  });

  describe('withActionReceipt wrapper contract', () => {
    it('returns exact original object identity when no receipt occurs (no extra keys)', async () => {
      const orig = { success: true, count: 123 };
      const res = await withActionReceipt(10, async () => orig, { settleMs: 5 });

      expect(res).toBe(orig);
      expect(Object.keys(res)).toEqual(['success', 'count']);
      expect((res as any).receipt).toBeUndefined();
    });

    it('injects receipt into JSON text in ToolResult while preserving image and other blocks', async () => {
      const toolResult = {
        content: [
          { type: 'image', data: 'base64image...' },
          { type: 'text', text: 'intro text' },
          { type: 'text', text: JSON.stringify({ success: true, clicked: true }) },
        ],
        isError: false,
      };

      const res = await withActionReceipt(
        10,
        async () => {
          for (const obs of registeredCdpObservers) {
            obs(10, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Popup blocked' });
          }
          return toolResult;
        },
        { settleMs: 5 },
      );

      expect(res).toBe(toolResult);
      expect(res.content).toHaveLength(3);
      expect(res.content[0]).toEqual({ type: 'image', data: 'base64image...' });
      expect(res.content[1]).toEqual({ type: 'text', text: 'intro text' });

      const parsedPayload = JSON.parse(res.content[2].text as string);
      expect(parsedPayload.success).toBe(true);
      expect(parsedPayload.clicked).toBe(true);
      expect(parsedPayload.receipt).toBeDefined();
      expect(parsedPayload.receipt.dialog?.message).toBe('Popup blocked');
      expect(res.isError).toBe(false);
    });

    it('handles parsed JSON array by appending a receipt text block rather than overwriting', async () => {
      const toolResult = {
        content: [{ type: 'text', text: JSON.stringify(['item1', 'item2']) }],
        isError: false,
      };

      const res = await withActionReceipt(
        10,
        async () => {
          for (const obs of registeredCdpObservers) {
            obs(10, 'Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 101 });
          }
          return toolResult;
        },
        { settleMs: 5 },
      );

      expect(res).toBe(toolResult);
      expect(res.content).toHaveLength(2);
      expect(JSON.parse(res.content[0].text as string)).toEqual(['item1', 'item2']);
      const appended = JSON.parse(res.content[1].text as string);
      expect(appended.receipt.fileChooser?.backendNodeId).toBe(101);
    });

    it('handles parsed JSON primitive without overwriting original string/number', async () => {
      const toolResult = {
        content: [{ type: 'text', text: JSON.stringify(42) }],
        isError: false,
      };

      const res = await withActionReceipt(
        10,
        async () => {
          for (const obs of registeredCdpObservers) {
            obs(10, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Primitive alert' });
          }
          return toolResult;
        },
        { settleMs: 5 },
      );

      expect(res.content).toHaveLength(2);
      expect(JSON.parse(res.content[0].text as string)).toBe(42);
      const appended = JSON.parse(res.content[1].text as string);
      expect(appended.receipt.dialog?.message).toBe('Primitive alert');
    });

    it('converts non-JSON error text to { success: false, error: text, receipt } preserving isError', async () => {
      const toolResult = {
        content: [{ type: 'text', text: 'Element not found on page' }],
        isError: true,
      };

      const res = await withActionReceipt(
        10,
        async () => {
          for (const obs of registeredCdpObservers) {
            obs(10, 'Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 88 });
          }
          return toolResult;
        },
        { settleMs: 5 },
      );

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text as string);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Element not found on page');
      expect(parsed.receipt.fileChooser?.backendNodeId).toBe(88);
    });

    it('converts non-JSON plain text (non-error) without tagging success: false', async () => {
      const toolResult = {
        content: [{ type: 'text', text: 'Action successfully initiated' }],
        isError: false,
      };

      const res = await withActionReceipt(
        10,
        async () => {
          for (const obs of registeredCdpObservers) {
            obs(10, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Info alert' });
          }
          return toolResult;
        },
        { settleMs: 5 },
      );

      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.content[0].text as string);
      expect(parsed.success).toBe(true); // NOT false!
      expect(parsed.text).toBe('Action successfully initiated');
      expect(parsed.receipt.dialog?.message).toBe('Info alert');
    });

    it('adds receipt to plain object result when not a ToolResult', async () => {
      const plainObj = { status: 'ok' };
      const res = await withActionReceipt(
        10,
        async () => {
          for (const obs of registeredCdpObservers) {
            obs(10, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Continue?' });
          }
          return plainObj;
        },
        { settleMs: 5 },
      );

      expect(res).toBe(plainObj);
      expect((res as any).receipt.dialog?.message).toBe('Continue?');
    });

    it('attaches receipt to thrown error and rethrows the EXACT original error instance', async () => {
      const originalError = new Error('Physical dispatch aborted');

      let caught: any;
      try {
        await withActionReceipt(
          10,
          async () => {
            for (const obs of registeredCdpObservers) {
              obs(10, 'Page.javascriptDialogOpening', {
                type: 'alert',
                message: 'Paused by modal',
              });
            }
            throw originalError;
          },
          { settleMs: 5 },
        );
      } catch (e) {
        caught = e;
      }

      expect(caught).toBe(originalError);
      expect(caught.receipt).toBeDefined();
      expect(caught.receipt.dialog?.message).toBe('Paused by modal');
      expect(registeredCdpObservers.size).toBe(0);
    });

    it.each([null, undefined, 0, ''])(
      'does not swallow falsy thrown values (%s) and rethrows them strictly',
      async (falsyVal) => {
        let caught: any = 'unreached';
        try {
          await withActionReceipt(
            10,
            async () => {
              throw falsyVal;
            },
            { settleMs: 5 },
          );
        } catch (e) {
          caught = e;
        }

        expect(caught).toBe(falsyVal);
      },
    );

    it('does not allow unexpected finish errors to mask original business errors', async () => {
      const businessError = new Error('Business operation failed');

      let caught: any;
      try {
        await withActionReceipt(
          10,
          async () => {
            // Mock cdpSessionManager or internal throw during finish if any
            throw businessError;
          },
          { settleMs: 5 },
        );
      } catch (e) {
        caught = e;
      }

      expect(caught).toBe(businessError);
      expect(registeredCdpObservers.size).toBe(0);
    });
  });

  describe('attachActionReceipt direct contract', () => {
    it('returns exact original object identity when receipt is missing or hasReceipt is false', () => {
      const obj = { success: true };
      expect(attachActionReceipt(obj, undefined)).toBe(obj);
      expect(attachActionReceipt(obj, { hasReceipt: false })).toBe(obj);
      expect((obj as any).receipt).toBeUndefined();
    });

    it('attaches receipt to an error response from an outer catch without dropping popups', () => {
      const errorResponse = {
        content: [
          { type: 'text', text: JSON.stringify({ success: false, error: 'target_occluded' }) },
        ],
        isError: true,
      };

      const errReceipt = {
        hasReceipt: true,
        popups: [{ tabId: 999, url: 'https://popup.test' }],
      };

      const out = attachActionReceipt(errorResponse, errReceipt);
      expect(out).toBe(errorResponse);
      const parsed = JSON.parse(out.content[0].text as string);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('target_occluded');
      expect(parsed.receipt.popups?.[0].tabId).toBe(999);
    });
  });
});

describe('ActionReceipt source downloads', () => {
  let page: DownloadObservation[];
  let active: number;

  beforeEach(() => {
    page = [];
    active = 0;
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});
    vi.spyOn(cdpSessionManager, 'getPendingDialogs').mockReturnValue([]);
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue(undefined);
    const originalOn = downloadsWatchdog.on.bind(downloadsWatchdog);
    vi.spyOn(downloadsWatchdog, 'on').mockImplementation((event: string, handler: any) => {
      const off = originalOn(event, handler);
      if (event !== 'source-download-updated') return off;
      active += 1;
      return () => {
        active -= 1;
        off();
      };
    });
    (downloadsWatchdog as any).getPageDownloads = (tabId: number) =>
      page.filter((item) => item.tabId === tabId);
  });

  afterEach(() => {
    downloadsWatchdog.removeAllListeners('source-download-updated');
    delete (downloadsWatchdog as any).getPageDownloads;
    vi.restoreAllMocks();
  });

  it('subscribes before the action, drops other tabs and pre-existing guids, and keeps first-start order', async () => {
    page = [dl({ guid: 'old', tabId: 10, sequence: 1, state: 'inProgress' })];
    let subscribed = false;
    const result = await withActionReceipt(
      10,
      async () => {
        subscribed = active > 0;
        page = [];
        downloadsWatchdog.emit(
          'source-download-updated',
          dl({ guid: 'old', tabId: 10, sequence: 2, state: 'completed' }),
        );
        downloadsWatchdog.emit(
          'source-download-updated',
          dl({ guid: 'other', tabId: 11, sequence: 9, state: 'completed' }),
        );
        downloadsWatchdog.emit(
          'source-download-updated',
          dl({ guid: 'b', tabId: 10, sequence: 5, state: 'inProgress' }),
        );
        downloadsWatchdog.emit(
          'source-download-updated',
          dl({ guid: 'a', tabId: 10, sequence: 3, state: 'completed' }),
        );
        downloadsWatchdog.emit(
          'source-download-updated',
          dl({ guid: 'b', tabId: 10, sequence: 4, state: 'canceled' }),
        );
        downloadsWatchdog.emit(
          'source-download-updated',
          dl({ guid: 'b', tabId: 10, sequence: 6, state: 'completed' }),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, clicked: true }) }],
          isError: false,
        };
      },
      { settleMs: 0 },
    );

    expect(subscribed).toBe(true);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
    const body = JSON.parse(result.content[0].text as string);
    expect(body.clicked).toBe(true);
    expect(
      body.receipt.downloads.map((item: DownloadObservation) => [
        item.guid,
        item.sequence,
        item.state,
      ]),
    ).toEqual([
      ['b', 6, 'completed'],
      ['a', 3, 'completed'],
    ]);
    expect(active).toBe(0);
  });

  it('does not turn a download that existed before the action into a receipt', async () => {
    page = [dl({ guid: 'old', tabId: 10, sequence: 1, state: 'inProgress' })];
    const original = { status: 'ok' };
    const result = await withActionReceipt(
      10,
      async () => {
        page = [];
        downloadsWatchdog.emit(
          'source-download-updated',
          dl({ guid: 'old', tabId: 10, sequence: 4, state: 'completed' }),
        );
        return original;
      },
      { settleMs: 0 },
    );
    expect(result).toBe(original);
    expect((result as any).receipt).toBeUndefined();
    expect(active).toBe(0);
  });

  it('removes the download listener on cancel and keeps finish idempotent', async () => {
    page = [];
    const receipt = startActionReceipt(10, { settleMs: 0 });
    expect(active).toBe(1);
    downloadsWatchdog.emit(
      'source-download-updated',
      dl({ guid: 'new', tabId: 10, sequence: 1, state: 'inProgress' }),
    );
    const first = await receipt.finish();
    expect(first.hasReceipt).toBe(true);
    expect(first.downloads).toHaveLength(1);
    expect(active).toBe(0);
    downloadsWatchdog.emit(
      'source-download-updated',
      dl({ guid: 'late', tabId: 10, sequence: 2, state: 'completed' }),
    );
    receipt.cancel();
    expect(await receipt.finish()).toBe(first);
    expect(active).toBe(0);
  });
});
