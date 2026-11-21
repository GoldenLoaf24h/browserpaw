import type { IndexedElement, PrunedDOMTreeResult } from 'chrome-mcp-shared';

export interface FrameObservation<R = PrunedDOMTreeResult> {
  frameId: number;
  documentId?: string;
  result?: R;
  error?: string;
}

export interface FrameBuckets<T> {
  frameId: number;
  items: T[];
}

export function roundRobinUniqueByFrame<T>(
  buckets: FrameBuckets<T>[],
  keyOf: (item: T) => string | number,
  priorityOf: (item: T) => number,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const seen = new Set<string | number>();
  const ordered: T[] = [];
  let offset = 0;

  while (true) {
    let progressed = false;
    for (const bucket of buckets) {
      const item = bucket.items[offset];
      if (item === undefined) continue;
      progressed = true;
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(item);
    }
    if (!progressed) break;
    offset++;
  }

  return ordered.sort((a, b) => priorityOf(b) - priorityOf(a)).slice(0, limit);
}

export function mergeStandardFrames(
  results: FrameObservation[],
  mainFrame: FrameObservation,
  format: 'compact' | 'html' | 'fast' | undefined,
  renderElement: (element: IndexedElement, frameId?: number) => string,
): {
  mergedData: PrunedDOMTreeResult;
  subframeLines: string[];
  assetRoutes: Map<number, { frameId: number; localIndex: number }>;
  standardFrameBuckets: FrameBuckets<IndexedElement>[];
} {
  const mainData = mainFrame.result!;
  const mergedData: PrunedDOMTreeResult = {
    treeString: mainData.treeString,
    elementCount: mainData.elementCount,
    interactiveCount: mainData.interactiveCount,
    compressionRatio: mainData.compressionRatio,
    indexMap: { ...mainData.indexMap },
    indexedElements: [...(mainData.indexedElements || [])],
    assets: [...(mainData.assets || [])],
    pages_up: mainData.pages_up,
    pages_down: mainData.pages_down,
    scrollInfo: mainData.scrollInfo,
    activeModal: mainData.activeModal,
    focusTrapped: mainData.focusTrapped,
    isConfirmationTrap: mainData.isConfirmationTrap,
    modalIsolated: mainData.modalIsolated,
    virtualizedCount: mainData.virtualizedCount,
    virtualizedSummary: mainData.virtualizedSummary,
    flattenedCardCount: mainData.flattenedCardCount,
    selectorMatched: results.some((result) => result.result?.selectorMatched === true),
  };

  let currentAssetIndex = (mergedData.assets?.length || 0) + 1;
  const subframeLines: string[] = [];
  const assetRoutes = new Map<number, { frameId: number; localIndex: number }>();

  for (const asset of mainData.assets || []) {
    if (typeof asset.index === 'number') {
      assetRoutes.set(asset.index, {
        frameId: mainFrame.frameId,
        localIndex: (asset.index || 1) - 1,
      });
    }
  }

  for (const frame of results) {
    if (frame === mainFrame || !frame.result || (frame.result as any).isErrorPage) continue;
    const subData = frame.result;
    mergedData.elementCount += subData.elementCount;

    if (typeof subData.virtualizedCount === 'number' && subData.virtualizedCount > 0) {
      mergedData.virtualizedCount = (mergedData.virtualizedCount || 0) + subData.virtualizedCount;
    }
    if (Array.isArray(subData.virtualizedSummary) && subData.virtualizedSummary.length > 0) {
      if (!mergedData.virtualizedSummary) mergedData.virtualizedSummary = [];
      for (const summary of subData.virtualizedSummary) {
        mergedData.virtualizedSummary.push({
          selector: `iframe[${frame.frameId}] ${summary.selector}`,
          count: summary.count,
        });
      }
    }

    if (subData.indexedElements && subData.indexedElements.length > 0) {
      subframeLines.push(`\n<!-- Frame ${frame.frameId} -->`);
      for (const element of subData.indexedElements) {
        mergedData.indexedElements!.push(element);
        mergedData.indexMap[element.index] = {
          selector: subData.indexMap?.[element.index]?.selector,
          frameId: String(frame.frameId),
          tagName: element.tagName,
        };

        if (format === 'html') {
          const attributes = Object.entries(element.attributes || {})
            .map(([key, value]) => `${key}="${value}"`)
            .join(' ');
          const text = element.text ? ` "${element.text}"` : '';
          const shadow = element.inShadowDom ? ' [shadow]' : '';
          subframeLines.push(
            `[${element.index}]${shadow} <${element.tagName}${attributes ? ' ' + attributes : ''} frame="${frame.frameId}">${text}</${element.tagName}>`,
          );
        } else {
          subframeLines.push(renderElement(element, frame.frameId));
        }
      }
    }

    if (subData.assets && subData.assets.length > 0) {
      if (!mergedData.assets) mergedData.assets = [];
      for (let localIndex = 0; localIndex < subData.assets.length; localIndex++) {
        const asset = subData.assets[localIndex];
        const globalIndex = currentAssetIndex++;
        mergedData.assets.push({
          ...asset,
          index: globalIndex,
          src: asset.src ? `${asset.src}#@frame=${frame.frameId}` : undefined,
        });
        assetRoutes.set(globalIndex, {
          frameId: frame.frameId,
          localIndex: (typeof asset.index === 'number' ? asset.index : localIndex + 1) - 1,
        });
      }
    }
  }

  const orderedFrames = [mainFrame, ...results.filter((result) => result !== mainFrame)];
  const standardFrameBuckets = orderedFrames
    .filter((result) => result.result && !(result.result as any).isErrorPage)
    .map((result) => ({ frameId: result.frameId, items: [] as IndexedElement[] }));
  const bucketByFrameId = new Map(
    standardFrameBuckets.map((bucket) => [String(bucket.frameId), bucket]),
  );
  const mainFrameId = String(mainFrame.frameId);
  for (const element of mergedData.indexedElements || []) {
    const mappedFrameId = mergedData.indexMap[element.index]?.frameId;
    const bucket =
      bucketByFrameId.get(mappedFrameId === undefined ? mainFrameId : String(mappedFrameId)) ||
      bucketByFrameId.get(mainFrameId);
    bucket?.items.push(element);
  }

  return { mergedData, subframeLines, assetRoutes, standardFrameBuckets };
}

export function rebuildTreeAfterAxFusion(
  mergedData: PrunedDOMTreeResult,
  results: FrameObservation[],
  mainFrame: FrameObservation,
  renderElement: (element: IndexedElement, frameId?: number) => string,
): string[] {
  const mainElements = (mergedData.indexedElements || []).filter((element) => {
    const frameId = mergedData.indexMap[element.index]?.frameId;
    return !frameId || frameId === '0';
  });
  mergedData.treeString = mainElements.map((element) => renderElement(element)).join('\n');

  const lines: string[] = [];
  for (const frame of results) {
    if (frame === mainFrame || !frame.result) continue;
    lines.push('\n<!-- Frame ' + frame.frameId + ' -->');
    const frameElements = (mergedData.indexedElements || []).filter(
      (element) => String(mergedData.indexMap[element.index]?.frameId) === String(frame.frameId),
    );
    for (const element of frameElements) lines.push(renderElement(element, frame.frameId));
  }
  return lines;
}
