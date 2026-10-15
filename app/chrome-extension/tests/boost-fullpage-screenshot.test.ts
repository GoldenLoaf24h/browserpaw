/**
 * @fileoverview Full-Page Screenshot Industrial Engine Tests
 * Comprehensive verification for GoFullPage-grade features:
 * 1. StyleStack header/sticky/footer de-duplication & 100% clean style rollback
 * 2. Page warmup for lazy-loading and skeleton screen triggering
 * 3. Dynamic height change auto-recovery during scroll steps
 * 4. captureVisibleTab quota error backoff retry
 * 5. Canvas dimension safety (16,384px bounds) & DPR 1:1 normalization
 * 6. Pure in-memory base64 vs native temp disk routing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { stitchImages, MAX_CANVAS_DIM, MAX_CANVAS_AREA } from '../utils/image-utils';

describe('GoFullPage Industrial Full-Page Screenshot Engine', () => {
  describe('1. StyleStack DOM & Slice Visibility Management (Content Script)', () => {
    let scriptContent: string;

    afterEach(() => {
      vi.useRealTimers();
    });

    beforeEach(() => {
      window.scrollTo = vi.fn();
      // Setup DOM elements representing typical page layout
      document.documentElement.style.overflow = 'auto';
      document.body.innerHTML = `
        <header id="main-header" style="position: fixed; top: 0; left: 0; width: 100%; height: 60px; z-index: 1000; color: red;">
          <h1>Site Navigation</h1>
        </header>
        <div id="sticky-bar" style="position: sticky; top: 60px; height: 40px; background: yellow;">
          Sticky Submenu
        </div>
        <main id="content" style="height: 3000px; padding-top: 100px;">
          <p>Main content paragraphs...</p>
        </main>
        <div id="cookie-banner" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 50px; background: black; color: white;">
          Accept Cookies
        </div>
        <div id="chat-widget" style="position: fixed; bottom: 80px; right: 20px; width: 60px; height: 60px;">
          Chat
        </div>
      `;

      // Mock getBoundingClientRect for jsdom
      const header = document.getElementById('main-header')!;
      header.getBoundingClientRect = () => ({
        top: 0,
        bottom: 60,
        left: 0,
        right: 1024,
        width: 1024,
        height: 60,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
      Object.defineProperty(header, 'offsetWidth', { value: 1024, configurable: true });
      Object.defineProperty(header, 'offsetHeight', { value: 60, configurable: true });

      const sticky = document.getElementById('sticky-bar')!;
      sticky.getBoundingClientRect = () => ({
        top: 60,
        bottom: 100,
        left: 0,
        right: 1024,
        width: 1024,
        height: 40,
        x: 0,
        y: 60,
        toJSON: () => {},
      });
      Object.defineProperty(sticky, 'offsetWidth', { value: 1024, configurable: true });
      Object.defineProperty(sticky, 'offsetHeight', { value: 40, configurable: true });

      const cookieBanner = document.getElementById('cookie-banner')!;
      cookieBanner.getBoundingClientRect = () => ({
        top: 718,
        bottom: 768,
        left: 0,
        right: 1024,
        width: 1024,
        height: 50,
        x: 0,
        y: 718,
        toJSON: () => {},
      });
      Object.defineProperty(cookieBanner, 'offsetWidth', { value: 1024, configurable: true });
      Object.defineProperty(cookieBanner, 'offsetHeight', { value: 50, configurable: true });

      const chat = document.getElementById('chat-widget')!;
      chat.getBoundingClientRect = () => ({
        top: 628,
        bottom: 688,
        left: 944,
        right: 1004,
        width: 60,
        height: 60,
        x: 944,
        y: 628,
        toJSON: () => {},
      });
      Object.defineProperty(chat, 'offsetWidth', { value: 60, configurable: true });
      Object.defineProperty(chat, 'offsetHeight', { value: 60, configurable: true });

      // Execute screenshot-helper.js in current jsdom window context
      if (!scriptContent) {
        const helperPath = path.resolve(__dirname, '../inject-scripts/screenshot-helper.js');
        scriptContent = fs.readFileSync(helperPath, 'utf8');
      }
      const runFn = new Function('chrome', scriptContent);
      runFn((globalThis as any).chrome);
    });

    it('exposes window.__mcpStyleStack and manages style push/pop', () => {
      const styleStack = (window as any).__mcpStyleStack;
      expect(styleStack).toBeDefined();
      expect(typeof styleStack.add).toBe('function');
      expect(typeof styleStack.popAll).toBe('function');

      const el = document.getElementById('main-header')!;
      const originalCss = el.style.cssText;

      styleStack.add(el, { visibility: 'hidden', overflow: 'hidden' });
      expect(el.style.visibility).toBe('hidden');

      styleStack.popAll();
      expect(el.style.cssText).toBe(originalCss);
    });

    it('preserves header on Screen 1 (stepIndex 0) and hides floating bottom banner', () => {
      const messageListeners = (chrome.runtime.onMessage.addListener as any).mock.calls;
      const lastListener = messageListeners[messageListeners.length - 1][0];

      const sendResponse = vi.fn();
      // Step 0, not last step
      lastListener({ action: 'prepareSlice', stepIndex: 0, isLastStep: false }, {}, sendResponse);

      const header = document.getElementById('main-header')!;
      const cookieBanner = document.getElementById('cookie-banner')!;

      // Header remains untouched on first screen
      expect(header.style.visibility).not.toBe('hidden');

      // Floating bottom banner is hidden on intermediate screens
      expect(cookieBanner.style.visibility).toBe('hidden');
    });

    it('hides header and converts stickies on Screen 2+ (stepIndex > 0)', () => {
      const messageListeners = (chrome.runtime.onMessage.addListener as any).mock.calls;
      const lastListener = messageListeners[messageListeners.length - 1][0];

      const sendResponse = vi.fn();
      // Step 1 (screen 2), not last step
      lastListener({ action: 'prepareSlice', stepIndex: 1, isLastStep: false }, {}, sendResponse);

      const header = document.getElementById('main-header')!;
      const sticky = document.getElementById('sticky-bar')!;
      const cookieBanner = document.getElementById('cookie-banner')!;
      const chat = document.getElementById('chat-widget')!;

      // Header is hidden to eliminate duplicate headers down the page
      expect(header.style.visibility).toBe('hidden');

      // Sticky converted to relative
      expect(sticky.style.position).toBe('relative');

      // Floating footer hidden
      expect(cookieBanner.style.visibility).toBe('hidden');

      // Floating chat widget hidden
      expect(chat.style.visibility).toBe('hidden');
    });

    it('reveals floating bottom banners on the final screen (isLastStep true)', () => {
      const messageListeners = (chrome.runtime.onMessage.addListener as any).mock.calls;
      const lastListener = messageListeners[messageListeners.length - 1][0];

      const sendResponse = vi.fn();
      // Step 2, isLastStep: true
      lastListener({ action: 'prepareSlice', stepIndex: 2, isLastStep: true }, {}, sendResponse);

      const header = document.getElementById('main-header')!;
      const cookieBanner = document.getElementById('cookie-banner')!;

      // Header remains hidden on final screen
      expect(header.style.visibility).toBe('hidden');

      // Floating footer is NOT hidden on final screen so it appears once at the bottom!
      expect(cookieBanner.style.visibility).not.toBe('hidden');
    });

    it('100% restores original DOM styles on resetPageAfterCapture', () => {
      const header = document.getElementById('main-header')!;
      const sticky = document.getElementById('sticky-bar')!;
      const cookieBanner = document.getElementById('cookie-banner')!;
      const origHeaderCss = header.style.cssText;
      const origStickyCss = sticky.style.cssText;
      const origCookieCss = cookieBanner.style.cssText;

      const messageListeners = (chrome.runtime.onMessage.addListener as any).mock.calls;
      const lastListener = messageListeners[messageListeners.length - 1][0];

      // Mutate via slice preparation
      lastListener({ action: 'prepareSlice', stepIndex: 1, isLastStep: false }, {}, () => {});
      expect(header.style.visibility).toBe('hidden');

      // Reset
      const sendResponse = vi.fn();
      lastListener({ action: 'resetPageAfterCapture', scrollX: 0, scrollY: 0 }, {}, sendResponse);

      expect(header.style.cssText).toBe(origHeaderCss);
      expect(sticky.style.cssText).toBe(origStickyCss);
      expect(cookieBanner.style.cssText).toBe(origCookieCss);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('warmupPage scrolls to bottom and settles cleanly at (0, 0) ready for slice 0', () => {
      Object.defineProperty(document.body, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

      const scrollCalls: any[] = [];
      window.scrollTo = vi.fn().mockImplementation((opt) => {
        scrollCalls.push(opt);
      });

      const messageListeners = (chrome.runtime.onMessage.addListener as any).mock.calls;
      const lastListener = messageListeners[messageListeners.length - 1][0];

      try {
        vi.useFakeTimers();
        const sendResponse = vi.fn();
        lastListener({ action: 'warmupPage' }, {}, sendResponse);

        vi.advanceTimersByTime(100);
        vi.advanceTimersByTime(100);

        expect(scrollCalls.length).toBeGreaterThanOrEqual(2);
        expect(scrollCalls[0].top).toBeGreaterThan(0);
        expect(scrollCalls[1]).toEqual({ left: 0, top: 0, behavior: 'instant' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('popSliceFixed immediately rolls back slice fixed styles and slice stylesheets', () => {
      const messageListeners = (chrome.runtime.onMessage.addListener as any).mock.calls;
      const lastListener = messageListeners[messageListeners.length - 1][0];

      const header = document.getElementById('main-header')!;
      const origCss = header.style.cssText;

      lastListener({ action: 'prepareSlice', stepIndex: 1, isLastStep: false }, {}, () => {});
      expect(header.style.visibility).toBe('hidden');

      const sendResponse = vi.fn();
      lastListener({ action: 'popSliceFixed' }, {}, sendResponse);
      expect(header.style.cssText).toBe(origCss);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('captures fixed/sticky elements inside open shadow roots (nested) and restores them on reset', () => {
      // Open shadow root with a fixed header, a sticky bar, and a nested open shadow root
      const shadowHost = document.createElement('div');
      shadowHost.id = 'shadow-host';
      document.body.appendChild(shadowHost);
      const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
      shadowRoot.innerHTML = `
        <div id="shadow-header" style="position: fixed; top: 0; left: 0; width: 100%; height: 60px;">Shadow Header</div>
        <div id="shadow-sticky" style="position: sticky; top: 60px; height: 40px;">Shadow Sticky</div>
        <div id="nested-shadow-host"></div>
      `;
      const nestedHost = shadowRoot.getElementById('nested-shadow-host')!;
      const nestedRoot = nestedHost.attachShadow({ mode: 'open' });
      nestedRoot.innerHTML =
        '<div id="nested-fixed" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 50px;">Nested Fixed</div>';

      const stubBox = (
        el: Element,
        box: {
          top: number;
          bottom: number;
          left: number;
          right: number;
          width: number;
          height: number;
        },
      ) => {
        el.getBoundingClientRect = () => ({
          ...box,
          x: box.left,
          y: box.top,
          toJSON: () => {},
        });
        Object.defineProperty(el, 'offsetWidth', { value: box.width, configurable: true });
        Object.defineProperty(el, 'offsetHeight', { value: box.height, configurable: true });
      };

      const shadowHeader = shadowRoot.getElementById('shadow-header')!;
      const shadowSticky = shadowRoot.getElementById('shadow-sticky')!;
      const nestedFixed = nestedRoot.getElementById('nested-fixed')!;
      stubBox(shadowHeader, { top: 0, bottom: 60, left: 0, right: 1024, width: 1024, height: 60 });
      stubBox(shadowSticky, {
        top: 60,
        bottom: 100,
        left: 0,
        right: 1024,
        width: 1024,
        height: 40,
      });
      // Docked at the bottom of the current viewport, whatever innerHeight the suite left behind
      const viewportHeight = window.innerHeight;
      stubBox(nestedFixed, {
        top: viewportHeight - 50,
        bottom: viewportHeight,
        left: 0,
        right: 1024,
        width: 1024,
        height: 50,
      });

      const origShadowHeaderCss = shadowHeader.style.cssText;
      const origShadowStickyCss = shadowSticky.style.cssText;
      const origNestedFixedCss = nestedFixed.style.cssText;

      const messageListeners = (chrome.runtime.onMessage.addListener as any).mock.calls;
      const lastListener = messageListeners[messageListeners.length - 1][0];

      lastListener({ action: 'prepareSlice', stepIndex: 1, isLastStep: false }, {}, vi.fn());

      // Fixed header inside a shadow root is hidden exactly like a light-DOM header
      expect(shadowHeader.style.visibility).toBe('hidden');
      // Sticky inside a shadow root is converted to relative
      expect(shadowSticky.style.position).toBe('relative');
      // Fixed element inside a nested open shadow root is captured too
      expect(nestedFixed.style.visibility).toBe('hidden');

      lastListener({ action: 'resetPageAfterCapture', scrollX: 0, scrollY: 0 }, {}, vi.fn());

      // StyleStack rollback restores shadow-DOM inline styles and preserves the original id
      expect(shadowHeader.style.cssText).toBe(origShadowHeaderCss);
      expect(shadowSticky.style.cssText).toBe(origShadowStickyCss);
      expect(nestedFixed.style.cssText).toBe(origNestedFixedCss);
      expect(shadowSticky.getAttribute('id')).toBe('shadow-sticky');
    });
  });

  describe('2. Canvas Dimension Safety & Boundary Scaling', () => {
    it('defines safe maximum canvas boundaries for Chromium stability', () => {
      expect(MAX_CANVAS_DIM).toBe(16384);
      expect(MAX_CANVAS_AREA).toBe(268435456);
    });

    it('safely handles ultra-long page without throwing RangeError or crashing', async () => {
      // 50,000px height (e.g. infinite scroll)
      const oversizedParts = [
        { dataUrl: 'data:image/png;base64,part1', y: 0 },
        { dataUrl: 'data:image/png;base64,part2', y: 20000 },
        { dataUrl: 'data:image/png;base64,part3', y: 40000 },
      ];

      const canvas = await stitchImages(oversizedParts, 1280, 50000);
      expect(canvas).toBeDefined();
      expect(canvas.height).toBeLessThanOrEqual(MAX_CANVAS_DIM);
      expect(canvas.width).toBeLessThanOrEqual(MAX_CANVAS_DIM);
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
    });
  });

  describe('3. Quota Error Backoff Retry for captureVisibleTab', () => {
    it('retries with backoff when Chromium throws MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded', async () => {
      const { screenshotTool } = await import('../entrypoints/background/tools/browser/screenshot');
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://example.com/long-page',
        title: 'Long Page',
        active: true,
      });

      let attempts = 0;
      (chrome.tabs as any).captureVisibleTab = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts <= 2) {
          throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded');
        }
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      });

      // Call private captureTabPngWithRetry
      const result = await (screenshotTool as any).captureTabPngWithRetry({
        id: 1,
        active: true,
      });

      expect(attempts).toBe(3);
      expect(result).toContain('data:image/png;base64,');
    });
  });

  describe('4. Full-Page Capture End-to-End Execution Flow', () => {
    it('executes fullPage screenshot with warmup, slice prep, dynamic height check, and clean cleanup', async () => {
      const { screenshotTool } = await import('../entrypoints/background/tools/browser/screenshot');
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://example.com/articles',
        title: 'Articles',
        active: true,
      });

      const sentMessages: any[] = [];
      (screenshotTool as any).sendMessageToTab = vi
        .fn()
        .mockImplementation(async (_tabId: number, msg: any) => {
          sentMessages.push(msg);
          if (msg.action === 'preparePageForCapture') {
            return { success: true };
          }
          if (msg.action === 'warmupPage') {
            // Warmup settled height: expanded to 1800px
            return { success: true, totalWidth: 1280, totalHeight: 1800 };
          }
          if (msg.action === 'getPageDetails') {
            return {
              totalWidth: 1280,
              totalHeight: 1800,
              viewportWidth: 1280,
              viewportHeight: 600,
              devicePixelRatio: 1,
              currentScrollX: 0,
              currentScrollY: 0,
            };
          }
          if (msg.action === 'prepareSlice') {
            return { success: true };
          }
          if (msg.action === 'scrollPage') {
            return {
              success: true,
              newScrollX: 0,
              newScrollY: msg.y,
              totalHeight: 1800,
              totalWidth: 1280,
            };
          }
          if (msg.action === 'resetPageAfterCapture') {
            return { success: true };
          }
          return { success: true };
        });

      (screenshotTool as any).injectContentScript = vi.fn().mockResolvedValue(undefined);
      (chrome.tabs as any).captureVisibleTab = vi
        .fn()
        .mockResolvedValue(
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        );

      const res = await screenshotTool.execute({
        name: 'full_page_test',
        fullPage: true,
      });

      expect(res.isError).toBe(false);
      const textBlock = res.content.find((c: any) => c.type === 'text');
      expect(textBlock).toBeDefined();
      const payload = JSON.parse(textBlock.text);
      expect(payload.success).toBe(true);
      expect(payload.name).toBe('full_page_test');

      // Verify actions sequence:
      // 1. preparePageForCapture
      // 2. getPageDetails
      // 3. warmupPage
      // 4. scrollPage to slice position (first)
      // 5. prepareSlice for each part (after scroll)
      // 6. popSliceFixed after capture
      // 7. resetPageAfterCapture in finally
      const actions = sentMessages.map((m) => m.action);
      expect(actions).toContain('preparePageForCapture');
      expect(actions).toContain('warmupPage');
      expect(actions).toContain('prepareSlice');
      expect(actions).toContain('popSliceFixed');
      expect(actions).toContain('resetPageAfterCapture');

      // Verify that scrollPage precedes prepareSlice for part 1
      const scrollStep1Index = sentMessages.findIndex(
        (m) => m.action === 'scrollPage' && m.y === 600,
      );
      const prepSlice1Index = sentMessages.findIndex(
        (m) => m.action === 'prepareSlice' && m.stepIndex === 1,
      );
      expect(scrollStep1Index).toBeGreaterThan(0);
      expect(prepSlice1Index).toBeGreaterThan(scrollStep1Index);

      // Verify in-memory return (zero disk write)
      expect(payload.fileSaved).toBe(false);
      expect(res.content.some((c: any) => c.type === 'image')).toBe(true);
    });

    it('allocates high clarity transport budget without aggressive dimension downscaling for fullPage', async () => {
      const { screenshotTool } = await import('../entrypoints/background/tools/browser/screenshot');
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://example.com/clear',
        title: 'Clear Page',
        active: true,
      });

      (screenshotTool as any).sendMessageToTab = vi
        .fn()
        .mockImplementation(async (_tabId: number, msg: any) => {
          if (msg.action === 'preparePageForCapture') return { success: true };
          if (msg.action === 'warmupPage')
            return { success: true, totalWidth: 1280, totalHeight: 1200 };
          if (msg.action === 'getPageDetails') {
            return {
              totalWidth: 1280,
              totalHeight: 1200,
              viewportWidth: 1280,
              viewportHeight: 600,
              devicePixelRatio: 1,
              currentScrollX: 0,
              currentScrollY: 0,
            };
          }
          return {
            success: true,
            newScrollX: 0,
            newScrollY: msg.y,
            totalHeight: 1200,
            totalWidth: 1280,
          };
        });
      (screenshotTool as any).injectContentScript = vi.fn().mockResolvedValue(undefined);
      (chrome.tabs as any).captureVisibleTab = vi
        .fn()
        .mockResolvedValue(
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        );

      const res = await screenshotTool.execute({ fullPage: true });
      expect(res.isError).toBe(false);
      const textBlock = res.content.find((c: any) => c.type === 'text');
      const payload = JSON.parse(textBlock.text);
      expect(payload.success).toBe(true);
      expect(payload.imageWidth).toBe(1280);
      expect(payload.imageHeight).toBe(1200);
    });

    it('always invokes resetPageAfterCapture in finally even if capture fails', async () => {
      const { screenshotTool } = await import('../entrypoints/background/tools/browser/screenshot');
      (screenshotTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://example.com/fail',
        title: 'Fail Page',
        active: true,
      });

      let didCallReset = false;
      (screenshotTool as any).sendMessageToTab = vi
        .fn()
        .mockImplementation(async (_tabId: number, msg: any) => {
          if (msg.action === 'preparePageForCapture') return { success: true };
          if (msg.action === 'getPageDetails') {
            return {
              totalWidth: 1280,
              totalHeight: 1200,
              viewportWidth: 1280,
              viewportHeight: 600,
              devicePixelRatio: 1,
              currentScrollX: 0,
              currentScrollY: 0,
            };
          }
          if (msg.action === 'warmupPage') {
            throw new Error('Simulated network failure during warmup');
          }
          if (msg.action === 'resetPageAfterCapture') {
            didCallReset = true;
            return { success: true };
          }
          return { success: true };
        });
      (screenshotTool as any).injectContentScript = vi.fn().mockResolvedValue(undefined);

      await screenshotTool.execute({ fullPage: true });
      expect(didCallReset).toBe(true);
    });
  });
});
