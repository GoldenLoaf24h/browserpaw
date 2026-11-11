import {
  resolveToolName,
  type IndexedElement,
  type PageAsset,
  type PrunedDOMTreeResult,
  type ScrollInfo,
  type ScrollUntilFoundOptions,
  type ScrollUntilFoundResult,
} from 'chrome-mcp-shared';

/**
 * Standard structured self-healing guidance when an element is not found or expired
 */
export const DIAGNOSTIC_REFRESH_GUIDANCE = `ACTION REQUIRED: Please call '${resolveToolName('read_dom')}' to refresh the index tree before re-attempting interaction`;

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

export interface FormObservationMetadata {
  label?: string;
  description?: string;
  errormessage?: string;
  invalid: boolean;
  invalidRaw?: string;
  valid?: boolean;
  required?: boolean;
  invalidReason?: string;
  validationMessage?: string;
}

export function isAriaInvalidToken(value: string | null | undefined): boolean {
  const token = (value || '').trim().toLowerCase();
  return token !== '' && token !== 'false';
}

export function readFormObservationMetadata(el: Element): FormObservationMetadata | null {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').trim().toLowerCase();
  const editable =
    (el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === '';
  const nativeControl = tag === 'input' || tag === 'textarea' || tag === 'select';
  const formRole = ['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(role);
  if (!nativeControl && !editable && !formRole) return null;

  const rawInvalid = el.getAttribute('aria-invalid');
  const ariaInvalid = isAriaInvalidToken(rawInvalid);
  const validity = nativeControl ? (el as HTMLInputElement).validity : undefined;
  const invalid = ariaInvalid || validity?.valid === false;
  const invalidReason = (
    [
      'valueMissing',
      'typeMismatch',
      'patternMismatch',
      'tooShort',
      'tooLong',
      'rangeUnderflow',
      'rangeOverflow',
      'stepMismatch',
      'badInput',
      'customError',
    ] as const
  ).find((reason) => validity?.[reason]);
  const validationMessage = nativeControl ? (el as HTMLInputElement).validationMessage : '';
  const label = getLocatorAccessibleName(el).replace(/\s+/g, ' ').trim().slice(0, 120);
  const description = getAriaReferenceText(el, 'aria-describedby', 120);
  const errormessage = ariaInvalid ? getAriaReferenceText(el, 'aria-errormessage', 120) : '';

  return {
    invalid,
    ...(validity ? { valid: !invalid } : {}),
    ...(el.hasAttribute('required') || el.getAttribute('aria-required') === 'true'
      ? { required: true }
      : {}),
    ...(invalidReason || ariaInvalid ? { invalidReason: invalidReason || 'aria-invalid' } : {}),
    ...(validationMessage ? { validationMessage: String(validationMessage).slice(0, 120) } : {}),
    ...(rawInvalid?.trim() ? { invalidRaw: rawInvalid.trim() } : {}),
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(errormessage ? { errormessage } : {}),
  };
}

import {
  getTableObservationRole,
  createTableObservationCache,
  isPresentationalNativeTable,
  buildTableObservation,
  hasDirectTableAction,
  type TableObservationRole,
  type TableObservation,
  type TableObservationMetadata,
  type TableObservationCache,
} from './dom-indexer/table-observation';

export {
  getTableObservationRole,
  createTableObservationCache,
  isPresentationalNativeTable,
  buildTableObservation,
  hasDirectTableAction,
  type TableObservationRole,
  type TableObservation,
  type TableObservationMetadata,
  type TableObservationCache,
};
export function pruneDetachedIndices(): void {
  for (const [index, entry] of getIsolatedIndexMap()) {
    const el = derefElement(entry);
    if (!el?.isConnected || el.ownerDocument !== document) {
      getIsolatedIndexMap().delete(index);
    }
  }
}

/**
 * Mapping from DOM Element to its verified unoccluded safe click point
 * computed during 9-point grid occlusion sampling.
 *
 * Pinned to globalThis under a registered symbol for the same reason as the
 * isolated index map above: the in-page engine is injected as a file, and a
 * module-scope WeakMap is rebuilt whenever that file re-executes, silently
 * dropping the occlusion-safe click point between chrome_read_dom (writer) and
 * chrome_interact_index (reader) — which degraded clicks back to the geometric
 * centre of partially covered elements.
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

/**
 * Shadow DOM and composed tree traversal helpers.
 * These enable penetrating Shadow DOM boundaries to find the true interactive target.
 */
export function composedParent(element: Element | null): Element | null {
  if (!element) return null;
  if ((element as any).assignedSlot) return (element as any).assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode ? element.getRootNode() : null;
  return root && root.nodeType === 11 ? (root as ShadowRoot).host : null;
}

export function composedChildren(element: Element): Element[] {
  if (!element) return [];
  if (element.tagName.toUpperCase() === 'SLOT') {
    const assigned = (element as HTMLSlotElement).assignedElements?.({ flatten: true }) || [];
    if (assigned.length > 0) return assigned;
  }
  const container = getShadowRoot(element) || element;
  return Array.from(container.children || []) as Element[];
}

/**
 * Checks whether an ancestor node contains a descendant across open and composed shadow boundaries.
 */
export function composedContains(ancestor: Node | null, descendant: Node | null): boolean {
  if (!ancestor || !descendant) return false;
  let cur: Element | null =
    descendant instanceof Element ? descendant : (descendant.parentElement as Element | null);
  while (cur) {
    if (cur === ancestor) return true;
    cur = composedParent(cur);
  }
  return false;
}

export function observationFocusScope(active: Element | null): Element | null {
  const form = (active as HTMLInputElement | null)?.form;
  if (form) return form;
  for (let element = active; element; element = composedParent(element)) {
    if (element.matches('form,dialog,[role="form"],[role="dialog"],article,li,tr,[role="row"]'))
      return element;
  }
  return null;
}

export function withinObservationFocusScope(element: Element, scope: Element | null): boolean {
  return (
    !!scope && ((element as HTMLInputElement).form === scope || composedContains(scope, element))
  );
}

export function hitElementAtPoint(target: Element, x: number, y: number): Element | null {
  const deep = deepElementFromPoint(x, y);
  if (!deep) return null;
  if (deep === target || composedContains(target, deep) || composedContains(deep, target)) {
    return deep;
  }
  return deep;
}

export function interceptingElementAtPoint(target: Element, x: number, y: number): Element | null {
  const hitElement = hitElementAtPoint(target, x, y);
  if (!hitElement) return null;

  let current: Element | null = hitElement;
  while (current && current !== target) current = composedParent(current);
  if (current === target) return null;

  current = target;
  while (current && current !== hitElement) current = composedParent(current);
  if (current === hitElement) return null; // It's the target itself or inside it

  return hitElement;
}

export function describeHitTarget(element: Element): string {
  let modal: Element | null = element;
  while (modal) {
    const role = modal.getAttribute?.('role');
    const ariaModal = modal.getAttribute?.('aria-modal');
    if (role === 'dialog' || ariaModal === 'true') {
      const name =
        modal.getAttribute?.('aria-label') ||
        modal.getAttribute?.('aria-labelledby') ||
        modal.querySelector?.('h1,h2,h3,h4,h5,h6')?.textContent?.trim();
      return name ? `dialog "${name}"` : 'dialog';
    }
    modal = composedParent(modal);
  }

  const tag = element.tagName.toLowerCase();
  const id = element.id ? ` id="${element.id}"` : '';
  const classAttr =
    typeof element.className === 'string' && element.className.trim()
      ? ` class="${element.className.trim()}"`
      : '';
  const roleAttr = element.getAttribute?.('role') ? ` role="${element.getAttribute('role')}"` : '';
  return `<${tag}${id}${classAttr}${roleAttr}>`;
}

/**
 * Whitelist check for interactive SVG nodes (e.g. icons, clickable vectors).
 * Prevents non-standard interactive SVG elements from being pruned as decorative.
 */
export function isInteractiveSvgNode(el: Element, style?: CSSStyleDeclaration): boolean {
  if (!el || (typeof Element !== 'undefined' && !(el instanceof Element) && !(el as any).tagName))
    return false;
  const tag = (el.tagName || '').toLowerCase();
  const isSvg =
    tag === 'svg' ||
    /^(path|g|rect|circle|line|polygon|polyline|ellipse|text|tspan|use|image)$/i.test(tag) ||
    el.namespaceURI === 'http://www.w3.org/2000/svg' ||
    (typeof el.closest === 'function' && Boolean(el.closest('svg')));
  if (!isSvg) return false;

  if (
    /^(defs|clippath|mask|pattern|lineargradient|radialgradient|filter|metadata|style|title|desc)$/i.test(
      tag,
    )
  ) {
    return false;
  }
  const role = el.getAttribute?.('role')?.toLowerCase();
  if (role && /^(button|link|checkbox|menuitem|tab|switch)$/.test(role)) return true;
  if (
    el.hasAttribute?.('onclick') ||
    el.hasAttribute?.('onmousedown') ||
    typeof (el as any).onclick === 'function'
  )
    return true;
  const tabIndex =
    typeof (el as HTMLElement).tabIndex === 'number' ? (el as HTMLElement).tabIndex : -1;
  if (
    tabIndex >= 0 ||
    (el.hasAttribute?.('tabindex') && !el.getAttribute('tabindex')?.startsWith('-'))
  )
    return true;
  if (style && (style.cursor === 'pointer' || /grab|grabbing|move/i.test(style.cursor)))
    return true;
  if (typeof el.getAttributeNames === 'function') {
    for (const name of el.getAttributeNames()) {
      if (
        /^data-(action|click|target|toggle|trigger|handler|command|interactive|button|nav|href|url|route|press|event)/i.test(
          name,
        )
      ) {
        return true;
      }
    }
  }
  const id = (el.id || el.getAttribute?.('id') || '').trim();
  if (id !== '') {
    // Exclude auto-generated machine SVG IDs (e.g. clip0_123, paint0_linear, path123, rect45)
    const isGenerated =
      /^(clip|paint|mask|gradient|linear|radial|pattern|filter|path|svg|layer|group|rect|circle|ellipse|shape|icon|image)[-_0-9a-z]*$/i.test(
        id,
      ) || /^[0-9a-f]{8,}$/i.test(id);
    if (!isGenerated) return true;
  }
  if (el.hasAttribute?.('aria-haspopup') || el.hasAttribute?.('aria-expanded')) return true;
  return false;
}

/**
 * Pierce open or closed ShadowRoot using chrome.dom.openOrClosedShadowRoot when available,
 * falling back to native el.shadowRoot.
 */
export function getShadowRoot(node: Node | null | undefined): ShadowRoot | null {
  if (!node || (typeof Element !== 'undefined' && !(node instanceof Element))) return null;
  try {
    if (typeof chrome !== 'undefined' && chrome?.dom?.openOrClosedShadowRoot) {
      const sr = chrome.dom.openOrClosedShadowRoot(node as HTMLElement);
      if (sr) return sr;
    }
  } catch {}
  return (node as Element).shadowRoot || null;
}

export function getDeepActiveElement(): Element | null {
  let active = typeof document !== 'undefined' ? document.activeElement : null;
  const seen = new Set<Element>();
  while (active && !seen.has(active)) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) break;
    seen.add(active);
    const inner = getShadowRoot(active)?.activeElement;
    if (!inner || inner === active) break;
    active = inner;
  }
  return active;
}

/**
 * Check if a node is an autonomous or customized Web Component custom element.
 */
export function isCustomElement(node: Node | null | undefined): boolean {
  if (!node || (typeof Element !== 'undefined' && !(node instanceof Element))) return false;
  const tag = ((node as Element).tagName || '').toLowerCase();
  return tag.includes('-') || Boolean((node as Element).getAttribute?.('is'));
}

/**
 * Resolves the true visual element at (x, y) by descending through all open and closed ShadowRoot boundaries.
 */
export function deepElementFromPoint(
  x: number,
  y: number,
  startRoot?: Document | ShadowRoot | Element,
): Element | null {
  const doc: Document | null =
    (startRoot &&
      ((startRoot as any).ownerDocument ||
        ((startRoot as any).nodeType === 9 ? (startRoot as Document) : null))) ||
    (typeof document !== 'undefined' ? document : null);
  if (!doc && !startRoot) return null;

  let current: Element | null = null;
  try {
    if (
      startRoot &&
      ((typeof Document !== 'undefined' && startRoot instanceof Document) ||
        (startRoot as any).nodeType === 11 ||
        (startRoot as any).nodeType === 9 ||
        typeof (startRoot as any).elementFromPoint === 'function')
    ) {
      current = (startRoot as Document | ShadowRoot).elementFromPoint(x, y);
    } else if (
      startRoot &&
      ((typeof Element !== 'undefined' && startRoot instanceof Element) ||
        Boolean((startRoot as any).tagName))
    ) {
      const sr = getShadowRoot(startRoot as Element);
      if (sr && typeof (sr as any).elementFromPoint === 'function') {
        current = (sr as any).elementFromPoint(x, y);
      } else {
        current = startRoot as Element;
      }
    } else if (doc && typeof doc.elementFromPoint === 'function') {
      current = doc.elementFromPoint(x, y);
    }
  } catch {}

  if (!current) return null;

  const visited = new Set<Element>();
  while (current && !visited.has(current)) {
    visited.add(current);
    try {
      const shadow = getShadowRoot(current);
      if (shadow && typeof (shadow as any).elementFromPoint === 'function') {
        const inner = (shadow as any).elementFromPoint(x, y);
        if (inner && inner !== current) {
          current = inner;
          continue;
        }
      }
    } catch {}
    break;
  }
  return current;
}

/**
 * Split a string by a single character delimiter unless that delimiter is inside quotes (single or double).
 * Reference: webdriverio/query-selector-shadow-dom (splitByCharacterUnlessQuoted)
 */
export function splitByCharacterUnlessQuoted(selector: string, character: string): string[] {
  const matches = selector.match(/\\?.|^$/gs);
  if (!matches) return [selector];
  return matches.reduce(
    (p: { quote: number; sQuote: number; a: string[] }, c: string) => {
      if (c === '"' && !p.sQuote) {
        p.quote ^= 1;
        p.a[p.a.length - 1] += c;
      } else if (c === "'" && !p.quote) {
        p.sQuote ^= 1;
        p.a[p.a.length - 1] += c;
      } else if (!p.quote && !p.sQuote && c === character) {
        p.a.push('');
      } else {
        p.a[p.a.length - 1] += c;
      }
      return p;
    },
    { quote: 0, sQuote: 0, a: [''] },
  ).a;
}

/**
 * Traverse across shadow boundaries upwards to find parent element or host element.
 * Reference: Playwright (parentElementOrShadowHost) & WebdriverIO (findParentOrHost)
 */
export function parentElementOrShadowHost(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  if (!element.parentNode) return null;
  if (element.parentNode.nodeType === 11 && (element.parentNode as ShadowRoot).host) {
    return (element.parentNode as ShadowRoot).host as Element;
  }
  return null;
}

/**
 * Normalizes explicit shadow-piercing combinators ('>>>', '/deep/', and '>>') outside quotes to whitespace.
 */
function normalizeExplicitCombinators(selector: string): string {
  const matches = selector.match(/\\?.|^$/gs) || [];
  let quote = 0;
  let sQuote = 0;
  let result = '';

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      quote ^= 1;
      result += c;
    } else if (c === "'" && !quote) {
      sQuote ^= 1;
      result += c;
    } else if (!quote && !sQuote) {
      if (
        c === '/' &&
        matches[i + 1] === 'd' &&
        matches[i + 2] === 'e' &&
        matches[i + 3] === 'e' &&
        matches[i + 4] === 'p' &&
        matches[i + 5] === '/'
      ) {
        result += ' ';
        i += 5;
        continue;
      }
      if (c === '>' && matches[i + 1] === '>' && matches[i + 2] === '>') {
        result += ' ';
        i += 2;
        continue;
      }
      if (c === '>' && matches[i + 1] === '>') {
        result += ' ';
        i += 1;
        continue;
      }
      result += c;
    } else {
      result += c;
    }
  }
  return result;
}

/**
 * Atomic in-page client-side auto-scroll until target element is found.
 * Executes smooth step-by-step scrolling, waits for virtual lists / dynamic DOM recycling
 * to settle, searches both standard light DOM and encapsulated open/closed ShadowRoots,
 * centers matched target in the viewport, allocates/refreshes a live 1-based index,
 * and returns live index and coordinates.
 */
export async function inPageScrollUntilFound(
  options: ScrollUntilFoundOptions,
): Promise<ScrollUntilFoundResult> {
  const query = options?.query?.trim();
  const selector = options?.selector?.trim();
  if (!query && !selector) {
    return {
      found: false,
      stepsTaken: 0,
      scrolledPx: 0,
      message: 'Either query or selector must be provided for scroll_until_found',
    };
  }

  const maxSteps = Math.min(Math.max(1, options?.maxSteps ?? 10), 30);
  const stepPx = Math.min(Math.max(50, options?.stepPx ?? 800), 3000);
  const direction = options?.direction === 'up' ? 'up' : 'down';
  const settleMs = Math.min(Math.max(50, options?.settleMs ?? 150), 1000);
  const timeoutMs = Math.min(Math.max(1000, options?.timeoutMs ?? 15000), 60000);
  const startTime = Date.now();

  let targetRegex: RegExp | null = null;
  if (query) {
    try {
      targetRegex = options.isRegex
        ? new RegExp(query, 'i')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
      targetRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }

  // Resolve scroll container
  let container: HTMLElement | Window = window;
  if (options?.containerSelector) {
    const el = querySelectorDeep(options.containerSelector);
    if (el instanceof HTMLElement) {
      container = el;
    }
  }

  function probeTarget(): Element | null {
    if (typeof document === 'undefined') return null;

    const expectedRole = options?.role?.trim().toLowerCase();
    function inferElementRole(el: Element): string | null {
      const explicitRole = el.getAttribute('role')?.trim().toLowerCase();
      if (explicitRole) return explicitRole;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').trim().toLowerCase();
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'search') return 'searchbox';
        if (['text', 'email', 'tel', 'url', 'number', ''].includes(type)) return 'textbox';
        return null;
      }
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'article') return 'article';
      if (tag === 'nav') return 'navigation';
      if (tag === 'main') return 'main';
      if (tag === 'header') return 'banner';
      if (tag === 'footer') return 'contentinfo';
      if (tag === 'aside') return 'complementary';
      if (tag === 'form') return 'form';
      if (tag === 'dialog') return 'dialog';
      if (tag === 'img') return 'img';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'ul' || tag === 'ol') return 'list';
      if (tag === 'li') return 'listitem';
      if (tag === 'table') return 'table';
      if (tag === 'tr') return 'row';
      if (tag === 'td') return 'cell';
      if (tag === 'th') return 'columnheader';
      return null;
    }
    function roleMatches(el: Element): boolean {
      if (!expectedRole) return true;
      const actualRole = inferElementRole(el);
      return actualRole === expectedRole;
    }

    if (selector) {
      const candidates = querySelectorAllDeep(selector, document);
      for (const el of candidates) {
        if (!el || !(el instanceof Element)) continue;
        if (!roleMatches(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            if (!query || (targetRegex && targetRegex.test(el.textContent || ''))) {
              return el;
            }
          }
        }
      }
    }

    if (targetRegex) {
      const candidates = querySelectorAllDeep(
        'button, a, input, textarea, select, h1, h2, h3, h4, h5, h6, [role="button"], [role="article"], [role="link"], [data-testid], article, p, span, li, div, section, blockquote, label, td, th, dt, dd, strong, b, i, em, code, pre, figcaption',
        document,
      );
      for (const el of candidates) {
        if (!el || !(el instanceof Element)) continue;
        const text = (
          el.textContent ||
          el.getAttribute('aria-label') ||
          (el as HTMLInputElement).placeholder ||
          (el as HTMLInputElement).value ||
          ''
        ).trim();
        if (text && targetRegex.test(text)) {
          if (!roleMatches(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              return el;
            }
          }
        }
      }
    }

    return null;
  }

  function getScrollPos(): number {
    if (container instanceof Window) {
      return window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0;
    }
    return container.scrollTop;
  }

  function doScroll(delta: number): void {
    if (container instanceof Window) {
      window.scrollBy({ top: delta, left: 0, behavior: 'instant' as any });
    } else {
      container.scrollBy({ top: delta, left: 0, behavior: 'instant' as any });
    }
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let stepsTaken = 0;
  let totalScrolledPx = 0;
  let lastPos = getScrollPos();
  let stallCount = 0;

  for (let step = 0; step <= maxSteps; step++) {
    if (Date.now() - startTime > timeoutMs) {
      break;
    }

    const hit = probeTarget();
    if (hit) {
      if (options?.actionOnFound === 'none') {
        // actionOnFound none: do not force scrollIntoView
      } else if (options?.actionOnFound === 'focus') {
        // actionOnFound focus: focus within page with preventScroll to avoid implicit scrolling
        try {
          (hit as HTMLElement).focus?.({ preventScroll: true });
        } catch {}
      } else {
        // default 'scroll_into_view' or 'click': center in viewport
        try {
          hit.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as any });
        } catch {}
        await wait(50);
      }

      // Resolve or allocate live 1-based index in isolatedMap
      let targetIndex: number | undefined;
      const isolatedMap = getIsolatedIndexMap();
      for (const [idx, ref] of isolatedMap.entries()) {
        if (derefElement(ref) === hit) {
          targetIndex = idx;
          break;
        }
      }

      if (targetIndex === undefined) {
        targetIndex = indexElement(hit);
      }

      const rect = hit.getBoundingClientRect();
      const coords = {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };

      const matchText = (hit.textContent || hit.getAttribute('aria-label') || '')
        .trim()
        .slice(0, 100);

      return {
        found: true,
        index: targetIndex,
        tagName: hit.tagName.toLowerCase(),
        text: matchText,
        stepsTaken,
        scrolledPx: totalScrolledPx,
        coordinates: coords,
        message: `Found target "${matchText || query || selector}" at index [${targetIndex}] after ${stepsTaken} step(s) (${totalScrolledPx}px). Element centered in viewport.`,
      };
    }

    if (step === maxSteps) {
      break;
    }

    const delta = direction === 'up' ? -stepPx : stepPx;
    doScroll(delta);
    stepsTaken++;
    totalScrolledPx += stepPx;

    await wait(settleMs);

    const currentPos = getScrollPos();
    if (Math.abs(currentPos - lastPos) < 2) {
      stallCount++;
      // If initial window scroll did not move, attempt fallback to smart inner container
      if (stallCount === 1 && container instanceof Window && !options?.containerSelector) {
        try {
          const smart = inPageFindSmartScrollTarget({ direction });
          if (smart && !smart.isWindow && smart.selector) {
            const el = querySelectorDeep(smart.selector);
            if (el instanceof HTMLElement) {
              container = el;
              lastPos = getScrollPos();
              stallCount = 0;
            }
          }
        } catch {}
      } else if (stallCount >= 2) {
        break;
      }
    } else {
      stallCount = 0;
    }
    lastPos = currentPos;
  }

  return {
    found: false,
    stepsTaken,
    scrolledPx: totalScrolledPx,
    message: `Target "${query || selector}" not found after ${stepsTaken} step(s) (${totalScrolledPx}px scrolled).`,
  };
}

/**
 * Folds whitespace around standard CSS combinators ('>', '+', '~') outside quotes.
 */
function foldCombinatorsUnlessQuoted(selector: string): string {
  const matches = selector.match(/\\?.|^$/gs) || [];
  let quote = 0;
  let sQuote = 0;
  let currentUnquoted = '';
  let result = '';

  const flushUnquoted = () => {
    if (currentUnquoted) {
      const folded = currentUnquoted
        .replace(/\s*([+~])\s*/g, '$1')
        .replace(/(?<!>)\s*>\s*(?!>)/g, '>');
      result += folded;
      currentUnquoted = '';
    }
  };

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      if (!quote) flushUnquoted();
      quote ^= 1;
      result += c;
    } else if (c === "'" && !quote) {
      if (!sQuote) flushUnquoted();
      sQuote ^= 1;
      result += c;
    } else if (quote || sQuote) {
      result += c;
    } else {
      currentUnquoted += c;
    }
  }
  flushUnquoted();
  return result;
}

