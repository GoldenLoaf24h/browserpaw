import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  executeInPage,
  injectedTabs,
  isNavigationOrContextDestroyedError,
} from '../entrypoints/background/tools/browser/in-page-engine';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import {
  tokenizeText,
  scoreCandidate,
  heuristicSemanticMatch,
  matchSemantically,
} from '../utils/form-semantic-matcher';
import * as nativeHost from '../entrypoints/background/native-host';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import { inPageQueryChoiceCandidates } from '../entrypoints/background/tools/browser/dom-indexer';

describe('Boost 6: Single-Turn Evaluation & Jev-Powered Form Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    injectedTabs.clear();
    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      tabs: {
        ...((globalThis as any).chrome?.tabs || {}),
        get: vi.fn().mockResolvedValue({ id: 101, url: 'https://example.com' }),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn(),
      },
    };
  });

  describe('1. executeInPage Single-Turn Evaluation & Resiliency', () => {
    it('detects navigation and context destruction errors accurately', () => {
      expect(isNavigationOrContextDestroyedError(new Error('Execution context was destroyed'))).toBe(true);
      expect(isNavigationOrContextDestroyedError(new Error('Frame was removed'))).toBe(true);
      expect(isNavigationOrContextDestroyedError(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(true);
      expect(isNavigationOrContextDestroyedError(new Error('No tab with id 123'))).toBe(true);
      expect(isNavigationOrContextDestroyedError(new Error('Cannot access contents of the page'))).toBe(true);
      expect(isNavigationOrContextDestroyedError(new Error('SyntaxError: Unexpected token'))).toBe(false);
      expect(isNavigationOrContextDestroyedError(null)).toBe(false);
    });

    it('evaluates synchronous entrypoints in a single turn without poll or retrieve', async () => {
      let executeScriptCallCount = 0;
      const scriptCalls: any[] = [];
      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 101, url: 'https://example.com' });
      (globalThis.chrome.scripting as any).executeScript = vi.fn().mockImplementation(async (opts: any) => {
        executeScriptCallCount++;
        scriptCalls.push(opts);
        // First injection is the engine file if not already injected
        if (opts.files) {
          return [{ result: undefined }];
        }
        // Slot cleanup call in single-turn path
        if (opts.func && opts.args && opts.args.length === 1 && String(opts.args[0]).startsWith('__mcp_slot_')) {
          return [{ result: undefined }];
        }
        // Then eval-or-start call: simulate synchronous function execution in page
        return [
          {
            frameId: 0,
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { success: true, coords: { x: 120, y: 340 } },
            },
          },
        ];
      });

      const res = await executeInPage<{ success: boolean; coords: { x: number; y: number } }>(
        { tabId: 101 },
        'inPageGetElementCoordinates',
        [5],
      );

      // 1 file injection + 1 single-turn eval = exactly 2 calls (zero poll, zero retrieve, zero extra cleanup for single target sync)
      expect(executeScriptCallCount).toBe(2);
      expect(res[0].result.success).toBe(true);
      expect(res[0].result.coords.x).toBe(120);

      // On subsequent call with tab already cached in injectedTabs:
      executeScriptCallCount = 0;
      const res2 = await executeInPage(
        { tabId: 101 },
        'inPageGetElementCoordinates',
        [5],
      );
      // Only 1 single-turn call, 0 file injections, 0 poll calls, 0 retrieve calls
      expect(executeScriptCallCount).toBe(1);
      expect(res2[0].result.coords.y).toBe(340);
    });

    it('cleans up stashed slots across frames when allFrames synchronous evaluation completes', async () => {
      let cleanupCalled = false;
      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 102, url: 'https://example.com' });
      (globalThis.chrome.scripting as any).executeScript = vi.fn().mockImplementation(async (opts: any) => {
        if (opts.files) return [{ result: undefined }];
        if (opts.func && opts.args && opts.args.length === 1) {
          cleanupCalled = true;
          return [{ result: undefined }];
        }
        return [
          { frameId: 0, result: { engineType: 'object', fnType: 'function', singleTurn: true, status: 'success', value: { x: 10 } } },
          { frameId: 1, result: { engineType: 'object', fnType: 'function', singleTurn: true, status: 'success', value: { x: 20 } } },
        ];
      });

      const res = await executeInPage({ tabId: 102, allFrames: true }, 'inPageGetElementCoordinates', [5]);
      expect(res).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 20));
      expect(cleanupCalled).toBe(true);
    });

    it('cleans up its slot on eval-or-start timeout and late resolution without deleting other slots', async () => {
      const g = globalThis as any;
      const cleanedSlots: string[] = [];
      let lateResolveStart: any;
      const delayedStartPromise = new Promise((resolve) => {
        lateResolveStart = resolve;
      });

      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 103, url: 'https://example.com' });
      (globalThis.chrome.scripting as any).executeScript = vi.fn().mockImplementation(async (opts: any) => {
        if (opts.files) return [{ result: undefined }];
        if (opts.func && opts.args && opts.args.length === 1) {
          cleanedSlots.push(opts.args[0]);
          delete g[opts.args[0]];
          return [{ result: undefined }];
        }
        // Stash another slot belonging to someone else in the page
        g['other_user_slot'] = { value: 'keep_me' };
        // Simulate late start execution that hangs across timeout
        await delayedStartPromise;
        return [
          { frameId: 0, result: { engineType: 'object', fnType: 'function', singleTurn: true, status: 'success', value: { x: 99 } } },
        ];
      });

      // Run executeInPage with very small timeout (20ms) so eval-or-start times out
      const pending = executeInPage({ tabId: 103 }, 'inPageGetElementCoordinates', [5], 20);
      await expect(pending).rejects.toThrow();

      // After timeout, initial cleanup was called for own slot, other slot is untouched
      expect(cleanedSlots.length).toBeGreaterThan(0);
      expect(g['other_user_slot']).toBeDefined();

      // Settle late resolution: late cleanup triggers, other slot still untouched
      lateResolveStart();
      await new Promise((r) => setTimeout(r, 20));
      expect(g['other_user_slot']).toBeDefined();
      expect(g['other_user_slot'].value).toBe('keep_me');
    });

    it('falls back to poll and retrieve when entrypoint returns a promise', async () => {
      let executeScriptCallCount = 0;
      injectedTabs.add(202);

      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 202, url: 'https://example.com' });
      (globalThis.chrome.scripting as any).executeScript = vi.fn().mockImplementation(async (opts: any) => {
        executeScriptCallCount++;
        if (executeScriptCallCount === 1) {
          // eval-or-start returns singleTurn: false (async function)
          return [
            {
              frameId: 0,
              result: {
                engineType: 'object',
                fnType: 'function',
                singleTurn: false,
                promiseType: 'object',
              },
            },
          ];
        } else if (executeScriptCallCount === 2) {
          // poll call: indicates promise is settled
          return [
            {
              frameId: 0,
              result: { done: true },
            },
          ];
        } else if (executeScriptCallCount === 3) {
          // retrieve call: returns resolved value
          return [
            {
              frameId: 0,
              result: { settled: true, durationMs: 15 },
            },
          ];
        }
      });

      const res = await executeInPage({ tabId: 202 }, 'inPageWaitForDOMSettle', []);
      expect(executeScriptCallCount).toBe(3); // eval-or-start -> poll -> retrieve
      expect(res[0].result).toEqual({ settled: true, durationMs: 15 });
    });

    it('purges tab from injectedTabs when context is destroyed during navigation', async () => {
      injectedTabs.add(303);
      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 303, url: 'https://example.com' });
      (globalThis.chrome.scripting as any).executeScript = vi.fn().mockRejectedValue(
        new Error('Execution context was destroyed.'),
      );

      await expect(
        executeInPage({ tabId: 303 }, 'inPageGetElementCoordinates', [1]),
      ).rejects.toThrow('Execution context was destroyed.');

      expect(injectedTabs.has(303)).toBe(false);
    });
  });

  describe('2. Form Semantic Matcher (Jev + Heuristics + Synonyms)', () => {
    it('tokenizes alphanumeric and CJK text into semantic bigrams', () => {
      const tokens = tokenizeText('用户手机号 phone_number');
      expect(tokens).toContain('用户');
      expect(tokens).toContain('户手');
      expect(tokens).toContain('手机');
      expect(tokens).toContain('机号');
      expect(tokens).toContain('phone');
      expect(tokens).toContain('number');
    });

    it('scores synonym categories with high confidence', () => {
      expect(scoreCandidate('手机号', 'phone')).toBeGreaterThanOrEqual(0.9);
      expect(scoreCandidate('email', '电子邮箱')).toBeGreaterThanOrEqual(0.9);
      expect(scoreCandidate('确认', 'yes')).toBeGreaterThanOrEqual(0.9);
      expect(scoreCandidate('next step', '下一步')).toBeGreaterThanOrEqual(0.9);
    });

    it('heuristic semantic match selects the best candidate matching query intent', () => {
      const candidates = [
        { id: 1, text: 'First Name' },
        { id: 2, text: 'Mobile Phone Number' },
        { id: 3, text: 'Email Address' },
        { id: 4, text: 'Submit Order' },
      ];

      const resPhone = heuristicSemanticMatch('联系电话', candidates);
      expect(resPhone?.matchedId).toBe(2);

      const resEmail = heuristicSemanticMatch('邮箱', candidates);
      expect(resEmail?.matchedId).toBe(3);
    });

    it('invokes native Jev System One matching when available and returns typed result', async () => {
      vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
        success: true,
        matchedId: 2,
        confidence: 0.95,
        engine: 'jev',
      });

      const res = await matchSemantically(
        'field',
        'Your contact telephone',
        [
          { id: 1, text: 'User Name' },
          { id: 2, text: 'Mobile' },
        ],
      );

      expect(res?.matchedId).toBe(2);
      expect(res?.engine).toBe('jev');
      expect(res?.confidence).toBe(0.95);
    });

    it('falls back to heuristic when Jev native host call fails', async () => {
      vi.spyOn(nativeHost, 'sendJevMatchToNative').mockRejectedValue(new Error('Native host disconnected'));

      const res = await matchSemantically(
        'field',
        '手机号',
        [
          { id: 1, text: 'Home Address' },
          { id: 2, text: 'Telephone' },
        ],
      );

      expect(res?.matchedId).toBe(2);
      expect(res?.engine).toBe('heuristic');
    });
  });

  describe('3. Autonomous Form Pipeline with Jev Semantic Intelligence', () => {
    it('semantically matches fields when question phrasing differs from query', async () => {
      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({
        id: 400,
        url: 'https://example.com/survey',
      });

      vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 400,
        url: 'https://example.com/survey',
      });

      vi.spyOn(nativeHost, 'sendJevMatchToNative').mockImplementation(async (params: any) => {
        if (params.query.includes('contact number') || params.query.includes('联系方式')) {
          return { success: true, matchedId: 0, confidence: 0.95 };
        }
        return null as any;
      });

      let step = 1;
      (globalThis.chrome.scripting as any).executeScript = vi.fn().mockImplementation(async (opts: any) => {
        return [
          {
            frameId: 0,
            result: {
              engineType: 'object',
              fnType: 'function',
              singleTurn: true,
              status: 'success',
              value: { success: true },
            },
          },
        ];
      });

      // Mock executeInPage for pipeline steps
      const inPageEngine = await import('../entrypoints/background/tools/browser/in-page-engine');
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageCheckCaptcha') {
          return [{ result: { detected: false } }] as any;
        }
        if (fnName === 'inPageDetectPerceptiveSignature') {
          if (step === 1) {
            return [
              {
                result: {
                  question: 'Please enter your primary contact number',
                  progress: '1 / 1',
                  activeInputs: [{ index: 1, name: 'phone_input', tagName: 'input' }],
                  alerts: [],
                },
              },
            ] as any;
          } else {
            return [
              {
                result: {
                  question: 'Survey completed!',
                  progress: '1 / 1',
                  activeInputs: [],
                  alerts: [],
                },
              },
            ] as any;
          }
        }
        if (fnName === 'inPageGetElementCoordinates') {
          return [{ result: { success: true, x: 200, y: 200, tagName: 'input' } }] as any;
        }
        if (fnName === 'inPageVerifyInputCommitment') {
          step++;
          return [{ result: { success: true, committed: true } }] as any;
        }
        if (fnName === 'inPageFillIndex') {
          step++;
          return [{ result: { success: true, committed: true } }] as any;
        }
        if (fnName === 'inPageLocateByText') {
          return [{ result: { success: true, index: 88, tagName: 'button' } }] as any;
        }
        if (fnName === 'inPageWaitForDOMSettle') {
          return [{ result: { settled: true, durationMs: 0 } }] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      const res = await formPipelineTool.execute({
        fields: [
          { query: '手机号', value: '13800138000' },
        ],
        tabId: 400,
        maxSteps: 3,
      });

      expect(res.isError).toBe(false);
      const payload = JSON.parse(res.content[0].text);
      expect(payload.status).toBe('completed');
      expect(payload.completedFields.length).toBe(1);
      expect(payload.completedFields[0].value).toBe('13800138000');
    });

    it('uses inPageQueryChoiceCandidates to semantically match and select choice options', async () => {
      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({
        id: 401,
        url: 'https://example.com/survey',
      });

      vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 401,
        url: 'https://example.com/survey',
      });

      let clickedIndex: number | undefined;
      vi.spyOn(formPipelineTool as any, 'dispatchNativeClick').mockImplementation(async (_tabId: number, index: number) => {
        clickedIndex = index;
        return true;
      });

      const inPageEngine = await import('../entrypoints/background/tools/browser/in-page-engine');
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
        if (fnName === 'inPageCheckCaptcha') {
          return [{ result: { detected: false } }] as any;
        }
        if (fnName === 'inPageDetectPerceptiveSignature') {
          return [
            {
              result: {
                question: 'What is your gender identity?',
                progress: '1 / 1',
                activeInputs: [],
                alerts: [],
              },
            },
          ] as any;
        }
        if (fnName === 'inPageLocateByText') {
          // Direct text match fails (e.g. text is slightly different or wrapped in custom widget)
          return [{ result: { success: false } }] as any;
        }
        if (fnName === 'inPageQueryChoiceCandidates') {
          return [
            {
              result: [
                { index: 11, tagName: 'button', text: 'Female / Woman' },
                { index: 12, tagName: 'button', text: 'Male / Man' },
                { index: 13, tagName: 'button', text: 'Prefer not to say' },
              ],
            },
          ] as any;
        }
        if (fnName === 'inPageWaitForDOMSettle') {
          return [{ result: { settled: true, durationMs: 0 } }] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      const res = await formPipelineTool.execute({
        fields: [
          { query: 'gender', value: 'woman', type: 'choice' },
        ],
        tabId: 401,
        maxSteps: 1,
      });

      expect(res.isError).toBe(false);
      expect(clickedIndex).toBe(11);
    });
  });

  describe('4. Resilient Edge Cases (Empty Candidates, Mixed Frames, Selector Fallback)', () => {
    it('does not falsely match candidates with empty string or single characters', async () => {
      const candidates = [
        { id: 1, text: '' },
        { id: 2, text: ' ' },
        { id: 3, text: 'a' },
        { id: 4, text: 'Full Name' },
      ];

      // Query "name" should match Candidate 4, not Candidate 1 (""), 2 (" "), or 3 ("a")
      const match = await matchSemantically('field', 'name', candidates);
      expect(match?.matchedId).toBe(4);

      // Blank query should return null
      const blankMatch = await matchSemantically('field', '', candidates);
      expect(blankMatch).toBeNull();
    });

    it('handles mixed sync and async frames in executeInPage without losing data', async () => {
      injectedTabs.add(501);
      let callCount = 0;

      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 501, url: 'https://example.com' });
      (globalThis.chrome.scripting as any).executeScript = vi.fn().mockImplementation(async (opts: any) => {
        if (opts.files) {
          return [{ result: undefined }];
        }
        callCount++;
        if (callCount === 1) {
          // eval-or-start: Frame 0 settled synchronously, Frame 1 returned a Promise
          return [
            {
              frameId: 0,
              result: {
                engineType: 'object',
                fnType: 'function',
                singleTurn: true,
                status: 'success',
                value: { frame: 0, syncVal: 42 },
              },
            },
            {
              frameId: 1,
              result: {
                engineType: 'object',
                fnType: 'function',
                singleTurn: false,
                promiseType: 'object',
              },
            },
          ];
        } else if (callCount === 2) {
          // poll: both frames done
          return [
            { frameId: 0, result: { done: true } },
            { frameId: 1, result: { done: true } },
          ];
        } else if (callCount === 3) {
          // retrieve: returns values from both frames
          return [
            { frameId: 0, result: { frame: 0, syncVal: 42 } },
            { frameId: 1, result: { frame: 1, asyncVal: 99 } },
          ];
        }
      });

      const res = await executeInPage({ tabId: 501, allFrames: true }, 'inPageReindexFrame', []);
      expect(res.length).toBe(2);
      expect(res[0].result).toEqual({ frame: 0, syncVal: 42 });
      expect(res[1].result).toEqual({ frame: 1, asyncVal: 99 });
    });

    it('falls back to synthetic in-page selector script when CDP is unavailable for selector target', async () => {
      // Mock CDP withSession to reject (simulating debugger unavailable / detached)
      const cdpMod = await import('../utils/cdp-session-manager');
      vi.spyOn(cdpMod.cdpSessionManager, 'withSession').mockRejectedValue(
        new Error('Debugger is not attached to this tab'),
      );

      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 601, url: 'https://example.com' });
      (globalThis.chrome.scripting as any).executeScript = vi.fn().mockImplementation(async (opts: any) => {
        // Fallback selector execution in page
        return [{ result: { success: true, filledText: 'test@example.com' } }];
      });

      const fillRes = await performPhysicalFill({
        tabId: 601,
        target: 'input[name="email"]',
        text: 'test@example.com',
      });

      expect(fillRes.success).toBe(true);
      expect(fillRes.method).toBe('synthetic_inpage');
      expect(fillRes.filledText).toBe('test@example.com');
    });
  });
});
