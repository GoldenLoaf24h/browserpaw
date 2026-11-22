import { type IndexedElement, type PrunedDOMTreeResult, type ScrollInfo } from 'chrome-mcp-shared';
import {
  derefElement,
  getIsolatedIndexMap,
  indexElement,
  pruneDetachedIndices,
  safeClickPointWeakMap,
} from './dom-indexer/index-state';
import { samplePage } from './dom-indexer/page-sampling';
import {
  createDomQueryCache,
  getCachedBoundingClientRect,
  getCachedComputedStyle,
  type DomQueryCache,
} from './dom-indexer/dom-cache';
import {
  composedChildNodes,
  composedChildren,
  composedClosest,
  composedContainingElement,
  composedContains,
  composedParent,
  extractComposedVisibleText,
  getShadowRoot,
  isBlockLikeElement,
  isCustomElement,
  isElementHiddenInComposedTree,
} from './dom-indexer/composed-dom';
import {
  parentElementOrShadowHost,
  querySelectorAllDeep,
  querySelectorDeep,
  splitByCharacterUnlessQuoted,
  splitSelectorSafely,
} from './dom-indexer/deep-query';
import {
  inPageRealignHighlights,
  inPageRenderHighlights,
  inPageScrollToIndex,
} from './dom-indexer/highlights';
import {
  buildScopedScrollInfo,
  computeInteractionScope,
  detectActiveModalBlocker,
  inPageEnsureModalFocus,
  type ActiveModalBlockerInfo,
  type InteractionScopeInfo,
} from './dom-indexer/modal-scope';
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
import {
  cleanAndNormalizeText,
  inPageVerifyActiveElement,
  inPageGetActiveElementSummary,
  inPageSelectCustomCombobox,
  inPageVerifyInputCommitment,
} from './dom-indexer/input-commitment';
import {
  inPageFindSmartScrollTarget,
  inPagePerformSmartScroll,
  type SmartScrollTargetInfo,
} from './dom-indexer/smart-scroll';
import { renderCompactElementLine } from './dom-indexer/compact-renderer';
import { isClippedOutOfView } from './dom-indexer/inpage-interactions';

export {
  derefElement,
  findExistingElementIndex,
  getIsolatedIndexMap,
  INDEX_NAMESPACE_SIZE,
  indexElement,
  inPageSetIndexNamespace,
  pruneDetachedIndices,
  safeClickPointWeakMap,
  wrapElement,
} from './dom-indexer/index-state';
export {
  createDomQueryCache,
  getCachedBoundingClientRect,
  getCachedComputedStyle,
  type DomQueryCache,
} from './dom-indexer/dom-cache';
export {
  composedChildNodes,
  composedChildren,
  composedClosest,
  composedContainingElement,
  composedContains,
  composedParent,
  extractComposedVisibleText,
  getShadowRoot,
  isBlockLikeElement,
  isCustomElement,
  isElementHiddenInComposedTree,
} from './dom-indexer/composed-dom';
export {
  parentElementOrShadowHost,
  querySelectorAllDeep,
  querySelectorDeep,
  splitByCharacterUnlessQuoted,
  splitSelectorSafely,
};
export { inPageScrollUntilFound } from './dom-indexer/scroll-until-found';
export { inPageRealignHighlights, inPageRenderHighlights, inPageScrollToIndex };
export {
  buildScopedScrollInfo,
  computeInteractionScope,
  detectActiveModalBlocker,
  inPageEnsureModalFocus,
  type ActiveModalBlockerInfo,
  type InteractionScopeInfo,
};
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
export {
  inPageGetElementCoordinates,
  inPageWaitForActionable,
  inPageSnapCoordinate,
  inPageArmDeliveryProbe,
  inPageReadDeliveryProbe,
  inPageGetFrameOrigin,
  inPageGetIndexCropRect,
  inPagePointerDragMove,
  inPageFocusIndex,
  inPageInteractIndex,
  inPagePrepareAppend,
  inPageFillIndex,
  type ActionableResult,
} from './dom-indexer/inpage-interactions';
/**
 * Standard structured self-healing guidance when an element is not found or expired
 */
export const DIAGNOSTIC_REFRESH_GUIDANCE = `ACTION REQUIRED: Please call 'browserpaw observe' to refresh the index tree before re-attempting interaction`;

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
    el.getAttribute('contenteditable') === '' ||
    el.getAttribute('contenteditable') === 'plaintext-only';
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

