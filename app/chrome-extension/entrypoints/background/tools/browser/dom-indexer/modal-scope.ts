import type { ScrollInfo } from 'chrome-mcp-shared';
import {
  composedContains,
  composedParent,
  extractComposedVisibleText,
  isElementHiddenInComposedTree,
} from './composed-dom';
import { querySelectorAllDeep, querySelectorDeep } from './deep-query';
import { indexElement } from './index-state';
import { getDeepActiveElement, getSameRootReference } from '../dom-indexer';
export interface ActiveModalBlockerInfo {
  el: HTMLElement;
  coverage: number;
  stackingScore: number;
  kind: 'modal' | 'mask';
  name: string;
  isTrap?: boolean;
}

export interface InteractionScopeInfo {
  activeModal?: string;
  focusTrapped: boolean;
  modalIsolated: boolean;
  isConfirmationTrap: boolean;
  blockingLayerKind?: 'modal' | 'mask';
  modalElement?: HTMLElement;
  roots: Element[];
  scrollContainers: HTMLElement[];
}

/**
 * Detect active modal blocker using stacking score competition algorithm.
 * Evaluates Top-Layer, dialog role, aria-modal, z-index, and DOM order so
 * secondary confirmation traps are not obscured by large parent modals.
 */
const MODAL_SURFACE_CONTROL_SELECTOR =
  'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [tabindex]:not([tabindex="-1"]), dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

function hasPositionedOverlayAncestor(el: Element, win: Window): boolean {
  const seen = new Set<Element>();
  for (let cur = composedParent(el); cur && !seen.has(cur); cur = composedParent(cur)) {
    seen.add(cur);
    if (cur === win.document.body || cur === win.document.documentElement) break;
    try {
      const pos = win.getComputedStyle(cur).position;
      if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') {
        return true;
      }
    } catch {}
  }
  return false;
}

function isElementVisibleInViewport(
  el: Element,
  win: Window,
  vpWidth: number,
  vpHeight: number,
): boolean {
  if (!elementIsVisibleForScope(el, win)) return false;
  try {
    const rect = el.getBoundingClientRect();
    return rect.right > 0 && rect.left < vpWidth && rect.bottom > 0 && rect.top < vpHeight;
  } catch {
    return false;
  }
}

function maskHasVisibleModalSurface(
  maskEl: HTMLElement,
  win: Window,
  vpWidth: number,
  vpHeight: number,
): boolean {
  const active = getDeepActiveElement();
  if (active && active !== maskEl && composedContains(maskEl, active)) {
    return true;
  }
  const surfaceRoot = modalSurfaceRoot(maskEl, win);
  const candidateRoots = outerMostRoots(
    [
      surfaceRoot,
      ...modalPortalRoots(maskEl, win, surfaceRoot),
      ...referencedModalRoots(surfaceRoot, win),
      focusedOverlayRoot(maskEl, win),
    ],
    win,
  );
  for (const root of candidateRoots) {
    if (
      root !== maskEl &&
      isTopLayerSurface(root) &&
      isElementVisibleInViewport(root, win, vpWidth, vpHeight)
    ) {
      return true;
    }
    const descendants = querySelectorAllDeep(MODAL_SURFACE_CONTROL_SELECTOR, root);
    for (const el of descendants) {
      if (el === maskEl) continue;
      if (isElementVisibleInViewport(el, win, vpWidth, vpHeight)) return true;
    }
  }
  return false;
}

