import type { PageAsset } from 'chrome-mcp-shared';
import {
  composedChildren,
  composedClosest,
  extractComposedVisibleText,
} from './composed-dom';

export interface SamplingCandidate {
  node: Element;
  tag: string;
  rect: DOMRect;
  isFile: boolean;
  isInteractive: boolean;
  inShadowDom?: boolean;
  isClosedShadowHost?: boolean;
  isSelectOption?: boolean;
  parentSelect?: HTMLSelectElement;
  optionValue?: string;
  optionLabel?: string;
  text?: string;
  isTableStructure?: boolean;
}

export interface PageSamplingResult {
  candidates: SamplingCandidate[];
  assets: PageAsset[];
  assetRegistry: Array<{ kind: string; el: Element; src?: string }>;
  totalOriginalNodes: number;
  selectOptionOmissions: Map<HTMLSelectElement, { total: number; shown: number }>;
  virtualizedCount: number;
  virtualizedSummary: Array<{ selector: string; count: number }>;
}

export interface PageSamplingOptions {
  roots: Element[];
  winWidth: number;
  winHeight: number;
  threshold: number;
  shouldVirtualize: boolean;
  focusForVirtualization: Element | null;
  isExcluded: (element: Element, isRoot?: boolean) => boolean;
  isInteractive: (
    element: Element,
    style: CSSStyleDeclaration,
    parentHasPointer?: boolean,
  ) => boolean;
  isAdOrTrackingElement: (element: Element) => boolean;
  isInformationalNode: (element: Element) => boolean;
  getShadowRoot: (node: Node | null | undefined) => ShadowRoot | null;
  isInteractiveSvgNode: (
    element: Element,
    style?: CSSStyleDeclaration,
    parentHasPointer?: boolean,
  ) => boolean;
  isCustomElement: (node: Node | null | undefined) => boolean;
  getTableObservationRole: (element: Element) => string | null;
  composedContains: (ancestor: Node | null, descendant: Node | null) => boolean;
}

const DROPPED_TAGS = new Set([
  'script',
  'style',
  'head',
  'meta',
  'link',
  'title',
  'noscript',
  'template',
]);

const SVG_INTERNAL_TAGS = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'use',
  'defs',
  'clippath',
  'mask',
  'pattern',
  'text',
  'tspan',
  'g',
]);

function isProtectedFromVirtualization(
  element: Element,
  focused: Element | null,
  contains: PageSamplingOptions['composedContains'],
): boolean {
  if (contains(element, focused)) return true;
  const tag = (element.tagName || '').toLowerCase();
  if (['header', 'nav', 'footer', 'dialog', 'form', 'main'].includes(tag)) return true;
  const role = (element.getAttribute('role') || '').toLowerCase();
  if (
    [
      'navigation',
      'banner',
      'contentinfo',
      'search',
      'dialog',
      'alertdialog',
      'menu',
      'menubar',
      'tablist',
    ].includes(role)
  ) {
    return true;
  }
  if (
    composedClosest(
      element,
      'header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], dialog',
    )
  ) {
    return true;
  }
  try {
    const position = window.getComputedStyle(element).position;
    if (position === 'fixed' || position === 'sticky') return true;
  } catch {}
  return false;
}

function childSignature(element: Element): string {
  const tag = (element.tagName || '').toLowerCase();
  let classSignature = '';
  const rawClass =
    typeof element.className === 'string' ? element.className : element.getAttribute('class') || '';
  if (rawClass.trim()) {
    const parts = rawClass
      .trim()
      .split(/\s+/)
      .filter(
        (part) =>
          !/^(active|selected|hover|focus|current|first|last|odd|even|visible|show|open|hide)$/i.test(
            part,
          ),
      )
      .slice(0, 2)
      .sort()
      .join('.');
    if (parts) classSignature = `.${parts}`;
  }
  const role = element.getAttribute('role');
  const testId = element.getAttribute('data-testid')?.replace(/[-_]\d+$/, '');
  const testIdPart = testId ? `[data-testid*="${testId}"]` : '';
  return role
    ? `${tag}${classSignature}${testIdPart}[role="${role}"]`
    : `${tag}${classSignature}${testIdPart}`;
}

