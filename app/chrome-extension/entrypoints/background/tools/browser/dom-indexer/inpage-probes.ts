import { findIndexedElement, interceptingElementAtPoint, describeHitTarget } from '../dom-indexer';

export async function inPageGetAssetImage(assetIndex: number): Promise<{
  success: boolean;
  reason?: string;
  dataUrl?: string;
  rect?: { x: number; y: number; width: number; height: number };
  frameOffsetX?: number;
  frameOffsetY?: number;
  devicePixelRatio?: number;
  kind?: string;
  src?: string;
}> {
  const MAP_KEY = Symbol.for('__browser_use_page_assets__') as any;
  const assets = (globalThis as any)[MAP_KEY];
  const entry = assets && assets[assetIndex - 1];
  if (!entry)
    return {
      success: false,
      reason: `asset ${assetIndex} not found (run browserpaw observe first)`,
    };
  const rect = entry.el.getBoundingClientRect().toJSON();
  // rect is relative to this frame's viewport; the background crops the
  // top-level capture, so also report the frame's cumulative viewport offset
  // (with border and zoom compensation) for the fallback path.
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
  const out: any = {
    success: false,
    reason: 'unsupported',
    dataUrl: undefined,
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    frameOffsetX: Math.round(frameOffsetX),
    frameOffsetY: Math.round(frameOffsetY),
    kind: entry.kind,
    src: entry.src,
    devicePixelRatio: (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1,
  };
  try {
    if (entry.kind === 'canvas') {
      out.dataUrl = (entry.el as HTMLCanvasElement).toDataURL('image/png');
      out.success = true;
      return out;
    }
    const src = entry.src;
    if (!src) {
      out.reason = 'no src (video/streams must be cropped)';
      return out;
    }
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) {
      out.reason = `fetch ${res.status}`;
      return out;
    }
    const blob = await res.blob();
    out.dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('FileReader failed'));
      fr.readAsDataURL(blob);
    });
    out.success = true;
    return out;
  } catch (err) {
    out.success = false;
    out.reason = String(err instanceof Error ? err.message : err);
    return out;
  }
}

/**
 * Extract crawlable links (absolute URL, anchor text, internal/external,
 * nofollow). Read-only; runs in the page's isolated world.
 */
export function inPageGetLinks(options?: {
  index?: number;
  selector?: string;
  sameOriginOnly?: boolean;
  includeEmptyHref?: boolean;
}): Array<{ url: string; text: string; internal: boolean; nofollow: boolean }> {
  const indexed = typeof options?.index === 'number' ? findIndexedElement(options.index) : null;
  const selected = options?.selector ? document.querySelector(options.selector) : null;
  const root: ParentNode = indexed ?? selected ?? document;
  const anchors = root.querySelectorAll('a[href]');
  const out: Array<{ url: string; text: string; internal: boolean; nofollow: boolean }> = [];
  const seen = new Set<string>();
  anchors.forEach((a) => {
    const href = (a as HTMLAnchorElement).href;
    if (!href || !/^https?:/i.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    const rel = (a.getAttribute('rel') || '').toLowerCase();
    const nofollow = rel.includes('nofollow');
    const internal = new URL(href, location.href).origin === location.origin;
    if (options?.sameOriginOnly && !internal) return;
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    out.push({ url: href, text, internal, nofollow });
  });
  return out;
}
export function inPageCheckInterception(
  index: number,
  x: number,
  y: number,
): {
  intercepted: boolean;
  description?: string;
  canPierce?: boolean;
  pierceReason?: string;
} {
  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) return { intercepted: false };

  const intercepting = interceptingElementAtPoint(el, x, y);
  if (
    intercepting &&
    intercepting !== el &&
    !el.contains(intercepting) &&
    !intercepting.contains(el)
  ) {
    const win = intercepting.ownerDocument?.defaultView || window;
    let isTransparentOrTransient = false;
    let pierceReason: string | undefined;

    try {
      const style = win.getComputedStyle(intercepting);
      // 1. Pointer-events: none -> passes straight through
      if (style.pointerEvents === 'none') {
        return { intercepted: false };
      }
      // 2. Hidden display / visibility -> passes straight through
      if (style.display === 'none' || style.visibility === 'hidden') {
        return { intercepted: false };
      }
      // 3. Near-zero opacity -> non-opaque overlay
      const op = parseFloat(style.opacity || '1');
      if (op <= 0.05) {
        isTransparentOrTransient = true;
        pierceReason = 'zero_opacity';
      }

      // 4. Transparent background color (e.g. rgba(0, 0, 0, 0) or transparent)
      const bg = (style.backgroundColor || '').toLowerCase().replace(/\s+/g, '');
      const isTransparentBg =
        bg === 'transparent' || bg === 'rgba(0,0,0,0)' || bg === 'hsla(0,0%,0%,0)';

      // 5. Transient backdrop masks / loading stubs / fading transitions
      const classIdStr =
        `${intercepting.className || ''} ${intercepting.id || ''} ${intercepting.getAttribute('role') || ''}`.toLowerCase();
      const isMaskOrBackdrop =
        /(backdrop|mask|overlay|loading|spinner|shim|transition|fading|fade-out|toast|stub)/i.test(
          classIdStr,
        );
      const isAriaHidden = intercepting.getAttribute('aria-hidden') === 'true';
      const isPresentation = intercepting.getAttribute('role') === 'presentation';

      // Check if intercepting element has no interactive children
      const hasInteractiveChildren = Boolean(
        intercepting.querySelector?.('button, a, input, textarea, select, [role="button"]'),
      );

      if (
        !hasInteractiveChildren &&
        (isMaskOrBackdrop || isAriaHidden || isPresentation || isTransparentBg || op <= 0.1)
      ) {
        isTransparentOrTransient = true;
        pierceReason =
          pierceReason || (isTransparentBg ? 'transparent_background' : 'transient_mask');
      }
    } catch {}

    const desc = describeHitTarget(intercepting);
    if (isTransparentOrTransient) {
      return {
        intercepted: true,
        description: desc,
        canPierce: true,
        pierceReason: pierceReason || 'transient_overlay',
      };
    }

    return { intercepted: true, description: desc };
  }
  return { intercepted: false };
}

