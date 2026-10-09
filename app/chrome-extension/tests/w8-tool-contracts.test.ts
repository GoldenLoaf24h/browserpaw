import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computerTool } from '../entrypoints/background/tools/browser/computer';
import { scrollUntilFoundTool } from '../entrypoints/background/tools/browser/scroll-until-found';
import { inPageScrollUntilFound } from '../entrypoints/background/tools/browser/dom-indexer';
import { screenshotTool, clampCanvasDimensions, MAX_CANVAS_DIM, MAX_CANVAS_AREA } from '../entrypoints/background/tools/browser/screenshot';
import { inspectMediaTool } from '../entrypoints/background/tools/browser/inspect-media';
import { tabGroupManager } from '../entrypoints/background/tools/browser/tab-group-manager';
import { screenshotContextManager, scaleCoordinates } from '@/utils/screenshot-context';
import { RAW_TOOL_SCHEMAS } from '../../../packages/shared/src/tools';

describe('W8 Contract & Screenshot Regression Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    if (typeof window !== 'undefined') {
      window.scrollBy = vi.fn();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('TOOL-01 (Part 1): chrome_computer groupTitle/groupColor/autoGroup consumption', () => {
    it('consumes groupTitle and groupColor when passed to computerTool.execute using spyOn', async () => {
      const ensureSpy = vi.spyOn(tabGroupManager, 'ensureAgentTabGroup').mockResolvedValue(999);
      vi.spyOn(tabGroupManager, 'isAgentTab').mockReturnValue(false);

      vi.spyOn(computerTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 123,
        windowId: 1,
      });
      vi.spyOn(computerTool as any, 'executeAction').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      });

      await computerTool.execute({
        action: 'wait',
        tabId: 123,
        groupTitle: 'W8-Custom-Group',
        groupColor: 'orange',
        autoGroup: true,
      });

      expect(ensureSpy).toHaveBeenCalledWith(123, {
        title: 'W8-Custom-Group',
        color: 'orange',
        windowId: 1,
      });
    });

    it('does not group tab when autoGroup is false', async () => {
      const ensureSpy = vi.spyOn(tabGroupManager, 'ensureAgentTabGroup').mockResolvedValue(999);

      vi.spyOn(computerTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 123,
        windowId: 1,
      });
      vi.spyOn(computerTool as any, 'executeAction').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      });

      await computerTool.execute({
        action: 'wait',
        tabId: 123,
        groupTitle: 'Ignored',
        autoGroup: false,
      });

      expect(ensureSpy).not.toHaveBeenCalled();
    });

    it('does not perform double-group if tab is already an agent tab and no custom title/color is requested', async () => {
      const ensureSpy = vi.spyOn(tabGroupManager, 'ensureAgentTabGroup').mockResolvedValue(999);
      vi.spyOn(tabGroupManager, 'isAgentTab').mockReturnValue(true);

      vi.spyOn(computerTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 123,
        windowId: 1,
      });
      vi.spyOn(computerTool as any, 'executeAction').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      });

      await computerTool.execute({
        action: 'wait',
        tabId: 123,
      });

      expect(ensureSpy).not.toHaveBeenCalled();
    });
  });

  describe('QUAL-05 & TOOL-01 (Part 2): chrome_scroll_until_found maxSteps clamp, role filter, actionOnFound', () => {
    it('QUAL-05: clamps maxSteps to 30 when user specifies 40 in scrolling container', async () => {
      const container = document.createElement('div');
      let curScrollTop = 0;
      Object.defineProperty(container, 'scrollTop', {
        get: () => curScrollTop,
        set: (v) => { curScrollTop = v; },
      });
      container.scrollBy = (opts: any) => {
        curScrollTop += opts.top || 0;
      };
      document.body.appendChild(container);

      const res = await inPageScrollUntilFound({
        query: 'never_find_me_token',
        maxSteps: 40,
        stepPx: 100,
        settleMs: 0,
        timeoutMs: 10000,
      });

      expect(res.stepsTaken).toBe(30);
      container.remove();
    });

    it('TOOL-01: filters candidates by role correctly, ignoring password/hidden for textbox and matching native elements', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Confirm Payment';
      btn.getBoundingClientRect = () => ({ width: 100, height: 40, top: 10, left: 10, bottom: 50, right: 110 } as any);
      document.body.appendChild(btn);

      const hiddenInput = document.createElement('input');
      hiddenInput.setAttribute('type', 'hidden');
      hiddenInput.setAttribute('value', 'Confirm Payment');
      hiddenInput.getBoundingClientRect = () => ({ width: 100, height: 40, top: 10, left: 10, bottom: 50, right: 110 } as any);
      document.body.appendChild(hiddenInput);

      const textInput = document.createElement('input');
      textInput.setAttribute('type', 'text');
      textInput.setAttribute('value', 'Confirm Payment');
      textInput.getBoundingClientRect = () => ({ width: 100, height: 40, top: 10, left: 10, bottom: 50, right: 110 } as any);
      document.body.appendChild(textInput);

      const roleBtnRes = await inPageScrollUntilFound({
        query: 'Confirm Payment',
        role: 'button',
        maxSteps: 1,
      });
      expect(roleBtnRes.found).toBe(true);
      expect(roleBtnRes.tagName).toBe('button');

      const roleTextRes = await inPageScrollUntilFound({
        query: 'Confirm Payment',
        role: 'textbox',
        maxSteps: 1,
      });
      expect(roleTextRes.found).toBe(true);
      expect(roleTextRes.tagName).toBe('input');

      const roleArticleRes = await inPageScrollUntilFound({
        query: 'Confirm Payment',
        role: 'article',
        maxSteps: 1,
      });
      expect(roleArticleRes.found).toBe(false);

      btn.remove();
      hiddenInput.remove();
      textInput.remove();
    });

    it('TOOL-01: actionOnFound none does not call scrollIntoView', async () => {
      const el = document.createElement('div');
      el.textContent = 'Target Action None';
      el.getBoundingClientRect = () => ({ width: 100, height: 40, top: 10, left: 10, bottom: 50, right: 110 } as any);
      let scrolled = false;
      el.scrollIntoView = () => { scrolled = true; };
      document.body.appendChild(el);

      const res = await inPageScrollUntilFound({
        query: 'Target Action None',
        actionOnFound: 'none',
        maxSteps: 1,
      });

      expect(res.found).toBe(true);
      expect(scrolled).toBe(false);
      el.remove();
    });

    it('TOOL-01: actionOnFound focus focuses element with preventScroll: true and does not scroll', async () => {
      const el = document.createElement('input');
      el.setAttribute('type', 'text');
      el.setAttribute('value', 'Focus Target');
      el.getBoundingClientRect = () => ({ width: 100, height: 40, top: 10, left: 10, bottom: 50, right: 110 } as any);
      let focused = false;
      let focusOptionsPassed: any = null;
      let scrolled = false;
      el.focus = (opts?: any) => { focused = true; focusOptionsPassed = opts; };
      el.scrollIntoView = () => { scrolled = true; };
      document.body.appendChild(el);

      const res = await inPageScrollUntilFound({
        selector: 'input[value="Focus Target"]',
        actionOnFound: 'focus',
        maxSteps: 1,
      });

      expect(res.found).toBe(true);
      expect(focused).toBe(true);
      expect(focusOptionsPassed?.preventScroll).toBe(true);
      expect(scrolled).toBe(false);
      el.remove();
    });

    it('TOOL-01: ScrollUntilFoundTool forwards role and actionOnFound and fails on failed auto-click without swallowing error', async () => {
      vi.spyOn(scrollUntilFoundTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 99 });

      const inPageEngineMod = await import('../entrypoints/background/tools/browser/in-page-engine');
      vi.spyOn(inPageEngineMod, 'executeInPage').mockResolvedValue([
        {
          result: {
            found: true,
            index: 5,
            stepsTaken: 1,
            scrolledPx: 0,
            message: 'Found target',
          },
        },
      ]);

      const interactIndexMod = await import('../entrypoints/background/tools/browser/interact-index');
      vi.spyOn(interactIndexMod.interactIndexTool, 'execute').mockResolvedValue({
        content: [{ type: 'text', text: 'Element occluded' }],
        isError: true,
      });

      const toolRes = await scrollUntilFoundTool.execute({
        tabId: 99,
        query: 'Click Target',
        role: 'button',
        actionOnFound: 'click',
      });

      expect(toolRes.isError).toBe(true);
      expect(toolRes.content[0].type).toBe('text');
      expect((toolRes.content[0] as any).text).toContain('actionOnFound click failed');
    });
  });

  describe('PERF-05 & TOOL-01 (Part 3): screenshot clampCanvasDimensions, maxWidth & coordinate fidelity', () => {
    it('PERF-05: clampCanvasDimensions rejects NaN/Infinity and protects dimensions exceeding 16384 or area', () => {
      const boundedNaN = clampCanvasDimensions(NaN as any, 100);
      expect(boundedNaN.width).toBe(1);
      expect(boundedNaN.height).toBe(100);

      const boundedInf = clampCanvasDimensions(Infinity as any, 200);
      expect(boundedInf.width).toBe(1);
      expect(boundedInf.height).toBe(200);

      const bounded1 = clampCanvasDimensions(1000, 20000);
      expect(bounded1.height).toBeLessThanOrEqual(MAX_CANVAS_DIM);
      expect(bounded1.width * bounded1.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
      expect(Math.round(bounded1.height / bounded1.width)).toBe(20);

      const bounded2 = clampCanvasDimensions(30000, 500);
      expect(bounded2.width).toBeLessThanOrEqual(MAX_CANVAS_DIM);
      expect(bounded2.width * bounded2.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);

      const normal = clampCanvasDimensions(800, 600);
      expect(normal.width).toBe(800);
      expect(normal.height).toBe(600);
    });

    it('TOOL-01: coordinate mapping scales accurately for element crop under supersampling zoom and maxWidth downscale', () => {
      // Case A: 2x zoom on element with CSS bounds (originX=100, originY=50, cropWidth=200, cropHeight=150)
      // Encoded screenshot size: 400x300
      screenshotContextManager.setContext(1, {
        screenshotWidth: 400,
        screenshotHeight: 300,
        viewportWidth: 1000,
        viewportHeight: 800,
        originX: 100,
        originY: 50,
        cropWidth: 200,
        cropHeight: 150,
        captureMode: 'element',
      });
      const ctxA = screenshotContextManager.getContext(1)!;
      // Click center of image: (200, 150) in image space
      const mappedCenterA = scaleCoordinates(200, 150, ctxA);
      // Must map exactly to viewport CSS center: (100 + 100, 50 + 75) = (200, 125)
      expect(mappedCenterA.x).toBe(200);
      expect(mappedCenterA.y).toBe(125);

      // Case B: downscaling with maxWidth=100 on the same element
      // Encoded screenshot size: 100x75
      screenshotContextManager.setContext(2, {
        screenshotWidth: 100,
        screenshotHeight: 75,
        viewportWidth: 1000,
        viewportHeight: 800,
        originX: 100,
        originY: 50,
        cropWidth: 200,
        cropHeight: 150,
        captureMode: 'element',
      });
      const ctxB = screenshotContextManager.getContext(2)!;
      // Click center of downscaled image: (50, 37.5) in image space
      const mappedCenterB = scaleCoordinates(50, 38, ctxB);
      expect(mappedCenterB.x).toBe(200);
      expect(Math.abs(mappedCenterB.y - 125)).toBeLessThanOrEqual(1);
    });
  });

  describe('TOOL-01 (Part 4): inspect_media zoom forwarding and correct description', () => {
    it('passes zoom parameter to screenshot tool, validates finite zoom, and formats note accurately without hardcoded 2.0x', async () => {
      vi.spyOn(inspectMediaTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 10 });
      vi.spyOn(inspectMediaTool as any, 'tryGetTab').mockResolvedValue({ id: 10 });
      vi.spyOn(inspectMediaTool as any, 'safeExecuteScript').mockResolvedValue([
        { result: { found: false } }
      ]);

      const executeSpy = vi.spyOn(screenshotTool, 'execute').mockResolvedValue({
        content: [
          { type: 'text', text: JSON.stringify({ success: true, imageWidth: 400, imageHeight: 300 }) },
          { type: 'image', data: 'abc==', mimeType: 'image/png' },
        ],
        isError: false,
      });

      const res = await inspectMediaTool.execute({
        tabId: 10,
        index: 1,
        zoom: 3.0,
      });

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          zoom: 3.0,
          targetIndex: 1,
        })
      );

      const textItem = res.content.find((c: any) => c.type === 'text');
      const parsed = JSON.parse((textItem as any).text);
      expect(parsed.zoom).toBe(3.0);
      expect(parsed.note).toContain('3x super-sampled');
      expect(parsed.note).not.toContain('2.0x');
    });
  });

  describe('TOOL-02 & QUAL-05: tool annotations and descriptions', () => {
    it('TOOL-02: read_dom annotations conservatively set readOnlyHint: false, idempotentHint: false, destructiveHint: true', () => {
      const readDomSchema = RAW_TOOL_SCHEMAS.find((s) => s.name === 'chrome_read_dom');
      expect(readDomSchema).toBeDefined();
      expect(readDomSchema?.annotations?.readOnlyHint).toBe(false);
      expect(readDomSchema?.annotations?.destructiveHint).toBe(true);
      expect(readDomSchema?.annotations?.idempotentHint).toBe(false);
      expect(readDomSchema?.description).toContain('Optional dismissOverlays closes modals and removes overlay elements.');
    });

    it('QUAL-05: console tool description accurately describes ~50ms settle instead of ~2s', () => {
      const consoleSchema = RAW_TOOL_SCHEMAS.find((s) => s.name === 'chrome_console');
      expect(consoleSchema).toBeDefined();
      expect(consoleSchema?.description).toContain('~50ms');
      expect(consoleSchema?.description).not.toContain('~2s');
    });
  });
});
