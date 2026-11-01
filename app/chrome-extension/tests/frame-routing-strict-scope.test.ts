import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTargetLocation as baseResolveTargetLocation } from '../utils/unified-locator';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import * as locator from '../entrypoints/background/tools/browser/unified-locator';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import { clickTool, fillTool } from '../entrypoints/background/tools/browser/interaction';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import * as frameCoordinates from '../utils/frame-coordinates';
import * as deltaHelper from '../utils/delta-helper';
import * as race from '../utils/race-cdp';
import { inPageSnapCoordinate } from '../entrypoints/background/tools/browser/dom-indexer';

const tab = { id: 42, url: 'https://example.test/frame-routing' };

function installChrome(): void {
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn(async () => [{ result: { success: true } }]) },
    debugger: {
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      sendCommand: vi.fn(async () => ({})),
    },
  });
}

describe('explicit frame routing', () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['ref', { ref: 7 }],
    ['selector', { selector: '#target' }],
    ['text', { text: 'Submit' }],
  ])('keeps %s resolution inside the explicit frame', async (_name, target) => {
    const executeInPage = vi.fn(async (scope: any) => [
      {
        frameId: 71,
        result: {
          success: true,
          x: 30,
          y: 40,
          width: 80,
          height: 24,
          tagName: 'button',
          scope: scope.frameIds?.[0],
        },
      },
    ]);

    const result = await baseResolveTargetLocation(
      9,
      { ...target, frameId: 71 },
      { executeInPage: executeInPage as any },
    );

    expect(result.success).toBe(true);
    expect(result.frameId).toBe(71);
    expect(executeInPage).toHaveBeenCalled();
    for (const [scope] of executeInPage.mock.calls) {
      expect(scope).toEqual({ tabId: 9, frameIds: [71] });
      expect(scope.allFrames).toBeUndefined();
    }
  });

  it('does not fall back to another frame when the explicit frame has no match', async () => {
    const executeInPage = vi.fn(async (scope: any) => {
      if (scope.allFrames) {
        return [
          {
            frameId: 0,
            result: { success: true, x: 10, y: 20, width: 30, height: 20 },
          },
        ];
      }
      return [{ frameId: 71, result: { success: false, notFound: true } }];
    });

    const result = await baseResolveTargetLocation(
      9,
      { selector: '#missing', frameId: 71 },
      { executeInPage: executeInPage as any },
    );

    expect(result.success).toBe(false);
    expect(executeInPage.mock.calls.every(([scope]) => !scope.allFrames)).toBe(true);
    expect(executeInPage.mock.calls.every(([scope]) => scope.frameIds?.[0] === 71)).toBe(true);
  });

  it('treats frameId 0 as an explicit main-frame scope', async () => {
    const executeInPage = vi.fn(async () => [
      {
        frameId: 0,
        result: { success: true, x: 10, y: 20, width: 30, height: 20 },
      },
    ]);

    await baseResolveTargetLocation(
      9,
      { selector: '#main-only', frameId: 0 },
      { executeInPage: executeInPage as any },
    );

    expect(executeInPage).toHaveBeenCalledWith(
      { tabId: 9, frameIds: [0] },
      'inPageLocateBySelector',
      ['#main-only', undefined],
    );
  });

  it('does not search other frames for an explicit numeric interact target', async () => {
    vi.spyOn(interactIndexTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    const executeInPage = vi
      .spyOn(engine, 'executeInPage')
      .mockImplementation(async (scope: any, fnName: string) => {
        if (fnName === 'inPageWaitForActionable') {
          return [
            {
              frameId: scope.frameIds?.[0] ?? 0,
              result: { success: false, notFound: true, error: 'not found in requested frame' },
            },
          ] as any;
        }
        return [] as any;
      });

    const result = await interactIndexTool.execute({
      tabId: tab.id,
      frameId: 71,
      index: 5,
      action: 'click',
      includeDelta: false,
      skipLock: true,
    });

    expect(result.isError).toBe(true);
    const actionLookups = executeInPage.mock.calls.filter(
      ([, fnName]) => fnName === 'inPageWaitForActionable',
    );
    expect(actionLookups.length).toBeGreaterThan(0);
    expect(actionLookups.every(([scope]) => !scope.allFrames)).toBe(true);
    expect(actionLookups.every(([scope]) => scope.frameIds?.[0] === 71)).toBe(true);
  });

  it('does not search other frames for an explicit numeric fill target', async () => {
    const executeInPage = vi
      .spyOn(engine, 'executeInPage')
      .mockImplementation(async (scope: any, fnName: string) => {
        if (fnName === 'inPageGetElementCoordinates') {
          return [
            {
              frameId: scope.frameIds?.[0] ?? 0,
              result: { success: false, notFound: true, error: 'not found in requested frame' },
            },
          ] as any;
        }
        return [] as any;
      });

    const result = await fillCore.performPhysicalFill({
      tabId: tab.id,
      frameId: 71,
      target: 5,
      text: 'value',
    });

    expect(result.success).toBe(false);
    const lookups = executeInPage.mock.calls.filter(
      ([, fnName]) => fnName === 'inPageGetElementCoordinates',
    );
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every(([scope]) => !scope.allFrames)).toBe(true);
    expect(lookups.every(([scope]) => scope.frameIds?.[0] === 71)).toBe(true);
  });

  it('forwards frameId through fill-index into the physical fill core', async () => {
    vi.spyOn(fillIndexTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([{ result: null }] as any);
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'value',
      isTrusted: true,
      method: 'cdp_native',
      receipt: { hasReceipt: false },
    } as any);

    const result = await fillIndexTool.execute({
      tabId: tab.id,
      frameId: 71,
      index: 5,
      text: 'value',
      includeDelta: false,
    });

    expect(result.isError).toBe(false);
    expect(fill).toHaveBeenCalledWith(expect.objectContaining({ tabId: tab.id, frameId: 71 }));
  });

  it('captures the default chained snapshot exactly once in interact-index', async () => {
    vi.spyOn(interactIndexTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_scope: any, fnName: string) => {
      if (fnName === 'inPageWaitForActionable') {
        return [
          {
            frameId: 0,
            result: { success: true, x: 100, y: 200, tagName: 'button', width: 80, height: 30 },
          },
        ] as any;
      }
      if (fnName === 'inPageCheckOcclusion') return [{ result: { x: 100, y: 200 } }] as any;
      if (fnName === 'inPageGetScrollState') {
        return [
          {
            result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 },
          },
        ] as any;
      }
      if (fnName === 'inPageReadDeliveryProbe') {
        return [{ result: { delivered: true, hits: [{ type: 'click' }] } }] as any;
      }
      if (fnName === 'inPageCheckInterception') {
        return [{ result: { intercepted: false } }] as any;
      }
      return [{ result: null }] as any;
    });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _tag, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});
    vi.spyOn(race, 'raceCdp').mockResolvedValue({});
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);
    const baseline = vi.spyOn(deltaHelper, 'ensureSnapshotBaseline').mockResolvedValue(undefined);
    const summary = { activeElement: { tagName: 'button' } };
    const delta = { isDelta: true, elements: [] };
    const capture = vi
      .spyOn(deltaHelper, 'captureChainedSnapshot')
      .mockResolvedValue({ summary, delta } as any);

    const result = await interactIndexTool.execute({
      tabId: tab.id,
      index: 5,
      action: 'click',
      skipLock: true,
    });

    expect(result.isError).toBe(false);
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(baseline).toHaveBeenCalledWith(tab.id, true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(tab.id, tab.url, { maxItems: 10, delayMs: 80 });
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.chainedSnapshot).toEqual(summary);
    expect(payload.delta).toBeUndefined();
  });

  it('captures the default chained snapshot exactly once in fill-index', async () => {
    vi.spyOn(fillIndexTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([{ result: null }] as any);
    vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'value',
      isTrusted: true,
      method: 'cdp_native',
    });
    const baseline = vi.spyOn(deltaHelper, 'ensureSnapshotBaseline').mockResolvedValue(undefined);
    const summary = { activeElement: { tagName: 'input' } };
    const delta = { isDelta: true, elements: [] };
    const capture = vi
      .spyOn(deltaHelper, 'captureChainedSnapshot')
      .mockResolvedValue({ summary, delta } as any);

    const result = await fillIndexTool.execute({
      tabId: tab.id,
      index: 5,
      text: 'value',
    });

    expect(result.isError).toBe(false);
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(baseline).toHaveBeenCalledWith(tab.id, true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(tab.id, tab.url, { maxItems: 10, delayMs: 80 });
    const payload = JSON.parse((result.content[0] as any).text);
    expect(payload.chainedSnapshot).toEqual(summary);
    expect(payload.delta).toBeUndefined();
  });

  it('delegates legacy XPath clicks to interact-index with frame and pointer options', async () => {
    vi.spyOn(clickTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    const sendMessage = vi
      .spyOn(clickTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, ref: 'ref_1' });
    vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 30,
      y: 40,
      index: 5,
      frameId: 71,
      resolutionPath: 'ref',
      tagName: 'button',
    } as any);
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _tag, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);
    const interact = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    });

    const result = await clickTool.execute({
      tabId: tab.id,
      frameId: 71,
      selector: '//button',
      selectorType: 'xpath',
      button: 'middle',
      modifiers: { shiftKey: true },
    });

    expect(result.isError).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      tab.id,
      expect.objectContaining({ selector: '//button', isXPath: true }),
      71,
    );
    expect(interact).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: tab.id,
        frameId: 71,
        index: 5,
        action: 'click',
        button: 'middle',
        modifiers: ['Shift'],
      }),
      undefined,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('preserves legacy double-click semantics through interact-index', async () => {
    vi.spyOn(clickTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 30,
      y: 40,
      index: 5,
      frameId: 71,
      resolutionPath: 'ref',
    } as any);
    const interact = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    });

    const result = await clickTool.execute({
      tabId: tab.id,
      frameId: 71,
      index: 5,
      double: true,
    });

    expect(result.isError).toBe(false);
    expect(interact).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: 71,
        index: 5,
        action: 'double_click',
      }),
      undefined,
    );
  });

  it('delegates legacy fills to the physical fill core and preserves the resolved frame', async () => {
    vi.spyOn(fillTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    const sendMessage = vi
      .spyOn(fillTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, ref: 'ref_1' });
    vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 30,
      y: 40,
      index: 5,
      frameId: 71,
      resolutionPath: 'ref',
      tagName: 'input',
    } as any);
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _tag, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'value',
      isTrusted: true,
      method: 'cdp_native',
    });

    const result = await fillTool.execute({
      tabId: tab.id,
      frameId: 71,
      selector: '//input',
      selectorType: 'xpath',
      value: 'value',
    });

    expect(result.isError).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      tab.id,
      expect.objectContaining({ selector: '//input', isXPath: true }),
      71,
    );
    expect(fill).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: tab.id,
        frameId: 71,
        target: 5,
        text: 'value',
      }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps coordinate-only legacy fill on the physical fill executor', async () => {
    vi.spyOn(fillTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 30,
      y: 40,
      frameId: 0,
      resolutionPath: 'coordinate',
    } as any);
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'value',
      isTrusted: true,
      method: 'cdp_native',
    });

    const result = await fillTool.execute({
      tabId: tab.id,
      coordinate: { x: 30, y: 40 },
      value: 'value',
    });

    expect(result.isError).toBe(false);
    expect(fill).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: tab.id,
        target: '',
        coordinate: { x: 30, y: 40 },
      }),
    );
  });

  it('hit-tests coordinate-only fill to an editable frame index before actionability', async () => {
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (scope: any, fnName: string) => {
      if (fnName === 'inPageSnapCoordinate') {
        return [
          {
            frameId: 71,
            result: {
              snapped: false,
              targetIndex: 9,
              targetTag: 'input',
              targetEditable: true,
            },
          },
        ] as any;
      }
      if (fnName === 'inPageGetElementCoordinates') {
        return [
          {
            frameId: scope.frameIds?.[0] ?? 0,
            result: {
              success: true,
              x: 140,
              y: 90,
              tagName: 'input',
              inputType: 'text',
              value: '',
            },
          },
        ] as any;
      }
      if (fnName === 'inPageWaitForActionable') {
        return [
          {
            frameId: 71,
            result: {
              success: false,
              notFound: false,
              actionable: false,
              reason: 'readonly',
              error: 'Target is readonly',
            },
          },
        ] as any;
      }
      return [] as any;
    });
    const withSession = vi.spyOn(cdpSessionManager, 'withSession');

    const result = await fillCore.performPhysicalFill({
      tabId: tab.id,
      target: '',
      coordinate: { x: 200, y: 150 },
      text: 'blocked',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('readonly');
    const snapCall = vi
      .mocked(engine.executeInPage)
      .mock.calls.find(([, fnName]) => fnName === 'inPageSnapCoordinate');
    expect(snapCall?.[0]).toEqual({ tabId: tab.id, allFrames: true });
    expect(snapCall?.[2]).toEqual([200, 150, 0, true, true]);
    const guardCall = vi
      .mocked(engine.executeInPage)
      .mock.calls.find(([, fnName]) => fnName === 'inPageWaitForActionable');
    expect(guardCall?.[0]).toEqual({ tabId: tab.id, frameIds: [71] });
    expect(guardCall?.[2]).toEqual([9, 'fill']);
    expect(withSession).not.toHaveBeenCalled();
  });

  it('existing deep hit-test resolves direct editable elements', () => {
    document.body.innerHTML = '<input id="coordinate-target" />';
    const input = document.getElementById('coordinate-target') as HTMLInputElement;
    input.getBoundingClientRect = () =>
      ({ left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }) as DOMRect;
    document.elementFromPoint = vi.fn(() => input);

    const hit = inPageSnapCoordinate(20, 30, 0, false, true);

    expect(hit.targetEditable).toBe(true);
    expect(hit.targetIndex).toBeGreaterThan(0);
  });

  it('returns an uncertain delegated click without replaying another physical dispatch', async () => {
    vi.spyOn(clickTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 30,
      y: 40,
      index: 5,
      frameId: 71,
      resolutionPath: 'ref',
    } as any);
    const sendMessage = vi.spyOn(clickTool as any, 'sendMessageToTab');
    const sendCommand = vi.spyOn(cdpSessionManager, 'sendCommand');
    const uncertain = {
      content: [{ type: 'text' as const, text: 'CDP_DISPATCH_TIMEOUT: outcome unknown' }],
      isError: true,
    };
    const interact = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue(uncertain);

    const result = await clickTool.execute({
      tabId: tab.id,
      frameId: 71,
      index: 5,
      button: 'left',
    });

    expect(result).toBe(uncertain);
    expect(interact).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('keeps an explicit drag endpoint inside the requested frame', async () => {
    vi.spyOn(interactIndexTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
    vi.spyOn(frameCoordinates, 'projectFramePoint').mockResolvedValue({ x: 140, y: 130 });
    const executeInPage = vi
      .spyOn(engine, 'executeInPage')
      .mockImplementation(async (scope: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageWaitForActionable') {
          if (scope.frameIds?.[0] === 71) {
            return [
              {
                frameId: 71,
                result: { success: true, x: 40, y: 30, tagName: 'div', width: 50, height: 20 },
              },
            ] as any;
          }
          return [
            {
              frameId: 99,
              result: { success: true, x: 400, y: 300, tagName: 'div', width: 50, height: 20 },
            },
          ] as any;
        }
        if (fnName === 'inPageGetElementCoordinates') {
          return [
            {
              frameId: scope.frameIds?.[0] ?? 0,
              result: { success: false, notFound: true, error: 'endpoint not in frame' },
            },
          ] as any;
        }
        if (fnName === 'inPageGetScrollState') {
          return [
            {
              result: { scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 },
            },
          ] as any;
        }
        if (fnName === 'inPageCheckOcclusion') {
          return [{ result: { x: 40, y: 30 } }] as any;
        }
        if (args?.[0] === 2) {
          return [{ frameId: scope.frameIds?.[0] ?? 0, result: { success: false } }] as any;
        }
        return [{ result: null }] as any;
      });

    const result = await interactIndexTool.execute({
      tabId: tab.id,
      frameId: 71,
      index: 1,
      action: 'drag',
      end: { index: 2 },
      includeDelta: false,
      skipLock: true,
    });

    expect(result.isError).toBe(true);
    expect(executeInPage.mock.calls.every(([scope]) => !scope.allFrames)).toBe(true);
    const endpointLookups = executeInPage.mock.calls.filter(
      ([, fnName, args]) => fnName === 'inPageGetElementCoordinates' && args?.[0] === 2,
    );
    expect(endpointLookups).toHaveLength(1);
    expect(endpointLookups[0][0]).toEqual({ tabId: tab.id, frameIds: [71] });
  });
});
