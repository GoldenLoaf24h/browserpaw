import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDomQueryCache,
  findExistingElementIndex,
  indexElement,
  inPageDOMPruner,
  inPageRemoveHighlights,
  isElementHiddenInComposedTree,
  querySelectorAllDeep,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { isLocatorCandidateVisible } from '../entrypoints/background/tools/browser/dom-indexer/locators';

const a11yHelperPath = path.resolve(__dirname, '../inject-scripts/accessibility-tree-helper.js');
const a11yHelperSource = fs.readFileSync(a11yHelperPath, 'utf8');

function mockRect(el: Element, x: number, y: number, width = 100, height = 30): DOMRect {
  const rect = {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }),
  } as DOMRect;
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: vi.fn(() => rect),
  });
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
  return rect;
}

function loadAccessibilityTreeHelper(): void {
  const win = window as any;
  delete win.__ACCESSIBILITY_TREE_HELPER_INITIALIZED__;
  delete win.__mcpElementMap;
  delete win.__claudeElementMap;
  delete win.__mcpRefCounter;
  delete win.__claudeRefCounter;
  delete win.__mcpElementReverseMap;
  delete win.__mcpElementReverseMapSource;
  delete win.__generateAccessibilityTree;
  (0, eval)(a11yHelperSource);
}

