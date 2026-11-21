/**
 * Isolated symbol to store element index map in the extension's execution context.
 * Prevents polluting global window scope and prevents host page hijacking.
 * Stored as WeakRef to prevent Detached DOM Trees in Blink C++ memory.
 */
const ISOLATED_INDEX_MAP_KEY = Symbol.for('__browser_use_isolated_index_map__');

export function derefElement(entry: any): Element | null {
  if (!entry) return null;
  if (typeof entry.deref === 'function') {
    return entry.deref() ?? null;
  }
  return (entry as Element) ?? null;
}

export function wrapElement(el: Element): any {
  if (typeof WeakRef !== 'undefined') {
    return new WeakRef(el);
  }
  return el;
}

export function getIsolatedIndexMap(): Map<number, any> {
  const g = globalThis as any;
  if (!g[ISOLATED_INDEX_MAP_KEY]) {
    g[ISOLATED_INDEX_MAP_KEY] = new Map<number, any>();
  }
  return g[ISOLATED_INDEX_MAP_KEY];
}

export const INDEX_NAMESPACE_SIZE = 2 ** 24;
const INDEX_IDENTITY_KEY = Symbol.for('__browser_use_index_identity__');

function getIndexState() {
  const g = globalThis as any;
  const base = g[Symbol.for('__browser_use_index_namespace__')] ?? 0;
  if (!g[INDEX_IDENTITY_KEY]) {
    const ids = new WeakMap<Element, Map<string, number>>();
    let next = base + 1;
    const map = getIsolatedIndexMap();
    for (const [index, entry] of map) {
      const node = derefElement(entry);
      if (node) ids.set(node, new Map([['', index]]));
      next = Math.max(next, index + 1);
    }
    g[INDEX_IDENTITY_KEY] = { ids, next, base };
  }
  return g[INDEX_IDENTITY_KEY] as {
    ids: WeakMap<Element, Map<string, number>>;
    next: number;
    base: number;
  };
}

export function inPageSetIndexNamespace(base: number): boolean {
  if (
    !Number.isSafeInteger(base) ||
    base < INDEX_NAMESPACE_SIZE ||
    base % INDEX_NAMESPACE_SIZE !== 0 ||
    base + INDEX_NAMESPACE_SIZE > Number.MAX_SAFE_INTEGER
  ) {
    return false;
  }
  const g = globalThis as any;
  const key = Symbol.for('__browser_use_index_namespace__');
  if (g[key] !== undefined) return true;
  // Invalidate references from an older engine before installing the document namespace.
  getIsolatedIndexMap().clear();
  delete g[INDEX_IDENTITY_KEY];
  for (const cache of [g.__pawFast, g.__clawFast]) {
    cache?.actionElements?.clear();
  }
  g[key] = base;
  return true;
}

export function indexElement(el: Element, key = '', minimum = 1): number {
  const map = getIsolatedIndexMap();
  const state = getIndexState();
  let ids = state.ids.get(el);
  if (!ids) {
    ids = new Map();
    state.ids.set(el, ids);
  }
  let index = ids.get(key);
  if (index === undefined) {
    state.next = Math.max(state.next, minimum);
    while (map.has(state.next)) state.next++;
    if (state.next >= state.base + INDEX_NAMESPACE_SIZE) {
      throw new Error('DOM index namespace exhausted; refusing to reuse an element index');
    }
    index = state.next++;
    ids.set(key, index);
  }
  map.set(index, wrapElement(el));
  return index;
}

export function pruneDetachedIndices(): void {
  for (const [index, entry] of getIsolatedIndexMap()) {
    const el = derefElement(entry);
    if (!el?.isConnected || el.ownerDocument !== document) {
      getIsolatedIndexMap().delete(index);
    }
  }
}

/**
 * Verified unoccluded click points survive in-page engine reinjection through a
 * registered global symbol, just like the element index map.
 */
const SAFE_CLICK_POINT_KEY = Symbol.for('__browser_use_safe_click_point_map__');

function getSafeClickPointMap(): WeakMap<
  Element,
  { x: number; y: number; offsetX: number; offsetY: number }
> {
  const g = globalThis as any;
  if (!g[SAFE_CLICK_POINT_KEY]) {
    g[SAFE_CLICK_POINT_KEY] = new WeakMap<
      Element,
      { x: number; y: number; offsetX: number; offsetY: number }
    >();
  }
  return g[SAFE_CLICK_POINT_KEY];
}

export const safeClickPointWeakMap = getSafeClickPointMap();
