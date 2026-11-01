import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computerTool } from '../entrypoints/background/tools/browser/computer';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { clickTool, fillTool } from '../entrypoints/background/tools/browser/interaction';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { screenshotContextManager } from '../utils/screenshot-context';
import {
  clearScreenshotValidity,
  createScreenshotCapture,
  inPageReadScreenshotState,
  type ScreenshotPageStateProbe,
} from '../utils/screenshot-validity';
import { RAW_TOOL_SCHEMAS, TOOL_SCHEMAS } from '../../../packages/shared/src/tools';

const tabId = 6206;
const tab = {
  id: tabId,
  windowId: 1,
  active: true,
  url: 'https://example.com/page',
};

type PageState = {
  documentId: string;
  url: string;
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  domRevision: number;
};

const basePage: PageState = {
  documentId: 'doc-contract-1',
  url: tab.url,
  width: 1000,
  height: 800,
  dpr: 2,
  scrollX: 10,
  scrollY: 20,
  domRevision: 50,
};

let page: PageState;
let dispatched: Array<{ method: string; params: any }>;
let syntheticClicks: number;
let forceObserverLoss: boolean;

function probeState(): ScreenshotPageStateProbe {
  const actual = inPageReadScreenshotState();
  return {
    ...actual,
    documentId: page.documentId,
    documentURL: page.url,
    width: page.width,
    height: page.height,
    dpr: page.dpr,
    scrollX: page.scrollX,
    scrollY: page.scrollY,
    domRevision: page.domRevision,
  };
}

function seedCapture(
  contextOverrides: { screenshotWidth?: number; screenshotHeight?: number } = {},
) {
  screenshotContextManager.setContext(tabId, {
    screenshotWidth: contextOverrides.screenshotWidth ?? page.width,
    screenshotHeight: contextOverrides.screenshotHeight ?? page.height,
    viewportWidth: page.width,
    viewportHeight: page.height,
    devicePixelRatio: page.dpr,
    hostname: 'example.com',
    documentId: page.documentId,
    scrollX: page.scrollX,
    scrollY: page.scrollY,
    captureMode: 'viewport',
  });
  const state = probeState();
  const context = screenshotContextManager.getContext(tabId)!;
  return createScreenshotCapture({
    tabId,
    state,
    contextTimestamp: context.timestamp,
    domRevision: state.domRevision,
    coordinateValidationSupported: true,
  });
}

