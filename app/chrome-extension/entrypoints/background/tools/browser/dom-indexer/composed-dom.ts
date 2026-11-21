/**
 * Composed-tree DOM primitives shared across perception, extraction, scrolling,
 * occlusion, and locator pipelines.
 *
 * Leaf module with zero imports from sibling indexer files to avoid circular
 * initialization issues inside the bundled in-page engine.
 */

const NON_CONTENT_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'meta',
  'link',
  'title',
]);

const STANDARD_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tr',
  'ul',
]);

const BLOCK_DISPLAY_VALUES = new Set([
  'block',
  'flex',
  'grid',
  'list-item',
  'table',
  'table-row',
  'table-caption',
  'flow-root',
]);

const INLINE_DISPLAY_VALUES = new Set([
  'inline',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'inline-table',
  'contents',
]);

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

/**
 * Check if a node is an autonomous or customized Web Component custom element.
 */
export function isCustomElement(node: Node | null | undefined): boolean {
  if (!node || (typeof Element !== 'undefined' && !(node instanceof Element))) return false;
  const tag = ((node as Element).tagName || '').toLowerCase();
  return tag.includes('-') || Boolean((node as Element).getAttribute?.('is'));
}

/**
 * Resolve parent element in the flat/composed tree, crossing <slot> projections
 * and open/closed ShadowRoot host boundaries.
 */
export function composedParent(element: Element | null): Element | null {
  if (!element) return null;
  if ((element as any).assignedSlot) return (element as any).assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode ? element.getRootNode() : null;
  if (root && root.nodeType === 11 && (root as ShadowRoot).host) {
    return (root as ShadowRoot).host as Element;
  }
  const parentNode = element.parentNode;
  if (parentNode && parentNode.nodeType === 11 && (parentNode as ShadowRoot).host) {
    return (parentNode as ShadowRoot).host as Element;
  }
  return null;
}

/**
 * Resolve direct element children in the flat/composed tree.
 * - For <slot>: returns flattened assigned elements when present, else fallback children.
 * - For a shadow host: returns shadow root children.
 * - Otherwise: returns light-DOM element children.
 */
export function composedChildren(element: Element): Element[] {
  if (!element) return [];
  if (element.tagName.toUpperCase() === 'SLOT') {
    try {
      const slot = element as HTMLSlotElement;
      const assignedNodes =
        typeof slot.assignedNodes === 'function' ? slot.assignedNodes({ flatten: true }) : null;
      if (assignedNodes && assignedNodes.length > 0) {
        return typeof slot.assignedElements === 'function'
          ? slot.assignedElements({ flatten: true })
          : (assignedNodes.filter((n) => n.nodeType === 1) as Element[]);
      }
    } catch {}
    return Array.from(element.children || []) as Element[];
  }
  const container = getShadowRoot(element) || element;
  return Array.from(container.children || []) as Element[];
}

/**
 * Resolve direct child nodes (elements + text) in the flat/composed tree.
 */
export function composedChildNodes(node: Node): Node[] {
  if (!node) return [];
  if (node.nodeType === 1) {
    const el = node as Element;
    if (el.tagName.toUpperCase() === 'SLOT') {
      try {
        const assigned = (el as HTMLSlotElement).assignedNodes?.({ flatten: true }) || [];
        if (assigned.length > 0) return assigned;
      } catch {}
      return Array.from(el.childNodes || []);
    }
    const shadow = getShadowRoot(el);
    if (shadow) return Array.from(shadow.childNodes || []);
  }
  return Array.from(node.childNodes || []);
}

/**
 * Resolve the nearest containing Element for any Node (including Text nodes
 * directly mounted under a ShadowRoot or slotted into a <slot>).
 */
export function composedContainingElement(node: Node | null): Element | null {
  if (!node) return null;
  if (typeof Element !== 'undefined' && node instanceof Element) return node;
  if ((node as any).assignedSlot) return (node as any).assignedSlot as Element;
  if ((node as any).parentElement) return (node as any).parentElement as Element;
  const parent = node.parentNode;
  if (parent) {
    if (typeof Element !== 'undefined' && parent instanceof Element) return parent;
    if (parent.nodeType === 11 && (parent as ShadowRoot).host) {
      return (parent as ShadowRoot).host as Element;
    }
  }
  return null;
}

/**
 * Checks whether an ancestor node contains a descendant across open/closed
 * ShadowRoot and <slot> boundaries.
 */
export function composedContains(ancestor: Node | null, descendant: Node | null): boolean {
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  if (descendant.parentNode === ancestor) return true;
  let cur: Element | null = composedContainingElement(descendant);
  const seen = new Set<Element>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = composedParent(cur);
  }
  return false;
}

