import { executeInPage } from '../entrypoints/background/tools/browser/in-page-engine';
import {
  snapshotCacheManager,
  snapshotObservationKey,
  type DomDiffResult,
} from './snapshot-cache-manager';
import type { PrunedDOMTreeResult, ScrollInfo } from 'chrome-mcp-shared';
import { describeFrameCoverage } from './frame-coverage';
import type { ToolResult } from '@/common/tool-handler';

/** Guarded goal steps need the complete next observation, not a second summary scan. */
export async function captureGoalObservation(
  tabId: number,
  sessionId?: string,
): Promise<{ tabId: number; result: ToolResult }> {
  const { readDOMTool } = await import('../entrypoints/background/tools/browser/read-dom');
  return {
    tabId,
    result: await readDOMTool.execute({
      tabId,
      sessionId,
      format: 'fast',
      fast: true,
      includeDetails: true,
      activeViewportOnly: true,
      limit: 100,
    }),
  };
}

async function fetchCurrentDomElements(tabId: number): Promise<{
  url: string;
  elements: any[];
  coverage: NonNullable<DomDiffResult['coverage']>;
} | null> {
  const results = await executeInPage<PrunedDOMTreeResult>(
    { tabId, allFrames: true },
    'inPageDOMPruner',
    [
      {
        viewportThreshold: 1000,
        highlight: false,
      },
    ],
  );

  if (!results || results.length === 0) return null;

  const allElements: any[] = [];
  for (const frame of results) {
    for (const element of frame.result?.indexedElements || []) {
      allElements.push(element);
    }
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const successfulFrames = results.filter(
    (frame) => frame.result && !(frame.result as any).isErrorPage,
  ).length;
  if (successfulFrames === 0) {
    throw new Error('All-frame DOM capture failed in every reported frame');
  }
  return {
    url: tab?.url || '',
    elements: allElements,
    coverage: await describeFrameCoverage(tabId, results),
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
  if (
    snapshotCacheManager.isSnapshotValid(tabId, {
      representation: 'standard',
      observationKey: snapshotObservationKey(),
    })
  )
    return;

  try {
    const data = await fetchCurrentDomElements(tabId);
    if (!data || data.coverage.status !== 'complete') return;

    snapshotCacheManager.setSnapshot(tabId, {
      url: data.url,
      elementCount: data.elements.length,
      elements: data.elements,
      coverage: data.coverage,
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
    if (!data) {
      return {
        isDelta: false,
        unchanged: false,
        revision: -1,
        added: [],
        modified: [],
        removed: [],
        totalCurrent: 0,
        error: 'All-frame DOM capture returned no frames',
        coverage: {
          status: 'failed',
          attemptedFrames: 'all',
        },
      };
    }

    const allElements = data.elements;
    if (data.coverage.status !== 'complete')
      return {
        isDelta: false,
        unchanged: false,
        revision: -1,
        added: [],
        modified: [],
        removed: [],
        totalCurrent: allElements.length,
        coverage: data.coverage,
        error: 'Incomplete frame observation; previous baseline retained, no removals inferred',
      };
    const diff = snapshotCacheManager.diffWithPrevious(tabId, allElements);
    snapshotCacheManager.setSnapshot(tabId, {
      url: data.url,
      elementCount: allElements.length,
      elements: allElements,
      coverage: data.coverage,
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
        coverage: data.coverage,
        message:
          'Baseline snapshot established. Subsequent interactions will report incremental DOM deltas.',
      };
    }

    return { ...diff, coverage: data.coverage };
  } catch (err) {
    const attemptedFrames = 'all' as const;
    return {
      isDelta: false,
      unchanged: false,
      revision: -1,
      added: [],
      modified: [],
      removed: [],
      totalCurrent: 0,
      error: err instanceof Error ? err.message : String(err),
      coverage: {
        status: 'failed',
        attemptedFrames,
      },
    };
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
  activeModal?: string;
  focusTrapped?: boolean;
  modalIsolated?: boolean;
  isConfirmationTrap?: boolean;
  scrollInfo?: ScrollInfo;
  deltaSummary: { added: number; modified: number; removed: number };
  coverage?: NonNullable<DomDiffResult['coverage']>;
  deltaError?: string;
  truncated?: boolean;
  totalChanged?: { added: number; modified: number; removed: number };
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
  options?: { maxItems?: number; delayMs?: number; frameId?: number },
): Promise<ChainedSnapshotSummary> {
  return (await captureChainedSnapshot(tabId, previousUrl, options)).summary;
}

export async function captureChainedSnapshot(
  tabId: number,
  previousUrl: string,
  options?: { maxItems?: number; delayMs?: number; frameId?: number },
): Promise<{ summary: ChainedSnapshotSummary; delta?: DomDiffResult }> {
  const maxItems = options?.maxItems ?? 10;
  const delayMs = options?.delayMs ?? 100;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const currentUrl = tab?.url || previousUrl;
  const urlChanged = Boolean(previousUrl && currentUrl && previousUrl !== currentUrl);

  const delta = await captureDeltaIfRequested(tabId, true, delayMs);

  let activeElInfo: any = {};
  try {
    const activeRes = await executeInPage(
      options?.frameId !== undefined ? { tabId, frameIds: [options.frameId] } : { tabId },
      'inPageGetActiveElementSummary',
      [],
    );
    if (activeRes?.[0]?.result) {
      activeElInfo = activeRes[0].result;
    }
  } catch {}

  const added = delta?.added || [];
  const modified = delta?.modified || [];
  const removed = delta?.removed || [];

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

  const summary = {
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
    ...(activeElInfo.activeModal ? { activeModal: activeElInfo.activeModal } : {}),
    ...(typeof activeElInfo.focusTrapped === 'boolean'
      ? { focusTrapped: activeElInfo.focusTrapped }
      : {}),
    ...(typeof activeElInfo.modalIsolated === 'boolean'
      ? { modalIsolated: activeElInfo.modalIsolated }
      : {}),
    ...(typeof activeElInfo.isConfirmationTrap === 'boolean'
      ? { isConfirmationTrap: activeElInfo.isConfirmationTrap }
      : {}),
    ...(activeElInfo.scrollInfo ? { scrollInfo: activeElInfo.scrollInfo } : {}),
    deltaSummary: {
      added: added.length,
      modified: modified.length,
      removed: removed.length,
    },
    ...(delta?.coverage ? { coverage: delta.coverage } : {}),
    ...(delta?.error ? { deltaError: delta.error } : {}),
    ...(delta?.truncated
      ? {
          truncated: true,
          totalChanged: {
            added: delta.totalAdded ?? added.length,
            modified: delta.totalModified ?? modified.length,
            removed: delta.totalRemoved ?? removed.length,
          },
        }
      : {}),
    keyChanges,
  };
  return { summary, delta };
}
