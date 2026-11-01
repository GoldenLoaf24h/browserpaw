import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cdpSessionManager,
  CDP_IDLE_DETACH_TIMEOUT_MS,
  CdpEventObserver,
} from '../utils/cdp-session-manager';

describe('CDP Recursive Flat Child Sessions (Production Semantics & Concurrency)', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    (globalThis as any).chrome = {
      runtime: { id: 'test-ext-id' },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockImplementation(async () => ({})),
        getTargets: vi.fn().mockResolvedValue([]),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 301 }),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
      },
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('REAL-RACE: ensureFrameSessions asynchronously drains nested child setups (A -> B -> C) before resolving', async () => {
    const tabId = 301;
    (chrome.runtime as any).id = 'real-ext-id';

    // Setup realistic async CDP chain:
    // 1. Root Target.setAutoAttach -> queues child B attachedToTarget
    // 2. Child B Target.setAutoAttach -> queues child C attachedToTarget
    (chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string) => {
      if (!target.sessionId && method === 'Target.setAutoAttach') {
        queueMicrotask(() => {
          cdpSessionManager.handleCdpEvent({ tabId }, 'Target.attachedToTarget', {
            sessionId: 'sess-b',
            targetInfo: { targetId: 'tgt-b', type: 'iframe' },
          });
        });
        return {};
      }
      if (target.sessionId === 'sess-b' && method === 'Target.setAutoAttach') {
        queueMicrotask(() => {
          cdpSessionManager.handleCdpEvent(
            { tabId, sessionId: 'sess-b' },
            'Target.attachedToTarget',
            {
              sessionId: 'sess-c',
              targetInfo: { targetId: 'tgt-c', type: 'iframe' },
            },
          );
        });
        return {};
      }
      return {};
    });

    const sessions = await cdpSessionManager.ensureFrameSessions(tabId);

    // Both B and C must be reliably discovered and resolved
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(
      expect.arrayContaining([
        { sessionId: 'sess-b', targetId: 'tgt-b', parentSessionId: undefined },
        { sessionId: 'sess-c', targetId: 'tgt-c', parentSessionId: 'sess-b' },
      ]),
    );

    // Verify Page.enable was called for every child
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId, sessionId: 'sess-b' },
      'Page.enable',
      {},
    );
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId, sessionId: 'sess-c' },
      'Page.enable',
      {},
    );
  });

  it('FAIL-FAST: any child setup failure rejects ensureFrameSessions and never returns partial success', async () => {
    const tabId = 302;
    (chrome.runtime as any).id = 'real-ext-id';

    (chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string) => {
      if (!target.sessionId && method === 'Target.setAutoAttach') {
        queueMicrotask(() => {
          cdpSessionManager.handleCdpEvent({ tabId }, 'Target.attachedToTarget', {
            sessionId: 'sess-b',
            targetInfo: { targetId: 'tgt-b', type: 'iframe' },
          });
        });
        return {};
      }
      if (target.sessionId === 'sess-b' && method === 'Page.enable') {
        return Promise.reject(new Error('Page.enable failed on child frame'));
      }
      return {};
    });

    await expect(cdpSessionManager.ensureFrameSessions(tabId)).rejects.toThrow(
      'Page.enable failed on child frame',
    );
  });

  it('OWNERSHIP: ensureFrameSessions balances refCount to 0 via withSession and enters 10min retention without leak', async () => {
    const tabId = 303;
    (chrome.runtime as any).id = 'real-ext-id';

    await cdpSessionManager.ensureFrameSessions(tabId);

    // Check internal state: refCount must be 0 (no leak of 'frame-sessions' owner)
    const state = (cdpSessionManager as any).getState(tabId);
    expect(state).toBeDefined();
    expect(state.refCount).toBe(0);
    expect(state.owners.get('frame-sessions') || 0).toBe(0);

    // Still physically attached because of 10-minute idle retention
    expect(cdpSessionManager.isAttached(tabId)).toBe(true);

    // Advance beyond 10-minute retention
    await vi.advanceTimersByTimeAsync(CDP_IDLE_DETACH_TIMEOUT_MS + 100);

    // Physically detached now
    expect(cdpSessionManager.isAttached(tabId)).toBe(false);
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId });
  });

  it('retries a failed child setup without requiring another attachedToTarget event', async () => {
    const tabId = 308;
    let childEnableCalls = 0;
    (chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string) => {
      if (!target.sessionId && method === 'Target.setAutoAttach') {
        queueMicrotask(() => {
          cdpSessionManager.handleCdpEvent({ tabId }, 'Target.attachedToTarget', {
            sessionId: 'retry-child',
            targetInfo: { targetId: 'retry-target', type: 'iframe' },
          });
        });
      }
      if (target.sessionId === 'retry-child' && method === 'Page.enable') {
        childEnableCalls++;
        if (childEnableCalls === 1) throw new Error('Transient child setup failure');
      }
      return {};
    });

    await expect(cdpSessionManager.ensureFrameSessions(tabId)).rejects.toThrow(
      'Transient child setup failure',
    );
    const recovered = await Promise.all([
      cdpSessionManager.ensureFrameSessions(tabId),
      cdpSessionManager.ensureFrameSessions(tabId),
    ]);
    for (const sessions of recovered) {
      expect(sessions).toEqual([
        { sessionId: 'retry-child', targetId: 'retry-target', parentSessionId: undefined },
      ]);
    }
    expect(childEnableCalls).toBe(2);
  });

  it('does not let an old child setup failure poison a reattached tab', async () => {
    const tabId = 309;
    await cdpSessionManager.ensureFrameSessions(tabId);
    let rejectOldSetup!: (error: Error) => void;
    (chrome.debugger.sendCommand as any).mockImplementation((target: any, method: string) => {
      if (target.sessionId === 'old-child' && method === 'Page.enable') {
        return new Promise((_, reject) => {
          rejectOldSetup = reject;
        });
      }
      return Promise.resolve({});
    });
    cdpSessionManager.handleCdpEvent({ tabId }, 'Target.attachedToTarget', {
      sessionId: 'old-child',
      targetInfo: { targetId: 'old-target', type: 'iframe' },
    });
    (cdpSessionManager as any).handleDetachOrRemoved(tabId, 'test-restart');
    await cdpSessionManager.ensureFrameSessions(tabId);
    rejectOldSetup(new Error('Old renderer disconnected'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(cdpSessionManager.ensureFrameSessions(tabId)).resolves.toEqual([]);
  });

  it('LATE-ATTACH-SHIELD: ignores attach from unregistered parent or unattached tab to prevent stale pollution', async () => {
    const tabId = 304;
    (chrome.runtime as any).id = 'real-ext-id';

    await cdpSessionManager.ensureFrameSessions(tabId);

    // 1. Child claiming parent is "ghost-session" (never registered in current epoch)
    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'ghost-session' },
      'Target.attachedToTarget',
      {
        sessionId: 'sess-orphan',
        targetInfo: { targetId: 'tgt-orphan', type: 'iframe' },
      },
    );

    let list = await cdpSessionManager.ensureFrameSessions(tabId);
    expect(list).toEqual([]); // Must be completely ignored

    // 2. Tab is detached, late attach arrives
    (cdpSessionManager as any).handleDetachOrRemoved(tabId, 'test-detach');
    expect(cdpSessionManager.isAttached(tabId)).toBe(false);

    cdpSessionManager.handleCdpEvent({ tabId }, 'Target.attachedToTarget', {
      sessionId: 'sess-stale',
      targetInfo: { targetId: 'tgt-stale', type: 'iframe' },
    });

    // Re-attach freshly
    list = await cdpSessionManager.ensureFrameSessions(tabId);
    expect(list).toEqual([]); // Stale attach must NOT pollute new session
  });

  it('ACTIVE-COMMANDS: child frame commands track activeCommands preventing premature idle detach', async () => {
    const tabId = 305;
    (chrome.runtime as any).id = 'real-ext-id';

    await cdpSessionManager.ensureFrameSessions(tabId);
    cdpSessionManager.handleCdpEvent({ tabId }, 'Target.attachedToTarget', {
      sessionId: 'sess-active',
      targetInfo: { targetId: 'tgt-active', type: 'iframe' },
    });

    // Drain initial setup for sess-active
    await cdpSessionManager.ensureFrameSessions(tabId);

    // Child command takes long time
    let resolveChildCmd!: (val: any) => void;
    (chrome.debugger.sendCommand as any).mockImplementation((target: any, method: string) => {
      if (target?.sessionId === 'sess-active' && method === 'DOM.getBoxModel') {
        return new Promise((r) => {
          resolveChildCmd = r;
        });
      }
      return Promise.resolve({});
    });

    const pendingChildCmd = cdpSessionManager.sendFrameCommand(
      tabId,
      'sess-active',
      'DOM.getBoxModel',
      {},
      15 * 60 * 1000, // 15 minutes timeout so it outlasts 10min idle check
    );

    // While command is running, activeCommands must be exactly 1
    expect((cdpSessionManager as any).activeCommands.get(tabId)).toBe(1);

    // Advance time near 10-minute idle retention
    await vi.advanceTimersByTimeAsync(CDP_IDLE_DETACH_TIMEOUT_MS);

    // Still attached because command is active (idle detach re-armed)
    expect(cdpSessionManager.isAttached(tabId)).toBe(true);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();

    // Now resolve child command
    resolveChildCmd({ model: { width: 100 } });
    await pendingChildCmd;

    expect((cdpSessionManager as any).activeCommands.get(tabId) || 0).toBe(0);

    // Now after idle timeout expires, it detaches cleanly
    await vi.advanceTimersByTimeAsync(CDP_IDLE_DETACH_TIMEOUT_MS + 100);
    expect(cdpSessionManager.isAttached(tabId)).toBe(false);
  });

  it('MUTATION-SAFETY: sendFrameCommand write failure uses exact outcome unknown phrasing to prevent synthetic retry', async () => {
    const tabId = 306;
    (chrome.runtime as any).id = 'real-ext-id';

    await cdpSessionManager.ensureFrameSessions(tabId);
    cdpSessionManager.handleCdpEvent({ tabId }, 'Target.attachedToTarget', {
      sessionId: 'sess-write',
      targetInfo: { targetId: 'tgt-write', type: 'iframe' },
    });
    await cdpSessionManager.ensureFrameSessions(tabId);

    (chrome.debugger.sendCommand as any).mockImplementation((target: any, method: string) => {
      if (target?.sessionId === 'sess-write' && method === 'Input.dispatchMouseEvent') {
        return Promise.reject(new Error('Renderer pipe broken'));
      }
      return Promise.resolve({});
    });

    await expect(
      cdpSessionManager.sendFrameCommand(tabId, 'sess-write', 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
      }),
    ).rejects.toThrow(
      /outcome unknown: connection lost after dispatch.*The command may have executed; inspect page state before retrying/,
    );
  });

  it('NETWORK-ISOLATION: child frame network events do not contaminate main tab inFlightRequests', async () => {
    const tabId = 307;
    (chrome.runtime as any).id = 'real-ext-id';

    await cdpSessionManager.ensureFrameSessions(tabId);

    // Main tab network request
    cdpSessionManager.handleCdpEvent({ tabId }, 'Network.requestWillBeSent', {
      requestId: 'main-req-1',
    });
    expect(cdpSessionManager.hasInFlightRequests(tabId)).toBe(true);

    // Child frame network request with same ID or different ID
    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'child-sess-net' },
      'Network.requestWillBeSent',
      { requestId: 'child-req-1' },
    );

    // Main tab has only its own request
    const inflight = cdpSessionManager.getInFlightRequests(tabId);
    expect(inflight.has('main-req-1')).toBe(true);
    expect(inflight.has('child-req-1')).toBe(false);

    // Child finishes: must NOT delete main tab's request even if requestId collided
    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'child-sess-net' },
      'Network.loadingFinished',
      { requestId: 'main-req-1' },
    );
    expect(cdpSessionManager.hasInFlightRequests(tabId)).toBe(true);

    // Main finishes
    cdpSessionManager.handleCdpEvent({ tabId }, 'Network.loadingFinished', {
      requestId: 'main-req-1',
    });
    expect(cdpSessionManager.hasInFlightRequests(tabId)).toBe(false);
  });

  it('TYPE-COMPAT: CdpEventObserver 4th argument supports Debuggee & { sessionId?: string } with direct access', async () => {
    const tabId = 308;
    (chrome.runtime as any).id = 'real-ext-id';

    let observedSourceSessionId: string | undefined = undefined;
    const observer: CdpEventObserver = (_tId, _method, _params, source) => {
      // TypeScript compiler checks: source?.sessionId is directly accessible without casting
      observedSourceSessionId = source?.sessionId;
    };

    cdpSessionManager.addCdpEventObserver(observer);

    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'sub-session-999' },
      'Page.loadEventFired',
      {},
    );

    expect(observedSourceSessionId).toBe('sub-session-999');
    cdpSessionManager.removeCdpEventObserver(observer);
  });
  it('DIALOG-ISOLATION: Page.javascriptDialogClosed only clears dialog matching its sessionId (root does not clear child, B does not clear A)', async () => {
    const tabId = 309;
    (chrome.runtime as any).id = 'real-ext-id';

    // 1. Child frame A opens a dialog
    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'sess-child-a' },
      'Page.javascriptDialogOpening',
      { type: 'prompt', message: 'Enter name in iframe A', defaultPrompt: 'Alice' },
    );

    let dialog = cdpSessionManager.getPendingDialog(tabId);
    expect(dialog).toBeDefined();
    expect(dialog?.sessionId).toBe('sess-child-a');
    expect(dialog?.message).toBe('Enter name in iframe A');

    // 2. Root sends dialogClosed (source has no sessionId) -> must NOT clear child A dialog
    cdpSessionManager.handleCdpEvent({ tabId }, 'Page.javascriptDialogClosed', {});
    dialog = cdpSessionManager.getPendingDialog(tabId);
    expect(dialog).toBeDefined();
    expect(dialog?.sessionId).toBe('sess-child-a');

    // 3. Child frame B sends dialogClosed -> must NOT clear child A dialog
    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'sess-child-b' },
      'Page.javascriptDialogClosed',
      {},
    );
    dialog = cdpSessionManager.getPendingDialog(tabId);
    expect(dialog).toBeDefined();
    expect(dialog?.sessionId).toBe('sess-child-a');

    // 4. Matching child frame A sends dialogClosed -> successfully clears
    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'sess-child-a' },
      'Page.javascriptDialogClosed',
      {},
    );
    expect(cdpSessionManager.getPendingDialog(tabId)).toBeUndefined();

    // 5. Root opens dialog -> child A closed must NOT clear root dialog
    cdpSessionManager.handleCdpEvent({ tabId }, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'Root alert',
    });
    expect(cdpSessionManager.getPendingDialog(tabId)?.sessionId).toBeUndefined();

    cdpSessionManager.handleCdpEvent(
      { tabId, sessionId: 'sess-child-a' },
      'Page.javascriptDialogClosed',
      {},
    );
    expect(cdpSessionManager.getPendingDialog(tabId)).toBeDefined();

    // Root closes its own dialog
    cdpSessionManager.handleCdpEvent({ tabId }, 'Page.javascriptDialogClosed', {});
    expect(cdpSessionManager.getPendingDialog(tabId)).toBeUndefined();
  });
});