/**
 * Safely split a selector by delimiter (default space):
 * 1. Folds whitespace around child (>), next-sibling (+), and subsequent-sibling (~) combinators outside quotes;
 * 2. Splits using single/double quote and bracket/paren state machine so whitespace inside quotes,
 *    attribute brackets [...], and pseudo-classes (...) is preserved;
 * 3. Supports explicit piercing combinators ' >> ', '>>>', '/deep/'.
 */
export function splitSelectorSafely(selector: string, delimiter: string = ' '): string[] {
  if (!selector) return [];
  const normalized = normalizeExplicitCombinators(selector);
  const folded = foldCombinatorsUnlessQuoted(normalized);

  const matches = folded.match(/\\?.|^$/gs);
  if (!matches) return [folded.trim()].filter(Boolean);

  let quote = 0;
  let sQuote = 0;
  let brackets = 0;
  let parens = 0;
  const parts: string[] = [''];

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      quote ^= 1;
      parts[parts.length - 1] += c;
    } else if (c === "'" && !quote) {
      sQuote ^= 1;
      parts[parts.length - 1] += c;
    } else if (!quote && !sQuote) {
      if (c === '[') brackets++;
      else if (c === ']' && brackets > 0) brackets--;
      else if (c === '(') parens++;
      else if (c === ')' && parens > 0) parens--;

      if (
        brackets === 0 &&
        parens === 0 &&
        (c === delimiter || (delimiter === ' ' && /\s/.test(c)))
      ) {
        parts.push('');
      } else {
        parts[parts.length - 1] += c;
      }
    } else {
      parts[parts.length - 1] += c;
    }
  }

  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Single-segment search within a root across all open and closed ShadowRoot boundaries.
 */
function querySelectorAllDeepSingle(selector: string, root: ParentNode): Element[] {
  const results: Element[] = [];
  const visitedRoots = new Set<Node>();

  function search(currentRoot: ParentNode) {
    if (!currentRoot || visitedRoots.has(currentRoot)) return;
    visitedRoots.add(currentRoot);

    try {
      const matches = currentRoot.querySelectorAll(selector);
      for (let i = 0; i < matches.length; i++) {
        results.push(matches[i]);
      }
    } catch {}

    let allEls: NodeListOf<Element>;
    try {
      allEls = currentRoot.querySelectorAll('*');
    } catch {
      return;
    }

    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      const shadow = getShadowRoot(el);
      if (shadow) {
        search(shadow);
      }
    }
  }

  if (typeof Element !== 'undefined' && root instanceof Element) {
    const rootShadow = getShadowRoot(root);
    if (rootShadow) {
      search(rootShadow);
    }
  }

  search(root);
  return results;
}

/**
 * Deep query selector that penetrates all open (and closed when supported) ShadowRoot boundaries.
 * Traverses recursively through both standard light DOM and encapsulated component shadow roots.
 * Supports explicit piercing (' >> ', '>>>', '/deep/') and composite descendant selectors
 * (e.g. 'shreddit-markdown-composer textarea') across shadow boundaries.
 */
export function querySelectorAllDeep(
  selector: string,
  root: ParentNode = typeof document !== 'undefined' ? document : (null as any),
): Element[] {
  if (!root || !selector || typeof selector !== 'string') return [];

  // Comma-separated selector list handling
  const commaSeparators = splitSelectorSafely(selector, ',');
  if (commaSeparators.length > 1) {
    const hasComplexSegment = commaSeparators.some(
      (sub) => splitSelectorSafely(sub, ' ').length > 1,
    );
    if (hasComplexSegment) {
      const combined: Element[] = [];
      for (const sub of commaSeparators) {
        const subMatches = querySelectorAllDeep(sub, root);
        for (const m of subMatches) {
          if (!combined.includes(m)) {
            combined.push(m);
          }
        }
      }
      return combined;
    }
    return querySelectorAllDeepSingle(selector, root);
  }

  const segments = splitSelectorSafely(selector, ' ');
  if (segments.length === 0) return [];

  if (segments.length === 1) {
    return querySelectorAllDeepSingle(segments[0], root);
  }

  // Multi-segment composite descendant selector piercing across Shadow DOM boundaries:
  // Each segment is matched across Document and all reachable ShadowRoots.
  // Between segments, context retains both the element itself and its shadowRoot (for slotted & shadow children).
  let currentContexts: ParentNode[] = [root];
  if (typeof Element !== 'undefined' && root instanceof Element) {
    const rootShadow = getShadowRoot(root);
    if (rootShadow) {
      currentContexts.push(rootShadow);
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const subSelector = segments[i];
    const isLast = i === segments.length - 1;
    const nextMatches: Element[] = [];

    for (const ctx of currentContexts) {
      const matched = querySelectorAllDeepSingle(subSelector, ctx);
      for (const m of matched) {
        if (!nextMatches.includes(m)) {
          nextMatches.push(m);
        }
      }
    }

    if (isLast) {
      return nextMatches;
    }

    const nextContexts: ParentNode[] = [];
    for (const m of nextMatches) {
      if (!nextContexts.includes(m)) {
        nextContexts.push(m);
      }
      const sr = getShadowRoot(m);
      if (sr && !nextContexts.includes(sr)) {
        nextContexts.push(sr);
      }
    }
    currentContexts = nextContexts;
    if (currentContexts.length === 0) return [];
  }

  return [];
}

/**
 * Deep query selector returning the first matching element across all shadow boundaries.
 */
export function querySelectorDeep(
  selector: string,
  root: ParentNode = typeof document !== 'undefined' ? document : (null as any),
): Element | null {
  const all = querySelectorAllDeep(selector, root);
  return all.length > 0 ? all[0] : null;
}

export function computeScopeHash(text: string): string {
  if (!text) return '';
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) + hash + text.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16);
}

export interface ParsedIndex {
  numericIndex: number;
  isExplicitFast: boolean;
  rawString?: string;
}

export function parseElementIndex(refOrIndex: unknown): ParsedIndex | null {
  if (typeof refOrIndex === 'number') {
    if (Number.isSafeInteger(refOrIndex) && refOrIndex > 0) {
      return { numericIndex: refOrIndex, isExplicitFast: false };
    }
    return null;
  }
  if (typeof refOrIndex === 'string') {
    const trimmed = refOrIndex.trim();
    if (!trimmed) return null;
    const fastMatch = trimmed.match(/^e(\d+)$/i);
    if (fastMatch) {
      const num = parseInt(fastMatch[1], 10);
      if (Number.isSafeInteger(num) && num > 0) {
        return { numericIndex: num, isExplicitFast: true, rawString: trimmed };
      }
      return null;
    }
    const refMatch = trimmed.match(/^ref_(\d+)$/i);
    if (refMatch) {
      const num = parseInt(refMatch[1], 10);
      if (Number.isSafeInteger(num) && num > 0) {
        return { numericIndex: num, isExplicitFast: false, rawString: trimmed };
      }
      return null;
    }
    const numMatch = trimmed.match(/^(\d+)$/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      if (Number.isSafeInteger(num) && num > 0) {
        return { numericIndex: num, isExplicitFast: false, rawString: trimmed };
      }
      return null;
    }
  }
  return null;
}

export function findIndexedElement(index: number | string): Element | null {
  const parsed = parseElementIndex(index);
  if (!parsed) return null;

  const entry = getIsolatedIndexMap().get(parsed.numericIndex);
  const el = derefElement(entry);
  if (!el?.isConnected || el.ownerDocument !== document) return null;
  return el;
}

/**
 * Remove Set-of-Mark visual badges overlay if present.
 */
export function inPageRemoveHighlights(): boolean {
  const overlay = document.getElementById('__mcp_som_overlay_container__');
  if (overlay) {
    overlay.remove();
    return true;
  }
  return false;
}

/**
 * Extract clean, high-signal text from an element:
 * - For <select>, extracts only currently selected option text (saving 90%+ tokens and exposing form state)
 * - For elements without text, checks ::before and ::after pseudo-element content
 */
export function extractCleanElementText(el: Element, maxLen = 120): string {
  if (!el) return '';
  const tag = (el.tagName || '').toLowerCase();
  let text = '';

  if (tag === 'select') {
    const selectEl = el as HTMLSelectElement;
    text = (selectEl.selectedOptions?.[0]?.text || selectEl.value || '').trim();
  } else {
    text = ((el as HTMLElement).innerText || el.textContent || '').trim();
  }

  if (!text) {
    try {
      const win =
        el.ownerDocument?.defaultView ||
        (typeof window !== 'undefined' ? window : (globalThis as any).window);
      if (win && typeof win.getComputedStyle === 'function') {
        const cleanContent = (c?: string): string => {
          if (!c || c === 'none' || c === 'normal') return '';
          let str = c.replace(/^["']|["']$/g, '').trim();
          // Decode CSS unicode escapes like \00d7, \u00d7, \2715, or \1F50D
          str = str.replace(/\\(?:u([0-9a-fA-F]{4})|([0-9a-fA-F]{1,6})\s?)/g, (_, uHex, hex) => {
            const code = parseInt(uHex || hex, 16);
            try {
              return isNaN(code) || code > 0x10ffff ? _ : String.fromCodePoint(code);
            } catch {
              return _;
            }
          });
          return str.trim();
        };
        let beforeContent: string | undefined;
        let afterContent: string | undefined;
        const isJsdom =
          typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
        if (!isJsdom) {
          try {
            beforeContent = win.getComputedStyle(el, '::before')?.getPropertyValue('content');
            afterContent = win.getComputedStyle(el, '::after')?.getPropertyValue('content');
          } catch {}
        }
        const bText = cleanContent(beforeContent);
        const aText = cleanContent(afterContent);
        const pseudoText = [bText, aText].filter(Boolean).join(' ').trim();
        if (pseudoText) {
          text = pseudoText;
        }
      }
    } catch {}
  }

  if (!text) {
    // 1. ARIA labelledby (highest priority in W3C accessible name specification)
    text = getAriaLabelledByText(el);
  }

  if (!text) {
    // 2. Semantic accessibility label extraction (aria-label, title, aria-description)
    const ariaLabel = el.getAttribute?.('aria-label')?.trim();
    if (ariaLabel) {
      text = ariaLabel;
    } else {
      const rawValue = String((el as HTMLInputElement).value ?? '').trim();
      const nativeLabel = getNativeLabelText(el);
      if (nativeLabel && nativeLabel !== rawValue) {
        text = nativeLabel;
      } else {
        const title = el.getAttribute?.('title')?.trim();
        if (title) {
          text = title;
        } else {
          const ariaDesc = el.getAttribute?.('aria-description')?.trim();
          if (ariaDesc) {
            text = ariaDesc;
          } else {
            // 3. Inner accessible children ([role="img"][aria-label], [aria-label], SVG titles)
            try {
              const innerRoleImg = el
                .querySelector?.('[role="img"][aria-label]')
                ?.getAttribute('aria-label')
                ?.trim();
              const svgAria = el
                .querySelector?.('svg[aria-label]')
                ?.getAttribute('aria-label')
                ?.trim();
              const svgTitle = el.querySelector?.('svg title, svg desc')?.textContent?.trim();
              const anyInnerAria = el
                .querySelector?.('[aria-label]')
                ?.getAttribute('aria-label')
                ?.trim();
              if (innerRoleImg) text = innerRoleImg;
              else if (svgAria) text = svgAria;
              else if (svgTitle) text = svgTitle;
              else if (anyInnerAria) text = anyInnerAria;
            } catch {}
          }
        }
      }
    }
  }

  // 4. Parent custom element wrapper semantics (e.g. Reddit <faceplate-tracker action="reply"> wrapping button)
  if (!text && el.parentElement && isCustomElement(el.parentElement)) {
    const parent = el.parentElement;
    const parentLabel =
      parent.getAttribute('aria-label') ||
      parent.getAttribute('action') ||
      parent.getAttribute('data-action') ||
      parent.getAttribute('data-testid');
    if (parentLabel && typeof parentLabel === 'string') {
      text = parentLabel.replace(/[-_]/g, ' ').trim();
    }
  }

  // 5. Element's own action/test attributes
  if (!text) {
    const actionAttr =
      el.getAttribute?.('data-action') ||
      el.getAttribute?.('data-testid') ||
      el.getAttribute?.('data-tooltip') ||
      el.getAttribute?.('data-click-id');
    if (actionAttr && typeof actionAttr === 'string') {
      text = actionAttr.replace(/[-_]/g, ' ').trim();
    }
  }

  // If still empty and element has slotted children (Web Component container), extract slotted text
  if (!text && typeof el.querySelectorAll === 'function') {
    try {
      const slots = el.querySelectorAll('slot');
      if (slots.length > 0) {
        const slotTexts: string[] = [];
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const assigned =
            typeof slot.assignedNodes === 'function' ? slot.assignedNodes({ flatten: true }) : [];
          for (const n of assigned) {
            const t = n.textContent?.trim();
            if (t) slotTexts.push(t);
          }
        }
        if (slotTexts.length > 0) {
          text = slotTexts.join(' ');
        }
      }
    } catch {}
  }

  if (tag === 'input') {
    const inputValue = String((el as HTMLInputElement).value ?? '').trim();
    if (inputValue && text.trim() === inputValue) text = '';
  }

  // Strip Unicode Private Use Area (PUA) characters (\uE000-\uF8FF) used by icon fonts
  // (e.g. \ue610 on JD/Taobao/FontAwesome), which crash Windows GBK console / python stdout.
  const sanitized = text
    .replace(/[\uE000-\uF8FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized.slice(0, maxLen);
}

export function getSameRootReference(el: Element, id: string): Element | null {
  const root = el.getRootNode?.() as Document | ShadowRoot | null;
  if (!root) return null;
  try {
    if (typeof (root as Document).getElementById === 'function') {
      return (root as Document).getElementById(id);
    }
    return root.querySelector?.(`#${CSS.escape(id)}`) || null;
  } catch {
    return null;
  }
}

export function getVisibleReferenceText(ref: Element | null, maxLen: number): string {
  if (!ref || maxLen <= 0) return '';
  const win = ref.ownerDocument?.defaultView;
  let text = '';

  const isHidden = (el: Element): boolean => {
    if (
      el.hasAttribute('hidden') ||
      el.hasAttribute('inert') ||
      el.getAttribute('aria-hidden') === 'true'
    ) {
      return true;
    }
    try {
      const style = win?.getComputedStyle(el);
      return (
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        style?.visibility === 'collapse' ||
        parseFloat(style?.opacity || '1') <= 0
      );
    } catch {
      return false;
    }
  };

  for (let current: Element | null = ref; current; current = composedParent(current)) {
    if (isHidden(current)) return '';
  }

  const walk = (node: Node): void => {
    if (text.length >= maxLen) return;
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const current = node as Element;
    const tag = current.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template') return;
    if (isHidden(current)) return;
    for (const child of Array.from(current.childNodes)) walk(child);
  };

  walk(ref);
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function getAriaReferenceText(el: Element, attribute: string, maxLen = 120): string {
  const ids = (el.getAttribute?.(attribute) || '').split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  const seen = new Set<Element>();
  for (const id of ids) {
    const ref = getSameRootReference(el, id);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const remaining = maxLen - parts.join(' ').length;
    if (remaining <= 0) break;
    const text = getVisibleReferenceText(ref, remaining);
    if (text) parts.push(text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Re-align Set-of-Mark visual badges overlay after scrolling or dynamic layout shifts.
 * Re-reads bounding rects of indexed elements in isolatedMap and updates the visual overlay.
 */
export function inPageRealignHighlights(): boolean {
  const overlay = document.getElementById('__mcp_som_overlay_container__');
  if (!overlay) return false;
  const isolatedMap = getIsolatedIndexMap();
  const reindexedElements: IndexedElement[] = [];

  for (const [idx, wrapped] of isolatedMap.entries()) {
    const el = derefElement(wrapped);
    if (!el || !(el instanceof Element)) continue;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      const text = extractCleanElementText(el);
      reindexedElements.push({
        index: idx,
        tagName: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        text: text || undefined,
        attributes: {},
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        isInteractive: true,
      });
    } catch {}
  }

  if (reindexedElements.length > 0) {
    inPageRenderHighlights(reindexedElements);
    return true;
  }
  return false;
}

/**
 * Scroll target element into center view by index inside active tab.
 */
export function inPageScrollToIndex(index: number): boolean {
  if (index <= 0) return false;
  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });

    // Secondary safety check: ensure element is not occluded by sticky top/bottom bars or within safe 80px viewport margins
    const win = el.ownerDocument?.defaultView || window;
    const vh = win.innerHeight || 800;
    const margins = getStickyOcclusionMargins(win);
    const elStyle = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    const scrollMarginTop = parseFloat(elStyle?.scrollMarginTop || '0') || 0;
    const scrollMarginBottom = parseFloat(elStyle?.scrollMarginBottom || '0') || 0;
    const safeTop = Math.min(Math.max(margins.top, scrollMarginTop, 80), Math.round(vh * 0.35));
    const safeBottom = Math.min(
      Math.max(margins.bottom, scrollMarginBottom, 80),
      Math.round(vh * 0.35),
    );

    try {
      const r = el.getBoundingClientRect();
      if (r.top < safeTop + 10) {
        const delta = r.top - safeTop - 20;
        win.scrollBy?.({ top: delta, behavior: 'instant' as any });
        let anc = composedParent(el);
        while (anc && anc !== win.document.body && anc !== win.document.documentElement) {
          anc.scrollBy?.({ top: delta, behavior: 'instant' as any });
          anc = composedParent(anc);
        }
      } else if (r.bottom > vh - safeBottom - 10) {
        const delta = r.bottom - (vh - safeBottom) + 20;
        win.scrollBy?.({ top: delta, behavior: 'instant' as any });
        let anc = composedParent(el);
        while (anc && anc !== win.document.body && anc !== win.document.documentElement) {
          anc.scrollBy?.({ top: delta, behavior: 'instant' as any });
          anc = composedParent(anc);
        }
      }
    } catch {}

    return true;
  } catch {
    return false;
  }
}

/**
 * Render high-contrast Set-of-Mark visual badges on top of indexed elements (Set-of-Mark 2.0).
 * Features:
 * 1. Frustum Culling: skips elements strictly outside the current viewport.
 * 2. Anti-Collision: tracks badge locations and offsets badges if within 25px of an existing badge.
 * 3. Micro-Pill design: high legibility, compact footprint, semi-transparent background to prevent obscuring content.
 */
export function inPageRenderHighlights(indexedElements: IndexedElement[]): void {
  inPageRemoveHighlights();

  const overlay = document.createElement('div');
  overlay.id = '__mcp_som_overlay_container__';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText =
    [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 100vw',
      'height: 100vh',
      'pointer-events: none',
      'z-index: 2147483647',
      'overflow: visible',
      'margin: 0',
      'padding: 0',
    ].join(' !important;') + ' !important;';

  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;

  // Track placed badge centers for anti-collision
  const placedBadges: Array<{ x: number; y: number }> = [];

  for (const el of indexedElements) {
    if (!el.rect || (el.rect.width <= 0 && el.rect.height <= 0)) continue;

    // 1. Frustum Culling: skip elements completely outside the visible viewport
    if (
      el.rect.x + el.rect.width < 0 ||
      el.rect.y + el.rect.height < 0 ||
      el.rect.x > vw ||
      el.rect.y > vh
    ) {
      continue;
    }

    // Outlined bounding box
    const box = document.createElement('div');
    box.style.cssText =
      [
        'position: fixed',
        `left: ${el.rect.x}px`,
        `top: ${el.rect.y}px`,
        `width: ${el.rect.width}px`,
        `height: ${el.rect.height}px`,
        'border: 1.5px solid rgba(245, 158, 11, 0.85)',
        'background: rgba(245, 158, 11, 0.08)',
        'box-sizing: border-box',
        'pointer-events: none',
        'z-index: 2147483646',
      ].join(' !important;') + ' !important;';
    overlay.appendChild(box);

    // Numbered Badge position calculation with Anti-Collision
    const isSmall = el.rect.width < 60 || el.rect.height < 30;
    let badgeTop = isSmall ? Math.max(0, el.rect.y - 14) : el.rect.y;
    const badgeLeft = el.rect.x;

    // 2. Anti-Collision: check proximity to placed badges (< 25px)
    const isColliding = (bx: number, by: number): boolean => {
      for (const placed of placedBadges) {
        const dx = placed.x - bx;
        const dy = placed.y - by;
        if (dx * dx + dy * dy < 25 * 25) {
          return true;
        }
      }
      return false;
    };

    if (isColliding(badgeLeft + 10, badgeTop + 7)) {
      // Alternate placement: flip below element or shift vertically
      const altTop = el.rect.y + el.rect.height - 2;
      if (!isColliding(badgeLeft + 10, altTop + 7) && altTop + 14 <= vh) {
        badgeTop = altTop;
      } else {
        badgeTop = Math.max(0, badgeTop + 14);
      }
    }

    placedBadges.push({ x: badgeLeft + 10, y: badgeTop + 7 });

    // 3. Micro-Pill Badge
    const badge = document.createElement('div');
    badge.textContent = String(el.index);
    badge.style.cssText =
      [
        'position: fixed',
        `left: ${badgeLeft}px`,
        `top: ${badgeTop}px`,
        'background: rgba(250, 204, 21, 0.9)',
        'color: #000000',
        'font-size: 9px',
        'font-weight: 800',
        'font-family: monospace, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'line-height: 11px',
        'padding: 1px 3px',
        'border-radius: 9999px',
        'border: 1px solid rgba(0, 0, 0, 0.7)',
        'box-shadow: 0 1px 3px rgba(0,0,0,0.35)',
        'pointer-events: none',
        'z-index: 2147483647',
        'user-select: none',
        'white-space: nowrap',
      ].join(' !important;') + ' !important;';

    overlay.appendChild(badge);
  }

  (document.body || document.documentElement).appendChild(overlay);
}

/**
 * Detect rich text composer / editor semantics vs generic searchbox inputs.
 * Enables accurate input disambiguation in modern SPAs (Twitter/X, Notion, Slack, GitHub).
 */
export function detectEditorSemantics(el: Element): {
  isComposer: boolean;
  isEditor: boolean;
  isSearch: boolean;
} {
  if (!el || !(el instanceof Element) || typeof (el as any).getAttribute !== 'function') {
    return { isComposer: false, isEditor: false, isSearch: false };
  }

  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const id = (el.getAttribute('id') || '').toLowerCase();
  const name = (el.getAttribute('name') || '').toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
  const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
  const dataTestId = (
    el.getAttribute('data-testid') ||
    el.getAttribute('data-test-id') ||
    ''
  ).toLowerCase();

  const isContentEditable =
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === '' ||
    (typeof (el as HTMLElement).isContentEditable === 'boolean' &&
      (el as HTMLElement).isContentEditable);

  // 1. Search Box Detection
  const isSearchType = tag === 'input' && type === 'search';
  const isSearchRole = role === 'searchbox' || role === 'search';
  const hasSearchAncestor =
    typeof el.closest === 'function' &&
    Boolean(el.closest('[role="search"], form[role="search"], .search-box, .search-form'));
  const matchesSearchText = /(search|query|find|sousuo|搜索|查找)/i.test(
    `${id} ${name} ${ariaLabel} ${placeholder} ${dataTestId}`,
  );

  const isSearch =
    isSearchType ||
    isSearchRole ||
    (!isContentEditable && matchesSearchText && (tag === 'input' || hasSearchAncestor));

  if (isSearch) {
    return { isComposer: false, isEditor: false, isSearch: true };
  }

  // 2. Rich Text Editor / SPA Composer signatures across social media, forums, and chat platforms
  const isSocialFeedOrMessageComposer =
    /(tweettextarea|tweet_box|composer|post_box|chat_input|reply_box|comment_box|message_input|editor_box)/i.test(
      dataTestId,
    ) ||
    /(tweet text|post text|what is happening|what's happening|post your reply|compose post|compose tweet|write a comment|write a reply|leave a comment|start a post|share your thoughts|发帖|有什么新鲜事|发布你的回复|写评论|发表评论|写下你的回复|发表新帖)/i.test(
      `${ariaLabel} ${placeholder} ${dataTestId}`,
    );

  const isRichEditorFramework =
    isContentEditable ||
    className.includes('drafteditor') ||
    className.includes('lexical') ||
    className.includes('prosemirror') ||
    className.includes('ql-editor') ||
    className.includes('cm-content') ||
    className.includes('monaco-editor') ||
    el.hasAttribute('data-lexical-editor') ||
    el.hasAttribute('data-slate-editor') ||
    el.hasAttribute('data-contents');

  const isMultiLineText =
    tag === 'textarea' || (role === 'textbox' && el.getAttribute('aria-multiline') === 'true');

  const isPostOrCommentContext =
    /(post|comment|reply|compose|tweet|thread|feed|status|feed-box|message|chat-input|editor|wysiwyg|pinglun|huifu|帖子|评论|回复)/i.test(
      `${id} ${name} ${ariaLabel} ${placeholder} ${className} ${dataTestId}`,
    );

  const isComposer =
    isSocialFeedOrMessageComposer ||
    (isRichEditorFramework && isPostOrCommentContext) ||
    (isMultiLineText && isPostOrCommentContext) ||
    (isContentEditable && isSocialFeedOrMessageComposer);

  const isEditor = !isComposer && (isRichEditorFramework || isMultiLineText || isContentEditable);

  return { isComposer, isEditor, isSearch: false };
}

/**
 * Detect fixed/sticky top and bottom occlusion bars (navbars, sticky headers, floating toolbars).
 * Returns safe margins to ensure elements scrolled or targeted are not occluded.
 */
export function getStickyOcclusionMargins(
  win: Window,
  target?: Element,
): { top: number; bottom: number } {
  let topMargin = 0;
  let bottomMargin = 0;
  try {
    const doc = win.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return { top: 0, bottom: 0 };
    const vpW = win.innerWidth || 1280;
    const vpH = win.innerHeight || 800;
    const candidates = doc.querySelectorAll(
      'header, nav, [role="banner"], [role="navigation"], [class*="header" i], [class*="nav" i], [class*="topbar" i], [class*="toolbar" i], [class*="floating" i], [class*="sticky" i], [class*="fixed" i]',
    );
    for (const c of Array.from(candidates)) {
      if (!(c instanceof (win as any).HTMLElement)) continue;
      if (target && composedContains(c, target)) continue;
      const s = win.getComputedStyle(c);
      if (s.position === 'fixed' || s.position === 'sticky') {
        const r = c.getBoundingClientRect();
        if (r.width >= vpW * 0.4 && r.height >= 20 && r.height <= vpH * 0.4) {
          if (r.top <= 15) {
            topMargin = Math.max(topMargin, Math.round(r.bottom));
          } else if (r.bottom >= vpH - 15) {
            bottomMargin = Math.max(bottomMargin, Math.round(vpH - r.top));
          }
        }
      }
    }
  } catch {}
  return {
    top: Math.min(topMargin, 160),
    bottom: Math.min(bottomMargin, 160),
  };
}

export interface ActiveModalBlockerInfo {
  el: HTMLElement;
  coverage: number;
  stackingScore: number;
  kind: 'modal' | 'mask';
  name: string;
  isTrap?: boolean;
}

export interface InteractionScopeInfo {
  activeModal?: string;
  focusTrapped: boolean;
  modalIsolated: boolean;
  isConfirmationTrap: boolean;
  blockingLayerKind?: 'modal' | 'mask';
  modalElement?: HTMLElement;
  roots: Element[];
  scrollContainers: HTMLElement[];
}

/**
 * Detect active modal blocker using stacking score competition algorithm.
 * Evaluates Top-Layer, dialog role, aria-modal, z-index, and DOM order so
 * secondary confirmation traps are not obscured by large parent modals.
 */
export function detectActiveModalBlocker(win: Window = window): ActiveModalBlockerInfo | null {
  try {
    const doc = win.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const vpWidth = win.innerWidth || doc.documentElement?.clientWidth || 1280;
    const vpHeight = win.innerHeight || doc.documentElement?.clientHeight || 800;
    const vpArea = vpWidth * vpHeight;

    const positionedCandidates = Array.from(
      doc.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover], [class*="modal"], [class*="dialog"], [class*="backdrop"], [class*="overlay"], [class*="mask"], [id*="modal"], [id*="dialog"], [id*="overlay"], [style*="fixed"], [style*="absolute"], body > div, body > section, body > aside',
      ),
    ) as HTMLElement[];

    try {
      const shadowCandidates = querySelectorAllDeep(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover], [class*="modal"], [class*="dialog"]',
        doc,
      );
      for (const sc of shadowCandidates) {
        if (sc instanceof HTMLElement && !positionedCandidates.includes(sc)) {
          positionedCandidates.push(sc);
        }
      }
    } catch {}

    let topBlocker: ActiveModalBlockerInfo | null = null;

    for (let i = 0; i < positionedCandidates.length; i++) {
      const d = positionedCandidates[i];
      if (!d || d.getAttribute('aria-hidden') === 'true') continue;
      let style: CSSStyleDeclaration;
      try {
        style = win.getComputedStyle(d);
      } catch {
        continue;
      }
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.pointerEvents === 'none'
      )
        continue;
      const pos = style.position;
      const isPositioned = pos === 'fixed' || pos === 'absolute' || pos === 'sticky';
      const tag = d.tagName.toLowerCase();
      const role = (d.getAttribute('role') || '').toLowerCase();
      const ariaModal = (d.getAttribute('aria-modal') || '').toLowerCase();

      const isNativeOpenDialog = tag === 'dialog' && Boolean((d as HTMLDialogElement).open);
      let isNativeModalDialog = false;
      if (isNativeOpenDialog) {
        try {
          isNativeModalDialog = (d as HTMLDialogElement).matches(':modal');
        } catch {
          isNativeModalDialog = false;
        }
      }
      if (ariaModal === 'false' && !isNativeModalDialog) continue;
      // An open non-modal <dialog> participates in the normal document flow and
      // must not turn into an interaction blocker merely because of its tag.
      if (isNativeOpenDialog && !isNativeModalDialog && ariaModal !== 'true') continue;
      const isExplicitModal = ariaModal === 'true' || role === 'alertdialog' || isNativeModalDialog;
      // Large positioned application shells are not evidence of a modal blocker.
      const hasModalIdentity = /modal|dialog|backdrop|overlay|mask/i.test(
        `${d.id} ${d.getAttribute('class') || ''}`,
      );
      const isPopover = Boolean((d as any).matches?.(':popover-open')) || d.hasAttribute('popover');
      if (isPopover && !isExplicitModal) continue;
      if (!isExplicitModal && !hasModalIdentity) continue;
      if (!isPositioned && !isNativeOpenDialog) continue;

      const rect = d.getBoundingClientRect();
      const ix = Math.max(0, Math.min(rect.right, vpWidth) - Math.max(rect.left, 0));
      const iy = Math.max(0, Math.min(rect.bottom, vpHeight) - Math.max(rect.top, 0));
      const cov = vpArea > 0 ? (ix * iy) / vpArea : 0;
      const declaredWidth = Number.parseFloat(style.width || d.style.width || '0');
      const declaredHeight = Number.parseFloat(style.height || d.style.height || '0');
      const hasBox =
        rect.width > 0 ||
        rect.height > 0 ||
        d.offsetWidth > 0 ||
        d.offsetHeight > 0 ||
        declaredWidth > 0 ||
        declaredHeight > 0;

      const qualifies =
        cov >= 0.6 ||
        (isExplicitModal && hasBox) ||
        (hasModalIdentity && hasBox && composedContains(d, getDeepActiveElement()));
      if (!qualifies) continue;

      const hasInputs = !!d.querySelector('input, textarea, select, button, a');
      const kind: 'modal' | 'mask' =
        isExplicitModal || hasInputs ? 'modal' : cov >= 0.85 ? 'mask' : 'modal';

      const id = d.id ? `#${d.id}` : '';
      const name =
        d.getAttribute('aria-label') ||
        d.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim()?.slice(0, 40);
      const desc = name
        ? `${tag}${id} "${name}"`
        : `${tag}${id || (kind === 'mask' ? '.mask' : '.modal')}`;

      const textSnippet = `${desc} ${name || ''} ${d.textContent?.slice(0, 300) || ''}`;
      const isDiscardOrConfirm =
        /(discard|abandon|unsaved|confirm|放弃|取消|未保存|确认放弃|是否放弃|离开)/i.test(
          textSnippet,
        );

      // Stacking score: Top-Layer > confirmation trap > alertdialog > aria-modal > z-index > DOM order
      let score = 0;
      const isPopoverOpen =
        Boolean((d as any).matches?.(':popover-open')) ||
        (d.hasAttribute('popover') && style.display !== 'none');
      if (isNativeOpenDialog || isPopoverOpen) {
        score += 1_000_000;
      }
      if (isDiscardOrConfirm) {
        score += 500_000;
      } else if (d.getAttribute('role') === 'alertdialog') {
        score += 200_000;
      } else if (d.getAttribute('aria-modal') === 'true') {
        score += 100_000;
      }

      let z = 0;
      if (style.zIndex && style.zIndex !== 'auto') {
        const parsedZ = parseInt(style.zIndex, 10);
        if (!isNaN(parsedZ)) z = parsedZ;
      }
      score += Math.max(0, Math.min(z, 99_999)) * 10;
      score += i;

      if (!topBlocker || score > topBlocker.stackingScore) {
        topBlocker = {
          el: d,
          coverage: cov,
          stackingScore: score,
          kind,
          name: isDiscardOrConfirm ? `${desc} [CONFIRMATION_TRAP]` : desc,
          isTrap: isDiscardOrConfirm,
        };
      }
    }

    return topBlocker;
  } catch {
    return null;
  }
}

