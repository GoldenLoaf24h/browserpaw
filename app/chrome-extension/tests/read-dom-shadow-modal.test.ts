import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderCompactElementLine,
  inPageDOMPruner,
  inPageCheckCaptcha,
} from '../entrypoints/background/tools/browser/dom-indexer';
import type { IndexedElement } from 'chrome-mcp-shared';

describe('Shadow DOM & Modal Focus Trap Enhancements', () => {
  it('renders [shadow] tag on compact element line when inShadowDom is true', () => {
    const shadowBtn: IndexedElement = {
      index: 42,
      tagName: 'button',
      role: 'button',
      text: 'Apply Flair',
      attributes: { id: 'apply-btn' },
      rect: { x: 50, y: 100, width: 80, height: 30 },
      isInteractive: true,
      inShadowDom: true,
    };

    const line = renderCompactElementLine(shadowBtn);
    expect(line).toContain('[42] [shadow] button "Apply Flair" #apply-btn');
  });

  it('detects active modal dialog and focus trap in inPageDOMPruner', () => {
    document.body.innerHTML = `
      <div id="main-content">
        <button id="btn-open">Open</button>
      </div>
      <dialog open id="test-modal" aria-modal="true" aria-label="Flair Selection">
        <h2>Select Flair</h2>
        <button id="btn-save">Save</button>
      </dialog>
    `;

    // Stub offsetWidth/offsetHeight for jsdom visibility check
    const dlg = document.getElementById('test-modal') as HTMLElement;
    Object.defineProperty(dlg, 'offsetWidth', { configurable: true, value: 300 });
    Object.defineProperty(dlg, 'offsetHeight', { configurable: true, value: 200 });

    const res = inPageDOMPruner();
    expect(res.focusTrapped).toBe(true);
    expect(res.activeModal).toContain('Flair Selection');
    expect(res.treeString).toContain('Modal Guidance: Active modal focus trap');
  });

  it('detects captcha container using inPageCheckCaptcha', () => {
    document.body.innerHTML = `
      <div id="app">
        <div id="captcha_modal" style="width: 300px; height: 200px;">
          <div class="slider-verify"></div>
        </div>
      </div>
    `;
    const cEl = document.getElementById('captcha_modal')!;
    Object.defineProperty(cEl, 'offsetWidth', { configurable: true, value: 300 });

    const check = inPageCheckCaptcha();
    expect(check.detected).toBe(true);
    expect(check.type).toBe('#captcha_modal');
  });

  it('detects Cloudflare Turnstile bot challenge container', () => {
    document.body.innerHTML = `
      <div id="app">
        <div class="cf-turnstile" style="width: 300px; height: 65px;"></div>
      </div>
    `;
    const tEl = document.querySelector('.cf-turnstile') as HTMLElement;
    Object.defineProperty(tEl, 'offsetWidth', { configurable: true, value: 300 });

    const check = inPageCheckCaptcha();
    expect(check.detected).toBe(true);
    expect(check.type).toBe('.cf-turnstile');
  });
});