describe('Phase 3 performance hot-path optimizations & modularization', () => {
  let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    document.body.innerHTML = '';
    originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('accessibility-tree-helper.js WeakMap reverse refs & per-call caches', () => {
    it('reuses stable refs via WeakMap, adopts external live refs, and prunes dead WeakRefs', () => {
      loadAccessibilityTreeHelper();
      const win = window as any;

      const btn1 = document.createElement('button');
      btn1.textContent = 'Save';
      const btn2 = document.createElement('button');
      btn2.textContent = 'Cancel';
      document.body.append(btn1, btn2);
      mockRect(document.body, 0, 0, 1280, 800);
      mockRect(btn1, 10, 10);
      mockRect(btn2, 120, 10);

      win.__mcpElementMap.ref_ext = new WeakRef(btn2);
      win.__mcpElementMap.ref_dead = { deref: () => undefined };

      const first = win.__generateAccessibilityTree('interactive');
      expect(win.__mcpElementReverseMap).toBeInstanceOf(WeakMap);
      expect(win.__mcpElementMap.ref_dead).toBeUndefined();
      expect(first.pageContent).toContain('[ref=ref_ext]');
      expect(first.pageContent).toContain('"Save"');

      const assignedSaveRef = win.__mcpElementReverseMap.get(btn1);
      expect(assignedSaveRef).toMatch(/^ref_\d+$/);
      expect(first.pageContent).toContain(`[ref=${assignedSaveRef}]`);

      const second = win.__generateAccessibilityTree('interactive');
      expect(second.pageContent).toContain(`[ref=${assignedSaveRef}]`);
      expect(second.pageContent).toContain('[ref=ref_ext]');
    });

    it('calls getComputedStyle and getBoundingClientRect at most once per element per traversal without stale cross-call caching', () => {
      loadAccessibilityTreeHelper();
      const win = window as any;

      const container = document.createElement('div');
      const buttons: HTMLButtonElement[] = [];
      for (let idx = 0; idx < 40; idx++) {
        const button = document.createElement('button');
        button.textContent = `Action ${idx}`;
        mockRect(button, 10, 10 + idx * 15, 80, 14);
        container.appendChild(button);
        buttons.push(button);
      }
      document.body.appendChild(container);
      mockRect(document.body, 0, 0, 1280, 800);
      mockRect(container, 0, 0, 1280, 800);

      const styleCounts = new Map<Element, number>();
      const realGetComputedStyle = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation(
        (el: Element, pseudo?: string | null) => {
          if (!pseudo) {
            styleCounts.set(el, (styleCounts.get(el) ?? 0) + 1);
          }
          return realGetComputedStyle(el, pseudo);
        },
      );

      const first = win.__generateAccessibilityTree('interactive');
      expect(first.pageContent).toContain('"Action 0"');
      expect(first.pageContent).toContain('(x=50,y=17)');

      for (const button of buttons) {
        expect(styleCounts.get(button)).toBe(1);
        expect((button.getBoundingClientRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
          1,
        );
      }

      mockRect(buttons[0], 300, 400, 100, 40);
      buttons[1].style.display = 'none';

      const second = win.__generateAccessibilityTree('interactive');
      expect(second.pageContent).toContain('"Action 0"');
      expect(second.pageContent).toContain('(x=350,y=420)');
      expect(second.pageContent).not.toContain('"Action 1"');
    });
  });

  describe('querySelectorAllDeep multi-segment ancestor pruning & shadow deduplication', () => {
    it('prunes nested ancestor contexts to avoid O(N^2) subtree rescans on deeply nested containers', () => {
      let parent: HTMLElement = document.body;
      for (let depth = 0; depth < 25; depth++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'nested-box';
        parent.appendChild(wrapper);
        parent = wrapper;
      }
      const leaf = document.createElement('span');
      leaf.className = 'target-leaf';
      leaf.textContent = 'found';
      parent.appendChild(leaf);

      const qsaSpy = vi.spyOn(Element.prototype, 'querySelectorAll');
      const matches = querySelectorAllDeep('div.nested-box span.target-leaf', document);

      expect(matches).toEqual([leaf]);
      expect(qsaSpy.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('pierces open shadow roots and slots without double-scanning the same shadow root', () => {
      const host = document.createElement('div');
      host.className = 'card-host';
      const shadow = host.attachShadow({ mode: 'open' });
      const shadowBtn = document.createElement('button');
      shadowBtn.className = 'shadow-action';
      shadowBtn.textContent = 'Run';
      const slot = document.createElement('slot');
      shadow.append(shadowBtn, slot);

      const slottedBtn = document.createElement('button');
      slottedBtn.className = 'shadow-action';
      slottedBtn.textContent = 'Slotted';
      host.appendChild(slottedBtn);
      document.body.appendChild(host);

      const shadowQsaSpy = vi.spyOn(shadow, 'querySelectorAll');
      const matches = querySelectorAllDeep('div.card-host button.shadow-action', document);

      expect(matches).toHaveLength(2);
      expect(matches).toContain(shadowBtn);
      expect(matches).toContain(slottedBtn);
      const secondSegmentCalls = shadowQsaSpy.mock.calls.filter(
        ([sel]) => sel === 'button.shadow-action',
      );
      expect(secondSegmentCalls).toHaveLength(1);
      expect(shadowQsaSpy.mock.calls).toHaveLength(4);
    });
  });

  describe('DomQueryCache visibility memoization, DOM pruner, index lookup & standalone highlight removal', () => {
    it('memoizes shared ancestor styles while preserving CSS visibility:visible override semantics', () => {
      let container: HTMLElement = document.body;
      const ancestors: HTMLElement[] = [];
      for (let depth = 0; depth < 6; depth++) {
        const layer = document.createElement('div');
        container.appendChild(layer);
        ancestors.push(layer);
        container = layer;
      }

      const hiddenParent = document.createElement('div');
      hiddenParent.style.visibility = 'hidden';
      container.appendChild(hiddenParent);

      const visibleOverride = document.createElement('button');
      visibleOverride.style.visibility = 'visible';
      visibleOverride.textContent = 'Override';
      mockRect(visibleOverride, 10, 10, 80, 24);

      const inheritedHidden = document.createElement('button');
      inheritedHidden.style.visibility = 'hidden';
      inheritedHidden.textContent = 'Hidden';
      mockRect(inheritedHidden, 10, 40, 80, 24);

      hiddenParent.append(visibleOverride, inheritedHidden);

      const siblingLeaves: HTMLButtonElement[] = [];
      for (let idx = 0; idx < 15; idx++) {
        const btn = document.createElement('button');
        btn.textContent = `Leaf ${idx}`;
        mockRect(btn, 10, 80 + idx * 30, 80, 24);
        container.appendChild(btn);
        siblingLeaves.push(btn);
      }

      const styleCounts = new Map<Element, number>();
      const realGetComputedStyle = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation(
        (el: Element, pseudo?: string | null) => {
          if (!pseudo) {
            styleCounts.set(el, (styleCounts.get(el) ?? 0) + 1);
          }
          return realGetComputedStyle(el, pseudo);
        },
      );

      const cache = createDomQueryCache();
      expect(isElementHiddenInComposedTree(hiddenParent, window, { cache })).toBe(true);
      expect(isElementHiddenInComposedTree(visibleOverride, window, { cache })).toBe(false);
      expect(isElementHiddenInComposedTree(inheritedHidden, window, { cache })).toBe(true);
      expect(isLocatorCandidateVisible(visibleOverride, cache)).toBe(true);
      expect(isLocatorCandidateVisible(inheritedHidden, cache)).toBe(false);

      for (const leaf of siblingLeaves) {
        expect(isElementHiddenInComposedTree(leaf, window, { cache })).toBe(false);
        expect(isLocatorCandidateVisible(leaf, cache)).toBe(true);
      }

      for (const ancestor of ancestors) {
        expect(styleCounts.get(ancestor)).toBe(1);
      }
    });

    it('inPageDOMPruner reflects DOM mutations across separate invocations without cross-call stale cache', () => {
      const btn = document.createElement('button');
      btn.id = 'phase3-btn';
      btn.textContent = 'Before';
      document.body.appendChild(btn);
      mockRect(document.body, 0, 0, 1280, 800);
      mockRect(btn, 20, 20, 100, 32);

      const first = inPageDOMPruner({
        flattenCards: false,
        virtualize: false,
        isolateModal: false,
      });
      expect(first.treeString).toContain('Before');

      btn.textContent = 'After';
      btn.style.display = 'none';
      const second = inPageDOMPruner({
        flattenCards: false,
        virtualize: false,
        isolateModal: false,
      });
      expect(second.treeString).not.toContain('Before');
      expect(second.treeString).not.toContain('After');
    });

    it('findExistingElementIndex resolves indexed elements in O(1) and inPageRemoveHighlights remains self-contained', () => {
      const btn = document.createElement('button');
      btn.textContent = 'Indexed';
      document.body.appendChild(btn);

      const assigned = indexElement(btn);
      expect(findExistingElementIndex(btn)).toBe(assigned);

      const overlay = document.createElement('div');
      overlay.id = '__mcp_som_overlay_container__';
      document.body.appendChild(overlay);

      const standaloneFn = new Function(`return (${inPageRemoveHighlights.toString()})();`);
      expect(standaloneFn()).toBe(true);
      expect(document.getElementById('__mcp_som_overlay_container__')).toBeNull();
    });
  });
});
