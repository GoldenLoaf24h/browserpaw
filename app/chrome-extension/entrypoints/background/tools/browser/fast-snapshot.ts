import type { IndexedElement, ScrollInfo } from 'chrome-mcp-shared';
import { observationPriority } from '@/utils/observation-priority';
import {
  buildTableObservation,
  buildScopedScrollInfo,
  composedContains,
  composedParent,
  computeInteractionScope,
  createTableObservationCache,
  findIndexedElement,
  getDeepActiveElement,
  getSameRootReference,
  getShadowRoot,
  getTableObservationRole,
  hasDirectTableAction,
  indexElement,
  isPresentationalNativeTable,
  observationFocusScope,
  pruneDetachedIndices,
  querySelectorAllDeep,
  readFormObservationMetadata,
  withinObservationFocusScope,
} from './dom-indexer';

/**
 * BrowserPaw Ultrafast Atomic DOM Snapshot & Perception Engine
 *
 * Single-pass TreeWalker traversal, WeakMap metric caching, native checkVisibility,
 * and code-owned WeakMap/Map node identity registry (`window.__pawFast` / `window.__clawFast`).
 *
 * Bounded by a 250 unique-element budget and 6000 text characters.
 */

export interface FastSnapshotOptions {
  legacyVisibility?: boolean;
  selector?: string;
  scope?: string;
  exclude?: string | string[];
  viewportThreshold?: number;
  viewportOnly?: boolean;
  activeViewportOnly?: boolean;
  isolateModal?: boolean;
  limit?: number;
  maxTextLength?: number;
}

export interface FastAction {
  id: string;
  node?: number;
  domId?: string;
  role?: string;
  label: string;
  rect?: { x: number; y: number; w: number; h: number };
  kind: 'click' | 'fill' | 'select' | 'scroll' | 'wait';
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  invalid?: boolean;
  invalidReason?: string;
  validationMessage?: string;
  required?: boolean;
  valid?: boolean;
  ariaInvalid?: string;
  errormessage?: string;
  description?: string;
  focused?: boolean;
  withinFocusScope?: boolean;
  delta?: number;
  containerIndex?: number;
}

export interface FastSnapshotResult {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  scroll: { y: number; height: number };
  scrollInfo?: ScrollInfo;
  actions: FastAction[];
  structuralElements?: IndexedElement[];
  marker: any[];
  page_key: any[];
  guards: Record<string | number, any>;
  omitted_actions: number;
  omitted_elements?: number;
  selectorMatched?: boolean;
  textTruncated?: boolean;
  omitted_text?: number;
  activeModal?: string;
  modalIsolated?: boolean;
}

export interface PawFastCache {
  ids: WeakMap<Element, number>;
  nodes: Map<number, Element>;
  actionElements?: Map<string | number, Element>;
  next: number;
  pageKey?: () => any[];
  guard?: (e: Element | null | undefined) => any[] | null;
  snapshot?: (options?: FastSnapshotOptions) => FastSnapshotResult | null;
}

export type ClawFastCache = PawFastCache;

export function inPageValidateObservedGuard(index: number, expected: unknown[]): boolean {
  const cache = getPawFastCache();
  const actual = cache.guard?.(findIndexedElement(index));
  return (
    Array.isArray(expected) &&
    expected.length >= 3 &&
    Array.isArray(actual) &&
    JSON.stringify(actual) === JSON.stringify(expected)
  );
}

const MAX_SELECT_ACTIONS_PER_ELEMENT = 50;

export function getPawFastCache(): PawFastCache {
  const g = globalThis as any;
  if (!g.__pawFast && !g.__clawFast) {
    const cache: PawFastCache = {
      ids: new WeakMap<Element, number>(),
      nodes: new Map<number, Element>(),
      actionElements: new Map<string | number, Element>(),
      next: 1,
    };
    g.__pawFast = cache;
    g.__clawFast = cache;
  } else if (!g.__pawFast && g.__clawFast) {
    g.__pawFast = g.__clawFast;
  } else if (g.__pawFast && !g.__clawFast) {
    g.__clawFast = g.__pawFast;
  }
  const active = g.__pawFast as PawFastCache;
  if (!active.actionElements) {
    active.actionElements = new Map<string | number, Element>();
  }
  return active;
}

