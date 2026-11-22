import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HumanInterventionTool } from '../entrypoints/background/tools/browser/human-intervention';

describe('HumanInterventionTool (Human-in-the-Loop Barrier Solver)', () => {
  let tool: HumanInterventionTool;

  beforeEach(() => {
    tool = new HumanInterventionTool();
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
        query: vi.fn(async () => [{ id: 1, active: true, windowId: 1 }]),
        sendMessage: vi.fn(),
      },
    };
  });

  it('rejects calls without reason', async () => {
    const res = await tool.execute({ reason: '' } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('reason is required');
  });

  it('dispatches banner request and resolves cleanly on user completion', async () => {
    (chrome.tabs.sendMessage as any).mockResolvedValueOnce({
      ok: true,
      action: 'completed_by_user',
    });

    const res = await tool.execute({
      tabId: 1,
      reason: '请在页面上输入短信验证码',
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.resolved).toBe(true);
    expect(parsed.action).toBe('completed_by_user');
  });

  it('handles timeout when user does not intervene within deadline', async () => {
    (chrome.tabs.sendMessage as any).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 500)),
    );

    const res = await tool.execute({
      tabId: 1,
      reason: '滑块验证',
      timeoutMs: 40, // fast timeout for test
    });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('timed out');
  });

  it('cleans up timeout timer immediately when user resolves early to prevent stray cancel messages', async () => {
    vi.useFakeTimers();
    (chrome.tabs.sendMessage as any).mockResolvedValueOnce({
      ok: true,
      action: 'completed_by_user',
    });

    const execPromise = tool.execute({
      tabId: 1,
      reason: '验证码输入',
      timeoutMs: 60000,
    });

    const res = await execPromise;
    expect(res.isError).toBe(false);

    // Advance time past the original 60s timeout
    await vi.advanceTimersByTimeAsync(70000);

    // chrome.tabs.sendMessage should ONLY have been called once for HUMAN_INTERVENTION_REQUEST
    // and NEVER for HUMAN_INTERVENTION_CANCEL
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect((chrome.tabs.sendMessage as any).mock.calls[0][1].type).toBe(
      'HUMAN_INTERVENTION_REQUEST',
    );
    vi.useRealTimers();
  });

  it('returns an error when the intervention request is cancelled or preempted', async () => {
    (chrome.tabs.sendMessage as any).mockResolvedValueOnce({
      ok: false,
      cancelled: true,
      reason: 'preempted',
    });

    const preemptedRes = await tool.execute({
      tabId: 1,
      reason: 'Complete login verification',
    });

    expect(preemptedRes.isError).toBe(true);
    expect((preemptedRes.content[0] as any).text).toContain('preempted');

    (chrome.tabs.sendMessage as any).mockResolvedValueOnce({
      ok: false,
      cancelled: true,
      reason: 'cancelled',
    });

    const cancelledRes = await tool.execute({
      tabId: 1,
      reason: 'Complete login verification',
    });

    expect(cancelledRes.isError).toBe(true);
    expect((cancelledRes.content[0] as any).text).toContain('cancelled');
  });
});
