import { describe, it, expect, beforeEach, vi } from 'vitest';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as raceCdpModule from '../utils/race-cdp';

describe('A-05: click_sequence multi-point action (clamp, order, failure)', () => {
  const targetTabId = 42;

  beforeEach(() => {
    vi.restoreAllMocks();

    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
        query: vi.fn(async () => [{ id: targetTabId, active: true, windowId: 1 }]),
      },
    };

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) => {
      return fn({} as any);
    });

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetScrollState') {
          return [
            { result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 } },
          ] as any;
        }
        if (fnName === 'inPageGetViewportCoordinates') {
          return [{ result: { x: 0, y: 0, width: 1280, height: 800 } }] as any;
        }
        return [{ result: { success: true } }] as any;
      },
    );
  });

  it('preserves point traversal order across all coordinates in sequence', async () => {
    const dispatchedPoints: Array<{ x: number; y: number; type: string }> = [];

    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent') {
        dispatchedPoints.push({ x: params.x, y: params.y, type: params.type });
      }
      return {} as any;
    });

    const points = [
      { x: 100, y: 150 },
      { x: 250, y: 300 },
      { x: 400, y: 450 },
    ];

    const res = await interactIndexTool.execute({
      tabId: targetTabId,
      points,
      intervalMs: 10,
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('click_sequence');
    expect(parsed.pointsDispatched).toBe(3);

    // Each point dispatches mousePressed then mouseReleased
    const presses = dispatchedPoints.filter((p) => p.type === 'mousePressed');
    expect(presses).toHaveLength(3);
    expect(presses[0]).toMatchObject({ x: 100, y: 150 });
    expect(presses[1]).toMatchObject({ x: 250, y: 300 });
    expect(presses[2]).toMatchObject({ x: 400, y: 450 });
  });

  it('clamps intervalMs to lower bound of 5ms and upper bound of 500ms (default 35ms)', async () => {
    const sleepDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number) => {
      if (typeof ms === 'number') sleepDelays.push(ms);
      return origSetTimeout(fn, ms);
    });

    vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);

    // 1. Lower clamp: intervalMs = 1 should clamp to 5ms
    sleepDelays.length = 0;
    await interactIndexTool.execute({
      tabId: targetTabId,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      intervalMs: 1,
    });
    expect(sleepDelays).toContain(5);

    // 2. Upper clamp: intervalMs = 999 should clamp to 500ms
    sleepDelays.length = 0;
    await interactIndexTool.execute({
      tabId: targetTabId,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      intervalMs: 999,
    });
    expect(sleepDelays).toContain(500);

    // 3. Default: intervalMs omitted should default to 35ms
    sleepDelays.length = 0;
    await interactIndexTool.execute({
      tabId: targetTabId,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
    });
    expect(sleepDelays).toContain(35);
  });

  it('propagates per-point failure honestly, stops sequence, and unlocks scroll', async () => {
    let callCount = 0;
    const lockCalls: boolean[] = [];

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageLockScroll') {
          lockCalls.push(args[0]);
        }
        return [{ result: { success: true } }] as any;
      },
    );

    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed') {
          callCount++;
          // Fail on the second point
          if (callCount === 2) {
            throw new Error('CDP_DISPATCH_TIMEOUT: simulated target lost');
          }
        }
      }
      return {} as any;
    });

    const res = await interactIndexTool.execute({
      tabId: targetTabId,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 30, y: 30 },
      ],
      intervalMs: 10,
    });

    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('click_sequence failed after 1 points');
    expect((res.content[0] as any).text).toContain('CDP_DISPATCH_TIMEOUT: simulated target lost');

    // Exactly 2 press attempts occurred (point 1 succeeded, point 2 failed, point 3 never attempted)
    expect(callCount).toBe(2);

    // inPageLockScroll must have been called with true then finally with false
    expect(lockCalls).toEqual([true, false]);
  });
});
