import { describeHitTarget } from '../dom-indexer';

export interface DismissedOverlayInfo {
  id?: string;
  className?: string;
  role?: string;
  title?: string;
  buttonText?: string;
  buttonSelector?: string;
  action: 'clicked_close_button' | 'dispatched_escape' | 'synthetic_attempted_still_present';
  x?: number;
  y?: number;
  dismissed?: boolean;
  needsPhysicalFallback?: boolean;
}

export interface DismissOverlaysResult {
  dismissedCount: number;
  overlays: DismissedOverlayInfo[];
}

/**
 * Fast in-page dismiss detector for visible top-level dialogs, marketing popups,
 * promotional modals, and cookie banners.
 */
export function inPageDismissOverlays(options?: { maxDismissals?: number }): DismissOverlaysResult {
  const maxCount = options?.maxDismissals ?? 5;
  const result: DismissOverlaysResult = {
    dismissedCount: 0,
    overlays: [],
  };

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return result;
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!win) return result;

  const candidateSelectors = [
    'dialog[open]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '[popover]',
    '[class*="modal"]',
    '[class*="popup"]',
    '[class*="dialog"]',
    '[class*="mask"]',
    '[class*="overlay"]',
    '[class*="coupon"]',
    '[class*="marketing"]',
    '[class*="banner"]',
    '[id*="modal"]',
    '[id*="popup"]',
    '[id*="dialog"]',
    '[id*="overlay"]',
  ];

  const foundElements = new Set<Element>();
  function queryDeep(root: ParentNode, depth = 0): void {
    if (depth > 5) return;
    try {
      const matched = root.querySelectorAll(candidateSelectors.join(', '));
      for (const el of Array.from(matched)) {
        foundElements.add(el);
      }
    } catch {}
    try {
      const hosts = root.querySelectorAll('*');
      for (const h of Array.from(hosts)) {
        const sr = (h as HTMLElement).shadowRoot;
        if (sr) queryDeep(sr, depth + 1);
      }
    } catch {}
  }
  queryDeep(doc);

  // Also check top-level positioned elements with high z-index (>= 1000)
  try {
    const topLevelElements = doc.querySelectorAll(
      'body > div, body > section, body > aside, [style*="z-index"], [style*="position: fixed"], [style*="position: absolute"]',
    );
    for (const el of Array.from(topLevelElements)) {
      let style: CSSStyleDeclaration;
      try {
        style = win.getComputedStyle(el);
      } catch {
        continue;
      }
      const pos = style.position;
      if (pos === 'fixed' || pos === 'absolute') {
        const z = parseInt(style.zIndex, 10);
        if (!isNaN(z) && z >= 1000) {
          foundElements.add(el);
        }
      }
    }
  } catch {}

  interface QualifiedOverlay {
    element: HTMLElement;
    zIndex: number;
    title?: string;
  }

  const qualified: QualifiedOverlay[] = [];

  for (const el of foundElements) {
    if (!(el instanceof (win as any).HTMLElement)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;

    // Never dismiss critical authentication/login dialogs containing password inputs
    if (el.querySelector('input[type="password"]')) continue;

    let style: CSSStyleDeclaration;
    try {
      style = win.getComputedStyle(el);
    } catch {
      continue;
    }

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none' ||
      parseFloat(style.opacity || '1') <= 0.05
    ) {
      continue;
    }

    const rect = el.getBoundingClientRect();
    const htmlEl = el as HTMLElement;
    const w = rect.width || htmlEl.offsetWidth || 0;
    const h = rect.height || htmlEl.offsetHeight || 0;
    if (w < 40 || h < 40) continue;

    let z = 0;
    if (style.zIndex && style.zIndex !== 'auto') {
      const parsedZ = parseInt(style.zIndex, 10);
      if (!isNaN(parsedZ)) z = parsedZ;
    }

    const title =
      el.getAttribute('aria-label') ||
      el
        .querySelector('h1, h2, h3, [role="heading"], [class*="title"]')
        ?.textContent?.trim()
        ?.slice(0, 50);

    qualified.push({
      element: htmlEl,
      zIndex: z,
      title: title || undefined,
    });
  }

  // Sort descending by z-index so top-most overlays are dismissed first
  qualified.sort((a, b) => b.zIndex - a.zIndex);

  const clickedCloseButtons = new Set<Element>();
  const dismissedContainers = new Set<Element>();

  const closeTextExactRegex =
    /^(关闭|跳过|我知道了|知道了|我已知晓|放弃优惠|残忍拒绝|稍后再说|暂不参与|收下留情|x|×|✕|✖|close|dismiss|cancel|skip|not now|later|no thanks)$/i;
  const closeSubstrRegex =
    /(关闭|跳过|残忍拒绝|放弃优惠|稍后再说|暂不参与|close|dismiss|cancel|skip)/i;
  const closeAttrRegex = /(close|dismiss|cancel|关闭|跳过)/i;
  const closeClassRegex =
    /(close|dismiss|cancel|btn-close|close-btn|close-icon|headerbtn|modal-close|dialog-close|popup-close|drawer-close|banner-close|toast-close|shut|cha)/i;

  for (const q of qualified) {
    if (result.dismissedCount >= maxCount) break;
    const container = q.element;

    // Check if this container or its ancestor/descendant was already dismissed in this pass
    if (
      dismissedContainers.has(container) ||
      Array.from(dismissedContainers).some((d) => d.contains(container) || container.contains(d))
    ) {
      continue;
    }

    try {
      const curStyle = win.getComputedStyle(container);
      if (curStyle.display === 'none' || curStyle.visibility === 'hidden') continue;
    } catch {
      continue;
    }

    const candidates: HTMLElement[] = [];
    function findCandidatesDeep(root: ParentNode, depth = 0): void {
      if (depth > 4) return;
      try {
        const found = Array.from(
          root.querySelectorAll(
            'button, [role="button"], a, i, span, svg, div[class*="close" i], div[class*="btn" i], div[class*="shut" i], div[class*="cha" i], [class*="headerbtn" i], [aria-label], [title], [data-testid], [data-dismiss], [data-bs-dismiss], [data-modal-hide], [data-dismiss-target], [data-radix-dialog-close]',
          ),
        ) as HTMLElement[];
        candidates.push(...found);
      } catch {}
      try {
        const hosts = root.querySelectorAll('*');
        for (const h of Array.from(hosts)) {
          const sr = (h as HTMLElement).shadowRoot;
          if (sr) findCandidatesDeep(sr, depth + 1);
        }
      } catch {}
    }
    findCandidatesDeep(container);

    interface ScoredCandidate {
      element: HTMLElement;
      score: number;
      buttonText: string;
    }
    const scoredCandidates: ScoredCandidate[] = [];

    const containerRect = container.getBoundingClientRect();

    for (const c of candidates) {
      if (!(c instanceof (win as any).HTMLElement)) continue;
      if (clickedCloseButtons.has(c)) continue;

      let cStyle: CSSStyleDeclaration;
      try {
        cStyle = win.getComputedStyle(c);
      } catch {
        continue;
      }
      if (
        cStyle.display === 'none' ||
        cStyle.visibility === 'hidden' ||
        cStyle.pointerEvents === 'none'
      ) {
        continue;
      }

      const cRect = c.getBoundingClientRect();
      const w = cRect.width || c.offsetWidth || 0;
      const h = cRect.height || c.offsetHeight || 0;
      if (w === 0 && h === 0) continue;

      const rawText = (c.textContent || (c as HTMLInputElement).value || '').trim();
      const ariaLabel = c.getAttribute('aria-label') || '';
      const title = c.getAttribute('title') || '';
      const className = typeof c.className === 'string' ? c.className : '';
      const dataDismiss = c.getAttribute('data-dismiss') || '';
      const dataBsDismiss = c.getAttribute('data-bs-dismiss') || '';
      const dataModalHide = c.getAttribute('data-modal-hide') || '';
      const dataDismissTarget = c.getAttribute('data-dismiss-target') || '';
      const hasRadixClose = c.hasAttribute('data-radix-dialog-close');
      const dataTestId = c.getAttribute('data-testid') || '';

      const tag = c.tagName.toLowerCase();
      const role = (c.getAttribute('role') || '').toLowerCase();
      const isInteractiveTag =
        tag === 'button' ||
        role === 'button' ||
        tag === 'a' ||
        (tag === 'input' &&
          (c.getAttribute('type') === 'button' || c.getAttribute('type') === 'submit'));
      const isClickable =
        isInteractiveTag ||
        c.hasAttribute('onclick') ||
        cStyle.cursor === 'pointer' ||
        (typeof (c as any).tabIndex === 'number' && (c as any).tabIndex >= 0);

      let score = 0;
      let detectedText = '';

      // 1. Explicit data-dismiss attribute
      if (
        dataDismiss === 'modal' ||
        dataDismiss === 'dialog' ||
        dataBsDismiss === 'modal' ||
        Boolean(dataModalHide) ||
        Boolean(dataDismissTarget) ||
        hasRadixClose
      ) {
        score += 100;
        detectedText = ariaLabel || title || rawText || 'dismiss';
      }

      // 2. Exact text match
      const isExactText = closeTextExactRegex.test(rawText);
      const isSymbol = /^[x×✕✖+-]$/i.test(rawText);
      if (isExactText) {
        if (isInteractiveTag) {
          score += 95;
        } else if (isClickable || isSymbol) {
          score += 85;
        } else {
          score += 60;
        }
        detectedText = (!isSymbol && rawText) || ariaLabel || title || rawText || 'close';
      }

      // 3. ARIA / Title / TestID match
      if (
        closeAttrRegex.test(ariaLabel) ||
        closeAttrRegex.test(title) ||
        closeAttrRegex.test(dataTestId)
      ) {
        if (isInteractiveTag) {
          score += 90;
        } else if (isClickable) {
          score += 80;
        } else {
          score += 55;
        }
        detectedText = detectedText || ariaLabel || title || 'close';
      }

      // 4. Class name match
      if (closeClassRegex.test(className)) {
        if (isInteractiveTag) {
          score += 85;
        } else if (isClickable) {
          score += 75;
        } else {
          score += 50;
        }
        detectedText = detectedText || ariaLabel || title || className || 'close';
      }

      // 5. SVG child match
      const svgChild = c.querySelector('svg');
      if (svgChild) {
        const svgClass = svgChild.getAttribute('class') || '';
        const svgAria = svgChild.getAttribute('aria-label') || '';
        if (closeClassRegex.test(svgClass) || closeAttrRegex.test(svgAria)) {
          score += isInteractiveTag ? 80 : isClickable ? 70 : 50;
          detectedText = detectedText || svgAria || 'svg_close';
        }
      }

      // 6. Substring text match (STRICT: ONLY for clickable/interactive elements with short text <= 8 chars)
      // Never match an informational <span> or <div> like "Limited time offer, check before closing"!
      if (
        !isExactText &&
        isClickable &&
        rawText.length > 0 &&
        rawText.length <= 8 &&
        closeSubstrRegex.test(rawText)
      ) {
        score += isInteractiveTag ? 50 : 35;
        detectedText = detectedText || rawText;
      }

      // Bonuses:
      if (score >= 40) {
        // Bonus for real button tags
        if (isInteractiveTag) score += 10;
        // Bonus for top-right corner positioning (classic modal close button)
        if (
          containerRect.width > 0 &&
          containerRect.height > 0 &&
          cRect.top <= containerRect.top + 80 &&
          cRect.right >= containerRect.right - 80
        ) {
          score += 15;
        }

        scoredCandidates.push({
          element: c,
          score,
          buttonText: detectedText || rawText || className || 'close',
        });
      }
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    const bestCandidate = scoredCandidates[0];

    if (bestCandidate) {
      const closeButton = bestCandidate.element;
      const buttonText = bestCandidate.buttonText;
      const bRect = closeButton.getBoundingClientRect();
      const clickX = Math.round(bRect.left + (bRect.width || closeButton.offsetWidth || 20) / 2);
      const clickY = Math.round(bRect.top + (bRect.height || closeButton.offsetHeight || 20) / 2);

      const eventInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX: clickX,
        clientY: clickY,
      };

      try {
        if (typeof (win as any).PointerEvent !== 'undefined') {
          try {
            closeButton.dispatchEvent(
              new (win as any).PointerEvent('pointerdown', {
                ...eventInit,
                pointerType: 'mouse',
              } as any),
            );
          } catch {}
        }
        const MouseEv = (win as any).MouseEvent || MouseEvent;
        try {
          closeButton.dispatchEvent(new MouseEv('mousedown', eventInit));
        } catch {}
        if (typeof (win as any).PointerEvent !== 'undefined') {
          try {
            closeButton.dispatchEvent(
              new (win as any).PointerEvent('pointerup', {
                ...eventInit,
                pointerType: 'mouse',
              } as any),
            );
          } catch {}
        }
        try {
          closeButton.dispatchEvent(new MouseEv('mouseup', eventInit));
        } catch {}
        let clickFired = false;
        try {
          closeButton.dispatchEvent(new MouseEv('click', eventInit));
          clickFired = true;
        } catch {}
        if (!clickFired && typeof closeButton.click === 'function') {
          try {
            closeButton.click();
          } catch {}
        }
      } catch {}

      clickedCloseButtons.add(closeButton);
      // Verify whether the overlay was actually dismissed / removed from visual viewport
      const isStillPresent = (() => {
        if (!container.isConnected) return false;
        try {
          const s = win.getComputedStyle(container);
          if (
            s.display === 'none' ||
            s.visibility === 'hidden' ||
            s.pointerEvents === 'none' ||
            parseFloat(s.opacity || '1') <= 0.05
          ) {
            return false;
          }
        } catch {
          return false;
        }
        const r = container.getBoundingClientRect();
        if (
          (r.width || container.offsetWidth || 0) < 10 ||
          (r.height || container.offsetHeight || 0) < 10
        ) {
          return false;
        }
        try {
          const topEl = doc.elementFromPoint(clickX, clickY);
          if (!topEl || !container.contains(topEl)) {
            return false;
          }
        } catch {}
        return true;
      })();

      if (!isStillPresent) {
        dismissedContainers.add(container);
        result.dismissedCount++;
      }

      result.overlays.push({
        id: container.id || undefined,
        className:
          typeof container.className === 'string' ? container.className.slice(0, 100) : undefined,
        role: container.getAttribute('role') || container.tagName.toLowerCase(),
        title: q.title,
        buttonText,
        buttonSelector: describeHitTarget(closeButton),
        action: isStillPresent ? 'synthetic_attempted_still_present' : 'clicked_close_button',
        x: clickX,
        y: clickY,
        dismissed: !isStillPresent,
        needsPhysicalFallback: isStillPresent,
      });
    } else {
      // If modal qualifies (role=dialog or high z-index), try Escape key
      if (
        q.zIndex >= 1000 ||
        container.getAttribute('role') === 'dialog' ||
        container.tagName.toLowerCase() === 'dialog'
      ) {
        try {
          const escDown = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          const escUp = new KeyboardEvent('keyup', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
            composed: true,
          });

          const target =
            doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : container;
          target.dispatchEvent(escDown);
          target.dispatchEvent(escUp);
          if (doc.body && target !== doc.body) {
            doc.body.dispatchEvent(escDown);
            doc.body.dispatchEvent(escUp);
          }

          dismissedContainers.add(container);
          result.dismissedCount++;
          result.overlays.push({
            id: container.id || undefined,
            className:
              typeof container.className === 'string'
                ? container.className.slice(0, 100)
                : undefined,
            role: container.getAttribute('role') || container.tagName.toLowerCase(),
            title: q.title,
            action: 'dispatched_escape',
          });
        } catch {}
      }
    }
  }

  return result;
}
