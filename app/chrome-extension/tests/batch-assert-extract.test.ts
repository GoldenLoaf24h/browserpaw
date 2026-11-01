import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BatchActionItem, BatchActionResult } from 'chrome-mcp-shared';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as raceCdpModule from '../utils/race-cdp';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import { CdpDispatchTimeoutError } from '../utils/race-cdp';

describe('Batch Actions Assert & Extract Pipeline', () => {
  it('supports declaring assert and extract actions in BatchActionItem', () => {
    const assertAction: BatchActionItem = {
      type: 'assert',
      index: 1,
      expectedText: 'Success',
      condition: 'contains',
      abortOnFailure: true,
    };

    const extractAction: BatchActionItem = {
      type: 'extract',
      index: 2,
      property: 'text',
      variableName: 'orderId',
    };

    expect(assertAction.type).toBe('assert');
    expect(assertAction.expectedText).toBe('Success');
    expect(extractAction.type).toBe('extract');
    expect(extractAction.variableName).toBe('orderId');

    const doubleClickAction: BatchActionItem = {
      type: 'double_click',
      index: 5,
    };
    const rightClickAction: BatchActionItem = {
      type: 'right_click',
      index: 6,
    };
    expect(doubleClickAction.type).toBe('double_click');
    expect(rightClickAction.type).toBe('right_click');
  });

  it('verifies BatchActionResult includes extractedData and assertions', () => {
    const res: BatchActionResult = {
      success: true,
      completedActions: 2,
      totalActions: 2,
      extractedData: { orderId: 'ORD-12345' },
      assertions: [{ actionIndex: 0, passed: true, condition: 'contains' }],
      results: [
        { actionIndex: 0, success: true },
        { actionIndex: 1, success: true },
      ],
    };

    expect(res.extractedData?.orderId).toBe('ORD-12345');
    expect(res.assertions?.[0].passed).toBe(true);
  });

  it('executes assert and extract pipeline on batchActionsTool', async () => {
    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/app',
    });
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/app' }),
      },
    };
    (batchActionsTool as any).safeExecuteScript = vi
      .fn()
      .mockResolvedValueOnce([
        { result: { found: true, visible: true, text: 'Order #999', value: '' } },
      ])
      .mockResolvedValueOnce([{ result: 'Order #999' }]);

    const res = await batchActionsTool.execute({
      tabId: 1,
      actions: [
        {
          type: 'assert',
          selector: '#order-status',
          expectedText: 'Order #999',
          condition: 'equals',
        },
        {
          type: 'extract',
          selector: '#order-status',
          property: 'text',
          variableName: 'confirmedOrder',
        },
      ],
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.completedActions).toBe(2);
    expect(parsed.extractedData?.confirmedOrder).toBe('Order #999');
    expect(parsed.assertions?.[0].passed).toBe(true);
  });
});

describe('batch-actions click delivery safety & honest isTrusted reporting', () => {
  const tabId = 1;
  let dispatchedEvents: Array<{ type: string; x: number; y: number }>;
  let syntheticClicks: number;
  let interceptionResult: any = null;
  let rightClickError: Error | null;

  beforeEach(() => {
    vi.restoreAllMocks();
    dispatchedEvents = [];
    syntheticClicks = 0;
    interceptionResult = null;
    rightClickError = null;

    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, url: 'https://example.com/app', active: true })),
        query: vi.fn(async () => [{ id: tabId, url: 'https://example.com/app', active: true }]),
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: undefined }]),
      },
    };

    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: tabId,
      url: 'https://example.com/app',
    });

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) => {
      return fn({} as any);
    });
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);

    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);

    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent') {
        dispatchedEvents.push({ type: params.type, x: params.x, y: params.y });
      }
      return {} as any;
    });

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetElementCoordinates') {
          return [
            { result: { success: true, x: 200, y: 300, tagName: 'button', text: 'Batch Button' } },
          ] as any;
        }
        if (fnName === 'inPageCheckOcclusion') {
          return [{ result: { x: 200, y: 300 } }] as any;
        }
        if (fnName === 'inPageCheckInterception') {
          return [{ result: interceptionResult }] as any;
        }
        if (fnName === 'inPageDispatchSyntheticClick') {
          syntheticClicks++;
          return [{ result: true }] as any;
        }
        if (fnName === 'inPageInteractIndex') {
          if (rightClickError) throw rightClickError;
          syntheticClicks++;
          return [{ result: { success: true } }] as any;
        }
        return [{ result: { success: true } }] as any;
      },
    );
  });

  it('batch click with maskPierced: does NOT dispatch synthetic click after CDP press/release, reports isTrusted=true and piercedOverlay', async () => {
    interceptionResult = {
      intercepted: true,
      canPierce: true,
      description: 'promo-toast-banner',
      pierceReason: 'transient_mask',
    };

    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'click', index: 1 }],
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    const step0 = parsed.results[0].output;

    // CDP mouse press was dispatched
    expect(dispatchedEvents.filter((e) => e.type === 'mousePressed')).toHaveLength(1);
    // Bug assertion: MUST NOT replay synthetic click after native press/release
    expect(syntheticClicks).toBe(0);
    // CDP was physically used, so isTrusted must be true (not falsified to false)
    expect(step0.isTrusted).toBe(true);
    expect(step0.piercedOverlay).toBeDefined();
    expect(step0.piercedOverlay.description).toBe('promo-toast-banner');
  });

  it('batch right_click: reports isTrusted=false honestly (synthetic delivery)', async () => {
    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'right_click', index: 1 }],
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    const step0 = parsed.results[0].output;
    expect(step0.isTrusted).toBe(false);
  });

  it('batch right_click: a failed synthetic dispatch is not reported as success', async () => {
    rightClickError = new Error('right click dispatch failed');
    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'right_click', index: 1 }],
    });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.results[0].success).toBe(false);
    expect(parsed.results[0].error).toContain('right click dispatch failed');
  });

  it('batch click normal (happy path): reports isTrusted=true with zero synthetic clicks', async () => {
    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'click', index: 1 }],
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    const step0 = parsed.results[0].output;
    expect(step0.isTrusted).toBe(true);
    expect(syntheticClicks).toBe(0);
    expect(agentCursor.animateAgentCursor).toHaveBeenCalledWith(
      tabId,
      200,
      300,
      expect.objectContaining({ actionNote: 'Clicking button "Batch Button"' }),
    );
  });

  it('batch click with CDP uncertain outcome: fails closed, does NOT replay synthetic click', async () => {
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        throw new CdpDispatchTimeoutError('Input.dispatchMouseEvent');
      }
      return {} as any;
    });

    const res = await batchActionsTool.execute({
      tabId,
      actions: [{ type: 'click', index: 1 }],
    });

    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(syntheticClicks).toBe(0);
  });
});

