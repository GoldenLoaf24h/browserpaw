import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleTaskPageControl,
  resetTaskPageControlForTest,
  type TaskPageControlPayload,
} from '../utils/task-page-control';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { tabGroupManager } from '../entrypoints/background/tools/browser/tab-group-manager';
import { tabFaviconManager } from '../entrypoints/background/tools/browser/tab-favicon';
import * as browserIdentity from '../utils/browser-identity';
import { downloadsWatchdog } from '../entrypoints/background/watchdogs/downloads-watchdog';

const STORAGE_KEY = 'task_page_control_holders';
const RELEASED_STORAGE_KEY = 'task_page_control_released';

function payload(overrides: Partial<TaskPageControlPayload> = {}): TaskPageControlPayload {
  return {
    action: 'viewport',
    taskId: 'task-1',
    tabId: 42,
    documentId: 'document-42',
    browserInstanceId: 'browser-1',
    ownership: 'owned',
    ...overrides,
  };
}

describe('task page control', () => {
  let stored: Record<string, unknown>;
  let attach: ReturnType<typeof vi.spyOn>;
  let detach: ReturnType<typeof vi.spyOn>;
  let sendCommand: ReturnType<typeof vi.spyOn>;
  let tabRemovedListener: ((tabId: number) => void) | undefined;
  let documents: Map<number, string>;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetTaskPageControlForTest();
    stored = {};
    tabRemovedListener = undefined;
    documents = new Map([[42, 'document-42']]);
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(async (keys: string | string[]) => {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.map((key) => [key, stored[key]]));
          }),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(stored, value);
          }),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: `https://owned.example/${tabId}`,
          favIconUrl: `https://owned.example/${tabId}/favicon.ico`,
        })),
        remove: vi.fn(),
        update: vi.fn(),
        onRemoved: {
          addListener: vi.fn((listener) => {
            tabRemovedListener = listener;
          }),
        },
      },
      webNavigation: {
        getFrame: vi.fn(async ({ tabId }: { tabId: number }) => ({
          documentId: documents.get(tabId),
        })),
      },
      scripting: { executeScript: vi.fn(async () => [{ result: true }]) },
      runtime: { id: 'test-ext-id' },
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        getTargets: vi.fn(async () => []),
        sendCommand: vi.fn(async () => ({})),
      },
    });

    vi.spyOn(browserIdentity, 'getBrowserInstanceId').mockResolvedValue('browser-1');
    vi.spyOn(tabGroupManager, 'ensureStorageLoaded').mockResolvedValue(undefined);
    vi.spyOn(tabGroupManager, 'isAgentTab').mockReturnValue(true);
    vi.spyOn(tabGroupManager, 'releaseAgentTab').mockResolvedValue(undefined);
    vi.spyOn(tabFaviconManager, 'restoreFavicon').mockResolvedValue(true);

    const attachedTabs = new Set<number>();
    attach = vi.spyOn(cdpSessionManager, 'attach').mockImplementation(async (tabId: number) => {
      attachedTabs.add(tabId);
    });
    detach = vi.spyOn(cdpSessionManager, 'detach').mockImplementation(async (tabId: number) => {
      attachedTabs.delete(tabId);
    });
    vi.spyOn(cdpSessionManager, 'isAttached').mockImplementation((tabId: number) =>
      attachedTabs.has(tabId),
    );
    sendCommand = vi
      .spyOn(cdpSessionManager, 'sendCommand')
      .mockImplementation(async (_tabId: number, method: string) => {
        if (method === 'Runtime.evaluate') {
          return {
            result: { value: { width: 1280, height: 720, dpr: 1.5 } },
          };
        }
        return {};
      });
  });

  it.each([
    ['borrowed', 'borrowed'],
    ['user', 'user'],
  ] as const)('rejects %s pages without touching CDP', async (_label, ownership) => {
    const result = await handleTaskPageControl(payload({ ownership }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('only self-created pages');
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['agent registration', () => vi.spyOn(tabGroupManager, 'isAgentTab').mockReturnValue(false)],
    [
      'document identity',
      () =>
        vi
          .spyOn(chrome.webNavigation, 'getFrame')
          .mockResolvedValue({ documentId: 'different-document' } as any),
    ],
    [
      'browser identity',
      () => vi.spyOn(browserIdentity, 'getBrowserInstanceId').mockResolvedValue('browser-2'),
    ],
  ])('rejects a %s mismatch before mutation', async (_label, arrange) => {
    arrange();

    const result = await handleTaskPageControl(payload());

    expect(result.success).toBe(false);
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('holds one CDP reference and follows the native viewport', async () => {
    const first = await handleTaskPageControl(payload());
    const second = await handleTaskPageControl(payload());

    expect(first).toMatchObject({
      success: true,
      viewport: { status: 'native', width: 1280, height: 720, dpr: 1.5 },
    });
    expect(second).toMatchObject({ success: true, viewport: { status: 'native' } });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(42, 'task-viewport:task-1');
    expect(sendCommand).not.toHaveBeenCalledWith(
      42,
      'Emulation.setDeviceMetricsOverride',
      expect.anything(),
    );
    expect(sendCommand).toHaveBeenCalledWith(42, 'Emulation.clearDeviceMetricsOverride', {});
    expect(sendCommand).toHaveBeenCalledWith(
      42,
      'Runtime.evaluate',
      expect.objectContaining({ returnByValue: true }),
    );
  });

  it('serializes concurrent viewport calls without duplicating the task reference', async () => {
    const results = await Promise.all([
      handleTaskPageControl(payload()),
      handleTaskPageControl(payload()),
    ]);

    expect(results.every((result) => result.viewport?.status === 'native')).toBe(true);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('keeps arbitrary portrait dimensions and DPR unchanged', async () => {
    sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 900, height: 1600, dpr: 2 } } };
      }
      return {};
    });

    const result = await handleTaskPageControl(payload());

    expect(result.viewport).toMatchObject({
      status: 'native',
      width: 900,
      height: 1600,
      dpr: 2,
    });
  });

  it('applies and releases two pages owned by the same task independently', async () => {
    documents.set(43, 'document-43');
    const first = payload();
    const second = payload({ tabId: 43, documentId: 'document-43' });

    const applied = await Promise.all([
      handleTaskPageControl(first),
      handleTaskPageControl(second),
    ]);

    expect(applied.every((result) => result.viewport?.status === 'native')).toBe(true);
    expect(attach).toHaveBeenCalledWith(42, 'task-viewport:task-1');
    expect(attach).toHaveBeenCalledWith(43, 'task-viewport:task-1');
    expect((stored[STORAGE_KEY] as any[]).map((entry) => entry.tabId).sort()).toEqual([42, 43]);

    const released = await handleTaskPageControl(payload({ action: 'release' }));

    expect(released).toMatchObject({ success: true, released: true });
    expect(detach).toHaveBeenCalledWith(42, 'task-viewport:task-1');
    expect((stored[STORAGE_KEY] as any[]).map((entry) => entry.tabId)).toEqual([43]);
    expect((stored[RELEASED_STORAGE_KEY] as any[]).map((entry) => entry.tabId)).toEqual([42]);

    const releasedSecond = await handleTaskPageControl(
      payload({ action: 'release', tabId: 43, documentId: 'document-43' }),
    );

    expect(releasedSecond).toMatchObject({ success: true, released: true });
    expect(detach).toHaveBeenCalledWith(43, 'task-viewport:task-1');
    expect(stored[STORAGE_KEY]).toEqual([]);
    expect((stored[RELEASED_STORAGE_KEY] as any[]).map((entry) => entry.tabId).sort()).toEqual([
      42, 43,
    ]);
  });

  it('uses real CDP owner refs for two task pages and decrements only the released tab', async () => {
    documents.set(91, 'document-91');
    documents.set(92, 'document-92');
    vi.mocked(cdpSessionManager.attach).mockRestore();
    vi.mocked(cdpSessionManager.detach).mockRestore();
    vi.mocked(cdpSessionManager.isAttached).mockRestore();

    try {
      const pageA = payload({ tabId: 91, documentId: 'document-91' });
      const pageB = payload({ tabId: 92, documentId: 'document-92' });
      await handleTaskPageControl(pageA);
      await handleTaskPageControl(pageB);
      await handleTaskPageControl(pageA);

      const getState = (tabId: number) => (cdpSessionManager as any).getState(tabId);
      expect(getState(91)).toMatchObject({ refCount: 1, attachedByUs: true });
      expect(getState(91).owners.get('task-viewport:task-1')).toBe(1);
      expect(getState(92)).toMatchObject({ refCount: 1, attachedByUs: true });
      expect(getState(92).owners.get('task-viewport:task-1')).toBe(1);

      await handleTaskPageControl(
        payload({ action: 'release', tabId: 91, documentId: 'document-91' }),
      );

      expect(getState(91)).toMatchObject({ refCount: 0 });
      expect(getState(91).owners.size).toBe(0);
      expect(getState(92)).toMatchObject({ refCount: 1 });
      expect(getState(92).owners.get('task-viewport:task-1')).toBe(1);
    } finally {
      await cdpSessionManager.detachDebugger(91).catch(() => {});
      await cdpSessionManager.detachDebugger(92).catch(() => {});
    }
  });

  it('adopts a verified current document after task-owned navigation', async () => {
    await handleTaskPageControl(payload());
    documents.set(42, 'document-42-next');

    const result = await handleTaskPageControl(payload({ documentId: 'document-42-next' }));

    expect(result.viewport?.status).toBe('native');
    expect(attach).toHaveBeenCalledTimes(1);
    expect(stored[STORAGE_KEY]).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        tabId: 42,
        documentId: 'document-42-next',
      }),
    ]);
  });

  it('restores a persisted worker holder and reattaches only once', async () => {
    stored[STORAGE_KEY] = [
      {
        taskId: 'task-1',
        tabId: 42,
        documentId: 'document-42',
        browserInstanceId: 'browser-1',
        owner: 'task-viewport:task-1',
      },
    ];

    const result = await handleTaskPageControl(payload());

    expect(result.success).toBe(true);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(42, 'task-viewport:task-1');
  });

  it('replaces an orphaned owner after worker state loss without stacking references', async () => {
    vi.spyOn(cdpSessionManager, 'isAttached').mockReturnValue(true);

    const result = await handleTaskPageControl(payload());

    expect(result.viewport?.status).toBe('native');
    expect(detach).toHaveBeenCalledWith(42, 'task-viewport:task-1');
    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0]);
  });

  it('returns limited when Chrome cannot provide a positive native viewport', async () => {
    sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 0, height: 800, dpr: 2 } } };
      }
      return {};
    });

    const result = await handleTaskPageControl(payload());

    expect(result.success).toBe(true);
    expect(result.viewport).toMatchObject({ status: 'limited', width: 0, height: 0 });
    expect(result.viewport?.reason).toContain('Native viewport measurement failed');
    expect(sendCommand).toHaveBeenCalledWith(42, 'Emulation.clearDeviceMetricsOverride', {});
    expect(detach).toHaveBeenCalledWith(42, 'task-viewport:task-1');
    expect((stored[STORAGE_KEY] as unknown[]) || []).toHaveLength(0);
  });

  it('does not report native when the document changes after measurement', async () => {
    let documentReads = 0;
    (chrome.webNavigation.getFrame as any).mockImplementation(async () => ({
      documentId: documentReads++ < 3 ? 'document-42' : 'document-after-navigation',
    }));

    const result = await handleTaskPageControl(payload());

    expect(result.success).toBe(true);
    expect(result.viewport?.status).toBe('limited');
    expect(result.viewport?.reason).toContain('document identity');
    expect(sendCommand).toHaveBeenCalledWith(42, 'Emulation.clearDeviceMetricsOverride', {});
    expect(detach).toHaveBeenCalledWith(42, 'task-viewport:task-1');
  });

  it('releases override before detach and removes agent/favicon state without closing or focusing', async () => {
    const releaseDownloads = vi.spyOn(downloadsWatchdog, 'endSourceTracking');
    await handleTaskPageControl(payload());
    const clearOrder = sendCommand.mock.calls.length;

    const result = await handleTaskPageControl(payload({ action: 'release' }));

    expect(result).toEqual({
      success: true,
      action: 'release',
      released: true,
      viewportRestored: true,
      warnings: undefined,
    });
    expect(sendCommand.mock.invocationCallOrder[clearOrder]).toBeLessThan(
      detach.mock.invocationCallOrder[0],
    );
    expect(sendCommand).toHaveBeenNthCalledWith(
      clearOrder + 1,
      42,
      'Emulation.clearDeviceMetricsOverride',
      {},
    );
    expect(detach).toHaveBeenCalledWith(42, 'task-viewport:task-1');
    expect(tabGroupManager.releaseAgentTab).toHaveBeenCalledWith(42);
    expect(releaseDownloads).toHaveBeenCalledWith(42, 'task-page-released');
    expect(tabFaviconManager.restoreFavicon).toHaveBeenCalledWith(42);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('returns release success with a warning when favicon restoration fails', async () => {
    await handleTaskPageControl(payload());
    vi.spyOn(tabFaviconManager, 'restoreFavicon').mockResolvedValue(false);

    const result = await handleTaskPageControl(payload({ action: 'release' }));

    expect(result).toMatchObject({
      success: true,
      released: true,
      viewportRestored: true,
    });
    expect(result.warnings).toContain('Original favicon was not restored');
    expect((stored[RELEASED_STORAGE_KEY] as any[]).length).toBe(1);
  });

  it('warns and does not claim viewport restoration when clearing override fails', async () => {
    await handleTaskPageControl(payload());
    sendCommand.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Emulation.clearDeviceMetricsOverride') {
        throw new Error('clear rejected');
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { width: 1280, height: 720, dpr: 1.5 } } };
      }
      return {};
    });

    const result = await handleTaskPageControl(payload({ action: 'release' }));

    expect(result).toMatchObject({
      success: true,
      released: true,
      viewportRestored: false,
    });
    expect(result.warnings?.join(' ')).toContain('clear rejected');
  });

  it('returns an idempotent release receipt without another mutation', async () => {
    await handleTaskPageControl(payload());
    const first = await handleTaskPageControl(payload({ action: 'release' }));
    const clearCalls = sendCommand.mock.calls.filter(
      ([, method]) => method === 'Emulation.clearDeviceMetricsOverride',
    ).length;
    const detachCalls = detach.mock.calls.length;

    const second = await handleTaskPageControl(payload({ action: 'release' }));

    expect(first.released).toBe(true);
    expect(second).toMatchObject({
      success: true,
      released: true,
      idempotent: true,
    });
    expect(
      sendCommand.mock.calls.filter(
        ([, method]) => method === 'Emulation.clearDeviceMetricsOverride',
      ),
    ).toHaveLength(clearCalls);
    expect(detach).toHaveBeenCalledTimes(detachCalls);
  });

  it('keeps core release success when the idempotency receipt cannot persist', async () => {
    await handleTaskPageControl(payload());
    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(
      new Error('session storage unavailable'),
    );

    const result = await handleTaskPageControl(payload({ action: 'release' }));

    expect(result).toMatchObject({
      success: true,
      released: true,
      viewportRestored: true,
    });
    expect(result.warnings?.join(' ')).toContain('could not be persisted');
  });

  it('does not claim release when agent ownership persistence fails', async () => {
    await handleTaskPageControl(payload());
    vi.spyOn(tabGroupManager, 'releaseAgentTab').mockRejectedValueOnce(
      new Error('storage write failed'),
    );

    const result = await handleTaskPageControl(payload({ action: 'release' }));

    expect(result.success).toBe(false);
    expect(result.released).toBeUndefined();
    expect(result.error).toContain('storage write failed');
    expect(tabFaviconManager.restoreFavicon).not.toHaveBeenCalled();
  });

  it('clears persisted holders when the tracked tab closes', async () => {
    await handleTaskPageControl(payload());
    expect(tabRemovedListener).toBeTypeOf('function');

    tabRemovedListener!(42);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((stored[STORAGE_KEY] as unknown[]) || []).toHaveLength(0);
  });
});
