import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CdpExecuteTool } from '../entrypoints/background/tools/browser/cdp-execute';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

describe('CdpExecuteTool (Industrial 1:1 Parity with Official CDP Engine)', () => {
  let tool: CdpExecuteTool;

  beforeEach(() => {
    tool = new CdpExecuteTool();
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
        query: vi.fn(async () => [{ id: 1, active: true, windowId: 1 }]),
      },
      debugger: {
        getTargets: vi.fn(async () => [
          { targetId: 'target-page-1', type: 'page', title: 'Test Page' },
          { targetId: 'target-worker-2', type: 'service_worker', title: 'Worker' },
        ]),
        sendCommand: vi.fn(async () => ({ attached: true })),
      },
    };
  });

  it('rejects calls without method', async () => {
    const res = await tool.execute({ method: '' } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('method is required');
  });

  it('intercepts Target.getTargets and returns targetInfos directly from chrome.debugger', async () => {
    const res = await tool.execute({
      method: 'Target.getTargets',
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.result.targetInfos).toHaveLength(2);
    expect(parsed.result.targetInfos[0].targetId).toBe('target-page-1');
  });

  it('supports polymorphic routing to specific targetId (e.g. iframe / worker)', async () => {
    const res = await tool.execute({
      target: { targetId: 'target-worker-2' },
      method: 'Runtime.evaluate',
      params: { expression: 'self.version' },
    });

    expect(res.isError).toBe(false);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'target-worker-2' }),
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'self.version' }),
    );
  });

  it('routes standard tabId via cdpSessionManager', async () => {
    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValueOnce();
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValueOnce({
      windowId: 42,
      bounds: { left: 0, top: 0, width: 1280, height: 800 },
    });

    const res = await tool.execute({
      tabId: 1,
      method: 'Browser.getWindowForTarget',
      params: {},
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.method).toBe('Browser.getWindowForTarget');
    expect(parsed.result.windowId).toBe(42);
  });

  it('triggers anti-hang detach guard on command timeout', async () => {
    vi.spyOn(cdpSessionManager, 'attach').mockResolvedValueOnce();
    const detachSpy = vi.spyOn(cdpSessionManager, 'detach').mockResolvedValueOnce(undefined as any);
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 500)),
    );

    const res = await tool.execute({
      tabId: 1,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
      timeoutMs: 40, // fast timeout
    });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('Timed out after 40ms');
    // Verifies official anti-hang guard detached the frozen session
    expect(detachSpy).toHaveBeenCalledWith(
      1,
      'timeout-guard',
      expect.stringMatching(/^cdp-execute:1:Page\.navigate:/),
    );
  });
});
