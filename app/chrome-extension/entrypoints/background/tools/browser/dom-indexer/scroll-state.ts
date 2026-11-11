import { getShadowRoot } from '../dom-indexer';

export function inPageGetScrollState(): {
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  docWidth: number;
  docHeight: number;
  documentURL?: string;
  documentId?: string;
} {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const doc = win?.document;
  const docEl = doc?.documentElement;
  const body = doc?.body;
  const scrollX = win?.scrollX || win?.pageXOffset || docEl?.scrollLeft || body?.scrollLeft || 0;
  const scrollY = win?.scrollY || win?.pageYOffset || docEl?.scrollTop || body?.scrollTop || 0;
  const viewportWidth = win?.innerWidth || docEl?.clientWidth || 1280;
  const viewportHeight = win?.innerHeight || docEl?.clientHeight || 800;
  const docWidth = Math.max(
    body?.scrollWidth || 0,
    docEl?.scrollWidth || 0,
    body?.offsetWidth || 0,
    docEl?.offsetWidth || 0,
    viewportWidth,
  );
  const docHeight = Math.max(
    body?.scrollHeight || 0,
    docEl?.scrollHeight || 0,
    body?.offsetHeight || 0,
    docEl?.offsetHeight || 0,
    viewportHeight,
  );
  let documentId: string | undefined = undefined;
  if (doc) {
    documentId = (doc as any)._browserpaw_doc_id;
    if (!documentId) {
      documentId = 'doc_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now();
      try {
        (doc as any)._browserpaw_doc_id = documentId;
      } catch {}
    }
  }
  const documentURL = doc?.URL || win?.location?.href || '';

  return {
    scrollX: Math.round(scrollX),
    scrollY: Math.round(scrollY),
    viewportWidth: Math.round(viewportWidth),
    viewportHeight: Math.round(viewportHeight),
    docWidth: Math.round(docWidth),
    docHeight: Math.round(docHeight),
    documentURL,
    documentId,
  };
}

/**
 * Instantaneously scrolls page to the specified coordinates without animation delay.
 */
export function inPageInstantScrollTo(
  x: number,
  y: number,
): { success: boolean; scrollX: number; scrollY: number } {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  if (!win) return { success: false, scrollX: 0, scrollY: 0 };
  const prevBehavior = win.document?.documentElement?.style?.scrollBehavior || '';
  try {
    if (win.document?.documentElement) {
      win.document.documentElement.style.scrollBehavior = 'auto';
    }
    const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
    if (!isJsdom && typeof win.scrollTo === 'function') {
      win.scrollTo({ left: x, top: y, behavior: 'instant' as any });
    }
  } finally {
    if (win.document?.documentElement) {
      win.document.documentElement.style.scrollBehavior = prevBehavior;
    }
  }
  const curX = win.scrollX || win.pageXOffset || 0;
  const curY = win.scrollY || win.pageYOffset || 0;
  return { success: true, scrollX: Math.round(curX), scrollY: Math.round(curY) };
}

/**
 * Temporarily locks smooth scroll behavior to prevent inertia/smooth-scroll racing during click dispatch.
 */
let originalScrollBehavior: string | null = null;
export function inPageLockScroll(lock: boolean): boolean {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const docEl = win?.document?.documentElement;
  if (!docEl) return false;
  if (lock) {
    if (originalScrollBehavior === null) {
      originalScrollBehavior = docEl.style.scrollBehavior || '';
    }
    docEl.style.scrollBehavior = 'auto';
  } else {
    if (originalScrollBehavior !== null) {
      docEl.style.scrollBehavior = originalScrollBehavior;
      originalScrollBehavior = null;
    }
  }
  return true;
}

/**
 * Deep page text extraction that pierces all open and closed ShadowRoot boundaries,
 * flattens <slot> projections, and structures text into clean readable lines.
 */
export function inPageExtractDeepPageText(rootNode?: Node): string {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const doc = win?.document;
  const start = rootNode || doc?.body || doc;
  if (!start) return '';

  const chunks: string[] = [];

  function walk(node: Node) {
    if (!node) return;

    if (node.nodeType === 3) {
      // Text node
      const val = node.textContent?.trim();
      if (val) {
        chunks.push(val);
      }
      return;
    }

    if (node.nodeType !== 1 && node.nodeType !== 11) {
      // Not Element or DocumentFragment / ShadowRoot
      return;
    }

    const el = node as Element;
    const tag = (el.tagName || '').toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) {
      return;
    }

    // Accessible name for buttons/links/custom elements without visible text
    const ariaLabel = el.getAttribute?.('aria-label')?.trim();
    if (ariaLabel && !el.textContent?.includes(ariaLabel)) {
      chunks.push(`[${ariaLabel}]`);
    }

    // Traverse shadow root (open or closed)
    const shadow = getShadowRoot(el);
    if (shadow) {
      walk(shadow);
    }

    // Flatten <slot> elements
    if (tag === 'slot' && typeof (el as HTMLSlotElement).assignedNodes === 'function') {
      try {
        const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
        for (const a of assigned) {
          walk(a);
        }
      } catch {
        for (const child of Array.from(node.childNodes)) {
          walk(child);
        }
      }
    } else {
      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
    }

    // Block-level break for standard layout and Web Component wrappers
    if (
      /^(div|p|h[1-6]|li|section|article|header|footer|nav|blockquote|tr|table|shreddit-|faceplate-)/i.test(
        tag,
      )
    ) {
      chunks.push('\n');
    }
  }

  walk(start);

  return chunks
    .join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