export function detectActiveModalBlocker(win: Window = window): ActiveModalBlockerInfo | null {
  try {
    const doc = win.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const vpWidth = win.innerWidth || doc.documentElement?.clientWidth || 1280;
    const vpHeight = win.innerHeight || doc.documentElement?.clientHeight || 800;
    const vpArea = vpWidth * vpHeight;

    const positionedCandidates = Array.from(
      doc.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover], [class*="modal"], [class*="dialog"], [class*="backdrop"], [class*="overlay"], [class*="mask"], [id*="modal"], [id*="dialog"], [id*="overlay"], [style*="fixed"], [style*="absolute"], body > div, body > section, body > aside',
      ),
    ) as HTMLElement[];
    const seenPositionedCandidates = new Set<HTMLElement>(positionedCandidates);

    try {
      const shadowCandidates = querySelectorAllDeep(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover], [class*="modal"], [class*="dialog"]',
        doc,
      );
      for (const sc of shadowCandidates) {
        if (isHTMLElementInWindow(sc, win) && !seenPositionedCandidates.has(sc)) {
          seenPositionedCandidates.add(sc);
          positionedCandidates.push(sc);
        }
      }
    } catch {}

    let topBlocker: ActiveModalBlockerInfo | null = null;

    for (let i = 0; i < positionedCandidates.length; i++) {
      const d = positionedCandidates[i];
      if (!d || isElementHiddenInComposedTree(d, win)) continue;
      let style: CSSStyleDeclaration;
      try {
        style = win.getComputedStyle(d);
      } catch {
        continue;
      }
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.pointerEvents === 'none' ||
        (style.opacity !== '' && Number.parseFloat(style.opacity) <= 0)
      )
        continue;
      const pos = style.position;
      const isPositioned =
        pos === 'fixed' ||
        pos === 'absolute' ||
        pos === 'sticky' ||
        hasPositionedOverlayAncestor(d, win);
      const tag = d.tagName.toLowerCase();
      const role = (d.getAttribute('role') || '').toLowerCase();
      const ariaModal = (d.getAttribute('aria-modal') || '').toLowerCase();

      const isNativeOpenDialog = tag === 'dialog' && Boolean((d as HTMLDialogElement).open);
      let isNativeModalDialog = false;
      if (isNativeOpenDialog) {
        try {
          isNativeModalDialog = (d as HTMLDialogElement).matches(':modal');
        } catch {
          isNativeModalDialog = false;
        }
      }
      if (ariaModal === 'false' && !isNativeModalDialog) continue;
      // An open non-modal <dialog> participates in the normal document flow and
      // must not turn into an interaction blocker merely because of its tag.
      if (isNativeOpenDialog && !isNativeModalDialog && ariaModal !== 'true') continue;
      const isExplicitModal = ariaModal === 'true' || role === 'alertdialog' || isNativeModalDialog;
      // Large positioned application shells are not evidence of a modal blocker.
      const hasModalIdentity = /modal|dialog|backdrop|overlay|mask/i.test(
        `${d.id} ${d.getAttribute('class') || ''}`,
      );
      const isPopover = Boolean((d as any).matches?.(':popover-open')) || d.hasAttribute('popover');
      if (isPopover && !isExplicitModal) continue;
      if (!isExplicitModal && !hasModalIdentity) continue;
      if (!isPositioned && !isNativeOpenDialog) continue;

      const rect = d.getBoundingClientRect();
      const ix = Math.max(0, Math.min(rect.right, vpWidth) - Math.max(rect.left, 0));
      const iy = Math.max(0, Math.min(rect.bottom, vpHeight) - Math.max(rect.top, 0));
      const cov = vpArea > 0 ? (ix * iy) / vpArea : 0;
      const declaredWidth = Number.parseFloat(style.width || d.style.width || '0');
      const declaredHeight = Number.parseFloat(style.height || d.style.height || '0');
      const hasBox =
        rect.width > 0 ||
        rect.height > 0 ||
        d.offsetWidth > 0 ||
        d.offsetHeight > 0 ||
        declaredWidth > 0 ||
        declaredHeight > 0;

      const qualifies =
        cov >= 0.6 ||
        (isExplicitModal && hasBox) ||
        (hasModalIdentity && hasBox && composedContains(d, getDeepActiveElement()));
      if (!qualifies) continue;

      const hasInputs = querySelectorAllDeep(
        'input, textarea, select, button, a[href], [role="button"], [role="menuitem"], [role="option"]',
        d,
      ).some((el) => el !== d && el.getAttribute('aria-hidden') !== 'true');
      const kind: 'modal' | 'mask' =
        isExplicitModal || role === 'dialog' || hasInputs ? 'modal' : 'mask';
      // A mask/backdrop without a visible modal surface or controls must not isolate the page.
      if (kind === 'mask' && !maskHasVisibleModalSurface(d, win, vpWidth, vpHeight)) {
        continue;
      }

      const id = d.id ? `#${d.id}` : '';
      const name =
        d.getAttribute('aria-label') ||
        extractComposedVisibleText(querySelectorDeep('h1, h2, h3, [role="heading"]', d), {
          maxLen: 40,
        }) ||
        undefined;
      const desc = name
        ? `${tag}${id} "${name}"`
        : `${tag}${id || (kind === 'mask' ? '.mask' : '.modal')}`;

      const textSnippet = `${desc} ${name || ''} ${extractComposedVisibleText(d, { maxLen: 300 })}`;
      const isDiscardOrConfirm =
        /(discard|abandon|unsaved|confirm|放弃|取消|未保存|确认放弃|是否放弃|离开)/i.test(
          textSnippet,
        );

      // Stacking score: Top-Layer > confirmation trap > alertdialog > aria-modal > z-index > DOM order
      let score = 0;
      const isPopoverOpen =
        Boolean((d as any).matches?.(':popover-open')) ||
        (d.hasAttribute('popover') && style.display !== 'none');
      if (isNativeOpenDialog || isPopoverOpen) {
        score += 1_000_000;
      }
      if (isDiscardOrConfirm) {
        score += 500_000;
      } else if (d.getAttribute('role') === 'alertdialog') {
        score += 200_000;
      } else if (d.getAttribute('aria-modal') === 'true') {
        score += 100_000;
      } else if (kind === 'modal') {
        score += 50_000;
      }

      let z = 0;
      if (style.zIndex && style.zIndex !== 'auto') {
        const parsedZ = parseInt(style.zIndex, 10);
        if (!isNaN(parsedZ)) z = parsedZ;
      }
      score += Math.max(0, Math.min(z, 99_999)) * 10;
      score += i;

      if (!topBlocker || score > topBlocker.stackingScore) {
        topBlocker = {
          el: d,
          coverage: cov,
          stackingScore: score,
          kind,
          name: isDiscardOrConfirm ? `${desc} [CONFIRMATION_TRAP]` : desc,
          isTrap: isDiscardOrConfirm,
        };
      }
    }

    return topBlocker;
  } catch {
    return null;
  }
}

