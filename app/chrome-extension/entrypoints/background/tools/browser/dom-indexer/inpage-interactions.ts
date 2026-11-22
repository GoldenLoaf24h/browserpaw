import { composedClosest, composedContains, composedParent, isCustomElement } from './composed-dom';
import { querySelectorAllDeep } from './deep-query';
import { derefElement, getIsolatedIndexMap, indexElement } from './index-state';
import { inPageSelectCustomCombobox, inPageVerifyInputCommitment } from './input-commitment';
import { collapseNestedLocatorMatches, isLocatorCandidateVisible } from './locators';
import {
  DIAGNOSTIC_REFRESH_GUIDANCE,
  deepElementFromPoint,
  extractElementLocationDetails,
  findIndexedElement,
  getDeepActiveElement,
  parseElementIndex,
} from '../dom-indexer';
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

export function isClippedOutOfView(el: Element, rect: DOMRect, win: Window): boolean {
  const visible = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  let positionMode: 'normal' | 'absolute' | 'fixed' = 'normal';
  if (typeof win.getComputedStyle === 'function') {
    try {
      const ownPos = win.getComputedStyle(el).position;
      if (ownPos === 'fixed') positionMode = 'fixed';
      else if (ownPos === 'absolute') positionMode = 'absolute';
    } catch {}
  }
  const createsFixedBlock = (style: CSSStyleDeclaration): boolean =>
    (Boolean(style.transform) && style.transform !== 'none') ||
    (Boolean(style.perspective) && style.perspective !== 'none') ||
    (Boolean(style.filter) && style.filter !== 'none') ||
    (Boolean((style as any).backdropFilter) && (style as any).backdropFilter !== 'none') ||
    /\b(paint|layout|strict|content)\b/.test((style as any).contain || '');

  let ancestor = composedParent(el);
  const seenAnc = new Set<Element>();
  while (
    ancestor &&
    !seenAnc.has(ancestor) &&
    ancestor !== el.ownerDocument.body &&
    ancestor !== el.ownerDocument.documentElement
  ) {
    seenAnc.add(ancestor);
    if (typeof win.getComputedStyle === 'function') {
      const style = win.getComputedStyle(ancestor);
      const ancPos = style.position || 'static';
      const isFixedContainer = createsFixedBlock(style);
      let ancestorClips = true;
      if (positionMode === 'fixed') {
        if (!isFixedContainer) {
          ancestorClips = false;
        } else {
          positionMode =
            ancPos === 'fixed' ? 'fixed' : ancPos === 'absolute' ? 'absolute' : 'normal';
        }
      } else if (positionMode === 'absolute') {
        if (ancPos === 'static' && !isFixedContainer) {
          ancestorClips = false;
        } else {
          positionMode =
            ancPos === 'fixed' ? 'fixed' : ancPos === 'absolute' ? 'absolute' : 'normal';
        }
      } else {
        if (ancPos === 'fixed') positionMode = 'fixed';
        else if (ancPos === 'absolute') positionMode = 'absolute';
      }

      if (ancestorClips) {
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
            return true;
          }
        }
      }
    }
    ancestor = composedParent(ancestor);
  }
  return false;
}

function getActionableBlockReason(
  el: Element,
  action: string,
  options?: { checkClipping?: boolean },
): string | null {
  if (!el.isConnected || el.ownerDocument !== document) return 'disconnected';
  const checkClipping = options?.checkClipping !== false;

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
    if (checkClipping && isClippedOutOfView(el, rect, win)) return 'out_of_view';
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

  let blockReason = getActionableBlockReason(el, action, { checkClipping: false });
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
  // Verify clipping after scrolling the target into view so scrollable offscreen controls
  // succeed while permanently clipped elements still report out_of_view.
  const win = el.ownerDocument?.defaultView || window;
  if (isClippedOutOfView(el, prevRect, win)) {
    return {
      ...initialCoords,
      success: false,
      actionable: false,
      notFound: false,
      reason: 'out_of_view',
      error: `Element [${index}] is not actionable (out_of_view)`,
    };
  }
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
    if (composedClosest(el, 'button, a, [role="button"], [onclick]')) return true;
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

  // Clamp in the element's own frame before projecting into each parent viewport.
  // A subframe is often much smaller than its top-level offset, so subtracting that
  // offset from the subframe viewport would collapse every crop to one pixel.
  const hasViewportWidth = typeof window.innerWidth === 'number' && window.innerWidth > 0;
  const hasViewportHeight = typeof window.innerHeight === 'number' && window.innerHeight > 0;
  const localLeft = Math.max(0, rawRect.left - effectivePadding);
  const localTop = Math.max(0, rawRect.top - effectivePadding);
  const localRight = hasViewportWidth
    ? Math.min(window.innerWidth, rawRect.right + effectivePadding)
    : rawRect.right + effectivePadding;
  const localBottom = hasViewportHeight
    ? Math.min(window.innerHeight, rawRect.bottom + effectivePadding)
    : rawRect.bottom + effectivePadding;
  const left = Math.max(0, Math.round(localLeft + frameOffsetX));
  const top = Math.max(0, Math.round(localTop + frameOffsetY));
  const width = Math.max(1, Math.round(localRight - localLeft));
  const height = Math.max(1, Math.round(localBottom - localTop));

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
  selectValues?: string[],
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

  if (selectValues) {
    if (!(el instanceof HTMLSelectElement) || !el.multiple || el.disabled || !selectValues.length) {
      return { success: false, index, error: 'Target must be an enabled multiple select.' };
    }
    const wanted = new Set(selectValues);
    const options = Array.from(el.options);
    const selectable = options.filter(
      (option) =>
        wanted.has(option.value) &&
        !option.disabled &&
        !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
    );
    if (selectable.length !== wanted.size) {
      return { success: false, index, error: 'Each value must identify one enabled option.' };
    }
    for (const option of options) option.selected = selectable.includes(option);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    const selected = Array.from(el.selectedOptions, (option) => option.value);
    const committed =
      selected.length === wanted.size && selected.every((value) => wanted.has(value));
    return {
      success: committed,
      committed,
      index,
      tagName: 'select',
      filledText: selected.join(', '),
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
