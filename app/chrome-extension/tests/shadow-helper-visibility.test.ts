import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deepElementFromPoint,
  interceptingElementAtPoint,
  querySelectorDeep,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('Shadow Root Visibility & Helper Suite', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('active shadow DOM piercing and occlusion behavior', () => {
    it('successfully pierces open shadow root to detect target element', () => {
      const host = document.createElement('custom-button-host');
      const root = host.attachShadow({ mode: 'open' });
      const innerBtn = document.createElement('button');
      innerBtn.id = 'inner-action-btn';
      innerBtn.textContent = 'Submit Inside Shadow';
      root.appendChild(innerBtn);
      document.body.appendChild(host);

      document.elementFromPoint = () => host;
      root.elementFromPoint = () => innerBtn;

      const hit = deepElementFromPoint(100, 100);
      expect(hit).toBe(innerBtn);

      const found = querySelectorDeep('#inner-action-btn', document);
      expect(found).toBe(innerBtn);
    });

    it('pierces nested shadow roots (nested custom components)', () => {
      const outerHost = document.createElement('outer-host');
      const outerRoot = outerHost.attachShadow({ mode: 'open' });
      const innerHost = document.createElement('inner-host');
      const innerRoot = innerHost.attachShadow({ mode: 'open' });
      const deepBtn = document.createElement('button');
      deepBtn.id = 'deep-nested-btn';

      innerRoot.appendChild(deepBtn);
      outerRoot.appendChild(innerHost);
      document.body.appendChild(outerHost);

      document.elementFromPoint = () => outerHost;
      outerRoot.elementFromPoint = () => innerHost;
      innerRoot.elementFromPoint = () => deepBtn;

      const hit = deepElementFromPoint(50, 50);
      expect(hit).toBe(deepBtn);

      const found = querySelectorDeep('#deep-nested-btn', document);
      expect(found).toBe(deepBtn);
    });

    it('strictly detects occlusion when an external modal overlay covers the shadow host', () => {
      const host = document.createElement('custom-host');
      const root = host.attachShadow({ mode: 'open' });
      const innerBtn = document.createElement('button');
      root.appendChild(innerBtn);

      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop-overlay';
      document.body.appendChild(host);
      document.body.appendChild(overlay);

      // Point hits overlay, not shadow host
      document.elementFromPoint = () => overlay;

      const hit = deepElementFromPoint(100, 100);
      expect(hit).toBe(overlay);

      const blocker = interceptingElementAtPoint(innerBtn, 100, 100);
      expect(blocker).toBe(overlay);
    });

    it('pierces shadow root to locate form input elements', () => {
      const host = document.createElement('custom-input-host');
      const root = host.attachShadow({ mode: 'open' });
      const innerInput = document.createElement('input');
      innerInput.type = 'text';
      innerInput.id = 'shadow-input-field';
      root.appendChild(innerInput);
      document.body.appendChild(host);

      document.elementFromPoint = () => host;
      root.elementFromPoint = () => innerInput;

      const hit = deepElementFromPoint(80, 80);
      expect(hit).toBe(innerInput);

      const found = querySelectorDeep('input[type="text"]', document);
      expect(found).toBe(innerInput);

      innerInput.value = 'Hello In Shadow DOM';
      expect(innerInput.value).toBe('Hello In Shadow DOM');
    });
  });
});
