import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { inPageDOMPruner } from '../entrypoints/background/tools/browser/dom-indexer';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { vi } from 'vitest';

describe('Scoped Read DOM (selector & exclude)', () => {
  let prevRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 20,
        y: 20,
        left: 20,
        top: 20,
        right: 120,
        bottom: 60,
        width: 100,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    };
    document.body.innerHTML = '';
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = prevRect;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('scopes DOM pruning to target container when selector is provided', () => {
    document.body.innerHTML = `
      <header id="global-header">
        <button id="btn-login">Login</button>
      </header>
      <main id="main-cart">
        <button id="btn-clean">清理购物车</button>
        <button id="btn-checkout">结算</button>
      </main>
      <footer id="global-footer">
        <a href="/about">About</a>
      </footer>
    `;

    const res = inPageDOMPruner({ selector: '#main-cart' });
    expect(res.selectorMatched).toBe(true);
    expect(res.elementCount).toBe(2);
    expect(res.indexedElements?.map((e) => e.attributes?.id)).toEqual([
      'btn-clean',
      'btn-checkout',
    ]);
    expect(res.treeString).toContain('清理购物车');
    expect(res.treeString).toContain('结算');
    expect(res.treeString).not.toContain('Login');
    expect(res.treeString).not.toContain('About');
  });

  it('excludes elements and their descendants matching exclude selector string', () => {
    document.body.innerHTML = `
      <div id="workspace">
        <button id="btn-1">Action 1</button>
        <div class="ad-banner">
          <button id="btn-ad">Buy Now</button>
          <span>Sponsored Ad</span>
        </div>
        <div id="jdccm-elevator">
          <button id="btn-scroll-top">Top</button>
        </div>
        <button id="btn-2">Action 2</button>
      </div>
    `;

    const res = inPageDOMPruner({
      exclude: '.ad-banner, #jdccm-elevator',
    });

    expect(res.elementCount).toBe(2);
    const ids = res.indexedElements?.map((e) => e.attributes?.id);
    expect(ids).toEqual(['btn-1', 'btn-2']);
    expect(res.treeString).not.toContain('Buy Now');
    expect(res.treeString).not.toContain('Sponsored Ad');
    expect(res.treeString).not.toContain('Top');
  });

  it('supports exclude as an array of CSS selectors', () => {
    document.body.innerHTML = `
      <div id="content">
        <button id="btn-keep">Keep Me</button>
        <div class="recommendations">
          <button id="btn-rec">Recommended Item</button>
        </div>
        <footer id="footer">
          <button id="btn-foot">Terms</button>
        </footer>
      </div>
    `;

    const res = inPageDOMPruner({
      exclude: ['.recommendations', '#footer'],
    });

    expect(res.elementCount).toBe(1);
    expect(res.indexedElements?.[0].attributes?.id).toBe('btn-keep');
  });

  it('combines selector scoping and exclusion simultaneously', () => {
    document.body.innerHTML = `
      <div id="outside">
        <button id="outside-btn">Ignored</button>
      </div>
      <div id="main-cart">
        <button id="btn-valid-1">Cart Item 1</button>
        <div class="guess-you-like">
          <button id="rec-item">Cart Upsell</button>
        </div>
        <button id="btn-valid-2">Cart Item 2</button>
      </div>
    `;

    const res = inPageDOMPruner({
      selector: '#main-cart',
      exclude: '.guess-you-like',
    });

    expect(res.selectorMatched).toBe(true);
    expect(res.elementCount).toBe(2);
    const ids = res.indexedElements?.map((e) => e.attributes?.id);
    expect(ids).toEqual(['btn-valid-1', 'btn-valid-2']);
    expect(res.treeString).not.toContain('Cart Upsell');
    expect(res.treeString).not.toContain('Ignored');
  });

  it('handles non-existent selector safely and reports selectorMatched: false in ReadDOMTool', async () => {
    const spy = vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      {
        frameId: 0,
        result: {
          treeString: '',
          elementCount: 0,
          interactiveCount: 0,
          compressionRatio: 1,
          indexMap: {},
          indexedElements: [],
          selectorMatched: false,
        },
      },
    ] as any);

    (readDOMTool as any).resolveAffinityTab = async () => ({
      id: 99,
      url: 'https://example.com/cart',
      title: 'Cart',
    });

    const response = await readDOMTool.execute({ selector: '#non-existent-modal' });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.selector).toBe('#non-existent-modal');
    expect(payload.selectorMatched).toBe(false);
    expect(payload.message).toContain('No elements matching selector');
  });

  it('resolves selectorMatched: true and omits no-elements message when child frame matches selector even if main frame does not', async () => {
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      {
        frameId: 0,
        result: {
          treeString: '',
          elementCount: 0,
          interactiveCount: 0,
          compressionRatio: 1,
          indexMap: {},
          indexedElements: [],
          selectorMatched: false,
        },
      },
      {
        frameId: 101,
        result: {
          treeString: '[1] <button id="iframe-submit">Submit</button>',
          elementCount: 1,
          interactiveCount: 1,
          compressionRatio: 1,
          indexMap: {
            1: { selector: '#iframe-submit', tagName: 'button' },
          },
          indexedElements: [
            {
              index: 1,
              tagName: 'button',
              isInteractive: true,
              attributes: { id: 'iframe-submit' },
              text: 'Submit',
            },
          ],
          selectorMatched: true,
        },
      },
    ] as any);

    (readDOMTool as any).resolveAffinityTab = async () => ({
      id: 99,
      url: 'https://example.com/checkout',
      title: 'Checkout',
    });

    const response = await readDOMTool.execute({ selector: '#iframe-submit' });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.selector).toBe('#iframe-submit');
    expect(payload.selectorMatched).toBe(true);
    expect(payload.message).toBeUndefined();
    expect(payload.elementCount).toBe(1);
    expect(payload.treeString).toContain('iframe-submit');
  });

  it('resolves selectorMatched: false and reports no-elements message when all frames fail to match selector', async () => {
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      {
        frameId: 0,
        result: {
          treeString: '',
          elementCount: 0,
          interactiveCount: 0,
          compressionRatio: 1,
          indexMap: {},
          indexedElements: [],
          selectorMatched: false,
        },
      },
      {
        frameId: 101,
        result: {
          treeString: '',
          elementCount: 0,
          interactiveCount: 0,
          compressionRatio: 1,
          indexMap: {},
          indexedElements: [],
          selectorMatched: false,
        },
      },
    ] as any);

    (readDOMTool as any).resolveAffinityTab = async () => ({
      id: 99,
      url: 'https://example.com/checkout',
      title: 'Checkout',
    });

    const response = await readDOMTool.execute({ selector: '#missing-everywhere' });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.selector).toBe('#missing-everywhere');
    expect(payload.selectorMatched).toBe(false);
    expect(payload.message).toContain(
      'No elements matching selector "#missing-everywhere" found on page.',
    );
  });

  it('filters out nested matching containers to prevent duplicate element indexing', () => {
    document.body.innerHTML = `
      <div class="card-box">
        <div class="card-box">
          <button id="nested-btn">Proceed</button>
        </div>
      </div>
    `;

    const res = inPageDOMPruner({ selector: '.card-box' });
    expect(res.selectorMatched).toBe(true);
    expect(res.elementCount).toBe(1);
    expect(res.indexedElements?.map((e) => e.attributes?.id)).toEqual(['nested-btn']);
  });

  it('supports :has-text in selector and exclude options', () => {
    document.body.innerHTML = `
      <div class="dialog" id="dialog-cart">
        <h2>购物车清单</h2>
        <button id="btn-submit-cart">提交订单</button>
      </div>
      <div class="dialog" id="dialog-fav">
        <h2>收藏夹清单</h2>
        <button id="btn-fav">移入购物车</button>
      </div>
      <div class="ad-block">
        <h3>猜你喜欢</h3>
        <button id="btn-ad">商品推荐</button>
      </div>
    `;

    // Scoped by :has-text
    const scopedRes = inPageDOMPruner({
      selector: '.dialog:has-text("购物车清单")',
    });
    expect(scopedRes.selectorMatched).toBe(true);
    expect(scopedRes.elementCount).toBe(2);
    expect(scopedRes.interactiveCount).toBe(1);
    expect(scopedRes.indexedElements?.find((e) => e.tagName === 'button')?.attributes?.id).toBe(
      'btn-submit-cart',
    );

    // Excluded by :has-text
    const excludedRes = inPageDOMPruner({
      exclude: 'div:has-text("猜你喜欢")',
    });
    const ids = excludedRes.indexedElements?.map((e) => e.attributes?.id);
    expect(ids).toContain('btn-submit-cart');
    expect(ids).toContain('btn-fav');
    expect(ids).not.toContain('btn-ad');
  });
});
