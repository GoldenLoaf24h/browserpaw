import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  indexElement,
  getIsolatedIndexMap,
  inPageWaitForActionable,
  safeClickPointWeakMap,
  actionPointForElement,
  getStickyOcclusionMargins,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('sticky chrome does not move target coordinates outside its own controls', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps a shadow button inside its own sticky header', () => {
    const header = document.createElement('header');
    header.style.position = 'sticky';
    attachBox(header, window.innerWidth, 80, 0, 0);
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    attachBox(button, 60, 32, 900, 20);
    root.append(button);
    header.append(host);
    document.body.append(header);

    expect(getStickyOcclusionMargins(window).top).toBe(80);
    expect(actionPointForElement(button)).toEqual({ x: 930, y: 36 });
  });

  it('never invents a point below a target covered by another sticky header', () => {
    const header = document.createElement('header');
    header.style.position = 'fixed';
    attachBox(header, window.innerWidth, 80, 0, 0);
    const button = document.createElement('button');
    attachBox(button, 60, 32, 900, 20);
    document.body.append(header, button);

    const point = actionPointForElement(button)!;
    expect(point.y).toBeGreaterThanOrEqual(20);
    expect(point.y).toBeLessThanOrEqual(52);
  });
});

function attachBox(el: HTMLElement, width = 100, height = 40, x = 100, y = 200) {
  el.getBoundingClientRect = () => ({
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => {},
  });
}

