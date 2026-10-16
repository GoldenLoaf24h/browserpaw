import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateDecodedBase64ByteLength, prepareImageForJevVision } from '../utils/image-utils';
import {
  screenshotContextManager,
  scaleVisionFrameCoordinates,
  MAX_VISION_FRAMES,
} from '../utils/screenshot-context';
import { validateVisionFrame, type VisionFrameValidationOptions } from '../utils/screenshot-guard';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as cursor from '../entrypoints/background/tools/browser/agent-cursor';
import type { PerceptiveSignature } from '../entrypoints/background/tools/browser/dom-indexer';

const tabId = 404;
const url = 'https://example.com/page?step=1#form';
const signature = (): PerceptiveSignature => ({
  url,
  title: 'Page A',
  activeInputs: [],
  alerts: [],
});
const frameInput = (id = 'frame') => ({
  id,
  tabId,
  url,
  documentId: 'document-1',
  width: 1000,
  height: 800,
  contentWidth: 1000,
  contentHeight: 800,
  padX: 0,
  padY: 0,
  scaleRatio: 1,
  viewportWidth: 1000,
  viewportHeight: 800,
  scrollX: 0,
  scrollY: 0,
  perceptiveSignature: signature(),
});
const probe = (
  overrides: Partial<VisionFrameValidationOptions> = {},
): VisionFrameValidationOptions => ({
  expectedScreenshotId: 'frame',
  currentTabId: tabId,
  currentUrl: url,
  currentDocumentId: 'document-1',
  currentScroll: { scrollX: 0, scrollY: 0 },
  currentViewport: { viewportWidth: 1000, viewportHeight: 800 },
  currentPerceptiveSignature: signature(),
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
  screenshotContextManager.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  screenshotContextManager.clear();
});

describe('Jev image preparation', () => {
  it('requires actual browser decoding and canvas support', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    await expect(prepareImageForJevVision('data:image/png;base64,AA==')).rejects.toThrow(
      /required/,
    );
  });
  it.each([
    [1, 1, 280, 280, 'image/png'],
    [4000, 200, 1568, 280, 'image/jpeg'],
    [200, 4000, 280, 1568, 'image/png'],
  ] as const)(
    'decodes and re-encodes %sx%s as %sx%s',
    async (width, height, finalW, finalH, format) => {
      const close = vi.fn();
      const drawImage = vi.fn();
      const encode = vi.fn(async ({ type }: { type: string }) => new Blob(['encoded'], { type }));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ blob: async () => new Blob(['source']) })),
      );
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => ({ width, height, close })),
      );
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          constructor(
            public width: number,
            public height: number,
          ) {}
          getContext() {
            return { fillStyle: '', fillRect: vi.fn(), drawImage };
          }
          convertToBlob = encode;
        },
      );
      const image = await prepareImageForJevVision('data:image/webp;base64,AA==', {
        preferredFormat: format,
      });
      expect(image).toMatchObject({
        width: finalW,
        height: finalH,
        mimeType: format,
        byteLength: 7,
      });
      expect(image.dataUrl).toBe(`data:${format};base64,ZW5jb2RlZA==`);
      expect(drawImage).toHaveBeenCalledWith(
        expect.objectContaining({ width, height }),
        0,
        0,
        width,
        height,
        image.padX,
        image.padY,
        image.contentWidth,
        image.contentHeight,
      );
      expect(encode).toHaveBeenCalledWith(expect.objectContaining({ type: format }));
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ['AA==', 1],
    ['AAA=', 2],
    ['AAAA', 3],
  ] as const)('counts decoded bytes for %s', (base64, bytes) => {
    expect(calculateDecodedBase64ByteLength(`data:image/png;base64,${base64}`)).toBe(bytes);
  });
});

describe('Vision frame lifecycle and projection', () => {
  it('maps letterboxed pixels and rejects padding or non-finite coordinates', () => {
    const frame = screenshotContextManager.createVisionFrame({
      ...frameInput(),
      height: 280,
      contentHeight: 200,
      viewportHeight: 200,
      padY: 40,
    });
    expect(scaleVisionFrameCoordinates(500, 140, frame)).toMatchObject({ x: 500, y: 100 });
    for (const [x, y] of [
      [500, 10],
      [500, 260],
      [NaN, 100],
      [Infinity, 100],
    ]) {
      expect(scaleVisionFrameCoordinates(x, y, frame)).toHaveProperty('error');
    }
  });
  it('invalidates superseded captures and consumes a valid frame only once', () => {
    screenshotContextManager.createVisionFrame(frameInput());
    screenshotContextManager.createVisionFrame(frameInput('new'));
    expect(validateVisionFrame(probe()).valid).toBe(false);
    expect(screenshotContextManager.consumeVisionFrame('new')).toBeTruthy();
    expect(screenshotContextManager.consumeVisionFrame('new')).toBeFalsy();
  });
  it('expires, clears, and bounds retained frames', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    screenshotContextManager.createVisionFrame(frameInput());
    now.mockReturnValue(1000 + 5 * 60 * 1000 + 1);
    expect(screenshotContextManager.getVisionFrame('frame')).toMatchObject({ isInvalidated: true });
    expect(screenshotContextManager.consumeVisionFrame('frame')).toBeFalsy();
    for (let i = 0; i <= MAX_VISION_FRAMES; i++) {
      screenshotContextManager.createVisionFrame({ ...frameInput(`frame-${i}`), tabId: i + 100 });
    }
    expect(screenshotContextManager.getVisionFrame('frame-0')).toBeUndefined();
    screenshotContextManager.clear();
    expect(screenshotContextManager.getVisionFrame(`frame-${MAX_VISION_FRAMES}`)).toBeUndefined();
  });
});

