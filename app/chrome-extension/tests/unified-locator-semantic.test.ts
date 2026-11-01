import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTargetLocation } from '../utils/unified-locator';
import { matchSemantically } from '../utils/form-semantic-matcher';
import * as nativeHost from '../entrypoints/background/native-host';

describe('Unified Locator Plan B - Semantic & Intelligent Positioning', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a changed accessible name after the model selects a candidate', async () => {
    const element = {
      index: 3,
      tagName: 'BUTTON',
      role: 'button',
      text: 'Sign in',
      attributes: { 'aria-label': 'Sign in' },
      isInteractive: true,
      rect: { width: 100, height: 30 },
    };
    const result = await resolveTargetLocation(
      1,
      { text: 'Log in', operation: 'click' },
      {
        executeInPage: async (_target: any, name: string) => [
          {
            frameId: 0,
            documentId: 'document',
            result:
              name === 'inPageDOMPruner'
                ? { indexedElements: [element] }
                : name === 'inPageGetElementCoordinates'
                  ? {
                      ...element,
                      success: true,
                      x: 10,
                      y: 20,
                      text: 'Send',
                      attributes: { 'aria-label': 'Send' },
                    }
                  : { success: false, notFound: true },
          },
        ],
        semanticMatcher: async () => ({
          success: true,
          status: 'matched',
          matchedId: 'cand_0_3',
          confidence: 0.99,
        }),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/semantic.*changed/i);
  });

  it('keeps editable contents and values out of semantic candidate descriptions', async () => {
    const element = {
      index: 3,
      tagName: 'DIV',
      role: 'textbox',
      text: 'private draft',
      value: 'private draft',
      attributes: { 'aria-label': 'Message', contenteditable: 'true' },
      isEditor: true,
      isInteractive: true,
      rect: { width: 100, height: 30 },
    };
    const matcher = vi.fn(async () => ({ success: false, status: 'none' as const }));
    await resolveTargetLocation(
      1,
      { text: 'Draft editor', operation: 'fill' },
      {
        executeInPage: async (_target: any, name: string) => [
          {
            frameId: 0,
            documentId: 'document',
            result:
              name === 'inPageDOMPruner'
                ? { indexedElements: [element] }
                : { success: false, notFound: true },
          },
        ],
        semanticMatcher: matcher,
      },
    );
    expect(matcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(matcher.mock.calls)).not.toContain('private draft');
    expect(JSON.stringify(matcher.mock.calls)).toContain('Message');
  });

  it('does not scan semantic candidates when Native mode is off', async () => {
    const executeInPage = vi.fn(async () => [
      { frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } },
    ]);
    const result = await resolveTargetLocation(
      1,
      { text: 'Email' },
      { executeInPage, semanticEnabled: () => false },
    );
    expect(result.success).toBe(false);
    expect(executeInPage.mock.calls.every((args: unknown[]) => args[1] !== 'inPageDOMPruner')).toBe(
      true,
    );
  });

  it('does not repair an explicit missing reference with a model guess', async () => {
    const matcher = vi.fn(async () => ({ success: false, status: 'none' as const }));
    await resolveTargetLocation(
      1,
      { index: 99, text: 'Email' },
      {
        executeInPage: async (_target: any, name: string) => [
          {
            frameId: 0,
            documentId: 'document',
            result:
              name === 'inPageDOMPruner'
                ? {
                    indexedElements: [
                      { index: 3, tagName: 'BUTTON', text: 'Email address', isInteractive: true },
                    ],
                  }
                : { success: false, notFound: true },
          },
        ],
        semanticMatcher: matcher,
      },
    );
    expect(matcher).not.toHaveBeenCalled();
  });

  it('zero requests on exact unique match (deterministic ref/selector/text succeeds without calling AI)', async () => {
    const sendJevSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative');

    const mockDeps = {
      executeInPage: async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateByText') {
          return [
            {
              frameId: 0,
              documentId: 'doc-main-1',
              result: {
                success: true,
                x: 100,
                y: 100,
                width: 80,
                height: 30,
                tagName: 'BUTTON',
                text: 'Submit',
              },
            },
          ];
        }
        return [
          { frameId: 0, documentId: 'doc-main-1', result: { success: false, notFound: true } },
        ];
      },
      sendJevMatch: sendJevSpy,
    };

    const res = await resolveTargetLocation(1, { text: 'Submit' }, mockDeps);
    expect(res.success).toBe(true);
    expect(res.x).toBe(100);
    expect(res.resolutionPath).toBe('text');
    expect(sendJevSpy).not.toHaveBeenCalled();
  });

  it('allows semantic Plan B fallback using real inPageDOMPruner fixture with frame+index id and doc binding', async () => {
    const sendJevSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
      success: true,
      status: 'matched',
      matchedId: 'cand_0_10',
      confidence: 0.92,
      model: 'jev-system-one',
      engine: 'jev',
    } as any);

    const mockDeps = {
      executeInPage: async (_target: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageLocateByText') {
          return [
            { frameId: 0, documentId: 'doc-main-1', result: { success: false, notFound: true } },
          ];
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              documentId: 'doc-main-1',
              result: {
                treeString: 'button "Sign In to Account" [10]',
                elementCount: 1,
                interactiveCount: 1,
                compressionRatio: 0.9,
                indexMap: { 10: { tagName: 'BUTTON' } },
                indexedElements: [
                  {
                    index: 10,
                    tagName: 'BUTTON',
                    role: 'button',
                    text: 'Sign In to Account',
                    attributes: { id: 'btn-signin', class: 'btn primary' },
                    rect: { x: 150, y: 220, width: 100, height: 40 },
                    isInteractive: true,
                    isOccluded: false,
                  },
                ],
              },
            },
          ];
        }
        if (fnName === 'inPageGetElementCoordinates' && args[0] === 10) {
          return [
            {
              frameId: 0,
              documentId: 'doc-main-1',
              result: {
                success: true,
                x: 150,
                y: 220,
                width: 100,
                height: 40,
                tagName: 'BUTTON',
                text: 'Sign In to Account',
                role: 'button',
                attributes: { id: 'btn-signin' },
              },
            },
          ];
        }
        return [
          { frameId: 0, documentId: 'doc-main-1', result: { success: false, notFound: true } },
        ];
      },
      sendJevMatch: sendJevSpy,
    };

    const res = await resolveTargetLocation(1, { text: 'Log In', operation: 'click' }, mockDeps);
    expect(res.success).toBe(true);
    expect(res.resolutionPath).toBe('semantic');
    expect(res.x).toBe(150);
    expect(res.y).toBe(220);
    expect(sendJevSpy).toHaveBeenCalledTimes(1);

    const payload = sendJevSpy.mock.calls[0][0];
    expect(payload.query).toBe('Log In');
    expect(payload.operation).toBe('click');
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].id).toBe('cand_0_10');
    expect(payload.candidates[0].text).toContain('Sign In to Account');
    expect(payload).not.toHaveProperty('value');
  });

  it('operation-aware filtering for fill: strictly excludes non-text inputs (checkbox/radio/button/file)', async () => {
    const sendJevSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
      success: true,
      status: 'matched',
      matchedId: 'cand_0_2',
      confidence: 0.97,
    } as any);

    const mockDeps = {
      executeInPage: async (_target: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageLocateByText') {
          return [{ frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } }];
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              documentId: 'doc-1',
              result: {
                indexedElements: [
                  {
                    index: 1,
                    tagName: 'INPUT',
                    attributes: { type: 'checkbox' },
                    text: 'Email subscription option',
                    rect: { x: 10, y: 10, width: 20, height: 20 },
                    isInteractive: true,
                  },
                  {
                    index: 2,
                    tagName: 'INPUT',
                    attributes: { type: 'text', placeholder: 'Enter your email' },
                    text: 'Your email address',
                    rect: { x: 10, y: 40, width: 200, height: 35 },
                    isInteractive: true,
                  },
                ],
              },
            },
          ];
        }
        if (fnName === 'inPageGetElementCoordinates' && args[0] === 2) {
          return [
            {
              frameId: 0,
              documentId: 'doc-1',
              result: {
                success: true,
                x: 10,
                y: 40,
                width: 200,
                height: 35,
                tagName: 'INPUT',
                text: 'Your email address',
                attributes: { type: 'text', placeholder: 'Enter your email' },
              },
            },
          ];
        }
        return [];
      },
      sendJevMatch: sendJevSpy,
    };

    const res = await resolveTargetLocation(1, { text: 'Email', operation: 'fill' }, mockDeps);
    expect(res.success).toBe(true);
    expect(res.index).toBe(2);

    const payload = sendJevSpy.mock.calls[0][0];
    // Checkbox must be filtered out, only text input should be in candidates!
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].id).toBe('cand_0_2');
  });

  it('unconditional role filtering: excludes non-matching roles even when element count <= 5', async () => {
    const sendJevSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative');

    const mockDeps = {
      executeInPage: async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateByRole') {
          return [{ frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } }];
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              documentId: 'doc-1',
              result: {
                indexedElements: [
                  {
                    index: 1,
                    tagName: 'DIV',
                    role: 'generic',
                    text: 'Not a button',
                    attributes: {},
                    rect: { x: 10, y: 10, width: 100, height: 30 },
                    isInteractive: false,
                  },
                ],
              },
            },
          ];
        }
        return [];
      },
      sendJevMatch: sendJevSpy,
    };

    const res = await resolveTargetLocation(1, { role: 'button', text: 'Submit' }, mockDeps);
    expect(res.success).toBe(false);
    expect(sendJevSpy).not.toHaveBeenCalled();
  });

  it('fails with coverage error when entry.error exists or documentId is missing', async () => {
    const mockDeps = {
      executeInPage: async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateByText') {
          return [{ frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } }];
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              // missing documentId
              result: { indexedElements: [] },
            },
          ];
        }
        return [];
      },
    };

    const res = await resolveTargetLocation(1, { text: 'Search' }, mockDeps);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/coverage observation failed|missing documentid/i);
  });

  it('fails with explicit error when explicit frameId returns mismatching frame, never silently continuing', async () => {
    const mockDeps = {
      executeInPage: async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateByText') {
          return [{ frameId: 3, documentId: 'doc-3', result: { success: false, notFound: true } }];
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              documentId: 'doc-main',
              result: { indexedElements: [] },
            },
          ];
        }
        return [];
      },
    };

    const res = await resolveTargetLocation(1, { text: 'Action', frameId: 3 }, mockDeps);
    expect(res.success).toBe(false);
    expect(res.error).toContain('requested for frameId 3 but returned frameId 0');
  });

  it('rejects matchedId when given an elementIndex alias, strictly requiring unique candidate id', async () => {
    const sendJevSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
      success: true,
      status: 'matched',
      matchedId: 10, // Bare elementIndex number alias, not cand_0_10
      confidence: 0.97,
    } as any);

    const mockDeps = {
      executeInPage: async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateByText') {
          return [{ frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } }];
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              documentId: 'doc-1',
              result: {
                indexedElements: [
                  {
                    index: 10,
                    tagName: 'BUTTON',
                    role: 'button',
                    text: 'Confirm Action',
                    attributes: {},
                    rect: { x: 50, y: 50, width: 80, height: 30 },
                    isInteractive: true,
                  },
                ],
              },
            },
          ];
        }
        return [];
      },
      sendJevMatch: sendJevSpy,
    };

    const res = await resolveTargetLocation(1, { text: 'Confirm', operation: 'click' }, mockDeps);
    // Bare index 10 does not match cand_0_10; strict mode must not guess alias
    expect(res.success).toBe(false);
  });

  it('semantic identity check: rejects when documentId changes between observation and guard', async () => {
    const sendJevSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
      success: true,
      status: 'matched',
      matchedId: 'cand_0_1',
      confidence: 0.97,
    } as any);

    const mockDeps = {
      executeInPage: async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateByText') {
          return [
            { frameId: 0, documentId: 'doc-before', result: { success: false, notFound: true } },
          ];
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              documentId: 'doc-before',
              result: {
                indexedElements: [
                  {
                    index: 1,
                    tagName: 'BUTTON',
                    role: 'button',
                    text: 'Target',
                    attributes: {},
                    rect: { x: 10, y: 10, width: 50, height: 20 },
                    isInteractive: true,
                  },
                ],
              },
            },
          ];
        }
        if (fnName === 'inPageGetElementCoordinates') {
          // Document navigated or reloaded during inference!
          return [
            {
              frameId: 0,
              documentId: 'doc-after-reload',
              result: { success: true, x: 10, y: 10, width: 50, height: 20, tagName: 'BUTTON' },
            },
          ];
        }
        return [];
      },
      sendJevMatch: sendJevSpy,
    };

    const res = await resolveTargetLocation(1, { text: 'Target', operation: 'click' }, mockDeps);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/document changed during resolution/i);
  });

  it('semantic identity check: rejects when tagName or role mutates between observation and guard', async () => {
    const sendJevSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
      success: true,
      status: 'matched',
      matchedId: 'cand_0_1',
      confidence: 0.97,
    } as any);

    const mockDeps = {
      executeInPage: async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateByText') {
          return [{ frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } }];
        }
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              documentId: 'doc-1',
              result: {
                indexedElements: [
                  {
                    index: 1,
                    tagName: 'BUTTON',
                    role: 'button',
                    text: 'Button Text',
                    attributes: {},
                    rect: { x: 10, y: 10, width: 50, height: 20 },
                    isInteractive: true,
                  },
                ],
              },
            },
          ];
        }
        if (fnName === 'inPageGetElementCoordinates') {
          // Mutated into a SPAN
          return [
            {
              frameId: 0,
              documentId: 'doc-1',
              result: { success: true, x: 10, y: 10, width: 50, height: 20, tagName: 'SPAN' },
            },
          ];
        }
        return [];
      },
      sendJevMatch: sendJevSpy,
    };

    const res = await resolveTargetLocation(
      1,
      { text: 'Button Text', operation: 'click' },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tagName changed during resolution/i);
  });

  it('matchSemantically: never picks first on duplicate exact candidate matches', async () => {
    const candidates = [
      { id: 1, text: 'Confirm' },
      { id: 2, text: 'Confirm' },
    ];

    const res = await matchSemantically('choice', 'Confirm', candidates);
    expect(res).toBeNull();
  });

  describe('Unified Locator Bounded Cancellation and Deadlines', () => {
    it('does not lose cancellation raised synchronously by the page transport', async () => {
      const controller = new AbortController();
      const resolution = resolveTargetLocation(
        1,
        { selector: '#pending', signal: controller.signal },
        {
          executeInPage: () => {
            controller.abort();
            return new Promise<any[]>(() => {});
          },
        },
      );
      const outcome = await Promise.race([
        resolution,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 80)),
      ]);
      expect(outcome).toMatchObject({
        success: false,
        status: 'cancelled',
        requestDispatched: false,
      });
    });
    it('aborts hung resolveAcrossFrames within short deadline or abort signal', async () => {
      const hungExecute = vi.fn(() => new Promise<any[]>(() => {}));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      const start = Date.now();
      const res = await resolveTargetLocation(
        1,
        { selector: '#hung-button', signal: controller.signal },
        { executeInPage: hungExecute },
      );
      const elapsed = Date.now() - start;

      expect(res.success).toBe(false);
      expect(res.dispatched).toBe(false);
      expect(elapsed).toBeLessThan(400);

      const resDeadline = await resolveTargetLocation(
        1,
        { selector: '#hung-button', deadlineAt: Date.now() + 30 },
        { executeInPage: hungExecute },
      );
      expect(resDeadline.success).toBe(false);
      expect(resDeadline.dispatched).toBe(false);
    }, 1000);

    it('bounds Plan B candidate observation and skips model call on cancellation', async () => {
      const matcher = vi.fn(async () => ({
        success: true,
        status: 'matched' as const,
        matchedId: 'cand_0_1',
      }));
      const hungScan = vi.fn(async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateByText') {
          return [{ frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } }];
        }
        if (fnName === 'inPageDOMPruner') {
          return new Promise<any[]>(() => {});
        }
        return [];
      });

      const res = await resolveTargetLocation(
        1,
        { text: 'NonExistent', deadlineAt: Date.now() + 30 },
        { executeInPage: hungScan, semanticMatcher: matcher },
      );

      expect(res.success).toBe(false);
      expect(res.dispatched).toBe(false);
      expect(matcher).not.toHaveBeenCalled();
    }, 1000);

    it('bounds post-model coords guard and skips guard if aborted after model match', async () => {
      const element = {
        index: 1,
        tagName: 'BUTTON',
        role: 'button',
        text: 'Checkout',
        isInteractive: true,
      };
      const controller = new AbortController();
      const matcher = vi.fn(async () => {
        controller.abort();
        return {
          success: true,
          status: 'matched' as const,
          matchedId: 'cand_0_1',
          confidence: 0.95,
        };
      });
      const guardSpy = vi.fn(() => new Promise<any[]>(() => {}));

      const res = await resolveTargetLocation(
        1,
        { text: 'Checkout Button', signal: controller.signal },
        {
          executeInPage: async (_target: any, fnName: string) => {
            if (fnName === 'inPageLocateByText')
              return [
                { frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } },
              ];
            if (fnName === 'inPageDOMPruner')
              return [{ frameId: 0, documentId: 'doc-1', result: { indexedElements: [element] } }];
            if (fnName === 'inPageGetElementCoordinates') return guardSpy();
            return [];
          },
          semanticMatcher: matcher,
        },
      );

      expect(res.success).toBe(false);
      expect(res.dispatched).toBe(false);
      expect(guardSpy).not.toHaveBeenCalled();
    }, 1000);

    it('preserves normal execution path when no deadline or signal is supplied', async () => {
      const res = await resolveTargetLocation(
        1,
        { selector: '#fast-btn' },
        {
          executeInPage: async () => [
            {
              frameId: 0,
              result: { success: true, x: 50, y: 50, width: 20, height: 20, tagName: 'BUTTON' },
            },
          ],
        },
      );
      expect(res.success).toBe(true);
      expect(res.x).toBe(50);
    });
  });
});