describe('inPageWaitForActionable pre-flight & stability watchdog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    const g = globalThis as any;
    delete g[Symbol.for('__browser_use_index_identity__')];
    delete g[Symbol.for('__browser_use_index_namespace__')];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
  });

  describe('1. Static element 2-frame geometric stability', () => {
    it('verifies stability over 2 consecutive frames and resolves live coordinates without extra scroll', async () => {
      const btn = document.createElement('button');
      btn.id = 'static-btn';
      btn.textContent = 'Submit';
      attachBox(btn, 80, 40, 100, 200);
      document.body.appendChild(btn);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click', 500);

      expect(res.success).toBe(true);
      expect(res.actionable).toBe(true);
      expect(res.stableFrames).toBeGreaterThanOrEqual(2);
      expect(res.x).toBe(140);
      expect(res.y).toBe(220);
      expect(res.width).toBe(80);
      expect(res.height).toBe(40);
      expect((res as any).details).toBeUndefined();
    });

    it('preserves safeClickPoint offset and does not collapse back to raw geometric center', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Safe Point Button';
      attachBox(btn, 80, 40, 100, 200);
      document.body.appendChild(btn);

      // Explicitly register an off-center safe click point
      safeClickPointWeakMap.set(btn, { offsetX: 15, offsetY: 25 } as any);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click', 500);

      expect(res.success).toBe(true);
      expect(res.actionable).toBe(true);
      // Expected safe point is left(100) + offsetX(15) = 115, top(200) + offsetY(25) = 225
      // If collapsed back to simple center it would be 140, 220
      expect(res.x).toBe(115);
      expect(res.y).toBe(225);
    });
  });

  describe('2. Dynamic movement and settling', () => {
    it('settles within bounded timeout after brief movement', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Moving Then Stop';
      let callCount = 0;
      btn.getBoundingClientRect = () => {
        callCount++;
        const posX = callCount <= 2 ? 100 + callCount * 10 : 150;
        return {
          x: posX,
          y: 200,
          left: posX,
          top: 200,
          right: posX + 80,
          bottom: 240,
          width: 80,
          height: 40,
          toJSON: () => {},
        };
      };
      document.body.appendChild(btn);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click', 600);

      expect(res.success).toBe(true);
      expect(res.actionable).toBe(true);
      expect(res.stableFrames).toBeGreaterThanOrEqual(2);
      expect(res.x).toBe(190);
    });

    it('fails with reason unstable when continuously moving beyond timeout without clicking', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Endlessly Moving';
      let posX = 100;
      btn.getBoundingClientRect = () => {
        posX += 5;
        return {
          x: posX,
          y: 200,
          left: posX,
          top: 200,
          right: posX + 80,
          bottom: 240,
          width: 80,
          height: 40,
          toJSON: () => {},
        };
      };
      document.body.appendChild(btn);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click', 120);

      expect(res.success).toBe(false);
      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('unstable');
      expect(res.error).toContain('geometry did not stabilize');
    });
  });

  describe('3. Connectedness and Detachment', () => {
    it('rejects disconnected element already removed from DOM', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Detached';
      attachBox(btn);
      document.body.appendChild(btn);

      const idx = indexElement(btn);
      btn.remove();

      const res = await inPageWaitForActionable(idx, 'click');
      expect(res.success).toBe(false);
      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('disconnected');
    });

    it('rejects when element is detached during stability wait', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Detached Mid-Wait';
      let calls = 0;
      btn.getBoundingClientRect = () => {
        calls++;
        if (calls === 2) {
          btn.remove();
        }
        return {
          x: 100,
          y: 200,
          left: 100,
          top: 200,
          right: 180,
          bottom: 240,
          width: 80,
          height: 40,
          toJSON: () => {},
        };
      };
      document.body.appendChild(btn);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click', 300);

      expect(res.success).toBe(false);
      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('disconnected');
    });
  });

  describe('4. Hidden and Zero-Size Elements', () => {
    it('rejects element with display: none or hidden attribute', async () => {
      const btn1 = document.createElement('button');
      btn1.style.display = 'none';
      attachBox(btn1);
      document.body.appendChild(btn1);
      const idx1 = indexElement(btn1);

      const res1 = await inPageWaitForActionable(idx1, 'click');
      expect(res1.actionable).toBe(false);
      expect(res1.reason).toBe('hidden');

      const btn2 = document.createElement('button');
      btn2.setAttribute('hidden', '');
      attachBox(btn2);
      document.body.appendChild(btn2);
      const idx2 = indexElement(btn2);

      const res2 = await inPageWaitForActionable(idx2, 'click');
      expect(res2.actionable).toBe(false);
      expect(res2.reason).toBe('hidden');
    });

    it('rejects element when either dimension is <= 0', async () => {
      const btnWidthZero = document.createElement('button');
      attachBox(btnWidthZero, 0, 40);
      document.body.appendChild(btnWidthZero);
      const idx1 = indexElement(btnWidthZero);

      const res1 = await inPageWaitForActionable(idx1, 'click');
      expect(res1.actionable).toBe(false);
      expect(res1.reason).toBe('hidden');

      const btnHeightZero = document.createElement('button');
      attachBox(btnHeightZero, 100, 0);
      document.body.appendChild(btnHeightZero);
      const idx2 = indexElement(btnHeightZero);

      const res2 = await inPageWaitForActionable(idx2, 'click');
      expect(res2.actionable).toBe(false);
      expect(res2.reason).toBe('hidden');
    });

    it('respects child visible override under visibility:hidden ancestor', async () => {
      const parent = document.createElement('div');
      parent.style.visibility = 'hidden';
      const child = document.createElement('button');
      child.style.visibility = 'visible';
      child.textContent = 'Visible Child';
      attachBox(child);
      parent.appendChild(child);
      document.body.appendChild(parent);

      const idx = indexElement(child);
      const res = await inPageWaitForActionable(idx, 'click');
      expect(res.actionable).toBe(true);
      expect(res.success).toBe(true);
    });
  });

  describe('5. Fieldset disabled and legend exception', () => {
    it('rejects controls inside disabled fieldset via native :disabled', async () => {
      const fieldset = document.createElement('fieldset');
      fieldset.setAttribute('disabled', '');
      const btn = document.createElement('button');
      btn.textContent = 'Disabled by fieldset';
      attachBox(btn);
      fieldset.appendChild(btn);
      document.body.appendChild(fieldset);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click');
      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('disabled');
    });

    it('allows controls inside the first legend of a disabled fieldset (HTML spec exception)', async () => {
      const fieldset = document.createElement('fieldset');
      fieldset.setAttribute('disabled', '');

      const legend = document.createElement('legend');
      const legendBtn = document.createElement('button');
      legendBtn.textContent = 'Active in First Legend';
      attachBox(legendBtn, 100, 40, 50, 50);
      legend.appendChild(legendBtn);
      fieldset.appendChild(legend);

      const outsideBtn = document.createElement('button');
      outsideBtn.textContent = 'Outside Legend in Fieldset';
      attachBox(outsideBtn, 100, 40, 50, 120);
      fieldset.appendChild(outsideBtn);

      document.body.appendChild(fieldset);

      const idxLegend = indexElement(legendBtn);
      const resLegend = await inPageWaitForActionable(idxLegend, 'click');
      expect(resLegend.actionable).toBe(true);
      expect(resLegend.success).toBe(true);

      const idxOutside = indexElement(outsideBtn);
      const resOutside = await inPageWaitForActionable(idxOutside, 'click');
      expect(resOutside.actionable).toBe(false);
      expect(resOutside.reason).toBe('disabled');
    });
  });

  describe('6. Aria-disabled & Inert across Composed Shadow DOM Boundaries', () => {
    it('detects aria-disabled on ancestor', async () => {
      const parent = document.createElement('div');
      parent.setAttribute('aria-disabled', 'true');
      const btn = document.createElement('button');
      btn.textContent = 'Child';
      attachBox(btn);
      parent.appendChild(btn);
      document.body.appendChild(parent);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click');
      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('aria-disabled');
    });

    it('penetrates Shadow DOM to find aria-disabled and inert on shadow host', async () => {
      const host = document.createElement('div');
      host.id = 'shadow-host';
      host.setAttribute('aria-disabled', 'true');
      document.body.appendChild(host);

      const shadow = host.attachShadow({ mode: 'open' });
      const innerBtn = document.createElement('button');
      innerBtn.textContent = 'Inside Shadow';
      attachBox(innerBtn);
      shadow.appendChild(innerBtn);

      const idx = indexElement(innerBtn);
      const res = await inPageWaitForActionable(idx, 'click');
      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('aria-disabled');

      host.removeAttribute('aria-disabled');
      host.setAttribute('inert', '');
      const resInert = await inPageWaitForActionable(idx, 'click');
      expect(resInert.actionable).toBe(false);
      expect(resInert.reason).toBe('inert');
    });
  });

  describe('7. Action Differences (Hover vs Click vs Fill)', () => {
    it('allows hover on disabled element while click is rejected', async () => {
      const btn = document.createElement('button');
      btn.setAttribute('disabled', '');
      btn.textContent = 'Disabled with tooltip';
      attachBox(btn);
      document.body.appendChild(btn);

      const idx = indexElement(btn);

      const clickRes = await inPageWaitForActionable(idx, 'click');
      expect(clickRes.actionable).toBe(false);
      expect(clickRes.reason).toBe('disabled');

      const hoverRes = await inPageWaitForActionable(idx, 'hover');
      expect(hoverRes.actionable).toBe(true);
      expect(hoverRes.success).toBe(true);
    });

    it('rejects fill on readonly input while click is permitted', async () => {
      const input = document.createElement('input');
      input.setAttribute('readonly', '');
      input.value = 'locked';
      attachBox(input, 120, 30);
      document.body.appendChild(input);

      const idx = indexElement(input);

      const fillRes = await inPageWaitForActionable(idx, 'fill');
      expect(fillRes.actionable).toBe(false);
      expect(fillRes.reason).toBe('readonly');

      const clickRes = await inPageWaitForActionable(idx, 'click');
      expect(clickRes.actionable).toBe(true);
      expect(clickRes.success).toBe(true);
    });
  });

  describe('8. Special Option Element Support', () => {
    it('allows normal option without zero-size rejection while keeping disabled guard', async () => {
      const select = document.createElement('select');
      attachBox(select, 120, 30, 80, 80);

      const optActive = document.createElement('option');
      optActive.value = 'opt1';
      optActive.textContent = 'Option 1';
      select.appendChild(optActive);

      const optDisabled = document.createElement('option');
      optDisabled.value = 'opt2';
      optDisabled.textContent = 'Option 2 (Disabled)';
      optDisabled.disabled = true;
      select.appendChild(optDisabled);

      document.body.appendChild(select);

      const idxActive = indexElement(optActive);
      const resActive = await inPageWaitForActionable(idxActive, 'click');
      expect(resActive.success).toBe(true);
      expect(resActive.actionable).toBe(true);
      expect(resActive.x).toBeDefined();

      const idxDisabled = indexElement(optDisabled);
      const resDisabled = await inPageWaitForActionable(idxDisabled, 'click');
      expect(resDisabled.actionable).toBe(false);
      expect(resDisabled.reason).toBe('disabled');
    });
  });

  describe('9. Mid-wait State Mutation Detection', () => {
    it('detects when element becomes disabled during stability sampling', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Will Disable Mid-Wait';
      let calls = 0;
      btn.getBoundingClientRect = () => {
        calls++;
        if (calls === 2) {
          btn.setAttribute('disabled', '');
          (btn as any).disabled = true;
        }
        return {
          x: 100,
          y: 200,
          left: 100,
          top: 200,
          right: 180,
          bottom: 240,
          width: 80,
          height: 40,
          toJSON: () => {},
        };
      };
      document.body.appendChild(btn);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click', 400);

      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('disabled');
      expect(res.error).toContain('became non-actionable');
    });

    it('detects element becoming disabled on the final tick right before success return', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Disable on Final Tick';
      attachBox(btn, 80, 40, 100, 200);
      document.body.appendChild(btn);

      let ticksCount = 0;
      const originalRaf = globalThis.requestAnimationFrame;
      // Hook rAF to flip disabled right on the 2nd stable frame
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
        (cb: FrameRequestCallback) => {
          return originalRaf(() => {
            ticksCount++;
            if (ticksCount >= 2) {
              btn.setAttribute('disabled', '');
              (btn as any).disabled = true;
            }
            cb(performance.now());
          });
        },
      );

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click', 500);

      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('disabled');
      expect(res.error).toContain('became non-actionable');
    });
  });

  describe('10. Background Tab and Timer Method Recording', () => {
    it('records method: timer if any tick used timer sampling', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Background Tab Button';
      attachBox(btn);
      document.body.appendChild(btn);

      const idx = indexElement(btn);

      Object.defineProperty(document, 'hidden', { value: true, configurable: true });

      try {
        const res = await inPageWaitForActionable(idx, 'click', 500);
        expect(res.success).toBe(true);
        expect(res.actionable).toBe(true);
        expect(res.method).toBe('timer');
      } finally {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      }
    });
  });

  describe('11. Direct drop-in contract: spread metadata & notFound flag', () => {
    it('spreads coordinates metadata on success and reports notFound: false', async () => {
      const btn = document.createElement('button');
      btn.textContent = 'Metadata Test';
      attachBox(btn, 100, 40, 50, 60);
      document.body.appendChild(btn);

      const idx = indexElement(btn);
      const res = await inPageWaitForActionable(idx, 'click');

      expect(res.success).toBe(true);
      expect(res.actionable).toBe(true);
      expect(res.notFound).toBe(false);
      expect(res.tagName).toBe('button');
      expect(typeof res.frameOffsetX).toBe('number');
      expect(typeof res.frameOffsetY).toBe('number');
    });

    it('sets notFound: true on missing element and notFound: false on disabled element', async () => {
      const missingRes = await inPageWaitForActionable(999999, 'click');
      expect(missingRes.success).toBe(false);
      expect(missingRes.actionable).toBe(false);
      expect(missingRes.notFound).toBe(true);
      expect(missingRes.error).toBeDefined();

      const btn = document.createElement('button');
      btn.disabled = true;
      attachBox(btn);
      document.body.appendChild(btn);

      const idx = indexElement(btn);
      const disabledRes = await inPageWaitForActionable(idx, 'click');
      expect(disabledRes.success).toBe(false);
      expect(disabledRes.actionable).toBe(false);
      expect(disabledRes.notFound).toBe(false);
      expect(disabledRes.reason).toBe('disabled');
      expect(disabledRes.error).toBeDefined();
    });
  });

  describe('12. Overflow clipping', () => {
    it('rejects an element fully clipped outside a scroll container', async () => {
      const pane = document.createElement('div');
      pane.style.overflowY = 'auto';
      Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 100 });
      attachBox(pane, 300, 100, 50, 100);

      const button = document.createElement('button');
      button.textContent = 'Clipped action';
      attachBox(button, 100, 40, 100, 300);
      pane.append(button);
      document.body.append(pane);

      const idx = indexElement(button);
      const result = await inPageWaitForActionable(idx, 'click', 250);

      expect(result.success).toBe(false);
      expect(result.actionable).toBe(false);
      expect(result.notFound).toBe(false);
      expect(result.reason).toBe('out_of_view');
    });
  });
});