function elementIsVisibleForScope(el: Element, win: Window): boolean {
  try {
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return false;
    const style = win.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      (style.opacity === '' || parseFloat(style.opacity) > 0) &&
      el.getBoundingClientRect().width > 0 &&
      el.getBoundingClientRect().height > 0
    );
  } catch {
    return false;
  }
}

function isHTMLElementInWindow(
  value: Element | null | undefined,
  win: Window,
): value is HTMLElement {
  const ctor = (win as unknown as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  return Boolean(value && ctor && value instanceof ctor);
}

function isTopLayerSurface(el: Element): boolean {
  const html = el as HTMLElement;
  try {
    if (html.matches(':popover-open')) return true;
  } catch {}
  return (
    el.tagName.toLowerCase() === 'dialog' &&
    Boolean((el as HTMLDialogElement).open) &&
    (() => {
      try {
        return (el as HTMLDialogElement).matches(':modal');
      } catch {
        return el.getAttribute('aria-modal') === 'true';
      }
    })()
  );
}

function isOverlaySurfaceElement(el: Element): boolean {
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (el.getAttribute('aria-modal') === 'true' || isTopLayerSurface(el)) return true;
  const identity = [
    el.id,
    el.getAttribute('class'),
    el.getAttribute('data-testid'),
    el.getAttribute('data-state'),
    el.tagName,
  ]
    .filter(Boolean)
    .join(' ');
  return /(?:modal|dialog|overlay|popup|popover|sheet|drawer|portal|backdrop|mask)/i.test(identity);
}

function isOverlaySurfaceContainer(parent: Element, child: Element): boolean {
  if (isOverlaySurfaceElement(parent)) return true;
  // Custom elements are structural overlay hosts even when the component
  // author did not expose a framework-specific class or role.
  return parent.tagName.includes('-') && composedContains(parent, child);
}

function modalSurfaceRoot(blocker: HTMLElement, win: Window): HTMLElement {
  let current = blocker;
  const seen = new Set<Element>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = composedParent(current);
    if (
      !isHTMLElementInWindow(parent, win) ||
      parent === win.document.body ||
      parent === win.document.documentElement ||
      !isOverlaySurfaceContainer(parent, current)
    ) {
      break;
    }
    current = parent;
  }
  return current;
}

function referencedModalRoots(root: HTMLElement, win: Window): HTMLElement[] {
  const roots: HTMLElement[] = [];
  const controls = querySelectorAllDeep(
    '[aria-controls], [aria-owns], [popovertarget], [commandfor]',
    root,
  );
  for (const control of controls) {
    if (!isHTMLElementInWindow(control, win)) continue;
    if (
      control.getAttribute('aria-expanded') === 'false' ||
      !elementIsVisibleForScope(control, win)
    )
      continue;
    if ((control as HTMLButtonElement).disabled) continue;
    const ids = [
      control.getAttribute('aria-controls'),
      control.getAttribute('aria-owns'),
      control.getAttribute('popovertarget'),
      control.getAttribute('commandfor'),
    ]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(/\s+/))
      .filter(Boolean);
    for (const id of ids) {
      const target = getSameRootReference(control, id);
      if (
        isHTMLElementInWindow(target, win) &&
        target !== control &&
        elementIsVisibleForScope(target, win)
      ) {
        roots.push(target);
      }
    }
  }
  return roots;
}

function focusedOverlayRoot(blocker: HTMLElement, win: Window): HTMLElement | null {
  const active = getDeepActiveElement();
  if (!active || composedContains(blocker, active)) return null;
  for (let current: Element | null = active; current; current = composedParent(current)) {
    if (current === win.document.body || current === win.document.documentElement) break;
    if (isHTMLElementInWindow(current, win) && isTopLayerSurface(current)) return current;
  }
  return null;
}

function outerMostRoots(roots: Array<Element | null | undefined>, win: Window): HTMLElement[] {
  const unique = Array.from(
    new Set(
      roots.filter(
        (root): root is HTMLElement => isHTMLElementInWindow(root, win) && root.isConnected,
      ),
    ),
  );
  return unique.filter(
    (root) =>
      !unique.some(
        (other) =>
          other !== root && composedContains(other, root) && !composedContains(root, other),
      ),
  );
}

function portalHasOpenOwner(portal: HTMLElement, ownerRoot: HTMLElement, win: Window): boolean {
  const portalId = portal.id;
  if (!portalId) return false;
  const controls = querySelectorAllDeep(
    '[aria-controls], [aria-owns], [popovertarget], [commandfor]',
    ownerRoot,
  );
  for (const control of controls) {
    if (!elementIsVisibleForScope(control, win)) continue;
    const references = [
      control.getAttribute('aria-controls'),
      control.getAttribute('aria-owns'),
      control.getAttribute('popovertarget'),
    ]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(/\s+/));
    if (!references.includes(portalId)) continue;
    if (control.getAttribute('aria-expanded') === 'false') continue;
    return true;
  }
  return false;
}

function modalPortalRoots(
  blocker: HTMLElement,
  win: Window,
  ownerRoot: HTMLElement = blocker,
): HTMLElement[] {
  const portalSelector = [
    '[data-radix-popper-content-wrapper]',
    '[data-radix-portal]',
    '[data-floating-ui-portal]',
    '[data-headlessui-portal]',
    '[data-portal]',
    ':popover-open',
    'dialog[open]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '.ant-select-dropdown',
    '.ant-picker-dropdown',
    '.ant-dropdown',
    '.ant-message',
    '.ant-notification',
    '.MuiMenu-root',
    '.MuiPopover-root',
    '.MuiAutocomplete-popper',
    '.el-select-dropdown',
    '.el-dropdown-menu',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="tooltip"]',
  ].join(',');
  const zIndex = (el: Element): number => {
    const raw = win.getComputedStyle(el).zIndex;
    const parsed = raw === 'auto' ? 0 : Number.parseInt(raw || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const blockerZ = zIndex(blocker);
  const all = querySelectorAllDeep('*', win.document);
  return all.filter((el): el is HTMLElement => {
    if (!isHTMLElementInWindow(el, win) || el === blocker) return false;
    if (
      (!el.matches(portalSelector) && !isOverlaySurfaceElement(el)) ||
      !elementIsVisibleForScope(el, win)
    )
      return false;
    if (composedContains(blocker, el)) return true;
    if (composedContains(el, blocker)) return false;
    // Class names and generic portal markers only discover a candidate. A
    // detached portal enters the interaction scope only when it is a real
    // top-layer surface, declares modal semantics, or an open trigger owns it.
    const role = (el.getAttribute('role') || '').toLowerCase();
    const explicitModal =
      role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
    if (!isTopLayerSurface(el) && !explicitModal && !portalHasOpenOwner(el, ownerRoot, win))
      return false;

    const portalZ = zIndex(el);
    if (isTopLayerSurface(el) && !isTopLayerSurface(blocker)) return true;
    if (portalZ !== blockerZ) return portalZ > blockerZ;
    return Boolean(blocker.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
}

function selectorForScopeElement(el: Element): string | undefined {
  const escapeSelector = (value: string) =>
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : value.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  if (el.id) return `#${escapeSelector(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${escapeSelector(testId)}"]`;
  const role = el.getAttribute('role');
  if (role) return `${el.tagName.toLowerCase()}[role="${escapeSelector(role)}"]`;
  return undefined;
}

function scrollContainersInRoots(roots: Element[], win: Window): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const root of roots) {
    const all = [
      ...(isHTMLElementInWindow(root, win) ? [root] : []),
      ...querySelectorAllDeep('*', root),
    ];
    for (const el of all) {
      if (!isHTMLElementInWindow(el, win) || found.includes(el)) continue;
      let style: CSSStyleDeclaration;
      try {
        style = win.getComputedStyle(el);
      } catch {
        // Inaccessible stylesheets must not make observation fail open.
        continue;
      }
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity !== '' && Number.parseFloat(style.opacity) <= 0)
      ) {
        continue;
      }
      const scrolls =
        el.scrollHeight > el.clientHeight + 2 &&
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        el.clientHeight > 0;
      if (scrolls) found.push(el);
    }
  }
  return found;
}

export function buildScopedScrollInfo(
  roots: Element[],
  win: Window = window,
  options?: { modalActive?: boolean; containers?: HTMLElement[] },
): ScrollInfo {
  const containers = options?.containers ?? scrollContainersInRoots(roots, win);
  if (containers.length === 1) {
    const container = containers[0];
    const viewportHeight = Math.max(1, container.clientHeight || 1);
    const totalHeight = Math.max(container.scrollHeight, viewportHeight);
    const scrollY = Math.max(0, container.scrollTop || 0);
    return {
      pages_up: Number((scrollY / viewportHeight).toFixed(1)),
      pages_down: Number(
        (Math.max(0, totalHeight - (scrollY + viewportHeight)) / viewportHeight).toFixed(1),
      ),
      scroll_y: Math.round(scrollY),
      total_height: Math.round(totalHeight),
      viewport_height: Math.round(viewportHeight),
      containerIndex: indexElement(container),
      containerTag: container.tagName.toLowerCase(),
      ...(selectorForScopeElement(container)
        ? { containerSelector: selectorForScopeElement(container) }
        : {}),
      ambiguous: false,
      scope: 'element',
    };
  }

  if (containers.length > 1) {
    return {
      pages_up: 0,
      pages_down: 0,
      scroll_y: 0,
      total_height: 0,
      viewport_height: 0,
      ambiguous: true,
      scope: 'ambiguous',
    };
  }

  if (options?.modalActive) {
    const viewportHeight = Math.max(
      1,
      win.innerHeight || win.document.documentElement?.clientHeight || 1,
    );
    return {
      pages_up: 0,
      pages_down: 0,
      scroll_y: 0,
      total_height: viewportHeight,
      viewport_height: viewportHeight,
      ambiguous: false,
      scope: 'none',
      backgroundBlocked: true,
    };
  }

  const doc = win.document;
  const viewportHeight = win.innerHeight || doc.documentElement?.clientHeight || 1;
  const scrollY = Math.max(
    0,
    win.scrollY || win.pageYOffset || doc.documentElement?.scrollTop || doc.body?.scrollTop || 0,
  );
  const totalHeight = Math.max(
    doc.body?.scrollHeight || 0,
    doc.documentElement?.scrollHeight || 0,
    doc.body?.offsetHeight || 0,
    doc.documentElement?.offsetHeight || 0,
    viewportHeight,
  );
  return {
    pages_up: Number((scrollY / viewportHeight).toFixed(1)),
    pages_down: Number(
      (Math.max(0, totalHeight - (scrollY + viewportHeight)) / viewportHeight).toFixed(1),
    ),
    scroll_y: Math.round(scrollY),
    total_height: Math.round(totalHeight),
    viewport_height: Math.round(viewportHeight),
    ambiguous: false,
    scope: 'page',
  };
}

export function computeInteractionScope(
  win: Window = window,
  options?: { explicitScope?: boolean },
): InteractionScopeInfo {
  const blocker = detectActiveModalBlocker(win);
  const focusTrapped = Boolean(blocker);
  const modalIsolated = Boolean(blocker && !options?.explicitScope);
  let roots: Element[] = [];
  let modalElement: HTMLElement | undefined;

  if (blocker) {
    const surfaceRoot = modalSurfaceRoot(blocker.el, win);
    modalElement = surfaceRoot;
    roots = outerMostRoots(
      [
        surfaceRoot,
        blocker.el,
        ...modalPortalRoots(blocker.el, win, surfaceRoot),
        ...referencedModalRoots(surfaceRoot, win),
        focusedOverlayRoot(blocker.el, win),
      ],
      win,
    );
  } else if (win.document.body) {
    roots = [win.document.body];
  }

  return {
    activeModal: blocker?.name,
    focusTrapped,
    modalIsolated,
    isConfirmationTrap: blocker?.isTrap === true,
    blockingLayerKind: blocker?.kind,
    modalElement,
    roots,
    scrollContainers: scrollContainersInRoots(roots, win),
  };
}

/**
 * Focus Trap and Modal Focus Guard:
 * Pulls and locks DOM keyboard focus into the active modal dialog or specified modal root.
 * Ensures subsequent Tab, Enter, and keyboard shortcuts don't bleed into background DOM.
 */
export function inPageEnsureModalFocus(modalEl?: Element): boolean {
  if (typeof document === 'undefined') return false;
  let target = modalEl;
  if (!target) {
    const blocker = detectActiveModalBlocker(typeof window !== 'undefined' ? window : undefined);
    if (blocker?.el) {
      target = blocker.el;
    }
  }
  if (!target) return false;

  // Check if current active element is already inside target
  if (composedContains(target, getDeepActiveElement())) {
    return true;
  }

  // Find first focusable element inside the modal (penetrating Shadow DOM)
  const focusable = querySelectorAllDeep(
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], a[href]',
    target,
  );
  for (const el of focusable) {
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        try {
          el.focus();
          return true;
        } catch {}
      }
    }
  }

  // Fallback: focus modal container itself
  if (target instanceof HTMLElement) {
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    try {
      target.focus();
      return true;
    } catch {}
  }
  return false;
}

/**
 * W3C Standard Composite Card Flattening (Card-level Semantic Aggregation)
 *
 * Targets standard semantic containers:
 * - article, [role="article"], [role="listitem"], li, [aria-roledescription="card"], [aria-roledescription="item"]
 *
 * Identifies fragmented composite cards (e.g. eCommerce product items, search result snippets, social feed items)
 * that have >= 3 candidate nodes and NO form inputs. Aggregates all fragmented leaf text nodes (title, price,
 * ratings, tags, shop names) into a single structured card summary while strictly preserving the primary
 * clickable element's index, safe click point, and href, as well as distinct action buttons (e.g. "Add to Cart").
 * Slashes token count and DOM lines by 60%+ without vendor-specific hacks.
 */
