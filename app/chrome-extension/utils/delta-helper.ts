import { executeInPage } from '../entrypoints/background/tools/browser/in-page-engine';
import { snapshotCacheManager, type DomDiffResult } from './snapshot-cache-manager';
import type { PrunedDOMTreeResult } from 'chrome-mcp-shared';

async function fetchCurrentDomElements(
  tabId: number,
): Promise<{ url: string; elements: any[] } | null> {
  let results: any[] | null = null;
  try {
    results = await executeInPage<PrunedDOMTreeResult>(
      { tabId, allFrames: true },
      'inPageDOMPruner',
      [
        {
          viewportThreshold: 500,
          highlight: false,
        },
      ],
    );
  } catch {
    try {
      results = await executeInPage<PrunedDOMTreeResult>({ tabId }, 'inPageDOMPruner', [
        {
          viewportThreshold: 500,
          highlight: false,
        },
      ]);
    } catch {
      return null;
    }
  }

  if (!results || results.length === 0) return null;

  const mainFrame = results.find((r) => r.frameId === 0) || results[0];
  const mainResult = mainFrame?.result;
  if (!mainResult) return null;

  const allElements: any[] = [...(mainResult.indexedElements || [])];
  let currentIndex = allElements.length + 1;

  for (const r of results) {
    if (r === mainFrame || !r.result) continue;
    const subData = r.result;
    if (subData.indexedElements && subData.indexedElements.length > 0) {
      for (const el of subData.indexedElements) {
        allElements.push({
          ...el,
          index: currentIndex++,
        });
      }
    }
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return {
    url: tab?.url || '',
    elements: allElements,
  };
}

/**
 * Ensure baseline snapshot is established BEFORE an interaction occurs.
 * If includeDelta is requested and no valid baseline snapshot exists in cache,
 * this captures the pre-interaction state so subsequent diff will accurately
 * detect elements added/modified/removed by the immediate action (e.g. dropdowns/popups/modals).
 */
export async function ensureSnapshotBaseline(tabId: number, includeDelta?: boolean): Promise<void> {
  if (!includeDelta) return;
  if (snapshotCacheManager.isSnapshotValid(tabId)) return;

  try {
    const data = await fetchCurrentDomElements(tabId);
    if (!data) return;

    snapshotCacheManager.setSnapshot(tabId, {
      url: data.url,
      elementCount: data.elements.length,
      elements: data.elements,
    });
  } catch {
    // Non-fatal: if pre-interaction capture fails, captureDeltaIfRequested will fall back gracefully
  }
}

export async function captureDeltaIfRequested(
  tabId: number,
  includeDelta?: boolean,
  delayMs = 150,
): Promise<DomDiffResult | undefined> {
  if (!includeDelta) return undefined;
  try {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const data = await fetchCurrentDomElements(tabId);
    if (!data) return undefined;

    const allElements = data.elements;
    const diff = snapshotCacheManager.diffWithPrevious(tabId, allElements);
    snapshotCacheManager.setSnapshot(tabId, {
      url: data.url,
      elementCount: allElements.length,
      elements: allElements,
    });

    if (!diff.isDelta) {
      // First interaction with includeDelta without a prior baseline (e.g. if pre-capture was bypassed)
      // Prevent context explosion by returning empty lists for the baseline
      return {
        isDelta: false,
        unchanged: false,
        revision: diff.revision,
        added: [],
        modified: [],
        removed: [],
        totalCurrent: diff.totalCurrent,
        message:
          'Baseline snapshot established. Subsequent interactions will report incremental DOM deltas.',
      };
    }

    return diff;
  } catch (err) {
    return {
      isDelta: true,
      unchanged: false,
      revision: -1,
      added: [],
      modified: [],
      removed: [],
      totalCurrent: 0,
      error: err instanceof Error ? err.message : String(err),
    } as any;
  }
}

export interface ChainedSnapshotSummary {
  urlChanged: boolean;
  currentUrl: string;
  activeElement?: {
    tagName?: string;
    id?: string;
    role?: string;
    type?: string;
    isInput?: boolean;
    value?: string;
    text?: string;
  };
  hasActiveModal: boolean;
  deltaSummary: { added: number; modified: number; removed: number };
  keyChanges: Array<{
    type: 'added' | 'modified' | 'removed';
    index?: number;
    tagName: string;
    text?: string;
  }>;
}

/**
 * Captures a lightweight chained snapshot summary right after an interaction,
 * allowing agents to observe immediate UI feedback (active element, modals, URL, DOM changes)
 * without issuing a separate full chrome_read_dom call.
 */
export async function captureChainedSnapshotSummary(
  tabId: number,
  previousUrl: string,
  options?: { maxItems?: number; delayMs?: number },
): Promise<ChainedSnapshotSummary> {
  const maxItems = options?.maxItems ?? 10;
  const delayMs = options?.delayMs ?? 100;

  let activeElInfo: any = {};
  try {
    const activeRes = await executeInPage({ tabId }, 'inPageGetActiveElementSummary', []);
    if (activeRes?.[0]?.result) {
      activeElInfo = activeRes[0].result;
    }
  } catch {}

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const currentUrl = tab?.url || previousUrl;
  const urlChanged = Boolean(previousUrl && currentUrl && previousUrl !== currentUrl);

  const diff = await captureDeltaIfRequested(tabId, true, delayMs);

  const added = diff?.added || [];
  const modified = diff?.modified || [];
  const removed = diff?.removed || [];

  const keyChanges: Array<{
    type: 'added' | 'modified' | 'removed';
    index?: number;
    tagName: string;
    text?: string;
  }> = [];

  for (const item of added) {
    if (keyChanges.length >= maxItems) break;
    keyChanges.push({
      type: 'added',
      index: item.index,
      tagName: item.tagName,
      text: item.text ? item.text.slice(0, 40) : undefined,
    });
  }

  for (const item of modified) {
    if (keyChanges.length >= maxItems) break;
    keyChanges.push({
      type: 'modified',
      index: item.index,
      tagName: item.tagName,
      text: item.text ? item.text.slice(0, 40) : undefined,
    });
  }

  for (const item of removed) {
    if (keyChanges.length >= maxItems) break;
    const remIndex = typeof item === 'number' ? item : (item as any)?.index;
    keyChanges.push({
      type: 'removed',
      index: remIndex,
      tagName:
        typeof item === 'object' && (item as any)?.tagName ? (item as any).tagName : 'removed',
      text:
        typeof item === 'object' && (item as any)?.text
          ? (item as any).text.slice(0, 40)
          : undefined,
    });
  }

  return {
    urlChanged,
    currentUrl,
    activeElement: activeElInfo.tagName
      ? {
          tagName: activeElInfo.tagName,
          id: activeElInfo.id,
          role: activeElInfo.role,
          type: activeElInfo.type,
          isInput: activeElInfo.isInput,
          value: activeElInfo.value,
          text: activeElInfo.text,
        }
      : undefined,
    hasActiveModal: Boolean(activeElInfo.hasActiveModal),
    deltaSummary: {
      added: added.length,
      modified: modified.length,
      removed: removed.length,
    },
    keyChanges,
  };
}