export const getClawFastCache = getPawFastCache;

// Module-scoped ephemeral DOM cache for single snapshot pass (Nanobrowser pattern)
const DOM_CACHE = {
  boundingRects: new WeakMap<Element, DOMRect>(),
  computedStyles: new WeakMap<Element, CSSStyleDeclaration>(),
  clearCache: () => {
    DOM_CACHE.boundingRects = new WeakMap();
    DOM_CACHE.computedStyles = new WeakMap();
  },
};

function getCachedBoundingRect(element: Element): DOMRect {
  let rect = DOM_CACHE.boundingRects.get(element);
  if (!rect) {
    rect = element.getBoundingClientRect();
    DOM_CACHE.boundingRects.set(element, rect);
  }
  return rect;
}

function getCachedComputedStyle(element: Element): CSSStyleDeclaration {
  let style = DOM_CACHE.computedStyles.get(element);
  if (!style) {
    style = window.getComputedStyle(element);
    DOM_CACHE.computedStyles.set(element, style);
  }
  return style;
}

/**
 * Get native value setter by climbing the element's actual prototype chain.
 * Essential for React 16-19 and Vue 3 controlled inputs where value setter is intercepted.
 */
export function getNativeValueSetter(
  element: HTMLInputElement | HTMLTextAreaElement,
): ((v: string) => void) | null {
  if (!element || typeof element !== 'object') return null;
  let proto = Object.getPrototypeOf(element);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) {
      return desc.set;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

/**
 * Get native checked setter by climbing the element's prototype chain.
 */
export function getNativeCheckedSetter(element: HTMLInputElement): ((v: boolean) => void) | null {
  if (!element || typeof element !== 'object') return null;
  let proto = Object.getPrototypeOf(element);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'checked');
    if (desc?.set) {
      return desc.set;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

/**
 * Execute ultrafast atomic snapshot of visible DOM interactive elements and body text.
 */
export function clearFastSnapshotMetrics(): void {
  DOM_CACHE.clearCache();
}

export function fastSnapshot(options?: FastSnapshotOptions): FastSnapshotResult | null {
  if (typeof document === 'undefined' || !document.body) return null;

  (globalThis as any)[Symbol.for('__browser_use_last_snapshot_type__')] = 'fast';
  const tableObservationCache = createTableObservationCache();

  pruneDetachedIndices();
  const cache = getClawFastCache();

  const identity = (e: Element): number => {
    if (!cache.ids.has(e)) {
      cache.ids.set(e, cache.next++);
    }
    const id = cache.ids.get(e)!;
    cache.nodes.set(id, e);
    return id;
  };

  // Clean up detached nodes to prevent memory leaks on SPA re-renders
  for (const [id, e] of cache.nodes) {
    if (!e.isConnected) {
      cache.nodes.delete(id);
    }
  }
  cache.actionElements?.clear();

  const fastActiveElement = getDeepActiveElement();
  const targetSelector = options?.scope || options?.selector;
  const isolateModal = options?.isolateModal !== false;
  const interactionScope = computeInteractionScope(window, {
    explicitScope: Boolean(targetSelector) || !isolateModal,
  });
  const focusScope = isolateModal
    ? (interactionScope.modalElement ?? observationFocusScope(fastActiveElement))
    : observationFocusScope(fastActiveElement);

  const safe = (e: any): boolean => !['password', 'file', 'hidden'].includes(e.type);

  const hiddenByAncestor = (element: Element): boolean => {
    const seen = new Set<Element>();
    for (let node: Element | null = element; node && !seen.has(node); node = composedParent(node)) {
      seen.add(node);
      if (
        node.getAttribute('aria-hidden') === 'true' ||
        node.hasAttribute('inert') ||
        (node as HTMLElement).inert === true
      ) {
        return true;
      }
    }
    return false;
  };

  const visible = (e: Element | null): boolean => {
    if (!e || hiddenByAncestor(e)) return false;
    if (options?.legacyVisibility || typeof (e as any).checkVisibility !== 'function') {
      const seen = new Set<Element>();
      for (
        let current: Element | null = e;
        current && !seen.has(current);
        current = composedParent(current)
      ) {
        seen.add(current);
        const style = getCachedComputedStyle(current);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          parseFloat(style.opacity || '1') === 0
        ) {
          return false;
        }
      }
      const r = getCachedBoundingRect(e);
      return r.width > 0 && r.height > 0;
    }
    return (e as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };

  const name = (e: Element | null, seen = new Set<Element>()): string => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => name(getSameRootReference(e, id), seen))
      .filter(Boolean)
      .join(' ');
    if (referenced) return referenced;
    const ariaLabel = e.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const labels = [...((e as any).labels || [])]
      .map((l: Element) => name(l, seen))
      .filter(Boolean)
      .join(' ');
    if (labels) return labels;
    if (['button', 'submit', 'reset'].includes((e as any).type)) {
      const v = (e as HTMLInputElement).value;
      if (v) return v;
    }
    const alt = e.getAttribute('alt');
    if (alt) return alt;
    if (e.tagName !== 'INPUT') {
      const textChildren = [...e.childNodes]
        .map((n) => {
          if (n.nodeType === 3) return n.textContent || '';
          if (n.nodeType === 1 && (n as Element).getAttribute('aria-hidden') !== 'true') {
            return name(n as Element, seen);
          }
          return '';
        })
        .join(' ')
        .trim();
      if (textChildren) return textChildren;
    }
    return e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };

  const roles = [
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemradio',
    'option',
    'gridcell',
    'combobox',
    'textbox',
    'searchbox',
    'spinbutton',
  ];

  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((r) => '[role="' + r + '"]').join(',');
  const tableStructuralSelector =
    'table,tr,td,th,[role="table"],[role="grid"],[role="row"],' +
    '[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]';
  const liveSelector = '[role="alert"],[role="status"],[aria-live]';
  const actionSelector = selector + ',' + tableStructuralSelector;
  const candidateSelector = actionSelector + ',' + liveSelector;

  const getRole = (e: Element): string | null => {
    const explicit = e.getAttribute('role');
    if (explicit && roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || (e as HTMLElement).isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      const type = (e as HTMLInputElement).type;
      if (['checkbox', 'radio'].includes(type)) return type;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(type)) return 'textbox';
    }
    return getTableObservationRole(e);
  };

  const isLiveRegion = (element: Element): boolean => {
    const role = (element.getAttribute('role') || '').trim().toLowerCase();
    const live = (element.getAttribute('aria-live') || '').trim().toLowerCase();
    return role === 'alert' || role === 'status' || (live !== '' && live !== 'off');
  };

  cache.pageKey = () => {
    const controls = querySelectorAllDeep('input,textarea,select', document).filter((element) =>
      safe(element),
    );
    return [
      performance.timeOrigin,
      location.href,
      window.scrollX,
      window.scrollY,
      window.innerWidth,
      window.innerHeight,
      controls.map((e: any) => [
        identity(e),
        e.value,
        e.checked,
        e.selectedIndex,
        e.disabled,
        e.readOnly,
      ]),
    ];
  };

  cache.guard = (e: any) => {
    if (!e?.isConnected || !visible(e) || !safe(e)) return null;
    const scope =
      e.closest?.('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [
      identity(e),
      getRole(e),
      name(e),
      e.value ?? null,
      e.checked ?? null,
      e.selectedIndex ?? null,
      e.readOnly ?? null,
      typeof e.matches === 'function' ? e.matches(':disabled') : false,
      e.getAttribute?.('aria-disabled'),
      e.getAttribute?.('aria-expanded'),
      e.getAttribute?.('aria-checked'),
      e.getAttribute?.('aria-selected'),
      e.getAttribute?.('href'),
      scope?.innerText ? String(scope.innerText).slice(0, 100) : '',
    ];
  };

  let actions: FastAction[] = [];
  const maxElementTextLen =
    typeof options?.maxTextLength === 'number' && options.maxTextLength > 0
      ? options.maxTextLength
      : 120;
  let hasTextTruncated = false;
  let omittedTextChars = 0;
  let omittedOptionActions = 0;

  const excludeList: string[] = [];
  if (options?.exclude) {
    const rawExclude = Array.isArray(options.exclude) ? options.exclude : [options.exclude];
    for (const item of rawExclude) {
      if (typeof item === 'string' && item.trim()) {
        const sel = item.trim();
        try {
          document.querySelector(sel);
        } catch (err) {
          throw new Error(
            'Invalid exclude selector: "' + sel + '" (' + ((err as Error)?.message || err) + ')',
          );
        }
        excludeList.push(sel);
      }
    }
  }

  const matchesExclude = (element: Element): boolean => {
    const seen = new Set<Element>();
    for (let node: Element | null = element; node && !seen.has(node); node = composedParent(node)) {
      seen.add(node);
      for (const sel of excludeList) {
        if (typeof node.matches === 'function' && node.matches(sel)) return true;
      }
    }
    return false;
  };

  const isExcluded = (e: Element | null): boolean =>
    !!e && excludeList.length > 0 && matchesExclude(e);

  const ariaDisabled = (element: Element): boolean => {
    const seen = new Set<Element>();
    for (let node: Element | null = element; node && !seen.has(node); node = composedParent(node)) {
      seen.add(node);
      if (node.getAttribute('aria-disabled') === 'true') return true;
    }
    return false;
  };

  let roots: Element[] = [];
  let selectorMatched: boolean | undefined = undefined;

  if (targetSelector) {
    try {
      document.querySelector(targetSelector);
    } catch (err) {
      throw new Error(
        'Invalid scope/selector: "' +
          targetSelector +
          '" (' +
          ((err as Error)?.message || err) +
          ')',
      );
    }
    try {
      const matched = querySelectorAllDeep(targetSelector, document);
      selectorMatched = matched.length > 0;
      roots = matched.filter(
        (root) => !matched.some((other) => other !== root && composedContains(other, root)),
      );
    } catch {
      selectorMatched = false;
      roots = [];
    }
    if (roots.length === 0) {
      return {
        url: location.href,
        title: document.title,
        w: window.innerWidth,
        h: window.innerHeight,
        text: '',
        scroll: {
          y: window.scrollY,
          height: document.documentElement
            ? document.documentElement.scrollHeight
            : document.body.scrollHeight,
        },
        actions: [],
        marker: [],
        page_key: cache.pageKey ? cache.pageKey() : [],
        guards: {},
        omitted_actions: 0,
        selectorMatched: false,
      };
    }
  } else {
    roots = isolateModal ? interactionScope.roots : document.body ? [document.body] : [];
  }

  const scrollInfo = buildScopedScrollInfo(roots, window, {
    modalActive: !targetSelector && isolateModal && interactionScope.focusTrapped,
    ...(!targetSelector
      ? { containers: isolateModal ? interactionScope.scrollContainers : undefined }
      : {}),
  });

  let pad = 0;
  let checkViewport = true;
  if (options?.activeViewportOnly === true || (options?.activeViewportOnly as any) === 'true') {
    pad = 0;
    checkViewport = true;
  } else if (typeof options?.viewportThreshold === 'number') {
    pad = options.viewportThreshold;
    checkViewport = true;
  } else if (options?.viewportOnly === true || (options?.viewportOnly as any) === 'true') {
    pad = 150;
    checkViewport = true;
  } else if (options?.viewportOnly === false || (options?.viewportOnly as any) === 'false') {
    checkViewport = false;
  }

  const inViewport = (rect: DOMRect): boolean => {
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (!checkViewport) return true;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    return x >= -pad && y >= -pad && x < window.innerWidth + pad && y < window.innerHeight + pad;
  };

  const rawElements: Element[] = [];
  const seenCandidates = new Set<Element>();
  const pushCandidate = (element: Element | null) => {
    if (!element || seenCandidates.has(element)) return;
    seenCandidates.add(element);
    rawElements.push(element);
  };
  for (const root of roots) {
    if (isExcluded(root)) continue;
    if (typeof root.matches === 'function' && root.matches(candidateSelector)) pushCandidate(root);
    for (const element of querySelectorAllDeep(candidateSelector, root)) pushCandidate(element);
  }

  let structuralElements: IndexedElement[] = [];
  const rank = new Map<number, number>();
  const remember = (masterId: number, priority: number) => {
    rank.set(masterId, Math.max(rank.get(masterId) || 0, priority));
  };

  for (const e of rawElements) {
    if (isExcluded(e) || !visible(e)) continue;
    const rect = getCachedBoundingRect(e);
    if (!inViewport(rect)) continue;
    const inScope = withinObservationFocusScope(e, focusScope);
    let masterId: number | null = null;
    const ensureId = () => (masterId ??= indexElement(e));
    const roundedRect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    if (
      typeof e.matches === 'function' &&
      e.matches(actionSelector) &&
      safe(e) &&
      !(typeof e.matches === 'function' && e.matches(':disabled')) &&
      !ariaDisabled(e)
    ) {
      const rname = getRole(e);
      const blockedTable = !!getTableObservationRole(e) && !hasDirectTableAction(e);
      const blockedGrid = rname === 'gridcell' && !!e.querySelector('button,[role="button"]');
      if (rname && !blockedTable && !blockedGrid) {
        const id = ensureId();
        const formMeta = readFormObservationMetadata(e);
        remember(
          id,
          observationPriority({
            focused: fastActiveElement === e,
            invalid: !!formMeta?.invalid,
            role: rname,
            withinFocusScope: inScope,
            attributes: {
              role: e.getAttribute('role') || undefined,
              'aria-invalid': e.getAttribute('aria-invalid') || undefined,
              'aria-live': e.getAttribute('aria-live') || undefined,
            },
          }),
        );
        const base: any = {
          id: 'e' + id,
          node: identity(e),
          ...(e.id ? { domId: e.id } : {}),
          role: rname,
          withinFocusScope: inScope || undefined,
          label: (() => {
            const fullLabel = name(e) || rname;
            if (fullLabel.length > maxElementTextLen) {
              hasTextTruncated = true;
              omittedTextChars += fullLabel.length - maxElementTextLen;
              return fullLabel.slice(0, maxElementTextLen);
            }
            return fullLabel;
          })(),
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        };
        for (const key of ['checked', 'selected', 'expanded']) {
          const val = e.getAttribute('aria-' + key);
          if (val !== null) base[key] = val;
        }
        if (['checkbox', 'radio'].includes((e as any).type)) {
          base.checked = String((e as HTMLInputElement).checked);
        }
        if (formMeta?.invalid) {
          base.invalid = true;
          base.invalidReason = formMeta.invalidReason;
        }
        if (formMeta?.valid !== undefined) base.valid = formMeta.valid;
        if (formMeta?.required) base.required = true;
        if (formMeta?.validationMessage) base.validationMessage = formMeta.validationMessage;
        if (formMeta?.invalidRaw) base.ariaInvalid = formMeta.invalidRaw;
        if (formMeta?.errormessage) base.errormessage = formMeta.errormessage;
        if (formMeta?.description) base.description = formMeta.description;
        if (fastActiveElement === e) base.focused = true;

        if (e.tagName === 'SELECT') {
          const selEl = e as HTMLSelectElement;
          actions.push({
            ...base,
            kind: 'click',
            current_value: [...selEl.selectedOptions].map((option) => option.label).join(', '),
          });
          let emittedSelectActions = 0;
          for (const o of selEl.options) {
            if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]')) {
              if (emittedSelectActions >= MAX_SELECT_ACTIONS_PER_ELEMENT) {
                omittedOptionActions++;
                continue;
              }
              actions.push({
                ...base,
                kind: 'select',
                value: o.value,
                current_value: [...selEl.selectedOptions].map((opt) => opt.label).join(', '),
                label: base.label + ' → ' + o.label,
              });
              emittedSelectActions++;
            }
          }
        } else {
          const isReadOnly = (e as any).readOnly || e.getAttribute('aria-readonly') === 'true';
          const editable =
            !isReadOnly &&
            (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
              (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
          const value =
            'value' in e
              ? String((e as any).value)
              : (e as HTMLElement).isContentEditable || rname === 'combobox'
                ? (e as HTMLElement).innerText?.trim() || ''
                : '';
          actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
          if (editable) {
            actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
          }
        }
      }
    }

    if (isLiveRegion(e)) {
      const full = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (!full) continue;
      const id = ensureId();
      const role = (e.getAttribute('role') || '').trim().toLowerCase();
      const liveRole = role === 'alert' || role === 'status' ? role : undefined;
      let text = full;
      if (full.length > maxElementTextLen) {
        hasTextTruncated = true;
        omittedTextChars += full.length - maxElementTextLen;
        text = full.slice(0, maxElementTextLen);
      }
      remember(
        id,
        observationPriority({
          focused: fastActiveElement === e,
          role: liveRole,
          withinFocusScope: inScope,
          attributes: {
            role: role || undefined,
            'aria-live': e.getAttribute('aria-live') || undefined,
          },
        }),
      );
      structuralElements.push({
        index: id,
        tagName: e.tagName.toLowerCase(),
        role: liveRole,
        text,
        attributes: {
          ...(e.id ? { id: e.id } : {}),
          ...(role ? { role } : {}),
          ...(e.getAttribute('aria-live') ? { 'aria-live': e.getAttribute('aria-live')! } : {}),
        },
        rect: roundedRect,
        isInteractive: false,
        withinFocusScope: inScope || undefined,
        inShadowDom: e.getRootNode() !== document || undefined,
      });
      continue;
    }

    if (!getTableObservationRole(e)) continue;
    const observation = buildTableObservation(e, maxElementTextLen, tableObservationCache);
    if (!observation) continue;
    const id = ensureId();
    remember(
      id,
      observationPriority({
        focused: fastActiveElement === e,
        role: observation.role,
        withinFocusScope: inScope,
        attributes: {
          role: e.getAttribute('role') || undefined,
          'aria-live': e.getAttribute('aria-live') || undefined,
        },
      }),
    );
    structuralElements.push({
      index: id,
      tagName: e.tagName.toLowerCase(),
      role: observation.role,
      text: observation.text,
      attributes: {
        ...(e.id ? { id: e.id } : {}),
        ...(e.getAttribute('role') ? { role: e.getAttribute('role')! } : {}),
        ...observation.attributes,
      },
      rect: roundedRect,
      isInteractive: false,
      withinFocusScope: inScope || undefined,
      inShadowDom: e.getRootNode() !== document || undefined,
    });
  }

  const BODY_TEXT_BUDGET = 6000;
  const words: string[] = [];
  const walkerRoots = roots;
  const range = document.createRange();
  let bodyTextLength = 0;
  const visitedTextRoots = new Set<Node>();
  const nativeControl = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

  const consumeText = (node: Node) => {
    const rawVal = node.textContent?.trim() || '';
    const parent = node.parentElement;
    const tableAncestor = parent?.closest('table,[role="table"],[role="grid"]');
    if (
      !rawVal ||
      !parent ||
      parent.closest('script,style,noscript,template') ||
      (tableAncestor && !isPresentationalNativeTable(tableAncestor)) ||
      isExcluded(parent) ||
      !visible(parent)
    ) {
      return;
    }
    if (bodyTextLength >= BODY_TEXT_BUDGET) {
      hasTextTruncated = true;
      omittedTextChars += rawVal.length;
      return;
    }
    const pushText = (val: string, omitted: number) => {
      if (omitted > 0) {
        hasTextTruncated = true;
        omittedTextChars += omitted;
      }
      words.push(val);
      bodyTextLength += val.length;
    };
    try {
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (
        r.width > 0 &&
        r.height > 0 &&
        (!checkViewport ||
          (r.bottom > -pad &&
            r.top < window.innerHeight + pad &&
            r.right > -pad &&
            r.left < window.innerWidth + pad))
      ) {
        const remaining = BODY_TEXT_BUDGET - bodyTextLength;
        const val = rawVal.length > remaining ? rawVal.slice(0, remaining) : rawVal;
        pushText(val, rawVal.length > remaining ? rawVal.length - remaining : 0);
      }
    } catch {
      const remaining = BODY_TEXT_BUDGET - bodyTextLength;
      const val = rawVal.length > remaining ? rawVal.slice(0, remaining) : rawVal;
      pushText(val, rawVal.length > remaining ? rawVal.length - remaining : 0);
    }
  };

  const walkTextRoot = (container: ParentNode) => {
    if (!container || visitedTextRoots.has(container)) return;
    visitedTextRoots.add(container);
    if (container instanceof Element && !nativeControl.has(container.tagName)) {
      const ownShadow = getShadowRoot(container);
      if (ownShadow) walkTextRoot(ownShadow);
    }
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        consumeText(node);
        continue;
      }
      const element = node as Element;
      if (nativeControl.has(element.tagName)) continue;
      const shadow = getShadowRoot(element);
      if (shadow) walkTextRoot(shadow);
    }
  };

  for (const rootNode of walkerRoots) {
    if (isExcluded(rootNode)) continue;
    walkTextRoot(rootNode);
  }

  const text = words.join('\n').slice(0, BODY_TEXT_BUDGET);
  const maxElements =
    typeof options?.limit === 'number' && options.limit > 0 ? Math.min(options.limit, 250) : 250;
  const ranked = [...rank.entries()].sort((a, b) => b[1] - a[1]);
  const keptElementIds = new Set(ranked.slice(0, maxElements).map(([id]) => id));
  const omittedElements = Math.max(0, rank.size - keptElementIds.size);
  const originalActionCount = actions.length;
  actions = actions.filter((action) => keptElementIds.has(Number(action.id.slice(1))));
  const omitted_actions = omittedOptionActions + originalActionCount - actions.length;
  structuralElements = structuralElements.filter((element) => keptElementIds.has(element.index));
  // Public actions and executor guards share the document's stable ref namespace.
  actions.forEach((a) => {
    if (typeof a.node === 'number') {
      const el = cache.nodes.get(a.node);
      if (el) {
        const actNum = indexElement(el);
        a.id = 'e' + actNum;
        a.node = actNum;
        cache.actionElements?.set(a.id, el);
        cache.actionElements?.set(actNum, el);
      }
    }
  });
  const page_key = cache.pageKey();
  const guards: Record<string | number, any> = {};

  for (const a of actions) {
    if (typeof a.node === 'number' && !(a.node in guards)) {
      guards[a.node] = cache.guard ? cache.guard(findIndexedElement(a.node)) : null;
    }
  }

  const semantics = actions.map(({ rect, ...rest }) => rest);
  const marker = [
    performance.timeOrigin,
    location.href,
    window.scrollX,
    window.scrollY,
    window.innerWidth,
    window.innerHeight,
    document.title,
    text,
    semantics,
    page_key[6],
  ];
  if (scrollInfo.pages_down > 0) {
    actions.push({
      id: 'scroll_down',
      kind: 'scroll',
      label: 'Scroll down',
      delta: 560,
      ...(typeof scrollInfo.containerIndex === 'number'
        ? { containerIndex: scrollInfo.containerIndex }
        : {}),
    });
  }
  if (scrollInfo.pages_up > 0) {
    actions.push({
      id: 'scroll_up',
      kind: 'scroll',
      label: 'Scroll up',
      delta: -560,
      ...(typeof scrollInfo.containerIndex === 'number'
        ? { containerIndex: scrollInfo.containerIndex }
        : {}),
    });
  }
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  if (interactionScope.activeModal) {
    marker.push({
      modal: interactionScope.activeModal,
      isolated: interactionScope.modalIsolated,
    });
  }
  if (scrollInfo.ambiguous || scrollInfo.backgroundBlocked) {
    marker.push({ scrollInfo });
  }

  // Clear single-pass layout cache
  DOM_CACHE.clearCache();

  return {
    url: location.href,
    title: document.title,
    w: window.innerWidth,
    h: window.innerHeight,
    text,
    scroll: {
      y: scrollInfo.scroll_y ?? 0,
      height: scrollInfo.total_height ?? window.innerHeight,
    },
    scrollInfo,
    actions,
    structuralElements,
    marker,
    page_key,
    guards,
    omitted_actions,
    omitted_elements: omittedElements,
    ...(interactionScope.activeModal ? { activeModal: interactionScope.activeModal } : {}),
    ...(interactionScope.modalIsolated ? { modalIsolated: true } : {}),
    ...(selectorMatched !== undefined ? { selectorMatched } : {}),
    ...(hasTextTruncated ? { textTruncated: true, omitted_text: omittedTextChars } : {}),
  };
}