function elementIsVisibleForScope(el: Element, win: Window): boolean {
  try {
    if (isElementHiddenInComposedTree(el, win)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch {
    return false;
  }
}

function isHTMLElementInWindow(
  value: Element | null | undefined,
  win: Window,
): value is HTMLElement {
  const ctor = (win as unknown as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  return Boolean(value && ctor && value instanceof ctor);
}

function isTopLayerSurface(el: Element): boolean {
  const html = el as HTMLElement;
  try {
    if (html.matches(':popover-open')) return true;
  } catch {}
  return (
    el.tagName.toLowerCase() === 'dialog' &&
    Boolean((el as HTMLDialogElement).open) &&
    (() => {
      try {
        return (el as HTMLDialogElement).matches(':modal');
      } catch {
        return el.getAttribute('aria-modal') === 'true';
      }
    })()
  );
}

function isOverlaySurfaceElement(el: Element): boolean {
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (el.getAttribute('aria-modal') === 'true' || isTopLayerSurface(el)) return true;
  const identity = [
    el.id,
    el.getAttribute('class'),
    el.getAttribute('data-testid'),
    el.getAttribute('data-state'),
    el.tagName,
  ]
    .filter(Boolean)
    .join(' ');
  return /(?:modal|dialog|overlay|popup|popover|sheet|drawer|portal|backdrop|mask)/i.test(identity);
}

function isOverlaySurfaceContainer(parent: Element, child: Element): boolean {
  if (isOverlaySurfaceElement(parent)) return true;
  // Custom elements are structural overlay hosts even when the component
  // author did not expose a framework-specific class or role.
  return parent.tagName.includes('-') && composedContains(parent, child);
}

function modalSurfaceRoot(blocker: HTMLElement, win: Window): HTMLElement {
  let current = blocker;
  const seen = new Set<Element>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = composedParent(current);
    if (
      !isHTMLElementInWindow(parent, win) ||
      parent === win.document.body ||
      parent === win.document.documentElement ||
      !isOverlaySurfaceContainer(parent, current)
    ) {
      break;
    }
    current = parent;
  }
  return current;
}

function referencedModalRoots(root: HTMLElement, win: Window): HTMLElement[] {
  const roots: HTMLElement[] = [];
  const controls = querySelectorAllDeep(
    '[aria-controls], [aria-owns], [popovertarget], [commandfor]',
    root,
  );
  for (const control of controls) {
    if (!isHTMLElementInWindow(control, win)) continue;
    if (
      control.getAttribute('aria-expanded') === 'false' ||
      !elementIsVisibleForScope(control, win)
    )
      continue;
    if ((control as HTMLButtonElement).disabled) continue;
    const ids = [
      control.getAttribute('aria-controls'),
      control.getAttribute('aria-owns'),
      control.getAttribute('popovertarget'),
      control.getAttribute('commandfor'),
    ]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(/\s+/))
      .filter(Boolean);
    for (const id of ids) {
      const target = getSameRootReference(control, id);
      if (
        isHTMLElementInWindow(target, win) &&
        target !== control &&
        elementIsVisibleForScope(target, win)
      ) {
        roots.push(target);
      }
    }
  }
  return roots;
}

function focusedOverlayRoot(blocker: HTMLElement, win: Window): HTMLElement | null {
  const active = getDeepActiveElement();
  if (!active || composedContains(blocker, active)) return null;
  for (let current: Element | null = active; current; current = composedParent(current)) {
    if (current === win.document.body || current === win.document.documentElement) break;
    if (isHTMLElementInWindow(current, win) && isTopLayerSurface(current)) return current;
  }
  return null;
}

function outerMostRoots(roots: Array<Element | null | undefined>, win: Window): HTMLElement[] {
  const unique = Array.from(
    new Set(
      roots.filter(
        (root): root is HTMLElement => isHTMLElementInWindow(root, win) && root.isConnected,
      ),
    ),
  );
  return unique.filter(
    (root) =>
      !unique.some(
        (other) =>
          other !== root && composedContains(other, root) && !composedContains(root, other),
      ),
  );
}

function portalHasOpenOwner(portal: HTMLElement, ownerRoot: HTMLElement, win: Window): boolean {
  const portalId = portal.id;
  if (!portalId) return false;
  const controls = querySelectorAllDeep(
    '[aria-controls], [aria-owns], [popovertarget], [commandfor]',
    ownerRoot,
  );
  for (const control of controls) {
    if (!elementIsVisibleForScope(control, win)) continue;
    const references = [
      control.getAttribute('aria-controls'),
      control.getAttribute('aria-owns'),
      control.getAttribute('popovertarget'),
    ]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(/\s+/));
    if (!references.includes(portalId)) continue;
    if (control.getAttribute('aria-expanded') === 'false') continue;
    return true;
  }
  return false;
}

