import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentObservationCache } from '../utils/document-observation-cache';
import {
  inPageDOMPruner,
  getShadowRoot,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { fastSnapshot } from '../entrypoints/background/tools/browser/fast-snapshot';

describe('document observation reuse', () => {
  let cache: DocumentObservationCache;
  beforeEach(() => {
    document.body.innerHTML = '<main><input aria-label="Name"><button>Save</button></main>';
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 10,
      width: 100,
      height: 25,
      top: 10,
      left: 10,
      right: 110,
      bottom: 35,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value: vi.fn(() => []),
    });
    cache = new DocumentObservationCache(document, getShadowRoot);
  });
  afterEach(() => {
    delete (globalThis as any)[Symbol.for('__browserpaw_agent_overlay__')];
    cache.dispose();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each(['standard', 'fast'] as const)('reuses %s without rerunning its collector', (mode) => {
    const collect = vi.fn(() => (mode === 'standard' ? inPageDOMPruner() : fastSnapshot()));
    const first = cache.read(mode, undefined, collect);
    const second = cache.read(mode, undefined, collect);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('invalidates synchronous DOM changes, including a replaced node with identical markup', () => {
    const collect = vi.fn(() => inPageDOMPruner());
    const first = cache.read('standard', undefined, collect);
    document.querySelector('button')!.outerHTML = '<button>Save</button>';
    const next = cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(2);
    const buttonRef = (result: typeof first) =>
      result.indexedElements?.find((e) => e.tagName === 'button')?.index;
    expect(buttonRef(next)).not.toBe(buttonRef(first));
  });

  it('notices direct control property updates that do not emit DOM mutations', () => {
    const collect = vi.fn(() => fastSnapshot());
    cache.read('fast', undefined, collect);
    document.querySelector('input')!.value = 'updated';
    const next = cache.read('fast', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(next)).toContain('updated');
  });

  it('notices CSSOM edits and layout changes without attribute changes', () => {
    const sheet = document.createElement('style');
    sheet.textContent = 'button { display: block; }';
    document.head.append(sheet);
    const collect = vi.fn(() => inPageDOMPruner());
    cache.read('standard', undefined, collect);
    sheet.sheet!.insertRule('button { display: none; }', 1);
    const hidden = cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(2);
    // jsdom retains its own computed-style cache after insertRule; compare the authoritative collector.
    expect(hidden).toEqual(inPageDOMPruner());
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({
      x: 40,
      y: 10,
      width: 100,
      height: 25,
      top: 10,
      left: 40,
      right: 140,
      bottom: 35,
    } as DOMRect);
    cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it('observes newly attached Shadow roots and their subsequent changes', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const collect = vi.fn(() => inPageDOMPruner());
    cache.read('standard', undefined, collect);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Inside</button>';
    cache.read('standard', undefined, collect);
    root.querySelector('button')!.textContent = 'Changed';
    const changed = cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(3);
    expect(changed.treeString).toContain('Changed');
  });

  it('bypasses uncertain animation or inaccessible stylesheet state', () => {
    const collect = vi.fn(() => inPageDOMPruner());
    vi.mocked(document.getAnimations).mockReturnValue([{} as Animation]);
    cache.read('standard', undefined, collect);
    cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(2);
    vi.mocked(document.getAnimations).mockReturnValue([]);
    const style = document.createElement('style');
    document.head.append(style);
    vi.spyOn(style.sheet!, 'cssRules', 'get').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    cache.read('standard', undefined, collect);
    cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(4);
  });

  it('notices checkbox and focus changes, and does not retain caller mutations', () => {
    document.body.innerHTML = '<input type="checkbox"><input aria-label="Name">';
    const collect = vi.fn(() => fastSnapshot());
    const first = cache.read('fast', undefined, collect)!;
    first.text = 'caller changed the returned object';
    expect(cache.read('fast', undefined, collect)!.text).not.toBe(first.text);
    (document.querySelector('input') as HTMLInputElement).checked = true;
    cache.read('fast', undefined, collect);
    (document.querySelectorAll('input')[1] as HTMLInputElement).focus();
    cache.read('fast', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it('ignores only the actual isolated-world cursor node, not a lookalike attribute', () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<span>cursor</span>';
    document.body.append(overlay);
    (globalThis as any)[Symbol.for('__browserpaw_agent_overlay__')] = overlay;
    const collect = vi.fn(() => inPageDOMPruner());
    cache.read('standard', undefined, collect);
    overlay.firstElementChild!.textContent = 'cursor moved';
    cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(1);
    const lookalike = document.createElement('div');
    lookalike.dataset.browserpawAgentOverlayRoot = 'true';
    document.body.append(lookalike);
    cache.read('standard', undefined, collect);
    lookalike.textContent = 'real page content';
    expect(cache.read('standard', undefined, collect).treeString).toContain('real page content');
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it('does not cache captures that change the DOM or request highlights', () => {
    const collect = vi.fn(() => {
      const result = inPageDOMPruner();
      document.body.append(document.createElement('div'));
      return result;
    });
    cache.read('standard', undefined, collect);
    cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(2);
    const unchanged = vi.fn(() => inPageDOMPruner());
    cache.read('standard', { highlight: true }, unchanged);
    cache.read('standard', { highlight: true }, unchanged);
    expect(unchanged).toHaveBeenCalledTimes(2);
  });

  it('does not mix options, representations or document namespaces', () => {
    const collect = vi.fn(() => inPageDOMPruner());
    cache.read('standard', { maxTextLength: 40 }, collect);
    cache.read('standard', { maxTextLength: 60 }, collect);
    cache.read('fast', undefined, collect);
    cache.read('standard', undefined, collect);
    const key = Symbol.for('__browser_use_index_namespace__');
    const before = (globalThis as any)[key];
    (globalThis as any)[key] = 123;
    try {
      cache.read('standard', undefined, collect);
    } finally {
      (globalThis as any)[key] = before;
    }
    expect(collect).toHaveBeenCalledTimes(5);
  });

  it('keeps unchanged documents reusable when a different document changes', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const child = iframe.contentDocument!;
    child.body.innerHTML = '<button>Child</button>';
    vi.spyOn(child, 'readyState', 'get').mockReturnValue('complete');
    Object.defineProperty(child, 'getAnimations', { configurable: true, value: () => [] });
    const childCache = new DocumentObservationCache(child, getShadowRoot);
    const main = vi.fn(() => inPageDOMPruner());
    const sub = vi.fn(() => ({ text: child.body.textContent }));
    try {
      cache.read('standard', undefined, main);
      childCache.read('standard', undefined, sub);
      child.body.firstElementChild!.textContent = 'Updated child';
      expect(childCache.read('standard', undefined, sub).text).toBe('Updated child');
      cache.read('standard', undefined, main);
      expect(main).toHaveBeenCalledTimes(1);
      expect(sub).toHaveBeenCalledTimes(2);
    } finally {
      childCache.dispose();
    }
  });

  it('invalidates replacement constructed sheets even when their CSS text is identical', () => {
    const previous = Object.getOwnPropertyDescriptor(document, 'adoptedStyleSheets');
    const first = new CSSStyleSheet(),
      second = new CSSStyleSheet();
    first.insertRule('input { outline: 1px solid transparent; }');
    second.insertRule('input { outline: 1px solid transparent; }');
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      writable: true,
      value: [first],
    });
    const collect = vi.fn(() => inPageDOMPruner());
    try {
      cache.read('standard', undefined, collect);
      cache.read('standard', undefined, collect);
      expect(collect).toHaveBeenCalledTimes(1);
      document.adoptedStyleSheets = [second];
      cache.read('standard', undefined, collect);
      expect(collect).toHaveBeenCalledTimes(2);
    } finally {
      if (previous) Object.defineProperty(document, 'adoptedStyleSheets', previous);
      else delete (document as any).adoptedStyleSheets;
    }
  });

  it('uses full collection outside the bounded document probe', () => {
    document.body.innerHTML = '<span></span>'.repeat(5001);
    const collect = vi.fn(() => ({ value: 'complete result' }));
    expect(cache.read('standard', undefined, collect)).toEqual({ value: 'complete result' });
    cache.read('standard', undefined, collect);
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