/**
 * Shadow- and slot-piercing equivalent of Element.prototype.closest().
 */
export function composedClosest(element: Element | null, selector: string): Element | null {
  if (!element || !selector) return null;
  let cur: Element | null = element;
  const seen = new Set<Element>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    try {
      if (typeof cur.matches === 'function' && cur.matches(selector)) {
        return cur;
      }
    } catch {}
    cur = composedParent(cur);
  }
  return null;
}

/**
 * Check whether an element or any of its composed ancestors hides it from layout/assistive perception.
 * Respects CSS visibility inheritance semantics: only the element's own computed `visibility`
 * determines hidden/collapse (since a descendant can override `visibility: visible`), whereas
 * `display: none`, `opacity <= 0`, `[hidden]`, `[inert]`, and `aria-hidden="true"` propagate down.
 */
export function isElementHiddenInComposedTree(
  el: Element | null,
  win?: Window | null,
  options?: { checkAriaHidden?: boolean; checkOpacity?: boolean },
): boolean {
  if (!el) return true;
  const view =
    win || el.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
  const checkAriaHidden = options?.checkAriaHidden !== false;
  const checkOpacity = options?.checkOpacity !== false;

  if (view && typeof view.getComputedStyle === 'function') {
    try {
      const ownStyle = view.getComputedStyle(el);
      if (ownStyle.visibility === 'hidden' || ownStyle.visibility === 'collapse') {
        return true;
      }
    } catch {}
  }

  let cur: Element | null = el;
  const seen = new Set<Element>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (
      (cur as HTMLElement).hidden === true ||
      cur.hasAttribute?.('hidden') ||
      (cur as any).inert === true ||
      cur.hasAttribute?.('inert') ||
      (checkAriaHidden && cur.getAttribute?.('aria-hidden') === 'true')
    ) {
      return true;
    }
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const style = view.getComputedStyle(cur);
        if (style.display === 'none') return true;
        if (checkOpacity && style.opacity !== '' && Number.parseFloat(style.opacity) <= 0) {
          return true;
        }
      } catch {}
    }
    cur = composedParent(cur);
  }
  return false;
}

/**
 * Returns true if the element creates a visual block boundary (standard block HTML tags,
 * block/flex/grid/list-item CSS display, or non-inline custom elements).
 */
export function isBlockLikeElement(
  el: Element,
  win?: Window | null,
  precomputedStyle?: CSSStyleDeclaration | null,
): boolean {
  const tag = (el.tagName || '').toLowerCase();
  if (STANDARD_BLOCK_TAGS.has(tag)) return true;
  const view =
    win || el.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
  let display = (precomputedStyle?.display || '').toLowerCase();
  if (!display && view && typeof view.getComputedStyle === 'function') {
    try {
      display = (view.getComputedStyle(el).display || '').toLowerCase();
    } catch {}
  }
  if (BLOCK_DISPLAY_VALUES.has(display)) return true;
  if (isCustomElement(el) && !INLINE_DISPLAY_VALUES.has(display)) {
    return true;
  }
  return false;
}

export interface ComposedVisibleTextOptions {
  maxLen?: number;
  includeSvgTitle?: boolean;
  includeHidden?: boolean;
  skipAriaHidden?: boolean;
  stripPua?: boolean;
  /**
   * When true and a shadow root contains no <slot> elements, also inspect unvisited
   * light-DOM children so semantic light-DOM fallbacks in slotless hosts are not lost.
   */
  fallbackLightDomWithoutSlot?: boolean;
}

/**
 * Extract clean visible text from a subtree across Shadow DOM and <slot> boundaries.
 * Never leaks <style>, <script>, <noscript>, <template>, or hidden descendant text.
 */
