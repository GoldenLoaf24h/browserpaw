import { describe, it, expect, vi, beforeEach } from 'vitest';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';
import { ensureSnapshotBaseline, captureDeltaIfRequested } from '../utils/delta-helper';

describe('Observation guidance', () => {
  it('ensures snapshotCacheManager truncation summary emits browserpaw observe', () => {
    snapshotCacheManager.clear(8888);
    const baseline = [{ index: 1, tagName: 'button', text: 'Checkout', isInteractive: true }];
    snapshotCacheManager.setSnapshot(8888, {
      url: 'https://example.com',
      elementCount: 1,
      elements: baseline,
    });

    // Generate elements exceeding maxDelta to trigger truncation
    const current = [
      { index: 1, tagName: 'button', text: 'Checkout', isInteractive: true },
      ...Array.from({ length: 30 }, (_, i) => ({
        index: i + 2,
        tagName: 'div',
        text: `Item ${i}`,
        isInteractive: false,
      })),
    ];

    const delta = snapshotCacheManager.diffWithPrevious(8888, current, { maxDelta: 5 });
    expect(delta.truncated).toBe(true);
    expect(delta.summary).toBeDefined();
    expect(delta.summary).toContain('Call browserpaw observe for full DOM tree.');
    expect(delta.summary).not.toContain('chrome_read_dom');
  });
});

describe('Root Cause Fix 2: NavigateTool URL Fallback & Post-Settle Resolution', () => {
  it('correctly prioritizes url, pendingUrl, and targetUrl without returning empty string', () => {
    // Simulating Chrome MV3 new tab creation where url is initially empty string ""
    const targetUrl = 'https://github.com/owner/repo/compare/main...branch';

    const tabInitialEmpty = {
      id: 1581267530,
      windowId: 158126738,
      url: '',
      pendingUrl: targetUrl,
    };

    const resolvedUrl1 = tabInitialEmpty.url || tabInitialEmpty.pendingUrl || targetUrl;
    expect(resolvedUrl1).toBe(targetUrl);
    expect(resolvedUrl1).not.toBe('');

    const tabBothEmpty = {
      id: 1581267531,
      windowId: 158126738,
      url: '',
      pendingUrl: '',
    };
    const resolvedUrl2 = tabBothEmpty.url || tabBothEmpty.pendingUrl || targetUrl;
    expect(resolvedUrl2).toBe(targetUrl);
  });
});

describe('Root Cause Fix 3: Pre-Interaction Baseline Capture & Popup Delta Retention', () => {
  const testTabId = 9999;

  beforeEach(() => {
    snapshotCacheManager.clear(testTabId);
    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
  });

  it('pre-captures baseline before interaction so newly opened popups/dropdowns are not swallowed', async () => {
    // 1. Initial page state before click (e.g. GitHub page before clicking "Sync fork")
    const preClickDom = [
      { index: 1, tagName: 'button', text: 'Sync fork', isInteractive: true },
      { index: 2, tagName: 'a', text: 'Code', isInteractive: true },
      { index: 3, tagName: 'a', text: 'Pull requests', isInteractive: true },
    ];

    // Mock chrome.scripting.executeScript to return preClickDom first, then postClickDom
    const postClickDom = [
      { index: 1, tagName: 'button', text: 'Sync fork', isInteractive: true },
      { index: 2, tagName: 'a', text: 'Code', isInteractive: true },
      { index: 3, tagName: 'a', text: 'Pull requests', isInteractive: true },
      // Newly opened dropdown / modal popup elements:
      { index: 4, tagName: 'button', text: 'Update branch', isInteractive: true },
      { index: 5, tagName: 'button', text: 'Discard commits', isInteractive: true },
    ];

    let prunerCallCount = 0;
    (globalThis as any).chrome.scripting = {
      executeScript: vi.fn(async (opts: any) => {
        if (opts?.files) {
          return [{ frameId: 0, documentId: 'doc-root-cause', result: undefined }];
        }
        if (opts?.target?.documentIds) {
          return [{ frameId: 0, documentId: opts.target.documentIds[0], result: true }];
        }
        prunerCallCount++;
        const currentElements = prunerCallCount === 1 ? preClickDom : postClickDom;
        return [
          {
            frameId: 0,
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: {
                indexedElements: currentElements,
              },
            },
          },
        ];
      }),
    };
    (globalThis as any).chrome.webNavigation = {
      ...(globalThis as any).chrome.webNavigation,
      getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0 }]),
    };

    (chrome.tabs.get as any) = vi.fn(async (id: number) => ({
      id,
      url: 'https://github.com/owner/repo',
      title: 'Repository',
      status: 'complete',
    }));

    // Step A: Pre-interaction baseline establishment
    // Before click execution, ensureSnapshotBaseline is invoked
    await ensureSnapshotBaseline(testTabId, true);

    // Verify that pre-interaction baseline snapshot was successfully established
    const baselineSnap = snapshotCacheManager.getSnapshot(testTabId);
    expect(baselineSnap).toBeDefined();
    expect(baselineSnap?.elementCount).toBe(3);

    // Step B: Post-interaction delta capture
    // Action has executed, popup appeared, captureDeltaIfRequested is invoked
    const delta = await captureDeltaIfRequested(testTabId, true);

    expect(delta).toBeDefined();
    expect(delta?.isDelta).toBe(true);
    expect(delta?.added).toBeDefined();
    expect(delta?.added.length).toBe(2);

    // Check that popup elements ("Update branch" and "Discard commits") were captured in added delta!
    const addedTexts = delta?.added.map((e: any) => e.text);
    expect(addedTexts).toContain('Update branch');
    expect(addedTexts).toContain('Discard commits');
  });
});
