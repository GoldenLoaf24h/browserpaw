import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cdpSessionManager, CDP_IDLE_DETACH_TIMEOUT_MS } from "../utils/cdp-session-manager";
import { executeInPage } from "../entrypoints/background/tools/browser/in-page-engine";

describe("W4 CDP Lifecycle & In-Page Regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).chrome = {
      runtime: { id: "test-ext-id" },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue({}),
        getTargets: vi.fn().mockResolvedValue([]),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 101 }),
        query: vi.fn().mockResolvedValue([]),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn(),
      },
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("[BUG-05] Same owner 2 attach and 2 detach should balance refCount to 0 and trigger idle detach", async () => {
    const tabId = 101;
    const owner = "tool-a";

    await cdpSessionManager.attach(tabId, owner);
    await cdpSessionManager.attach(tabId, owner);

    // First detach
    await cdpSessionManager.detach(tabId, owner);
    expect(cdpSessionManager.isAttached(tabId)).toBe(true);

    // Second detach: should decrement refCount to 0 and arm idleTimer
    await cdpSessionManager.detach(tabId, owner);
    expect(cdpSessionManager.isAttached(tabId)).toBe(true);

    // Advance idle timer
    await vi.advanceTimersByTimeAsync(CDP_IDLE_DETACH_TIMEOUT_MS + 100);

    // Should now be physically detached
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId });
    expect(cdpSessionManager.isAttached(tabId)).toBe(false);
  });

  it("[BUG-07] serializeTabOp maintains strict serialization even if predecessor takes > 4000ms", async () => {
    const tabId = 102;
    let predecessorFinished = false;
    let successorStartedWhilePredecessorRunning = false;

    const p1 = (cdpSessionManager as any).serializeTabOp(tabId, async () => {
      await new Promise((r) => setTimeout(r, 6000));
      predecessorFinished = true;
    });

    const p2 = (cdpSessionManager as any).serializeTabOp(tabId, async () => {
      if (!predecessorFinished) {
        successorStartedWhilePredecessorRunning = true;
      }
    });

    await vi.advanceTimersByTimeAsync(4500);
    expect(successorStartedWhilePredecessorRunning).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([p1, p2]);
    expect(predecessorFinished).toBe(true);
    expect(successorStartedWhilePredecessorRunning).toBe(false);
  });

  it("[BUG-06] enableDomain rolls back tabDomains refCount on non-closing errors and rethrows", async () => {
    const tabId = 103;
    (chrome.runtime as any).id = "real-ext-id";
    (chrome.debugger.sendCommand as any).mockRejectedValueOnce(new Error("Internal CDP protocol error"));

    await expect(cdpSessionManager.enableDomain(tabId, "CSS")).rejects.toThrow("Internal CDP protocol error");
    expect(cdpSessionManager.getDomainRefCount(tabId, "CSS")).toBe(0);
  });

  it("[BUG-21] physical attach rolls back session and detaches if initial domain enable fails", async () => {
    const tabId = 104;
    (chrome.runtime as any).id = "real-ext-id";

    (chrome.debugger.sendCommand as any).mockImplementation(async (target: any, method: string) => {
      if (method === "Page.enable") {
        throw new Error("Page.enable failed");
      }
      return {};
    });

    await expect(cdpSessionManager.attach(tabId, "owner-init")).rejects.toThrow("Page.enable failed");
    expect(cdpSessionManager.isAttached(tabId)).toBe(false);
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId });
  });

  it("[BUG-08] sendCommand invalidates stale attachedByUs and re-attaches physically when not-attached occurs", async () => {
    const tabId = 105;
    (chrome.runtime as any).id = "real-ext-id";

   await cdpSessionManager.attach(tabId, "owner-active");
   expect(cdpSessionManager.isAttached(tabId)).toBe(true);

    const attachCount = (chrome.debugger.attach as any).mock.calls.length;
   (chrome.debugger.sendCommand as any)
     .mockRejectedValueOnce(new Error("Debugger is not attached to the target with id: 105"))
     .mockResolvedValueOnce({});

    const pending = cdpSessionManager.sendCommand(tabId, "DOM.getDocument");
    await vi.advanceTimersByTimeAsync(500);
    const res = await pending;
    expect(res).toBeDefined();
    expect((chrome.debugger.attach as any).mock.calls.length).toBeGreaterThan(attachCount);
    expect(cdpSessionManager.isAttached(tabId)).toBe(true);
  });

  it("[BUG-19/CDP] post-dispatch detach is reported as uncertain and the command is not replayed", async () => {
    const tabId = 107;
    (chrome.runtime as any).id = "real-ext-id";
    await cdpSessionManager.attach(tabId, "owner-write");
    const send = chrome.debugger.sendCommand as any;
    send.mockReset();
    send.mockImplementation(async (_t: any, method: string) => {
      if (method === "Input.dispatchMouseEvent") throw new Error("Debugger detached while handling command");
      return {};
    });

    const p = cdpSessionManager.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed" });
    const assertion = expect(p).rejects.toThrow(/outcome unknown/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    const dispatched = send.mock.calls.filter((c: any[]) => c[1] === "Input.dispatchMouseEvent");
    expect(dispatched).toHaveLength(1);
  });

  it("[BUG-01] executeInPage does not delete other in-flight call slots", async () => {
    const g = globalThis as any;
    let slot1Key = "";
    let slot2Key = "";

    (chrome.scripting.executeScript as any).mockImplementation(async ({ func, args, files }: any) => {
      if (files) return [{ result: true, frameId: 0 }];
      if (func && func.length >= 4) {
        const slotKey = args[3];
        if (!slot1Key) slot1Key = slotKey;
        else if (!slot2Key) slot2Key = slot2Key || slotKey;
        return [{ result: func(...args), frameId: 0 }];
      } else if (func.length === 1) {
        const [slotKey] = args;
        return [{ result: func(slotKey), frameId: 0 }];
      } else if (func.length === 2) {
        const [slotKey, timeoutMs] = args;
        return [{ result: func(slotKey, timeoutMs), frameId: 0 }];
      }
      return [];
    });

    let resolve1: any;
    let resolve2: any;
    g.__MCP_INPAGE__ = {
      action1: () => new Promise((r) => { resolve1 = r; }),
      action2: () => new Promise((r) => { resolve2 = r; }),
    };

    const p1 = executeInPage({ tabId: 106 }, "action1", []);
    await vi.advanceTimersByTimeAsync(20);

    const p2 = executeInPage({ tabId: 106 }, "action2", []);
    await vi.advanceTimersByTimeAsync(20);

    expect(g[slot1Key]).toBeDefined();
    expect(g[slot2Key]).toBeDefined();

    resolve1({ data: "result1" });
    resolve2({ data: "result2" });

    await vi.advanceTimersByTimeAsync(100);

   const [r1, r2] = await Promise.all([p1, p2]);
   expect(r1[0].result).toEqual({ data: "result1" });
   expect(r2[0].result).toEqual({ data: "result2" });
 });

  it("enableDomain concurrent calls share in-flight enable and both reject without false success if enable fails", async () => {
    const tabId = 108;
    (chrome.runtime as any).id = "real-ext-id";
    let rejectEnable: (err: any) => void;
    (chrome.debugger.sendCommand as any).mockImplementation(async (_t: any, method: string) => {
      if (method === "DOM.enable") {
        return new Promise((_, reject) => {
          rejectEnable = reject;
        });
      }
      return {};
    });

    const p1 = cdpSessionManager.enableDomain(tabId, "DOM");
    const p2 = cdpSessionManager.enableDomain(tabId, "DOM");

    // Verify exact domain.enable method was dispatched via CDP protocol
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId }, "DOM.enable", expect.anything());

    expect(cdpSessionManager.getDomainRefCount(tabId, "DOM")).toBe(2);

    rejectEnable!(new Error("Failed to enable DOM"));

    await expect(p1).rejects.toThrow("Failed to enable DOM");
    await expect(p2).rejects.toThrow("Failed to enable DOM");
    expect(cdpSessionManager.getDomainRefCount(tabId, "DOM")).toBe(0);
  });

  it("sendCommand treats Runtime.evaluate as unknown and does NOT replay even if error says not-attached", async () => {
    const tabId = 109;
    (chrome.runtime as any).id = "real-ext-id";
    await cdpSessionManager.attach(tabId, "owner-eval");
    const send = chrome.debugger.sendCommand as any;
    send.mockReset();
    send.mockImplementation(async (_t: any, method: string) => {
      if (method === "Runtime.evaluate") {
        throw new Error("Debugger is not attached to the target with id: 109");
      }
      return {};
    });

    const p = cdpSessionManager.sendCommand(tabId, "Runtime.evaluate", { expression: "location.href" });
    const assertion = expect(p).rejects.toThrow(/outcome unknown/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    const evalCalls = send.mock.calls.filter((c: any[]) => c[1] === "Runtime.evaluate");
    expect(evalCalls).toHaveLength(1);
  });

  it("auto-reconnect rolls back physical attach if restoreActiveDomains fails", async () => {
    const tabId = 110;
    (chrome.runtime as any).id = "real-ext-id";
    await cdpSessionManager.attach(tabId, "owner-flaky");
    await cdpSessionManager.enableDomain(tabId, "CSS");

    (chrome.debugger.detach as any).mockClear();
    (chrome.debugger.attach as any).mockClear();

    (chrome.debugger.sendCommand as any).mockImplementation(async (_t: any, method: string) => {
      if (method === "DOM.getDocument") {
        throw new Error("Debugger is not attached to the target with id: 110");
      }
      if (method === "CSS.enable") {
        throw new Error("CSS.enable failed during domain restore");
      }
      return {};
    });

    const p = cdpSessionManager.sendCommand(tabId, "DOM.getDocument");
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

   expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId }, "1.3");
   expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId });
   expect(cdpSessionManager.isAttached(tabId)).toBe(false);
 });

  it("[BUG-01/Timeout] executeInPage cleans up its slot on timeout and prevents delayed resolution from repolluting", async () => {
    const g = globalThis as any;
    let activeSlotKey = "";
    let delayedResolve: any;

    (chrome.scripting.executeScript as any).mockImplementation(async ({ func, args, files }: any) => {
      if (files) return [{ result: true, frameId: 0 }];
      if (func && func.length >= 4) {
        const [ns, name, fnArgs, slotKey, stashSync] = args;
        activeSlotKey = slotKey;
        return [{ result: func(ns, name, fnArgs, slotKey, stashSync), frameId: 0 }];
      } else if (func && func.length === 1) {
        const [slotKey] = args;
        return [{ result: func(slotKey), frameId: 0 }];
      } else if (func && func.length === 2) {
        const [slotKey, timeoutMs] = args;
        return [{ result: func(slotKey, timeoutMs), frameId: 0 }];
      }
      return [];
    });

    g.__MCP_INPAGE__ = {
      slowAction: () => new Promise((r) => { delayedResolve = r; }),
    };

    const pending = executeInPage({ tabId: 111 }, "slowAction", [], 50);
    const assertion = expect(pending).rejects.toThrow(/timeout/);

    // Let it poll and exceed timeout (50ms)
    await vi.advanceTimersByTimeAsync(150);

    await assertion;
    // The slot must be removed from globalThis
    expect(g[activeSlotKey]).toBeUndefined();

    // Delayed resolution happens after timeout
    delayedResolve({ data: "late-data" });
    await vi.advanceTimersByTimeAsync(50);
   // Still undefined, cannot repollute
   expect(g[activeSlotKey]).toBeUndefined();
 });

  it("[BUG-01/SingleTurn] executeInPage cleans up stashed slot on single-turn completion", async () => {
    const g = globalThis as any;
    let activeSlotKey = "";

    (chrome.scripting.executeScript as any).mockImplementation(async ({ func, args, files }: any) => {
      if (files) return [{ result: true, frameId: 0 }];
      if (func && func.length >= 4) {
        const slotKey = args[3];
        activeSlotKey = slotKey;
        return [{ result: func(...args), frameId: 0 }];
      } else if (func && func.length === 1) {
        const [slotKey] = args;
        return [{ result: func(slotKey), frameId: 0 }];
      }
      return [];
    });

    g.__MCP_INPAGE__ = {
      syncAction: () => ({ ok: true }),
    };

   const res = await executeInPage({ tabId: 112 }, "syncAction", []);
   expect(res[0].result).toEqual({ ok: true });
   expect(g[activeSlotKey]).toBeUndefined();
 });

  it("auto-reconnect merges existing owners and preserves concurrent owners without overwrite", async () => {
    const tabId = 113;
    (chrome.runtime as any).id = "real-ext-id";

    await cdpSessionManager.attach(tabId, "owner-orig");

    // Simulate a concurrent attach that added owner-concurrent
    await cdpSessionManager.attach(tabId, "owner-concurrent");

    (chrome.debugger.sendCommand as any)
      .mockRejectedValueOnce(new Error("Debugger is not attached to the target with id: 113"))
      .mockResolvedValueOnce({});

    const pending = cdpSessionManager.sendCommand(tabId, "DOM.getDocument");
    await vi.advanceTimersByTimeAsync(500);
    await pending;

    // Both owners must be preserved and total refCount balanced
    const state = (cdpSessionManager as any).getState(tabId);
    expect(state).toBeDefined();
    expect(state.owners.get("owner-orig")).toBe(1);
    expect(state.owners.get("owner-concurrent")).toBe(1);
    expect(state.refCount).toBe(2);
  });

  it("serializeTabOp queue does not deadlock when an earlier op rejects", async () => {
    const tabId = 114;
    let secondOpExecuted = false;

    const p1 = (cdpSessionManager as any).serializeTabOp(tabId, async () => {
      throw new Error("Op 1 intentional crash");
    });

    const p2 = (cdpSessionManager as any).serializeTabOp(tabId, async () => {
      secondOpExecuted = true;
      return "op2-success";
    });

    await expect(p1).rejects.toThrow("Op 1 intentional crash");
    const res2 = await p2;
    expect(secondOpExecuted).toBe(true);
    expect(res2).toBe("op2-success");
  });
  it("[BUG-RECONNECT-DETACH-RACE] reconnect preserves concurrent detach and does not resurrect detached owner via Math.max", async () => {
    const tabId = 115;
    (chrome.runtime as any).id = "real-ext-id";

    await cdpSessionManager.attach(tabId, "owner-persist");
    await cdpSessionManager.attach(tabId, "owner-to-detach");

    let sendCommandCallCount = 0;
    (chrome.debugger.sendCommand as any).mockImplementation(async (_t: any, method: string) => {
      if (method === "DOM.getDocument") {
        sendCommandCallCount++;
        if (sendCommandCallCount === 1) {
          throw new Error("Debugger is not attached to the target with id: 115");
        }
      }
      return {};
    });

    const pendingCmd = cdpSessionManager.sendCommand(tabId, "DOM.getDocument");
    const pendingDetach = cdpSessionManager.detach(tabId, "owner-to-detach");

    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([pendingCmd, pendingDetach]);

    const state = (cdpSessionManager as any).getState(tabId);
    expect(state).toBeDefined();
    expect(state.owners.get("owner-to-detach") || 0).toBe(0);
    expect(state.owners.get("owner-persist")).toBe(1);
    expect(state.refCount).toBe(1);
  });

  it("[GATE-100-CYCLES] 100 cycles of reconnect conserve core Page and Network domain refCounts without accumulation", async () => {
    const tabId = 116;
    (chrome.runtime as any).id = "real-ext-id";

    await cdpSessionManager.attach(tabId, "owner-cycle");
    expect(cdpSessionManager.getDomainRefCount(tabId, "Page")).toBe(1);
    expect(cdpSessionManager.getDomainRefCount(tabId, "Network")).toBe(1);

    for (let i = 1; i <= 100; i++) {
      (chrome.debugger.sendCommand as any).mockRejectedValueOnce(
        new Error(`Debugger is not attached to the target with id: ${tabId}`),
      );
      const p = cdpSessionManager.sendCommand(tabId, "DOM.getDocument");
      await vi.advanceTimersByTimeAsync(500);
      await p;
    }

    const pageRefCount = cdpSessionManager.getDomainRefCount(tabId, "Page");
    const netRefCount = cdpSessionManager.getDomainRefCount(tabId, "Network");
    expect(pageRefCount).toBe(1);
    expect(netRefCount).toBe(1);
  });

  it("[GATE-LATE-ENABLE] onDetach / tab close prevents stale domain enable late-resolution from polluting new session state", async () => {
    const tabId = 117;
    (chrome.runtime as any).id = "real-ext-id";

    await cdpSessionManager.attach(tabId, "owner-old");

    let resolveOldEnable!: (val: any) => void;
    let isFirstDomEnable = true;
    (chrome.debugger.sendCommand as any).mockImplementation(async (_t: any, method: string) => {
      if (method === "DOM.enable" && isFirstDomEnable) {
        isFirstDomEnable = false;
        return new Promise((resolve) => {
          resolveOldEnable = resolve;
        });
      }
      return {};
    });

    const oldEnablePromise = cdpSessionManager.enableDomain(tabId, "DOM");

    const onDetachListeners = (chrome.debugger.onDetach.addListener as any).mock.calls;
    const onDetachCallback = onDetachListeners[onDetachListeners.length - 1]?.[0];
    if (onDetachCallback) {
      onDetachCallback({ tabId }, "target_closed");
    } else {
      (cdpSessionManager as any).handleDetachOrRemoved(tabId, "test onDetach");
    }

    await cdpSessionManager.attach(tabId, "owner-new");
    expect(cdpSessionManager.getDomainRefCount(tabId, "DOM")).toBe(0);

    resolveOldEnable({});
    await expect(oldEnablePromise).rejects.toThrow(/detached/i);

    expect(cdpSessionManager.getDomainRefCount(tabId, "DOM")).toBe(0);

    await cdpSessionManager.enableDomain(tabId, "DOM");
    expect(cdpSessionManager.getDomainRefCount(tabId, "DOM")).toBe(1);
  });
});
