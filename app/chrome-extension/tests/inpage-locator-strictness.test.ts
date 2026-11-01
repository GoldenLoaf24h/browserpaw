import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getLocatorAccessibleName,
  inPageLocateByLabel,
  inPageLocateByRole,
  inPageLocateBySelector,
  inPageLocateByText,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { resolveTargetLocation } from '../utils/unified-locator';

describe('Real InPage Locator Strictness & Eligibility Verification', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function mockVisibleRect(
    el: HTMLElement,
    rect: { top: number; left: number; width: number; height: number },
  ) {
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: rect.top,
        left: rect.left,
        bottom: rect.top + rect.height,
        right: rect.left + rect.width,
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top,
      }),
    });
  }

  it('reproduces flaw: inPageLocateBySelector silently takes first when 2 visible elements match', () => {
    const btn1 = document.createElement('button');
    btn1.className = 'dup-btn';
    btn1.textContent = 'Button 1';
    mockVisibleRect(btn1, { top: 50, left: 50, width: 100, height: 40 });
    document.body.appendChild(btn1);

    const btn2 = document.createElement('button');
    btn2.className = 'dup-btn';
    btn2.textContent = 'Button 2';
    mockVisibleRect(btn2, { top: 150, left: 50, width: 100, height: 40 });
    document.body.appendChild(btn2);

    const res = inPageLocateBySelector('.dup-btn');
    // Expected: Must detect 2 visible matches in current frame and fail closed with strict error
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
    expect((res as any).matchCount).toBe(2);
  });

  it('treats scrolled-out but scrollable elements as visible (visible != in viewport)', () => {
    const btn1 = document.createElement('button');
    btn1.className = 'scroll-target';
    btn1.textContent = 'Top Button';
    // In viewport
    mockVisibleRect(btn1, { top: 100, left: 50, width: 100, height: 40 });
    document.body.appendChild(btn1);

    const btn2 = document.createElement('button');
    btn2.className = 'scroll-target';
    btn2.textContent = 'Bottom Button (Below Viewport)';
    // Scrolled out of viewport (top = 2500px, window height = 800px), but has real dimensions and is in document
    mockVisibleRect(btn2, { top: 2500, left: 50, width: 100, height: 40 });
    document.body.appendChild(btn2);

    const res = inPageLocateBySelector('.scroll-target');
    // Both are real visible elements with area -> must trigger strict ambiguity violation!
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
    expect((res as any).matchCount).toBe(2);
  });

  it('treats scrolled-out elements in inPageLocateByText as visible instead of picking viewport one', () => {
    const btn1 = document.createElement('button');
    btn1.textContent = 'Confirm Action';
    // Inside viewport
    mockVisibleRect(btn1, { top: 100, left: 50, width: 120, height: 40 });
    document.body.appendChild(btn1);

    const btn2 = document.createElement('button');
    btn2.textContent = 'Confirm Action';
    // Below viewport
    mockVisibleRect(btn2, { top: 3000, left: 50, width: 120, height: 40 });
    document.body.appendChild(btn2);

    const res = inPageLocateByText('Confirm Action');
    // Must NOT silently pick btn1 due to viewport bonus! Both exist -> ambiguity!
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
    expect((res as any).matchCount).toBe(2);
  });

  it('disqualifies zero-width or zero-height elements as having zero area', () => {
    const validBtn = document.createElement('button');
    validBtn.className = 'area-check';
    validBtn.textContent = 'Valid Button';
    mockVisibleRect(validBtn, { top: 50, left: 50, width: 100, height: 30 });
    document.body.appendChild(validBtn);

    const zeroWidthBtn = document.createElement('button');
    zeroWidthBtn.className = 'area-check';
    zeroWidthBtn.textContent = 'Zero Width';
    // Width is 0 -> zero area
    mockVisibleRect(zeroWidthBtn, { top: 100, left: 50, width: 0, height: 30 });
    document.body.appendChild(zeroWidthBtn);

    const zeroHeightBtn = document.createElement('button');
    zeroHeightBtn.className = 'area-check';
    zeroHeightBtn.textContent = 'Zero Height';
    // Height is 0 -> zero area
    mockVisibleRect(zeroHeightBtn, { top: 150, left: 50, width: 100, height: 0 });
    document.body.appendChild(zeroHeightBtn);

    const res = inPageLocateBySelector('.area-check');
    // Exactly 1 qualified visible element -> must succeed, no false ambiguity!
    expect(res.success).toBe(true);
    expect((res as any).matchCount).toBe(1);
    expect(res.text).toBe('Valid Button');
  });

  it('disqualifies elements with NaN or Infinity coordinates', () => {
    const validBtn = document.createElement('button');
    validBtn.className = 'nan-check';
    validBtn.textContent = 'Valid';
    mockVisibleRect(validBtn, { top: 100, left: 100, width: 80, height: 30 });
    document.body.appendChild(validBtn);

    const nanBtn = document.createElement('button');
    nanBtn.className = 'nan-check';
    nanBtn.textContent = 'NaN Position';
    // NaN coordinate
    mockVisibleRect(nanBtn, { top: NaN, left: NaN, width: 80, height: 30 });
    document.body.appendChild(nanBtn);

    const res = inPageLocateBySelector('.nan-check');
    expect(res.success).toBe(true);
    expect((res as any).matchCount).toBe(1);
    expect(res.text).toBe('Valid');
  });

  it('disqualifies display:none and visibility:hidden elements', () => {
    const visibleBtn = document.createElement('button');
    visibleBtn.className = 'visibility-check';
    visibleBtn.textContent = 'Visible';
    mockVisibleRect(visibleBtn, { top: 50, left: 50, width: 100, height: 40 });
    document.body.appendChild(visibleBtn);

    const hiddenBtn = document.createElement('button');
    hiddenBtn.className = 'visibility-check';
    hiddenBtn.textContent = 'Hidden';
    hiddenBtn.style.display = 'none';
    mockVisibleRect(hiddenBtn, { top: 100, left: 50, width: 100, height: 40 });
    document.body.appendChild(hiddenBtn);

    const res = inPageLocateBySelector('.visibility-check');
    expect(res.success).toBe(true);
    expect((res as any).matchCount).toBe(1);
    expect(res.text).toBe('Visible');
  });

  it('reproduces flaw: XPath multi-match returns strict error', () => {
    const div1 = document.createElement('div');
    div1.setAttribute('data-test', 'item');
    div1.textContent = 'Item 1';
    mockVisibleRect(div1, { top: 50, left: 50, width: 100, height: 40 });
    document.body.appendChild(div1);

    const div2 = document.createElement('div');
    div2.setAttribute('data-test', 'item');
    div2.textContent = 'Item 2';
    mockVisibleRect(div2, { top: 150, left: 50, width: 100, height: 40 });
    document.body.appendChild(div2);

    const res = inPageLocateBySelector('//div[@data-test="item"]', 'xpath');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
    expect((res as any).matchCount).toBe(2);
  });

  it('retains interactive button over non-interactive child span in inPageLocateByText', () => {
    const btn = document.createElement('button');
    const span = document.createElement('span');
    span.textContent = 'Click Me';
    btn.appendChild(span);
    mockVisibleRect(btn, { top: 100, left: 100, width: 120, height: 40 });
    mockVisibleRect(span, { top: 110, left: 110, width: 80, height: 20 });
    document.body.appendChild(btn);

    const res = inPageLocateByText('Click Me');
    expect(res.success).toBe(true);
    expect((res as any).matchCount).toBe(1);
    expect(res.tagName?.toLowerCase()).toBe('button');
  });

  it('retains interactive button inside non-interactive wrapper div in inPageLocateByText', () => {
    const div = document.createElement('div');
    div.className = 'button-wrapper';
    const btn = document.createElement('button');
    btn.textContent = 'Save Profile';
    div.appendChild(btn);
    mockVisibleRect(div, { top: 200, left: 100, width: 500, height: 80 });
    mockVisibleRect(btn, { top: 220, left: 120, width: 100, height: 35 });
    document.body.appendChild(div);

    const res = inPageLocateByText('Save Profile');
    expect(res.success).toBe(true);
    expect((res as any).matchCount).toBe(1);
    // Must pick the interactive button, NOT the outer wrapper div!
    expect(res.tagName?.toLowerCase()).toBe('button');
  });

  it('retains leaf span when all nested wrapper containers are non-interactive', () => {
    const container = document.createElement('div');
    const p = document.createElement('p');
    const span = document.createElement('span');
    span.textContent = 'Detailed Description';
    p.appendChild(span);
    container.appendChild(p);
    mockVisibleRect(container, { top: 100, left: 50, width: 600, height: 200 });
    mockVisibleRect(p, { top: 120, left: 50, width: 400, height: 100 });
    mockVisibleRect(span, { top: 130, left: 50, width: 200, height: 30 });
    document.body.appendChild(container);

    const res = inPageLocateByText('Detailed Description');
    expect(res.success).toBe(true);
    expect((res as any).matchCount).toBe(1);
    // Must pick the innermost leaf span, NOT outer div or p!
    expect(res.tagName?.toLowerCase()).toBe('span');
  });

  it('reports a large ambiguous text set without pairwise layout work', () => {
    const count = 1000;
    for (let i = 0; i < count; i++) {
      const span = document.createElement('span');
      span.textContent = 'Repeated label';
      mockVisibleRect(span, { top: 100, left: 50, width: 100, height: 20 });
      document.body.appendChild(span);
    }
    const visibleStyle = window.getComputedStyle(document.body);
    const styles = vi.spyOn(window, 'getComputedStyle').mockReturnValue(visibleStyle);
    const contains = vi.spyOn(Element.prototype, 'contains');
    try {
      const result = inPageLocateByText('Repeated label');
      expect(result.success).toBe(false);
      expect(result.matchCount).toBe(count);
      expect(styles.mock.calls.length).toBeLessThan(count * 10);
      expect(contains.mock.calls.length).toBeLessThan(count * 10);
    } finally {
      styles.mockRestore();
      contains.mockRestore();
    }
  });

  it('triggers ambiguity error for multiple distinct cards each containing wrapped buttons', () => {
    const card1 = document.createElement('div');
    card1.className = 'card';
    const btn1 = document.createElement('button');
    btn1.textContent = 'Checkout';
    card1.appendChild(btn1);
    mockVisibleRect(card1, { top: 100, left: 50, width: 300, height: 150 });
    mockVisibleRect(btn1, { top: 150, left: 70, width: 100, height: 40 });
    document.body.appendChild(card1);

    const card2 = document.createElement('div');
    card2.className = 'card';
    const btn2 = document.createElement('button');
    btn2.textContent = 'Checkout';
    card2.appendChild(btn2);
    mockVisibleRect(card2, { top: 300, left: 50, width: 300, height: 150 });
    mockVisibleRect(btn2, { top: 350, left: 70, width: 100, height: 40 });
    document.body.appendChild(card2);

    const res = inPageLocateByText('Checkout');
    // Both distinct buttons survive collapse -> must trigger ambiguity!
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
    expect((res as any).matchCount).toBe(2);
  });
  it('detects cross-root ambiguity between light DOM and Shadow DOM without missing shadow matches', () => {
    const mainBtn = document.createElement('button');
    mainBtn.className = 'shared-target';
    mainBtn.textContent = 'Main Button';
    mockVisibleRect(mainBtn, { top: 50, left: 50, width: 100, height: 40 });
    document.body.appendChild(mainBtn);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowBtn = document.createElement('button');
    shadowBtn.className = 'shared-target';
    shadowBtn.textContent = 'Shadow Button';
    mockVisibleRect(shadowBtn, { top: 150, left: 50, width: 100, height: 40 });
    shadow.appendChild(shadowBtn);

    const res = inPageLocateBySelector('.shared-target');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
    expect((res as any).matchCount).toBe(2);
  });

  it('fails immediately with explicit error on invalid CSS selector and does not return clean not found', () => {
    const res = inPageLocateBySelector('button[===invalid]');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/invalid css selector/i);
    expect(res.notFound).not.toBe(true);
  });

  it('keeps a real CSS syntax failure from degrading to supplied coordinates', async () => {
    const result = await resolveTargetLocation(
      1,
      {
        selector: 'button[===invalid]',
        coordinate: { x: 10, y: 20 },
      },
      {
        executeInPage: async () => [
          { frameId: 0, result: inPageLocateBySelector('button[===invalid]') },
        ],
      },
    );
    expect(result.success).toBe(false);
    expect(result.resolutionPath).toBe('selector');
    expect(result.error).toContain('Invalid CSS selector');
  });

  it('disqualifies element when its ancestor has opacity: 0', () => {
    const hiddenParent = document.createElement('div');
    hiddenParent.style.opacity = '0';
    const ghostBtn = document.createElement('button');
    ghostBtn.className = 'opacity-ancestor-test';
    ghostBtn.textContent = 'Ghost Button';
    mockVisibleRect(ghostBtn, { top: 50, left: 50, width: 100, height: 40 });
    hiddenParent.appendChild(ghostBtn);
    document.body.appendChild(hiddenParent);

    const visibleParent = document.createElement('div');
    visibleParent.style.opacity = '1';
    const realBtn = document.createElement('button');
    realBtn.className = 'opacity-ancestor-test';
    realBtn.textContent = 'Real Button';
    mockVisibleRect(realBtn, { top: 150, left: 50, width: 100, height: 40 });
    visibleParent.appendChild(realBtn);
    document.body.appendChild(visibleParent);

    const res = inPageLocateBySelector('.opacity-ancestor-test');
    expect(res.success).toBe(true);
    expect((res as any).matchCount).toBe(1);
    expect(res.text).toBe('Real Button');
  });

  it('locates native input as implicit textbox with role="textbox" and preserves strictness on duplicate', () => {
    const input1 = document.createElement('input');
    input1.type = 'text';
    input1.placeholder = 'Search keyword';
    mockVisibleRect(input1, { top: 50, left: 50, width: 200, height: 35 });
    document.body.appendChild(input1);

    const singleRes = inPageLocateByText('Search keyword', 'textbox');
    expect(singleRes.success).toBe(true);
    expect((singleRes as any).matchCount).toBe(1);
    expect(singleRes.tagName?.toLowerCase()).toBe('input');

    const input2 = document.createElement('input');
    input2.type = 'text';
    input2.placeholder = 'Search keyword';
    mockVisibleRect(input2, { top: 150, left: 50, width: 200, height: 35 });
    document.body.appendChild(input2);

    const dupRes = inPageLocateByText('Search keyword', 'textbox');
    expect(dupRes.success).toBe(false);
    expect(dupRes.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
    expect((dupRes as any).matchCount).toBe(2);
  });

  it('resolves real native label associations through getByLabel semantics', () => {
    const label = document.createElement('label');
    label.htmlFor = 'email-field';
    label.textContent = 'Email address';
    document.body.appendChild(label);

    const input = document.createElement('input');
    input.id = 'email-field';
    input.type = 'email';
    mockVisibleRect(input, { top: 50, left: 50, width: 220, height: 36 });
    document.body.appendChild(input);

    const result = inPageLocateByLabel('Email address', { exact: true });
    expect(result.success).toBe(true);
    expect(result.tagName?.toLowerCase()).toBe('input');
    expect(getLocatorAccessibleName(input)).toBe('Email address');
  });

  it('resolves wrapping labels and rejects duplicate label names', () => {
    for (let i = 0; i < 2; i++) {
      const wrapping = document.createElement('label');
      const text = document.createElement('span');
      text.textContent = 'Account name';
      const input = document.createElement('input');
      input.type = 'text';
      wrapping.append(text, input);
      mockVisibleRect(input, { top: 50 + i * 60, left: 50, width: 220, height: 36 });
      document.body.appendChild(wrapping);
    }

    const result = inPageLocateByLabel('Account name');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/strict mode|ambiguity|multiple elements/i);
    expect((result as any).matchCount).toBe(2);
  });

  it('uses implicit/explicit role subsets with accessible-name exactness and strict ambiguity', () => {
    const button = document.createElement('button');
    button.textContent = 'Save';
    mockVisibleRect(button, { top: 50, left: 50, width: 120, height: 40 });
    document.body.appendChild(button);

    const single = inPageLocateByRole('button', { name: 'Save', exact: true });
    expect(single.success).toBe(true);
    expect(single.tagName?.toLowerCase()).toBe('button');

    const second = document.createElement('button');
    second.setAttribute('role', 'button');
    second.textContent = 'Save';
    mockVisibleRect(second, { top: 120, left: 50, width: 120, height: 40 });
    document.body.appendChild(second);

    const duplicate = inPageLocateByRole('button', { name: 'Save', exact: true });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toMatch(/strict mode|ambiguity|multiple elements/i);
    expect((duplicate as any).matchCount).toBe(2);
  });

  it('does not treat unknown role names as CSS tags or case-insensitive exact names', () => {
    const button = document.createElement('button');
    button.textContent = 'Save draft';
    mockVisibleRect(button, { top: 50, left: 50, width: 120, height: 40 });
    document.body.appendChild(button);

    const unsupported = inPageLocateByRole('div' as any, { name: 'anything' });
    expect(unsupported.success).toBe(false);
    expect(unsupported.error).toMatch(/unsupported role/i);

    const exactCase = inPageLocateByRole('button', { name: 'save', exact: true });
    expect(exactCase.success).toBe(false);

    const exactWhole = inPageLocateByRole('button', { name: 'Save draft extra', exact: true });
    expect(exactWhole.success).toBe(false);
  });
});