/**
 * Shadow DOM and composed tree traversal helpers.
 * These enable penetrating Shadow DOM boundaries to find the true interactive target.
 */
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
        extractComposedVisibleText(querySelectorDeep('h1,h2,h3,h4,h5,h6', modal), { maxLen: 80 });
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
export function isInteractiveSvgNode(
  el: Element,
  style?: CSSStyleDeclaration,
  parentHasPointer = false,
): boolean {
  if (!el || (typeof Element !== 'undefined' && !(el instanceof Element) && !(el as any).tagName))
    return false;
  const tag = (el.tagName || '').toLowerCase();
  const isSvg =
    tag === 'svg' ||
    /^(path|g|rect|circle|line|polygon|polyline|ellipse|text|tspan|use|image)$/i.test(tag) ||
    el.namespaceURI === 'http://www.w3.org/2000/svg' ||
    Boolean(composedClosest(el, 'svg'));
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
  if (
    style &&
    ((!parentHasPointer && style.cursor === 'pointer') || /grab|grabbing|move/i.test(style.cursor))
  )
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

export function computeScopeHash(text: string): string {
  if (!text) return '';
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) + hash + text.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16);
}

function computeElementScopeHash(el: Element): string {
  try {
    const container =
      composedClosest(el, 'form,dialog,[role="dialog"],article,li,tr,[role="row"]') ||
      composedParent(el);
    const scopeText = container ? extractComposedVisibleText(container, { maxLen: 1000 }) : '';
    return scopeText ? computeScopeHash(scopeText) : '';
  } catch {
    return '';
  }
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
const PRUNER_NON_INFORMATIONAL_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'meta',
  'link',
  'template',
]);
const PRUNER_ATTRS_TO_KEEP = [
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
  'readonly',
  'aria-readonly',
  'contenteditable',
  'aria-checked',
  'aria-selected',
  'aria-expanded',
  'aria-pressed',
  'aria-haspopup',
  'aria-current',
  'aria-valuenow',
  'aria-invalid',
  'aria-required',
  'aria-describedby',
  'aria-errormessage',
] as const;
const FORM_CONSTRAINT_ATTRS = ['pattern', 'min', 'max', 'minlength', 'maxlength', 'step'] as const;

