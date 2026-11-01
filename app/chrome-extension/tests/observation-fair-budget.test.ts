import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';

const FRAME_IDS = [0, 1, 2, 3, 4];

function installFrameInventory(frameIds: number[]) {
  chrome.webNavigation = {
    ...chrome.webNavigation,
    getAllFrames: vi.fn(async () =>
      frameIds.map((frameId) => ({ frameId, documentId: `doc-${frameId}` })),
    ),
  } as any;
}

function mockFrameObservation(frameIds: number[], results: any[]) {
  installFrameInventory(frameIds);
  vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue(results as any);
  vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
    id: 1,
    url: 'https://fair-budget.test',
    title: 'Fair budget',
  });
}

function indexedFrame(frameId: number, startIndex: number, count: number, prefix: string) {
  const elements = Array.from({ length: count }, (_, offset) => ({
    index: startIndex + offset,
    tagName: 'button',
    text: `${prefix} ${offset + 1}`,
    isInteractive: true,
  }));
  const lines = elements.map((element) => `[${element.index}] button "${element.text}"`);

  return {
    documentId: `doc-${frameId}`,
    frameId,
    result: {
      treeString: (frameId === 0 ? '' : `<!-- Frame ${frameId} -->\n`) + lines.join('\n'),
      elementCount: count,
      interactiveCount: count,
      compressionRatio: 1,
      indexMap: Object.fromEntries(
        elements.map((element) => [element.index, { selector: 'button', tagName: 'button' }]),
      ),
      indexedElements: elements,
    },
  };
}

function treeElementIndices(payload: any): number[] {
  return (payload.treeString.match(/^\[(\d+)\]/gm) || []).map((line) => Number(line.slice(1, -1)));
}

describe('M3 observation fair budgets', () => {
  beforeEach(() => {
    snapshotCacheManager.clear();
    installFrameInventory(FRAME_IDS);
  });

  it('rotates fast budgets over unique elements despite multiple actions per input', async () => {
    const actionsByFrame = FRAME_IDS.map((frameId) => {
      const baseIndex = frameId * 16777216 + 1;
      if (frameId === 0) {
        return Array.from({ length: 100 }, (_, offset) => {
          const id = `e${baseIndex + offset}`;
          const node = offset + 1;
          return [
            {
              id,
              node,
              kind: 'fill',
              role: 'textbox',
              label: `F0 Field ${offset + 1}`,
              value: `value-${offset + 1}`,
            },
            {
              id,
              node,
              kind: 'click',
              role: 'textbox',
              label: `F0 Field ${offset + 1}`,
            },
          ];
        }).flat();
      }

      return Array.from({ length: 100 }, (_, offset) => ({
        id: `e${baseIndex + offset}`,
        node: offset + 1,
        kind: 'click',
        role: 'button',
        label: `F${frameId} Button ${offset + 1}`,
      }));
    });

    mockFrameObservation(
      FRAME_IDS,
      FRAME_IDS.map((frameId) => ({
        documentId: `doc-${frameId}`,
        frameId,
        result: {
          url: `https://fair-budget.test/frame-${frameId}`,
          title: `Frame ${frameId}`,
          w: 1000,
          h: 800,
          text: '',
          scroll: { y: 0, height: 800 },
          actions: actionsByFrame[frameId],
          omitted_actions: 0,
        },
      })),
    );

    const response = await readDOMTool.execute({
      fast: true,
      includeDetails: true,
      tabId: 1,
    } as any);
    const payload = JSON.parse(response.content[0].text as string);
    const counts = FRAME_IDS.map(
      (frameId) =>
        payload.treeString
          .split('\n')
          .filter((line: string) => /^\[\d+\]/.test(line) && line.includes(`"F${frameId} `)).length,
    );

    expect(payload.elementCount).toBe(250);
    expect(counts).toEqual([50, 50, 50, 50, 50]);
    expect(
      payload.actions.filter((action: any) => action.label?.startsWith('F0 Field')).length,
    ).toBe(100);
    expect(payload.omitted_actions).toBe(300);
  });

  it('keeps a 300/100 standard observation visible under the default 250 limit', async () => {
    mockFrameObservation(
      [0, 1],
      [indexedFrame(0, 1, 300, 'Main'), indexedFrame(1, 301, 100, 'Child')],
    );
    const setSnapshotSpy = vi.spyOn(snapshotCacheManager, 'setSnapshot');

    const response = await readDOMTool.execute({ includeDetails: true } as any);
    const payload = JSON.parse(response.content[0].text as string);
    const mainCount = payload.indexedElements.filter((element: any) => element.index <= 300).length;
    const childCount = payload.indexedElements.filter((element: any) => element.index > 300).length;

    expect(payload.totalElements).toBe(400);
    expect(payload.indexedElements).toHaveLength(250);
    expect({ mainCount, childCount }).toEqual({ mainCount: 150, childCount: 100 });
    expect(payload.indexedElements.slice(0, 4).map((element: any) => element.index)).toEqual([
      1, 301, 2, 302,
    ]);
    expect(payload.hasMore).toBe(true);
    expect(payload.nextCursor).toBe(250);
    const standardSnapshot = setSnapshotSpy.mock.calls.find(
      ([, snapshot]) => snapshot.representation === 'standard',
    )?.[1];
    expect(standardSnapshot?.elements).toHaveLength(400);
  });

  it('preserves a custom standard limit while applying fair frame ordering', async () => {
    mockFrameObservation(
      [0, 1],
      [indexedFrame(0, 1, 300, 'Main'), indexedFrame(1, 301, 100, 'Child')],
    );

    const response = await readDOMTool.execute({ includeDetails: true, limit: 3 } as any);
    const payload = JSON.parse(response.content[0].text as string);

    expect(payload.limit).toBe(3);
    expect(payload.indexedElements.map((element: any) => element.index)).toEqual([1, 301, 2]);
    expect(payload.totalElements).toBe(400);
    expect(payload.nextCursor).toBe(3);
  });

  it('paginates five standard frames without duplicate or missing elements', async () => {
    const results = FRAME_IDS.map((frameId) =>
      indexedFrame(frameId, frameId * 100 + 1, 100, `F${frameId}`),
    );
    mockFrameObservation(FRAME_IDS, results);

    const page1 = JSON.parse(
      (await readDOMTool.execute({ includeDetails: true, cursor: 0 } as any)).content[0]
        .text as string,
    );
    const page2 = JSON.parse(
      (await readDOMTool.execute({ includeDetails: true, cursor: 250 } as any)).content[0]
        .text as string,
    );
    const indices = [
      ...page1.indexedElements.map((element: any) => element.index),
      ...page2.indexedElements.map((element: any) => element.index),
    ];
    const expectedOrder = Array.from({ length: 100 }, (_, offset) =>
      FRAME_IDS.map((frameId) => frameId * 100 + offset + 1),
    ).flat();

    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(250);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeUndefined();
    expect(indices).toEqual(expectedOrder);
    expect(new Set(indices).size).toBe(500);
    expect(treeElementIndices(page1)).toEqual(
      page1.indexedElements.map((element: any) => element.index),
    );
    expect(treeElementIndices(page2)).toEqual(
      page2.indexedElements.map((element: any) => element.index),
    );
  });
});