/**
 * Pre-CDP 1ms instantaneous occlusion check with pointer-events: none piercing.
 * Returns valid target coordinates { x, y } or null if occluded, detached, or out of viewport.
 */
export function inPageCheckOcclusion(action: {
  node: number | string;
  kind?: string;
}): { x: number; y: number } | null {
  if (typeof document === 'undefined') return null;

  const e = findIndexedElement(action.node);
  if (!e) return null;
  const interactionScope = computeInteractionScope(window);
  if (
    interactionScope.focusTrapped &&
    !interactionScope.roots.some((root) => root === e || composedContains(root, e))
  ) {
    return null;
  }
  if (typeof (e as any).matches === 'function' && (e as any).matches(':disabled')) return null;
  if (typeof e.closest === 'function' && e.closest('[aria-disabled="true"],[inert]')) return null;

  if (
    action.kind === 'fill' &&
    ((e as any).readOnly || e.getAttribute?.('aria-readonly') === 'true')
  ) {
    return null;
  }

  // Use checkVisibility if available
  if (
    typeof (e as any).checkVisibility === 'function' &&
    !(e as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  ) {
    return null;
  }

  const r = e.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  if (
    !r.width ||
    !r.height ||
    x < 0 ||
    y < 0 ||
    x >= window.innerWidth ||
    y >= window.innerHeight
  ) {
    return null;
  }

  // Helper: Deep shadow-piercing elementFromPoint
  const deepElementFromPoint = (
    root: Document | ShadowRoot,
    px: number,
    py: number,
  ): Element | null => {
    let el =
      typeof (root as any).elementFromPoint === 'function'
        ? (root as any).elementFromPoint(px, py)
        : null;
    let sDepth = 0;
    while (el && sDepth < 20) {
      const sr = getShadowRoot(el);
      if (!sr || typeof sr.elementFromPoint !== 'function') break;
      const inner = sr.elementFromPoint(px, py);
      if (!inner || inner === el) break;
      el = inner;
      sDepth++;
    }
    return el;
  };

  // Helper: Composed hierarchy containment check (traverses parentNode and shadow host)
  const deepContains = (parent: Element, child: Element): boolean => {
    if (parent === child) return true;
    if (typeof parent.contains === 'function' && parent.contains(child)) return true;
    let curr: Node | null = child;
    while (curr) {
      if (curr === parent) return true;
      if ((curr as any).host) {
        curr = (curr as any).host;
      } else {
        curr = curr.parentNode;
      }
    }
    return false;
  };

  // Piercing patch: penetrate shadow roots and pierce pointer-events: none layers
  let hit = deepElementFromPoint(document, x, y);
  let depth = 0;
  while (hit && depth < 5) {
    const pe =
      typeof window.getComputedStyle === 'function'
        ? window.getComputedStyle(hit).pointerEvents
        : '';
    if (pe === 'none') {
      hit = hit.parentElement || ((hit.parentNode as any)?.host as Element) || null;
      depth++;
    } else {
      break;
    }
  }
  if (!hit) return null;

  // Click target must contain the hit element (the target itself, host, or child element like text/icon)
  let isHit = deepContains(e, hit) || hit === e;

  // Check if hit element is a label targeting e
  if (!isHit && hit.tagName === 'LABEL') {
    if ((hit as HTMLLabelElement).control === e || (hit as HTMLLabelElement).htmlFor === e.id) {
      isHit = true;
    }
  }

  // Backdrop / transparent mask piercing tolerance:
  // If hit is an overlay/backdrop and not e, check if temporarily ignoring it hits e
  if (!isHit && hit instanceof HTMLElement) {
    const cls = (
      hit.className && typeof hit.className === 'string' ? hit.className : ''
    ).toLowerCase();
    const role = (hit.getAttribute?.('role') || '').toLowerCase();
    const isOverlayOrBackdrop =
      cls.includes('backdrop') ||
      cls.includes('overlay') ||
      cls.includes('mask') ||
      cls.includes('scrim') ||
      cls.includes('dimmer') ||
      role === 'presentation';

    if (isOverlayOrBackdrop && hit !== document.body && hit !== document.documentElement) {
      const prevPE = hit.style.pointerEvents;
      try {
        hit.style.pointerEvents = 'none';
        const nextHit = deepElementFromPoint(document, x, y);
        if (nextHit && (deepContains(e, nextHit) || nextHit === e)) {
          isHit = true;
        }
      } finally {
        hit.style.pointerEvents = prevPE;
      }
    }
  }

  if (!isHit) {
    return null;
  }

  return { x, y };
}
