import type { ScrollUntilFoundOptions, ScrollUntilFoundResult } from 'chrome-mcp-shared';
import { composedParent, extractComposedVisibleText } from './composed-dom';
import { querySelectorAllDeep, querySelectorDeep } from './deep-query';
import { createDomQueryCache } from './dom-cache';
import { findExistingElementIndex, indexElement } from './index-state';
import { collapseNestedLocatorMatches, isLocatorCandidateVisible } from './locators';
import { inPageFindSmartScrollTarget } from './smart-scroll';

const TEXTBOX_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', '']);

/**
 * In-page atomic scroll-until-found loop for virtualized infinite-scroll lists (X/Twitter, Reddit, Notion, Slack).
 * Scrolls incrementally inside the page context at zero IPC overhead until the target text or CSS selector
 * appears in the DOM (penetrating Shadow DOM), stops immediately, scrolls target into center view,
 * and returns its live 1-based interactive index and coordinates.
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

  let container: HTMLElement | undefined;
  if (options?.containerSelector) {
    const el = querySelectorDeep(options.containerSelector);
    if (el instanceof HTMLElement) {
      container = el;
    }
  }

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
      if (TEXTBOX_INPUT_TYPES.has(type)) return 'textbox';
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
    return inferElementRole(el) === expectedRole;
  }

  function probeTarget(): { element: Element; text: string } | null {
    if (typeof document === 'undefined') return null;

    const stepCache = createDomQueryCache();
    const candidates = querySelectorAllDeep(
      selector ||
        'button, a, input, textarea, select, h1, h2, h3, h4, h5, h6, [role], [data-testid], article, p, span, li, div, section, blockquote, label, td, th, dt, dd, strong, b, i, em, code, pre, figcaption',
      document,
    );
    const matches = new Map<Element, string>();
    for (const element of candidates) {
      if (!roleMatches(element) || !isLocatorCandidateVisible(element, stepCache)) continue;
      const label = element.getAttribute('aria-label')?.trim() ?? '';
      const visibleText = extractComposedVisibleText(
        element,
        targetRegex ? { cache: stepCache } : { maxLen: 100, cache: stepCache },
      );
      const control = element as HTMLInputElement;
      const value =
        control.type !== 'password' && typeof control.value === 'string' ? control.value : '';
      const text = targetRegex
        ? [visibleText, label, control.placeholder, value].find(
            (part) => typeof part === 'string' && Boolean(part) && targetRegex.test(part),
          )
        : visibleText || label;
      if (text === undefined) continue;
      if (selector) return { element, text };
      matches.set(element, text);
    }
    const element = collapseNestedLocatorMatches([...matches.keys()])[0];
    return element ? { element, text: matches.get(element)! } : null;
  }

  function getScrollPos(): number {
    if (!container) {
      return window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0;
    }
    return container.scrollTop;
  }

  function doScroll(delta: number): void {
    if (!container) {
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

    const target = probeTarget();
    if (target) {
      const hit = target.element;
      if (options?.actionOnFound === 'focus') {
        try {
          (hit as HTMLElement).focus?.({ preventScroll: true });
        } catch {}
      } else if (options?.actionOnFound !== 'none') {
        const windowTop = window.scrollY;
        const ancestorTops = new Map<Element, number>();
        for (let ancestor = composedParent(hit); ancestor; ancestor = composedParent(ancestor)) {
          if (ancestor !== document.scrollingElement)
            ancestorTops.set(ancestor, ancestor.scrollTop);
        }
        try {
          hit.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as any });
        } catch {}
        await wait(50);
        totalScrolledPx += Math.abs(window.scrollY - windowTop);
        for (const [ancestor, top] of ancestorTops) {
          totalScrolledPx += Math.abs(ancestor.scrollTop - top);
        }
      }

      let targetIndex = findExistingElementIndex(hit);
      if (targetIndex === undefined) {
        targetIndex = indexElement(hit);
      }

      const rect = hit.getBoundingClientRect();
      const coords = {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };

      const matchText = target.text.slice(0, 100);

      return {
        found: true,
        index: targetIndex,
        tagName: hit.tagName.toLowerCase(),
        text: matchText,
        stepsTaken,
        scrolledPx: totalScrolledPx,
        coordinates: coords,
        message: `Found target "${matchText || query || selector}" at index [${targetIndex}] after ${stepsTaken} search step(s) (${totalScrolledPx}px scrolled).`,
      };
    }

    if (step === maxSteps) {
      break;
    }

    const delta = direction === 'up' ? -stepPx : stepPx;
    doScroll(delta);
    stepsTaken++;

    await wait(settleMs);

    const currentPos = getScrollPos();
    const moved = Math.abs(currentPos - lastPos);
    lastPos = currentPos;
    totalScrolledPx += moved;
    if (moved < 2) {
      stallCount++;
      if (stallCount === 1 && !container && !options?.containerSelector) {
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
  }

  return {
    found: false,
    stepsTaken,
    scrolledPx: totalScrolledPx,
    message: `Target "${query || selector}" not found after ${stepsTaken} step(s) (${totalScrolledPx}px scrolled).`,
  };
}
