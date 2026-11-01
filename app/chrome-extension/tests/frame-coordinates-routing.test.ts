import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { projectFramePoint } from '../utils/frame-coordinates';

describe('document-bound frame projection through confirmed sessions', () => {
  let navigated: boolean;
  let markerMatches: boolean;
  let missingOwner: boolean;
  let viewportChanged: boolean;
  let send: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    navigated = false;
    markerMatches = true;
    missingOwner = false;
    viewportChanged = false;
    document.documentElement.removeAttribute('data-bp-frame-existing');
    vi.stubGlobal('innerWidth', 100);
    vi.stubGlobal('innerHeight', 100);
    vi.stubGlobal('chrome', {
      webNavigation: {
        getFrame: vi.fn(async () => ({ documentId: navigated ? 'new-doc' : 'task-doc' })),
      },
      scripting: {
        executeScript: vi.fn(async ({ target, func, args }) => {
          expect(target).toEqual({ tabId: 42, documentIds: ['task-doc'] });
          return [{ frameId: 126, result: func(...args) }];
        }),
      },
    });
    vi.spyOn(cdpSessionManager, 'ensureFrameSessions').mockResolvedValue([
      { sessionId: 'B', targetId: 'frame-B' },
      { sessionId: 'C', targetId: 'frame-C', parentSessionId: 'B' },
    ]);
    send = vi
      .spyOn(cdpSessionManager, 'sendFrameCommand')
      .mockImplementation(async (_tab, session, method, params: any) => {
        const root = session === 'C' ? 'frame-C' : session === 'B' ? 'frame-B' : 'frame-A';
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: root } } } as any;
        }
        if (method === 'Page.createIsolatedWorld') {
          if (params.frameId !== root) throw new Error('Foreign frame');
          return { executionContextId: session === 'C' ? 3 : session === 'B' ? 2 : 1 } as any;
        }
        if (method === 'Runtime.evaluate') {
          if (params.expression.includes('marked:')) {
            return {
              result: {
                value: { marked: markerMatches, width: viewportChanged ? 200 : 100, height: 100 },
              },
            } as any;
          }
          if (params.expression.includes('hasAttribute')) {
            return { result: { value: params.contextId === 3 && markerMatches } } as any;
          }
          return { result: { value: { width: 200, height: 100 } } } as any;
        }
        if (method === 'DOM.getFrameOwner') {
          if (missingOwner) throw new Error('Missing frame owner');
          expect([session, params.frameId]).toEqual(
            session === 'B' ? ['B', 'frame-C'] : [undefined, 'frame-B'],
          );
          return { backendNodeId: session === 'B' ? 3 : 2 } as any;
        }
        if (method === 'DOM.scrollIntoViewIfNeeded') return {} as any;
        if (method === 'DOM.getBoxModel') {
          return {
            model: {
              content:
                session === 'B'
                  ? [10, 20, 110, 20, 110, 120, 10, 120]
                  : [100, 50, 500, 50, 500, 250, 100, 250],
            },
          } as any;
        }
        throw new Error(`Unexpected command ${method}`);
      });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('walks C to B to the main renderer, composing their real quads', async () => {
    expect(await projectFramePoint(42, 126, { x: 25, y: 30 })).toEqual({ x: 170, y: 150 });
    expect(
      send.mock.calls.filter((call) => call[2] === 'DOM.getFrameOwner').map((call) => call[1]),
    ).toEqual(['B', undefined]);
    expect(
      Array.from(document.documentElement.attributes).some((a) =>
        a.name.startsWith('data-bp-frame-'),
      ),
    ).toBe(false);
  });

  it('cannot substitute an equal-URL document without the unique marker', async () => {
    markerMatches = false;
    await expect(projectFramePoint(42, 126, { x: 25, y: 30 })).rejects.toThrow(
      'confirmed sessions',
    );
    expect(send.mock.calls.some((call) => call[2] === 'DOM.getFrameOwner')).toBe(false);
  });

  it('rejects a disappearing owner without dispatching input', async () => {
    missingOwner = true;
    await expect(projectFramePoint(42, 126, { x: 25, y: 30 })).rejects.toThrow(
      'Missing frame owner',
    );
    expect(send.mock.calls.some((call) => String(call[2]).startsWith('Input.'))).toBe(false);
    expect(
      Array.from(document.documentElement.attributes).some((a) =>
        a.name.startsWith('data-bp-frame-'),
      ),
    ).toBe(false);
  });

  it('rejects navigation to a different document even when the URL is unchanged', async () => {
    vi.mocked(chrome.webNavigation.getFrame).mockResolvedValueOnce({
      documentId: 'task-doc',
    } as any);
    navigated = true;
    await expect(projectFramePoint(42, 126, { x: 25, y: 30 })).rejects.toThrow('navigated');
  });

  it('rejects a viewport change rather than using geometry sampled at the old size', async () => {
    viewportChanged = true;
    await expect(projectFramePoint(42, 126, { x: 25, y: 30 })).rejects.toThrow('viewport changed');
  });

  it('cleans a stamp that executes after its injection timeout without touching existing attributes', async () => {
    vi.useFakeTimers();
    document.documentElement.setAttribute('data-bp-frame-existing', 'keep');
    let completeStamp: () => void = () => {};
    vi.mocked(chrome.scripting.executeScript).mockImplementationOnce(
      ({ func, args }: any) =>
        new Promise((resolve) => {
          completeStamp = () => resolve([{ result: func(...args) }]);
        }) as any,
    );
    const operation = projectFramePoint(42, 126, { x: 10, y: 20 });
    const rejected = expect(operation).rejects.toThrow('injection timed out');
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    completeStamp();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.documentElement.getAttribute('data-bp-frame-existing')).toBe('keep');
    expect(
      Array.from(document.documentElement.attributes).filter((a) =>
        a.name.startsWith('data-bp-frame-'),
      ),
    ).toHaveLength(1);
    document.documentElement.removeAttribute('data-bp-frame-existing');
    expect(vi.getTimerCount()).toBe(0);
  });
});
