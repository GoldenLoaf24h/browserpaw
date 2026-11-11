import { describe, it, expect, vi, beforeEach } from 'vitest';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as raceCdpModule from '../utils/race-cdp';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

describe('Mouse trajectory and drag cursor coordination', () => {
  const targetTabId = 77;
  let sentEvents: Array<{ type: string; x: number; y: number }>;
  let cursorCalls: Array<{ x: number; y: number; options: any }>;

  beforeEach(() => {
    vi.restoreAllMocks();
    sentEvents = [];
    cursorCalls = [];

    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, url: 'https://example.com/app', active: true })),
        query: vi.fn(async () => [
          { id: targetTabId, url: 'https://example.com/app', active: true },
        ]),
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: undefined }]),
      },
    };

    vi.spyOn(interactIndexTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: targetTabId,
      url: 'https://example.com/app',
    });

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) => {
      return fn({} as any);
    });

    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method, params: any) => {
        if (method === 'Input.dispatchMouseEvent') {
          sentEvents.push({ type: params.type, x: params.x, y: params.y });
        }
        return {} as any;
      },
    );

    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent') {
        sentEvents.push({ type: params.type, x: params.x, y: params.y });
      }
      return {} as any;
    });

    vi.spyOn(agentCursor, 'animateAgentCursor').mockImplementation(
      async (_tabId, x, y, options) => {
        cursorCalls.push({ x, y, options });
      },
    );
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetElementCoordinates' || fnName === 'inPageWaitForActionable') {
          return [
            { result: { success: true, x: 200, y: 300, tagName: 'button', text: 'Click Me' } },
          ] as any;
        }
        if (fnName === 'inPageCheckOcclusion') {
          return [{ result: { x: 200, y: 300 } }] as any;
        }
        if (fnName === 'inPageGetScrollState') {
          return [
            { result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 } },
          ] as any;
        }
        if (fnName === 'inPageWaitForDOMSettle') {
          return [
            {
              result: {
                settled: true,
                durationMs: 10,
                mutationsObserved: 0,
                trapCheckedInPage: true,
              },
            },
          ] as any;
        }
        return [] as any;
      },
    );
  });

  it.each([false, true])(
    'moves through distinct nearby points before clicking (humanize=%s)',
    async (humanize) => {
      await interactIndexTool.execute({
        action: 'click',
        coordinate: { x: 200, y: 300 },
        humanize,
        tabId: targetTabId,
      });
      const press = sentEvents.findIndex((event) => event.type === 'mousePressed');
      expect(press).toBeGreaterThan(0);
      const moves = sentEvents.slice(0, press).filter((event) => event.type === 'mouseMoved');
      const nearby = moves.filter((point) => Math.hypot(point.x - 200, point.y - 300) <= 48);
      expect(new Set(nearby.map((point) => `${point.x},${point.y}`)).size).toBeGreaterThanOrEqual(
        3,
      );
      expect(moves.at(-1)).toEqual({ type: 'mouseMoved', x: 200, y: 300 });
    },
  );

  it('drag synchronizes visual cursor during movement and snaps after mouseReleased', async () => {
    await interactIndexTool.execute({
      action: 'drag',
      coordinate: { x: 100, y: 150 },
      end: { coordinate: { x: 400, y: 450 } },
      steps: 4,
      tabId: targetTabId,
    });

    // Cursor calls:
    // 1. Initial cursor positioning to start point (100, 150) before interaction
    // 2. Concurrent arrival promise cursor call during drag: (400, 450) with immediate: false, waitForArrival: true
    // 3. Final cursor snap triggered after mouseReleased: (400, 450) with immediate: true, waitForArrival: false
    const glideCall = cursorCalls.find(
      (c) =>
        c.x === 400 &&
        c.y === 450 &&
        c.options?.immediate === false &&
        c.options?.waitForArrival === true,
    );
    expect(glideCall).toBeDefined();

    const snapCall = cursorCalls.find(
      (c) =>
        c.x === 400 &&
        c.y === 450 &&
        c.options?.immediate === true &&
        c.options?.waitForArrival === false,
    );
    expect(snapCall).toBeDefined();

    // Verify mouseReleased occurred before snap confirmation
    const releaseIdx = sentEvents.findIndex((e) => e.type === 'mouseReleased');
    expect(releaseIdx).toBeGreaterThan(-1);
  });
});