function mouseEvents(type?: string) {
  return dispatched.filter(
    (event) =>
      event.method === 'Input.dispatchMouseEvent' && (type ? event.params?.type === type : true),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  screenshotContextManager.clear(tabId);
  clearScreenshotValidity(tabId);
  page = { ...basePage };
  dispatched = [];
  syntheticClicks = 0;
  forceObserverLoss = false;
  document.body.innerHTML = '<button id="target">Target</button>';
  delete (globalThis as any).__browserpaw_dom_revision_v1__;

  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
    },
    scripting: {
      executeScript: vi.fn(async ({ func }: any) => {
        if (typeof func !== 'function') return [{ result: undefined }];
        const actual = func();
        const state = probeState();
        return [
          {
            result: {
              ...actual,
              documentId: state.documentId,
              documentURL: state.documentURL,
              width: state.width,
              height: state.height,
              dpr: state.dpr,
              scrollX: state.scrollX,
              scrollY: state.scrollY,
              domRevision: state.domRevision,
              observerInitializedNow: forceObserverLoss || actual.observerInitializedNow,
            },
          },
        ];
      }),
    },
  });

  vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(
    async (_id: number, _caller: string, fn: any) => fn({}),
  );
  vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
    async (_id: number, method: string, params: any) => {
      if (method === 'Input.dispatchMouseEvent') {
        dispatched.push({ method, params });
      }
      return {};
    },
  );

  vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
    async (_target: any, method: string, args?: any[]) => {
      if (method === 'inPageGetScrollState') {
        return [
          {
            documentId: page.documentId,
            result: {
              documentId: page.documentId,
              documentURL: page.url,
              scrollX: page.scrollX,
              scrollY: page.scrollY,
              viewportWidth: page.width,
              viewportHeight: page.height,
              docWidth: page.width,
              docHeight: 2400,
            },
          },
        ] as any;
      }
      if (method === 'inPageInstantScrollTo') {
        page.scrollX = args?.[0] ?? page.scrollX;
        page.scrollY = args?.[1] ?? page.scrollY;
        return [{ result: { success: true, scrollX: page.scrollX, scrollY: page.scrollY } }] as any;
      }
      if (method === 'inPageSnapCoordinate') {
        return [{ result: { snapped: false } }] as any;
      }
      if (method === 'inPageArmDeliveryProbe') {
        return [{ result: { armed: true } }] as any;
      }
      if (method === 'inPageReadDeliveryProbe') {
        return [{ result: { delivered: true, hits: [] } }] as any;
      }
      if (method === 'inPageDetectPerceptiveSignature') {
        return [
          {
            documentId: page.documentId,
            result: {
              url: page.url,
              title: 'Page',
              activeInputs: [],
              alerts: [],
            },
          },
        ] as any;
      }
      if (method === 'inPageDispatchSyntheticClick') {
        syntheticClicks++;
      }
      return [{ result: true, documentId: page.documentId }] as any;
    },
  );

  vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined);
  vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined);
  vi.spyOn(computerTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
  vi.spyOn(interactIndexTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
  vi.spyOn(clickTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
  vi.spyOn(fillTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
  vi.spyOn(computerTool as any, 'safeExecuteScript').mockResolvedValue({
    result: { success: true, target: { tagName: 'BUTTON' } },
  });
});

afterEach(() => {
  screenshotContextManager.clear(tabId);
  clearScreenshotValidity(tabId);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function computerClick(overrides: Record<string, any> = {}) {
  return computerTool.execute({
    action: 'left_click',
    coordinateSpace: 'screenshot',
    coordinates: { x: 100, y: 100 },
    tabId,
    autoSnap: false,
    ...overrides,
  } as any);
}

function interactClick(overrides: Record<string, any> = {}) {
  return interactIndexTool.execute({
    action: 'click',
    coordinateSpace: 'screenshot',
    coordinate: { x: 100, y: 100 },
    tabId,
    autoSnap: false,
    includeDelta: false,
    skipLock: true,
    ...overrides,
  } as any);
}

describe('Screenshot coordinate contract', () => {
  it('keeps captureId on every schema that accepts screenshot coordinates', () => {
    for (const name of [
      'chrome_computer',
      'chrome_interact_index',
      'chrome_click_element',
      'chrome_fill_or_select',
      'chrome_burst_interact',
    ]) {
      const tool = RAW_TOOL_SCHEMAS.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.inputSchema.properties?.captureId, name).toMatchObject({
        type: 'string',
      });
      expect(tool!.inputSchema.properties?.coordinateSpace?.description, name).toMatch(
        /captureId/i,
      );
    }
    expect(TOOL_SCHEMAS.some((tool) => tool.name === 'chrome_burst_interact')).toBe(false);
  });

  it('rejects computer screenshot coordinates without a captureId before dispatch', async () => {
    seedCapture();
    page.scrollY = 99;

    const result = await computerClick();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/captureId|fresh screenshot/i);
    expect(dispatched).toEqual([]);
  });

  it('rejects interact screenshot coordinates without a captureId before dispatch', async () => {
    seedCapture();
    page.scrollY = 99;

    const result = await interactClick();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/captureId|fresh screenshot/i);
    expect(dispatched).toEqual([]);
  });

  it('preserves native viewport coordinates without requiring a captureId', async () => {
    seedCapture();
    page.scrollY = 99;

    const computerResult = await computerClick({
      coordinateSpace: 'viewport',
      coordinates: { x: 40, y: 50 },
    });
    const interactResult = await interactClick({
      coordinateSpace: 'viewport',
      coordinate: { x: 60, y: 70 },
    });

    expect(computerResult.isError).toBe(false);
    expect(interactResult.isError).toBe(false);
    expect(mouseEvents('mousePressed')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ x: 40, y: 50 }) }),
      expect.objectContaining({ params: expect.objectContaining({ x: 60, y: 70 }) }),
    ]);
  });

  it('accepts an explicit captureId for screenshot coordinates in both executors', async () => {
    const capture = seedCapture();

    const computerResult = await computerClick({ captureId: capture.captureId });
    const interactResult = await interactClick({ captureId: capture.captureId });

    expect(computerResult.isError).toBe(false);
    expect(interactResult.isError).toBe(false);
    const computerPayload = JSON.parse(computerResult.content[0].text as string);
    const interactPayload = JSON.parse(interactResult.content[0].text as string);
    expect(computerPayload).toMatchObject({ captureValidated: true, captureId: capture.captureId });
    expect(interactPayload).toMatchObject({ captureValidated: true, captureId: capture.captureId });
    expect(mouseEvents('mousePressed')).toHaveLength(2);
  });

  it.each([
    ['document navigation', () => (page.documentId = 'doc-contract-2'), /document changed/i],
    ['viewport resize', () => (page.width = 1100), /viewport changed/i],
    ['DPR change', () => (page.dpr = 2.5), /device pixel ratio changed/i],
    ['scroll change', () => (page.scrollY = 21), /scroll changed/i],
    ['same-document DOM change', () => (page.domRevision += 1), /DOM changed/i],
  ])('fails closed before either executor dispatches after %s', async (_label, mutate, reason) => {
    const capture = seedCapture();
    mutate();

    const computerResult = await computerClick({ captureId: capture.captureId });
    const interactResult = await interactClick({ captureId: capture.captureId });

    expect(computerResult.isError).toBe(true);
    expect(interactResult.isError).toBe(true);
    expect(computerResult.content[0].text).toMatch(reason);
    expect(interactResult.content[0].text).toMatch(reason);
    expect(dispatched).toEqual([]);
  });

  it('rejects a superseded captureId in both executors', async () => {
    const first = seedCapture();
    seedCapture();

    const computerResult = await computerClick({ captureId: first.captureId });
    const interactResult = await interactClick({ captureId: first.captureId });

    expect(computerResult.isError).toBe(true);
    expect(interactResult.isError).toBe(true);
    expect(computerResult.content[0].text).toMatch(/not found or superseded/i);
    expect(interactResult.content[0].text).toMatch(/not found or superseded/i);
    expect(dispatched).toEqual([]);
  });

  it('rejects when the DOM observer continuity is lost before either executor dispatches', async () => {
    const capture = seedCapture();
    forceObserverLoss = true;

    const computerResult = await computerClick({ captureId: capture.captureId });
    const interactResult = await interactClick({ captureId: capture.captureId });

    expect(computerResult.isError).toBe(true);
    expect(interactResult.isError).toBe(true);
    expect(computerResult.content[0].text).toMatch(/observer continuity/i);
    expect(interactResult.content[0].text).toMatch(/observer continuity/i);
    expect(dispatched).toEqual([]);
  });

  it.each([
    ['left_click', { coordinates: { x: 100, y: 100 } }],
    ['double_click', { coordinates: { x: 100, y: 100 } }],
    ['right_click', { coordinates: { x: 100, y: 100 } }],
    ['hover', { coordinates: { x: 100, y: 100 } }],
    ['left_click_drag', { startCoordinates: { x: 100, y: 100 }, coordinates: { x: 200, y: 200 } }],
  ])('requires captureId for computer %s before dispatch', async (action, coords) => {
    seedCapture();

    const result = await computerClick({
      action,
      coordinateSpace: 'screenshot',
      ...coords,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/captureId|fresh screenshot/i);
    expect(dispatched).toEqual([]);
  });

  it.each([
    ['click', { coordinate: { x: 100, y: 100 } }],
    ['double_click', { coordinate: { x: 100, y: 100 } }],
    ['right_click', { coordinate: { x: 100, y: 100 } }],
    ['hover', { coordinate: { x: 100, y: 100 } }],
    [
      'drag',
      {
        coordinate: { x: 100, y: 100 },
        end: { coordinate: { x: 200, y: 200 } },
        steps: 2,
      },
    ],
  ])('requires captureId for interact %s before dispatch', async (action, coords) => {
    seedCapture();

    const result = await interactClick({
      action,
      coordinateSpace: 'screenshot',
      ...coords,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/captureId|fresh screenshot/i);
    expect(dispatched).toEqual([]);
  });

  it.each([
    ['left_click', { coordinates: { x: 100, y: 100 } }],
    ['double_click', { coordinates: { x: 100, y: 100 } }],
    ['right_click', { coordinates: { x: 100, y: 100 } }],
    ['hover', { coordinates: { x: 100, y: 100 } }],
    ['left_click_drag', { startCoordinates: { x: 100, y: 100 }, coordinates: { x: 200, y: 200 } }],
  ])('fails stale computer %s before any mouse dispatch', async (action, coords) => {
    const capture = seedCapture();
    page.scrollY = 99;

    const result = await computerClick({
      action,
      captureId: capture.captureId,
      ...coords,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scroll changed/i);
    expect(dispatched).toEqual([]);
  });

  it.each([
    ['click', { coordinate: { x: 100, y: 100 } }],
    ['double_click', { coordinate: { x: 100, y: 100 } }],
    ['right_click', { coordinate: { x: 100, y: 100 } }],
    ['hover', { coordinate: { x: 100, y: 100 } }],
    [
      'drag',
      {
        coordinate: { x: 100, y: 100 },
        end: { coordinate: { x: 200, y: 200 } },
        steps: 2,
      },
    ],
  ])('fails stale interact %s before any mouse dispatch', async (action, coords) => {
    const capture = seedCapture();
    page.scrollY = 99;

    const result = await interactClick({
      action,
      captureId: capture.captureId,
      ...coords,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scroll changed/i);
    expect(dispatched).toEqual([]);
  });

  it('rejects combining ordinary captureId with Jev expectedScreenshotId', async () => {
    const capture = seedCapture();

    const result = await interactClick({
      captureId: capture.captureId,
      expectedScreenshotId: 'vf-existing',
      expectedDeadlineAt: Date.now() + 10_000,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      /captureId.*expectedScreenshotId|expectedScreenshotId.*captureId/i,
    );
    expect(dispatched).toEqual([]);
  });

  it('does not replay a capture-bound hover through the synthetic DOM fallback', async () => {
    const capture = seedCapture();
    vi.mocked(cdpSessionManager.sendCommand).mockRejectedValue(
      new Error('CDP Input.dispatchMouseEvent outcome unknown'),
    );

    const result = await computerClick({
      action: 'hover',
      captureId: capture.captureId,
    });

    expect(result.isError).toBe(true);
    expect(computerTool.safeExecuteScript).not.toHaveBeenCalled();
  });

  it('does not synthesize a replay for an uncertain capture-bound click', async () => {
    const capture = seedCapture();
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
      async (_id: number, method: string, params: any) => {
        if (method === 'Input.dispatchMouseEvent') {
          dispatched.push({ method, params });
          if (params?.type === 'mousePressed') {
            throw new Error('CDP Input.dispatchMouseEvent outcome unknown');
          }
        }
        return {};
      },
    );

    const result = await interactClick({ captureId: capture.captureId });

    expect(result.isError).toBe(true);
    expect(syntheticClicks).toBe(0);
    expect(mouseEvents('mousePressed')).toHaveLength(1);
  });

  it('rejects legacy click screenshot coordinates without captureId before dispatch', async () => {
    seedCapture({ screenshotWidth: page.width / 2 });

    const result = await clickTool.execute({
      tabId,
      coordinate: { x: 100, y: 100 },
      coordinateSpace: 'screenshot',
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/captureId|fresh screenshot/i);
    expect(dispatched).toEqual([]);
  });

  it('rejects a stale legacy click captureId before dispatch', async () => {
    const capture = seedCapture({ screenshotWidth: page.width / 2 });
    page.scrollY = 99;

    const result = await clickTool.execute({
      tabId,
      coordinate: { x: 100, y: 100 },
      coordinateSpace: 'screenshot',
      captureId: capture.captureId,
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scroll changed/i);
    expect(dispatched).toEqual([]);
  });

  it('passes original screenshot coordinates through legacy click once, without double scaling', async () => {
    const capture = seedCapture({
      screenshotWidth: page.width / 2,
      screenshotHeight: page.height / 2,
    });

    const result = await clickTool.execute({
      tabId,
      coordinate: { x: 100, y: 100 },
      coordinateSpace: 'screenshot',
      captureId: capture.captureId,
    } as any);

    expect(result.isError).toBe(false);
    const press = mouseEvents('mousePressed')[0];
    expect(press.params).toMatchObject({ x: 200, y: 200 });
    expect(JSON.parse(result.content[0].text as string)).toMatchObject({
      captureId: capture.captureId,
      captureValidated: true,
    });
  });

  it('keeps legacy click viewport pixels raw even when a screenshot context exists', async () => {
    seedCapture({ screenshotWidth: page.width / 2 });

    const result = await clickTool.execute({
      tabId,
      coordinate: { x: 100, y: 100 },
      coordinateSpace: 'viewport',
    } as any);

    expect(result.isError).toBe(false);
    expect(mouseEvents('mousePressed')[0].params).toMatchObject({ x: 100, y: 100 });
  });

  it('keeps legacy click normalized viewport coordinates on viewport dimensions', async () => {
    seedCapture({ screenshotWidth: page.width / 2, screenshotHeight: page.height / 2 });

    const result = await clickTool.execute({
      tabId,
      coordinate: { x: 0.5, y: 0.5 },
      coordinateSpace: 'viewport',
    } as any);

    expect(result.isError).toBe(false);
    expect(mouseEvents('mousePressed')[0].params).toMatchObject({ x: 500, y: 400 });
  });

  it('does not let an unused stale captureId break a semantic legacy click', async () => {
    const capture = seedCapture({ screenshotWidth: page.width / 2 });
    page.scrollY = 99;
    vi.mocked(inPageEngine.executeInPage).mockImplementation(
      async (_target: any, method: string) => {
        if (method === 'inPageLocateBySelector') {
          return [
            {
              frameId: 0,
              result: {
                success: true,
                x: 10,
                y: 20,
                width: 30,
                height: 20,
                index: 5,
                tagName: 'BUTTON',
              },
            },
          ] as any;
        }
        return [{ result: true }] as any;
      },
    );
    const interact = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    });

    const result = await clickTool.execute({
      tabId,
      selector: '#go',
      coordinate: { x: 100, y: 100 },
      coordinateSpace: 'screenshot',
      captureId: capture.captureId,
    } as any);

    expect(result.isError).toBe(false);
    expect(interact).toHaveBeenCalledWith(
      expect.not.objectContaining({ captureId: expect.anything(), coordinateSpace: 'screenshot' }),
      undefined,
    );
    expect(interact).toHaveBeenCalledWith(expect.objectContaining({ index: 5 }), undefined);
  });

  it('rejects a stale legacy fill captureId before physical fill', async () => {
    const capture = seedCapture({ screenshotWidth: page.width / 2 });
    page.scrollY = 99;
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'value',
      isTrusted: true,
      method: 'cdp_native',
    });

    const result = await fillTool.execute({
      tabId,
      coordinate: { x: 100, y: 100 },
      coordinateSpace: 'screenshot',
      captureId: capture.captureId,
      value: 'value',
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scroll changed/i);
    expect(fill).not.toHaveBeenCalled();
  });

  it('passes legacy fill screenshot coordinates to the physical fill in viewport space', async () => {
    const capture = seedCapture({
      screenshotWidth: page.width / 2,
      screenshotHeight: page.height / 2,
    });
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'value',
      isTrusted: true,
      method: 'cdp_native',
    });

    const result = await fillTool.execute({
      tabId,
      coordinate: { x: 100, y: 100 },
      coordinateSpace: 'screenshot',
      captureId: capture.captureId,
      value: 'value',
    } as any);

    expect(result.isError).toBe(false);
    expect(fill).toHaveBeenCalledWith(expect.objectContaining({ coordinate: { x: 200, y: 200 } }));
  });

  it('does not let an unused stale captureId break a semantic legacy fill', async () => {
    const capture = seedCapture({ screenshotWidth: page.width / 2 });
    page.scrollY = 99;
    vi.mocked(inPageEngine.executeInPage).mockImplementation(
      async (_target: any, method: string) => {
        if (method === 'inPageLocateBySelector') {
          return [
            {
              frameId: 0,
              result: {
                success: true,
                x: 10,
                y: 20,
                width: 30,
                height: 20,
                index: 5,
                tagName: 'INPUT',
              },
            },
          ] as any;
        }
        return [{ result: true }] as any;
      },
    );
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'value',
      isTrusted: true,
      method: 'cdp_native',
    });

    const result = await fillTool.execute({
      tabId,
      selector: '#name',
      coordinate: { x: 100, y: 100 },
      coordinateSpace: 'screenshot',
      captureId: capture.captureId,
      value: 'value',
    } as any);

    expect(result.isError).toBe(false);
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('revalidates a capture-bound point sequence between every click', async () => {
    const capture = seedCapture();
    let presses = 0;
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(
      async (_id: number, method: string, params: any) => {
        if (method === 'Input.dispatchMouseEvent') {
          dispatched.push({ method, params });
          if (params?.type === 'mousePressed') {
            presses++;
            if (presses === 1) page.domRevision += 1;
          }
        }
        return {};
      },
    );

    const result = await interactIndexTool.execute({
      tabId,
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
        { x: 300, y: 300 },
      ],
      coordinateSpace: 'screenshot',
      captureId: capture.captureId,
      includeDelta: false,
      skipLock: true,
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/DOM changed|click_sequence failed after 1/i);
    expect(mouseEvents('mousePressed')).toHaveLength(1);
  });
});