export function samplePage(options: PageSamplingOptions): PageSamplingResult {
  const candidates: SamplingCandidate[] = [];
  const assets: PageAsset[] = [];
  const assetRegistry: Array<{ kind: string; el: Element; src?: string }> = [];
  const selectOptionOmissions = new Map<HTMLSelectElement, { total: number; shown: number }>();
  const virtualizedSummary: Array<{ selector: string; count: number }> = [];
  let totalOriginalNodes = 0;
  let assetSequence = 0;
  let virtualizedCount = 0;
  const visited = new Set<Element>();
  const NATIVE_SHADOW_SKIP_TAGS = new Set(['input', 'textarea', 'select']);

  const pushAsset = (
    kind: PageAsset['kind'],
    element: Element,
    rect: DOMRect,
    src?: string,
    alt?: string,
  ) => {
    if (rect.width < 8 || rect.height < 8) return;
    if (
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > options.winHeight ||
      rect.left > options.winWidth
    ) {
      return;
    }
    assetSequence++;
    assetRegistry.push({ kind, el: element, src });
    assets.push({
      index: assetSequence,
      kind,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      ...(src ? { src } : {}),
      ...(alt ? { alt } : {}),
    });
  };

  function traverse(
    node: Element,
    propagatingParentRect?: DOMRect | null,
    parentHasPointer = false,
    insideShadow = false,
  ) {
    if (!node || visited.has(node)) return;
    if (options.isExcluded(node, false)) return;
    visited.add(node);
    totalOriginalNodes++;

    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'body' || tag === 'html') {
      let style: CSSStyleDeclaration | null = null;
      try {
        style = window.getComputedStyle(node);
      } catch {}
      const nextPointer = style?.cursor === 'pointer' || parentHasPointer;
      for (const child of composedChildren(node)) {
        const childInShadow = insideShadow || child.getRootNode?.()?.nodeType === 11;
        traverse(child, propagatingParentRect, nextPointer, childInShadow);
      }
      return;
    }

    if (tag === 'option' || DROPPED_TAGS.has(tag)) return;
    if (SVG_INTERNAL_TAGS.has(tag)) {
      const insideSvg = Boolean(composedClosest(node, 'svg'));
      if (insideSvg) {
        let style: CSSStyleDeclaration | undefined;
        try {
          style = window.getComputedStyle(node);
        } catch {}
        if (!options.isInteractiveSvgNode(node, style, parentHasPointer)) return;
      }
    }
    if (typeof Element !== 'undefined' && !(node instanceof Element)) return;
    if (options.isAdOrTrackingElement(node)) return;
    if (
      (node as HTMLElement).hidden === true ||
      node.hasAttribute('hidden') ||
      node.hasAttribute('inert') ||
      (node as any).inert === true ||
      node.getAttribute('aria-hidden') === 'true'
    ) {
      return;
    }

    let style: CSSStyleDeclaration | null = null;
    try {
      style = window.getComputedStyle(node);
    } catch {}
    if (!style) return;

    const isFile = tag === 'input' && (node as HTMLInputElement).type === 'file';
    const isSlot = tag === 'slot';
    const isContents = style.display === 'contents' || isSlot;
    if (!isFile) {
      if (style.display === 'none') return;
      if (parseFloat(style.opacity || '1') <= 0) return;
      if (!isSlot && (style.visibility === 'hidden' || style.visibility === 'collapse')) {
        // CSS visibility:hidden can be overridden by a visibility:visible descendant,
        // so skip indexing this element but continue traversing composed children.
        const hiddenNextPointer = style.cursor === 'pointer' || parentHasPointer;
        const hiddenChildren = NATIVE_SHADOW_SKIP_TAGS.has(tag)
          ? Array.from(node.children)
          : composedChildren(node);
        for (const child of hiddenChildren) {
          const childInShadow =
            child.getRootNode?.()?.nodeType === 11 || (insideShadow && !isSlot);
          traverse(child, propagatingParentRect, hiddenNextPointer, childInShadow);
        }
        return;
      }
      if (!isContents && typeof (node as any).checkVisibility === 'function') {
        if (!(node as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return;
        }
      }
    }

    const shadowRoot = NATIVE_SHADOW_SKIP_TAGS.has(tag) ? null : options.getShadowRoot(node);
    const rawChildren = NATIVE_SHADOW_SKIP_TAGS.has(tag)
      ? Array.from(node.children)
      : composedChildren(node);
    const effectiveInShadow = insideShadow || node.getRootNode?.()?.nodeType === 11;

    const rect = node.getBoundingClientRect();
    const isZeroSize = isContents || rect.width <= 0 || rect.height <= 0;
    if (!isFile) {
      if (isZeroSize) {
        if (rawChildren.length === 0 && !shadowRoot) return;
      } else if (
        rect.top > options.winHeight + options.threshold ||
        rect.bottom < -options.threshold ||
        rect.left > options.winWidth + options.threshold ||
        rect.right < -options.threshold
      ) {
        return;
      }
    }

    if (!isZeroSize) {
      if (tag === 'img') {
        const image = node as HTMLImageElement;
        pushAsset(
          'img',
          image,
          rect,
          image.currentSrc || image.src || undefined,
          image.alt || undefined,
        );
      } else if (tag === 'canvas' || tag === 'video') {
        pushAsset(tag, node, rect);
      } else if (assets.length < 40) {
        const background = style.backgroundImage;
        if (background && background !== 'none') {
          const match = /url\(["']?([^"')]+)["']?\)/.exec(background);
          if (match) pushAsset('bg-image', node, rect, match[1]);
        }
      }
    }

    const currentHasPointer = style.cursor === 'pointer';
    const interactive = options.isInteractive(node, style, parentHasPointer);
    const informational = !interactive && options.isInformationalNode(node);
    const tableRole = options.getTableObservationRole(node);

    if (propagatingParentRect && !interactive && !isFile && !informational && tableRole === null) {
      const overlapWidth = Math.max(
        0,
        Math.min(rect.right, propagatingParentRect.right) -
          Math.max(rect.left, propagatingParentRect.left),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(rect.bottom, propagatingParentRect.bottom) -
          Math.max(rect.top, propagatingParentRect.top),
      );
      const childArea = rect.width * rect.height;
      if (childArea > 0 && (overlapWidth * overlapHeight) / childArea >= 0.99) {
        const nextPointer = currentHasPointer || parentHasPointer;
        for (const child of rawChildren) {
          const childInShadow =
            Boolean(shadowRoot) ||
            child.getRootNode?.()?.nodeType === 11 ||
            (effectiveInShadow && !isSlot);
          traverse(child, propagatingParentRect, nextPointer, childInShadow);
        }
        return;
      }
    }

    const hasInformationalText =
      informational && extractComposedVisibleText(node, { maxLen: 16 }).length > 0;
    const isClosedShadowHost =
      options.isCustomElement(node) &&
      shadowRoot === null &&
      (interactive ||
        style.cursor === 'pointer' ||
        node.hasAttribute('aria-label') ||
        node.hasAttribute('role') ||
        (node as HTMLElement).tabIndex >= 0);
    const hasFormControlDescendant = (element: Element, maxDepth = 2): boolean => {
      if (maxDepth <= 0) return false;
      for (const child of composedChildren(element)) {
        const childTag = (child.tagName || '').toLowerCase();
        if (['input', 'select', 'textarea', 'button'].includes(childTag)) return true;
        if (hasFormControlDescendant(child, maxDepth - 1)) return true;
      }
      return false;
    };
    const isWrapperOverFormControl =
      ['label', 'span', 'div'].includes(tag) && hasFormControlDescendant(node, 2);

    if (
      !isZeroSize &&
      !isWrapperOverFormControl &&
      (interactive ||
        isFile ||
        (informational && hasInformationalText) ||
        isClosedShadowHost ||
        tableRole !== null)
    ) {
      candidates.push({
        node,
        tag,
        rect,
        isFile,
        isInteractive: interactive || isFile || isClosedShadowHost,
        inShadowDom: effectiveInShadow || (isClosedShadowHost ? true : undefined),
        isClosedShadowHost: isClosedShadowHost ? true : undefined,
        isTableStructure: tableRole !== null,
      });
    }

    if (tag === 'select' && (node as HTMLSelectElement).options) {
      const select = node as HTMLSelectElement;
      const enabledOptions = Array.from(select.options).filter(
        (option) => !option.disabled && !composedClosest(option, 'optgroup[disabled]'),
      );
      const shownOptions = enabledOptions.slice(0, 50);
      for (const option of shownOptions) {
        candidates.push({
          node: option,
          tag: 'option',
          rect,
          isFile: false,
          isInteractive: true,
          inShadowDom: effectiveInShadow,
          isSelectOption: true,
          parentSelect: select,
          optionValue: option.value,
          optionLabel: option.label || option.text || option.value,
        });
      }
      if (enabledOptions.length > shownOptions.length) {
        selectOptionOmissions.set(select, {
          total: enabledOptions.length,
          shown: shownOptions.length,
        });
      }
    }

    const nextPropagatingRect =
      !isZeroSize && interactive && (tag === 'button' || tag === 'a')
        ? rect
        : propagatingParentRect;
    const nextPointer = currentHasPointer || parentHasPointer;
    let childrenToTraverse = rawChildren;

    if (options.shouldVirtualize && rawChildren.length >= 4) {
      let containerRect: DOMRect | null = null;
      try {
        const parentStyle = window.getComputedStyle(node);
        const inlineStyle = (node as HTMLElement).style;
        const overflow = `${parentStyle?.overflowY || inlineStyle?.overflowY || ''} ${parentStyle?.overflow || inlineStyle?.overflow || ''}`;
        if (/(auto|scroll|hidden|clip)/i.test(overflow)) {
          containerRect = node.getBoundingClientRect();
        }
      } catch {}

      const groups = new Map<string, Element[]>();
      for (const child of rawChildren) {
        const signature = childSignature(child);
        const group = groups.get(signature) || [];
        group.push(child);
        groups.set(signature, group);
      }

      const folded = new Set<Element>();
      for (const [signature, items] of groups) {
        if (items.length < 4) continue;
        const visible: Element[] = [];
        const offscreen: Element[] = [];
        for (const item of items) {
          if (
            isProtectedFromVirtualization(
              item,
              options.focusForVirtualization,
              options.composedContains,
            )
          ) {
            visible.push(item);
            continue;
          }
          const childRect = item.getBoundingClientRect();
          const insideContainer =
            !containerRect ||
            (childRect.bottom >= containerRect.top - 60 &&
              childRect.top <= containerRect.bottom + 60 &&
              childRect.right >= containerRect.left &&
              childRect.left <= containerRect.right);
          const inViewport =
            insideContainer &&
            childRect.bottom >= -60 &&
            childRect.top <= options.winHeight + 100 &&
            childRect.right >= 0 &&
            childRect.left <= options.winWidth;
          (inViewport ? visible : offscreen).push(item);
        }
        if (offscreen.length < 3) continue;
        const foldedItems = offscreen.slice(1);
        for (const item of foldedItems) folded.add(item);
        virtualizedCount += foldedItems.length;
        const parentTag = (node.tagName || '').toLowerCase();
        const parentId = node.id ? `#${node.id}` : '';
        const parentClass =
          typeof node.className === 'string' && node.className.trim()
            ? `.${node.className.trim().split(/\s+/)[0]}`
            : '';
        virtualizedSummary.push({
          selector: `${parentTag}${parentId || parentClass} > ${signature}`,
          count: foldedItems.length,
        });
        const markerRect = offscreen[0].getBoundingClientRect();
        candidates.push({
          node: items[0],
          tag: 'virtual_marker',
          rect: {
            x: markerRect.x,
            y: markerRect.y,
            top: markerRect.top,
            bottom: markerRect.bottom,
            left: markerRect.left,
            right: markerRect.right,
            width: markerRect.width,
            height: markerRect.height,
          } as DOMRect,
          isFile: false,
          isInteractive: false,
          ...({
            isVirtualMarker: true,
            virtualCount: foldedItems.length,
            virtualSig: signature,
          } as any),
        });
      }
      childrenToTraverse = rawChildren.filter((child) => !folded.has(child));
    }

    for (const child of childrenToTraverse) {
      const childInShadow =
        Boolean(shadowRoot) ||
        child.getRootNode?.()?.nodeType === 11 ||
        (effectiveInShadow && !isSlot);
      traverse(child, nextPropagatingRect, nextPointer, childInShadow);
    }
  }

  for (const root of options.roots) {
    if (!options.isExcluded(root, true)) {
      const rootInShadow = root.getRootNode?.()?.nodeType === 11;
      traverse(root, null, false, rootInShadow);
    }
  }

  candidates.sort((a, b) => {
    const deltaY =
      Math.round(a.rect?.y ?? a.rect?.top ?? 0) - Math.round(b.rect?.y ?? b.rect?.top ?? 0);
    if (Math.abs(deltaY) > 4) return deltaY;
    return Math.round(a.rect?.x ?? a.rect?.left ?? 0) - Math.round(b.rect?.x ?? b.rect?.left ?? 0);
  });

  return {
    candidates,
    assets,
    assetRegistry,
    totalOriginalNodes,
    selectOptionOmissions,
    virtualizedCount,
    virtualizedSummary,
  };
}
