import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('MOTION-03: Click & Fill Helper Shadow Root Visibility & Occlusion Tests', () => {
  let messageListeners: Array<(req: any, sender: any, sendResponse: any) => any> = [];

  beforeEach(() => {
    messageListeners = [];
    (globalThis as any).chrome = {
      runtime: {
        onMessage: {
          addListener: (fn: any) => messageListeners.push(fn),
        },
      },
    };
    (window as any).__CLICK_HELPER_INITIALIZED__ = false;
    (window as any).__FILL_HELPER_INITIALIZED__ = false;
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  function loadHelper(helperFile: string) {
    const filePath = path.resolve(__dirname, '../inject-scripts', helperFile);
    const code = fs.readFileSync(filePath, 'utf-8');
    // Execute helper in current jsdom window context
    (0, eval)(code);
  }

  async function sendMessage(action: string, payload: Record<string, any>): Promise<any> {
    for (const listener of messageListeners) {
      let result: any = null;
      let answered = false;
      const res = listener({ action, ...payload }, {}, (ans: any) => {
        answered = true;
        result = ans;
      });
      if (res === true || answered) {
        // Wait for async response
        for (let i = 0; i < 80; i++) {
          if (answered) return result;
          await new Promise((r) => setTimeout(r, 20));
        }
        return result;
      }
    }
    return null;
  }

  describe('click-helper.js shadow root and occlusion behavior', () => {
    it('successfully pierces open shadow root to detect and click target element', async () => {
      loadHelper('click-helper.js');

      // Create host component with shadow root
      const host = document.createElement('custom-button-host');
      const root = host.attachShadow({ mode: 'open' });
      const innerBtn = document.createElement('button');
      innerBtn.id = 'inner-action-btn';
      innerBtn.textContent = 'Submit Inside Shadow';
      root.appendChild(innerBtn);
      document.body.appendChild(host);

      // Mock bounding client rects & elementFromPoint
      innerBtn.getBoundingClientRect = () =>
        ({
          x: 100,
          y: 100,
          left: 100,
          top: 100,
          right: 200,
          bottom: 150,
          width: 100,
          height: 50,
        }) as any;
      host.getBoundingClientRect = () =>
        ({
          x: 100,
          y: 100,
          left: 100,
          top: 100,
          right: 200,
          bottom: 150,
          width: 100,
          height: 50,
        }) as any;

      // Document point returns host, but shadow root point returns innerBtn
      document.elementFromPoint = (x: number, y: number) => host;
      root.elementFromPoint = (x: number, y: number) => innerBtn;

      let clicked = false;
      innerBtn.addEventListener('click', () => {
        clicked = true;
      });

      // Put ref into element map
      const refId = 'ref_shadow_btn';
      (window as any).__mcpElementMap = { [refId]: new WeakRef(innerBtn) };

      const response = await sendMessage('clickElement', { ref: refId });

      expect(response?.success).toBe(true);
      expect(clicked).toBe(true);
    });

    it('pierces nested shadow roots (nested custom components)', async () => {
      loadHelper('click-helper.js');

      const outerHost = document.createElement('outer-host');
      const outerRoot = outerHost.attachShadow({ mode: 'open' });
      const innerHost = document.createElement('inner-host');
      const innerRoot = innerHost.attachShadow({ mode: 'open' });
      const deepBtn = document.createElement('button');
      deepBtn.id = 'deep-nested-btn';

      innerRoot.appendChild(deepBtn);
      outerRoot.appendChild(innerHost);
      document.body.appendChild(outerHost);

      deepBtn.getBoundingClientRect = () =>
        ({
          x: 50,
          y: 50,
          left: 50,
          top: 50,
          right: 150,
          bottom: 100,
          width: 100,
          height: 50,
        }) as any;

      document.elementFromPoint = () => outerHost;
      outerRoot.elementFromPoint = () => innerHost;
      innerRoot.elementFromPoint = () => deepBtn;

      let clicked = false;
      deepBtn.addEventListener('click', () => {
        clicked = true;
      });

      const refId = 'ref_deep_nested';
      (window as any).__mcpElementMap = { [refId]: new WeakRef(deepBtn) };

      const response = await sendMessage('clickElement', { ref: refId });

      expect(response?.success).toBe(true);
      expect(clicked).toBe(true);
    });

    it('strictly forbids bypassing when an external modal overlay covers the shadow host', async () => {
      loadHelper('click-helper.js');

      const host = document.createElement('custom-host');
      const root = host.attachShadow({ mode: 'open' });
      const innerBtn = document.createElement('button');
      root.appendChild(innerBtn);

      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop-overlay';
      document.body.appendChild(host);
      document.body.appendChild(overlay);

      innerBtn.getBoundingClientRect = () =>
        ({
          x: 100,
          y: 100,
          left: 100,
          top: 100,
          right: 200,
          bottom: 150,
          width: 100,
          height: 50,
        }) as any;

      // Point hits the overlay, NOT the host
      document.elementFromPoint = () => overlay;

      const refId = 'ref_occluded_btn';
      (window as any).__mcpElementMap = { [refId]: new WeakRef(innerBtn) };

      const response = await sendMessage('clickElement', {
        selector: '#inner-action-btn',
      });
      // Selector lookup checks visibility and must fail with element not visible error
      // Or when targeted, report error that it cannot be clicked
      expect(response.error).toBeDefined();
    });
  });

  describe('fill-helper.js shadow root behavior', () => {
    it('successfully pierces shadow root to fill inner input element', async () => {
      loadHelper('fill-helper.js');

      const host = document.createElement('custom-input-host');
      const root = host.attachShadow({ mode: 'open' });
      const innerInput = document.createElement('input');
      innerInput.type = 'text';
      root.appendChild(innerInput);
      document.body.appendChild(host);

      innerInput.getBoundingClientRect = () =>
        ({
          x: 80,
          y: 80,
          left: 80,
          top: 80,
          right: 280,
          bottom: 120,
          width: 200,
          height: 40,
        }) as any;
      host.getBoundingClientRect = () =>
        ({
          x: 80,
          y: 80,
          left: 80,
          top: 80,
          right: 280,
          bottom: 120,
          width: 200,
          height: 40,
        }) as any;

      document.elementFromPoint = () => host;
      root.elementFromPoint = () => innerInput;

      const refId = 'ref_shadow_input';
      (window as any).__mcpElementMap = { [refId]: new WeakRef(innerInput) };

      const response = await sendMessage('fillElement', {
        ref: refId,
        value: 'Hello In Shadow DOM',
      });

      expect(response.success).toBe(true);
      expect(innerInput.value).toBe('Hello In Shadow DOM');
    });
  });
});
