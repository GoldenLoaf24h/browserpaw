import type { IndexedElement } from 'chrome-mcp-shared';
import { composedParent } from './composed-dom';
import { derefElement, getIsolatedIndexMap } from './index-state';
import {
  extractCleanElementText,
  findIndexedElement,
  getStickyOcclusionMargins,
  inPageRemoveHighlights,
} from '../dom-indexer';

/**
 * Re-align existing Set-of-Mark visual highlights after dynamic scroll/resize events
 * without triggering a full DOM re-pruning or index regeneration.
 */
export function inPageRealignHighlights(): boolean {
  const existing = document.getElementById('__mcp_som_overlay_container__');
  if (!existing) return false;

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

  const placedBadges: Array<{ x: number; y: number }> = [];

  for (const el of indexedElements) {
    if (!el.rect || (el.rect.width <= 0 && el.rect.height <= 0)) continue;

    if (
      el.rect.x + el.rect.width < 0 ||
      el.rect.y + el.rect.height < 0 ||
      el.rect.x > vw ||
      el.rect.y > vh
    ) {
      continue;
    }

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

    const isSmall = el.rect.width < 60 || el.rect.height < 30;
    let badgeTop = isSmall ? Math.max(0, el.rect.y - 14) : el.rect.y;
    const badgeLeft = el.rect.x;

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
      const altTop = el.rect.y + el.rect.height - 2;
      if (!isColliding(badgeLeft + 10, altTop + 7) && altTop + 14 <= vh) {
        badgeTop = altTop;
      } else {
        badgeTop = Math.max(0, badgeTop + 14);
      }
    }

    placedBadges.push({ x: badgeLeft + 10, y: badgeTop + 7 });

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