describe('batch scroll/assert/extract index parsing & explicit invalid rejection', () => {
  const tabId = 1;
  let recordedCalls: Array<{ fnName: string; args: any[] }>;

  beforeEach(() => {
    vi.restoreAllMocks();
    recordedCalls = [];

    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, url: 'https://example.com/app', active: true })),
      },
    };

    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: tabId,
      url: 'https://example.com/app',
    });

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string, args?: any[]) => {
        recordedCalls.push({ fnName, args: args || [] });
        if (fnName === 'inPageScrollToIndex') {
          return [{ result: true }] as any;
        }
        if (fnName === 'inPageGetElementCoordinates') {
          return [{ result: { success: true, text: 'Expected Text', value: 'Captured' } }] as any;
        }
        return [{ result: true }] as any;
      },
    );
  });

  it('parses numeric, eN, ref_N and safe integer indices for scroll, assert, extract', async () => {
    const bigSafe = 9007199254740991;
    const res = await batchActionsTool.execute({
      tabId,
      actions: [
        { type: 'scroll', ref: 'e42' },
        { type: 'assert', ref: 'ref_99', condition: 'contains', expectedText: 'Expected' },
        { type: 'extract', ref: 'ref_' + String(bigSafe), property: 'text', variableName: 'out' },
      ],
    });

    expect(res.isError).toBe(false);
    const scrollCall = recordedCalls.find((c) => c.fnName === 'inPageScrollToIndex');
    expect(scrollCall?.args[0]).toBe(42);

    const coordCalls = recordedCalls.filter((c) => c.fnName === 'inPageGetElementCoordinates');
    expect(coordCalls[0]?.args[0]).toBe(99);
    expect(coordCalls[1]?.args[0]).toBe(bigSafe);
  });

  it('explicitly rejects invalid index or ref formats on scroll, assert, and extract', async () => {
    for (const badRef of ['invalid_format', -1, 'e0', 'ref_abc']) {
      const scrollRes = await batchActionsTool.execute({
        tabId,
        actions: [{ type: 'scroll', ref: badRef as any }],
      });
      expect(JSON.parse((scrollRes.content[0] as any).text).success).toBe(false);

      const assertRes = await batchActionsTool.execute({
        tabId,
        actions: [{ type: 'assert', ref: badRef as any, expectedText: 'x' }],
      });
      expect(JSON.parse((assertRes.content[0] as any).text).success).toBe(false);

      const extractRes = await batchActionsTool.execute({
        tabId,
        actions: [{ type: 'extract', ref: badRef as any, variableName: 'v' }],
      });
      expect(JSON.parse((extractRes.content[0] as any).text).success).toBe(false);

      const bigUnsafe = 9007199254740992;
      const unsafeScroll = await batchActionsTool.execute({
        tabId,
        actions: [{ type: 'scroll', ref: ('e' + String(bigUnsafe)) as any }],
      });
      expect(JSON.parse((unsafeScroll.content[0] as any).text).success).toBe(false);
    }
  });
});
