import { describe, expect, it, vi } from 'vitest';
import type { IndexedElement, PrunedDOMTreeResult } from 'chrome-mcp-shared';
import {
  mergeStandardFrames,
  rebuildTreeAfterAxFusion,
  roundRobinUniqueByFrame,
} from '../entrypoints/background/tools/browser/dom-indexer/frame-merge';

function element(index: number, tagName = 'button'): IndexedElement {
  return {
    index,
    tagName,
    isInteractive: true,
    attributes: {},
    rect: { x: 0, y: 0, width: 10, height: 10 },
  } as IndexedElement;
}

function result(elements: IndexedElement[] = []): PrunedDOMTreeResult {
  return {
    treeString: elements.map((item) => `[${item.index}]`).join('\n'),
    elementCount: elements.length,
    interactiveCount: elements.length,
    compressionRatio: 0,
    indexMap: Object.fromEntries(
      elements.map((item) => [item.index, { selector: `#${item.tagName}`, tagName: item.tagName }]),
    ),
    indexedElements: elements,
  };
}

describe('frame-merge', () => {
  it('preserves frame ownership, counts, asset routes and rendering', () => {
    const main = element(1, 'main-button');
    const child = element(2, 'child-button');
    const render = vi.fn(
      (item: IndexedElement, frameId?: number) => `${frameId ?? 0}:${item.index}`,
    );
    const mainFrame = {
      frameId: 0,
      result: {
        ...result([main]),
        assets: [{ index: 1, kind: 'img', rect: { x: 1, y: 2, width: 20, height: 20 } }],
      },
    };
    const merged = mergeStandardFrames(
      [
        mainFrame,
        {
          frameId: 9,
          result: {
            ...result([child]),
            virtualizedCount: 3,
            virtualizedSummary: [{ selector: '.item', count: 3 }],
            assets: [
              {
                index: 1,
                kind: 'img',
                rect: { x: 3, y: 4, width: 30, height: 30 },
                src: 'https://example.com/image.png',
              },
            ],
          },
        },
      ],
      mainFrame,
      'compact',
      render,
    );

    expect(merged.mergedData.elementCount).toBe(2);
    expect(merged.mergedData.indexMap[2].frameId).toBe('9');
    expect(merged.mergedData.virtualizedCount).toBe(3);
    expect(merged.mergedData.virtualizedSummary).toEqual([
      { selector: 'iframe[9] .item', count: 3 },
    ]);
    expect(merged.mergedData.assets?.[1]).toMatchObject({
      index: 2,
      src: 'https://example.com/image.png#@frame=9',
    });
    expect(merged.assetRoutes.get(2)).toEqual({ frameId: 9, localIndex: 0 });
    expect(merged.subframeLines).toEqual(['\n<!-- Frame 9 -->', '9:2']);
    expect(render).toHaveBeenCalledWith(child, 9);
    expect(merged.standardFrameBuckets.map((bucket) => bucket.items[0]?.index)).toEqual([1, 2]);
  });

  it('renders HTML frame lines without invoking compact renderer', () => {
    const render = vi.fn(() => 'unused');
    const child = element(7, 'a');
    child.attributes = { href: '/docs' };
    child.text = 'Docs';
    const merged = mergeStandardFrames(
      [
        { frameId: 0, result: result() },
        { frameId: 3, result: result([child]) },
      ],
      { frameId: 0, result: result() },
      'html',
      render,
    );

    expect(merged.subframeLines).toContain('[7] <a href="/docs" frame="3"> "Docs"</a>');
    expect(render).not.toHaveBeenCalled();
  });

  it('rebuilds main and child trees after AX fusion', () => {
    const main = element(1);
    const child = element(2);
    const mergedData = {
      ...result([main, child]),
      indexMap: {
        1: { frameId: '0' },
        2: { frameId: '5' },
      },
    };
    const mainFrame = { frameId: 0, result: result([main]) };
    const lines = rebuildTreeAfterAxFusion(
      mergedData,
      [mainFrame, { frameId: 5, result: result([child]) }],
      mainFrame,
      (item, frameId) => `${frameId ?? 0}:${item.index}`,
    );

    expect(mergedData.treeString).toBe('0:1');
    expect(lines).toEqual(['\n<!-- Frame 5 -->', '5:2']);
  });

  it('round-robins frames, deduplicates shared indexes and applies priority', () => {
    const selected = roundRobinUniqueByFrame(
      [
        { frameId: 0, items: [1, 2] },
        { frameId: 1, items: [1, 3] },
      ],
      (value) => value,
      (value) => value,
      2,
    );

    expect(selected).toEqual([3, 2]);
  });
});
