import {
  composedContains,
  findIndexedElement,
  deepElementFromPoint,
  computeInteractionScope,
  getStickyOcclusionMargins,
  inPageDOMPruner,
} from '../dom-indexer';

export interface SmartScrollTargetInfo {
  found: boolean;
  reason?: string;
  ambiguous?: boolean;
  isWindow: boolean;
  tagName: string;
  selector?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  canScrollDown: boolean;
  canScrollUp: boolean;
  canScrollRight: boolean;
  canScrollLeft: boolean;
}

/**
 * Identify the optimal scrollable container on the page, or target a specific
 * container by selector, ref, or coordinate.
 */
export function inPageFindSmartScrollTarget(options?: {
  selector?: string;
  ref?: number;
  coordinate?: { x: number; y: number };
  direction?: 'down' | 'up' | 'left' | 'right';
  isWindow?: boolean;
}): SmartScrollTargetInfo {
  const unavailable = (reason: string, ambiguous = false): SmartScrollTargetInfo => ({
    found: false,
    reason,
    ambiguous,
    isWindow: false,
    tagName: 'none',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    clientWidth: 0,
    clientHeight: 0,
    canScrollDown: false,
    canScrollUp: false,
    canScrollRight: false,
    canScrollLeft: false,
  });
  const direction = options?.direction;
  const interactionScope = computeInteractionScope(window);
  const inInteractionScope = (el: Element): boolean =>
    !interactionScope.focusTrapped ||
    interactionScope.roots.some((root) => root === el || composedContains(root, el));
  const canScrollInDirection = (el: HTMLElement): boolean => {
    const scrollTop = el.scrollTop || 0;
    const scrollLeft = el.scrollLeft || 0;
    const canScrollDown = scrollTop + el.clientHeight < el.scrollHeight - 5;
    const canScrollUp = scrollTop > 5;
    const canScrollRight = scrollLeft + el.clientWidth < el.scrollWidth - 5;
    const canScrollLeft = scrollLeft > 5;
    if (direction === 'down') return canScrollDown;
    if (direction === 'up') return canScrollUp;
    if (direction === 'right') return canScrollRight;
    if (direction === 'left') return canScrollLeft;
    return canScrollDown || canScrollUp || canScrollRight || canScrollLeft;
  };

  // If explicitly requested window scroll, skip container search
  if (!options?.isWindow) {
    let targetEl: Element | null = null;
    const hasExplicitTarget = Boolean(
      typeof options?.ref === 'number' || options?.selector || options?.coordinate,
    );

    if (typeof options?.ref === 'number') {
      targetEl = findIndexedElement(options.ref);
    } else if (options?.selector) {
      try {
        targetEl = document.querySelector(options.selector);
      } catch {}
    } else if (options?.coordinate) {
      try {
        targetEl = deepElementFromPoint(options.coordinate.x, options.coordinate.y);
      } catch {}
    }

    // If a target element was specified, check if it or an ancestor is scrollable
    if (targetEl) {
      if (!inInteractionScope(targetEl)) {
        return unavailable('target_outside_interaction_scope');
      }
      let curr: Element | null = targetEl;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        const isScrollable =
          (curr.scrollHeight > curr.clientHeight + 10 ||
            curr.scrollWidth > curr.clientWidth + 10) &&
          /(auto|scroll|overlay)/i.test(
            (window.getComputedStyle?.(curr)?.overflowY || '') +
              ' ' +
              (window.getComputedStyle?.(curr)?.overflowX || ''),
          );
        if (isScrollable) {
          targetEl = curr;
          break;
        }
        curr = curr.parentElement;
      }
      if (curr === document.body || curr === document.documentElement) {
        targetEl = null; // Fall back to window
      }
    }

    if (hasExplicitTarget && !targetEl) {
      return unavailable('target_not_scrollable');
    }

    if (!targetEl && !hasExplicitTarget) {
      const scopedContainers = (interactionScope.scrollContainers || []).filter(
        canScrollInDirection,
      );
      if (interactionScope.focusTrapped && scopedContainers.length > 1) {
        return unavailable('ambiguous_scroll_container', true);
      }
      if (scopedContainers.length === 1) {
        targetEl = scopedContainers[0];
      } else if (interactionScope.focusTrapped) {
        return unavailable('no_scroll_container_in_interaction_scope');
      }
    }

    // If no explicit target, find the optimal scrollable container using the Priority Scroll Engine
    if (
      !targetEl &&
      typeof document !== 'undefined' &&
      typeof document.querySelectorAll === 'function'
    ) {
      const winW = typeof window !== 'undefined' ? window.innerWidth || 800 : 800;
      const winH = typeof window !== 'undefined' ? window.innerHeight || 600 : 600;
      const vpCenterX = winW / 2;
      const vpCenterY = winH / 2;

      // Check whether window/document itself can scroll in requested direction
      const doc = (
        typeof document !== 'undefined' ? document.documentElement || document.body : null
      ) as HTMLElement | null;
      const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
      const currentScrollY =
        win?.scrollY ||
        win?.pageYOffset ||
        doc?.scrollTop ||
        (typeof document !== 'undefined' ? document.body?.scrollTop : 0) ||
        0;
      const currentScrollX =
        win?.scrollX ||
        win?.pageXOffset ||
        doc?.scrollLeft ||
        (typeof document !== 'undefined' ? document.body?.scrollLeft : 0) ||
        0;
      const winScrollHeight = Math.max(
        doc?.scrollHeight || 0,
        (typeof document !== 'undefined' ? document.body?.scrollHeight : 0) || 0,
        winH,
      );
      const winScrollWidth = Math.max(
        doc?.scrollWidth || 0,
        (typeof document !== 'undefined' ? document.body?.scrollWidth : 0) || 0,
        winW,
      );

      let windowCanScrollInDir = winScrollHeight > winH + 15;
      if (options?.direction === 'down') {
        windowCanScrollInDir =
          winScrollHeight > winH + 15 && currentScrollY + winH < winScrollHeight - 5;
      } else if (options?.direction === 'up') {
        windowCanScrollInDir = currentScrollY > 5;
      } else if (options?.direction === 'right') {
        windowCanScrollInDir =
          winScrollWidth > winW + 15 && currentScrollX + winW < winScrollWidth - 5;
      } else if (options?.direction === 'left') {
        windowCanScrollInDir = currentScrollX > 5;
      }

      // Probe scroll container of the central viewport element
      let centerScrollParent: Element | null = null;
      if (typeof document.elementFromPoint === 'function') {
        try {
          let probeEl = document.elementFromPoint(vpCenterX, vpCenterY);
          while (probeEl && probeEl !== document.body && probeEl !== document.documentElement) {
            const sh = probeEl.scrollHeight;
            const ch = probeEl.clientHeight;
            const sw = probeEl.scrollWidth;
            const cw = probeEl.clientWidth;
            if (sh > ch + 10 || sw > cw + 10) {
              const style = window.getComputedStyle?.(probeEl);
              const overflow = (style?.overflowY || '') + ' ' + (style?.overflowX || '');
              if (/(auto|scroll|overlay)/i.test(overflow)) {
                centerScrollParent = probeEl;
                break;
              }
            }
            probeEl = probeEl.parentElement;
          }
        } catch {}
      }

      let bestScore = -1;
      let bestEl: Element | null = null;
      const allElements = document.querySelectorAll('*');

      for (const el of Array.from(allElements)) {
        if (el === document.body || el === document.documentElement) continue;
        const sh = el.scrollHeight;
        const ch = el.clientHeight;
        const sw = el.scrollWidth;
        const cw = el.clientWidth;
        if (sh <= ch + 10 && sw <= cw + 10) continue;

        const scrollTop = el.scrollTop || 0;
        const scrollLeft = el.scrollLeft || 0;
        const canScrollDown = scrollTop + ch < sh - 5;
        const canScrollUp = scrollTop > 5;
        const canScrollRight = scrollLeft + cw < sw - 5;
        const canScrollLeft = scrollLeft > 5;

        let canScrollInDir = true;
        if (options?.direction === 'down') canScrollInDir = canScrollDown;
        else if (options?.direction === 'up') canScrollInDir = canScrollUp;
        else if (options?.direction === 'right') canScrollInDir = canScrollRight;
        else if (options?.direction === 'left') canScrollInDir = canScrollLeft;
        else canScrollInDir = canScrollDown || canScrollUp || canScrollRight || canScrollLeft;

        // Disqualify containers that are exhausted in the requested direction
        if (!canScrollInDir) continue;

        const style = window.getComputedStyle?.(el);
        if (!style) continue;
        const overflow = (style.overflowY || '') + ' ' + (style.overflowX || '');
        if (!/(auto|scroll|overlay)/i.test(overflow)) continue;
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          parseFloat(style.opacity || '1') <= 0
        )
          continue;

        const rect =
          typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        if (!rect) continue;

        const vLeft = Math.max(0, rect.left);
        const vTop = Math.max(0, rect.top);
        const vRight = Math.min(winW, rect.right);
        const vBottom = Math.min(winH, rect.bottom);
        const visibleWidth = vRight - vLeft;
        const visibleHeight = vBottom - vTop;
        if (visibleWidth < 50 || visibleHeight < 50) continue;

        const elCenterX = rect.left + rect.width / 2;
        const distX = Math.abs(elCenterX - vpCenterX);
        const centerProximity = Math.max(0.05, 1 - (distX / (winW / 2)) * 0.85);
        const straddlesCenter = rect.left <= vpCenterX && rect.right >= vpCenterX;

        // Width & aspect ratio penalty: heavily penalize narrow sidebars / columns (<300px)
        const widthPenalty = rect.width < 220 ? 0.1 : rect.width < 320 ? 0.3 : 1.0;

        // Semantic analysis: negative weighting for navigation/sidebars
        const getAttr = (k: string) =>
          typeof el.getAttribute === 'function' ? el.getAttribute(k) || '' : '';
        const tag = el.tagName.toLowerCase();
        const role = getAttr('role').toLowerCase();
        const idClass = (
          (el.id || '') +
          ' ' +
          (typeof el.className === 'string' ? el.className : '') +
          ' ' +
          getAttr('data-testid') +
          ' ' +
          getAttr('aria-label')
        ).toLowerCase();

        const isNavOrSidebar =
          tag === 'nav' ||
          tag === 'aside' ||
          tag === 'header' ||
          tag === 'footer' ||
          role === 'navigation' ||
          role === 'banner' ||
          role === 'complementary' ||
          role === 'menu' ||
          role === 'menubar' ||
          role === 'tablist' ||
          /(sidebar|side-nav|sidenav|navigation|navbar|rail|drawer|menu-list|toc|panel-left|left-rail|right-rail)/i.test(
            idClass,
          );

        const semanticMultiplier = isNavOrSidebar ? 0.05 : 1.0;

        // Content boost for main article / feed containers
        const isMainContent =
          tag === 'main' ||
          tag === 'article' ||
          role === 'main' ||
          /(main-content|post-container|feed|scroll-content|timeline|messages|discussion)/i.test(
            idClass,
          );

        const contentBoost = isMainContent ? 2.0 : 1.0;

        // Proximity boost if element matches the viewport center's scroll parent
        const isCenterParent =
          centerScrollParent &&
          (el === centerScrollParent ||
            el.contains(centerScrollParent) ||
            centerScrollParent.contains(el));
        const centerParentBoost = isCenterParent ? 3.0 : 1.0;

        const baseArea = visibleWidth * visibleHeight;
        const interactiveCount =
          typeof el.querySelectorAll === 'function'
            ? el.querySelectorAll('button, a, input, select, textarea, [role="button"]').length
            : 0;
        const interactiveFactor = 1 + 0.1 * Math.min(5, interactiveCount);

        const score =
          baseArea *
          centerProximity *
          widthPenalty *
          semanticMultiplier *
          contentBoost *
          centerParentBoost *
          (straddlesCenter ? 1.5 : 1.0) *
          interactiveFactor;

        if (score > bestScore) {
          bestScore = score;
          bestEl = el;
        }
      }

      // Default to window if viewport center has no scroll container and window can scroll,
      // or if best candidate is a penalized sidebar
      const bestIsPenalizedSidebar = bestEl
        ? /sidebar|side-nav|sidenav|navigation|navbar|rail|drawer|menu-list|toc/i.test(
            bestEl.id + ' ' + (typeof bestEl.className === 'string' ? bestEl.className : ''),
          )
        : false;
      const shouldPreferWindow =
        windowCanScrollInDir &&
        (!bestEl ||
          (bestIsPenalizedSidebar && bestScore < winW * winH * 0.35) ||
          bestScore < winW * winH * 0.02);

      if (!shouldPreferWindow && bestEl) {
        targetEl = bestEl;
      }
    }

    if (targetEl && typeof targetEl.getBoundingClientRect === 'function') {
      const rect = targetEl.getBoundingClientRect();
      const scrollTop = targetEl.scrollTop || 0;
      const scrollLeft = targetEl.scrollLeft || 0;
      const scrollHeight = targetEl.scrollHeight || 0;
      const scrollWidth = targetEl.scrollWidth || 0;
      const clientHeight = targetEl.clientHeight || 0;
      const clientWidth = targetEl.clientWidth || 0;

      let selector: string;
      if (targetEl.id) {
        const safeId =
          typeof CSS !== 'undefined' && CSS.escape
            ? CSS.escape(targetEl.id)
            : targetEl.id.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');
        selector = `#${safeId}`;
      } else {
        try {
          targetEl.setAttribute('data-browserpaw-scroll-target', 'true');
          selector = `${targetEl.tagName.toLowerCase()}[data-browserpaw-scroll-target="true"]`;
        } catch {
          selector = targetEl.tagName.toLowerCase();
        }
      }

      const winW = typeof window !== 'undefined' ? window.innerWidth || 800 : 800;
      const winH = typeof window !== 'undefined' ? window.innerHeight || 600 : 600;
      const margins =
        typeof window !== 'undefined' ? getStickyOcclusionMargins(window) : { top: 0, bottom: 0 };
      const safeTopMargin = Math.min(Math.max(margins.top, 80), Math.round(winH * 0.35));
      const safeBottomMargin = Math.min(Math.max(margins.bottom, 80), Math.round(winH * 0.35));
      const vLeft = Math.max(0, rect.left);
      const vTop = Math.max(safeTopMargin, rect.top);
      const vRight = Math.min(winW, rect.right);
      const vBottom = Math.min(winH - safeBottomMargin, rect.bottom);
      const visibleWidth = Math.max(1, vRight - vLeft);
      const visibleHeight = Math.max(1, vBottom - vTop);
      const dispatchX = Math.round(vLeft + visibleWidth / 2);
      const dispatchY = Math.round(vTop + visibleHeight / 2);

      return {
        found: true,
        isWindow: false,
        tagName: targetEl.tagName.toLowerCase(),
        selector,
        x: dispatchX,
        y: dispatchY,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollLeft,
        scrollTop,
        scrollWidth,
        scrollHeight,
        clientWidth,
        clientHeight,
        canScrollDown: scrollTop + clientHeight < scrollHeight - 5,
        canScrollUp: scrollTop > 5,
        canScrollRight: scrollLeft + clientWidth < scrollWidth - 5,
        canScrollLeft: scrollLeft > 5,
      };
    }
  }

  // Fallback to Window / Document
  if (interactionScope.focusTrapped) {
    return unavailable('background_scroll_blocked_by_modal');
  }
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const doc = (
    typeof document !== 'undefined' ? document.documentElement || document.body : null
  ) as HTMLElement | null;
  const scrollY = win?.scrollY || win?.pageYOffset || doc?.scrollTop || 0;
  const scrollX = win?.scrollX || win?.pageXOffset || doc?.scrollLeft || 0;
  const clientWidth = win?.innerWidth || doc?.clientWidth || 800;
  const clientHeight = win?.innerHeight || doc?.clientHeight || 600;
  const scrollHeight = Math.max(
    doc?.scrollHeight || 0,
    (typeof document !== 'undefined' ? document.body?.scrollHeight : 0) || 0,
    clientHeight,
  );
  const scrollWidth = Math.max(
    doc?.scrollWidth || 0,
    (typeof document !== 'undefined' ? document.body?.scrollWidth : 0) || 0,
    clientWidth,
  );

  const winMargins = win ? getStickyOcclusionMargins(win) : { top: 0, bottom: 0 };
  const safeTop = Math.min(Math.max(winMargins.top, 80), Math.round(clientHeight * 0.35));
  const safeBottom =
    clientHeight - Math.min(Math.max(winMargins.bottom, 80), Math.round(clientHeight * 0.35));
  const effectiveH = Math.max(10, safeBottom - safeTop);
  const windowDispatchY = Math.round(safeTop + effectiveH / 2);

  return {
    found: true,
    isWindow: true,
    tagName: 'window',
    x: Math.round(clientWidth / 2),
    y: windowDispatchY,
    width: clientWidth,
    height: clientHeight,
    scrollLeft: scrollX,
    scrollTop: scrollY,
    scrollWidth,
    scrollHeight,
    clientWidth,
    clientHeight,
    canScrollDown: scrollY + clientHeight < scrollHeight - 5,
    canScrollUp: scrollY > 5,
    canScrollRight: scrollX + clientWidth < scrollWidth - 5,
    canScrollLeft: scrollX > 5,
  };
}