function modalPortalRoots(
  blocker: HTMLElement,
  win: Window,
  ownerRoot: HTMLElement = blocker,
): HTMLElement[] {
  const portalSelector = [
    '[data-radix-popper-content-wrapper]',
    '[data-radix-portal]',
    '[data-floating-ui-portal]',
    '[data-headlessui-portal]',
    '[data-portal]',
    ':popover-open',
    'dialog[open]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '.ant-select-dropdown',
    '.ant-picker-dropdown',
    '.ant-dropdown',
    '.ant-message',
    '.ant-notification',
    '.MuiMenu-root',
    '.MuiPopover-root',
    '.MuiAutocomplete-popper',
    '.el-select-dropdown',
    '.el-dropdown-menu',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="tooltip"]',
  ].join(',');
  const zIndex = (el: Element): number => {
    const raw = win.getComputedStyle(el).zIndex;
    const parsed = raw === 'auto' ? 0 : Number.parseInt(raw || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const blockerZ = zIndex(blocker);
  const all = querySelectorAllDeep('*', win.document);
  return all.filter((el): el is HTMLElement => {
    if (!isHTMLElementInWindow(el, win) || el === blocker) return false;
    if (
      (!el.matches(portalSelector) && !isOverlaySurfaceElement(el)) ||
      !elementIsVisibleForScope(el, win)
    )
      return false;
    if (composedContains(blocker, el)) return true;
    if (composedContains(el, blocker)) return false;
    // Class names and generic portal markers only discover a candidate. A
    // detached portal enters the interaction scope only when it is a real
    // top-layer surface, declares modal semantics, or an open trigger owns it.
    const role = (el.getAttribute('role') || '').toLowerCase();
    const explicitModal =
      role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
    if (!isTopLayerSurface(el) && !explicitModal && !portalHasOpenOwner(el, ownerRoot, win))
      return false;

    const portalZ = zIndex(el);
    if (isTopLayerSurface(el) && !isTopLayerSurface(blocker)) return true;
    if (portalZ !== blockerZ) return portalZ > blockerZ;
    return Boolean(blocker.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
}

function selectorForScopeElement(el: Element): string | undefined {
  const escapeSelector = (value: string) =>
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : value.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  if (el.id) return `#${escapeSelector(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${escapeSelector(testId)}"]`;
  const role = el.getAttribute('role');
  if (role) return `${el.tagName.toLowerCase()}[role="${escapeSelector(role)}"]`;
  return undefined;
}

const NON_SCROLL_CONTAINER_TAGS = new Set([
  'textarea',
  'input',
  'select',
  'option',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'path',
  'img',
  'br',
  'hr',
  'canvas',
  'video',
  'audio',
]);

function isSecondaryScrollChrome(el: HTMLElement, win: Window): boolean {
  const tag = (el.tagName || '').toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (tag === 'main' || tag === 'article' || role === 'main') return false;
  if (
    tag === 'nav' ||
    tag === 'aside' ||
    tag === 'header' ||
    tag === 'footer' ||
    role === 'navigation' ||
    role === 'complementary' ||
    role === 'banner' ||
    role === 'contentinfo' ||
    role === 'menu' ||
    role === 'menubar' ||
    role === 'tablist'
  ) {
    return true;
  }
  const identity = [
    el.id,
    typeof el.className === 'string' ? el.className : el.getAttribute('class') || '',
    el.getAttribute('data-testid'),
    el.getAttribute('aria-label'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (
    /(sidebar|side-nav|sidenav|navigation|navbar|rail|drawer|menu-list|toc|left-rail|right-rail)/i.test(
      identity,
    )
  ) {
    return true;
  }
  try {
    const rect = el.getBoundingClientRect();
    const vw = win.innerWidth || win.document.documentElement?.clientWidth || 1280;
    if (rect.width > 0 && rect.width < Math.min(320, vw * 0.3)) {
      return true;
    }
  } catch {}
  return false;
}

function scrollContainersInRoots(roots: Element[], win: Window): HTMLElement[] {
  const found: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const root of roots) {
    const all = [
      ...(isHTMLElementInWindow(root, win) ? [root] : []),
      ...querySelectorAllDeep('*', root),
    ];
    for (const el of all) {
      if (!isHTMLElementInWindow(el, win) || seen.has(el)) continue;
      if (el === win.document.body || el === win.document.documentElement) continue;
      const tag = (el.tagName || '').toLowerCase();
      if (NON_SCROLL_CONTAINER_TAGS.has(tag)) continue;
      if (!(el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2)) continue;
      let style: CSSStyleDeclaration;
      try {
        style = win.getComputedStyle(el);
      } catch {
        // Inaccessible stylesheets must not make observation fail open.
        continue;
      }
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
      if (isElementHiddenInComposedTree(el, win)) continue;
      seen.add(el);
      found.push(el);
    }
  }
  return found;
}

export function buildScopedScrollInfo(
  roots: Element[],
  win: Window = window,
  options?: { modalActive?: boolean; containers?: HTMLElement[] },
): ScrollInfo {
  const containers = options?.containers ?? scrollContainersInRoots(roots, win);
  const doc = win.document;
  const docViewportHeight = win.innerHeight || doc.documentElement?.clientHeight || 1;
  const docScrollY = Math.max(
    0,
    win.scrollY || win.pageYOffset || doc.documentElement?.scrollTop || doc.body?.scrollTop || 0,
  );
  const docTotalHeight = Math.max(
    doc.body?.scrollHeight || 0,
    doc.documentElement?.scrollHeight || 0,
    doc.body?.offsetHeight || 0,
    doc.documentElement?.offsetHeight || 0,
    docViewportHeight,
  );
  const docScrolls = docTotalHeight > docViewportHeight + 2;

  if (
    containers.length === 1 &&
    (options?.modalActive || !docScrolls || !isSecondaryScrollChrome(containers[0], win))
  ) {
    const container = containers[0];
    const viewportHeight = Math.max(1, container.clientHeight || 1);
    const totalHeight = Math.max(container.scrollHeight, viewportHeight);
    const scrollY = Math.max(0, container.scrollTop || 0);
    return {
      pages_up: Number((scrollY / viewportHeight).toFixed(1)),
      pages_down: Number(
        (Math.max(0, totalHeight - (scrollY + viewportHeight)) / viewportHeight).toFixed(1),
      ),
      scroll_y: Math.round(scrollY),
      total_height: Math.round(totalHeight),
      viewport_height: Math.round(viewportHeight),
      containerIndex: indexElement(container),
      containerTag: container.tagName.toLowerCase(),
      ...(selectorForScopeElement(container)
        ? { containerSelector: selectorForScopeElement(container) }
        : {}),
      ambiguous: false,
      scope: 'element',
    };
  }

  if (containers.length > 1 && (options?.modalActive || !docScrolls)) {
    return {
      pages_up: 0,
      pages_down: 0,
      scroll_y: 0,
      total_height: 0,
      viewport_height: 0,
      ambiguous: true,
      scope: 'ambiguous',
    };
  }

  if (options?.modalActive) {
    const viewportHeight = Math.max(
      1,
      win.innerHeight || win.document.documentElement?.clientHeight || 1,
    );
    return {
      pages_up: 0,
      pages_down: 0,
      scroll_y: 0,
      total_height: viewportHeight,
      viewport_height: viewportHeight,
      ambiguous: false,
      scope: 'none',
      backgroundBlocked: true,
    };
  }

  return {
    pages_up: Number((docScrollY / docViewportHeight).toFixed(1)),
    pages_down: Number(
      (Math.max(0, docTotalHeight - (docScrollY + docViewportHeight)) / docViewportHeight).toFixed(
        1,
      ),
    ),
    scroll_y: Math.round(docScrollY),
    total_height: Math.round(docTotalHeight),
    viewport_height: Math.round(docViewportHeight),
    ambiguous: false,
    scope: 'page',
  };
}

export function computeInteractionScope(
  win: Window = window,
  options?: { explicitScope?: boolean; includeScrollContainers?: boolean },
): InteractionScopeInfo {
  const blocker = detectActiveModalBlocker(win);
  const focusTrapped = Boolean(blocker);
  const modalIsolated = Boolean(blocker && !options?.explicitScope);
  let roots: Element[] = [];
  let modalElement: HTMLElement | undefined;

  if (blocker) {
    const surfaceRoot = modalSurfaceRoot(blocker.el, win);
    modalElement = surfaceRoot;
    roots = outerMostRoots(
      [
        surfaceRoot,
        blocker.el,
        ...modalPortalRoots(blocker.el, win, surfaceRoot),
        ...referencedModalRoots(surfaceRoot, win),
        focusedOverlayRoot(blocker.el, win),
      ],
      win,
    );
  } else if (win.document.body) {
    roots = [win.document.body];
  }

  return {
    activeModal: blocker?.name,
    focusTrapped,
    modalIsolated,
    isConfirmationTrap: blocker?.isTrap === true,
    blockingLayerKind: blocker?.kind,
    modalElement,
    roots,
    scrollContainers:
      options?.includeScrollContainers === false ? [] : scrollContainersInRoots(roots, win),
  };
}

/**
 * Focus Trap and Modal Focus Guard:
 * Pulls and locks DOM keyboard focus into the active modal dialog or specified modal root.
 * Ensures subsequent Tab, Enter, and keyboard shortcuts don't bleed into background DOM.
 */
export function inPageEnsureModalFocus(modalEl?: Element): boolean {
  if (typeof document === 'undefined') return false;
  let target = modalEl;
  if (!target) {
    const blocker = detectActiveModalBlocker(typeof window !== 'undefined' ? window : undefined);
    if (blocker?.el) {
      target = blocker.el;
    }
  }
  if (!target) return false;

  // Check if current active element is already inside target
  if (composedContains(target, getDeepActiveElement())) {
    return true;
  }

  // Find first focusable element inside the modal (penetrating Shadow DOM)
  const focusable = querySelectorAllDeep(
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], a[href]',
    target,
  );
  for (const el of focusable) {
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        try {
          el.focus();
          return true;
        } catch {}
      }
    }
  }

  // Fallback: focus modal container itself
  if (target instanceof HTMLElement) {
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    try {
      target.focus();
      return true;
    } catch {}
  }
  return false;
}