export function flattenCompositeCards(
  candidates: Array<{
    node: Element;
    tag: string;
    rect: DOMRect;
    isFile: boolean;
    isInteractive: boolean;
    inShadowDom?: boolean;
    isClosedShadowHost?: boolean;
    isCard?: boolean;
    cardRole?: string;
    aggregatedText?: string;
    isCardSecondary?: boolean;
    isVirtualMarker?: boolean;
  }>,
  maxTextLength: number = 120,
): number {
  if (!candidates || candidates.length < 3) return 0;

  // Group candidate elements by their closest ancestor card container
  const cardMap = new Map<Element, Array<(typeof candidates)[0]>>();

  for (const cand of candidates) {
    if (cand.isVirtualMarker || cand.isFile || !cand.node || !(cand.node instanceof Element)) {
      continue;
    }
    if ((cand as any).isTableStructure) continue;

    const card = cand.node.closest?.(
      'article, [role="article"], [role="listitem"], li, [aria-roledescription="card"], [aria-roledescription="item"]',
    );
    if (!card || card.tagName.toLowerCase() === 'body') continue;

    let items = cardMap.get(card);
    if (!items) {
      items = [];
      cardMap.set(card, items);
    }
    items.push(cand);
  }

  let flattenedCount = 0;

  for (const [card, items] of cardMap.entries()) {
    if (items.length < 3) continue;

    // Safety Guard 1: Never collapse forms or containers with interactive editable inputs
    const hasFormInputs = card.querySelector?.(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]',
    );
    if (hasFormInputs) continue;

    // Safety Guard 2: Card dimensions should be reasonable (not a giant page section)
    const cardRect = card.getBoundingClientRect();
    if (cardRect.height > 1000 || (cardRect.width > 1200 && card.tagName.toLowerCase() !== 'li')) {
      continue;
    }

    // Collect distinct text fragments from the card items
    const infoTexts: string[] = [];
    for (const it of items) {
      // Exclude action buttons, checkboxes, radios from the card description
      const isControl = it.node.matches?.(
        'button, [role="button"], input[type="checkbox"], input[type="radio"], [role="checkbox"]',
      );
      if (isControl) continue;

      const t = extractCleanElementText(it.node, maxTextLength);
      if (t) {
        // Avoid duplicate or substring text
        const isRedundant = infoTexts.some(
          (existing) => existing === t || existing.includes(t) || t.includes(existing),
        );
        if (!isRedundant) {
          infoTexts.push(t);
        } else {
          // If the new text is longer and contains existing, replace with longer text
          const existingIdx = infoTexts.findIndex((existing) => t.includes(existing));
          if (existingIdx !== -1 && t.length > infoTexts[existingIdx].length) {
            infoTexts[existingIdx] = t;
          }
        }
      }
    }

    // Must have at least 2 distinct text fragments to be considered fragmented composite card
    if (infoTexts.length < 2) continue;

    // Find the primary interactive element (e.g. product title link or main card link)
    let primaryCandidate = items.find(
      (it) =>
        it.tag === 'a' &&
        Boolean(((it.node as HTMLElement).innerText || it.node.textContent || '').trim()),
    );
    if (!primaryCandidate) {
      primaryCandidate = items.find((it) => it.isInteractive);
    }
    if (!primaryCandidate) {
      primaryCandidate = items[0];
    }

    // Aggregate clean structured summary (joined by " | ")
    const cardSummary = infoTexts.join(' | ').slice(0, Math.max(maxTextLength * 2, 200));

    primaryCandidate.isCard = true;
    primaryCandidate.cardRole = 'card';
    primaryCandidate.aggregatedText = cardSummary;

    const ACTION_TRIGGER_TESTID_REGEX =
      /(reply|retweet|repost|like|favorite|bookmark|share|upvote|downvote|comment|action|menu|more)/i;
    const ACTION_TRIGGER_LABEL_REGEX =
      /(reply|retweet|repost|like|favorite|bookmark|share|upvote|downvote|comment|options|回复|转发|点赞|分享|收藏|评论|投票)/i;

    function detectActionTrigger(
      node: Element,
      primaryHref?: string,
    ): { isTrigger: boolean; type?: string } {
      if (!node || !(node instanceof Element)) return { isTrigger: false };
      const tag = node.tagName.toLowerCase();
      const testId = node.getAttribute?.('data-testid') || '';
      if (ACTION_TRIGGER_TESTID_REGEX.test(testId)) {
        const m = testId.match(ACTION_TRIGGER_TESTID_REGEX);
        return { isTrigger: true, type: m ? m[0].toLowerCase() : 'action' };
      }
      const ariaLabel = node.getAttribute?.('aria-label') || '';
      if (ACTION_TRIGGER_LABEL_REGEX.test(ariaLabel)) {
        const m = ariaLabel.match(ACTION_TRIGGER_LABEL_REGEX);
        return { isTrigger: true, type: m ? m[0].toLowerCase() : 'action' };
      }
      const role = node.getAttribute?.('role') || '';
      if (tag === 'button' || role === 'button') {
        const btnText = (node.textContent || '').trim();
        if (ACTION_TRIGGER_LABEL_REGEX.test(btnText)) {
          const m = btnText.match(ACTION_TRIGGER_LABEL_REGEX);
          return { isTrigger: true, type: m ? m[0].toLowerCase() : 'button' };
        }
        return { isTrigger: true, type: 'button' };
      }
      if (tag === 'a') {
        const href = node.getAttribute?.('href') || '';
        if (
          href &&
          primaryHref &&
          href !== primaryHref &&
          !href.startsWith('#') &&
          !href.startsWith('javascript:')
        ) {
          return { isTrigger: true, type: 'link' };
        }
      }
      return { isTrigger: false };
    }

    const primaryHref = primaryCandidate.node.getAttribute?.('href') || undefined;

    // Mark other non-control items as secondary so they are omitted from tree lines,
    // while explicitly identifying and preserving action triggers (reply, retweet, like, share, etc.)
    for (const it of items) {
      if (it === primaryCandidate) continue;
      if ((it as any).isTableStructure) continue;
      const isControl = it.node.matches?.(
        'button, [role="button"], input[type="checkbox"], input[type="radio"], [role="checkbox"]',
      );
      const trigger = detectActionTrigger(it.node, primaryHref);
      if (trigger.isTrigger) {
        (it as any).isActionTrigger = true;
        (it as any).actionTriggerType = trigger.type;
        it.isInteractive = true;
      } else if (!isControl) {
        it.isCardSecondary = true;
      }
    }

    flattenedCount++;
  }

  return flattenedCount;
}

/**
 * DOM In-Page Indexer & Pruner
 * Evaluated inside the active tab context.
 */