export function inPagePerformSmartScroll(
  isWindow: boolean,
  selector: string | undefined,
  deltaX: number,
  deltaY: number,
  smooth = true,
): {
  success: boolean;
  newScrollTop: number;
  newScrollLeft: number;
  canScrollDown: boolean;
  canScrollUp: boolean;
} {
  const behavior = smooth ? ('smooth' as ScrollBehavior) : ('auto' as ScrollBehavior);
  if (isWindow || !selector) {
    if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
      window.scrollBy({ left: deltaX, top: deltaY, behavior });
    }
    const doc = (
      typeof document !== 'undefined' ? document.documentElement || document.body : null
    ) as HTMLElement | null;
    const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
    const scrollY = win?.scrollY || win?.pageYOffset || doc?.scrollTop || 0;
    const scrollX = win?.scrollX || win?.pageXOffset || doc?.scrollLeft || 0;
    const clientHeight = win?.innerHeight || doc?.clientHeight || 600;
    const scrollHeight = Math.max(
      doc?.scrollHeight || 0,
      (typeof document !== 'undefined' ? document.body?.scrollHeight : 0) || 0,
      clientHeight,
    );
    return {
      success: true,
      newScrollTop: Math.round(scrollY),
      newScrollLeft: Math.round(scrollX),
      canScrollDown: scrollY + clientHeight < scrollHeight - 5,
      canScrollUp: scrollY > 5,
    };
  }

  let el: Element | null = null;
  if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
    try {
      el = document.querySelector(selector);
    } catch {}
  }
  if (!el) {
    if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
      window.scrollBy({ left: deltaX, top: deltaY, behavior });
    }
    const doc = (
      typeof document !== 'undefined' ? document.documentElement || document.body : null
    ) as HTMLElement | null;
    const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
    return {
      success: true,
      newScrollTop: Math.round(win?.scrollY || doc?.scrollTop || 0),
      newScrollLeft: Math.round(win?.scrollX || doc?.scrollLeft || 0),
      canScrollDown: true,
      canScrollUp: false,
    };
  }

  if (typeof el.scrollBy === 'function') {
    el.scrollBy({ left: deltaX, top: deltaY, behavior });
  } else {
    el.scrollTop += deltaY;
    el.scrollLeft += deltaX;
  }
  return {
    success: true,
    newScrollTop: Math.round(el.scrollTop),
    newScrollLeft: Math.round(el.scrollLeft),
    canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 5,
    canScrollUp: el.scrollTop > 5,
  };
}

/**
 * Resolve an asset index (from inPageDOMPruner assets) to image data.
 * Primary path pulls real bytes: canvas -> toDataURL, img/bg-image ->
 * fetch + FileReader in page context (same-origin or CORS-enabled only).
 * Returns rect so background can fall back to viewport cropping when bytes
 * are not obtainable (tainted canvas, opaque cross-origin, video).
 */
