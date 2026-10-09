import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  inPageVerifyInputCommitment,
  inPageDismissOverlays,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { navigateTool } from '../entrypoints/background/tools/browser/common';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import { dismissOverlayTool } from '../entrypoints/background/tools/browser/dismiss-overlay';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import { tabGroupManager } from '../entrypoints/background/tools/browser/tab-group-manager';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

describe('Live Taobao Session Fixes: Tab Grouping, Search Bar Autocomplete & Overlay Fast Dismissal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Problem A: Existing Tab Grouping Gap
  // =========================================================================
  describe('Problem A: Existing Tab Grouping Gap in chrome_navigate', () => {
    it('automatically adds existing tab to Agent tab group when autoGroup is not false', async () => {
      const existingTab = {
        id: 101,
        windowId: 10,
        url: 'https://www.taobao.com',
      };

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [existingTab]),
          get: vi.fn(async () => existingTab),
          update: vi.fn(async () => existingTab),
          onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        windows: {
          get: vi.fn(async () => ({ id: 10, focused: true })),
          update: vi.fn(async () => ({ id: 10, focused: true })),
        },
        storage: {
          local: { get: vi.fn(async () => ({})) },
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      const ensureGroupSpy = vi
        .spyOn(tabGroupManager, 'ensureAgentTabGroup')
        .mockResolvedValue(555);

      const res = await navigateTool.execute({
        url: 'https://www.taobao.com',
        autoGroup: true,
        groupTitle: '淘宝比价',
        groupColor: 'orange',
      });

      expect(res.isError).toBe(false);
      expect(ensureGroupSpy).toHaveBeenCalledWith(101, {
        title: '淘宝比价',
        color: 'orange',
        windowId: 10,
      });
    });

    it('does not group existing tab when autoGroup is explicitly false', async () => {
      const existingTab = {
        id: 102,
        windowId: 10,
        url: 'https://www.jd.com',
      };

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [existingTab]),
          get: vi.fn(async () => existingTab),
          update: vi.fn(async () => existingTab),
          onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        windows: {
          get: vi.fn(async () => ({ id: 10, focused: true })),
          update: vi.fn(async () => ({ id: 10, focused: true })),
        },
        storage: {
          local: { get: vi.fn(async () => ({})) },
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      const ensureGroupSpy = vi
        .spyOn(tabGroupManager, 'ensureAgentTabGroup')
        .mockResolvedValue(555);

      const res = await navigateTool.execute({
        url: 'https://www.jd.com',
        autoGroup: false,
      });

      expect(res.isError).toBe(false);
      expect(ensureGroupSpy).not.toHaveBeenCalled();
    });

    it('automatically groups tab during refresh when autoGroup is not false', async () => {
      const activeTab = {
        id: 103,
        windowId: 12,
        url: 'https://www.google.com',
        active: true,
      };

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [activeTab]),
          get: vi.fn(async () => activeTab),
          reload: vi.fn(async () => {}),
          onUpdated: {
            addListener: vi.fn((cb: any) => {
              cb(103, { status: 'complete' });
            }),
            removeListener: vi.fn(),
          },
        },
        windows: {
          get: vi.fn(async () => ({ id: 12, focused: true })),
          update: vi.fn(async () => ({ id: 12, focused: true })),
        },
        storage: {
          local: { get: vi.fn(async () => ({})) },
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      const ensureGroupSpy = vi
        .spyOn(tabGroupManager, 'ensureAgentTabGroup')
        .mockResolvedValue(555);

      const res = await navigateTool.execute({
        refresh: true,
        autoGroup: true,
      });

      expect(res.isError).toBe(false);
      expect(ensureGroupSpy).toHaveBeenCalledWith(103, {
        title: undefined,
        color: undefined,
        windowId: 12,
      });
    });

    it('supports history navigation with action: "back" when url is omitted', async () => {
      const activeTab = {
        id: 105,
        windowId: 10,
        url: 'https://example.com/subpage',
        active: true,
      };

      const goBackMock = vi.fn(async () => {});
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [activeTab]),
          get: vi.fn(async () => activeTab),
          goBack: goBackMock,
          onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        windows: {
          get: vi.fn(async () => ({ id: 10, focused: true })),
        },
        storage: {
          local: { get: vi.fn(async () => ({})) },
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      const res = await navigateTool.execute({
        action: 'back',
        tabId: 105,
      });

      expect(res.isError).toBe(false);
      expect(goBackMock).toHaveBeenCalledWith(105);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.success).toBe(true);
      expect(parsed.action).toBe('back');
    });

    it('returns clear diagnostic error when history navigation hits beginning of history', async () => {
      const activeTab = {
        id: 106,
        windowId: 10,
        url: 'https://example.com',
        active: true,
      };

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [activeTab]),
          get: vi.fn(async () => activeTab),
          goBack: vi.fn(async () => {
            throw new Error('Cannot go back.');
          }),
          onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        windows: {
          get: vi.fn(async () => ({ id: 10, focused: true })),
        },
        storage: {
          local: { get: vi.fn(async () => ({})) },
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      const res = await navigateTool.execute({
        action: 'back',
        tabId: 106,
      });

      expect(res.isError).toBe(true);
      expect((res.content[0] as any).text).toContain('already at the beginning of browsing history');
    });

    it('automatically groups tab and sets agent favicon when opening in new window with newWindow: true and autoGroup: true', async () => {
      const newWinTab = { id: 105, windowId: 99, url: 'https://www.taobao.com' };
      const newWin = { id: 99, tabs: [newWinTab] };

      (globalThis as any).chrome = {
        windows: {
          create: vi.fn(async () => newWin),
        },
        tabs: {
          query: vi.fn(async () => []),
          get: vi.fn(async () => newWinTab),
          onUpdated: {
            addListener: vi.fn((cb: any) => {
              cb(105, { status: 'complete' });
            }),
            removeListener: vi.fn(),
          },
        },
        runtime: {},
        storage: {
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      const ensureGroupSpy = vi.spyOn(tabGroupManager, 'ensureAgentTabGroup').mockResolvedValue(888);

      const res = await navigateTool.execute({
        url: 'https://www.taobao.com',
        newWindow: true,
        autoGroup: true,
        groupTitle: '新窗口任务',
        groupColor: 'cyan',
      });

      expect(res.isError).toBe(false);
      expect(ensureGroupSpy).toHaveBeenCalledWith(105, {
        title: '新窗口任务',
        color: 'cyan',
        windowId: 99,
      });
    });
  });

  // =========================================================================
  // Problem B: Search Bar Autocomplete & Submit Button Integration
  // =========================================================================
  describe('Problem B: Search Bar Autocomplete & Submit Button Integration', () => {
    it('detects Taobao-style search button with btn-search and tb-bg classes', () => {
      const searchBox = document.createElement('div');
      searchBox.className = 'search-box';

      const inputWrap = document.createElement('div');
      inputWrap.className = 'search-suggest-combobox';
      const input = document.createElement('input');
      input.className = 'search-suggest-combobox-input';
      input.placeholder = '搜索宝贝';
      input.value = '机械键盘';
      inputWrap.appendChild(input);

      const btn = document.createElement('button');
      btn.className = 'btn-search tb-bg';
      btn.textContent = '搜索';

      searchBox.appendChild(inputWrap);
      searchBox.appendChild(btn);
      document.body.appendChild(searchBox);

      getIsolatedIndexMap().set(1, input);
      getIsolatedIndexMap().set(2, btn);

      const res = inPageVerifyInputCommitment(1, '机械键盘');
      expect(res.committed).toBe(true);
      expect(res.submitButtonState?.found).toBe(true);
      expect(res.submitButtonState?.index).toBe(2);
      expect(res.submitButtonState?.text).toBe('搜索');
    });

    it('detects search button located 3 ancestor levels up with SVG icon', () => {
      const rootForm = document.createElement('div');
      rootForm.className = 'search-panel';

      const level1 = document.createElement('div');
      const level2 = document.createElement('div');
      const input = document.createElement('input');
      input.type = 'search';
      input.value = 'RTX 5090';
      level2.appendChild(input);
      level1.appendChild(level2);

      const btnWrap = document.createElement('div');
      const btn = document.createElement('button');
      btn.className = 'search-submit-btn';
      btn.innerHTML = '<svg class="search-icon"><title>Search</title></svg>';
      btnWrap.appendChild(btn);

      rootForm.appendChild(level1);
      rootForm.appendChild(btnWrap);
      document.body.appendChild(rootForm);

      getIsolatedIndexMap().set(5, input);
      getIsolatedIndexMap().set(8, btn);

      const res = inPageVerifyInputCommitment(5, 'RTX 5090');
      expect(res.committed).toBe(true);
      expect(res.submitButtonState?.found).toBe(true);
      expect(res.submitButtonState?.index).toBe(8);
    });

    it('automatically clicks detected submit button in 1 turn when pressEnter is consumed without URL change', async () => {
      const mockTab = {
        id: 201,
        url: 'https://www.taobao.com',
      };

      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [mockTab]),
          get: vi.fn(async () => mockTab), // URL does not change (autocomplete intercepted Enter)
        },
        storage: {
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      // Mock executeInPage
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => {
        if (fnName === 'inPageGetElementCoordinates') {
          return [{ result: { success: true, x: 100, y: 100, isSearch: true } }] as any;
        }
        if (fnName === 'inPageVerifyInputCommitment') {
          return [
            {
              result: {
                committed: true,
                submitButtonState: {
                  found: true,
                  index: 15,
                  text: '搜索',
                },
              },
            },
          ] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      const clickSpy = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ success: true, clicked: true }) }],
        isError: false,
      });

      const fillRes = await fillIndexTool.execute({
        index: 10,
        text: 'iPhone 17 Pro',
        pressEnter: true,
        tabId: 201,
        waitForSettle: false,
      });

      expect(fillRes.isError).toBe(false);
      const parsed = JSON.parse((fillRes.content[0] as any).text);

      // Verify that autocomplete fallback click was triggered automatically
      expect(clickSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 15,
          action: 'click',
          tabId: 201,
        }),
      );
      expect(parsed.submitted).toBe(true);
      expect(parsed.submitMethod).toBe('click');
      expect(parsed.submittedButtonIndex).toBe(15);
      expect(parsed.autoSubmitFallbackApplied).toBe(true);
    });

    it('records submitted: true and submitMethod: pressEnter when Enter results in URL change', async () => {
      const initialTab = { id: 202, url: 'https://www.google.com' };
      const navTab = { id: 202, url: 'https://www.google.com/search?q=test' };

      let callCount = 0;
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [initialTab]),
          get: vi.fn(async () => {
            callCount++;
            return callCount > 1 ? navTab : initialTab;
          }),
        },
        storage: {
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => {
        if (fnName === 'inPageGetElementCoordinates') {
          return [{ result: { success: true, x: 50, y: 50, isSearch: true } }] as any;
        }
        if (fnName === 'inPageVerifyInputCommitment') {
          return [{ result: { committed: true } }] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      const fillRes = await fillIndexTool.execute({
        index: 1,
        text: 'test',
        pressEnter: true,
        tabId: 202,
        waitForSettle: false,
      });

      expect(fillRes.isError).toBe(false);
      const parsed = JSON.parse((fillRes.content[0] as any).text);
      expect(parsed.submitted).toBe(true);
      expect(parsed.submitMethod).toBe('pressEnter');
      expect(parsed.urlChanged).toBe(true);
    });
  });

  // =========================================================================
  // Problem C: Overlay & Marketing Popup Fast Dismissal
  // =========================================================================
  describe('Problem C: Overlay & Marketing Popup Fast Dismissal (inPageDismissOverlays & chrome_dismiss_overlay)', () => {
    it('detects and dismisses visible marketing popup with "关闭" close button', () => {
      document.body.innerHTML = `
        <div id="page-content">
          <h1>Main Store Content</h1>
        </div>
        <div id="marketing-coupon-popup" class="coupon-popup-wrap" style="position: fixed; z-index: 10000; width: 400px; height: 500px;">
          <div class="coupon-title">恭喜获得 88VIP 消费券</div>
          <button class="btn-close tb-close">关闭</button>
        </div>
      `;

      const popup = document.getElementById('marketing-coupon-popup') as HTMLElement;
      Object.defineProperty(popup, 'offsetWidth', { configurable: true, value: 400 });
      Object.defineProperty(popup, 'offsetHeight', { configurable: true, value: 500 });
      const closeBtn = popup.querySelector('button') as HTMLElement;
      Object.defineProperty(closeBtn, 'offsetWidth', { configurable: true, value: 60 });
      Object.defineProperty(closeBtn, 'offsetHeight', { configurable: true, value: 30 });

      let clicked = false;
      closeBtn.addEventListener('click', () => {
        clicked = true;
        popup.style.display = 'none';
      });

      const result = inPageDismissOverlays();
      expect(clicked).toBe(true);
      expect(result.dismissedCount).toBe(1);
      expect(result.overlays[0].buttonText).toBe('关闭');
      expect(result.overlays[0].action).toBe('clicked_close_button');
    });

    it('detects and dismisses modal with aria-label="close" or English close text', () => {
      document.body.innerHTML = `
        <div role="dialog" class="promo-modal" style="position: fixed; z-index: 2000; width: 300px; height: 300px;">
          <h2>Special Discount</h2>
          <button aria-label="Close promotion dialog">×</button>
        </div>
      `;

      const modal = document.querySelector('.promo-modal') as HTMLElement;
      Object.defineProperty(modal, 'offsetWidth', { configurable: true, value: 300 });
      Object.defineProperty(modal, 'offsetHeight', { configurable: true, value: 300 });
      const closeBtn = modal.querySelector('button') as HTMLElement;
      Object.defineProperty(closeBtn, 'offsetWidth', { configurable: true, value: 24 });
      Object.defineProperty(closeBtn, 'offsetHeight', { configurable: true, value: 24 });

      let clicked = false;
      closeBtn.addEventListener('click', () => {
        clicked = true;
        modal.style.display = 'none';
      });

      const result = inPageDismissOverlays();
      expect(clicked).toBe(true);
      expect(result.dismissedCount).toBe(1);
      expect(result.overlays[0].buttonText).toContain('Close');
    });

    it('strictly avoids dismissing critical login dialogs with password input', () => {
      document.body.innerHTML = `
        <div role="dialog" class="login-modal" style="position: fixed; z-index: 5000; width: 400px; height: 400px;">
          <h2>Please Log In</h2>
          <input type="text" placeholder="Username" />
          <input type="password" placeholder="Password" />
          <button class="btn-close">关闭</button>
        </div>
      `;

      const modal = document.querySelector('.login-modal') as HTMLElement;
      Object.defineProperty(modal, 'offsetWidth', { configurable: true, value: 400 });
      Object.defineProperty(modal, 'offsetHeight', { configurable: true, value: 400 });

      const result = inPageDismissOverlays();
      expect(result.dismissedCount).toBe(0);
    });

    it('dispatches Escape key fallback when modal has role=dialog but no explicit close button', () => {
      document.body.innerHTML = `
        <div role="dialog" aria-label="Alert Dialog" class="overlay-dialog" style="position: fixed; z-index: 3000; width: 350px; height: 250px;">
          <p>Please review update details</p>
        </div>
      `;

      const modal = document.querySelector('.overlay-dialog') as HTMLElement;
      Object.defineProperty(modal, 'offsetWidth', { configurable: true, value: 350 });
      Object.defineProperty(modal, 'offsetHeight', { configurable: true, value: 250 });

      let escapeReceived = false;
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') escapeReceived = true;
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') escapeReceived = true;
      });

      const result = inPageDismissOverlays();
      expect(escapeReceived).toBe(true);
      expect(result.dismissedCount).toBe(1);
      expect(result.overlays[0].action).toBe('dispatched_escape');
    });

    it('executes chrome_dismiss_overlay tool and reports structured dismissal metrics', async () => {
      const mockTab = { id: 301, url: 'https://www.taobao.com' };
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [mockTab]),
          get: vi.fn(async () => mockTab),
        },
        storage: {
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        {
          result: {
            dismissedCount: 2,
            overlays: [
              { title: '天猫优惠券', buttonText: '关闭', action: 'clicked_close_button' },
              { title: 'Cookie Consent', buttonText: 'Dismiss', action: 'clicked_close_button' },
            ],
          },
        },
      ] as any);

      const res = await dismissOverlayTool.execute({
        tabId: 301,
        waitForSettle: false,
      });

      expect(res.isError).toBe(false);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.success).toBe(true);
      expect(parsed.dismissedCount).toBe(2);
      expect(parsed.overlays.length).toBe(2);
      expect(parsed.message).toContain('Successfully dismissed 2 overlay(s)');
    });

    it('triggers overlay dismissal in chrome_read_dom when dismissOverlays: true', async () => {
      const mockTab = { id: 302, url: 'https://www.taobao.com' };
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [mockTab]),
          get: vi.fn(async () => mockTab),
        },
        storage: {
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      const inPageSpy = vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => {
        if (fnName === 'inPageDismissOverlays') {
          return [{ result: { dismissedCount: 1, overlays: [] } }] as any;
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              result: {
                treeString: '[1] button "Search"',
                indexedElements: [],
                scrollInfo: { pages_up: 0, pages_down: 0 },
              },
            },
          ] as any;
        }
        return [{ result: {} }] as any;
      });

      const res = await readDOMTool.execute({
        tabId: 302,
        dismissOverlays: true,
      });

      expect(res.isError).toBe(false);
      expect(inPageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 302 }),
        'inPageDismissOverlays',
        [],
      );
    });

    it('prioritizes real close button over preceding informational span mentioning "关闭"', () => {
      document.body.innerHTML = `
        <div id="marketing-popup" class="coupon-dialog" style="position: fixed; z-index: 10000; width: 400px; height: 500px;">
          <div class="header">
            <span>限时优惠券，关闭前请知悉相关说明</span>
          </div>
          <div class="content">
            <p>红包即刻可用</p>
          </div>
          <button class="close-btn">关闭</button>
        </div>
      `;

      const popup = document.getElementById('marketing-popup') as HTMLElement;
      Object.defineProperty(popup, 'offsetWidth', { configurable: true, value: 400 });
      Object.defineProperty(popup, 'offsetHeight', { configurable: true, value: 500 });
      const span = popup.querySelector('span') as HTMLElement;
      Object.defineProperty(span, 'offsetWidth', { configurable: true, value: 200 });
      Object.defineProperty(span, 'offsetHeight', { configurable: true, value: 20 });
      const button = popup.querySelector('button') as HTMLElement;
      Object.defineProperty(button, 'offsetWidth', { configurable: true, value: 50 });
      Object.defineProperty(button, 'offsetHeight', { configurable: true, value: 30 });

      let buttonClicked = false;
      let spanClicked = false;
      button.addEventListener('click', () => {
        buttonClicked = true;
        popup.style.display = 'none';
      });
      span.addEventListener('click', () => {
        spanClicked = true;
      });

      const result = inPageDismissOverlays();
      expect(buttonClicked).toBe(true);
      expect(spanClicked).toBe(false);
      expect(result.dismissedCount).toBe(1);
      expect(result.overlays[0].buttonText).toBe('关闭');
      expect(result.overlays[0].dismissed).toBe(true);
      expect(result.overlays[0].needsPhysicalFallback).toBe(false);
    });

    it('deduplicates dismissal between nested modal container and its backdrop mask', () => {
      document.body.innerHTML = `
        <div id="modal-mask" class="modal-backdrop mask" style="position: fixed; z-index: 10000; width: 1000px; height: 800px;">
          <div id="modal-dialog" class="modal-container dialog" style="position: absolute; z-index: 10001; width: 400px; height: 300px;">
            <button class="btn-close">×</button>
          </div>
        </div>
      `;

      const mask = document.getElementById('modal-mask') as HTMLElement;
      const dialog = document.getElementById('modal-dialog') as HTMLElement;
      const btn = dialog.querySelector('button') as HTMLElement;
      Object.defineProperty(mask, 'offsetWidth', { configurable: true, value: 1000 });
      Object.defineProperty(mask, 'offsetHeight', { configurable: true, value: 800 });
      Object.defineProperty(dialog, 'offsetWidth', { configurable: true, value: 400 });
      Object.defineProperty(dialog, 'offsetHeight', { configurable: true, value: 300 });
      Object.defineProperty(btn, 'offsetWidth', { configurable: true, value: 24 });
      Object.defineProperty(btn, 'offsetHeight', { configurable: true, value: 24 });

      let clickCount = 0;
      btn.addEventListener('click', () => {
        clickCount++;
        dialog.style.display = 'none';
        mask.style.display = 'none';
      });

      const result = inPageDismissOverlays();
      expect(clickCount).toBe(1);
      expect(result.dismissedCount).toBe(1);
    });

    it('detects camelCase closeBtn and Alibaba next-dialog-close class names', () => {
      document.body.innerHTML = `
        <div class="next-overlay-wrapper modal" style="position: fixed; z-index: 9999; width: 350px; height: 300px;">
          <div class="next-dialog-close">
            <button class="closeBtn" aria-label="关闭">×</button>
          </div>
        </div>
      `;

      const wrapper = document.querySelector('.next-overlay-wrapper') as HTMLElement;
      const btn = wrapper.querySelector('button') as HTMLElement;
      Object.defineProperty(wrapper, 'offsetWidth', { configurable: true, value: 350 });
      Object.defineProperty(wrapper, 'offsetHeight', { configurable: true, value: 300 });
      Object.defineProperty(btn, 'offsetWidth', { configurable: true, value: 24 });
      Object.defineProperty(btn, 'offsetHeight', { configurable: true, value: 24 });

      let clicked = false;
      btn.addEventListener('click', () => {
        clicked = true;
        wrapper.style.display = 'none';
      });

      const result = inPageDismissOverlays();
      expect(clicked).toBe(true);
      expect(result.dismissedCount).toBe(1);
      expect(result.overlays[0].dismissed).toBe(true);
      expect(result.overlays[0].needsPhysicalFallback).toBe(false);
    });

    it('reports dismissedCount: 0 and needsPhysicalFallback: true when synthetic click fails to close overlay (BUG-17 contract)', () => {
      document.body.innerHTML = `
        <div class="stubborn-modal" style="position: fixed; z-index: 9999; width: 350px; height: 300px;">
          <button class="close-btn" aria-label="关闭">×</button>
        </div>
      `;
      const modal = document.querySelector('.stubborn-modal') as HTMLElement;
      const btn = modal.querySelector('button') as HTMLElement;
      Object.defineProperty(modal, 'offsetWidth', { configurable: true, value: 350 });
      Object.defineProperty(modal, 'offsetHeight', { configurable: true, value: 300 });
      Object.defineProperty(btn, 'offsetWidth', { configurable: true, value: 24 });
      Object.defineProperty(btn, 'offsetHeight', { configurable: true, value: 24 });

      let clicked = false;
      // Event dispatched but modal does NOT close (e.g. requires isTrusted true)
      btn.addEventListener('click', () => {
        clicked = true;
      });

      const result = inPageDismissOverlays();
      expect(clicked).toBe(true);
      expect(result.dismissedCount).toBe(0);
      expect(result.overlays[0].dismissed).toBe(false);
      expect(result.overlays[0].needsPhysicalFallback).toBe(true);
    });

    it('triggers overlay dismissal in chrome_navigate when dismissOverlays: true', async () => {
      const mockTab = { id: 303, url: 'https://www.taobao.com', windowId: 5 };
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [mockTab]),
          get: vi.fn(async () => mockTab),
          update: vi.fn(async () => mockTab),
          onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        windows: {
          get: vi.fn(async () => ({ id: 5, focused: true })),
          update: vi.fn(async () => ({ id: 5, focused: true })),
        },
        storage: {
          local: { get: vi.fn(async () => ({})) },
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      const inPageSpy = vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { result: { dismissedCount: 1, overlays: [] } },
      ] as any);

      const res = await navigateTool.execute({
        url: 'https://www.taobao.com',
        dismissOverlays: true,
      });

      expect(res.isError).toBe(false);
      expect(inPageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 303 }),
        'inPageDismissOverlays',
        [],
      );
    });
  });
});