export function extractCleanElementText(
  el: Element,
  maxLen = 120,
  domCache?: DomQueryCache,
): string {
  if (!el) return '';
  const tag = (el.tagName || '').toLowerCase();
  let text = '';

  if (tag === 'select') {
    const selectEl = el as HTMLSelectElement;
    text = (selectEl.selectedOptions?.[0]?.text || selectEl.value || '').trim();
  } else {
    text = extractComposedVisibleText(el, { maxLen, cache: domCache });
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
              const innerRoleImg = querySelectorDeep('[role="img"][aria-label]', el)
                ?.getAttribute('aria-label')
                ?.trim();
              const svgAria = querySelectorDeep('svg[aria-label]', el)
                ?.getAttribute('aria-label')
                ?.trim();
              const svgTitle = querySelectorDeep('svg title, svg desc', el)?.textContent?.trim();
              const anyInnerAria = querySelectorDeep('[aria-label]', el)
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
  if (!text) {
    const parent = composedParent(el);
    if (parent && isCustomElement(parent)) {
      const parentLabel =
        parent.getAttribute('aria-label') ||
        parent.getAttribute('action') ||
        parent.getAttribute('data-action') ||
        parent.getAttribute('data-testid');
      if (parentLabel && typeof parentLabel === 'string') {
        text = parentLabel.replace(/[-_]/g, ' ').trim();
      }
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
  if (isElementHiddenInComposedTree(ref, win)) return '';
  return extractComposedVisibleText(ref, { maxLen });
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
    el.getAttribute('contenteditable') === 'plaintext-only' ||
    (typeof (el as HTMLElement).isContentEditable === 'boolean' &&
      (el as HTMLElement).isContentEditable);

  // 1. Search Box Detection
  const isSearchType = tag === 'input' && type === 'search';
  const isSearchRole = role === 'searchbox' || role === 'search';
  const hasSearchAncestor = Boolean(
    composedClosest(el, '[role="search"], form[role="search"], .search-box, .search-form'),
  );
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
  domCache?: DomQueryCache,
): number {
  if (!candidates || candidates.length < 3) return 0;

  // Group candidate elements by their closest ancestor card container
  const cardMap = new Map<Element, Array<(typeof candidates)[0]>>();

  for (const cand of candidates) {
    if (cand.isVirtualMarker || cand.isFile || !cand.node || !(cand.node instanceof Element)) {
      continue;
    }
    if ((cand as any).isTableStructure) continue;

    const card = composedClosest(
      cand.node,
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
    const hasFormInputs = querySelectorDeep(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], [role="combobox"], [role="searchbox"]',
      card,
    );
    if (hasFormInputs) continue;

    // Safety Guard 2: Card dimensions should be reasonable (not a giant page section)
    const cardRect = getCachedBoundingClientRect(card, domCache);
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

      const t = extractCleanElementText(it.node, maxTextLength, domCache);
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
      (it) => it.tag === 'a' && extractComposedVisibleText(it.node, { maxLen: 40 }).length > 0,
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
            if (composedContains(textEl, el)) return true;
          }
        }
      }

      for (const sel of standardSelectors) {
        try {
          if (isRoot) {
            if (composedClosest(el, sel)) return true;
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

  const interactiveRoles = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'option',
    'textbox',
    'combobox',
    'searchbox',
    'switch',
    'slider',
    'spinbutton',
  ]);

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
  const domCache = createDomQueryCache();

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
      el.getAttribute('contenteditable') === '' ||
      el.getAttribute('contenteditable') === 'plaintext-only'
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
      el.hasAttribute('aria-haspopup') ||
      el.hasAttribute('aria-expanded') ||
      el.hasAttribute('aria-pressed')
    ) {
      return true;
    }
    if (isInteractiveSvgNode(el, style, parentHasPointer)) {
      return true;
    }
    // Web Component icon buttons and action triggers (e.g. Reddit faceplate-tracker, faceplate-button, shreddit action rows)
    if (
      (el.hasAttribute('aria-label') || el.hasAttribute('title')) &&
      (isCustomElement(el) ||
        (!parentHasPointer && style.cursor === 'pointer') ||
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
    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(winWidth, rect.right);
    const visibleBottom = Math.min(winHeight, rect.bottom);
    const visibleWidth = visibleRight - visibleLeft;
    const visibleHeight = visibleBottom - visibleTop;

    const defaultCenter = {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      offsetX: rect.width / 2,
      offsetY: rect.height / 2,
    };

    if (rect.width <= 0 || rect.height <= 0) {
      return { isFullyOccluded: false, isOccluded: false, safeClickPoint: defaultCenter };
    }

    if (visibleWidth <= 0 || visibleHeight <= 0) {
      return { isFullyOccluded: false, isOccluded: false, safeClickPoint: defaultCenter };
    }

    const makeSamplePoint = (px: number, py: number) => ({
      x: Math.round(px),
      y: Math.round(py),
      offsetX: px - rect.left,
      offsetY: py - rect.top,
    });

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
          topEl = deepElementFromPoint(px, py);
          if (!topEl && typeof document.elementFromPoint === 'function') {
            topEl = document.elementFromPoint(px, py);
          }
        } catch {}

        if (!topEl || topEl === el || composedContains(el, topEl) || composedContains(topEl, el)) {
          const pt = makeSamplePoint(px, py);
          clearPoints.push(pt);
          if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
          continue;
        }

        try {
          const topStyle = getCachedComputedStyle(topEl, window, domCache);
          if (!topStyle) continue;
          const isVisible = topStyle.display !== 'none' && topStyle.visibility !== 'hidden';
          const isPointerBlocking = topStyle.pointerEvents !== 'none';
          const isBackdropOrOverlay =
            topEl.matches?.(
              'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal, .modal-backdrop, [class*="backdrop"], [class*="mask"], [class*="overlay"]',
            ) ||
            composedClosest(
              topEl,
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

        const pt = makeSamplePoint(px, py);
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
        safePoint = centerClearPoint;
      } else {
        const avgOffsetX = clearPoints.reduce((sum, p) => sum + p.offsetX, 0) / clearPoints.length;
        const avgOffsetY = clearPoints.reduce((sum, p) => sum + p.offsetY, 0) / clearPoints.length;
        const avgX = Math.round(rect.left + avgOffsetX);
        const avgY = Math.round(rect.top + avgOffsetY);

        let centroidClear = false;
        try {
          const topAtAvg =
            deepElementFromPoint(avgX, avgY) ||
            (typeof document.elementFromPoint === 'function'
              ? document.elementFromPoint(avgX, avgY)
              : null);
          if (
            !topAtAvg ||
            topAtAvg === el ||
            composedContains(el, topAtAvg) ||
            composedContains(topAtAvg, el)
          ) {
            centroidClear = true;
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
      composedChildren(el).length === 0 &&
      !PRUNER_NON_INFORMATIONAL_TAGS.has(tag) &&
      extractComposedVisibleText(el, { maxLen: 16, cache: domCache }).length > 0
    ) {
      return true;
    }
    return false;
  }

  const shouldVirtualize =
    options?.virtualizeViewport === true ||
    (options?.virtualizeViewport !== false && !options?.selector && !options?.scope);
  const focusForVirtualization = getDeepActiveElement();

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
      roots = allRoots.filter(
        (r) => !allRoots.some((other) => other !== r && composedContains(other, r)),
      );
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

  const {
    candidates,
    assets,
    assetRegistry,
    totalOriginalNodes,
    selectOptionOmissions,
    virtualizedCount,
    virtualizedSummary,
  } = samplePage({
    roots,
    winWidth,
    winHeight,
    threshold,
    shouldVirtualize,
    focusForVirtualization,
    isExcluded,
    isInteractive,
    isAdOrTrackingElement,
    isInformationalNode,
    getShadowRoot,
    isInteractiveSvgNode,
    isCustomElement,
    getTableObservationRole,
    composedContains,
    domCache,
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
  const descendantShape = (root: Element, seen = new Set<Element>()): string | null => {
    const cached = descendantShapeCache.get(root);
    if (cached !== undefined) return cached;
    if (seen.has(root)) return null;
    seen.add(root);

    let shape: string | null = null;
    for (const child of composedChildren(root)) {
      if (SHAPE_DESCENDANT_TAGS.has(child.tagName.toLowerCase())) {
        shape = ownVisualShape(child);
        if (shape !== null) break;
      }
      shape = descendantShape(child, seen);
      if (shape !== null) break;
    }

    descendantShapeCache.set(root, shape);
    return shape;
  };

  // Phase 2: Decoupled batch hit-testing & indexing pass (eliminates layout thrashing)
  let flattenedCardCount = 0;
  if (options?.flattenCards !== false) {
    flattenedCardCount = flattenCompositeCards(candidates as any, maxTextLength, domCache);
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
    for (const attr of PRUNER_ATTRS_TO_KEEP) {
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
    const scopeHash = computeElementScopeHash(cand.node);
    if (scopeHash) {
      attributes['data-scope-hash'] = scopeHash;
    }

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
      cand.node.getAttribute('contenteditable') === '' ||
      cand.node.getAttribute('contenteditable') === 'plaintext-only'
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
    if (
      (cand.node as any).readOnly === true ||
      cand.node.hasAttribute('readonly') ||
      cand.node.getAttribute('aria-readonly') === 'true'
    ) {
      attributes['readonly'] = 'true';
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
        /(auto|scroll)/.test(getCachedComputedStyle(cand.node, window, domCache)?.overflowY || '')
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
      for (const attr of FORM_CONSTRAINT_ATTRS) {
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
      if (composedClosest(cand.node, 'dialog, [role="dialog"], [role="alertdialog"], .modal')) {
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
        : extractCleanElementText(cand.node, maxTextLength, domCache);
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
      const readPath = `browserpaw select ${assignedIndex}`;
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
      `[Scroll Guidance: ${pages_up} pages above, ${pages_down} pages below. Use browserpaw click / scroll to reveal more content.]\n` +
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

  const clippedOut =
    initialRect.width > 0 && initialRect.height > 0 && isClippedOutOfView(el, initialRect, win);

  if ((!inViewport || clippedOut) && allowScroll) {
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
            if (
              ((scrollReq.deltaX !== 0 && canScrollX) || (scrollReq.deltaY !== 0 && canScrollY)) &&
              typeof ancestor.scrollBy === 'function'
            ) {
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
      } else if (!inViewport) {
        try {
          if (typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
          }
        } catch {}
      }
    } else if (!inViewport) {
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
  const candidateSafeX = safePoint ? rect.left + safePoint.offsetX : NaN;
  const candidateSafeY = safePoint ? rect.top + safePoint.offsetY : NaN;
  const safePointValid =
    Boolean(safePoint) &&
    Number.isFinite(candidateSafeX) &&
    Number.isFinite(candidateSafeY) &&
    safePoint!.offsetX >= 0 &&
    safePoint!.offsetX <= Math.max(rect.width, 1) &&
    safePoint!.offsetY >= 0 &&
    safePoint!.offsetY <= Math.max(rect.height, 1) &&
    (vw <= 0 || (candidateSafeX >= 0 && candidateSafeX <= vw)) &&
    (vh <= 0 || (candidateSafeY >= 0 && candidateSafeY <= vh));
  if (safePointValid) {
    clickX = candidateSafeX;
    clickY = candidateSafeY;
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
      const interactiveEl = composedClosest(
        el,
        'button, a, input, select, textarea, [role="button"]',
      );
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
    scopeHash: computeElementScopeHash(el) || undefined,
  };
}

export { inPageWaitForDOMSettle } from '@/utils/action-watchdog';
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
