import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { cdpSessionManager } from '../utils/cdp-session-manager';

describe('CDP Adoption & Non-Invasive Probe Authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-adoption-extension-id',
      },
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 201 }),
      },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockImplementation(async (_target: any, method: string) => {
          if (method === 'Page.getLayoutMetrics') {
            return { layoutViewport: { pageX: 0, pageY: 0 } };
          }
          return {};
        }),
        getTargets: vi.fn().mockResolvedValue([]),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Case 1: recovers own-session when extensionId is undefined in getTargets', async () => {
    const tabId = 201;
    // Chrome TargetInfo for standard web page has extensionId: undefined
    (chrome.debugger.getTargets as any).mockResolvedValue([
      { tabId, attached: true, extensionId: undefined, type: 'page' },
    ]);

    // Should probe with Page.getLayoutMetrics, succeed, and adopt the session
    await expect(cdpSessionManager.attach(tabId, 'owner-recovery')).resolves.toBeUndefined();

    expect(cdpSessionManager.isAttached(tabId)).toBe(true);
    // Verified that it didn't freshly re-attach or detach
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    // Verified probe was called
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId },
      'Page.getLayoutMetrics',
      {},
    );
  });

  it('Case 2: rejects other client (e.g. DevTools) without calling detach/attach', async () => {
    const tabId = 202;
    (chrome.debugger.getTargets as any).mockResolvedValue([
      { tabId, attached: true, extensionId: undefined, type: 'page' },
    ]);

    // Probe fails because another client (DevTools) owns the session
    (chrome.debugger.sendCommand as any).mockImplementation(
      async (_target: any, method: string) => {
        if (method === 'Page.getLayoutMetrics') {
          throw new Error('Debugger is not attached to the target with id: 202');
        }
        return {};
      },
    );

    await expect(cdpSessionManager.attach(tabId, 'owner-conflict')).rejects.toThrow(
      /Debugger is already attached to tab 202 by another client/,
    );

    // CRITICAL: Must not preempt or disrupt other client's session
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
    expect(cdpSessionManager.isAttached(tabId)).toBe(false);
  });

  it('Case 3: untrusted extensionId cannot bypass probe verification', async () => {
    const tabId = 203;
    // Even if extensionId matches chrome.runtime.id, if probe fails, it must reject
    (chrome.debugger.getTargets as any).mockResolvedValue([
      { tabId, attached: true, extensionId: chrome.runtime.id, type: 'page' },
    ]);

    // Probe fails (session is stale or dead)
    (chrome.debugger.sendCommand as any).mockImplementation(
      async (_target: any, method: string) => {
        if (method === 'Page.getLayoutMetrics') {
          throw new Error('Target closed');
        }
        return {};
      },
    );

    await expect(cdpSessionManager.attach(tabId, 'owner-untrusted')).rejects.toThrow(
      /Debugger is already attached to tab 203 by another client/,
    );

    expect(cdpSessionManager.isAttached(tabId)).toBe(false);
  });

  it('Case 4: probe timeout is bounded and does not hang indefinitely', async () => {
    const tabId = 204;
    (chrome.debugger.getTargets as any).mockResolvedValue([
      { tabId, attached: true, extensionId: undefined, type: 'page' },
    ]);

    // Probe hangs indefinitely
    (chrome.debugger.sendCommand as any).mockImplementation(() => new Promise(() => {}));

    // Should timeout and reject within bounded time
    const start = performance.now();
    await expect(cdpSessionManager.attach(tabId, 'owner-hang')).rejects.toThrow(
      /CDP_SEND_TIMEOUT: Page\.getLayoutMetrics no ack within 1000ms/,
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(3000);
    expect(cdpSessionManager.isAttached(tabId)).toBe(false);
  });

  it('Case 5: reconnect replays read methods only and refuses mutation replay', async () => {
    const tabId = 205;
    (chrome.debugger.getTargets as any).mockResolvedValue([
      { tabId, attached: true, extensionId: undefined, type: 'page' },
    ]);

    // First attach normally via adoption
    await cdpSessionManager.attach(tabId, 'owner-replay');

    // Simulate transient detachment on first call
    let callCount = 0;
    (chrome.debugger.sendCommand as any).mockImplementation(
      async (_target: any, method: string) => {
        if (method === 'Page.getNavigationHistory') {
          callCount++;
          if (callCount === 1) {
            throw new Error('Debugger detached while handling command');
          }
          return { currentIndex: 0, entries: [] };
        }
        if (method === 'Input.dispatchMouseEvent') {
          throw new Error('Debugger detached while handling command');
        }
        return {};
      },
    );

    // 1. Read command should auto-reconnect and retry successfully
    const readResult = await cdpSessionManager.sendCommand(tabId, 'Page.getNavigationHistory');
    expect(readResult).toEqual({ currentIndex: 0, entries: [] });
    expect(callCount).toBe(2);

    // 2. Mutation command should NOT be replayed, should throw uncertainError
    await expect(
      cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed' }),
    ).rejects.toThrow(/CDP Input\.dispatchMouseEvent outcome unknown/);
  });
  it('Case 6: cleans up adopted manager state on restore failure without detaching physical session', async () => {
    const tabId = 206;
    (chrome.debugger.getTargets as any).mockResolvedValue([
      { tabId, attached: true, extensionId: undefined, type: 'page' },
    ]);

    // Probe succeeds, but restoreActiveDomains fails (e.g. Page.enable rejects)
    (chrome.debugger.sendCommand as any).mockImplementation(
      async (_target: any, method: string) => {
        if (method === 'Page.getLayoutMetrics') {
          return { layoutViewport: { pageX: 0, pageY: 0 } };
        }
        if (method === 'Page.enable') {
          throw new Error('Page.enable domain restore failure');
        }
        return {};
      },
    );

    await expect(cdpSessionManager.attach(tabId, 'owner-fail-restore')).rejects.toThrow(
      /Page\.enable domain restore failure/,
    );

    // Manager state must be cleaned up
    expect(cdpSessionManager.isAttached(tabId)).toBe(false);
    // CRITICAL: Must NEVER detach the physical debugger session
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
  });

  it('Case 7: probe failure does not mutate or leak into existing state owners', async () => {
    const tabId = 207;
    // Pre-populate a fake state on the manager
    const originalOwners = new Map([['pre-existing', 1]]);
    (cdpSessionManager as any).setState(tabId, {
      refCount: 1,
      owners: originalOwners,
      attachedByUs: false,
    });

    (chrome.debugger.getTargets as any).mockResolvedValue([
      { tabId, attached: true, extensionId: undefined, type: 'page' },
    ]);

    // Probe fails
    (chrome.debugger.sendCommand as any).mockImplementation(
      async (_target: any, method: string) => {
        if (method === 'Page.getLayoutMetrics') {
          throw new Error('Debugger is not attached to the target with id: 207');
        }
        return {};
      },
    );

    await expect(cdpSessionManager.attach(tabId, 'new-failed-owner')).rejects.toThrow(
      /Debugger is already attached to tab 207 by another client/,
    );

    // Original owners Map was not mutated
    expect(originalOwners.has('new-failed-owner')).toBe(false);
    expect(originalOwners.get('pre-existing')).toBe(1);
  });
});
