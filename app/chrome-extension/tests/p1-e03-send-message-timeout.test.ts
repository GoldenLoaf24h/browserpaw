import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseBrowserToolExecutor } from '../entrypoints/background/tools/base-browser';
import { networkRequestTool } from '../entrypoints/background/tools/browser/network-request';
import type { ToolResult } from '../common/tool-handler';

class TestBrowserExecutor extends BaseBrowserToolExecutor {
  name = 'test_executor';
  async execute(): Promise<ToolResult> {
    return { content: [], isError: false };
  }
  public testSendMessage(tabId: number, message: any, frameId?: number, timeoutMs?: number) {
    return this.sendMessageToTab(tabId, message, frameId, timeoutMs);
  }
}

describe('P1-E03: sendMessageToTab timeout propagation & D-16 timer cleanup', () => {
  let executor: TestBrowserExecutor;

  beforeEach(() => {
    executor = new TestBrowserExecutor();
    vi.useFakeTimers();
    (globalThis as any).chrome = (globalThis as any).chrome || {};
    (globalThis as any).chrome.tabs = (globalThis as any).chrome.tabs || {};
    (globalThis as any).chrome.tabs.sendMessage = vi.fn();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('D-16: clears timer when chrome.tabs.sendMessage resolves fast', async () => {
    vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(async () => {
      return { success: true, data: 123 };
    });

    const res = await executor.testSendMessage(1, { action: 'ping' });
    expect(res).toEqual({ success: true, data: 123 });
    // D-16: Timer MUST be cleared immediately upon resolve
    expect(vi.getTimerCount()).toBe(0);
  });

  it('D-16: clears timer when chrome.tabs.sendMessage rejects fast', async () => {
    vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(async () => {
      throw new Error('Connection failed');
    });

    let caught: any = null;
    try {
      await executor.testSendMessage(1, { action: 'ping' });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect(caught.message).toContain('Connection failed');
    // D-16: Timer MUST be cleared immediately upon reject
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces default 5s timeout when timeoutMs is not specified and cleans up timer', async () => {
    // Hanging tab message that never resolves
    vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(() => {
      return new Promise(() => {});
    });

    let caught: any = null;
    const sendPromise = executor.testSendMessage(1, { action: 'slow_action' }).catch((e) => {
      caught = e;
    });

    // Advance 4900ms - should still be pending
    await vi.advanceTimersByTimeAsync(4900);
    expect(caught).toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    // Advance past 5000ms default
    await vi.advanceTimersByTimeAsync(200);
    await sendPromise;

    expect(caught).not.toBeNull();
    expect(caught.message).toContain('TABS_MESSAGE_TIMEOUT');
    expect(caught.message).toContain('slow_action');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors propagated timeoutMs allowing slow network responses to complete', async () => {
    vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(() => {
      // Resolves at 7000ms (would fail under default 5000ms)
      return new Promise((resolve) => {
        setTimeout(() => resolve({ success: true, content: 'data' }), 7000);
      });
    });

    // Custom 10000ms timeout
    const sendPromise = executor.testSendMessage(1, { action: 'network_fetch' }, undefined, 10000);

    // Advance past 5s default
    await vi.advanceTimersByTimeAsync(5500);
    // Still running, not rejected!

    // Advance to 7000ms
    await vi.advanceTimersByTimeAsync(1500);
    const result = await sendPromise;

    expect(result).toEqual({ success: true, content: 'data' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('networkRequestTool propagates timeout with a reasonable margin to sendMessageToTab', async () => {
    vi.useRealTimers(); // real timers for this call-arg inspection test
    vi.spyOn(networkRequestTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 99 });
    vi.spyOn(networkRequestTool as any, 'injectContentScript').mockResolvedValue(undefined);
    const sendSpy = vi
      .spyOn(networkRequestTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true });

    // Explicit timeout 40000ms
    await networkRequestTool.execute({
      url: 'https://example.com/api',
      timeout: 40000,
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const callArgs = sendSpy.mock.calls[0];
    const passedTabId = callArgs[0];
    const passedMsg = callArgs[1];
    const passedFrameId = callArgs[2];
    const passedTimeoutMs = callArgs[3];

    expect(passedTabId).toBe(99);
    expect(passedMsg.timeout).toBe(40000);
    expect(passedFrameId).toBeUndefined();
    // Margin must be reasonable: timeout + 5000 = 45000ms
    expect(passedTimeoutMs).toBe(45000);
  });
});
