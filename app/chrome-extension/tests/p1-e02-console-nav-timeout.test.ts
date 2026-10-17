import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleTool } from '../entrypoints/background/tools/browser/console';

describe('P1-E02: waitForTabReady bounded deadline and timer cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects with timeout when tab status remains loading past TAB_READY_TIMEOUT_MS and cleans up timers', async () => {
    // Mock chrome.tabs.get returning loading tab indefinitely
    (globalThis as any).chrome = (globalThis as any).chrome || {};
    (globalThis as any).chrome.tabs = (globalThis as any).chrome.tabs || {};
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({ id: 42, status: 'loading' } as any);

    let caughtError: any = null;
    const waitPromise = (consoleTool as any).waitForTabReady(42).catch((err: any) => {
      caughtError = err;
    });

    // Advance 14.9s - should still be waiting
    await vi.advanceTimersByTimeAsync(14900);
    expect(caughtError).toBeNull();

    // Advance past 15s deadline
    await vi.advanceTimersByTimeAsync(200);
    await waitPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError.message).toContain('TAB_READY_TIMEOUT');
    expect(caughtError.message).toContain('42');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves immediately when tab is complete and leaves zero active timers', async () => {
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({ id: 42, status: 'complete' } as any);

    await (consoleTool as any).waitForTabReady(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves when tab is closed (get throws) and leaves zero active timers', async () => {
    vi.spyOn(chrome.tabs, 'get').mockRejectedValue(new Error('Tab closed'));

    await (consoleTool as any).waitForTabReady(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves when tab transitions to complete after several checks and cleans up', async () => {
    let callCount = 0;
    vi.spyOn(chrome.tabs, 'get').mockImplementation(async () => {
      callCount++;
      return { id: 42, status: callCount >= 3 ? 'complete' : 'loading' } as any;
    });

    const waitPromise = (consoleTool as any).waitForTabReady(42);
    await vi.advanceTimersByTimeAsync(300);
    await waitPromise;

    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
