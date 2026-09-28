import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureChainedSnapshotSummary, type ChainedSnapshotSummary } from '../utils/delta-helper';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';

vi.mock('../entrypoints/background/tools/browser/in-page-engine', () => ({
  executeInPage: vi.fn(),
}));

import { executeInPage } from '../entrypoints/background/tools/browser/in-page-engine';

describe('Chained Snapshot Enhancement (v3.4.0)', () => {
  const testTabId = 999;
  const testUrl = 'https://example.com/dashboard';

  beforeEach(() => {
    vi.clearAllMocks();
    snapshotCacheManager.clear();
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: testTabId, url: testUrl }),
      },
    };
  });

  it('captures activeElement and compact delta in chainedSnapshot', async () => {
    (executeInPage as any).mockImplementation((target: any, fnName: string) => {
      if (fnName === 'inPageGetActiveElementSummary') {
        return Promise.resolve([
          {
            result: {
              tagName: 'input',
              id: 'search-box',
              role: 'combobox',
              isInput: true,
              value: 'browser automation',
              hasActiveModal: false,
            },
          },
        ]);
      }
      if (fnName === 'inPageDOMPruner') {
        return Promise.resolve([
          {
            frameId: 0,
            result: {
              indexedElements: [
                { index: 1, tagName: 'input', text: 'search' },
                { index: 2, tagName: 'button', text: 'Search' },
                { index: 3, tagName: 'div', text: 'Result 1' },
              ],
            },
          },
        ]);
      }
      return Promise.resolve([]);
    });

    // Establish baseline
    snapshotCacheManager.setSnapshot(testTabId, {
      url: testUrl,
      elementCount: 2,
      elements: [
        { index: 1, tagName: 'input', text: 'search' },
        { index: 2, tagName: 'button', text: 'Search' },
      ],
    });

    const summary: ChainedSnapshotSummary = await captureChainedSnapshotSummary(
      testTabId,
      testUrl,
      { maxItems: 5, delayMs: 0 },
    );

    expect(summary.urlChanged).toBe(false);
    expect(summary.currentUrl).toBe(testUrl);
    expect(summary.activeElement).toBeDefined();
    expect(summary.activeElement?.tagName).toBe('input');
    expect(summary.activeElement?.id).toBe('search-box');
    expect(summary.activeElement?.isInput).toBe(true);
    expect(summary.hasActiveModal).toBe(false);
    expect(summary.deltaSummary.added).toBe(1);
    expect(summary.keyChanges.length).toBe(1);
    expect(summary.keyChanges[0].type).toBe('added');
    expect(summary.keyChanges[0].index).toBe(3);
  });

  it('caps keyChanges at maxItems to prevent context bloat', async () => {
    (executeInPage as any).mockImplementation((target: any, fnName: string) => {
      if (fnName === 'inPageGetActiveElementSummary') {
        return Promise.resolve([{ result: { tagName: 'body' } }]);
      }
      if (fnName === 'inPageDOMPruner') {
        const manyElements = Array.from({ length: 25 }, (_, i) => ({
          index: i + 1,
          tagName: 'li',
          text: `Item ${i + 1}`,
        }));
        return Promise.resolve([{ frameId: 0, result: { indexedElements: manyElements } }]);
      }
      return Promise.resolve([]);
    });

    // Baseline with 0 elements
    snapshotCacheManager.setSnapshot(testTabId, {
      url: testUrl,
      elementCount: 1,
      elements: [{ index: 9999, tagName: 'header', text: 'Baseline Header' }],
    });

    const summary = await captureChainedSnapshotSummary(testTabId, testUrl, {
      maxItems: 10,
      delayMs: 0,
    });

    expect(summary.deltaSummary.added).toBe(25);
    expect(summary.keyChanges.length).toBe(10); // Capped at 10
  });
});
