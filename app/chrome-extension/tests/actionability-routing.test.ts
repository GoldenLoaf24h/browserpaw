import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import * as locator from '../entrypoints/background/tools/browser/unified-locator';
import * as race from '../utils/race-cdp';
import { cdpSessionManager } from '../utils/cdp-session-manager';

describe('actionability failures stop physical delivery', () => {
  const coords = { success: true, x: 100, y: 200, index: 1, tagName: 'input', inputType: 'text' };
  let guard: Record<string, unknown>;
  let page: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async () => ({ id: 42, url: 'https://example.org/', active: false })),
      },
    });
    guard = { success: false, actionable: false, notFound: false, error: 'Target is disabled' };
    vi.spyOn(interactIndexTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 42,
      url: 'https://example.org/',
    });
    vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 42,
      url: 'https://example.org/',
    });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);
    vi.spyOn(race, 'raceCdp').mockResolvedValue({} as any);
    vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({ ...coords, frameId: 0 } as any);
    page = vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, name) => {
      if (name === 'inPageWaitForActionable') return [{ frameId: 0, result: guard }] as any;
      if (name === 'inPageGetElementCoordinates') return [{ frameId: 0, result: coords }] as any;
      return [];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['disabled', 'unstable', 'inert'])(
    'does not click or take visual fallback for %s',
    async (reason) => {
      guard = { ...guard, reason, error: `Target is ${reason}` };
      const result = await interactIndexTool.execute({
        tabId: 42,
        index: 1,
        coordinate: { x: 100, y: 200 },
        action: 'click',
        skipLock: true,
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse((result.content[0] as any).text);
      expect(JSON.stringify(result)).toContain(reason);
      expect(payload).toMatchObject({
        status: 'blocked',
        requestDispatched: false,
        interaction: {
          execution: { status: 'not_dispatched', dispatchedCount: 0 },
          verification: { status: 'not_requested' },
        },
      });
      expect(race.raceCdp).not.toHaveBeenCalled();
      expect(page).toHaveBeenCalledWith({ tabId: 42 }, 'inPageWaitForActionable', [1, 'click']);
      expect(page.mock.calls.some((call) => /InteractIndex|Synthetic/.test(String(call[1])))).toBe(
        false,
      );
    },
  );

  it('retains a subframe actionability failure rather than using supplied coordinates', async () => {
    page.mockImplementation(async (target: any, name: string) => {
      if (name === 'inPageWaitForActionable') {
        return target.allFrames
          ? [{ frameId: 122, result: guard }]
          : [{ frameId: 0, result: { success: false, notFound: true } }];
      }
      return [];
    });
    const result = await interactIndexTool.execute({
      tabId: 42,
      index: 1,
      coordinate: { x: 10, y: 10 },
      skipLock: true,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('disabled');
    expect(race.raceCdp).not.toHaveBeenCalled();
  });

  it('stops a batch before dispatch and reports zero completed actions', async () => {
    const result = await batchActionsTool.execute({
      tabId: 42,
      actions: [{ type: 'click', index: 1 }],
      includeDelta: false,
    });
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.success).toBe(false);
    expect(payload.completedActions).toBe(0);
    expect(payload.requestDispatched).toBe(false);
    expect(payload.interaction).toMatchObject({
      execution: { status: 'not_dispatched', dispatchedCount: 0 },
      verification: { status: 'not_requested' },
    });
    expect(race.raceCdp).not.toHaveBeenCalled();
  });

  it.each([
    { ref: 99, selector: '#replacement' },
    { index: 99, ref: 200 },
  ])('checks the resolved node instead of the original batch target: %j', async (target) => {
    vi.mocked(locator.resolveTargetLocation).mockResolvedValue({
      ...coords,
      index: 200,
      frameId: 0,
      resolutionPath: 'selector',
    } as any);
    page.mockImplementation(async (_scope, name, args) => {
      if (name === 'inPageWaitForActionable') {
        return [
          {
            frameId: 0,
            result:
              args[0] === 200
                ? { ...coords, index: 200 }
                : { success: false, error: 'Old ref not found' },
          },
        ] as any;
      }
      return [];
    });
    const result = await batchActionsTool.execute({
      tabId: 42,
      includeDelta: false,
      actions: [{ type: 'click', ...target }],
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse((result.content[0] as any).text).completedActions).toBe(1);
    expect(page).toHaveBeenCalledWith({ tabId: 42 }, 'inPageWaitForActionable', [200, 'click']);
    expect(race.raceCdp).toHaveBeenCalled();
  });

  it('does not recheck an expired ref after coordinate fallback was validated', async () => {
    vi.mocked(locator.resolveTargetLocation).mockResolvedValue({
      success: true,
      x: 100,
      y: 200,
      frameId: 0,
      resolutionPath: 'coordinate',
    } as any);
    const result = await batchActionsTool.execute({
      tabId: 42,
      includeDelta: false,
      actions: [{ type: 'click', ref: 99, coordinate: { x: 100, y: 200 } }],
    });
    expect(result.isError).toBe(false);
    expect(page.mock.calls.some(([, name]) => name === 'inPageWaitForActionable')).toBe(false);
    expect(race.raceCdp).toHaveBeenCalled();
  });

  it('does not fill, submit or synthesize input on a readonly target', async () => {
    guard = { ...guard, reason: 'readonly', error: 'Target is readonly' };
    const result = await performPhysicalFill({ tabId: 42, target: 1, text: 'replacement' });
    expect(result).toMatchObject({
      success: false,
      committed: false,
      filledText: '',
      isTrusted: false,
    });
    expect(result.error).toContain('readonly');
    expect(race.raceCdp).not.toHaveBeenCalled();
    expect(page.mock.calls.some((call) => /FillIndex|Synthetic|Focus/.test(String(call[1])))).toBe(
      false,
    );
  });
});