export function inPageDOMPruner(options?: {
  viewportThreshold?: number;
  highlight?: boolean;
  startingIndex?: number;
  frameId?: string;
  maxTextLength?: number;
  format?: 'compact' | 'html';
  viewportOnly?: boolean;
  activeViewportOnly?: boolean;
  selector?: string;
  scope?: string;
  exclude?: string | string[];
  isolateModal?: boolean;
  virtualizeViewport?: boolean;
  flattenCards?: boolean;
}): PrunedDOMTreeResult {
  const isActiveViewportOnly =
    options?.activeViewportOnly === true || (options?.activeViewportOnly as any) === 'true';
  const isViewportOnly =
    options?.viewportOnly === true || (options?.viewportOnly as any) === 'true';
  const threshold = isActiveViewportOnly
    ? 0
    : isViewportOnly
      ? 150
      : (options?.viewportThreshold ?? 1000);
  const startingIndex = options?.startingIndex ?? 1;
  const frameId = options?.frameId;
  const tableObservationCache = createTableObservationCache();

  // Robust :has-text evaluator for container scoping & exclusion
  function splitTopLevelCommas(selector: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let parenDepth = 0;

    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      const prev = i > 0 ? selector[i - 1] : '';

      if (ch === "'" && !inDoubleQuote && prev !== '\\') {
        inSingleQuote = !inSingleQuote;
        current += ch;
      } else if (ch === '"' && !inSingleQuote && prev !== '\\') {
        inDoubleQuote = !inDoubleQuote;
        current += ch;
      } else if (ch === '(' && !inSingleQuote && !inDoubleQuote) {
        parenDepth++;
        current += ch;
      } else if (ch === ')' && !inSingleQuote && !inDoubleQuote) {
        if (parenDepth > 0) parenDepth--;
        current += ch;
      } else if (ch === ',' && !inSingleQuote && !inDoubleQuote && parenDepth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  function extractFirstHasText(sel: string): {
    prefix: string;
    pattern: string | RegExp;
    suffix: string;
  } | null {
    const idx = sel.indexOf(':has-text(');
    if (idx === -1) return null;

    const prefix = sel.slice(0, idx).trim() || '*';
    const afterOpen = sel.slice(idx + ':has-text('.length);

    let inSingle = false;
    let inDouble = false;
    let closeIdx = -1;

    for (let i = 0; i < afterOpen.length; i++) {
      const ch = afterOpen[i];
      const prev = i > 0 ? afterOpen[i - 1] : '';
      if (ch === "'" && !inDouble && prev !== '\\') {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle && prev !== '\\') {
        inDouble = !inDouble;
      } else if (ch === ')' && !inSingle && !inDouble) {
        closeIdx = i;
        break;
      }
    }

    if (closeIdx === -1) return null;

    const rawArg = afterOpen.slice(0, closeIdx).trim();
    const suffix = afterOpen.slice(closeIdx + 1);

    let pattern: string | RegExp = rawArg;
    const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(rawArg);
    if (regexMatch) {
      try {
        pattern = new RegExp(regexMatch[1], regexMatch[2]);
      } catch {
        pattern = rawArg;
      }
    } else if (
      (rawArg.startsWith('"') && rawArg.endsWith('"')) ||
      (rawArg.startsWith("'") && rawArg.endsWith("'"))
    ) {
      pattern = rawArg.slice(1, -1).replace(/\\(["'])/g, '$1');
    }

    return { prefix, pattern, suffix };
  }

  function elementMatchesPattern(el: Element, pattern: string | RegExp): boolean {
    const text = (el as HTMLElement).innerText || el.textContent || '';
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }
    return text.includes(pattern);
  }

  function queryHasTextSingleSelector(
    root: Element | Document,
    selector: string,
    single: boolean,
  ): Element[] {
    const parsed = extractFirstHasText(selector);
    if (!parsed) {
      try {
        return single
          ? root.querySelector(selector)
            ? [root.querySelector(selector)!]
            : []
          : Array.from(root.querySelectorAll(selector));
      } catch {
        return [];
      }
    }

    const { prefix, pattern, suffix } = parsed;
    let baseCandidates: Element[];
    try {
      baseCandidates = Array.from(root.querySelectorAll(prefix));
    } catch {
      baseCandidates = [];
    }

    const matchedPrefix = baseCandidates.filter((el) => elementMatchesPattern(el, pattern));

    const trimmedSuffix = suffix.trim();
    if (!trimmedSuffix) {
      if (single) {
        if (matchedPrefix.length === 0) return [];
        const innermost = matchedPrefix.find(
          (el) => !matchedPrefix.some((other) => other !== el && el.contains(other)),
        );
        return [innermost || matchedPrefix[0]];
      }
      return matchedPrefix;
    }

    const results: Element[] = [];
    const seen = new Set<Element>();

    for (const parent of matchedPrefix) {
      let childMatches: Element[];
      if (trimmedSuffix.startsWith(':has-text(')) {
        childMatches = queryHasTextSingleSelector(parent, '*' + trimmedSuffix, single);
      } else {
        const isCombinator = /^[>+~]/.test(trimmedSuffix);
        const childSel = isCombinator ? `:scope ${trimmedSuffix}` : trimmedSuffix;
        if (childSel.includes(':has-text(')) {
          childMatches = queryHasTextSingleSelector(parent, childSel, single);
        } else {
          try {
            childMatches = single
              ? parent.querySelector(childSel)
                ? [parent.querySelector(childSel)!]
                : []
              : Array.from(parent.querySelectorAll(childSel));
          } catch {
            childMatches = [];
          }
        }
      }

      for (const m of childMatches) {
        if (!seen.has(m)) {
          seen.add(m);
          results.push(m);
          if (single) return results;
        }
      }
    }

    return results;
  }

  function queryWithHasText(root: Element | Document, selector: string, single = false): Element[] {
    if (typeof selector !== 'string') return [];
    if (!selector.includes(':has-text(')) {
      try {
        return single
          ? root.querySelector(selector)
            ? [root.querySelector(selector)!]
            : []
          : Array.from(root.querySelectorAll(selector));
      } catch {
        return [];
      }
    }

    const parts = splitTopLevelCommas(selector);
    if (parts.length === 1) {
      return queryHasTextSingleSelector(root, parts[0], single);
    }

    const combined: Element[] = [];
    const seen = new Set<Element>();
    for (const part of parts) {
      const res = queryHasTextSingleSelector(root, part, single);
      for (const el of res) {
        if (!seen.has(el)) {
          seen.add(el);
          combined.push(el);
          if (single) return [el];
        }
      }
    }
    return combined;
  }

  function buildExcludeChecker(
    exclude?: string | string[],
  ): (el: Element, isRoot?: boolean) => boolean {
    if (!exclude) return () => false;
    const rawList = Array.isArray(exclude) ? exclude : [exclude];
    const standardSelectors: string[] = [];
    const textExcludedSet = new Set<Element>();

    for (const item of rawList) {
      if (typeof item === 'string') {
        for (const part of splitTopLevelCommas(item)) {
          const trimmed = part.trim();
          if (trimmed) {
            if (trimmed.includes(':has-text(')) {
              for (const matched of queryWithHasText(document, trimmed, false)) {
                textExcludedSet.add(matched);
              }
            } else {
              standardSelectors.push(trimmed);
            }
          }
        }
      }
    }

    if (standardSelectors.length === 0 && textExcludedSet.size === 0) return () => false;

    return (el: Element, isRoot = false) => {
      if (!el) return false;
      if (textExcludedSet.size > 0) {
        if (textExcludedSet.has(el)) return true;
        if (isRoot) {
          for (const textEl of textExcludedSet) {
            if (textEl.contains(el)) return true;
          }
        }
      }

      for (const sel of standardSelectors) {
        try {
          if (isRoot) {
            if (typeof el.closest === 'function' && el.closest(sel)) return true;
          }
          if (typeof el.matches === 'function' && el.matches(sel)) return true;
        } catch {
          try {
            if (el.matches(sel)) return true;
          } catch {}
        }
      }
      return false;
    };
  }

  const isExcluded = buildExcludeChecker(options?.exclude);
  const maxTextLength =
    typeof options?.maxTextLength === 'number' && options.maxTextLength > 0
      ? options.maxTextLength
      : 120;
  const outputFormat = options?.format === 'html' ? 'html' : 'compact';
  const winHeight = window.innerHeight;
  const winWidth = window.innerWidth;

  const droppedTags = new Set([
    'script',
    'style',
    'head',
    'meta',
    'link',
    'title',
    'noscript',
    'template',
  ]);

  const svgInternalTags = new Set([
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'use',
    'defs',
    'clippath',
    'mask',
    'pattern',
    'text',
    'tspan',
    'g',
  ]);

  const interactiveRoles = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'option',
    'textbox',
    'combobox',
    'searchbox',
    'switch',
    'slider',
    'spinbutton',
  ]);

  let totalOriginalNodes = 0;
  // Number of nodes retained in the pruned tree (interactive + informational + files).
  // Previously this counter was never incremented, so elementCount was always 0 and
  // compressionRatio was always 1 — both self-contradictory next to interactiveCount.
  let prunedElementCount = 0;
  const indexedElements: IndexedElement[] = [];
  const indexMap: Record<
    number,
    { selector?: string; backendNodeId?: number; frameId?: string; tagName?: string }
  > = {};

  const g = globalThis as any;
  g[Symbol.for('__browser_use_last_snapshot_type__')] = 'standard';
  pruneDetachedIndices();

  const PROPAGATING_ELEMENTS = new Set([
    'p',
    'span',
    'b',
    'strong',
    'i',
    'em',
    'small',
    'label',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'div',
    'li',
    'td',
    'th',
    'sub',
    'sup',
  ]);

  function isInteractive(
    el: Element,
    style: CSSStyleDeclaration,
    parentHasPointer = false,
  ): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') {
      return false;
    }
    if (
      style.pointerEvents === 'none' ||
      el.hasAttribute('inert') ||
      (el as any).inert === true ||
      el.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }
    if (getTableObservationRole(el) && !hasDirectTableAction(el)) {
      return false;
    }
    if (
      tag === 'button' ||
      tag === 'select' ||
      tag === 'textarea' ||
      tag === 'details' ||
      tag === 'summary' ||
      tag === 'option' ||
      tag === 'canvas'
    ) {
      return true;
    }
    if (tag === 'input' && (el as HTMLInputElement).type !== 'hidden') {
      return true;
    }
    if (tag === 'a' && (el as HTMLAnchorElement).href) {
      return true;
    }
    if (
      (el as HTMLElement).isContentEditable ||
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('contenteditable') === ''
    ) {
      return true;
    }
    const role = el.getAttribute('role')?.toLowerCase();
    if (role && interactiveRoles.has(role)) {
      return true;
    }
    if (
      el.hasAttribute('onclick') ||
      el.hasAttribute('oncontextmenu') ||
      el.hasAttribute('ondblclick') ||
      el.hasAttribute('draggable') ||
      el.hasAttribute('data-action') ||
      (el as HTMLElement).tabIndex >= 0 ||
      el.hasAttribute('aria-valuenow') ||
      el.hasAttribute('aria-controls') ||
      el.hasAttribute('aria-selected') ||
      el.hasAttribute('aria-checked')
    ) {
      return true;
    }
    // Task B6: Non-invasive JS dynamic event listener detection (getEventListeners)
    try {
      const g = globalThis as any;
      if (typeof g.getEventListeners === 'function') {
        const listeners = g.getEventListeners(el);
        if (listeners && (listeners.click || listeners.mousedown || listeners.pointerdown)) {
          return true;
        }
      }
    } catch {}
    const cls =
      typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '';
    if (
      cls.includes('group/') ||
      cls.includes('hover') ||
      cls.includes('dropdown') ||
      cls.includes('menu-item') ||
      el.hasAttribute('aria-haspopup') ||
      el.hasAttribute('aria-expanded')
    ) {
      return true;
    }
    if (isInteractiveSvgNode(el, style)) {
      return true;
    }
    // Web Component icon buttons and action triggers (e.g. Reddit faceplate-tracker, faceplate-button, shreddit action rows)
    if (
      (el.hasAttribute('aria-label') || el.hasAttribute('title')) &&
      (isCustomElement(el) ||
        style.cursor === 'pointer' ||
        tag.includes('button') ||
        tag.includes('item') ||
        tag.includes('action') ||
        cls.includes('button') ||
        cls.includes('btn') ||
        cls.includes('action'))
    ) {
      return true;
    }
    // Closed shadow host check: custom elements with zero exposed shadowRoot but with interactive layout
    if (isCustomElement(el) && getShadowRoot(el) === null) {
      if (
        style.cursor === 'pointer' ||
        el.hasAttribute('aria-label') ||
        el.hasAttribute('role') ||
        (el as HTMLElement).tabIndex >= 0
      ) {
        return true;
      }
    }
    if (style.cursor && /grab|grabbing|resize|^move$|all-scroll/i.test(style.cursor)) {
      // Drag/resize targets carry grab/resize cursors instead of pointer.
      return true;
    }
    if (style.cursor === 'pointer') {
      // Browser-use enhancement: Block cursor: pointer inheritance from parent
      // on standard propagating containers to eliminate redundant fractured sub-elements
      if (parentHasPointer && PROPAGATING_ELEMENTS.has(tag)) {
        return false;
      }
      return true;
    }
    return false;
  }

  interface OcclusionResult {
    isFullyOccluded: boolean;
    isOccluded: boolean;
    occludedBy?: string;
    safeClickPoint: { x: number; y: number; offsetX: number; offsetY: number };
  }

  /**
   * 9-point grid occlusion sampling (3x3 grid at 15%, 50%, 85% width/height).
   * Determines whether an element is fully occluded, partially occluded, or clear,
   * and calculates the optimal unoccluded safe click point.
   */
  function checkOcclusionGrid(el: Element, rect: DOMRect): OcclusionResult {
    const defaultCenter = {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      offsetX: rect.width / 2,
      offsetY: rect.height / 2,
    };

    if (rect.width <= 0 || rect.height <= 0) {
      return { isFullyOccluded: false, isOccluded: false, safeClickPoint: defaultCenter };
    }

    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(winWidth, rect.right);
    const visibleBottom = Math.min(winHeight, rect.bottom);
    const visibleWidth = visibleRight - visibleLeft;
    const visibleHeight = visibleBottom - visibleTop;

    if (visibleWidth <= 0 || visibleHeight <= 0) {
      return { isFullyOccluded: false, isOccluded: false, safeClickPoint: defaultCenter };
    }

    const ratios = [0.15, 0.5, 0.85];
    let totalSampled = 0;
    let occludedCount = 0;
    let primaryOccluder: string | undefined = undefined;
    const clearPoints: Array<{ x: number; y: number; offsetX: number; offsetY: number }> = [];
    let centerClearPoint: { x: number; y: number; offsetX: number; offsetY: number } | null = null;

    for (const ry of ratios) {
      for (const rx of ratios) {
        const px = visibleLeft + visibleWidth * rx;
        const py = visibleTop + visibleHeight * ry;

        if (px < 0 || py < 0 || px >= winWidth || py >= winHeight) {
          continue;
        }
        totalSampled++;

        let topEl: Element | null = null;
        try {
          if (typeof document.elementFromPoint === 'function') {
            topEl = document.elementFromPoint(px, py);
          }
        } catch {}

        // Composed / Shadow-aware deep hit check
        let deepHit: Element | null = null;
        if (el.getRootNode && el.getRootNode() !== document) {
          try {
            deepHit = hitElementAtPoint(el, px, py);
          } catch {}
        }

        if (
          deepHit &&
          (deepHit === el || composedContains(el, deepHit) || composedContains(deepHit, el))
        ) {
          const pt = {
            x: Math.round(px),
            y: Math.round(py),
            offsetX: rect.width * rx,
            offsetY: rect.height * ry,
          };
          clearPoints.push(pt);
          if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
          continue;
        }

        if (!topEl) {
          const pt = {
            x: Math.round(px),
            y: Math.round(py),
            offsetX: rect.width * rx,
            offsetY: rect.height * ry,
          };
          clearPoints.push(pt);
          if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
          continue;
        }

        if (topEl === el || composedContains(el, topEl) || composedContains(topEl, el)) {
          const pt = {
            x: Math.round(px),
            y: Math.round(py),
            offsetX: rect.width * rx,
            offsetY: rect.height * ry,
          };
          clearPoints.push(pt);
          if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
          continue;
        }

        try {
          const topStyle = window.getComputedStyle(topEl);
          const isVisible = topStyle.display !== 'none' && topStyle.visibility !== 'hidden';
          const isPointerBlocking = topStyle.pointerEvents !== 'none';
          const isBackdropOrOverlay =
            topEl.matches?.(
              'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal, .modal-backdrop, [class*="backdrop"], [class*="mask"], [class*="overlay"]',
            ) ||
            topEl.closest?.(
              'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal, .modal-backdrop, [class*="backdrop"], [class*="mask"], [class*="overlay"]',
            );
          const hasSignificantOpacity = parseFloat(topStyle.opacity || '1') >= 0.35;

          if (isVisible && isPointerBlocking && (hasSignificantOpacity || isBackdropOrOverlay)) {
            occludedCount++;
            if (!primaryOccluder) {
              const tag = topEl.tagName?.toLowerCase() || 'element';
              const id = topEl.id ? `#${topEl.id}` : '';
              primaryOccluder = `${tag}${id}`;
            }
            continue;
          }
        } catch {}

        const pt = {
          x: Math.round(px),
          y: Math.round(py),
          offsetX: rect.width * rx,
          offsetY: rect.height * ry,
        };
        clearPoints.push(pt);
        if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
      }
    }

    if (totalSampled > 0 && occludedCount === totalSampled) {
      return {
        isFullyOccluded: true,
        isOccluded: true,
        occludedBy: primaryOccluder,
        safeClickPoint: defaultCenter,
      };
    }

    const isPartiallyOccluded = occludedCount > 0;
    let safePoint = defaultCenter;

    if (clearPoints.length > 0) {
      // Prefer the geometric center whenever it is unoccluded. Previously a
      // partially occluded element skipped this branch and averaged every clear
      // sample, which biased the point toward whichever 15%/85% column survived.
      // On a ~40px control that is a +8..+18px drift off center — enough to land
      // on a neighbouring element. Centre-first removes that bias.
      if (centerClearPoint) {
        safePoint = defaultCenter;
      } else {
        const avgOffsetX = clearPoints.reduce((sum, p) => sum + p.offsetX, 0) / clearPoints.length;
        const avgOffsetY = clearPoints.reduce((sum, p) => sum + p.offsetY, 0) / clearPoints.length;
        const avgX = Math.round(rect.left + avgOffsetX);
        const avgY = Math.round(rect.top + avgOffsetY);

        let centroidClear = false;
        try {
          if (typeof document.elementFromPoint === 'function') {
            const topAtAvg = document.elementFromPoint(avgX, avgY);
            if (
              !topAtAvg ||
              topAtAvg === el ||
              composedContains(el, topAtAvg) ||
              composedContains(topAtAvg, el)
            ) {
              centroidClear = true;
            }
          }
        } catch {}

        if (centroidClear) {
          safePoint = { x: avgX, y: avgY, offsetX: avgOffsetX, offsetY: avgOffsetY };
        } else {
          let bestDist = Infinity;
          let bestPt = clearPoints[0];
          for (const pt of clearPoints) {
            const d = Math.hypot(pt.x - avgX, pt.y - avgY);
            if (d < bestDist) {
              bestDist = d;
              bestPt = pt;
            }
          }
          safePoint = bestPt;
        }
      }
    }

    return {
      isFullyOccluded: false,
      isOccluded: isPartiallyOccluded,
      occludedBy: isPartiallyOccluded ? primaryOccluder : undefined,
      safeClickPoint: safePoint,
    };
  }

  function checkOcclusion(el: Element, rect: DOMRect): boolean {
    return checkOcclusionGrid(el, rect).isFullyOccluded;
  }

  function isAdOrTrackingElement(el: Element): boolean {
    const tag = el.tagName?.toLowerCase() || '';
    if (tag === 'ins' && el.classList?.contains?.('adsbygoogle')) return true;
    const idAndClass = `${el.id || ''} ${(el as HTMLElement).className || ''}`.toLowerCase();
    if (
      /(^|[\s_-])(adsbygoogle|google[-_]?ads?|ad[-_]?banner|ad[-_]?wrapper|ad[-_]?container|taboola|outbrain|sponsored[-_]?post|advertisement)([\s_-]|$)/i.test(
        idAndClass,
      )
    ) {
      return true;
    }
    return false;
  }

  function isInformationalNode(el: Element): boolean {
    const tag = el.tagName?.toLowerCase() || '';
    if (/^h[1-6]$/.test(tag) || tag === 'th') return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'alert' || role === 'status' || role === 'heading') return true;
    if (el.hasAttribute('aria-live')) return true;
    // Text budgets truncate long leaves during serialization instead of hiding their content.
    if (
      el.children.length === 0 &&
      el.textContent &&
      el.textContent.trim().length > 0 &&
      !['script', 'style', 'noscript', 'meta', 'link'].includes(tag)
    ) {
      return true;
    }
    return false;
  }

  // Visual assets (img/canvas/video/CSS background images) with viewport
  // geometry, so the agent can request an individual asset by index.
  const assets: PageAsset[] = [];
  const assetRegistry: Array<{ kind: string; el: Element; src?: string }> = [];
  let assetSeq = 0;
  const pushAsset = (
    kind: PageAsset['kind'],
    el: Element,
    rect: DOMRect,
    src?: string,
    alt?: string,
  ) => {
    if (rect.width < 8 || rect.height < 8) return;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > winHeight || rect.left > winWidth) return;
    assetSeq += 1;
    assetRegistry.push({ kind, el, src });
    assets.push({
      index: assetSeq,
      kind,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      ...(src ? { src } : {}),
      ...(alt ? { alt } : {}),
    });
  };

  let virtualizedCount = 0;
  const virtualizedSummary: Array<{ selector: string; count: number }> = [];

  const shouldVirtualize =
    options?.virtualizeViewport === true ||
    (options?.virtualizeViewport !== false && !options?.selector && !options?.scope);
  const focusForVirtualization = getDeepActiveElement();

  function isProtectedFromVirtualization(el: Element): boolean {
    if (composedContains(el, focusForVirtualization)) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (
      tag === 'header' ||
      tag === 'nav' ||
      tag === 'footer' ||
      tag === 'dialog' ||
      tag === 'form' ||
      tag === 'main'
    ) {
      return true;
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (
      role === 'navigation' ||
      role === 'banner' ||
      role === 'contentinfo' ||
      role === 'search' ||
      role === 'dialog' ||
      role === 'alertdialog' ||
      role === 'menu' ||
      role === 'menubar' ||
      role === 'tablist'
    ) {
      return true;
    }
    if (
      typeof el.closest === 'function' &&
      el.closest(
        'header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], dialog',
      )
    ) {
      return true;
    }
    try {
      const s = window.getComputedStyle(el);
      if (s.position === 'fixed' || s.position === 'sticky') return true;
    } catch {}
    return false;
  }

  function getChildSignature(el: Element): string {
    const tag = (el.tagName || '').toLowerCase();
    let classSig = '';
    const rawClass =
      typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    if (rawClass.trim()) {
      const parts = rawClass
        .trim()
        .split(/\s+/)
        .filter(
          (c) =>
            !/^(active|selected|hover|focus|current|first|last|odd|even|visible|show|open|hide)$/i.test(
              c,
            ),
        )
        .slice(0, 2)
        .sort()
        .join('.');
      if (parts) classSig = '.' + parts;
    }
    const role = el.getAttribute('role');
    const rawTestId = el.getAttribute('data-testid');
    const normalizedTestId = rawTestId ? rawTestId.replace(/[-_]\d+$/, '') : null;
    const testIdPart = normalizedTestId ? `[data-testid*="${normalizedTestId}"]` : '';
    return role
      ? `${tag}${classSig}${testIdPart}[role="${role}"]`
      : `${tag}${classSig}${testIdPart}`;
  }

  const selectOptionOmissions = new Map<HTMLSelectElement, { total: number; shown: number }>();

  function traverse(
    node: Element,
    propagatingParentRect?: DOMRect | null,
    parentHasPointer = false,
    insideShadow = false,
  ) {
    if (isExcluded(node, false)) return;

    totalOriginalNodes++;

    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'body' || tag === 'html') {
      let style: CSSStyleDeclaration | null = null;
      try {
        style = window.getComputedStyle(node);
      } catch {}
      const currentHasPointer = style?.cursor === 'pointer';
      const nextPointer = currentHasPointer || parentHasPointer;
      const children = node.children ? Array.from(node.children) : [];
      for (const child of children) {
        traverse(child, propagatingParentRect, nextPointer, insideShadow);
      }
      return;
    }

    // Native options are indexed through the budgeted select pass below.
    if (tag === 'option') return;

    if (droppedTags.has(tag)) return;
    if (svgInternalTags.has(tag)) {
      const insideSvg = typeof node.closest === 'function' ? Boolean(node.closest('svg')) : true;
      if (insideSvg) {
        let nodeStyle: CSSStyleDeclaration | undefined;
        try {
          nodeStyle = window.getComputedStyle(node);
        } catch {}
        if (!isInteractiveSvgNode(node, nodeStyle)) {
          return;
        }
      }
    }
    if (typeof Element !== 'undefined' && !(node instanceof Element)) return;
    if (isAdOrTrackingElement(node)) return;

    if (
      node.hasAttribute('inert') ||
      (node as any).inert === true ||
      node.getAttribute('aria-hidden') === 'true'
    ) {
      return;
    }

    let style: CSSStyleDeclaration | null = null;
    try {
      style = window.getComputedStyle(node);
    } catch {}
    if (!style) {
      return;
    }

    const isFile = tag === 'input' && (node as HTMLInputElement).type === 'file';
    const isContents = style.display === 'contents';

    if (!isFile) {
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (parseFloat(style.opacity || '1') <= 0) return;
      if (!isContents && typeof (node as any).checkVisibility === 'function') {
        if (!(node as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return;
        }
      }
    }

    const rect = node.getBoundingClientRect();
    const isZeroSize = isContents || rect.width <= 0 || rect.height <= 0;

    if (!isFile) {
      if (isZeroSize) {
        if (node.children.length === 0 && !getShadowRoot(node)) return;
      } else {
        if (
          rect.top > winHeight + threshold ||
          rect.bottom < -threshold ||
          rect.left > winWidth + threshold ||
          rect.right < -threshold
        ) {
          return;
        }
      }
    }

    // Inline visual asset detection during the single traverse pass (eliminates secondary querySelectorAll thrashing)
    if (!isZeroSize) {
      if (tag === 'img') {
        const img = node as HTMLImageElement;
        pushAsset('img', img, rect, img.currentSrc || img.src || undefined, img.alt || undefined);
      } else if (tag === 'canvas' || tag === 'video') {
        pushAsset(tag as 'canvas' | 'video', node, rect);
      } else if (assets.length < 40) {
        const bg = style.backgroundImage;
        if (bg && bg !== 'none') {
          const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
          if (m) pushAsset('bg-image', node, rect, m[1]);
        }
      }
    }

    const currentHasPointer = style.cursor === 'pointer';
    const interactive = isInteractive(node, style, parentHasPointer);
    const informational = !interactive && isInformationalNode(node);
    const tableRole = getTableObservationRole(node);

    if (propagatingParentRect && !interactive && !isFile && !informational) {
      const xOverlap = Math.max(
        0,
        Math.min(rect.right, propagatingParentRect.right) -
          Math.max(rect.left, propagatingParentRect.left),
      );
      const yOverlap = Math.max(
        0,
        Math.min(rect.bottom, propagatingParentRect.bottom) -
          Math.max(rect.top, propagatingParentRect.top),
      );
      const overlapArea = xOverlap * yOverlap;
      const childArea = rect.width * rect.height;
      if (childArea > 0 && overlapArea / childArea >= 0.99) {
        const nextPointer = currentHasPointer || parentHasPointer;
        for (const child of Array.from(node.children)) {
          traverse(child, propagatingParentRect, nextPointer, insideShadow);
        }
        const shadow = getShadowRoot(node);
        if (shadow) {
          for (const shadowChild of Array.from(shadow.children)) {
            traverse(shadowChild, propagatingParentRect, nextPointer, true);
          }
        }
        return;
      }
    }

    const hasInfoText =
      informational && Boolean(((node as HTMLElement).innerText || node.textContent || '').trim());
    const isClosedHost =
      isCustomElement(node) &&
      getShadowRoot(node) === null &&
      (interactive ||
        style.cursor === 'pointer' ||
        node.hasAttribute('aria-label') ||
        node.hasAttribute('role') ||
        (node as HTMLElement).tabIndex >= 0);

    // Task B7: 2-level form control descendant penetration
    const hasFormControlDescendant = (element: Element, maxDepth = 2): boolean => {
      if (maxDepth <= 0 || !element || !element.children) return false;
      for (const child of Array.from(element.children)) {
        const childTag = (child.tagName || '').toLowerCase();
        if (
          childTag === 'input' ||
          childTag === 'select' ||
          childTag === 'textarea' ||
          childTag === 'button'
        ) {
          return true;
        }
        if (hasFormControlDescendant(child, maxDepth - 1)) {
          return true;
        }
      }
      return false;
    };

    const isWrapperOverFormControl =
      (tag === 'label' || tag === 'span' || tag === 'div') && hasFormControlDescendant(node, 2);

    if (
      !isZeroSize &&
      !isWrapperOverFormControl &&
      (interactive ||
        isFile ||
        (informational && hasInfoText) ||
        isClosedHost ||
        tableRole !== null)
    ) {
      candidates.push({
        node,
        tag,
        rect,
        isFile,
        isInteractive: interactive || isFile || isClosedHost,
        inShadowDom: insideShadow || (isClosedHost ? true : undefined),
        isClosedShadowHost: isClosedHost ? true : undefined,
        isTableStructure: tableRole !== null,
      });
    }

    // Task B4: Native <select> options static flattening into virtual entries
    if (tag === 'select' && (node as HTMLSelectElement).options) {
      const selectEl = node as HTMLSelectElement;
      const enabledOptions = Array.from(selectEl.options).filter(
        (opt) => !opt.disabled && !(opt.closest && opt.closest('optgroup[disabled]')),
      );
      const shownOptions = enabledOptions.slice(0, 50);
      for (const opt of shownOptions) {
        candidates.push({
          node: opt,
          tag: 'option',
          rect,
          isFile: false,
          isInteractive: true,
          inShadowDom: insideShadow,
          isSelectOption: true,
          parentSelect: selectEl,
          optionValue: opt.value,
          optionLabel: opt.label || opt.text || opt.value,
        });
      }
      if (enabledOptions.length > shownOptions.length) {
        selectOptionOmissions.set(selectEl, {
          total: enabledOptions.length,
          shown: shownOptions.length,
        });
      }
    }

    const nextPropagatingRect =
      !isZeroSize && interactive && (tag === 'button' || tag === 'a')
        ? rect
        : propagatingParentRect;
    const nextPointer = currentHasPointer || parentHasPointer;

    // Traverse standard children with Viewport Virtualization Pruning
    const rawChildren = Array.from(node.children);
    let childrenToTraverse = rawChildren;

    if (shouldVirtualize && rawChildren.length >= 4) {
      // Check if current node acts as a scroll container clipping its children
      let containerRect: DOMRect | null = null;
      try {
        const pStyle = window.getComputedStyle(node);
        const inlineStyle = (node as HTMLElement).style;
        const overflow =
          (pStyle?.overflowY || inlineStyle?.overflowY || '') +
          ' ' +
          (pStyle?.overflow || inlineStyle?.overflow || '');
        if (/(auto|scroll|hidden|clip)/i.test(overflow)) {
          containerRect = node.getBoundingClientRect();
        }
      } catch {}

      const groups = new Map<string, Element[]>();
      for (const child of rawChildren) {
        const sig = getChildSignature(child);
        let arr = groups.get(sig);
        if (!arr) {
          arr = [];
          groups.set(sig, arr);
        }
        arr.push(child);
      }

      const foldedSet = new Set<Element>();
      for (const [sig, items] of groups.entries()) {
        if (items.length >= 4) {
          const inViewportOrProtected: Element[] = [];
          const offscreenItems: Element[] = [];

          for (const item of items) {
            if (isProtectedFromVirtualization(item)) {
              inViewportOrProtected.push(item);
              continue;
            }
            const r = item.getBoundingClientRect();
            let inContainer = true;
            if (containerRect && containerRect.height > 0) {
              inContainer =
                r.bottom >= containerRect.top - 60 &&
                r.top <= containerRect.bottom + 60 &&
                r.right >= containerRect.left &&
                r.left <= containerRect.right;
            }
            const inViewport =
              inContainer &&
              r.bottom >= -60 &&
              r.top <= winHeight + 100 &&
              r.right >= 0 &&
              r.left <= winWidth;
            if (inViewport) {
              inViewportOrProtected.push(item);
            } else {
              offscreenItems.push(item);
            }
          }

          if (offscreenItems.length >= 3) {
            // Keep the first offscreen item as sample representation
            const sampleCount = Math.min(1, offscreenItems.length);
            const folded = offscreenItems.slice(sampleCount);

            for (const f of folded) {
              foldedSet.add(f);
            }

            virtualizedCount += folded.length;
            const parentTag = (node.tagName || '').toLowerCase();
            const parentId = node.id ? `#${node.id}` : '';
            const parentCls =
              typeof node.className === 'string' && node.className.trim()
                ? '.' + node.className.trim().split(/\s+/)[0]
                : '';
            const clusterSelector = `${parentTag}${parentId || parentCls} > ${sig}`;
            virtualizedSummary.push({ selector: clusterSelector, count: folded.length });

            const markerRect = offscreenItems[0].getBoundingClientRect();
            candidates.push({
              node: items[0],
              tag: 'virtual_marker',
              rect: {
                x: markerRect.x ?? markerRect.left ?? 0,
                y: markerRect.y ?? markerRect.top ?? 0,
                top: markerRect.top ?? 0,
                bottom: markerRect.bottom ?? 0,
                left: markerRect.left ?? 0,
                right: markerRect.right ?? 0,
                width: markerRect.width ?? 0,
                height: markerRect.height ?? 0,
              } as DOMRect,
              isFile: false,
              isInteractive: false,
              isVirtualMarker: true,
              virtualCount: folded.length,
              virtualSig: sig,
            } as any);
          }
        }
      }

      // Preserve strict DOM child ordering while omitting folded elements
      childrenToTraverse = rawChildren.filter((c) => !foldedSet.has(c));
    }

    for (const child of childrenToTraverse) {
      traverse(child, nextPropagatingRect, nextPointer, insideShadow);
    }

    // Traverse slotted elements if node is a slot
    if (tag === 'slot' && typeof (node as HTMLSlotElement).assignedElements === 'function') {
      try {
        const assigned = (node as HTMLSlotElement).assignedElements({ flatten: true });
        for (const assignedEl of assigned) {
          traverse(assignedEl, nextPropagatingRect, nextPointer, insideShadow);
        }
      } catch {}
    }

    // Traverse Shadow DOM children (penetration for open and closed shadow roots)
    const shadow = getShadowRoot(node);
    if (shadow) {
      for (const shadowChild of Array.from(shadow.children)) {
        traverse(shadowChild, nextPropagatingRect, nextPointer, true);
      }
    }
  }

  const candidates: Array<{
    node: Element;
    tag: string;
    rect: DOMRect;
    isFile: boolean;
    isInteractive: boolean;
    inShadowDom?: boolean;
    isClosedShadowHost?: boolean;
    isSelectOption?: boolean;
    parentSelect?: HTMLSelectElement;
    optionValue?: string;
    optionLabel?: string;
    text?: string;
    isTableStructure?: boolean;
  }> = [];

  let roots: Element[] = [];
  let selectorMatched = false;
  let modalIsolated = false;
  let interactionScope: InteractionScopeInfo | undefined;

  const targetSelector = options?.scope || options?.selector;
  if (targetSelector) {
    interactionScope = computeInteractionScope(window, { explicitScope: true });
    try {
      const allRoots = targetSelector.includes(':has-text(')
        ? queryWithHasText(document, targetSelector, false)
        : querySelectorAllDeep(targetSelector, document);
      selectorMatched = allRoots.length > 0;
      // Filter out nested roots so child elements are not traversed or indexed twice
      roots = allRoots.filter((r) => !allRoots.some((other) => other !== r && other.contains(r)));
    } catch {
      roots = [];
      selectorMatched = false;
    }
  } else if (options?.isolateModal !== false) {
    interactionScope = computeInteractionScope(window);
    roots = interactionScope.roots;
    modalIsolated = interactionScope.modalIsolated;
    selectorMatched = roots.length > 0;
  } else if (document.body) {
    interactionScope = {
      ...computeInteractionScope(window, { explicitScope: true }),
      roots: [document.body],
    };
    roots = [document.body];
    selectorMatched = true;
  }

  for (const root of roots) {
    if (isExcluded(root, true)) continue;
    traverse(root, null, false, false);
  }

  // Phase 2: Deterministic visual reading-order sort (top-to-bottom, left-to-right)
  candidates.sort((a, b) => {
    const ay = a.rect?.y ?? a.rect?.top ?? 0;
    const by = b.rect?.y ?? b.rect?.top ?? 0;
    const ax = a.rect?.x ?? a.rect?.left ?? 0;
    const bx = b.rect?.x ?? b.rect?.left ?? 0;
    const dy = Math.round(ay) - Math.round(by);
    if (Math.abs(dy) > 4) {
      return dy;
    }
    return Math.round(ax) - Math.round(bx);
  });

  type TreeOutputItem = { type: 'element'; el: IndexedElement } | { type: 'marker'; line: string };
  const treeOutputItems: TreeOutputItem[] = [];

  // Shape inference scans a candidate's whole subtree, so a nested candidate re-walks nodes an
  // ancestor candidate already visited. Both helpers below are pure per node, so caching them for
  // this snapshot keeps the original document order and depth while visiting each node once.
  const SHAPE_DESCENDANT_TAGS = new Set(['span', 'div', 'i', 'svg', 'polygon', 'circle', 'rect']);
  const ownShapeCache = new WeakMap<Element, string | null>();
  const descendantShapeCache = new WeakMap<Element, string | null>();

  // Shape contributed by the element's own style/tag, in the original rule precedence.
  const ownVisualShape = (el: Element): string | null => {
    const cached = ownShapeCache.get(el);
    if (cached !== undefined) return cached;

    let shape: string | null = null;
    const style = el.getAttribute('style') || '';
    if (/rotate\(\s*(45|135|225|315)deg\s*\)/i.test(style)) {
      shape = 'diamond';
    } else if (/border-radius:\s*(50%|9999px)/i.test(style)) {
      shape = 'circle';
    } else if (/clip-path:\s*polygon/i.test(style)) {
      const pts = (style.match(/%/g) || []).length;
      shape = pts >= 12 ? 'hex' : 'triangle';
    } else {
      const tag = el.tagName.toLowerCase();
      if (tag === 'circle') shape = 'circle';
      else if (tag === 'polygon') shape = 'polygon';
    }

    ownShapeCache.set(el, shape);
    return shape;
  };

  // First shape among the descendants the original selector matched, in document order.
  const descendantShape = (root: Element): string | null => {
    const cached = descendantShapeCache.get(root);
    if (cached !== undefined) return cached;

    let shape: string | null = null;
    for (const child of Array.from(root.children)) {
      if (SHAPE_DESCENDANT_TAGS.has(child.tagName.toLowerCase())) {
        shape = ownVisualShape(child);
        if (shape !== null) break;
      }
      shape = descendantShape(child);
      if (shape !== null) break;
    }

    descendantShapeCache.set(root, shape);
    return shape;
  };

  // Phase 2: Decoupled batch hit-testing & indexing pass (eliminates layout thrashing)
  let flattenedCardCount = 0;
  if (options?.flattenCards !== false) {
    flattenedCardCount = flattenCompositeCards(candidates as any, maxTextLength);
  }

  const deepActiveElement = getDeepActiveElement();
  const focusScope = observationFocusScope(deepActiveElement);

  for (const cand of candidates) {
    if ((cand as any).isCardSecondary) {
      continue;
    }

    if ((cand as any).isVirtualMarker) {
      const virtualMarkerText =
        outputFormat === 'html'
          ? `<!-- [virtualized: ${(cand as any).virtualCount} similar offscreen items in <${(cand as any).virtualSig}> folded (scroll down or use scope/selector to reveal)] -->`
          : `~ [virtualized: ${(cand as any).virtualCount} similar offscreen items in <${(cand as any).virtualSig}> folded (scroll down or use selector to reveal)]`;
      treeOutputItems.push({ type: 'marker', line: virtualMarkerText });
      continue;
    }

    const occlusion = checkOcclusionGrid(cand.node, cand.rect);
    if (occlusion.isFullyOccluded) continue;

    safeClickPointWeakMap.set(cand.node, occlusion.safeClickPoint);

    const assignedIndex = indexElement(cand.node, '', startingIndex);

    // Detect visual geometric shape if styled or transformed (diamond, circle, hex, triangle, square)
    let detectedShape: string | undefined = undefined;
    try {
      detectedShape = ownVisualShape(cand.node) ?? descendantShape(cand.node) ?? undefined;
    } catch {}

    const attributes: Record<string, string> = {};
    const attrsToKeep = [
      'id',
      'name',
      'type',
      'placeholder',
      'aria-label',
      'role',
      'href',
      'title',
      'disabled',
      'aria-disabled',
      'contenteditable',
      'aria-checked',
      'aria-selected',
      'aria-expanded',
      'aria-pressed',
      'aria-invalid',
      'aria-required',
      'aria-describedby',
      'aria-errormessage',
    ];
    for (const attr of attrsToKeep) {
      const val = cand.node.getAttribute(attr);
      if (val) attributes[attr] = val.slice(0, 100);
    }
    if (typeof cand.node.getAttributeNames === 'function') {
      for (const attr of cand.node.getAttributeNames()) {
        if (attr.startsWith('data-') && !attributes[attr]) {
          const val = cand.node.getAttribute(attr);
          if (val) attributes[attr] = val.slice(0, 100);
        }
      }
    }
    if (cand.isFile) {
      attributes['type'] = 'file';
    }
    if (detectedShape) {
      attributes['visual-shape'] = detectedShape;
    }

    // Task B1: Compute scopeHash for Local Scope Guard
    let scopeHash = '';
    try {
      const container =
        (cand.node as Element).closest?.(
          'form,dialog,[role="dialog"],article,li,tr,[role="row"]',
        ) || cand.node.parentElement;
      const scopeText = container ? (container.textContent || '').trim().slice(0, 1000) : '';
      if (scopeText) {
        scopeHash = computeScopeHash(scopeText);
        attributes['data-scope-hash'] = scopeHash;
      }
    } catch {}

    // Task B4: Select option attributes
    if (cand.isSelectOption) {
      if (cand.optionValue !== undefined) {
        attributes['value'] = cand.optionValue;
      }
      attributes['selected'] = (cand.node as HTMLOptionElement).selected ? 'true' : 'false';
    }

    if (
      (cand.node as HTMLElement).isContentEditable ||
      cand.node.getAttribute('contenteditable') === 'true' ||
      cand.node.getAttribute('contenteditable') === ''
    ) {
      attributes['contenteditable'] = 'true';
    }
    if (
      (cand.node as any).disabled ||
      cand.node.hasAttribute('disabled') ||
      cand.node.getAttribute('aria-disabled') === 'true'
    ) {
      attributes['disabled'] = 'true';
    }

    // Expose live toggle state. React controlled inputs update the IDL property
    // (`el.checked`) without touching the content attribute, so the attribute
    // layer alone cannot tell a checked box from an unchecked one — agents had
    // to fall back to screenshots to verify form state.
    try {
      const node = cand.node as HTMLInputElement;
      const inputType = (attributes.type || node.getAttribute('type') || '').toLowerCase();
      if (cand.tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
        attributes['checked'] = node.checked ? 'true' : 'false';
      }
      if (cand.tag === 'option') {
        attributes['selected'] = (node as unknown as HTMLOptionElement).selected ? 'true' : 'false';
      }
    } catch {}

    // Scrollable container hint (P1-7)
    try {
      if (
        cand.node.scrollHeight > cand.node.clientHeight + 2 &&
        /(auto|scroll)/.test(window.getComputedStyle(cand.node).overflowY)
      ) {
        attributes['scrollable'] = 'true';
      }
    } catch {}

    // Form validation state. Agents previously had to submit a form and watch
    // for a re-render to learn whether a field was valid, and React/Angular
    // validators set aria-invalid without ever setting the DOM validity flags.
    // Report both: the native constraint state and the ARIA hint.
    try {
      const el = cand.node as HTMLInputElement;
      const supportsValidity =
        cand.tag === 'input' || cand.tag === 'textarea' || cand.tag === 'select';
      const formMeta = readFormObservationMetadata(cand.node);
      if (formMeta?.valid !== undefined) attributes['valid'] = String(formMeta.valid);
      if (formMeta?.invalidReason) attributes['invalidReason'] = formMeta.invalidReason;
      if (formMeta?.validationMessage) attributes['validationMessage'] = formMeta.validationMessage;
      if (formMeta?.required) attributes['required'] = 'true';
      // Constraint hints so an agent can satisfy the field without guessing.
      for (const attr of ['pattern', 'min', 'max', 'minlength', 'maxlength', 'step']) {
        if (attributes[attr]) continue;
        const val = cand.node.getAttribute(attr);
        if (val) attributes[attr] = val.slice(0, 100);
      }

      if (formMeta) {
        const rawValue = supportsValidity
          ? typeof (el as any).value === 'string'
            ? String((el as any).value).trim()
            : ''
          : (cand.node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (formMeta.label && formMeta.label !== rawValue) {
          attributes['label'] = formMeta.label;
        }
        if (formMeta.invalid) {
          attributes['invalid'] = 'true';
          delete attributes['valid'];
          if (!attributes['invalidReason']) attributes['invalidReason'] = 'aria-invalid';
          if (formMeta.invalidRaw) attributes['aria-invalid'] = formMeta.invalidRaw;
        } else {
          delete attributes['aria-errormessage'];
        }

        const existingTexts = new Set(
          [attributes['validationMessage'], attributes['label'], rawValue].filter(Boolean),
        );
        if (formMeta.errormessage && !existingTexts.has(formMeta.errormessage)) {
          attributes['errormessage'] = formMeta.errormessage;
          existingTexts.add(formMeta.errormessage);
        }
        if (formMeta.description && !existingTexts.has(formMeta.description)) {
          attributes['description'] = formMeta.description;
        }
      }
    } catch {}

    if (deepActiveElement === cand.node) {
      attributes['focused'] = 'true';
    }

    // Dialog / modal status (P1-7)
    try {
      if (cand.node.closest('dialog, [role="dialog"], [role="alertdialog"], .modal')) {
        attributes['dialog'] = 'true';
      }
    } catch {}

    // Form value extraction with sensitive field masking (P1-7)
    let elemValue: string | undefined = undefined;
    if (cand.tag === 'input' || cand.tag === 'textarea' || cand.tag === 'select') {
      try {
        const rawVal = (cand.node as any).value;
        if (typeof rawVal === 'string' && rawVal.length > 0) {
          const type = (attributes.type || cand.node.getAttribute('type') || '').toLowerCase();
          const name = (attributes.name || cand.node.getAttribute('name') || '').toLowerCase();
          const id = (attributes.id || cand.node.getAttribute('id') || '').toLowerCase();
          const autocomplete = (cand.node.getAttribute('autocomplete') || '').toLowerCase();
          const ariaLabel = (
            attributes['aria-label'] ||
            cand.node.getAttribute('aria-label') ||
            ''
          ).toLowerCase();
          const isSensitive =
            type === 'password' ||
            /(password|passcode|secret|cc-|credit-card|cvv|cvc|card-number|one-time-code|otp|token)/i.test(
              `${name} ${id} ${autocomplete} ${ariaLabel}`,
            );

          if (isSensitive) {
            elemValue = '••••••••';
          } else {
            elemValue = rawVal.slice(0, 200);
          }
        }
      } catch {}
    }

    const isCard = (cand as any).isCard === true;
    const tableObservation = cand.isTableStructure
      ? buildTableObservation(cand.node, maxTextLength, tableObservationCache)
      : null;
    let text = tableObservation
      ? tableObservation.text || ''
      : isCard
        ? (cand as any).aggregatedText
        : extractCleanElementText(cand.node, maxTextLength);
    const editorSemantics = detectEditorSemantics(cand.node);
    let role =
      tableObservation?.role || (isCard ? 'card' : cand.node.getAttribute('role') || undefined);
    if (tableObservation) Object.assign(attributes, tableObservation.attributes);

    // Task B4: Virtual select option text and role
    if (cand.isSelectOption) {
      const parentName =
        cand.parentSelect?.getAttribute('name') ||
        cand.parentSelect?.getAttribute('aria-label') ||
        cand.parentSelect?.getAttribute('id') ||
        'select';
      const optText =
        cand.optionLabel || (cand.node as HTMLOptionElement).text || cand.optionValue || '';
      text = `${parentName} → ${optText}`;
      role = 'option';
      if (!elemValue && cand.optionValue !== undefined) {
        elemValue = cand.optionValue;
      }
    }

    const indexedElem: IndexedElement = {
      index: assignedIndex,
      tagName: cand.tag,
      role: role,
      text: text || undefined,
      value: elemValue,
      attributes,
      rect: {
        x: Math.round(cand.rect.x),
        y: Math.round(cand.rect.y),
        width: Math.round(cand.rect.width),
        height: Math.round(cand.rect.height),
      },
      isInteractive: cand.isInteractive,
      ...(withinObservationFocusScope(cand.node, focusScope) ? { withinFocusScope: true } : {}),
      isOccluded: occlusion.isOccluded,
      occludedBy: occlusion.occludedBy,
      inShadowDom: cand.inShadowDom,
      safeClickPoint:
        cand.isTableStructure && !cand.isInteractive
          ? undefined
          : {
              x: occlusion.safeClickPoint.x,
              y: occlusion.safeClickPoint.y,
            },
      isComposer: editorSemantics.isComposer || undefined,
      isEditor: editorSemantics.isEditor || undefined,
      isSearch: editorSemantics.isSearch || undefined,
      isClosedShadowHost: cand.isClosedShadowHost || undefined,
      isActionTrigger: (cand as any).isActionTrigger || undefined,
      actionTriggerType: (cand as any).actionTriggerType || undefined,
    };

    indexedElements.push(indexedElem);
    treeOutputItems.push({ type: 'element', el: indexedElem });
    prunedElementCount++;
    indexMap[assignedIndex] = {
      selector: attributes.id ? `#${attributes.id}` : `${cand.tag}`,
      frameId,
      tagName: cand.tag,
    };

    const omittedOptions =
      cand.tag === 'select' ? selectOptionOmissions.get(cand.node as HTMLSelectElement) : undefined;
    if (omittedOptions) {
      const omitted = omittedOptions.total - omittedOptions.shown;
      const selectName =
        attributes.label ||
        attributes.name ||
        attributes.id ||
        cand.node.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) ||
        'select';
      const readPath = `${resolveToolName('get_dropdown_options')} index=${assignedIndex}`;
      const message = `${omitted} enabled options omitted for select "${selectName}" (showing ${omittedOptions.shown} of ${omittedOptions.total}); use ${readPath} to read all`;
      treeOutputItems.push({
        type: 'marker',
        line: outputFormat === 'html' ? `<!-- [${message}] -->` : `~ [${message}]`,
      });
    }
  }

  // Scroll guidance uses the same roots as the observation. Explicit scope is
  // allowed to inspect background content, but the default modal scope never
  // falls back to scrolling the obscured page.
  const usePrecomputedContainers =
    !targetSelector && options?.isolateModal !== false && interactionScope !== undefined;
  const scrollInfo = buildScopedScrollInfo(roots, window, {
    modalActive: Boolean(
      interactionScope?.focusTrapped && !targetSelector && options?.isolateModal !== false,
    ),
    ...(usePrecomputedContainers ? { containers: interactionScope?.scrollContainers ?? [] } : {}),
  });
  const pages_up = scrollInfo.pages_up;
  const pages_down = scrollInfo.pages_down;

  const compressionRatio =
    totalOriginalNodes > 0
      ? Number(((totalOriginalNodes - prunedElementCount) / totalOriginalNodes).toFixed(4))
      : 0;

  const treeLines = treeOutputItems.map((item) => {
    if (item.type === 'marker') {
      return item.line;
    }
    const el = item.el;
    if (outputFormat === 'html') {
      const attrStr = Object.entries(el.attributes)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      const valPart = el.value ? ` value="${el.value}"` : '';
      const textPart = el.text ? ` "${el.text}"` : '';
      const occludedPart = el.isOccluded
        ? ` [occluded: partially by ${el.occludedBy || 'overlay'}]`
        : '';
      const shadowPart = el.isClosedShadowHost
        ? ' [closed-shadow-host]'
        : el.inShadowDom
          ? ' [shadow]'
          : '';
      return `[${el.index}]${shadowPart} <${el.tagName}${attrStr ? ' ' + attrStr : ''}${valPart}>${textPart}</${el.tagName}>${occludedPart}`;
    }
    return renderCompactElementLine(el);
  });

  let treeString = treeLines.join('\n');

  const activeModal = interactionScope?.activeModal;
  const focusTrapped = interactionScope?.focusTrapped === true;
  const isConfirmationTrap = interactionScope?.isConfirmationTrap === true;

  if (activeModal) {
    const modalNotice = isConfirmationTrap
      ? `[Modal Guidance: CRITICAL CONFIRMATION TRAP DETECTED (${activeModal}). A secondary confirmation dialog is open ("Discard / Confirm" / "放弃帖子？"). You MUST dismiss or confirm this dialog (e.g. click "Discard" or "Cancel") before attempting any other actions on the page.]\n`
      : `[Modal Guidance: Active modal focus trap (${activeModal}). Prioritize interacting with modal elements or dismissing it.]\n`;
    treeString = modalNotice + treeString;
  }

  if (modalIsolated) {
    const isolateNotice = `[MODAL_ACTIVE: Focus locked to active modal "${activeModal || 'dialog'}". Background page elements pruned to prevent misclicks. Dismiss modal or submit to return to main page.]\n`;
    treeString = isolateNotice + treeString;
  }

  if (pages_down > 0 || pages_up > 0) {
    treeString =
      `[Scroll Guidance: ${pages_up} pages above, ${pages_down} pages below. Use ${resolveToolName('interact_index')} / scroll to reveal more content.]\n` +
      treeString;
  }

  // Handle visual Set-of-Mark badges if highlight is enabled
  if (options?.highlight) {
    inPageRenderHighlights(indexedElements);
  }

  (globalThis as any)[Symbol.for('__browser_use_page_assets__')] = assetRegistry;

  return {
    treeString,
    elementCount: prunedElementCount,
    // Informational nodes (h1-h6, th, role=alert/status/heading, aria-live) are
    // indexed with isInteractive:false, so counting every indexed element here
    // made interactiveCount identical to elementCount and told the agent nothing.
    interactiveCount: indexedElements.filter((el) => el.isInteractive).length,
    compressionRatio,
    indexMap,
    indexedElements,
    assets,
    pages_up,
    pages_down,
    scrollInfo,
    activeModal,
    focusTrapped: focusTrapped || undefined,
    isConfirmationTrap: isConfirmationTrap || undefined,
    selectorMatched:
      options?.selector !== undefined || options?.scope !== undefined ? selectorMatched : undefined,
    modalIsolated: modalIsolated || undefined,
    virtualizedCount: virtualizedCount > 0 ? virtualizedCount : undefined,
    virtualizedSummary: virtualizedSummary.length > 0 ? virtualizedSummary : undefined,
    flattenedCardCount: flattenedCardCount > 0 ? flattenedCardCount : undefined,
  };
}

