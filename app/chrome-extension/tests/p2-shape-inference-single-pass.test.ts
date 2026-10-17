import { describe, it, expect, beforeEach } from 'vitest';
import {
  inPageDOMPruner,
  getIsolatedIndexMap,
  getIndexFingerprintMap,
} from '../entrypoints/background/tools/browser/dom-indexer';

/**
 * P2-3: shape inference must not re-walk a subtree for every nested candidate.
 *
 * `inPageDOMPruner` used to run `cand.node.querySelectorAll(...)` per candidate, so a candidate
 * nested inside another candidate re-visited nodes the ancestor had already scanned. The indexed
 * result must be identical while each node is inspected once per snapshot.
 */
describe('P2-3: shape inference scans each node once per snapshot', () => {
  let originalRect: typeof Element.prototype.getBoundingClientRect;
  let originalQuerySelectorAll: typeof Element.prototype.querySelectorAll;
  let querySelectorAllCalls = 0;

  beforeEach(() => {
    getIsolatedIndexMap().clear();
    getIndexFingerprintMap().clear();
    document.body.innerHTML = '';

    originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 110,
        bottom: 60,
        width: 100,
        height: 50,
        toJSON: () => ({}),
      } as DOMRect;
    };

    querySelectorAllCalls = 0;
    originalQuerySelectorAll = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (this: Element, selectors: string) {
      querySelectorAllCalls++;
      return originalQuerySelectorAll.call(this, selectors);
    };
  });

  const restore = () => {
    Element.prototype.getBoundingClientRect = originalRect;
    Element.prototype.querySelectorAll = originalQuerySelectorAll;
  };

  it('still finds the deep shape for nested candidates and keeps every index', () => {
    try {
      // Deeply nested candidates: the outer button contains an inner button, which contains the
      // rotated square carrying the actual diamond shape.
      document.body.innerHTML = `
        <button id="outer">
          Outer
          <button id="inner">
            Inner
            <span style="transform: rotate(45deg)">*</span>
          </button>
        </button>
      `;

      const res = inPageDOMPruner({ flattenCards: false });

      // Original indexing result survives: both nested candidates stay in the tree.
      expect(res.treeString).toContain('#outer');
      expect(res.treeString).toContain('#inner');

      // The shape is still decoded, for the inner candidate at minimum.
      expect(res.treeString).toContain('shape="diamond"');
    } finally {
      restore();
    }
  });

  it('preserves shape precedence: own style beats descendants, and rule order is unchanged', () => {
    try {
      document.body.innerHTML = `
        <button id="own-wins" style="border-radius: 50%">
          <span style="transform: rotate(45deg)">x</span>
        </button>
        <button id="clip-hex" style="clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)">h</button>
        <button id="clip-tri" style="clip-path: polygon(50% 0, 100% 100%, 0 100%)">t</button>
        <button id="svg-poly"><svg><polygon points="0,0 10,0 5,10"></polygon></svg></button>
        <button id="svg-circle"><svg><circle r="5"></circle></svg></button>
      `;

      const res = inPageDOMPruner({ flattenCards: false });

      // Own rotate/border-radius/clip-path rules keep their original order and meaning.
      expect(res.treeString).toContain('shape="circle"');
      expect(res.treeString).toContain('shape="hex"');
      expect(res.treeString).toContain('shape="triangle"');
      expect(res.treeString).toContain('shape="polygon"');
      // An own style rule wins over a shaped descendant, as before.
      expect(res.treeString).toMatch(/#own-wins shape="circle"/);
    } finally {
      restore();
    }
  });

  it('does not scan a subtree per candidate', () => {
    try {
      // 40 sibling candidates, each wrapping a shaped descendant. The old implementation ran one
      // `querySelectorAll` per candidate purely for shape detection.
      const items = Array.from(
        { length: 40 },
        (_, i) => `<button id="b${i}"><span style="border-radius: 50%">${i}</span></button>`,
      ).join('');
      document.body.innerHTML = `<div>${items}</div>`;

      const res = inPageDOMPruner({ flattenCards: false });

      expect(res.treeString).toContain('shape="circle"');
      // A generous ceiling: still far below the per-candidate scan the fix removes.
      expect(querySelectorAllCalls).toBeLessThan(40);
    } finally {
      restore();
    }
  });
});
