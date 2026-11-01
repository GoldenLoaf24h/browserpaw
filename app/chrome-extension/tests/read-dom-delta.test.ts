import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SnapshotCacheManager } from '../utils/snapshot-cache-manager';

describe('SnapshotCacheManager (DOM Delta & Revision Diffing)', () => {
  let manager: SnapshotCacheManager;

  beforeEach(() => {
    manager = new SnapshotCacheManager();
  });

  it('reports isDelta false on initial capture when no baseline exists', () => {
    const elements = [
      { index: 1, tagName: 'button', text: 'Submit', isInteractive: true },
      { index: 2, tagName: 'input', text: '', isInteractive: true, value: 'test' },
    ];
    const diff = manager.diffWithPrevious(1, elements);
    expect(diff.isDelta).toBe(false);
    expect(diff.unchanged).toBe(false);
    expect(diff.added).toHaveLength(2);
  });

  it('correctly detects unchanged DOM on repeated capture and provides revision', () => {
    const elements = [{ index: 1, tagName: 'button', text: 'Submit', isInteractive: true }];
    manager.setSnapshot(1, { url: 'https://example.com', elementCount: 1, elements });
    const diff = manager.diffWithPrevious(1, elements);
    expect(diff.isDelta).toBe(true);
    expect(diff.unchanged).toBe(true);
    expect(diff.revision).toBe(2);
    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it('accurately captures added, modified, and removed elements', () => {
    const baseline = [
      { index: 1, tagName: 'button', text: 'Submit', isInteractive: true },
      { index: 2, tagName: 'input', text: 'Old', isInteractive: true, value: 'foo' },
      { index: 3, tagName: 'a', text: 'Old Link', isInteractive: true },
    ];
    manager.setSnapshot(1, { url: 'https://example.com', elementCount: 3, elements: baseline });

    // Next snapshot: [1] unchanged, [2] modified text/val, [3] removed, [4] added
    const next = [
      { index: 1, tagName: 'button', text: 'Submit', isInteractive: true },
      { index: 2, tagName: 'input', text: 'New', isInteractive: true, value: 'bar' },
      { index: 4, tagName: 'div', text: 'Modal popup', isInteractive: true },
    ];

    const diff = manager.diffWithPrevious(1, next);
    expect(diff.isDelta).toBe(true);
    expect(diff.unchanged).toBe(false);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].index).toBe(4);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].index).toBe(2);
    expect(diff.removed).toContain(3);
  });

  it('keeps the complete diff baseline while caching a partial observation for asset routing', () => {
    const elements = [
      { index: 1, tagName: 'button' },
      { index: 2, tagName: 'button' },
    ];
    manager.setSnapshot(1, {
      url: 'https://example.com',
      elementCount: 2,
      elements,
      coverage: { status: 'complete', attemptedFrames: 'all' },
    });
    manager.setSnapshot(1, {
      url: 'https://example.com',
      elementCount: 1,
      elements: elements.slice(0, 1),
      coverage: { status: 'incomplete', attemptedFrames: 'all' },
      assetRoutes: new Map([[7, { frameId: 0, localIndex: 0 }]]),
    });
    expect(manager.getSnapshot(1)?.assetRoutes?.get(7)?.frameId).toBe(0);
    expect(manager.diffWithPrevious(1, elements)).toMatchObject({
      isDelta: true,
      unchanged: true,
      added: [],
      modified: [],
      removed: [],
    });
    manager.invalidate(1, 'navigation');
    expect(manager.diffWithPrevious(1, elements).isDelta).toBe(false);
    manager.clear(1);
    expect(manager.diffWithPrevious(1, elements).isDelta).toBe(false);
  });

  it('reports failed delta collection instead of substituting a main-frame-only capture', async () => {
    const helper = await import('../utils/delta-helper');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'https://example.com' }),
      },
    };
    const executeSpy = vi
      .spyOn(engine, 'executeInPage')
      .mockRejectedValue(new Error('all frame capture failed'));

    const delta = await helper.captureDeltaIfRequested(77, true, 0);
    expect(delta?.error).toContain('all frame capture failed');
    expect(delta?.coverage?.status).toBe('failed');
    expect(delta?.coverage?.attemptedFrames).toBe('all');
    expect(executeSpy.mock.calls.filter((call) => !(call[0] as any).allFrames)).toHaveLength(0);
  });

  it('reports incomplete coverage when a non-main frame fails during delta capture', async () => {
    const helper = await import('../utils/delta-helper');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'https://example.com' }),
      },
    };
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      {
        frameId: 0,
        result: { indexedElements: [{ index: 1, tagName: 'button', text: 'Main' }] },
      },
      { frameId: 2, result: null },
    ] as any);

    const delta = await helper.captureDeltaIfRequested(78, true, 0);

    expect(delta?.totalCurrent).toBe(1);
    expect(delta?.coverage).toMatchObject({
      attemptedFrames: 'all',
      reportedFrames: 2,
      successfulFrames: 1,
      failedFrameCount: 1,
      status: 'incomplete',
    });
  });

  it('does not infer removals or replace a complete baseline when a frame disappears from observation', async () => {
    const { captureDeltaIfRequested } = await import('../utils/delta-helper');
    const { snapshotCacheManager } = await import('../utils/snapshot-cache-manager');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const baseline = snapshotCacheManager.setSnapshot(707, {
      url: 'https://example.com/',
      elementCount: 2,
      elements: [
        { index: 1, tagName: 'button' },
        { index: 2, tagName: 'button' },
      ],
    });
    (globalThis as any).chrome = {
      tabs: { get: vi.fn(async () => ({ url: 'https://example.com/' })) },
      webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0 }, { frameId: 2 }]) },
    };
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      { frameId: 0, result: { indexedElements: [{ index: 1, tagName: 'button' }] } },
    ] as any);
    const delta = await captureDeltaIfRequested(707, true, 0);
    expect(delta?.coverage?.status).toBe('incomplete');
    expect(delta?.removed).toEqual([]);
    expect(delta?.unchanged).toBe(false);
    expect(snapshotCacheManager.getSnapshot(707)?.snapshotId).toBe(baseline.snapshotId);
    expect(snapshotCacheManager.getSnapshot(707)?.elementCount).toBe(2);
  });

  it('fails instead of establishing a baseline when every frame reports an error', async () => {
    const helper = await import('../utils/delta-helper');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'https://example.com' }),
      },
    };
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      { frameId: 0, result: { isErrorPage: true } },
      { frameId: 1, result: null },
    ] as any);

    const delta = await helper.captureDeltaIfRequested(79, true, 0);

    expect(delta?.error).toContain('failed in every reported frame');
    expect(delta?.coverage?.status).toBe('failed');
  });
});
