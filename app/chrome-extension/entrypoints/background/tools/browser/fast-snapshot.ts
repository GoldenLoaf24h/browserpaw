/**
 * BrowserPaw Ultrafast Atomic DOM Snapshot & Perception Engine
 *
 * Single-pass TreeWalker traversal, WeakMap metric caching, native checkVisibility,
 * and code-owned WeakMap/Map node identity registry (`window.__pawFast` / `window.__clawFast`).
 *
 * Execution target: 10-30ms, payload budget <=15KB, <=250 actions, <=6000 text chars.
 */

export interface FastSnapshotOptions {
  legacyVisibility?: boolean;
}

export interface FastAction {
  id: string;
  node?: number;
  role?: string;
  label: string;
  rect?: { x: number; y: number; w: number; h: number };
  kind: 'click' | 'fill' | 'select' | 'scroll' | 'wait';
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  delta?: number;
}

export interface FastSnapshotResult {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  scroll: { y: number; height: number };
  actions: FastAction[];
  marker: any[];
  page_key: any[];
  guards: Record<string | number, any>;
  omitted_actions: number;
}

export interface PawFastCache {
  ids: WeakMap<Element, number>;
  nodes: Map<number, Element>;
  actionElements?: Map<string | number, Element>;
  next: number;
  pageKey?: () => any[];
  guard?: (e: Element | null | undefined) => any[] | null;
  snapshot?: (options?: FastSnapshotOptions) => FastSnapshotResult | null;
}

export type ClawFastCache = PawFastCache;

export function getPawFastCache(): PawFastCache {
  const g = globalThis as any;
  if (!g.__pawFast && !g.__clawFast) {
    const cache: PawFastCache = {
      ids: new WeakMap<Element, number>(),
      nodes: new Map<number, Element>(),
      actionElements: new Map<string | number, Element>(),
      next: 1,
    };
    g.__pawFast = cache;
    g.__clawFast = cache;
  } else if (!g.__pawFast && g.__clawFast) {
    g.__pawFast = g.__clawFast;
  } else if (g.__pawFast && !g.__clawFast) {
    g.__clawFast = g.__pawFast;
  }
  if (!g.__pawFast.actionElements) {
    g.__pawFast.actionElements = new Map<string | number, Element>();
  }
  return g.__pawFast;
}

export const getClawFastCache = getPawFastCache;

// Module-scoped ephemeral DOM cache for single snapshot pass (Nanobrowser pattern)
const DOM_CACHE = {
  boundingRects: new WeakMap<Element, DOMRect>(),
  computedStyles: new WeakMap<Element, CSSStyleDeclaration>(),
  clearCache: () => {
    DOM_CACHE.boundingRects = new WeakMap();
    DOM_CACHE.computedStyles = new WeakMap();
  },
};

function getCachedBoundingRect(element: Element): DOMRect {
  let rect = DOM_CACHE.boundingRects.get(element);
  if (!rect) {
    rect = element.getBoundingClientRect();
    DOM_CACHE.boundingRects.set(element, rect);
  }
  return rect;
}

function getCachedComputedStyle(element: Element): CSSStyleDeclaration {
  let style = DOM_CACHE.computedStyles.get(element);
  if (!style) {
    style = window.getComputedStyle(element);
    DOM_CACHE.computedStyles.set(element, style);
  }
  return style;
}

/**
 * Get native value setter by climbing the element's actual prototype chain.
 * Essential for React 16-19 and Vue 3 controlled inputs where value setter is intercepted.
 */