export function extractComposedVisibleText(
  root: Node | null | undefined,
  options: ComposedVisibleTextOptions = {},
): string {
  if (!root) return '';
  const maxLen = options.maxLen ?? 0;
  const includeSvgTitle = options.includeSvgTitle === true;
  const includeHidden = options.includeHidden === true;
  const skipAriaHidden = options.skipAriaHidden !== false;
  const stripPua = options.stripPua !== false;
  const fallbackLightDomWithoutSlot = options.fallbackLightDomWithoutSlot === true;

  const ownerDoc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  const view = ownerDoc?.defaultView || (typeof window !== 'undefined' ? window : null);

  const visited = new Set<Node>();
  const parts: string[] = [];
  let charCount = 0;

  const inspectNodeVisibility = (
    el: Element,
    parentVisibilityHidden: boolean,
  ): { pruneSubtree: boolean; visibilityHidden: boolean; style: CSSStyleDeclaration | null } => {
    if (includeHidden) {
      return { pruneSubtree: false, visibilityHidden: false, style: null };
    }
    if (
      (el as HTMLElement).hidden === true ||
      el.hasAttribute?.('hidden') ||
      (el as any).inert === true ||
      el.hasAttribute?.('inert') ||
      (skipAriaHidden && el.getAttribute?.('aria-hidden') === 'true')
    ) {
      return { pruneSubtree: true, visibilityHidden: true, style: null };
    }
    let style: CSSStyleDeclaration | null = null;
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        style = view.getComputedStyle(el);
        if (style.display === 'none') {
          return { pruneSubtree: true, visibilityHidden: true, style };
        }
        if (style.opacity !== '' && Number.parseFloat(style.opacity) <= 0) {
          return { pruneSubtree: true, visibilityHidden: true, style };
        }
        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
          return { pruneSubtree: false, visibilityHidden: true, style };
        }
        if (style.visibility === 'visible') {
          return { pruneSubtree: false, visibilityHidden: false, style };
        }
      } catch {}
    }
    return { pruneSubtree: false, visibilityHidden: parentVisibilityHidden, style };
  };

  const pushChunk = (raw: string) => {
    if (!raw) return;
    parts.push(raw);
    charCount += raw.length;
  };

  const walk = (node: Node, insideSvg: boolean, visibilityHidden: boolean): void => {
    if (!node || visited.has(node)) return;
    if (maxLen > 0 && charCount >= maxLen * 2 + 64) return;
    visited.add(node);

    if (node.nodeType === 3) {
      if (visibilityHidden) return;
      const val = node.textContent || '';
      if (val) pushChunk(val);
      return;
    }

    if (node.nodeType === 11 || node.nodeType === 9) {
      for (const child of Array.from(node.childNodes || [])) {
        walk(child, insideSvg, visibilityHidden);
      }
      return;
    }

    if (node.nodeType !== 1) return;

    const el = node as Element;
    const tag = (el.tagName || '').toLowerCase();

    if (tag === 'title') {
      if (includeSvgTitle && insideSvg && !visibilityHidden) {
        const val = (el.textContent || '').trim();
        if (val) pushChunk(` ${val} `);
      }
      return;
    }

    if (NON_CONTENT_TAGS.has(tag)) return;
    const vis = inspectNodeVisibility(el, visibilityHidden);
    if (vis.pruneSubtree) return;

    if (tag === 'br') {
      if (!vis.visibilityHidden) pushChunk(' ');
      return;
    }

    const nextInsideSvg = insideSvg || tag === 'svg';

    if (tag === 'slot') {
      let assigned: Node[] = [];
      try {
        if (typeof (el as HTMLSlotElement).assignedNodes === 'function') {
          assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
        }
      } catch {}
      const children = assigned.length > 0 ? assigned : Array.from(el.childNodes || []);
      for (const child of children) {
        walk(child, nextInsideSvg, vis.visibilityHidden);
      }
      return;
    }

    const block = isBlockLikeElement(el, view, vis.style);
    if (block && parts.length > 0) pushChunk(' ');

    const shadow = getShadowRoot(el);
    if (shadow) {
      walk(shadow, nextInsideSvg, vis.visibilityHidden);
      if (fallbackLightDomWithoutSlot && !shadow.querySelector?.('slot')) {
        for (const child of Array.from(el.childNodes || [])) {
          walk(child, nextInsideSvg, vis.visibilityHidden);
        }
      }
    } else {
      const beforeCount = charCount;
      for (const child of Array.from(el.childNodes || [])) {
        walk(child, nextInsideSvg, vis.visibilityHidden);
      }
      // jsdom does not back innerText with child Text nodes; own-property check avoids native reflow.
      if (
        charCount === beforeCount &&
        !vis.visibilityHidden &&
        Object.prototype.hasOwnProperty.call(el, 'innerText')
      ) {
        const ownInnerText = (el as HTMLElement).innerText;
        if (typeof ownInnerText === 'string' && ownInnerText) {
          pushChunk(ownInnerText);
        }
      }
    }

    if (block && parts.length > 0) pushChunk(' ');
  };

  walk(root, false, false);

  let text = parts.join('');
  if (stripPua) {
    text = text.replace(/[\uE000-\uF8FF]/g, ' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return maxLen > 0 ? text.slice(0, maxLen) : text;
}
