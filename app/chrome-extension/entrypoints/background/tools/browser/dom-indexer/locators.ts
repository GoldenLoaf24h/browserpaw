import {
  detectEditorSemantics,
  getSameRootReference,
  extractElementLocationDetails,
} from '../dom-indexer';
import { composedParent } from './composed-dom';
import { querySelectorAllDeep } from './deep-query';
import {
  createDomQueryCache,
  getCachedBoundingClientRect,
  getCachedComputedStyle,
  type DomQueryCache,
} from './dom-cache';

export function isLocatorCandidateVisible(el: Element, cache?: DomQueryCache): boolean {
  const view = el.ownerDocument?.defaultView || window;
  const ownStyle = getCachedComputedStyle(el, view, cache);
  const visibility = ownStyle?.visibility;
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  const subtreeHiddenMap = cache?.locatorSubtreeHidden ?? null;
  const trail: Element[] = [];
  let hidden = false;
  for (let current: Element | null = el; current; current = composedParent(current)) {
    if (subtreeHiddenMap && subtreeHiddenMap.has(current)) {
      hidden = subtreeHiddenMap.get(current) === true;
      break;
    }
    trail.push(current);
    if (current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') {
      hidden = true;
      break;
    }
    const style = current === el ? ownStyle : getCachedComputedStyle(current, view, cache);
    if (style && (style.display === 'none' || parseFloat(style.opacity || '1') <= 0)) {
      hidden = true;
      break;
    }
  }
  if (subtreeHiddenMap) {
    for (let index = 0; index < trail.length; index++) {
      subtreeHiddenMap.set(trail[index], hidden);
    }
  }
  if (hidden) return false;
  const rect = getCachedBoundingClientRect(el, cache);
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function inPageLocateBySelector(
  selector: string,
  selectorType?: 'css' | 'xpath',
): {
  success: boolean;
  matchCount?: number;
  notFound?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tagName?: string;
  text?: string;
  value?: string;
  frameOffsetX?: number;
  frameOffsetY?: number;
  error?: string;
} {
  if (!selector || typeof selector !== 'string') {
    return { success: false, error: 'Selector parameter must be a non-empty string' };
  }

  try {
    const isXPath =
      selectorType === 'xpath' ||
      selector.startsWith('//') ||
      selector.startsWith('(') ||
      selector.startsWith('/html');

    let rawElements: Element[] = [];

    if (isXPath && typeof document !== 'undefined' && typeof document.evaluate === 'function') {
      try {
        const xRes = document.evaluate(
          selector,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        for (let i = 0; i < xRes.snapshotLength; i++) {
          const node = xRes.snapshotItem(i);
          if (node instanceof Element) {
            rawElements.push(node);
          }
        }
      } catch (xpathErr) {
        return {
          success: false,
          error: `XPath evaluation error: ${xpathErr instanceof Error ? xpathErr.message : String(xpathErr)}`,
        };
      }
    } else if (typeof document !== 'undefined') {
      const hasCustomShadowCombinator =
        selector.includes('>>>') || selector.includes('/deep/') || selector.includes(' >> ');

      let mainElements: Element[] = [];
      if (!hasCustomShadowCombinator) {
        try {
          mainElements = Array.from(document.querySelectorAll(selector));
        } catch (cssErr) {
          return {
            success: false,
            error: `Invalid CSS selector "${selector}": ${cssErr instanceof Error ? cssErr.message : String(cssErr)}`,
          };
        }
      } else {
        const segments = selector.split(/>>>|\/deep\/|\s>>\s/);
        for (const seg of segments) {
          const trimmed = seg.trim();
          if (!trimmed) continue;
          try {
            document.createDocumentFragment().querySelector(trimmed);
          } catch (segErr) {
            return {
              success: false,
              error: `Invalid CSS selector segment "${trimmed}": ${segErr instanceof Error ? segErr.message : String(segErr)}`,
            };
          }
        }
      }

      let deepElements: Element[] = [];
      try {
        deepElements = querySelectorAllDeep(selector, document);
      } catch (deepErr) {
        return {
          success: false,
          error: `Invalid CSS selector "${selector}": ${deepErr instanceof Error ? deepErr.message : String(deepErr)}`,
        };
      }

      rawElements = Array.from(new Set([...mainElements, ...deepElements]));
    }

    const uniqueElements = Array.from(new Set(rawElements));
    const eligibleMatches: Element[] = [];
    const visibilityCache = createDomQueryCache();

    for (const el of uniqueElements) {
      if (isLocatorCandidateVisible(el, visibilityCache)) {
        eligibleMatches.push(el);
      }
    }

    if (eligibleMatches.length === 0) {
      return {
        success: false,
        matchCount: 0,
        notFound: true,
        error: `Element not found by selector: ${selector}`,
      };
    }

    if (eligibleMatches.length > 1) {
      return {
        success: false,
        matchCount: eligibleMatches.length,
        error: `Strict mode violation: selector "${selector}" resolved to ${eligibleMatches.length} visible elements in current frame. Specify a more specific selector, text, or ref.`,
      };
    }

    const loc = extractElementLocationDetails(eligibleMatches[0]);
    if (!Number.isFinite(loc.x) || !Number.isFinite(loc.y)) {
      return {
        success: false,
        error: `Element found by selector "${selector}" has non-finite coordinates (x: ${loc.x}, y: ${loc.y})`,
      };
    }

    return {
      ...loc,
      matchCount: 1,
    };
  } catch (err) {
    return {
      success: false,
      error: `Selector lookup error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const LOCATOR_ROLE_SET = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'searchbox',
  'checkbox',
  'radio',
  'heading',
  'option',
  'tab',
  'menuitem',
  'switch',
]);

function normalizeLocatorText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getAriaLabelledByText(el: Element): string {
  const ariaLabelledBy = el.getAttribute?.('aria-labelledby')?.trim();
  if (!ariaLabelledBy) return '';
  const parts: string[] = [];
  for (const id of ariaLabelledBy.split(/\s+/).filter(Boolean)) {
    const labelEl = getSameRootReference(el, id);
    const text = normalizeLocatorText(labelEl?.textContent || '');
    if (text) parts.push(text);
  }
  return normalizeLocatorText(parts.join(' '));
}

export function getNativeLabelText(el: Element): string {
  const labels = (el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> }).labels;
  if (labels && labels.length > 0) {
    return normalizeLocatorText(
      Array.from(labels)
        .map((label) => label.textContent || '')
        .join(' '),
    );
  }

  const id = el.getAttribute?.('id');
  if (id) {
    const explicitLabels = Array.from(
      (el.getRootNode() as ParentNode).querySelectorAll('label[for]'),
    ).filter((label) => label.getAttribute('for') === id);
    if (explicitLabels.length > 0) {
      return normalizeLocatorText(explicitLabels.map((label) => label.textContent || '').join(' '));
    }
  }
  return normalizeLocatorText(el.closest?.('label')?.textContent || '');
}

export function getLocatorAccessibleName(el: Element): string {
  const labelledBy = getAriaLabelledByText(el);
  if (labelledBy) return labelledBy;

  const ariaLabel = normalizeLocatorText(el.getAttribute?.('aria-label') || '');
  if (ariaLabel) return ariaLabel;

  const nativeLabel = getNativeLabelText(el);
  if (nativeLabel) return nativeLabel;

  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.type || 'text').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') {
      return normalizeLocatorText(input.value || '');
    }
  }
  if (tag === 'img') {
    return normalizeLocatorText(el.getAttribute('alt') || '');
  }

  const contentNameRoles = new Set(['button', 'link', 'heading', 'option', 'tab', 'menuitem']);
  const role = el.getAttribute?.('role')?.toLowerCase();
  if (
    contentNameRoles.has(role || '') ||
    tag === 'button' ||
    tag === 'a' ||
    tag === 'option' ||
    tag === 'summary' ||
    /^h[1-6]$/.test(tag)
  ) {
    const contentName = normalizeLocatorText((el as HTMLElement).innerText || el.textContent || '');
    if (contentName) return contentName;
  }

  const innerName =
    normalizeLocatorText(el.querySelector?.('img[alt]')?.getAttribute('alt') || '') ||
    normalizeLocatorText(
      el.querySelector?.('[role="img"][aria-label], [aria-label]')?.getAttribute('aria-label') ||
        '',
    ) ||
    normalizeLocatorText(el.querySelector?.('svg title, svg desc')?.textContent || '');
  if (innerName) return innerName;

  return normalizeLocatorText(el.getAttribute?.('title') || '');
}

function getLocatorLabelText(el: Element): string {
  return (
    getAriaLabelledByText(el) ||
    normalizeLocatorText(el.getAttribute?.('aria-label') || '') ||
    getNativeLabelText(el)
  );
}

function getLocatorRole(el: Element): string | undefined {
  const explicit = el.getAttribute?.('role')?.trim().toLowerCase();
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'option') return 'option';
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search') return 'searchbox';
    if (!['hidden', 'file', 'image', 'range', 'color'].includes(type)) {
      return 'textbox';
    }
  }
  if (
    (el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === ''
  ) {
    return 'textbox';
  }
  return undefined;
}

function locatorIsInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'body' || tag === 'html') return false;
  if (['button', 'select', 'textarea', 'summary', 'option', 'a'].includes(tag)) return true;
  if (tag === 'input' && (el as HTMLInputElement).type !== 'hidden') return true;
  const role = getLocatorRole(el);
  if (
    role &&
    [
      'button',
      'link',
      'checkbox',
      'radio',
      'tab',
      'menuitem',
      'option',
      'switch',
      'textbox',
      'combobox',
      'searchbox',
    ].includes(role)
  ) {
    return true;
  }
  return (
    el.hasAttribute('onclick') ||
    el.hasAttribute('data-action') ||
    (typeof (el as HTMLElement).tabIndex === 'number' && (el as HTMLElement).tabIndex >= 0)
  );
}

export function collapseNestedLocatorMatches(elements: Element[]): Element[] {
  if (elements.length <= 1) return elements;
  const interactive = new Map(elements.map((el) => [el, locatorIsInteractive(el)]));
  const dominated = new Set<Element>();
  for (const el of elements) {
    const elInteractive = interactive.get(el)!;
    for (let ancestor = composedParent(el); ancestor; ancestor = composedParent(ancestor)) {
      const ancestorInteractive = interactive.get(ancestor);
      if (ancestorInteractive === undefined) continue;
      if (!ancestorInteractive || elInteractive) dominated.add(ancestor);
      if (ancestorInteractive && !elInteractive) dominated.add(el);
    }
  }
  return elements.filter((el) => !dominated.has(el));
}

function finalizeLocatorMatches(elements: Element[], descriptor: string) {
  const matches = collapseNestedLocatorMatches(elements);
  if (matches.length === 0) {
    return {
      success: false,
      matchCount: 0,
      notFound: true,
      error: `Element not found matching ${descriptor}`,
    };
  }
  if (matches.length > 1) {
    return {
      success: false,
      matchCount: matches.length,
      error: `Strict mode violation: ${descriptor} resolved to ${matches.length} visible elements in current frame. Specify a unique target.`,
    };
  }
  const location = extractElementLocationDetails(matches[0]);
  if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) {
    return {
      success: false,
      error: `Element found matching ${descriptor} has non-finite coordinates`,
    };
  }
  return { ...location, matchCount: 1 };
}

export interface LocateByLabelOptions {
  exact?: boolean;
}

export function inPageLocateByLabel(label: string, options: LocateByLabelOptions = {}) {
  const target = normalizeLocatorText(label);
  if (!target) return { success: false, error: 'Label must be provided' };
  const targetLower = target.toLowerCase();
  const candidates = querySelectorAllDeep(
    'input:not([type="hidden"]), textarea, select, button, [role], [aria-label], [aria-labelledby]',
    document,
  );
  const visibilityCache = createDomQueryCache();
  const matches = candidates.filter((el) => {
    if (!isLocatorCandidateVisible(el, visibilityCache)) return false;
    const candidate = getLocatorLabelText(el);
    if (!candidate) return false;
    return options.exact ? candidate === target : candidate.toLowerCase().includes(targetLower);
  });
  return finalizeLocatorMatches(matches, `label "${label}"`);
}

export interface LocateByRoleOptions {
  name?: string;
  exact?: boolean;
}

export function inPageLocateByRole(role: string, options: LocateByRoleOptions = {}) {
  const targetRole = normalizeLocatorText(role).toLowerCase();
  if (!LOCATOR_ROLE_SET.has(targetRole)) {
    return {
      success: false,
      error: `Unsupported role locator "${role}". Supported roles: ${Array.from(LOCATOR_ROLE_SET).join(', ')}`,
    };
  }
  const targetName = normalizeLocatorText(options.name || '');
  const targetNameLower = targetName.toLowerCase();
  const candidates = querySelectorAllDeep(
    'button, a, input, textarea, select, option, h1, h2, h3, h4, h5, h6, [role], [contenteditable]',
    document,
  );
  const visibilityCache = createDomQueryCache();
  const matches = candidates.filter((el) => {
    if (!isLocatorCandidateVisible(el, visibilityCache)) return false;
    if (getLocatorRole(el) !== targetRole) return false;
    if (!targetName) return true;
    const accessibleName = getLocatorAccessibleName(el);
    return options.exact
      ? accessibleName === targetName
      : accessibleName.toLowerCase().includes(targetNameLower);
  });
  return finalizeLocatorMatches(
    matches,
    `role "${targetRole}"${targetName ? ` name "${targetName}"` : ''}`,
  );
}

export interface LocateByTextOptions {
  role?: string;
  exact?: boolean;
  visibleOnly?: boolean;
  threshold?: number;
  mode?: 'legacy' | 'text';
}

/**
 * Locate element coordinates and info by visible text content and/or ARIA role.
 * Enforces strict uniqueness within the frame: multiple matching visible elements fail closed with matchCount and strict error.
 */
export function inPageLocateByText(
  text: string,
  roleOrOptions?: string | LocateByTextOptions,
): {
  success: boolean;
  matchCount?: number;
  notFound?: boolean;
  index?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tagName?: string;
  inputType?: string;
  text?: string;
  value?: string;
  role?: string;
  isClickable?: boolean;
  frameOffsetX?: number;
  frameOffsetY?: number;
  error?: string;
} {
  const role =
    typeof roleOrOptions === 'string'
      ? roleOrOptions
      : roleOrOptions && typeof roleOrOptions === 'object' && typeof roleOrOptions.role === 'string'
        ? roleOrOptions.role
        : undefined;

  const isExact =
    typeof roleOrOptions === 'object' && roleOrOptions !== null
      ? Boolean(roleOrOptions.exact)
      : false;
  const textOnly =
    typeof roleOrOptions === 'object' && roleOrOptions !== null && roleOrOptions.mode === 'text';

  if (!text && !role) {
    return { success: false, error: 'Either text or role must be provided' };
  }

  try {
    const displayTarget = normalizeLocatorText(text || '');
    const normalizedTarget = displayTarget.toLowerCase();
    const isSeekingComposer = role === 'composer' || role === 'editor';

    let selector: string;
    if (role) {
      if (isSeekingComposer) {
        selector =
          '[role="textbox"], textarea, [contenteditable], [data-testid*="composer" i], [data-testid*="editor" i], [data-testid*="post" i], [data-testid*="tweet" i], [data-testid*="comment" i], [data-testid*="chat" i], [data-testid*="message" i], .DraftEditor-root, .ProseMirror, .ql-editor, .monaco-editor, .cm-editor, .tiptap, div, span, [role]';
      } else if (role.toLowerCase() === 'textbox') {
        selector =
          '[role="textbox"], textarea, input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="image"]):not([type="file"]), [contenteditable="true"], [contenteditable=""]';
      } else if (role.toLowerCase() === 'button') {
        selector =
          '[role="button"], button, input[type="button"], input[type="submit"], input[type="reset"]';
      } else if (role.toLowerCase() === 'link') {
        selector = '[role="link"], a[href], a';
      } else if (role.toLowerCase() === 'combobox') {
        selector = '[role="combobox"], select';
      } else {
        selector = `[role="${role}"], ${role}`;
      }
    } else {
      selector = 'button, a, input, textarea, select, span, p, div, h1, h2, h3, h4, [role]';
    }

    let rawCandidates: Element[];
    try {
      rawCandidates = querySelectorAllDeep(selector, document);
    } catch {
      rawCandidates = querySelectorAllDeep('*', document);
    }

    const candidates = Array.from(new Set(rawCandidates));
    const exactMatches: Element[] = [];
    const substringMatches: Element[] = [];
    const roleOnlyMatches: Element[] = [];

    function matchRole(element: Element, targetRole: string): boolean {
      const explicitRole = element.getAttribute('role')?.toLowerCase();
      if (explicitRole) {
        return explicitRole === targetRole.toLowerCase();
      }
      const tag = element.tagName.toLowerCase();
      const normTarget = targetRole.toLowerCase();
      if (normTarget === 'textbox') {
        if (tag === 'textarea') return true;
        if (tag === 'input') {
          const inputType = ((element as HTMLInputElement).type || 'text').toLowerCase();
          const nonTextTypes = new Set([
            'button',
            'submit',
            'reset',
            'checkbox',
            'radio',
            'hidden',
            'image',
            'file',
            'range',
            'color',
          ]);
          return !nonTextTypes.has(inputType);
        }
        if (
          (element as HTMLElement).isContentEditable ||
          element.getAttribute('contenteditable') === 'true' ||
          element.getAttribute('contenteditable') === ''
        ) {
          return true;
        }
        return false;
      }
      if (normTarget === 'button') {
        if (tag === 'button') return true;
        if (tag === 'input') {
          const inputType = ((element as HTMLInputElement).type || '').toLowerCase();
          return inputType === 'button' || inputType === 'submit' || inputType === 'reset';
        }
        return false;
      }
      if (normTarget === 'link') {
        return (
          tag === 'a' &&
          (element.hasAttribute('href') || Boolean((element as HTMLAnchorElement).href))
        );
      }
      if (normTarget === 'combobox') {
        return tag === 'select';
      }
      if (normTarget === 'checkbox' || normTarget === 'radio') {
        return tag === 'input' && (element as HTMLInputElement).type?.toLowerCase() === normTarget;
      }
      return tag === normTarget;
    }

    const visibilityCache = createDomQueryCache();
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!isLocatorCandidateVisible(el, visibilityCache)) continue;

      const semantics = detectEditorSemantics(el);
      if (role === 'composer') {
        if (!semantics.isComposer && !semantics.isEditor) continue;
      } else if (role === 'editor') {
        if (!semantics.isEditor && !semantics.isComposer) continue;
      } else if (typeof role === 'string' && role.length > 0) {
        if (!matchRole(el, role)) continue;
      }

      if (normalizedTarget) {
        const displayText = normalizeLocatorText(el.textContent || '');
        const elText = displayText.toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const placeholder = (el.getAttribute('placeholder') || '').trim().toLowerCase();
        const value = ((el as HTMLInputElement).value || '').trim().toLowerCase();

        const exactMatch = textOnly
          ? isExact
            ? displayText === displayTarget
            : elText === normalizedTarget
          : elText === normalizedTarget ||
            ariaLabel === normalizedTarget ||
            placeholder === normalizedTarget ||
            value === normalizedTarget;
        if (exactMatch) {
          exactMatches.push(el);
        } else if (
          !isExact &&
          (textOnly
            ? elText.includes(normalizedTarget)
            : elText.includes(normalizedTarget) ||
              ariaLabel.includes(normalizedTarget) ||
              placeholder.includes(normalizedTarget))
        ) {
          substringMatches.push(el);
        }
      } else {
        roleOnlyMatches.push(el);
      }
    }

    function isInteractive(el: Element): boolean {
      if (!(el instanceof Element)) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') return false;
      if (
        tag === 'button' ||
        tag === 'select' ||
        tag === 'textarea' ||
        tag === 'summary' ||
        tag === 'option'
      ) {
        return true;
      }
      if (tag === 'input' && (el as HTMLInputElement).type !== 'hidden') {
        return true;
      }
      if (tag === 'a' && ((el as HTMLAnchorElement).href || el.hasAttribute('href'))) {
        return true;
      }
      if (
        (el as HTMLElement).isContentEditable ||
        el.getAttribute('contenteditable') === 'true' ||
        el.getAttribute('contenteditable') === ''
      ) {
        return true;
      }
      const elRole = el.getAttribute('role')?.toLowerCase();
      const interactiveRoles = new Set([
        'button',
        'link',
        'checkbox',
        'radio',
        'tab',
        'menuitem',
        'menuitemcheckbox',
        'menuitemradio',
        'option',
        'switch',
        'textbox',
        'combobox',
        'searchbox',
        'spinbutton',
      ]);
      if (elRole && interactiveRoles.has(elRole)) {
        return true;
      }
      if (
        el.hasAttribute('onclick') ||
        el.hasAttribute('oncontextmenu') ||
        el.hasAttribute('ondblclick') ||
        (typeof (el as HTMLElement).tabIndex === 'number' && (el as HTMLElement).tabIndex >= 0) ||
        el.hasAttribute('data-action') ||
        el.getAttribute('aria-pressed') !== null ||
        el.getAttribute('aria-expanded') !== null ||
        el.getAttribute('aria-selected') !== null ||
        el.getAttribute('aria-checked') !== null
      ) {
        return true;
      }
      let st: CSSStyleDeclaration | null = null;
      try {
        const win = el.ownerDocument?.defaultView || window;
        st = win.getComputedStyle(el);
      } catch {}
      if (st?.cursor === 'pointer') {
        return true;
      }
      return false;
    }

    function collapseNested(elements: Element[]): Element[] {
      if (elements.length <= 1) return elements;
      const interactive = new Map(elements.map((el) => [el, isInteractive(el)]));
      const dominated = new Set<Element>();
      for (const el of elements) {
        const isElInteractive = interactive.get(el)!;
        // Only matched ancestors can dominate a candidate or be dominated by it.
        for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const isAncestorInteractive = interactive.get(ancestor);
          if (isAncestorInteractive === undefined) continue;
          if (!isAncestorInteractive || isElInteractive) dominated.add(ancestor);
          if (isAncestorInteractive && !isElInteractive) dominated.add(el);
        }
      }
      return elements.filter((el) => !dominated.has(el));
    }

    let targetElementList: Element[] = [];
    if (normalizedTarget) {
      const collapsedExact = collapseNested(exactMatches);
      if (collapsedExact.length > 0) {
        targetElementList = collapsedExact;
      } else if (!isExact) {
        targetElementList = collapseNested(substringMatches);
      }
    } else {
      targetElementList = collapseNested(roleOnlyMatches);
    }

    if (targetElementList.length === 0) {
      return {
        success: false,
        matchCount: 0,
        notFound: true,
        error: `Element not found matching text="${text}" role="${role || ''}"`,
      };
    }

    if (targetElementList.length > 1) {
      return {
        success: false,
        matchCount: targetElementList.length,
        error: `Strict mode violation: text "${text || role}" resolved to ${targetElementList.length} visible elements in current frame. Specify a more specific selector, text, or ref.`,
      };
    }

    const loc = extractElementLocationDetails(targetElementList[0]);
    if (!Number.isFinite(loc.x) || !Number.isFinite(loc.y)) {
      return {
        success: false,
        error: `Element found matching text="${text}" has non-finite coordinates (x: ${loc.x}, y: ${loc.y})`,
      };
    }

    return {
      ...loc,
      matchCount: 1,
    };
  } catch (err) {
    return {
      success: false,
      error: `Text lookup error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
