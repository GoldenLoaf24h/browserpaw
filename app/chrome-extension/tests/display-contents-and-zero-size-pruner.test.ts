import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { inPageDOMPruner } from '../entrypoints/background/tools/browser/dom-indexer';

describe('display:contents and zero-size container pruning regressions', () => {
  let originalCheckVisibility: any;
  let originalGetBoundingClientRect: any;

  beforeEach(() => {
    originalCheckVisibility = Element.prototype.checkVisibility;
    originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

    // Faithful simulation of Blink / Chromium native checkVisibility
    Element.prototype.checkVisibility = function (options?: {
      checkOpacity?: boolean;
      checkVisibilityCSS?: boolean;
    }) {
      const style = window.getComputedStyle(this);
      // W3C spec: elements with display: none or display: contents do not generate boxes -> returns false
      if (style.display === 'none' || style.display === 'contents') {
        return false;
      }
      if (options?.checkVisibilityCSS && style.visibility === 'hidden') {
        return false;
      }
      if (options?.checkOpacity && parseFloat(style.opacity || '1') <= 0) {
        return false;
      }
      let parent = this.parentElement;
      while (parent) {
        const pStyle = window.getComputedStyle(parent);
        if (pStyle.display === 'none') {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    };

    Element.prototype.getBoundingClientRect = function () {
      const style = window.getComputedStyle(this);
      // display: contents or explicit zero size produces 0x0 rect
      if (style.display === 'contents' || this.classList.contains('zero-size')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }

      const isOffscreen = this.classList.contains('offscreen-bottom');
      const top = isOffscreen ? 5000 : 100;
      const height = 40;
      const width = 200;
      return {
        x: 50,
        y: top,
        top,
        bottom: top + height,
        left: 50,
        right: 50 + width,
        width,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    };

    document.body.innerHTML = '';
  });

  afterEach(() => {
    Element.prototype.checkVisibility = originalCheckVisibility;
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    document.body.innerHTML = '';
  });

  it('reproduces failure: main with display:contents must retain visible h1 and examples under selector:main and default compact', () => {
    document.body.innerHTML = `
      <nav id="sidebar">
        <a href="#doc-methods">Document Methods</a>
        <a href="#doc-events">Document Events</a>
      </nav>
      <main id="main-content" style="display: contents">
        <article>
          <h1>Document: querySelectorAll() method</h1>
          <p>The Document method querySelectorAll() returns a static NodeList...</p>
          <h2>Examples</h2>
          <button id="btn-run-example">Run Example</button>
        </article>
      </main>
    `;

    // 1. selector: 'main' must match and index main descendants
    const scopedRes = inPageDOMPruner({ selector: 'main' });
    expect(scopedRes.selectorMatched).toBe(true);
    expect(scopedRes.elementCount).toBeGreaterThanOrEqual(1);
    expect(scopedRes.treeString).toContain('Document: querySelectorAll() method');
    expect(scopedRes.treeString).toContain('Examples');
    expect(scopedRes.treeString).toContain('#btn-run-example');
    expect(scopedRes.treeString).not.toContain('Document Methods');

    // When flattenCards is disabled, main contains distinct headings and action elements
    const unflattenedRes = inPageDOMPruner({ selector: 'main', flattenCards: false });
    expect(unflattenedRes.elementCount).toBeGreaterThanOrEqual(3);
    expect(unflattenedRes.treeString).toContain('Document: querySelectorAll() method');
    expect(unflattenedRes.treeString).toContain('Examples');

    // 2. default compact without selector must contain both sidebar and main content
    const defaultRes = inPageDOMPruner();
    expect(defaultRes.treeString).toContain('Document Methods');
    expect(defaultRes.treeString).toContain('Document: querySelectorAll() method');
    expect(defaultRes.treeString).toContain('Examples');
    expect(defaultRes.treeString).toContain('#btn-run-example');
  });

  it('reproduces failure: nested display:contents and zero-size container preserve visible button', () => {
    document.body.innerHTML = `
      <main style="display: contents">
        <div class="nested-contents" style="display: contents">
          <div class="zero-size" style="width: 0; height: 0">
            <button id="btn-deep">Deep Visible Action</button>
          </div>
        </div>
      </main>
    `;

    const res = inPageDOMPruner({ selector: 'main' });
    expect(res.selectorMatched).toBe(true);
    expect(res.treeString).toContain('Deep Visible Action');
    expect(res.elementCount).toBe(1);
  });

  it('ensures truly hidden elements inside display:contents are NOT leaked', () => {
    document.body.innerHTML = `
      <main style="display: contents">
        <button id="btn-vis">Visible Button</button>
        <button id="btn-display-none" style="display: none">Hidden None</button>
        <button id="btn-vis-hidden" style="visibility: hidden">Hidden Vis</button>
        <button id="btn-opacity-0" style="opacity: 0">Hidden Opacity</button>
        <div inert>
          <button id="btn-inert">Inert Button</button>
        </div>
        <div aria-hidden="true">
          <button id="btn-aria-hidden">Aria Hidden Button</button>
        </div>
      </main>
    `;

    const res = inPageDOMPruner({ selector: 'main' });
    expect(res.treeString).toContain('Visible Button');
    expect(res.treeString).not.toContain('Hidden None');
    expect(res.treeString).not.toContain('Hidden Vis');
    expect(res.treeString).not.toContain('Hidden Opacity');
    expect(res.treeString).not.toContain('Inert Button');
    expect(res.treeString).not.toContain('Aria Hidden Button');
    expect(res.elementCount).toBe(1);
  });

  it('ensures offscreen elements inside display:contents are pruned by viewport threshold', () => {
    document.body.innerHTML = `
      <main style="display: contents">
        <button id="btn-onscreen">Onscreen Button</button>
        <button id="btn-offscreen" class="offscreen-bottom">Offscreen Far Button</button>
      </main>
    `;

    const res = inPageDOMPruner({ selector: 'main', viewportThreshold: 500 });
    expect(res.treeString).toContain('Onscreen Button');
    expect(res.treeString).not.toContain('Offscreen Far Button');
    expect(res.elementCount).toBe(1);
  });
});