export function getNativeValueSetter(
  element: HTMLInputElement | HTMLTextAreaElement,
): ((v: string) => void) | null {
  if (!element || typeof element !== 'object') return null;
  let proto = Object.getPrototypeOf(element);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) {
      return desc.set;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

/**
 * Get native checked setter by climbing the element's prototype chain.
 */
export function getNativeCheckedSetter(element: HTMLInputElement): ((v: boolean) => void) | null {
  if (!element || typeof element !== 'object') return null;
  let proto = Object.getPrototypeOf(element);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'checked');
    if (desc?.set) {
      return desc.set;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

/**
 * Execute ultrafast atomic snapshot of visible DOM interactive elements and body text.
 */
export function fastSnapshot(options?: FastSnapshotOptions): FastSnapshotResult | null {
  if (typeof document === 'undefined' || !document.body) return null;

  const cache = getClawFastCache();
  const isoMap = (globalThis as any)[Symbol.for('__browser_use_isolated_index_map__')];

  const identity = (e: Element): number => {
    if (!cache.ids.has(e)) {
      cache.ids.set(e, cache.next++);
    }
    const id = cache.ids.get(e)!;
    cache.nodes.set(id, e);
    if (isoMap && typeof isoMap.set === 'function') {
      try {
        isoMap.set(id, typeof WeakRef !== 'undefined' ? new WeakRef(e) : e);
      } catch {}
    }
    return id;
  };

  // Clean up detached nodes to prevent memory leaks on SPA re-renders
  for (const [id, e] of cache.nodes) {
    if (!e.isConnected) {
      cache.nodes.delete(id);
    }
  }
  cache.actionElements?.clear();

  const safe = (e: any): boolean => !['password', 'file', 'hidden'].includes(e.type);

  const visible = (e: Element | null): boolean => {
    if (!e || e.closest('[aria-hidden="true"],[inert]')) return false;
    if (options?.legacyVisibility || typeof (e as any).checkVisibility !== 'function') {
      const style = getCachedComputedStyle(e);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        parseFloat(style.opacity || '1') === 0
      ) {
        return false;
      }
      const r = getCachedBoundingRect(e);
      return r.width > 0 && r.height > 0;
    }
    return (e as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };

  const name = (e: Element | null, seen = new Set<Element>()): string => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => name(document.getElementById(id), seen))
      .filter(Boolean)
      .join(' ');
    if (referenced) return referenced;
    const ariaLabel = e.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const labels = [...((e as any).labels || [])]
      .map((l: Element) => name(l, seen))
      .filter(Boolean)
      .join(' ');
    if (labels) return labels;
    if (['button', 'submit', 'reset'].includes((e as any).type)) {
      const v = (e as HTMLInputElement).value;
      if (v) return v;
    }
    const alt = e.getAttribute('alt');
    if (alt) return alt;
    if (e.tagName !== 'INPUT') {
      const textChildren = [...e.childNodes]
        .map((n) => {
          if (n.nodeType === 3) return n.textContent || '';
          if (n.nodeType === 1 && (n as Element).getAttribute('aria-hidden') !== 'true') {
            return name(n as Element, seen);
          }
          return '';
        })
        .join(' ')
        .trim();
      if (textChildren) return textChildren;
    }
    return e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };

  const roles = [
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemradio',
    'option',
    'gridcell',
    'combobox',
    'textbox',
    'searchbox',
    'spinbutton',
  ];

  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((r) => `[role="${r}"]`).join(',');

  const getRole = (e: Element): string | null => {
    const explicit = e.getAttribute('role');
    if (explicit && roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || (e as HTMLElement).isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      const type = (e as HTMLInputElement).type;
      if (['checkbox', 'radio'].includes(type)) return type;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(type)) return 'textbox';
    }
    return null;
  };

  cache.pageKey = () => [
    performance.timeOrigin,
    location.href,
    window.scrollX,
    window.scrollY,
    window.innerWidth,
    window.innerHeight,
    [...document.querySelectorAll('input,textarea,select')]
      .filter(safe)
      .map((e: any) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly]),
  ];

  cache.guard = (e: any) => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope =
      e.closest?.('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [
      identity(e),
      getRole(e),
      name(e),
      e.value ?? null,
      e.checked ?? null,
      e.selectedIndex ?? null,
      e.readOnly ?? null,
      typeof e.matches === 'function' ? e.matches(':disabled') : false,
      e.getAttribute?.('aria-disabled'),
      e.getAttribute?.('aria-expanded'),
      e.getAttribute?.('aria-checked'),
      e.getAttribute?.('aria-selected'),
      e.getAttribute?.('href'),
      scope?.innerText ? String(scope.innerText).slice(0, 100) : '',
    ];
  };

  const actions: FastAction[] = [];
  const rawElements = document.querySelectorAll(selector);

  for (let i = 0; i < rawElements.length; i++) {
    const e = rawElements[i];
    if (
      !safe(e) ||
      !visible(e) ||
      (typeof (e as any).matches === 'function' && (e as any).matches(':disabled')) ||
      (typeof e.closest === 'function' && e.closest('[aria-disabled="true"]'))
    ) {
      continue;
    }

    const r = getCachedBoundingRect(e);
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const rname = getRole(e);
    if (
      !rname ||
      r.width <= 0 ||
      r.height <= 0 ||
      x < 0 ||
      y < 0 ||
      x >= window.innerWidth ||
      y >= window.innerHeight
    ) {
      continue;
    }

    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) {
      continue;
    }

    const base: any = {
      node: identity(e),
      role: rname,
      label: name(e) || rname,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };

    for (const key of ['checked', 'selected', 'expanded']) {
      const val = e.getAttribute('aria-' + key);
      if (val !== null) base[key] = val;
    }

    if (['checkbox', 'radio'].includes((e as any).type)) {
      base.checked = String((e as HTMLInputElement).checked);
    }

    if (e.tagName === 'SELECT') {
      const selEl = e as HTMLSelectElement;
      for (const o of selEl.options) {
        if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]')) {
          actions.push({
            ...base,
            kind: 'select',
            value: o.value,
            current_value: [...selEl.selectedOptions].map((opt) => opt.label).join(', '),
            label: base.label + ' → ' + o.label,
          });
        }
      }
    } else {
      const isReadOnly = (e as any).readOnly || e.getAttribute('aria-readonly') === 'true';
      const editable =
        !isReadOnly &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
          (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const value =
        'value' in e
          ? String((e as any).value)
          : (e as HTMLElement).isContentEditable || rname === 'combobox'
            ? (e as HTMLElement).innerText?.trim() || ''
            : '';

      actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
      if (editable) {
        actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
      }
    }
  }

  // Single-pass TreeWalker text extraction bounded by 6000 characters
  const words: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node: Node | null;
  let textLength = 0;

  while ((node = walker.nextNode()) && textLength < 6000) {
    const val = node.textContent?.trim() || '';
    const parent = node.parentElement;
    if (!val || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) {
      continue;
    }
    try {
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < window.innerHeight &&
        r.right > 0 &&
        r.left < window.innerWidth
      ) {
        words.push(val);
        textLength += val.length;
      }
    } catch {
      words.push(val);
      textLength += val.length;
    }
  }

  const text = words.join('\n').slice(0, 6000);
  const height = document.documentElement
    ? document.documentElement.scrollHeight
    : document.body.scrollHeight;
  const page_key = cache.pageKey();
  const guards: Record<string | number, any> = {};

  for (const a of actions) {
    if (typeof a.node === 'number' && !(a.node in guards)) {
      guards[a.node] = cache.guard ? cache.guard(cache.nodes.get(a.node)) : null;
    }
  }

  const semantics = actions.map(({ rect, ...rest }) => rest);
  const marker = [
    performance.timeOrigin,
    location.href,
    window.scrollX,
    window.scrollY,
    window.innerWidth,
    window.innerHeight,
    document.title,
    text,
    semantics,
    page_key[6],
  ];

  const omitted_actions = Math.max(0, actions.length - 250);
  actions.splice(250);
  actions.forEach((a, i) => {
    a.id = 'e' + (i + 1);
    if (typeof a.node === 'number') {
      const el = cache.nodes.get(a.node);
      if (el) {
        cache.actionElements?.set(a.id, el);
        cache.actionElements?.set(i + 1, el);
      }
    }
  });

  if (window.scrollY + window.innerHeight < height - 2) {
    actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
  }
  if (window.scrollY > 0) {
    actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 });
  }
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });

  // Clear single-pass layout cache
  DOM_CACHE.clearCache();

  return {
    url: location.href,
    title: document.title,
    w: window.innerWidth,
    h: window.innerHeight,
    text,
    scroll: { y: window.scrollY, height },
    actions,
    marker,
    page_key,
    guards,
    omitted_actions,
  };
}