describe('Vision freshness guard', () => {
  beforeEach(() => screenshotContextManager.createVisionFrame(frameInput()));
  it('accepts matching document, geometry, and semantic probes', () => {
    expect(validateVisionFrame(probe()).valid).toBe(true);
  });
  it.each([
    { currentTabId: 505 },
    { currentDocumentId: 'document-2' },
    { currentUrl: url.replace('step=1', 'step=2') },
    { currentUrl: url.replace('#form', '#other') },
    { currentScroll: { scrollX: 0, scrollY: 10 } },
    { currentViewport: { viewportWidth: 990, viewportHeight: 800 } },
    { currentPerceptiveSignature: { ...signature(), title: 'Page B' } },
    { currentPerceptiveSignature: { ...signature(), question: 'Next question' } },
    { currentPerceptiveSignature: { ...signature(), alerts: ['Invalid'] } },
    {
      currentPerceptiveSignature: {
        ...signature(),
        activeInputs: [{ tagName: 'INPUT', value: 'new' }],
      },
    },
    { currentScroll: undefined },
    { currentViewport: undefined },
    { currentDocumentId: undefined },
    { currentUrl: undefined },
    { currentPerceptiveSignature: undefined },
  ])('rejects drift or absent probes: %j', (overrides) => {
    expect(validateVisionFrame(probe(overrides)).valid).toBe(false);
  });
});

describe('Real interact executor with frame-bound click', () => {
  let currentSignature: PerceptiveSignature;
  let moved: (() => void) | undefined;
  let delivered: boolean;
  let events: Array<{ type: string; x: number; y: number }>;
  let syntheticClicks: number;
  const click = (overrides: Record<string, any> = {}) =>
    interactIndexTool.execute({
      action: 'click',
      coordinate: { x: 500, y: 400 },
      coordinateSpace: 'screenshot',
      expectedScreenshotId: 'frame',
      expectedDeadlineAt: Date.now() + 10000,
      tabId,
      includeDelta: false,
      skipLock: true,
      ...overrides,
    });
  beforeEach(() => {
    currentSignature = signature();
    moved = undefined;
    delivered = true;
    events = [];
    syntheticClicks = 0;
    screenshotContextManager.createVisionFrame(frameInput());
    const tab = { id: tabId, url, windowId: 1, active: false };
    vi.spyOn(interactIndexTool as any, 'resolveAffinityTab').mockResolvedValue(tab);
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) },
    });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_id, _label, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_id, method, params: any) => {
        if (method === 'Input.dispatchMouseEvent') {
          events.push(params);
          if (params.type === 'mouseMoved') moved?.();
        }
        return {} as any;
      },
    );
    vi.spyOn(cursor, 'animateAgentCursor').mockResolvedValue(undefined);
    vi.spyOn(cursor, 'animateAgentCursorClick').mockResolvedValue(undefined);
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string) => {
        let result: any = { success: true };
        if (fnName === 'inPageGetScrollState')
          result = {
            scrollX: 0,
            scrollY: 0,
            viewportWidth: 1000,
            viewportHeight: 800,
            documentURL: url,
          };
        if (fnName === 'inPageDetectPerceptiveSignature') result = { ...currentSignature };
        if (fnName === 'inPageArmDeliveryProbe') result = { armed: true };
        if (fnName === 'inPageReadDeliveryProbe') result = { delivered, hits: [] };
        if (fnName === 'inPageSnapCoordinate') result = { snapped: false };
        if (fnName === 'inPageDispatchSyntheticClick') syntheticClicks++;
        return [{ result, documentId: 'document-1' }] as any;
      },
    );
  });
  it('presses once at the projected point, then rejects replay', async () => {
    const result = await click();
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(events.filter((e) => e.type === 'mousePressed')).toEqual([
      expect.objectContaining({ x: 500, y: 400 }),
    ]);
    expect((await click()).isError).toBe(true);
    expect(events.filter((e) => e.type === 'mousePressed')).toHaveLength(1);
  });
  it('blocks a page change during movement before pressing or animating a click', async () => {
    moved = () => {
      currentSignature = { ...signature(), title: 'Page B' };
    };
    const result = await click();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('signature mismatch');
    expect(events.some((e) => e.type === 'mouseMoved')).toBe(true);
    expect(events.filter((e) => e.type !== 'mouseMoved')).toHaveLength(0);
    expect(cursor.animateAgentCursorClick).not.toHaveBeenCalled();
  });
  it('blocks a deadline crossed during pre-press delay', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    moved = () => {
      clock.mockReturnValue(1200);
    };
    const result = await click({ expectedDeadlineAt: 1100, prePressDelayMs: 5 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('deadline expired');
    expect(events.filter((e) => e.type !== 'mouseMoved')).toHaveLength(0);
  });
  it('does not retry an unverified visual click synthetically', async () => {
    delivered = false;
    const result = await click();
    expect(result.isError).toBe(true);
    expect(events.filter((e) => e.type === 'mousePressed')).toHaveLength(1);
    expect(syntheticClicks).toBe(0);
  });
  it.each([
    { action: 'drag' },
    { index: 1 },
    { expectedDeadlineAt: Infinity },
    { expectedDeadlineAt: 1 },
    { expectedScreenshotId: 'missing' },
  ])('rejects invalid inputs: %j', async (overrides) => {
    expect((await click(overrides)).isError).toBe(true);
    expect(events).toHaveLength(0);
  });
});
