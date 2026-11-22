export interface DomQueryCache {
  styles: WeakMap<Element, CSSStyleDeclaration | null>;
  rects: WeakMap<Element, DOMRect>;
  subtreeHiddenByFlags: Map<number, WeakMap<Element, boolean>>;
  locatorSubtreeHidden: WeakMap<Element, boolean>;
}

export function createDomQueryCache(): DomQueryCache {
  return {
    styles: new WeakMap<Element, CSSStyleDeclaration | null>(),
    rects: new WeakMap<Element, DOMRect>(),
    subtreeHiddenByFlags: new Map<number, WeakMap<Element, boolean>>(),
    locatorSubtreeHidden: new WeakMap<Element, boolean>(),
  };
}

export function getCachedComputedStyle(
  el: Element,
  win?: Window | null,
  cache?: DomQueryCache,
): CSSStyleDeclaration | null {
  if (cache && cache.styles.has(el)) {
    return cache.styles.get(el) ?? null;
  }
  const view =
    win || el.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
  let style: CSSStyleDeclaration | null = null;
  if (view && typeof view.getComputedStyle === 'function') {
    try {
      style = view.getComputedStyle(el);
    } catch {
      style = null;
    }
  }
  if (cache) {
    cache.styles.set(el, style);
  }
  return style;
}

export function getCachedBoundingClientRect(el: Element, cache?: DomQueryCache): DOMRect {
  if (cache) {
    const cached = cache.rects.get(el);
    if (cached) return cached;
  }
  const rect = el.getBoundingClientRect();
  if (cache) {
    cache.rects.set(el, rect);
  }
  return rect;
}

export function getSubtreeHiddenCache(
  cache: DomQueryCache,
  checkAriaHidden: boolean,
  checkOpacity: boolean,
): WeakMap<Element, boolean> {
  const flags = (checkAriaHidden ? 1 : 0) | (checkOpacity ? 2 : 0);
  let map = cache.subtreeHiddenByFlags.get(flags);
  if (!map) {
    map = new WeakMap<Element, boolean>();
    cache.subtreeHiddenByFlags.set(flags, map);
  }
  return map;
}
