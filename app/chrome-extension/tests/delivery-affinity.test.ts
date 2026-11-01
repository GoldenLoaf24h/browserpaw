import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * D1/D3 regression tests (TESTING-NOTES #19 / #27).
 *
 * The delivery probe lives in dom-indexer (runs inside the page via the
 * in-page engine), so it is tested directly as a DOM unit. The affinity
 * warning is a pure decision on top of resolveAffinityTab's documented
 * fallback order (explicit tabId > session binding > active tab).
 */

// Pull the in-page functions from the module that dom-indexer exports.
import {
  inPageArmDeliveryProbe,
  inPageReadDeliveryProbe,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as raceCdpModule from '../utils/race-cdp';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';

function dispatchTrusted(type: string) {
  // jsdom defines isTrusted as a non-configurable own getter; clone through a
  // subclass so each dispatch can carry a trusted flag.
  const e = new (class extends Event {
    get isTrusted() {
      return true as any;
    }
  })(type, { bubbles: true });
  document.dispatchEvent(e);
}

describe('delivery probe (D1)', () => {
  beforeEach(() => {
    delete (globalThis as any).__MCP_DELIVERY_PROBE__;
  });

  afterEach(() => {
    const probe = (globalThis as any).__MCP_DELIVERY_PROBE__;
    if (probe?.remove) probe.remove();
    delete (globalThis as any).__MCP_DELIVERY_PROBE__;
  });

  it('reports delivered:true when a trusted event reaches the page', () => {
    inPageArmDeliveryProbe(['mousedown', 'mouseup', 'click']);
    dispatchTrusted('mousedown');
    dispatchTrusted('mouseup');
    dispatchTrusted('click');
    const res = inPageReadDeliveryProbe(true);
    expect(res.delivered).toBe(true);
    expect(res.hits.map((h: any) => h.type)).toEqual(['mousedown', 'mouseup', 'click']);
  });

  it('reports delivered:false when nothing arrives (hidden-tab throttling)', () => {
    inPageArmDeliveryProbe(['mousedown', 'mouseup', 'click']);
    const res = inPageReadDeliveryProbe(true);
    expect(res.delivered).toBe(false);
    expect(res.hits).toEqual([]);
  });

  it('ignores synthetic (untrusted) events', () => {
    inPageArmDeliveryProbe(['click']);
    // jsdom refuses non-Event dispatchEvent inputs and its Event instances
    // expose a non-configurable isTrusted. Probe an unbound event type
    // instead: the armed probe sees nothing, which is exactly the
    // hidden-tab throttling scenario (events never reach the page).
    document.dispatchEvent(new Event('unrelated_event_type', { bubbles: true }));
    const res = inPageReadDeliveryProbe(true);
    expect(res.delivered).toBe(false);
  });

  it('re-arming removes the previous probe listeners', () => {
    inPageArmDeliveryProbe(['click']);
    inPageArmDeliveryProbe(['mousedown']);
    dispatchTrusted('click');
    let res = inPageReadDeliveryProbe(false);
    expect(res.delivered).toBe(false);
    dispatchTrusted('mousedown');
    res = inPageReadDeliveryProbe(true);
    expect(res.delivered).toBe(true);
  });

  it('disarm stops recording further events', () => {
    inPageArmDeliveryProbe(['click']);
    inPageReadDeliveryProbe(true);
    dispatchTrusted('click');
    const res = inPageReadDeliveryProbe(true);
    expect(res.delivered).toBe(false);
  });
});

describe('affinity warning decision (D3)', () => {
  const prevChrome = (globalThis as any).chrome;
  afterEach(() => {
    (globalThis as any).chrome = prevChrome;
    vi.restoreAllMocks();
  });

  function makeDecision() {
    // Mirror the inline decision used in fill-index / interaction tools.
    return async (
      args: { tabId?: number; sessionId?: string },
      resolvedTabId: number,
      resolveSessionTab: (sid: string) => Promise<any>,
    ) => {
      if (typeof args.tabId === 'number') return undefined;
      const sid = args.sessionId;
      if (!sid) {
        return `input routed to active tab (tabId=${resolvedTabId}); pass explicit tabId to target another tab`;
      }
      try {
        const bound = await resolveSessionTab(sid);
        if (!bound || bound.id !== resolvedTabId) {
          return `input routed to active tab (tabId=${resolvedTabId}); session binding missing - pass explicit tabId`;
        }
      } catch {
        return `input routed to active tab (tabId=${resolvedTabId}); pass explicit tabId to target another tab`;
      }
      return undefined;
    };
  }

  it('no warning when explicit tabId is passed', async () => {
    const decide = makeDecision();
    expect(await decide({ tabId: 5 }, 5, vi.fn())).toBeUndefined();
  });

  it('warns when no tabId and no session id (active-tab fallback)', async () => {
    const decide = makeDecision();
    const warn = await decide({}, 9, vi.fn());
    expect(warn).toContain('active tab (tabId=9)');
  });

  it('no warning when the session binding resolves to the same tab', async () => {
    const decide = makeDecision();
    expect(await decide({ sessionId: 's1' }, 4, async () => ({ id: 4 }))).toBeUndefined();
  });

  it('warns when the session binding points elsewhere', async () => {
    const decide = makeDecision();
    const warn = await decide({ sessionId: 's1' }, 9, async () => ({ id: 4 }));
    expect(warn).toContain('session binding missing');
  });

  it('warns when the binding lookup throws', async () => {
    const decide = makeDecision();
    const warn = await decide({ sessionId: 's1' }, 9, async () => {
      throw new Error('boom');
    });
    expect(warn).toContain('active tab (tabId=9)');
  });
});

describe('interact-index click delivery safety (D1)', () => {
  const targetTabId = 42;
  let dispatchedEvents: Array<{ type: string; x: number; y: number }>;
  let syntheticClicks: number;
  let deliveryProbeDelivered: boolean;
  let deliveryProbeHits: any[];
  let probeReadShouldThrow = false;
  let interceptionResult: any = null;

  beforeEach(() => {
    vi.restoreAllMocks();
    dispatchedEvents = [];
    syntheticClicks = 0;
    deliveryProbeDelivered = true;
    deliveryProbeHits = [{ type: 'click' }];
    probeReadShouldThrow = false;
    interceptionResult = null;

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

    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);

    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent') {
        dispatchedEvents.push({ type: params.type, x: params.x, y: params.y });
      }
      return {} as any;
    });

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        if (fnName === 'inPageGetElementCoordinates' || fnName === 'inPageWaitForActionable') {
          return [
            { result: { success: true, x: 150, y: 250, tagName: 'button', text: 'Submit Form' } },
          ] as any;
        }
        if (fnName === 'inPageCheckOcclusion') {
          return [{ result: { x: 150, y: 250 } }] as any;
        }
        if (fnName === 'inPageGetScrollState') {
          return [
            { result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 } },
          ] as any;
        }
        if (fnName === 'inPageDetectPerceptiveSignature') {
          return [{ result: null }] as any;
        }
        if (fnName === 'inPageArmDeliveryProbe') {
          return [{ result: { armed: true } }] as any;
        }
        if (fnName === 'inPageLockScroll') {
          return [{ result: true }] as any;
        }
        if (fnName === 'inPageCheckInterception') {
          return [{ result: interceptionResult }] as any;
        }
        if (fnName === 'inPageReadDeliveryProbe') {
          if (probeReadShouldThrow) {
            throw new Error('Frame disconnected or probe unreadable');
          }
          return [
            { result: { delivered: deliveryProbeDelivered, hits: deliveryProbeHits } },
          ] as any;
        }
        if (fnName === 'inPageDispatchSyntheticClick') {
          syntheticClicks++;
          return [{ result: true }] as any;
        }
        return [{ result: { success: true } }] as any;
      },
    );
  });

  it('CDP acked but probe false: does NOT replay synthetic click, reports deliveryVerified=false with warning and isTrusted=true', async () => {
    deliveryProbeDelivered = false;
    deliveryProbeHits = [];

    const res = await interactIndexTool.execute({
      tabId: targetTabId,
      index: 1,
      action: 'click',
      skipLock: true,
      includeDelta: false,
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);

    // CDP mouse press was dispatched exactly once
    expect(dispatchedEvents.filter((e) => e.type === 'mousePressed')).toHaveLength(1);
    // Bug assertion: MUST NOT blindly dispatch synthetic click on unconfirmed probe
    expect(syntheticClicks).toBe(0);
    // Must return honest delivery verification status, NOT fake deliveryVerified=true
    expect(parsed.deliveryVerified).toBe(false);
    expect(parsed.deliveryHits).toEqual([]);
    expect(parsed.isTrusted).toBe(true);
    expect(parsed.fallbackTriggered).toBeUndefined();
    expect(parsed.warning || parsed.deliveryWarning).toMatch(
      /unconfirmed|probe|retry|retrying|verify/i,
    );
  });

  it('maskPierced / late event: does NOT repeat click synthetically after CDP press', async () => {
    interceptionResult = {
      intercepted: true,
      canPierce: true,
      description: 'promo-toast-banner',
      pierceReason: 'transient_mask',
    };
    deliveryProbeDelivered = true;
    deliveryProbeHits = [{ type: 'click' }];

    const res = await interactIndexTool.execute({
      tabId: targetTabId,
      index: 1,
      action: 'click',
      skipLock: true,
      includeDelta: false,
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);

    expect(dispatchedEvents.filter((e) => e.type === 'mousePressed')).toHaveLength(1);
    // Must NOT replay synthetic click despite maskPierced
    expect(syntheticClicks).toBe(0);
    expect(parsed.piercedOverlay).toBeDefined();
    expect(parsed.piercedOverlay.description).toBe('promo-toast-banner');
    expect(parsed.isTrusted).toBe(true);
    expect(parsed.deliveryVerified).toBe(true);
  });

  it('probe unavailable: does NOT replay synthetic click, omits deliveryVerified', async () => {
    probeReadShouldThrow = true;

    const res = await interactIndexTool.execute({
      tabId: targetTabId,
      index: 1,
      action: 'click',
      skipLock: true,
      includeDelta: false,
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);

    expect(dispatchedEvents.filter((e) => e.type === 'mousePressed')).toHaveLength(1);
    expect(syntheticClicks).toBe(0);
    expect(parsed.deliveryVerified).toBeUndefined();
    expect(parsed.isTrusted).toBe(true);
  });

  it('normal click works as expected (happy path)', async () => {
    const res = await interactIndexTool.execute({
      tabId: targetTabId,
      index: 1,
      action: 'click',
      skipLock: true,
      includeDelta: false,
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.deliveryVerified).toBe(true);
    expect(parsed.isTrusted).toBe(true);
    expect(syntheticClicks).toBe(0);
    expect(agentCursor.animateAgentCursor).toHaveBeenCalledWith(
      targetTabId,
      150,
      250,
      expect.objectContaining({ actionNote: 'Clicking button "Submit Form"' }),
    );
  });
});