export function inPageDispatchSyntheticClick(
  index: number | null | undefined,
  x: number,
  y: number,
  action: 'click' | 'right_click' | 'double_click' = 'click',
): boolean {
  let el = typeof index === 'number' && index > 0 ? findIndexedElement(index) : null;
  if (
    !el &&
    typeof document !== 'undefined' &&
    typeof (document as any).elementsFromPoint === 'function'
  ) {
    const elements = (document as any).elementsFromPoint(x, y) || [];
    for (const cand of elements) {
      if (!(cand instanceof Element)) continue;
      const win = cand.ownerDocument?.defaultView || window;
      let isMask = false;
      try {
        const s = win.getComputedStyle(cand);
        if (s.pointerEvents === 'none' || s.display === 'none' || s.visibility === 'hidden') {
          continue;
        }
        const op = parseFloat(s.opacity || '1');
        const bg = (s.backgroundColor || '').toLowerCase().replace(/\s+/g, '');
        const isTransparentBg = bg === 'transparent' || bg === 'rgba(0,0,0,0)';
        const classId =
          `${cand.className || ''} ${cand.id || ''} ${cand.getAttribute('role') || ''}`.toLowerCase();
        const matchesMask =
          /(backdrop|mask|overlay|loading|spinner|shim|transition|fading|fade-out|toast|stub)/i.test(
            classId,
          );
        const hasInteractive = Boolean(
          cand.querySelector?.('button, a, input, textarea, select, [role="button"]'),
        );
        if (!hasInteractive && (op <= 0.05 || (matchesMask && isTransparentBg))) {
          isMask = true;
        }
      } catch {}
      if (!isMask) {
        el = cand;
        break;
      }
    }
  }
  if (!el && typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
    el = document.elementFromPoint(x, y);
  }
  if (!el || !(el instanceof Element)) return false;

  const isRight = action === 'right_click';
  const button = isRight ? 2 : 0;
  const buttons = isRight ? 2 : 1;

  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
  };

  try {
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons, pointerType: 'mouse' }));
  } catch {}
  el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons }));
  try {
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
  } catch {}
  el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));

  if (isRight) {
    el.dispatchEvent(new MouseEvent('contextmenu', { ...init, buttons: 0 }));
  } else if (action === 'double_click') {
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons, pointerType: 'mouse' }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons }));
    try {
      el.dispatchEvent(
        new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }),
      );
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('dblclick', { ...init, buttons: 0 }));
  } else {
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  }

  return true;
}

/**
 * Detect active confirmation trap dialogs (e.g. "Discard draft?", "放弃帖子？") on the page.
 */
