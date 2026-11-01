import { describe, it, expect } from 'vitest';
import { resolveTargetLocation } from '../utils/unified-locator';

describe('Unified Locator Strictness & Cross-Frame Verification', () => {
  it('reproduces flaw: cross-frame ambiguity when main frame and iframe both have matching selector', async () => {
    const mockDeps = {
      executeInPage: async (target: any) => {
        if (target.allFrames) {
          return [
            {
              frameId: 0,
              result: { success: true, x: 100, y: 100, width: 50, height: 20, tagName: 'BUTTON' },
            },
            {
              frameId: 1,
              result: { success: true, x: 200, y: 200, width: 50, height: 20, tagName: 'BUTTON' },
            },
          ];
        }
        return [
          {
            frameId: 0,
            result: { success: true, x: 100, y: 100, width: 50, height: 20, tagName: 'BUTTON' },
          },
        ];
      },
    };

    const res = await resolveTargetLocation(1, { selector: '.action-btn' }, mockDeps);
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
    expect(res.error).toContain('frameId');
  });

  it('reproduces flaw: cross-frame ambiguity between two subframes when main frame has no match', async () => {
    const mockDeps = {
      executeInPage: async (target: any) => {
        if (target.allFrames) {
          return [
            { frameId: 0, result: { success: false, notFound: true } },
            {
              frameId: 1,
              result: { success: true, x: 150, y: 150, width: 80, height: 30, tagName: 'A' },
            },
            {
              frameId: 2,
              result: { success: true, x: 350, y: 350, width: 80, height: 30, tagName: 'A' },
            },
          ];
        }
        return [{ frameId: 0, result: { success: false, notFound: true } }];
      },
    };

    const res = await resolveTargetLocation(1, { text: 'Learn More' }, mockDeps);
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('text');
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
  });

  it('reproduces flaw: ambiguous selector must NOT degrade to coordinate fallback', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          {
            frameId: 0,
            result: { success: true, x: 100, y: 100, width: 40, height: 20, tagName: 'INPUT' },
          },
          {
            frameId: 1,
            result: { success: true, x: 300, y: 300, width: 40, height: 20, tagName: 'INPUT' },
          },
        ];
      },
    };

    const res = await resolveTargetLocation(
      1,
      { selector: 'input.username', coordinate: { x: 500, y: 500 } },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
  });

  it('reproduces flaw: ambiguous selector must NOT degrade to text locator', async () => {
    const mockDeps = {
      executeInPage: async (_target: any, fnName: string) => {
        if (fnName === 'inPageLocateBySelector') {
          return [
            {
              frameId: 0,
              result: { success: true, x: 100, y: 100, width: 40, height: 20, tagName: 'BUTTON' },
            },
            {
              frameId: 1,
              result: { success: true, x: 300, y: 300, width: 40, height: 20, tagName: 'BUTTON' },
            },
          ];
        }
        if (fnName === 'inPageLocateByText') {
          return [
            {
              frameId: 0,
              result: { success: true, x: 100, y: 100, width: 40, height: 20, tagName: 'BUTTON' },
            },
          ];
        }
        return [];
      },
    };

    const res = await resolveTargetLocation(
      1,
      { selector: 'button.action', text: 'Submit' },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
  });

  it('handles in-page reported single-frame ambiguity without degrading', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          {
            frameId: 0,
            result: {
              success: false,
              matchCount: 3,
              error: 'Strict mode violation: locator(".dup") resolved to 3 elements in document',
            },
          },
        ];
      },
    };

    const res = await resolveTargetLocation(
      1,
      { selector: '.dup', text: 'Fallback', coordinate: { x: 100, y: 100 } },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/strict mode|violation|resolved to 3 elements/i);
  });

  it('handles ref ambiguity across frames without degrading', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          { frameId: 0, result: { success: true, x: 100, y: 100, tagName: 'BUTTON' } },
          { frameId: 2, result: { success: true, x: 300, y: 300, tagName: 'BUTTON' } },
        ];
      },
    };

    const res = await resolveTargetLocation(1, { ref: 10, selector: '#btn' }, mockDeps);
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('ref');
    expect(res.error).toMatch(/strict mode|ambiguity|ambiguous|multiple elements/i);
  });

  it('qualifies matches properly: ignores zero-dimension invisible elements across frames', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          // Frame 0 has zero-dimension invisible element
          {
            frameId: 0,
            result: { success: true, x: 10, y: 10, width: 0, height: 0, tagName: 'DIV' },
          },
          // Frame 1 has a real visible element
          {
            frameId: 1,
            result: { success: true, x: 250, y: 250, width: 100, height: 40, tagName: 'DIV' },
          },
        ];
      },
    };

    const res = await resolveTargetLocation(1, { selector: '.card' }, mockDeps);
    expect(res.success).toBe(true);
    expect(res.frameId).toBe(1);
    expect(res.x).toBe(250);
    expect(res.y).toBe(250);
  });

  it('qualifies matches properly: ignores elements marked invisible', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          {
            frameId: 0,
            result: {
              success: true,
              x: 100,
              y: 100,
              width: 50,
              height: 20,
              visible: false,
              tagName: 'SPAN',
            },
          },
          {
            frameId: 2,
            result: {
              success: true,
              x: 200,
              y: 200,
              width: 50,
              height: 20,
              visible: true,
              tagName: 'SPAN',
            },
          },
        ];
      },
    };

    const res = await resolveTargetLocation(1, { selector: '.badge' }, mockDeps);
    expect(res.success).toBe(true);
    expect(res.frameId).toBe(2);
    expect(res.x).toBe(200);
  });

  it('preserves normal single match path with metadata', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          {
            frameId: 3,
            result: {
              success: true,
              x: 120,
              y: 240,
              width: 100,
              height: 30,
              tagName: 'BUTTON',
              text: 'Save',
              role: 'button',
              frameOffsetX: 10,
              frameOffsetY: 20,
              attributes: { id: 'save-btn', class: 'primary' },
            },
          },
        ];
      },
    };

    const res = await resolveTargetLocation(1, { selector: '#save-btn' }, mockDeps);
    expect(res.success).toBe(true);
    expect(res.resolutionPath).toBe('selector');
    expect(res.x).toBe(120);
    expect(res.y).toBe(240);
    expect(res.frameId).toBe(3);
    expect(res.frameOffsetX).toBe(10);
    expect(res.frameOffsetY).toBe(20);
    expect(res.attributes).toEqual({ id: 'save-btn', class: 'primary' });
    expect(res.tagName).toBe('BUTTON');
  });

  it('preserves clean fallback when earlier locator has zero matches (not ambiguous)', async () => {
    const mockDeps = {
      executeInPage: async (_target: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageGetElementCoordinates') {
          // Ref 99 not found (0 matches)
          return [{ frameId: 0, result: { success: false, notFound: true } }];
        }
        if (fnName === 'inPageLocateBySelector' && args[0] === '#fallback-btn') {
          // Unique match on selector
          return [
            {
              frameId: 0,
              result: { success: true, x: 300, y: 400, width: 50, height: 20, tagName: 'BUTTON' },
            },
          ];
        }
        return [{ frameId: 0, result: { success: false, notFound: true } }];
      },
    };

    const res = await resolveTargetLocation(
      1,
      { ref: 99, selector: '#fallback-btn', coordinate: { x: 50, y: 50 } },
      mockDeps,
    );
    expect(res.success).toBe(true);
    expect(res.resolutionPath).toBe('selector');
    expect(res.x).toBe(300);
    expect(res.y).toBe(400);
  });

  it('preserves coordinate fallback when all preceding tiers have zero matches', async () => {
    const mockDeps = {
      executeInPage: async () => [{ frameId: 0, result: { success: false, notFound: true } }],
    };

    const res = await resolveTargetLocation(
      1,
      { selector: '#nonexistent', text: 'NotFound', coordinate: { x: 600, y: 700 } },
      mockDeps,
    );
    expect(res.success).toBe(true);
    expect(res.resolutionPath).toBe('coordinate');
    expect(res.x).toBe(600);
    expect(res.y).toBe(700);
  });

  it('returns explicit error when no locators are provided', async () => {
    const res = await resolveTargetLocation(1, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('No target locator provided');
  });

  it('rejects non-finite caller coordinates instead of dispatching them', async () => {
    const res = await resolveTargetLocation(1, { coordinate: { x: Infinity, y: 10 } });
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('ref');
    expect(res.error).toContain('No target locator provided');
  });

  it.each(
    [
      [],
      [{ frameId: 0, result: {} }],
      [{ frameId: 0, result: { success: false } }],
      [{ frameId: 0, result: { success: true, x: NaN, y: 10 } }],
      [{ frameId: 0, result: { success: true, x: 10, y: Infinity } }],
    ].map((frames) => ({ frames })),
  )(
    'rejects missing or invalid frame observations without coordinate fallback: $frames',
    async ({ frames }) => {
      const result = await resolveTargetLocation(
        1,
        {
          selector: 'button',
          coordinate: { x: 20, y: 30 },
        },
        { executeInPage: async () => frames as any[] },
      );
      expect(result.success).toBe(false);
      expect(result.resolutionPath).toBe('selector');
    },
  );

  it('anti-masking: allFrames execution failure fails closed without degrading to coordinate', async () => {
    const mockDeps = {
      executeInPage: async () => {
        throw new Error('Frame execution crashed or detached');
      },
    };

    const res = await resolveTargetLocation(
      1,
      { selector: '.action-btn', coordinate: { x: 100, y: 100 } },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/Execution across frames failed|Frame execution crashed/i);
  });

  it('anti-masking: subframe entry.error fails closed without masking subframe failure', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          { frameId: 0, result: { success: false, notFound: true } },
          { frameId: 2, error: 'Cannot access cross-origin frame contents' },
        ];
      },
    };

    const res = await resolveTargetLocation(
      1,
      { selector: '.action-btn', coordinate: { x: 200, y: 200 } },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/Execution in frameId 2 failed|cross-origin/i);
  });

  it('anti-masking: unexpected script evaluation error fails closed without degrading', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          {
            frameId: 0,
            result: {
              success: false,
              matchCount: 0,
              error: 'XPath evaluation error: The expression is not a valid XPath expression.',
            },
          },
        ];
      },
    };

    const res = await resolveTargetLocation(
      1,
      { selector: '//invalid[xpath', coordinate: { x: 300, y: 300 } },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/Execution in frameId 0 failed|XPath evaluation error/i);
  });
  it('anti-masking: non-not-found error like namespace exhausted fails closed without degrading', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [
          {
            frameId: 0,
            result: {
              success: false,
              matchCount: 0,
              error: 'DOM index namespace exhausted; refusing to reuse an element index',
            },
          },
        ];
      },
    };

    const res = await resolveTargetLocation(
      1,
      { selector: '.action-btn', coordinate: { x: 100, y: 100 } },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/Execution in frameId 0 failed|namespace exhausted/i);
  });

  it('anti-masking: malformed frame response fails closed instead of continuing silently', async () => {
    const mockDeps = {
      executeInPage: async () => {
        return [{ frameId: 1 }];
      },
    };

    const res = await resolveTargetLocation(
      1,
      { selector: '.action-btn', coordinate: { x: 100, y: 100 } },
      mockDeps,
    );
    expect(res.success).toBe(false);
    expect(res.resolutionPath).toBe('selector');
    expect(res.error).toMatch(/Execution in frameId 1 returned malformed/i);
  });
});