/**
 * Pre-CDP 1ms instantaneous occlusion check with pointer-events: none piercing.
 * Returns valid target coordinates { x, y } or null if occluded, detached, or out of viewport.
 */
export function inPageCheckOcclusion(action: {
  node: number | string;
  kind?: string;
}): { x: number; y: number } | null {
  if (typeof document === 'undefined') return null;

  const g = globalThis as any;
  const cache = g.__pawFast || g.__clawFast;

  let targetId: number | undefined;
  if (typeof action.node === 'number') {
    targetId = action.node;
  } else if (typeof action.node === 'string') {
    if (action.node.startsWith('e')) {
      targetId = parseInt(action.node.slice(1), 10);
    } else if (action.node.startsWith('ref_')) {
      targetId = parseInt(action.node.slice(4), 10);
    } else if (/^\d+$/.test(action.node)) {
      targetId = parseInt(action.node, 10);
    }
  }

  let e: Element | undefined =
    (typeof action.node === 'string' ? cache?.actionElements?.get(action.node) : undefined) ||
    (targetId !== undefined ? cache?.actionElements?.get(targetId) : undefined) ||
    (targetId !== undefined ? cache?.nodes?.get(targetId) : undefined);

  if (!e && targetId !== undefined) {
    const isoMap = (globalThis as any)[Symbol.for('__browser_use_isolated_index_map__')];
    const wrapped = isoMap?.get(targetId);
    e = wrapped?.deref ? wrapped.deref() : wrapped;
  }
  if (!e && targetId !== undefined) {
    e = (document.querySelector(`[data-mcp-idx="${targetId}"]`) as Element) || undefined;
  }
  if (!e || !e.isConnected) return null;
  if (typeof (e as any).matches === 'function' && (e as any).matches(':disabled')) return null;
  if (typeof e.closest === 'function' && e.closest('[aria-disabled="true"],[inert]')) return null;

  if (
    action.kind === 'fill' &&
    ((e as any).readOnly || e.getAttribute?.('aria-readonly') === 'true')
  ) {
    return null;
  }

  // Use checkVisibility if available
  if (
    typeof (e as any).checkVisibility === 'function' &&
    !(e as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  ) {
    return null;
  }

  const r = e.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  if (
    !r.width ||
    !r.height ||
    x < 0 ||
    y < 0 ||
    x >= window.innerWidth ||
    y >= window.innerHeight
  ) {
    return null;
  }

  // Helper: Deep shadow-piercing elementFromPoint
  const deepElementFromPoint = (
    root: Document | ShadowRoot,
    px: number,
    py: number,
  ): Element | null => {
    let el =
      typeof (root as any).elementFromPoint === 'function'
        ? (root as any).elementFromPoint(px, py)
        : null;
    let sDepth = 0;
    while (el && (el as any).shadowRoot && sDepth < 20) {
      const sr = (el as any).shadowRoot;
      if (typeof sr.elementFromPoint !== 'function') break;
      const inner = sr.elementFromPoint(px, py);
      if (!inner || inner === el) break;
      el = inner;
      sDepth++;
    }
    return el;
  };

  // Helper: Composed hierarchy containment check (traverses parentNode and shadow host)
  const deepContains = (parent: Element, child: Element): boolean => {
    if (parent === child) return true;
    if (typeof parent.contains === 'function' && parent.contains(child)) return true;
    let curr: Node | null = child;
    while (curr) {
      if (curr === parent) return true;
      if ((curr as any).host) {
        curr = (curr as any).host;
      } else {
        curr = curr.parentNode;
      }
    }
    return false;
  };

  // Piercing patch: penetrate shadow roots and pierce pointer-events: none layers
  let hit = deepElementFromPoint(document, x, y);
  let depth = 0;
  while (hit && depth < 5) {
    const pe =
      typeof window.getComputedStyle === 'function'
        ? window.getComputedStyle(hit).pointerEvents
        : '';
    if (pe === 'none') {
      hit = hit.parentElement || ((hit.parentNode as any)?.host as Element) || null;
      depth++;
    } else {
      break;
    }
  }
  if (!hit) return null;

  // Click target must contain the hit element (the target itself, host, or child element like text/icon)
  let isHit = deepContains(e, hit) || hit === e;

  // Check if hit element is a label targeting e
  if (!isHit && hit.tagName === 'LABEL') {
    if ((hit as HTMLLabelElement).control === e || (hit as HTMLLabelElement).htmlFor === e.id) {
      isHit = true;
    }
  }

  // Backdrop / transparent mask piercing tolerance:
  // If hit is an overlay/backdrop and not e, check if temporarily ignoring it hits e
  if (!isHit && hit instanceof HTMLElement) {
    const cls = (
      hit.className && typeof hit.className === 'string' ? hit.className : ''
    ).toLowerCase();
    const role = (hit.getAttribute?.('role') || '').toLowerCase();
    const isOverlayOrBackdrop =
      cls.includes('backdrop') ||
      cls.includes('overlay') ||
      cls.includes('mask') ||
      cls.includes('scrim') ||
      cls.includes('dimmer') ||
      role === 'presentation';

    if (isOverlayOrBackdrop && hit !== document.body && hit !== document.documentElement) {
      const prevPE = hit.style.pointerEvents;
      try {
        hit.style.pointerEvents = 'none';
        const nextHit = deepElementFromPoint(document, x, y);
        if (nextHit && (deepContains(e, nextHit) || nextHit === e)) {
          isHit = true;
        }
      } finally {
        hit.style.pointerEvents = prevPE;
      }
    }
  }

  if (!isHit) {
    return null;
  }

  return { x, y };
}
