import { describe, it, expect, beforeEach } from 'vitest';
import {
  findIndexedElement,
  getIsolatedIndexMap,
  renderCompactElementLine,
  inPageDOMPruner,
  inPageFillIndex,
  type IndexedElement,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('DOM Self-Healing & Visual Shape Decoding', () => {
  beforeEach(() => {
    getIsolatedIndexMap().clear();
    document.body.innerHTML = '';
  });

  it('self-heals an element reference when React re-renders and replaces the DOM node', () => {
    const prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 110,
        bottom: 60,
        width: 100,
        height: 50,
        toJSON: () => ({}),
      } as DOMRect;
    };

    try {
      // 1. Initial render: button with id "submit-btn"
      const oldBtn = document.createElement('button');
      oldBtn.id = 'submit-btn';
      oldBtn.innerText = 'Submit';
      document.body.appendChild(oldBtn);

      // Prune and index
      inPageDOMPruner();
      const isolatedMap = getIsolatedIndexMap();
      expect(isolatedMap.size).toBeGreaterThan(0);

      // Find assigned index for submit-btn
      let targetIndex = 0;
      for (const [idx, ref] of isolatedMap.entries()) {
        const el = ref?.deref ? ref.deref() : ref;
        if (el?.id === 'submit-btn') {
          targetIndex = idx;
          break;
        }
      }
      expect(targetIndex).toBeGreaterThan(0);
      expect(findIndexedElement(targetIndex)).toBe(oldBtn);

      // 2. Simulate React component re-render: oldBtn is destroyed, newBtn is created
      oldBtn.remove();
      const newBtn = document.createElement('button');
      newBtn.id = 'submit-btn';
      newBtn.innerText = 'Submit (Updated)';
      document.body.appendChild(newBtn);

      // 3. Old element in isolatedMap is disconnected: stale index is invalidated
      const stale = findIndexedElement(targetIndex);
      expect(stale).toBeNull();

      // 4. Must re-observe DOM to acquire new index for the updated node
      inPageDOMPruner();
      let newTargetIndex = 0;
      for (const [idx, ref] of isolatedMap.entries()) {
        const el = ref?.deref ? ref.deref() : ref;
        if (el?.id === 'submit-btn') {
          newTargetIndex = idx;
          break;
        }
      }
      expect(newTargetIndex).toBeGreaterThan(0);
      const updated = findIndexedElement(newTargetIndex);
      expect(updated).toBe(newBtn);
      expect(updated?.innerText).toBe('Submit (Updated)');
    } finally {
      Element.prototype.getBoundingClientRect = prevRect;
    }
  });

  it('decodes visual geometric shapes from transformed CSS styling in compact tree lines', () => {
    const el: IndexedElement = {
      index: 12,
      tagName: 'button',
      text: 'ACTION',
      attributes: {
        id: 'btn-1',
        'visual-shape': 'diamond',
      },
      rect: { x: 0, y: 0, width: 50, height: 50 },
    };

    const line = renderCompactElementLine(el);
    expect(line).toContain('[12] button "ACTION" #btn-1');
    expect(line).toContain('shape="diamond"');
  });

  it('automatically normalizes physical device coordinates from high-DPI Windows screens', async () => {
    const { parseUnifiedCoordinate } = await import('../utils/coordinate-parser');
    const { screenshotContextManager } = await import('../utils/screenshot-context');

    const testTabId = 9988;
    // Set up a high-DPI context: CSS viewport is 1280x800, but devicePixelRatio is 1.5 (physical: 1920x1200)
    screenshotContextManager.setContext(testTabId, {
      screenshotWidth: 1280,
      screenshotHeight: 800,
      viewportWidth: 1280,
      viewportHeight: 800,
      devicePixelRatio: 1.5,
    });

    // Vision model sent physical coordinate x: 1500 (which exceeds CSS viewport 1280, but within physical 1920)
    const parsed = parseUnifiedCoordinate({ x: 1500, y: 600 }, { tabId: testTabId });
    expect(parsed).not.toBeNull();
    // 1500 / 1920 * 1280 = 1000 CSS px!
    expect(parsed?.x).toBe(1000);
    expect(parsed?.y).toBe(400);
  });

  it('self-heals an element reference using aria-label when React re-renders', () => {
    const prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 20,
        y: 20,
        left: 20,
        top: 20,
        right: 120,
        bottom: 70,
        width: 100,
        height: 50,
        toJSON: () => ({}),
      } as DOMRect;
    };

    try {
      // 1. Render icon button with aria-label but without id
      const oldIconBtn = document.createElement('button');
      oldIconBtn.setAttribute('aria-label', 'Close Dialog');
      document.body.appendChild(oldIconBtn);

      inPageDOMPruner();
      const isolatedMap = getIsolatedIndexMap();
      let targetIndex = 0;
      for (const [idx, ref] of isolatedMap.entries()) {
        const el = ref?.deref ? ref.deref() : ref;
        if (el?.getAttribute('aria-label') === 'Close Dialog') {
          targetIndex = idx;
          break;
        }
      }
      expect(targetIndex).toBeGreaterThan(0);
      expect(findIndexedElement(targetIndex)).toBe(oldIconBtn);

      // 2. React re-renders: old button replaced by a new button with same aria-label
      oldIconBtn.remove();
      const newIconBtn = document.createElement('button');
      newIconBtn.setAttribute('aria-label', 'Close Dialog');
      document.body.appendChild(newIconBtn);

      // 3. Stale index is invalidated
      const stale = findIndexedElement(targetIndex);
      expect(stale).toBeNull();

      // 4. Must re-observe DOM to acquire new index
      inPageDOMPruner();
      let newTargetIndex = 0;
      for (const [idx, ref] of isolatedMap.entries()) {
        const el = ref?.deref ? ref.deref() : ref;
        if (el?.getAttribute('aria-label') === 'Close Dialog') {
          newTargetIndex = idx;
          break;
        }
      }
      expect(newTargetIndex).toBeGreaterThan(0);
      const updated = findIndexedElement(newTargetIndex);
      expect(updated).toBe(newIconBtn);
    } finally {
      Element.prototype.getBoundingClientRect = prevRect;
    }
  });

  it('sets checkbox checked property correctly via inPageFillIndex', () => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'terms-cb';
    cb.checked = false;
    document.body.appendChild(cb);

    const prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 20,
        bottom: 20,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      } as DOMRect;
    };

    try {
      inPageDOMPruner();
      const isolatedMap = getIsolatedIndexMap();
      let cbIndex = 0;
      for (const [idx, ref] of isolatedMap.entries()) {
        const el = ref?.deref ? ref.deref() : ref;
        if (el?.id === 'terms-cb') {
          cbIndex = idx;
          break;
        }
      }
      expect(cbIndex).toBeGreaterThan(0);

      // Fill with 'true'
      const resTrue = inPageFillIndex(cbIndex, 'true');
      expect(resTrue.success).toBe(true);
      expect(cb.checked).toBe(true);

      // Fill with 'false'
      const resFalse = inPageFillIndex(cbIndex, 'false');
      expect(resFalse.success).toBe(true);
      expect(cb.checked).toBe(false);

      // Test polymorphic ref format (e.g. 'ref_123' or '123')
      const resPoly = inPageFillIndex(`ref_${cbIndex}`, 'true');
      expect(resPoly.success).toBe(true);
      expect(cb.checked).toBe(true);
    } finally {
      Element.prototype.getBoundingClientRect = prevRect;
    }
  });

  it('detects visible captcha challenges while ignoring hidden captcha stubs', async () => {
    const { inPageCheckCaptcha } =
      await import('../entrypoints/background/tools/browser/dom-indexer');

    // 1. Inactive/hidden captcha stub (e.g. preloaded in DOM with display: none)
    const hiddenCaptcha = document.createElement('div');
    hiddenCaptcha.id = 'captcha_modal';
    hiddenCaptcha.style.display = 'none';
    document.body.appendChild(hiddenCaptcha);

    // Initial check: hidden stub must NOT trigger false positive
    const check1 = inPageCheckCaptcha();
    expect(check1.detected).toBe(false);

    // 2. Active visible turnstile challenge
    const activeTurnstile = document.createElement('div');
    activeTurnstile.className = 'cf-turnstile';
    activeTurnstile.style.display = 'block';
    Object.defineProperty(activeTurnstile, 'offsetWidth', { value: 300, configurable: true });
    Object.defineProperty(activeTurnstile, 'offsetHeight', { value: 65, configurable: true });
    document.body.appendChild(activeTurnstile);

    const check2 = inPageCheckCaptcha();
    expect(check2.detected).toBe(true);
    expect(check2.type).toBe('.cf-turnstile');
  });

  it('correctly identifies restricted URLs including modern Chrome Web Store and cloud metadata', async () => {
    const { isRestrictedChromeUrl, isCloudMetadataUrl } = await import('../utils/restricted-url');

    // Web store & internal schemes
    expect(isRestrictedChromeUrl('https://chromewebstore.google.com/detail/123')).toBe(true);
    expect(isRestrictedChromeUrl('https://chrome.google.com/webstore/detail/123')).toBe(true);
    expect(isRestrictedChromeUrl('chrome://extensions')).toBe(true);
    expect(isRestrictedChromeUrl('edge://settings')).toBe(true);
    expect(isRestrictedChromeUrl('devtools://devtools/bundled/inspector.html')).toBe(true);
    expect(isRestrictedChromeUrl('chrome-extension://abcdef/popup.html')).toBe(true);
    expect(isRestrictedChromeUrl('view-source:https://example.com')).toBe(true);

    // Cloud metadata endpoints
    expect(isCloudMetadataUrl('http://169.254.169.254/latest/meta-data')).toBe(true);
    expect(isCloudMetadataUrl('http://169.254.169.253/latest/meta-data')).toBe(true);
    expect(isCloudMetadataUrl('http://100.100.100.200/latest/meta-data')).toBe(true);
    expect(isCloudMetadataUrl('http://169.254.0.2/opc/v1/instance/')).toBe(true);
    expect(isCloudMetadataUrl('http://instance-data/latest/meta-data')).toBe(true);
    expect(isCloudMetadataUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(true);

    // Normal safe web URLs
    expect(isRestrictedChromeUrl('https://github.com')).toBe(false);
    expect(isRestrictedChromeUrl('https://google.com')).toBe(false);
    expect(isCloudMetadataUrl('https://example.com')).toBe(false);
  });
});