export function actionPointForElement(
  target: Element,
  view: Window = window,
): { x: number; y: number } | null {
  const rects = Array.from(target.getClientRects?.() || []).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (rects.length === 0) {
    const rect = target.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    rects.push(rect);
  }

  const vw = typeof view?.innerWidth === 'number' && view.innerWidth > 0 ? view.innerWidth : 1280;
  const vh = typeof view?.innerHeight === 'number' && view.innerHeight > 0 ? view.innerHeight : 800;
  const margins = getStickyOcclusionMargins(view, target);
  const safeTop = margins.top > 0 ? margins.top : 0;
  const safeBottom = margins.bottom > 0 ? vh - margins.bottom : vh;

  let best = null;
  for (const rect of rects) {
    const left = Math.max(0, rect.left);
    const top = Math.max(safeTop, rect.top);
    const right = Math.min(vw, rect.right);
    const bottom = Math.min(safeBottom, rect.bottom);
    const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);

    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    const distanceX = centerX - Math.max(0, Math.min(vw, centerX));
    const distanceY = centerY - Math.max(safeTop, Math.min(safeBottom, centerY));
    const viewportDistance = distanceX * distanceX + distanceY * distanceY;

    if (
      !best ||
      visibleArea > best.visibleArea ||
      (visibleArea === best.visibleArea && viewportDistance < best.viewportDistance)
    ) {
      best = { rect, left, top, right, bottom, visibleArea, viewportDistance };
    }
  }

  if (best && best.visibleArea > 0) {
    return {
      x: (best.left + best.right) / 2,
      y: (best.top + best.bottom) / 2,
    };
  }

  if (best) {
    return {
      x: (best.rect.left + best.rect.right) / 2,
      y: (best.rect.top + best.rect.bottom) / 2,
    };
  }
  return null;
}

export function scrollRequestForPoint(
  target: Element,
  x: number,
  y: number,
): { x: number; y: number; deltaX: number; deltaY: number } | null {
  const view = target.ownerDocument?.defaultView || window;
  const vw = typeof view?.innerWidth === 'number' && view.innerWidth > 0 ? view.innerWidth : 1280;
  const vh = typeof view?.innerHeight === 'number' && view.innerHeight > 0 ? view.innerHeight : 800;

  let ancestor = composedParent(target);
  while (ancestor) {
    if (
      ancestor !== target.ownerDocument?.body &&
      ancestor !== target.ownerDocument?.documentElement
    ) {
      const style =
        typeof view.getComputedStyle === 'function' ? view.getComputedStyle(ancestor) : null;
      if (style) {
        const canScrollX =
          /^(auto|scroll|overlay)$/.test(style.overflowX) &&
          ancestor.scrollWidth > ancestor.clientWidth + 1;
        const canScrollY =
          /^(auto|scroll|overlay)$/.test(style.overflowY) &&
          ancestor.scrollHeight > ancestor.clientHeight + 1;

        if (canScrollX || canScrollY) {
          const rect = ancestor.getBoundingClientRect();
          const area = {
            left: Math.max(0, rect.left),
            top: Math.max(0, rect.top),
            right: Math.min(vw, rect.right),
            bottom: Math.min(vh, rect.bottom),
          };

          if (area.right > area.left && area.bottom > area.top) {
            let deltaX =
              canScrollX && (x < area.left || x >= area.right)
                ? x - (area.left + area.right) / 2
                : 0;
            let deltaY =
              canScrollY && (y < area.top || y >= area.bottom)
                ? y - (area.top + area.bottom) / 2
                : 0;

            if (
              (deltaX < 0 && ancestor.scrollLeft <= 0) ||
              (deltaX > 0 && ancestor.scrollLeft >= ancestor.scrollWidth - ancestor.clientWidth - 1)
            )
              deltaX = 0;
            if (
              (deltaY < 0 && ancestor.scrollTop <= 0) ||
              (deltaY > 0 &&
                ancestor.scrollTop >= ancestor.scrollHeight - ancestor.clientHeight - 1)
            )
              deltaY = 0;

            if (deltaX || deltaY) {
              return {
                x: (area.left + area.right) / 2,
                y: (area.top + area.bottom) / 2,
                deltaX,
                deltaY,
              };
            }
          }
        }
      }
    }
    ancestor = composedParent(ancestor);
  }

  if (x >= 0 && y >= 0 && x < vw && y < vh) return null;

  return {
    x: Math.max(0, Math.min(vw - 1, x)),
    y: Math.max(0, Math.min(vh - 1, y)),
    deltaX: x - vw / 2,
    deltaY: y - vh / 2,
  };
}

