import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveToolName,
  alignToolReferences,
  normalizeIncomingToolName,
  getActiveToolPrefix,
  setActiveToolPrefix,
} from 'chrome-mcp-shared';
import { snapshotCacheManager } from '../utils/snapshot-cache-manager';
import { ensureSnapshotBaseline, captureDeltaIfRequested } from '../utils/delta-helper';

describe('Root Cause Fix 1: Universal Tool Name Resolver & Namespace Dynamic Alignment', () => {
  it('resolves tool names dynamically and defaults to browserpaw_ prefix', () => {
    expect(getActiveToolPrefix()).toBe('browserpaw_');
    expect(resolveToolName('read_dom')).toBe('browserpaw_read_dom');
    expect(resolveToolName('chrome_read_dom')).toBe('browserpaw_read_dom');
    expect(resolveToolName('browserpaw_read_dom')).toBe('browserpaw_read_dom');
    expect(resolveToolName('browserclaw_read_dom')).toBe('browserpaw_read_dom');
    expect(resolveToolName('read_dom', 'chrome')).toBe('chrome_read_dom');
    expect(resolveToolName('batch_actions', 'chrome_')).toBe('chrome_batch_actions');
    expect(resolveToolName('read_dom', 'browserpaw')).toBe('browserpaw_read_dom');
    expect(resolveToolName('batch_actions', 'browserpaw_')).toBe('browserpaw_batch_actions');
    expect(resolveToolName('get_windows_and_tabs', 'browserpaw')).toBe(
      'browserpaw_get_windows_and_tabs',
    );
    expect(resolveToolName('get_windows_and_tabs', 'chrome')).toBe('get_windows_and_tabs');
  });

  it('normalizes incoming tool names from both namespaces to internal canonical backend names', () => {
    expect(normalizeIncomingToolName('browserpaw_read_dom')).toEqual({
      canonicalBackendName: 'chrome_read_dom',
      prefix: 'browserpaw_',
    });
    expect(normalizeIncomingToolName('browserclaw_read_dom')).toEqual({
      canonicalBackendName: 'chrome_read_dom',
      prefix: 'browserclaw_',
    });
    expect(normalizeIncomingToolName('chrome_read_dom')).toEqual({
      canonicalBackendName: 'chrome_read_dom',
      prefix: 'chrome_',
    });
    expect(normalizeIncomingToolName('browserpaw_get_windows_and_tabs')).toEqual({
      canonicalBackendName: 'get_windows_and_tabs',
      prefix: 'browserpaw_',
    });
    expect(normalizeIncomingToolName('browserclaw_get_windows_and_tabs')).toEqual({
      canonicalBackendName: 'get_windows_and_tabs',
      prefix: 'browserclaw_',
    });
    expect(normalizeIncomingToolName('get_windows_and_tabs')).toEqual({
      canonicalBackendName: 'get_windows_and_tabs',
      prefix: '',
    });
  });

  it('aligns legacy tool references in prompts, hints, and errors to requested target prefix', () => {
    const rawHint =
      'Delta truncated: showing 0/0 added, 25/143 modified, 1/1 removed. Call chrome_read_dom for full DOM tree. Prefer chrome_batch_actions over chrome_interact_index. Also check get_windows_and_tabs.';
    const aligned = alignToolReferences(rawHint, 'browserpaw');

    expect(aligned).toContain('Call browserpaw_read_dom for full DOM tree.');
    expect(aligned).toContain('Prefer browserpaw_batch_actions');
    expect(aligned).toContain('browserpaw_interact_index');
    expect(aligned).toContain('browserpaw_get_windows_and_tabs');

    // Bidirectional alignment: browserpaw_ -> chrome_
    const modernHint =
      'Call browserpaw_read_dom for full DOM tree. Prefer browserpaw_batch_actions over browserpaw_interact_index. Also check browserpaw_get_windows_and_tabs.';
    const alignedToChrome = alignToolReferences(modernHint, 'chrome');
    expect(alignedToChrome).toContain('Call chrome_read_dom for full DOM tree.');
    expect(alignedToChrome).toContain('Prefer chrome_batch_actions');
    expect(alignedToChrome).toContain('chrome_interact_index');
    expect(alignedToChrome).toContain('get_windows_and_tabs');

    // Ensure URLs and system paths containing "chrome" are never corrupted
    const textWithUrls =
      'Navigate to chrome://extensions or https://chrome.google.com via chrome_navigate';
    const alignedUrls = alignToolReferences(textWithUrls, 'browserpaw');
    expect(alignedUrls).toContain('chrome://extensions');
    expect(alignedUrls).toContain('https://chrome.google.com');
    expect(alignedUrls).toContain('browserpaw_navigate');
  });

  it('ensures snapshotCacheManager truncation summary emits browserpaw_read_dom', () => {
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
    // Verify it instructs calling browserpaw_read_dom, not legacy chrome_read_dom
    expect(delta.summary).toContain('Call browserpaw_read_dom for full DOM tree.');
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
          return [{ result: undefined }];
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