export function extractElementLocationDetails(
  el: Element,
  allowScroll = true,
): {
  success: boolean;
  index?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  tagName: string;
  inputType?: string;
  text?: string;
  value?: string;
  role?: string;
  isClickable?: boolean;
  frameOffsetX: number;
  frameOffsetY: number;
  attributes?: Record<string, string>;
  isComposer?: boolean;
  isEditor?: boolean;
  isSearch?: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  validity?: { valid: boolean };
  invalidReason?: string;
  checked?: boolean;
  selected?: boolean;
  scopeHash?: string;
} {
  const win = el.ownerDocument?.defaultView || window;
  const initialRect = el.getBoundingClientRect();
  const vh = win.innerHeight || 0;
  const vw = win.innerWidth || 0;
  const margins = getStickyOcclusionMargins(win, el);
  const elStyle = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
  const scrollMarginTop = parseFloat(elStyle?.scrollMarginTop || '0') || 0;
  const scrollMarginBottom = parseFloat(elStyle?.scrollMarginBottom || '0') || 0;
  const safeTop = Math.min(Math.max(margins.top, scrollMarginTop, 80), Math.round(vh * 0.35));
  const safeBottom = Math.min(
    Math.max(margins.bottom, scrollMarginBottom, 80),
    Math.round(vh * 0.35),
  );
  const minSafeTop = safeTop;
  const maxSafeBottom = Math.max(minSafeTop, vh - safeBottom);

  const inViewport =
    vh > 0 &&
    vw > 0 &&
    initialRect.top >= minSafeTop &&
    initialRect.bottom <= maxSafeBottom &&
    initialRect.left >= 0 &&
    initialRect.right <= vw &&
    initialRect.width > 0 &&
    initialRect.height > 0;

  if (!inViewport && allowScroll) {
    // Try local scroll first
    const point = actionPointForElement(el, win);
    if (point) {
      const scrollReq = scrollRequestForPoint(el, point.x, point.y);
      if (scrollReq && (scrollReq.deltaX || scrollReq.deltaY)) {
        let ancestor = composedParent(el);
        let scrolled = false;
        while (ancestor && !scrolled) {
          if (ancestor !== el.ownerDocument.body && ancestor !== el.ownerDocument.documentElement) {
            const style = win.getComputedStyle(ancestor);
            const canScrollX =
              /^(auto|scroll|overlay)$/.test(style.overflowX) &&
              ancestor.scrollWidth > ancestor.clientWidth + 1;
            const canScrollY =
              /^(auto|scroll|overlay)$/.test(style.overflowY) &&
              ancestor.scrollHeight > ancestor.clientHeight + 1;
            if (canScrollX || canScrollY) {
              ancestor.scrollBy({
                left: scrollReq.deltaX,
                top: scrollReq.deltaY,
                behavior: 'instant' as any,
              });
              scrolled = true;
            }
          }
          ancestor = composedParent(ancestor);
        }
        if (!scrolled) {
          try {
            if (typeof (el as any).scrollIntoView === 'function') {
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
            }
          } catch {}
        }
      } else {
        try {
          if (typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
          }
        } catch {}
      }
    } else {
      try {
        if (typeof (el as any).scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
        }
      } catch {}
    }

    // Secondary safety check: if element ended up occluded by a sticky top header or bottom bar, nudge scroll
    try {
      const isJsdom =
        typeof win.navigator !== 'undefined' &&
        typeof win.navigator.userAgent === 'string' &&
        win.navigator.userAgent.includes('jsdom');
      const updatedR = el.getBoundingClientRect();
      if (!isJsdom && updatedR.top < safeTop + 10) {
        const delta = updatedR.top - safeTop - 20;
        win.scrollBy?.({ top: delta, behavior: 'instant' as any });
        let anc = composedParent(el);
        while (anc && anc !== win.document.body && anc !== win.document.documentElement) {
          anc.scrollBy?.({ top: delta, behavior: 'instant' as any });
          anc = composedParent(anc);
        }
      } else if (!isJsdom && updatedR.bottom > vh - safeBottom - 10) {
        const delta = updatedR.bottom - (vh - safeBottom) + 20;
        win.scrollBy?.({ top: delta, behavior: 'instant' as any });
        let anc = composedParent(el);
        while (anc && anc !== win.document.body && anc !== win.document.documentElement) {
          anc.scrollBy?.({ top: delta, behavior: 'instant' as any });
          anc = composedParent(anc);
        }
      }
    } catch {}
  }

  const rect = el.getBoundingClientRect();
  const text = extractCleanElementText(el).slice(0, 100);

  // Calculate cumulative viewport offset if inside an iframe (with border and zoom compensation)
  let frameOffsetX = 0;
  let frameOffsetY = 0;
  try {
    let curWin: Window = window;
    while (curWin !== curWin.top) {
      if (curWin.frameElement) {
        const fEl = curWin.frameElement;
        const fRect = fEl.getBoundingClientRect();
        const parentWin = curWin.parent || fEl.ownerDocument?.defaultView || window;
        const fStyle =
          typeof parentWin.getComputedStyle === 'function'
            ? parentWin.getComputedStyle(fEl)
            : undefined;
        const borderLeft = parseFloat(fStyle?.borderLeftWidth || '0') || 0;
        const borderTop = parseFloat(fStyle?.borderTopWidth || '0') || 0;
        const zoom = parseFloat((fStyle as any)?.zoom || '1') || 1;

        frameOffsetX += (fRect.left + borderLeft) / zoom;
        frameOffsetY += (fRect.top + borderTop) / zoom;
        curWin = curWin.parent;
      } else {
        break;
      }
    }
  } catch {
    // Cross-origin boundary fallback
  }

  const safePoint = safeClickPointWeakMap.get(el);
  let clickX, clickY;
  if (safePoint) {
    clickX = rect.left + safePoint.offsetX;
    clickY = rect.top + safePoint.offsetY;
  } else {
    const bestPoint = actionPointForElement(el, win);
    if (bestPoint) {
      clickX = bestPoint.x;
      clickY = bestPoint.y;
    } else {
      clickX = rect.left + rect.width / 2;
      clickY = rect.top + rect.height / 2;
    }
  }

  const semantics = detectEditorSemantics(el);

  const disabled = Boolean(
    (el as any).disabled === true ||
    (typeof (el as any).hasAttribute === 'function' && el.hasAttribute('disabled')),
  );
  const ariaDisabled =
    typeof (el as any).getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true';
  const isAriaInvalid =
    typeof (el as any).getAttribute === 'function' && el.getAttribute('aria-invalid') === 'true';
  const valObj =
    typeof (el as any).validity === 'object' && (el as any).validity !== null
      ? (el as any).validity
      : undefined;
  const validity = valObj
    ? { valid: isAriaInvalid ? false : Boolean(valObj.valid) }
    : isAriaInvalid
      ? { valid: false }
      : undefined;
  const invalidReason =
    typeof (el as any).validationMessage === 'string' && (el as any).validationMessage
      ? (el as any).validationMessage
      : isAriaInvalid
        ? 'aria-invalid'
        : undefined;
  const checked =
    typeof (el as any).checked === 'boolean'
      ? (el as any).checked
      : typeof (el as any).getAttribute === 'function' && el.getAttribute('aria-checked') === 'true'
        ? true
        : typeof (el as any).getAttribute === 'function' &&
            el.getAttribute('aria-checked') === 'false'
          ? false
          : undefined;
  const selected =
    typeof (el as any).selected === 'boolean'
      ? (el as any).selected
      : typeof (el as any).getAttribute === 'function' &&
          el.getAttribute('aria-selected') === 'true'
        ? true
        : typeof (el as any).getAttribute === 'function' &&
            el.getAttribute('aria-selected') === 'false'
          ? false
          : undefined;

  let matchedIndex: number | undefined;
  try {
    const isolatedMap = getIsolatedIndexMap();
    // Pass 1: exact element match
    for (const [idx, entry] of isolatedMap.entries()) {
      const target = derefElement(entry);
      if (target === el) {
        matchedIndex = idx;
        break;
      }
    }
    // Pass 2: interactive wrapper match (e.g. inner icon/span of button/link)
    if (matchedIndex === undefined) {
      const interactiveEl =
        typeof el.closest === 'function'
          ? el.closest('button, a, input, select, textarea, [role="button"]')
          : null;
      if (interactiveEl && interactiveEl !== el) {
        for (const [idx, entry] of isolatedMap.entries()) {
          const target = derefElement(entry);
          if (target === interactiveEl) {
            matchedIndex = idx;
            break;
          }
        }
      }
    }
    // Pass 3: allocate new index if still unindexed
    if (matchedIndex === undefined) {
      matchedIndex = indexElement(el);
    }
  } catch {}

  const elTag = el.tagName.toLowerCase();
  const elRole =
    typeof el.getAttribute === 'function'
      ? el.getAttribute('role')?.toLowerCase() || undefined
      : undefined;
  const isClickable = Boolean(
    elTag === 'button' ||
    elTag === 'a' ||
    elRole === 'button' ||
    (el as HTMLInputElement).type === 'submit' ||
    (el as HTMLInputElement).type === 'button' ||
    typeof (el as any).onclick === 'function' ||
    (typeof window !== 'undefined' &&
      window.getComputedStyle &&
      window.getComputedStyle(el).cursor === 'pointer'),
  );

  return {
    success: true,
    ...(typeof matchedIndex === 'number' ? { index: matchedIndex } : {}),
    x: Math.round(clickX + frameOffsetX),
    y: Math.round(clickY + frameOffsetY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    tagName: elTag,
    inputType:
      typeof (el as HTMLInputElement).type === 'string'
        ? (el as HTMLInputElement).type.toLowerCase()
        : undefined,
    text,
    value:
      typeof (globalThis as any).HTMLInputElement !== 'undefined' &&
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? String((el as any).value ?? '')
        : typeof (el as any)?.value === 'string'
          ? (el as any).value
          : undefined,
    role: elRole,
    isClickable,
    frameOffsetX,
    frameOffsetY,
    attributes:
      typeof (el as any).attributes !== 'undefined'
        ? Object.fromEntries(
            Array.from((el as Element).attributes || []).map((a) => [a.name, a.value]),
          )
        : undefined,
    isComposer: semantics.isComposer || undefined,
    isEditor: semantics.isEditor || undefined,
    isSearch: semantics.isSearch || undefined,
    disabled,
    ariaDisabled,
    validity,
    invalidReason,
    checked,
    selected,
    scopeHash: (() => {
      try {
        const container =
          el.closest?.('form,dialog,[role="dialog"],article,li,tr,[role="row"]') ||
          el.parentElement;
        const scopeText = container ? (container.textContent || '').trim().slice(0, 1000) : '';
        return scopeText ? computeScopeHash(scopeText) : undefined;
      } catch {
        return undefined;
      }
    })(),
  };
}

/**
 * Retrieve element coordinates and info for native CDP interaction.
 * Supports numeric 1-based index or string ref (e.g. "1" or "ref_1").
 */
export function inPageGetElementCoordinates(refOrIndex: number | string): {
  success: boolean;
  notFound?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tagName?: string;
  inputType?: string;
  text?: string;
  value?: string;
  frameOffsetX?: number;
  frameOffsetY?: number;
  attributes?: Record<string, string>;
  isComposer?: boolean;
  isEditor?: boolean;
  isSearch?: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  validity?: { valid: boolean };
  invalidReason?: string;
  checked?: boolean;
  selected?: boolean;
  scopeHash?: string;
  warning?: string;
  isSelectOption?: boolean;
  error?: string;
} {
  const parsed = parseElementIndex(refOrIndex);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid index or ref format: ${refOrIndex}`,
    };
  }
  const index = parsed.numericIndex;

  const el = findIndexedElement(refOrIndex);

  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      notFound: true,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  const details: any = extractElementLocationDetails(el);
  if (el instanceof HTMLOptionElement || el.tagName.toLowerCase() === 'option') {
    details.isSelectOption = true;
  }
  return details;
}

export type ActionableResult = ReturnType<typeof inPageGetElementCoordinates> & {
  actionable: boolean;
  reason?: string;
  stableFrames?: number;
  durationMs?: number;
  method?: 'raf' | 'timer';
};

function getActionableBlockReason(el: Element, action: string): string | null {
  if (!el.isConnected || el.ownerDocument !== document) return 'disconnected';

  const isOption = el instanceof HTMLOptionElement || el.tagName.toLowerCase() === 'option';
  const isHover = action === 'hover' || action === 'mouse_move';
  const isFill = action === 'fill' || action === 'type' || action === 'clear';

  // 1. Disabled (hover allows disabled for tooltips)
  if (!isHover) {
    try {
      if (el.matches?.(':disabled') || (el as any).disabled === true) return 'disabled';
    } catch {
      if ((el as any).disabled === true || el.hasAttribute('disabled')) return 'disabled';
    }
  }

  // 2. Readonly for fill actions
  if (isFill && ((el as any).readOnly === true || el.hasAttribute('readonly'))) {
    return 'readonly';
  }

  // 3. Visibility on target element (descendant can override visible)
  const win = el.ownerDocument?.defaultView || window;
  if (typeof win.getComputedStyle === 'function') {
    try {
      const style = win.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'hidden';
    } catch {}
  }

  // 4. Single composed ancestor pass: inert, aria-disabled, display:none, hidden attribute
  for (let cur: Element | null = el; cur; cur = composedParent(cur)) {
    if ((cur as any).inert === true || cur.hasAttribute('inert')) return 'inert';
    if (!isHover && cur.getAttribute('aria-disabled') === 'true') return 'aria-disabled';
    if ((cur as any).hidden === true || cur.hasAttribute('hidden')) return 'hidden';
    if (typeof win.getComputedStyle === 'function') {
      try {
        if (win.getComputedStyle(cur).display === 'none') return 'hidden';
      } catch {}
    }
  }

  // 5. Zero-size check: any dimension <= 0 is non-actionable (options exempt)
  if (!isOption) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 'hidden';
    const visible = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    let ancestor = composedParent(el);
    while (
      ancestor &&
      ancestor !== el.ownerDocument.body &&
      ancestor !== el.ownerDocument.documentElement
    ) {
      if (typeof win.getComputedStyle === 'function') {
        const style = win.getComputedStyle(ancestor);
        const overflowX = style.overflowX || style.overflow;
        const overflowY = style.overflowY || style.overflow;
        const clipsX = /^(hidden|clip|auto|scroll|overlay)$/.test(overflowX);
        const clipsY = /^(hidden|clip|auto|scroll|overlay)$/.test(overflowY);
        if (clipsX || clipsY) {
          const area = ancestor.getBoundingClientRect();
          const left = area.left + (ancestor.clientLeft || 0);
          const top = area.top + (ancestor.clientTop || 0);
          const right = left + (ancestor.clientWidth || area.width);
          const bottom = top + (ancestor.clientHeight || area.height);
          if (clipsX) {
            visible.left = Math.max(visible.left, left);
            visible.right = Math.min(visible.right, right);
          }
          if (clipsY) {
            visible.top = Math.max(visible.top, top);
            visible.bottom = Math.min(visible.bottom, bottom);
          }
          if (visible.right <= visible.left || visible.bottom <= visible.top) {
            return 'out_of_view';
          }
        }
      }
      ancestor = composedParent(ancestor);
    }
  }

  return null;
}

function waitForNextTick(): Promise<'raf' | 'timer'> {
  return new Promise((resolve) => {
    const isDocHidden = typeof document !== 'undefined' && document.hidden;
    const hasRaf = typeof requestAnimationFrame === 'function';
    if (isDocHidden || !hasRaf) {
      setTimeout(() => resolve('timer'), 16);
      return;
    }
    let settled = false;
    let timerId: any = null;
    const rafId = requestAnimationFrame(() => {
      if (!settled) {
        settled = true;
        if (timerId) clearTimeout(timerId);
        resolve('raf');
      }
    });
    timerId = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
        resolve('timer');
      }
    }, 50);
  });
}

/**
 * Actionability pre-flight and 2-frame geometry stability watchdog.
 * Direct drop-in replacement for inPageGetElementCoordinates on user action paths.
 * Returns spread coordinate metadata on success, and distinguishes notFound: true vs false on errors.
 */
export async function inPageWaitForActionable(
  refOrIndex: number | string,
  action: string = 'click',
  timeoutMs = 1000,
): Promise<ActionableResult> {
  const parsed = parseElementIndex(refOrIndex);
  if (!parsed) {
    return {
      success: false,
      actionable: false,
      notFound: true,
      reason: 'not_found',
      error: `Invalid index: ${refOrIndex}`,
    };
  }
  const index = parsed.numericIndex;
  const entry = getIsolatedIndexMap().get(index);
  const el = entry ? derefElement(entry) : null;

  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      actionable: false,
      notFound: true,
      reason: 'not_found',
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  let blockReason = getActionableBlockReason(el, action);
  if (blockReason) {
    return {
      success: false,
      actionable: false,
      notFound: false,
      reason: blockReason,
      error: `Element [${index}] is not actionable (${blockReason})`,
    };
  }

  // Pre-scroll and initial coordinates resolution
  const initialCoords = inPageGetElementCoordinates(refOrIndex);
  if (!initialCoords?.success) {
    return {
      ...initialCoords,
      actionable: false,
      notFound: Boolean(initialCoords?.notFound),
      error: initialCoords?.error || `Failed to resolve coords for [${index}]`,
    };
  }

  // <option> elements have no separate layout box; delegate to select and bypass stability loop
  const isOption = el instanceof HTMLOptionElement || el.tagName.toLowerCase() === 'option';
  if (isOption) {
    return {
      ...initialCoords,
      success: true,
      actionable: true,
      notFound: false,
    };
  }

  const STABILITY_THRESHOLD = 0.25;
  const startTime = performance.now();
  let prevRect = el.getBoundingClientRect();
  let stableFrames = 0;
  let everUsedTimer = false;

  while (true) {
    const tickMethod = await waitForNextTick();
    if (tickMethod === 'timer') everUsedTimer = true;

    // Re-verify actionable state immediately after tick
    blockReason = getActionableBlockReason(el, action);
    if (blockReason) {
      return {
        ...initialCoords,
        success: false,
        actionable: false,
        notFound: false,
        reason: blockReason,
        error: `Element [${index}] became non-actionable (${blockReason}) during stability wait`,
        durationMs: Math.round(performance.now() - startTime),
        method: everUsedTimer ? 'timer' : 'raf',
      };
    }

    const currRect = el.getBoundingClientRect();
    const dx = Math.abs(currRect.left - prevRect.left);
    const dy = Math.abs(currRect.top - prevRect.top);
    const dw = Math.abs(currRect.width - prevRect.width);
    const dh = Math.abs(currRect.height - prevRect.height);

    if (
      dx <= STABILITY_THRESHOLD &&
      dy <= STABILITY_THRESHOLD &&
      dw <= STABILITY_THRESHOLD &&
      dh <= STABILITY_THRESHOLD
    ) {
      stableFrames++;
      if (stableFrames >= 2) {
        // Final check before success return
        blockReason = getActionableBlockReason(el, action);
        if (blockReason) {
          return {
            ...initialCoords,
            success: false,
            actionable: false,
            notFound: false,
            reason: blockReason,
            error: `Element [${index}] became non-actionable (${blockReason}) during stability wait`,
            durationMs: Math.round(performance.now() - startTime),
            method: everUsedTimer ? 'timer' : 'raf',
          };
        }

        // Compute live safe point & fresh metadata with scrolling disabled
        const finalCoords = extractElementLocationDetails(el, false);
        return {
          ...finalCoords,
          success: true,
          actionable: true,
          notFound: false,
          stableFrames,
          durationMs: Math.round(performance.now() - startTime),
          method: everUsedTimer ? 'timer' : 'raf',
        };
      }
    } else {
      stableFrames = 0;
    }

    prevRect = currRect;

    if (performance.now() - startTime >= timeoutMs) {
      return {
        ...initialCoords,
        success: false,
        actionable: false,
        notFound: false,
        reason: 'unstable',
        error: `Element [${index}] geometry did not stabilize within ${timeoutMs}ms (dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)})`,
        durationMs: Math.round(performance.now() - startTime),
        method: everUsedTimer ? 'timer' : 'raf',
      };
    }
  }
}

/**
 * Bounding box / interactive element auto-snapping.
 * If model eye measurement clicked slightly off-target (e.g. 10-25px outside a dice/button onto whitespace),
 * magnetically snap the coordinate to the closest interactive element.
 */
export function inPageSnapCoordinate(
  x: number,
  y: number,
  snapRadius = 24,
  topLevelViewport = false,
  editableOnly = false,
): {
  snapped: boolean;
  x: number;
  y: number;
  originalX: number;
  originalY: number;
  targetIndex?: number;
  targetTag?: string;
  targetEditable?: boolean;
  frameOffsetX?: number;
  frameOffsetY?: number;
  distance?: number;
} {
  const inputX = Math.round(x);
  const inputY = Math.round(y);
  let frameOffsetX = 0;
  let frameOffsetY = 0;
  if (topLevelViewport) {
    try {
      let curWin: Window = window;
      while (curWin !== curWin.top) {
        const frameEl = curWin.frameElement;
        if (!frameEl) throw new Error('Frame owner unavailable');
        const frameRect = frameEl.getBoundingClientRect();
        const parentWin = curWin.parent || frameEl.ownerDocument?.defaultView || window;
        const frameStyle =
          typeof parentWin.getComputedStyle === 'function'
            ? parentWin.getComputedStyle(frameEl)
            : undefined;
        const borderLeft = parseFloat(frameStyle?.borderLeftWidth || '0') || 0;
        const borderTop = parseFloat(frameStyle?.borderTopWidth || '0') || 0;
        const zoom = parseFloat((frameStyle as any)?.zoom || '1') || 1;
        frameOffsetX += (frameRect.left + borderLeft) / zoom;
        frameOffsetY += (frameRect.top + borderTop) / zoom;
        curWin = curWin.parent;
      }
    } catch {
      return {
        snapped: false,
        x: inputX,
        y: inputY,
        originalX: inputX,
        originalY: inputY,
        targetEditable: false,
      };
    }
  }
  const origX = inputX - Math.round(frameOffsetX);
  const origY = inputY - Math.round(frameOffsetY);
  const toViewportPoint = (localX: number, localY: number) => ({
    x: topLevelViewport ? Math.round(localX + frameOffsetX) : localX,
    y: topLevelViewport ? Math.round(localY + frameOffsetY) : localY,
  });
  const defaultViewportPoint = toViewportPoint(origX, origY);
  const defaultRes = {
    snapped: false,
    ...defaultViewportPoint,
    originalX: inputX,
    originalY: inputY,
    frameOffsetX: Math.round(frameOffsetX),
    frameOffsetY: Math.round(frameOffsetY),
  };

  if (typeof document === 'undefined') return defaultRes;

  const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement?.clientHeight || 800;
  if (origX < 0 || origY < 0 || origX > vw || origY > vh) return defaultRes;

  // 1. Direct hit test at (origX, origY) with deep Shadow DOM penetration
  let hitEl: Element | null = null;
  try {
    hitEl = deepElementFromPoint(origX, origY);
  } catch {}

  const findEditableElement = (start: Element | null): Element | null => {
    let current = start;
    while (current && current !== document.body && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const inputType = ((current as HTMLInputElement).type || '').toLowerCase();
      const nonTextInput =
        /^(button|submit|reset|checkbox|radio|hidden|image|file|range|color)$/.test(inputType);
      if (
        (tag === 'input' && !nonTextInput) ||
        tag === 'textarea' ||
        tag === 'select' ||
        (current as HTMLElement).isContentEditable ||
        current.getAttribute('contenteditable') === 'true' ||
        current.getAttribute('contenteditable') === ''
      ) {
        return current;
      }
      current = composedParent(current);
    }
    return null;
  };

  const directEditable = editableOnly ? findEditableElement(hitEl) : null;
  if (directEditable) {
    let targetIndex: number | undefined;
    for (const [idx, wrapped] of getIsolatedIndexMap().entries()) {
      if (derefElement(wrapped) === directEditable) {
        targetIndex = idx;
        break;
      }
    }
    if (targetIndex === undefined) targetIndex = indexElement(directEditable);
    return {
      ...defaultRes,
      targetIndex,
      targetTag: directEditable.tagName.toLowerCase(),
      targetEditable: true,
    };
  }
  if (editableOnly) {
    return { ...defaultRes, targetEditable: false };
  }

  const isInteractiveNode = (el: Element | null): boolean => {
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return false;
    const tag = el.tagName.toLowerCase();
    if (/^(button|input|select|textarea|a|canvas|video|audio|summary)$/.test(tag)) return true;
    const role = el.getAttribute('role')?.toLowerCase();
    if (
      role &&
      /^(button|link|checkbox|radio|menuitem|tab|switch|option|combobox|treeitem)$/.test(role)
    )
      return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('data-action') || (el as any).onclick)
      return true;
    const tabIndex =
      typeof (el as HTMLElement).tabIndex === 'number' ? (el as HTMLElement).tabIndex : -1;
    if (tabIndex >= 0) return true;
    if (tag === 'svg' || (el as any).ownerSVGElement) {
      const svgRoot = tag === 'svg' ? el : (el as any).ownerSVGElement;
      if (svgRoot && (svgRoot.hasAttribute('onclick') || svgRoot.getAttribute('role') === 'button'))
        return true;
    }
    if (typeof (el as any).closest === 'function') {
      try {
        if ((el as any).closest('button, a, [role="button"], [onclick]')) return true;
      } catch {}
    }
    try {
      const style = window.getComputedStyle(el);
      if (style.cursor === 'pointer' || /grab|grabbing/i.test(style.cursor)) return true;
    } catch {}
    if (isCustomElement(el) && (el.hasAttribute('aria-label') || el.hasAttribute('title'))) {
      return true;
    }
    return false;
  };

  // If already directly hitting an interactive element or inside one, no snap needed
  let cur: Element | null = hitEl;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (isInteractiveNode(cur)) {
      let targetIndex: number | undefined;
      for (const [idx, wrapped] of getIsolatedIndexMap().entries()) {
        if (derefElement(wrapped) === cur) {
          targetIndex = idx;
          break;
        }
      }
      if (targetIndex === undefined) targetIndex = indexElement(cur);
      return {
        ...defaultRes,
        targetIndex,
        targetTag: cur.tagName.toLowerCase(),
        targetEditable: Boolean(findEditableElement(cur)),
      };
    }
    cur = composedParent(cur);
  }

  // 2. Search candidate elements in isolatedIndexMap within snapRadius
  const isolatedMap = getIsolatedIndexMap();
  let bestEl: Element | null = null;
  let bestDist = Infinity;
  let bestIndex: number | undefined;
  let bestRect: DOMRect | undefined;

  for (const [idx, wrapped] of isolatedMap.entries()) {
    const el = derefElement(wrapped);
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) continue;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // Clamped point in rect closest to (origX, origY)
      const cx = Math.max(rect.left, Math.min(rect.right, origX));
      const cy = Math.max(rect.top, Math.min(rect.bottom, origY));
      const dist = Math.hypot(origX - cx, origY - cy);
      if (dist < bestDist && dist <= snapRadius) {
        bestDist = dist;
        bestEl = el;
        bestIndex = idx;
        bestRect = rect;
      }
    } catch {}
  }

  // 3. Fallback: Radial search if isolatedIndexMap had no candidates (penetrates Shadow DOM)
  if (!bestEl) {
    const searchDistances = [8, 16, snapRadius];
    const angles = [0, 45, 90, 135, 180, 225, 270, 315];
    for (const r of searchDistances) {
      if (bestEl) break;
      for (const a of angles) {
        const rad = (a * Math.PI) / 180;
        const px = Math.round(origX + r * Math.cos(rad));
        const py = Math.round(origY + r * Math.sin(rad));
        if (px < 0 || py < 0 || px > vw || py > vh) continue;
        try {
          const sampleEl = deepElementFromPoint(px, py);
          let candidate: Element | null = sampleEl;
          while (
            candidate &&
            candidate !== document.body &&
            candidate !== document.documentElement
          ) {
            if (isInteractiveNode(candidate)) {
              const b = candidate.getBoundingClientRect();
              const cx = Math.max(b.left, Math.min(b.right, origX));
              const cy = Math.max(b.top, Math.min(b.bottom, origY));
              const d = Math.hypot(origX - cx, origY - cy);
              if (d <= snapRadius) {
                bestDist = d;
                bestEl = candidate;
                bestRect = b;
                break;
              }
            }
            candidate = composedParent(candidate);
          }
        } catch {}
      }
    }
  }

  // 4. Final deep query search for closest interactive Shadow DOM elements if still unhit
  if (!bestEl && typeof document !== 'undefined') {
    try {
      const candidates = querySelectorAllDeep(
        'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [aria-label], [data-action]',
        document,
      );
      for (const candEl of candidates) {
        if (!candEl || !(candEl instanceof Element)) continue;
        const b = candEl.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) continue;
        const cx = Math.max(b.left, Math.min(b.right, origX));
        const cy = Math.max(b.top, Math.min(b.bottom, origY));
        const d = Math.hypot(origX - cx, origY - cy);
        if (d < bestDist && d <= snapRadius) {
          bestDist = d;
          bestEl = candEl;
          bestRect = b;
        }
      }
    } catch {}
  }

  if (bestEl && bestRect) {
    // Bring element into comfortable viewport view if scrolled outside or clipped
    try {
      const curVh = window.innerHeight || 800;
      const curVw = window.innerWidth || 1280;
      if (
        bestRect.top < 0 ||
        bestRect.bottom > curVh ||
        bestRect.left < 0 ||
        bestRect.right > curVw
      ) {
        if (typeof (bestEl as any).scrollIntoView === 'function') {
          (bestEl as any).scrollIntoView({
            block: 'center',
            inline: 'center',
            behavior: 'instant',
          });
          bestRect = bestEl.getBoundingClientRect();
        }
      }
    } catch {}

    // For small/medium elements (<= 120px in width/height), snap to geometric center.
    // For large elements (> 120px), clamp within the element with a safe margin to avoid jumping hundreds of pixels.
    const isSmallOrMedium = bestRect.width <= 120 && bestRect.height <= 120;
    let safeX: number;
    let safeY: number;

    if (isSmallOrMedium) {
      safeX = Math.round((bestRect.left + bestRect.right) / 2);
      safeY = Math.round((bestRect.top + bestRect.bottom) / 2);
    } else {
      const marginX = Math.min(12, Math.floor(bestRect.width * 0.1));
      const marginY = Math.min(12, Math.floor(bestRect.height * 0.1));
      safeX = Math.round(
        Math.max(bestRect.left + marginX, Math.min(bestRect.right - marginX, origX)),
      );
      safeY = Math.round(
        Math.max(bestRect.top + marginY, Math.min(bestRect.bottom - marginY, origY)),
      );
    }
    const viewportPoint = toViewportPoint(safeX, safeY);
    return {
      snapped: true,
      ...viewportPoint,
      originalX: inputX,
      originalY: inputY,
      targetIndex: bestIndex,
      targetTag: bestEl.tagName.toLowerCase(),
      targetEditable: Boolean(findEditableElement(bestEl)),
      frameOffsetX: Math.round(frameOffsetX),
      frameOffsetY: Math.round(frameOffsetY),
      distance: Math.round(bestDist),
    };
  }

  return defaultRes;
}

/**
 * Post-dispatch delivery verification for CDP Input events.
 *
 * Chrome throttles CDP input to occluded/hidden tabs: the command acks
 * successfully but the renderer never records the event (TESTING-NOTES #27),
 * producing phantom successes. document.elementFromPoint cannot detect this -
 * layout is computed on demand even in hidden tabs - so verification uses
 * one-shot capture listeners armed BEFORE dispatch: if no trusted event
 * arrives, the input never reached the renderer.
 */
// Returns a marker because executeInPage's retrieve protocol throws on
// undefined returns (its undefined sentinel means 'entrypoint vanished').
export function inPageArmDeliveryProbe(events: string[]): { armed: true } {
  const g = globalThis as any;
  const prev = g.__MCP_DELIVERY_PROBE__;
  if (prev && typeof prev.remove === 'function') {
    try {
      prev.remove();
    } catch {}
  }
  const probe: any = { events, hits: [], armed: true, remove: () => {} };
  const listener = (e: Event) => {
    if (!probe.armed) return;
    probe.hits.push({
      type: e.type,
      isTrusted: (e as any).isTrusted === true,
      target: (e.target as Element | null | undefined)?.tagName?.toLowerCase?.(),
    });
    if (probe.hits.length > 8) probe.hits.shift();
  };
  probe.remove = () => {
    for (const t of events) {
      document.removeEventListener(t, listener, true);
    }
  };
  for (const t of events) {
    document.addEventListener(t, listener, true);
  }
  g.__MCP_DELIVERY_PROBE__ = probe;
  return { armed: true };
}

export function inPageReadDeliveryProbe(disarm?: boolean): {
  delivered: boolean;
  hits: any[];
  missing?: boolean;
} {
  const probe = (globalThis as any).__MCP_DELIVERY_PROBE__;
  if (!probe) return { delivered: false, hits: [], missing: true };
  const hits = probe.hits.slice();
  if (disarm !== false) {
    probe.armed = false;
    try {
      probe.remove();
    } catch {}
  }
  return { delivered: hits.length > 0, hits };
}

import {
  inPageLocateBySelector,
  getLocatorAccessibleName,
  inPageLocateByLabel,
  inPageLocateByRole,
  inPageLocateByText,
  getAriaLabelledByText,
  getNativeLabelText,
  type LocateByLabelOptions,
  type LocateByRoleOptions,
  type LocateByTextOptions,
} from './dom-indexer/locators';

export {
  inPageLocateBySelector,
  getLocatorAccessibleName,
  inPageLocateByLabel,
  inPageLocateByRole,
  inPageLocateByText,
  getAriaLabelledByText,
  getNativeLabelText,
  type LocateByLabelOptions,
  type LocateByRoleOptions,
  type LocateByTextOptions,
};
export function inPageGetFrameOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return '';
  }
}

/**
 * Retrieve element crop rectangle (viewport-relative) with optional padding for region-of-interest screenshot.
 * Optionally expands small elements (< 100x100) to a contextual bounding box (Midscene-inspired expandSearchArea).
 */
export function inPageGetIndexCropRect(
  index: number,
  padding: number = 0,
  autoExpand: boolean = false,
): {
  success: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  devicePixelRatio?: number;
  error?: string;
} {
  if (index <= 0) {
    return {
      success: false,
      error: `Index must be a positive 1-based integer. Received: ${index}`,
    };
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  const rawRect = el.getBoundingClientRect();

  let frameOffsetX = 0;
  let frameOffsetY = 0;
  try {
    let curWin: Window = window;
    while (curWin !== curWin.top) {
      if (curWin.frameElement) {
        const fEl = curWin.frameElement;
        const fRect = fEl.getBoundingClientRect();
        const parentWin = curWin.parent || fEl.ownerDocument?.defaultView || window;
        const fStyle =
          typeof parentWin.getComputedStyle === 'function'
            ? parentWin.getComputedStyle(fEl)
            : undefined;
        const borderLeft = parseFloat(fStyle?.borderLeftWidth || '0') || 0;
        const borderTop = parseFloat(fStyle?.borderTopWidth || '0') || 0;
        const zoom = parseFloat((fStyle as any)?.zoom || '1') || 1;

        frameOffsetX += (fRect.left + borderLeft) / zoom;
        frameOffsetY += (fRect.top + borderTop) / zoom;
        curWin = curWin.parent;
      } else {
        break;
      }
    }
  } catch {}

  // Micro-element adaptive expansion (Midscene-inspired expandSearchArea)
  // For small elements (< 100x100), expand to retain surrounding table headers, labels, and context
  let effectivePadding = Math.max(0, padding);
  if (autoExpand && (rawRect.width < 100 || rawRect.height < 100)) {
    // Expand by at least 100px on each side (or expand to at least 200x200)
    const minBoundingSize = 200;
    const neededPadX = Math.max(0, Math.round((minBoundingSize - rawRect.width) / 2));
    const neededPadY = Math.max(0, Math.round((minBoundingSize - rawRect.height) / 2));
    effectivePadding = Math.max(effectivePadding, Math.max(100, Math.max(neededPadX, neededPadY)));
  }

  const left = Math.max(0, Math.round(rawRect.left + frameOffsetX - effectivePadding));
  const top = Math.max(0, Math.round(rawRect.top + frameOffsetY - effectivePadding));
  const maxW =
    typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0
      ? Math.max(1, window.innerWidth - left)
      : undefined;
  const maxH =
    typeof window !== 'undefined' &&
    typeof window.innerHeight === 'number' &&
    window.innerHeight > 0
      ? Math.max(1, window.innerHeight - top)
      : undefined;
  const rawWidth = Math.round(rawRect.width + effectivePadding * 2);
  const rawHeight = Math.round(rawRect.height + effectivePadding * 2);
  const width = Math.max(1, maxW !== undefined ? Math.min(rawWidth, maxW) : rawWidth);
  const height = Math.max(1, maxH !== undefined ? Math.min(rawHeight, maxH) : rawHeight);

  return {
    success: true,
    rect: { x: left, y: top, width, height },
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

/**
 * One-shot pointer-move delivery for CDP-synthetic pointer drags: CDP routes
 * mouseMoved by hit-testing and page-side setPointerCapture does not stick
 * under synthetic presses, so narrow targets (resize handles, sliders) miss
 * every move once the cursor leaves their few-pixel hit area. Deliver the
 * final pointermove straight to the element under the press point carrying
 * the real end coordinates, so its onPointerMove sees the true final position.
 */
export function inPagePointerDragMove(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): { success: boolean; tag?: string; error?: string } {
  try {
    const el = document.elementFromPoint(fromX, fromY);
    if (!el) {
      return { success: false, error: `No element at point (${fromX}, ${fromY})` };
    }
    el.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: toX,
        clientY: toY,
        button: -1,
        buttons: 1,
      }),
    );
    return {
      success: true,
      tag: el.id || el.tagName.toLowerCase(),
    };
  } catch (err) {
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Perform fallback in-page interaction by 1-based index inside active tab.
 */
/**
 * Focus an indexed element without firing click handlers.
 * chrome_keyboard previously used inPageInteractIndex(index, 'click'), which both
 * fired the element's click handlers as a side effect and never actually moved
 * focus for non-focusable nodes — so subsequent key events landed on whatever
 * document.activeElement already was. This focuses first, then falls back to a
 * click only for elements that cannot take focus directly.
 */
export function inPageFocusIndex(index: number): {
  success: boolean;
  index: number;
  tagName?: string;
  focused?: boolean;
  error?: string;
} {
  if (index <= 0) {
    return {
      success: false,
      index,
      error: `Index must be a positive 1-based integer. Received: ${index}`,
    };
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      index,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  const htmlEl = el as HTMLElement;
  let focused = false;
  try {
    if (typeof htmlEl.focus === 'function') {
      htmlEl.focus({ preventScroll: true });
      focused = composedContains(el, getDeepActiveElement());
    }
  } catch {}

  // Non-focusable containers (plain div/li/canvas): make them programmatically
  // focusable for this session so keyboard events target the intended node.
  if (!focused && !el.hasAttribute('tabindex')) {
    try {
      el.setAttribute('tabindex', '-1');
      htmlEl.focus({ preventScroll: true });
      focused = composedContains(el, getDeepActiveElement());
    } catch {}
  }

  return {
    success: true,
    index,
    tagName: el.tagName.toLowerCase(),
    focused,
  };
}

export function inPageInteractIndex(
  index: number,
  action: 'click' | 'hover' | 'double_click' | 'right_click' = 'click',
): { success: boolean; index: number; tagName?: string; text?: string; error?: string } {
  if (index <= 0) {
    return {
      success: false,
      index,
      error: `Index must be a positive 1-based integer. Received: ${index}`,
    };
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      index,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  const text = ((el as HTMLElement).innerText || el.textContent || '').trim().slice(0, 100);

  if (action === 'click') {
    // Task B4: Direct single-step selection for HTMLOptionElement
    if (el instanceof HTMLOptionElement || el.tagName.toLowerCase() === 'option') {
      const opt = el as HTMLOptionElement;
      const select = (
        opt.parentElement instanceof HTMLSelectElement ? opt.parentElement : opt.closest?.('select')
      ) as HTMLSelectElement | null;
      if (select) {
        select.value = opt.value;
        opt.selected = true;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          success: true,
          index,
          tagName: 'option',
          text: opt.label || opt.text || opt.value,
        };
      }
    }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    (el as HTMLElement).click?.();
  } else if (action === 'double_click') {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    (el as HTMLElement).click?.();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    (el as HTMLElement).click?.();
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  } else if (action === 'right_click') {
    const rawRect = el.getBoundingClientRect();
    const cx = Math.round(rawRect.left + rawRect.width / 2);
    const cy = Math.round(rawRect.top + rawRect.height / 2);
    const mouseOpts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: cx,
      clientY: cy,
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...mouseOpts, pointerType: 'mouse' }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    try {
      el.dispatchEvent(
        new PointerEvent('pointerup', { ...mouseOpts, buttons: 0, pointerType: 'mouse' }),
      );
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseup', { ...mouseOpts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('contextmenu', mouseOpts));
  } else if (action === 'hover') {
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
  }

  return {
    success: true,
    index,
    tagName: el.tagName.toLowerCase(),
    text,
  };
}

function resolveEditableTextTarget(el: Element): HTMLElement | null {
  if (el instanceof HTMLInputElement) {
    const type = (el.type || 'text').toLowerCase();
    if (/^(text|search|email|url|tel|password|number)$/.test(type)) return el;
    return null;
  }
  if (el instanceof HTMLTextAreaElement) return el;
  const ownEditable =
    (el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === '';
  if (ownEditable) return el as HTMLElement;
  return (
    (el.querySelector?.('[contenteditable="true"], [contenteditable=""]') as HTMLElement) || null
  );
}

function readEditableTextValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || '';
  const target = resolveEditableTextTarget(el);
  if (!target) return '';
  return String(target.innerText ?? target.textContent ?? '');
}

/**
 * Focus the editable target, place its caret at the true end, and return the
 * pre-append value used by commitment verification.
 */
export function inPagePrepareAppend(refOrIndex: number | string): {
  success: boolean;
  currentValue: string;
  tagName?: string;
  error?: string;
} {
  const parsed = parseElementIndex(refOrIndex);
  if (!parsed) return { success: false, currentValue: '', error: 'Invalid index or ref format' };
  const index = parsed.numericIndex;
  const el = findIndexedElement(refOrIndex);
  if (!el || !(el instanceof Element)) {
    return { success: false, currentValue: '', error: `Element with index [${index}] not found` };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  const editTarget = resolveEditableTextTarget(el);
  if (!editTarget) {
    return {
      success: false,
      currentValue: '',
      tagName: el.tagName.toLowerCase(),
      error: `Element [${index}] is not a text-editable control`,
    };
  }

  try {
    editTarget.focus({ preventScroll: true });
  } catch {
    try {
      editTarget.focus();
    } catch {}
  }

  if (editTarget instanceof HTMLInputElement || editTarget instanceof HTMLTextAreaElement) {
    try {
      editTarget.setSelectionRange(editTarget.value.length, editTarget.value.length);
    } catch {}
  } else {
    const doc = editTarget.ownerDocument || document;
    const selection = doc.defaultView?.getSelection?.() || null;
    if (selection && typeof doc.createRange === 'function') {
      const range = doc.createRange();
      range.selectNodeContents(editTarget);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  return {
    success: true,
    currentValue: readEditableTextValue(el),
    tagName: el.tagName.toLowerCase(),
  };
}

/**
 * Fill input or textarea by 1-based index inside active tab.
 */
export function inPageFillIndex(
  refOrIndex: number | string,
  textToFill: string,
  clear = true,
  pressEnter = false,
): {
  success: boolean;
  committed?: boolean;
  index: number;
  tagName?: string;
  filledText?: string;
  submitButtonState?: { found: boolean; disabled?: boolean; text?: string };
  pressEnterDispatched?: boolean;
  diagnostics?: string;
  error?: string;
} {
  const parsed = parseElementIndex(refOrIndex);
  if (!parsed) {
    return {
      success: false,
      index: 0,
      error: `Invalid index or ref format: `,
    };
  }
  const index = parsed.numericIndex;

  const el = findIndexedElement(refOrIndex);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      index,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  if (typeof (el as HTMLElement).focus === 'function') {
    (el as HTMLElement).focus();
  }

  let expectedAfterFill = textToFill;
  if (!clear && resolveEditableTextTarget(el)) {
    const prepared = inPagePrepareAppend(refOrIndex);
    if (!prepared.success) {
      return {
        success: false,
        index,
        error: prepared.error || `Cannot prepare element [${index}] for append`,
      };
    }
    expectedAfterFill = `${prepared.currentValue}${textToFill}`;
  }

  const getNativeSetter = (element: any, prop: string) => {
    let proto = Object.getPrototypeOf(element);
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc?.set) return desc.set;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  };

  const nativeInputValueSetter = getNativeSetter(el, 'value');
  const nativeCheckboxSetter = getNativeSetter(el, 'checked');
  const nativeTextAreaValueSetter = nativeInputValueSetter;

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const isTruthy =
      textToFill === 'true' ||
      textToFill === '1' ||
      textToFill === 'checked' ||
      textToFill === 'on' ||
      (textToFill !== 'false' && textToFill !== '0' && textToFill !== 'off' && Boolean(textToFill));
    if (nativeCheckboxSetter) {
      nativeCheckboxSetter.call(el, isTruthy);
    } else {
      el.checked = isTruthy;
    }
  } else if (el instanceof HTMLInputElement && nativeInputValueSetter) {
    nativeInputValueSetter.call(el, clear ? textToFill : `${el.value || ''}${textToFill}`);
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {}
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: textToFill,
        }),
      );
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } else if (el instanceof HTMLTextAreaElement && nativeTextAreaValueSetter) {
    nativeTextAreaValueSetter.call(el, clear ? textToFill : `${el.value || ''}${textToFill}`);
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {}
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: textToFill,
        }),
      );
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } else if (el instanceof HTMLSelectElement) {
    let matched = false;
    for (const opt of Array.from(el.options)) {
      if (
        opt.value === textToFill ||
        opt.text === textToFill ||
        opt.text.trim() === textToFill.trim()
      ) {
        el.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) el.value = textToFill;
  } else if (
    el.getAttribute('role') === 'combobox' ||
    el.getAttribute('role') === 'listbox' ||
    el.getAttribute('aria-haspopup') === 'listbox'
  ) {
    try {
      void inPageSelectCustomCombobox(index, undefined, textToFill);
    } catch {}
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value = clear ? textToFill : `${el.value || ''}${textToFill}`;
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {}
  } else if (
    (el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === '' ||
    Boolean(el.querySelector?.('[contenteditable="true"]'))
  ) {
    const editTarget =
      (el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true'
        ? (el as HTMLElement)
        : (el.querySelector?.('[contenteditable="true"]') as HTMLElement) || (el as HTMLElement);

    if (clear) {
      const sel = window.getSelection();
      if (sel && typeof document.createRange === 'function') {
        try {
          const range = document.createRange();
          range.selectNodeContents(editTarget);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false);
        } catch {}
      }
      editTarget.innerText = '';
    }
    const lines = textToFill ? textToFill.split(/\r?\n/) : [];
    if (lines.length > 1) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) {
          const beforeLine = String(editTarget.innerText ?? editTarget.textContent ?? '');
          let insertedLine = false;
          try {
            insertedLine = document.execCommand('insertText', false, lines[i]);
          } catch {}
          const afterLine = String(editTarget.innerText ?? editTarget.textContent ?? '');
          if (
            !insertedLine &&
            (!clear || afterLine === beforeLine) &&
            typeof editTarget.appendChild === 'function'
          ) {
            editTarget.appendChild(document.createTextNode(lines[i]));
          }
        }
        if (i < lines.length - 1) {
          const beforeBreak = String(editTarget.innerText ?? editTarget.textContent ?? '');
          let paraInserted = false;
          try {
            paraInserted = document.execCommand('insertParagraph', false);
          } catch {}
          if (!paraInserted) {
            try {
              paraInserted = document.execCommand('insertLineBreak', false);
            } catch {}
          }
          const afterBreak = String(editTarget.innerText ?? editTarget.textContent ?? '');
          if (
            !paraInserted &&
            afterBreak === beforeBreak &&
            typeof editTarget.appendChild === 'function'
          ) {
            editTarget.appendChild(document.createElement('br'));
          }
          try {
            editTarget.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                composed: true,
              }),
            );
            editTarget.dispatchEvent(
              new KeyboardEvent('keyup', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                composed: true,
              }),
            );
          } catch {}
        }
      }
    } else {
      const beforeText = String(editTarget.innerText ?? editTarget.textContent ?? '');
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, textToFill);
      } catch {}
      if (!inserted) {
        const afterText = String(editTarget.innerText ?? editTarget.textContent ?? '');
        if (clear) {
          editTarget.innerText = textToFill;
        } else if (afterText === beforeText && typeof editTarget.appendChild === 'function') {
          editTarget.appendChild(document.createTextNode(textToFill));
        }
      }
    }
    try {
      editTarget.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: textToFill,
        }),
      );
    } catch {
      editTarget.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    editTarget.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } else {
    (el as any).value = textToFill;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  if (pressEnter) {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        composed: true,
      }),
    );
    el.dispatchEvent(
      new KeyboardEvent('keypress', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        composed: true,
      }),
    );
    el.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        composed: true,
      }),
    );
  }

  const verification: any = textToFill
    ? inPageVerifyInputCommitment(index, expectedAfterFill)
    : { committed: true };

  return {
    success: verification.committed,
    committed: verification.committed,
    index,
    tagName: el.tagName.toLowerCase(),
    filledText: textToFill,
    ...(verification.submitButtonState
      ? { submitButtonState: verification.submitButtonState }
      : {}),
    ...(pressEnter ? { pressEnterDispatched: true } : {}),
    ...(verification.diagnostics ? { diagnostics: verification.diagnostics } : {}),
  };
}

export { inPageWaitForDOMSettle } from '@/utils/action-watchdog';

import {
  cleanAndNormalizeText,
  inPageVerifyActiveElement,
  inPageGetActiveElementSummary,
  inPageSelectCustomCombobox,
  inPageVerifyInputCommitment,
} from './dom-indexer/input-commitment';

export {
  cleanAndNormalizeText,
  inPageVerifyActiveElement,
  inPageGetActiveElementSummary,
  inPageSelectCustomCombobox,
  inPageVerifyInputCommitment,
};
export {
  inPageDetectPerceptiveSignature,
  inPageQueryChoiceCandidates,
  computePerceptiveDelta,
  type PerceptiveSignature,
  type ChoiceCandidateItem,
} from './dom-indexer/perceptive-signature';
export {
  inPageExtractMarkdown,
  type SemanticMarkdownOptions,
  type SemanticMarkdownResult,
} from './dom-indexer/semantic-markdown';
export {
  inPageExtractDropdownOptions,
  type DropdownOptionItem,
  type DropdownOptionsResult,
} from './dom-indexer/dropdown-options';
import {
  inPageFindSmartScrollTarget,
  inPagePerformSmartScroll,
  type SmartScrollTargetInfo,
} from './dom-indexer/smart-scroll';

export { inPageFindSmartScrollTarget, inPagePerformSmartScroll, type SmartScrollTargetInfo };
export {
  inPageGetAssetImage,
  inPageGetLinks,
  inPageCheckInterception,
  inPageDispatchSyntheticClick,
} from './dom-indexer/inpage-probes';
export {
  inPageDetectConfirmationTrap,
  type ConfirmationTrapInfo,
} from './dom-indexer/confirmation-trap';
import { renderCompactElementLine } from './dom-indexer/compact-renderer';

export { renderCompactElementLine };

export { inPageCheckCaptcha, type CaptchaDetectionResult } from './dom-indexer/captcha';
export {
  inPageInsertMedia,
  type InsertMediaOptions,
  type InsertMediaResult,
} from './dom-indexer/media';
export {
  inPageGetScrollState,
  inPageInstantScrollTo,
  inPageLockScroll,
  inPageExtractDeepPageText,
} from './dom-indexer/scroll-state';
export {
  inPageDismissOverlays,
  type DismissedOverlayInfo,
  type DismissOverlaysResult,
} from './dom-indexer/dismiss-overlays';
