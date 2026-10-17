import { describe, expect, test, beforeEach } from '@jest/globals';
import { FastDecisionEngine, findMatchingPauseKeyword } from './fast-decision-engine';
import { isSessionKeyInvalid, resetInvalidKeyLatch } from './jev-client';
import { jevModelManager } from '../server/jev-model-manager';

describe('Fast Decision Engine Integration Tests (§4, §5, §6)', () => {
  beforeEach(() => {
    resetInvalidKeyLatch();
    delete process.env.TYPESAFE_API_KEY;
    jevModelManager.setActiveMode('remote');
  });

  const createMockInternalCaller = (pageData?: {
    treeString?: string;
    url?: string;
    title?: string;
    options?: Array<{ text: string; value: string }>;
  }) => {
    return async (toolName: string, args: any): Promise<any> => {
      if (toolName === 'chrome_read_dom') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                tabUrl: pageData?.url || 'https://example.com',
                tabTitle: pageData?.title || 'Example Domain',
                treeString:
                  pageData?.treeString ||
                  '[1] link "首页" href="/"\n[12] button "登录"\n[15] textbox "用户名"',
              }),
            },
          ],
        };
      }
      if (toolName === 'chrome_get_dropdown_options') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                options: pageData?.options || [
                  { text: 'Option A', value: 'opt_a' },
                  { text: 'Option B', value: 'opt_b' },
                ],
              }),
            },
          ],
        };
      }
      // Interaction tools (interact_index, fill_index, smart_scroll, navigate)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              urlChanged: args.action === 'back' || false,
              mutated: true,
            }),
          },
        ],
      };
    };
  };

  test('1. Heuristic fallback when no TYPESAFE_API_KEY is configured (§4.1)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const engine = new FastDecisionEngine();

    const result = await engine.run(
      { goal: '点击登录按钮', maxSteps: 3 },
      createMockInternalCaller(),
    );

    expect(result.engine).toBe('heuristic');
    expect(result.fallbackReason).toBe('no_api_key');
    expect(result.engineSwitched).toBe(false);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].action).toBe('click');
    expect(result.steps[0].target).toContain('[12]');
  });

  test('2. Enforces heuristic mode maxSteps <= 5 cap (§4.3)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const engine = new FastDecisionEngine();

    // Pass maxSteps 20 in heuristic mode -> must cap at 5
    const mockCaller = createMockInternalCaller();
    const result = await engine.run({ goal: '向下滑动', maxSteps: 20 }, mockCaller);

    expect(result.engine).toBe('heuristic');
    expect(result.steps.length).toBeLessThanOrEqual(5);
  });

  test('3. Escalates on destructive action in heuristic mode (§4.3)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const engine = new FastDecisionEngine();

    const caller = createMockInternalCaller({
      treeString: '[1] button "确认支付 $50"\n[2] link "取消"',
    });

    const result = await engine.run({ goal: '支付订单' }, caller);

    expect(result.status).toBe('escalate');
    expect(result.reason).toMatch(/destructive/i);
    expect(result.currentElements).toBeDefined();
    expect(result.currentElements!.length).toBeGreaterThan(0);
  });

  test('4. Detects stuck state when consecutive steps produce no change (§4.3)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const engine = new FastDecisionEngine();

    // Mock caller where interactions produce zero change
    const zeroChangeCaller = async (toolName: string, args: any) => {
      if (toolName === 'chrome_read_dom') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                tabUrl: 'https://example.com',
                tabTitle: 'Static Page',
                treeString: '[12] button "刷新"',
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              urlChanged: false,
              mutated: false,
            }),
          },
        ],
      };
    };

    const result = await engine.run({ goal: '点击刷新', maxSteps: 10 }, zeroChangeCaller);

    expect(result.status).toBe('stuck');
    expect(result.reason).toMatch(/stuck/i);
  });

  test('5. Detects goal_done in heuristic mode when text matches (§4.3)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const engine = new FastDecisionEngine();

    let stepCount = 0;
    const changingCaller = async (toolName: string, args: any) => {
      if (toolName === 'chrome_read_dom') {
        stepCount++;
        // Include a URL change so the goal-done heuristic has a real
        // navigation/mutation signal instead of static-text false positives.
        const text = stepCount > 1 ? '[1] text "已完成任务，保存成功"' : '[1] button "完成任务"';
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                tabUrl: stepCount > 1 ? 'https://example.com/done' : 'https://example.com',
                tabTitle: 'Task Flow',
                treeString: text,
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ urlChanged: true, mutated: true }),
          },
        ],
      };
    };

    const result = await engine.run({ goal: '完成任务', maxSteps: 5 }, changingCaller);

    expect(result.status).toBe('done');
  });

  test('6. Handles timeout guard when execution time exceeds timeoutMs (§4.4)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const engine = new FastDecisionEngine();

    const slowCaller = async (toolName: string) => {
      if (toolName === 'chrome_read_dom') {
        await new Promise((r) => setTimeout(r, 60));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                tabUrl: 'https://example.com',
                tabTitle: 'Slow Page',
                treeString: '[1] button "Action"',
              }),
            },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ urlChanged: false, mutated: true }) }],
      };
    };

    const result = await engine.run({ goal: '点击按钮', timeoutMs: 50, maxSteps: 5 }, slowCaller);

    expect(result.status).toBe('timeout');
    expect(result.reason).toMatch(/timeoutMs/i);
  });

  test('7. Progress notifications dispatched when _meta.progressToken provided (§6)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const engine = new FastDecisionEngine();

    const mockNotifications: any[] = [];
    const mockServer: any = {
      notification: async (notif: any) => {
        mockNotifications.push(notif);
      },
    };

    await engine.run(
      {
        goal: '点击登录按钮',
        maxSteps: 2,
        _meta: { progressToken: 'token-xyz-123' },
      },
      createMockInternalCaller(),
      mockServer,
    );

    expect(mockNotifications.length).toBeGreaterThan(0);
    expect(mockNotifications[0].method).toBe('notifications/progress');
    expect(mockNotifications[0].params.progressToken).toBe('token-xyz-123');
  });

  describe('Jev Mode & Degradation Matrix Tests (§1.3, §4, §5)', () => {
    const createMockJevAnswers = (overrides?: any) => {
      return {
        action: {
          type: 'choice',
          choice: 'click',
          confidence: 0.92,
          probabilities: {
            click: 0.92,
            type: 0.04,
            select: 0.01,
            scroll_down: 0.01,
            scroll_up: 0.0,
            back: 0.0,
            wait: 0.0,
            done: 0.02,
            escalate: 0.0,
          },
        },
        click_target: {
          type: 'choice',
          choice: '12',
          confidence: 0.88,
          probabilities: { '1': 0.05, '12': 0.88, '15': 0.04, none: 0.03 },
        },
        type_target: {
          type: 'choice',
          choice: '15',
          confidence: 0.9,
          probabilities: { '1': 0.02, '12': 0.03, '15': 0.9, none: 0.05 },
        },
        select_target: {
          type: 'choice',
          choice: '1',
          confidence: 0.85,
          probabilities: { '1': 0.85, '12': 0.05, '15': 0.05, none: 0.05 },
        },
        goal_done: { type: 'noul', noul: 0.05 },
        stuck: { type: 'noul', noul: 0.1 },
        destructive: { type: 'noul', noul: 0.02 },
        ...overrides,
      };
    };

    test('8. Jev happy path: click action records step, jevSuggestion, and usage (§5.6, §6)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      let queryCount = 0;
      (engine as any).jevClient.query = async () => {
        queryCount++;
        if (queryCount === 1) {
          return {
            result: {
              model: 'jev-latest',
              answers: createMockJevAnswers(),
              usage: { input_tokens: 350, output_tokens: 25 },
            },
            errorReason: null,
          };
        }
        return {
          result: {
            model: 'jev-latest',
            answers: createMockJevAnswers({ goal_done: { type: 'noul', noul: 0.95 } }),
            usage: { input_tokens: 320, output_tokens: 10 },
          },
          errorReason: null,
        };
      };

      const result = await engine.run({ goal: '点击登录' }, createMockInternalCaller());

      expect(result.status).toBe('done');
      expect(result.engine).toBe('jev');
      expect(result.engineSwitched).toBe(false);
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].action).toBe('click');
      expect(result.steps[0].jevSuggestion).toBeDefined();
      expect(result.steps[0].jevSuggestion?.target).toBe('12');
      expect(result.jevUsage).toBeDefined();
      expect(result.jevUsage?.calls).toBe(2);
      expect(result.jevUsage?.inputTokens).toBe(670);
    });

    test('9. Degradation: 401 Unauthorized causes mid-loop switch to heuristic & latches key (§4.2)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      resetInvalidKeyLatch();
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return { result: null, errorReason: 'invalid_key' };
      };

      const result = await engine.run({ goal: '点击登录' }, createMockInternalCaller());

      expect(result.engine).toBe('heuristic');
      expect(result.engineSwitched).toBe(true);
      expect(result.fallbackReason).toBe('invalid_key');
      expect(isSessionKeyInvalid()).toBe(true);

      // Subsequent run should immediately start in heuristic mode
      const result2 = await engine.run({ goal: '点击登录' }, createMockInternalCaller());
      expect(result2.engine).toBe('heuristic');
      expect(result2.engineSwitched).toBe(false);
      expect(result2.fallbackReason).toBe('invalid_key');
    });

    test('10. Degradation: 429 quota exhaustion switches to heuristic mid-loop without latching (§4.2)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      resetInvalidKeyLatch();
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return { result: null, errorReason: 'quota_exhausted' };
      };

      const result = await engine.run({ goal: '点击登录' }, createMockInternalCaller());

      expect(result.engine).toBe('heuristic');
      expect(result.engineSwitched).toBe(true);
      expect(result.fallbackReason).toBe('quota_exhausted');
      expect(isSessionKeyInvalid()).toBe(false);
    });

    test('11. Degradation: Network error switches to heuristic mid-loop (§4.2)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      resetInvalidKeyLatch();
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return { result: null, errorReason: 'network_error' };
      };

      const result = await engine.run({ goal: '点击登录' }, createMockInternalCaller());

      expect(result.engine).toBe('heuristic');
      expect(result.engineSwitched).toBe(true);
      expect(result.fallbackReason).toBe('network_error');
    });

    const typeActionAnswers = (submitChoice: string) =>
      createMockJevAnswers({
        action: {
          type: 'choice',
          choice: 'type',
          confidence: 0.92,
          probabilities: {
            click: 0.02,
            type: 0.92,
            select: 0.01,
            scroll_down: 0.01,
            scroll_up: 0.0,
            back: 0.0,
            wait: 0.01,
            done: 0.03,
            escalate: 0.0,
          },
        },
        submit_intent: {
          type: 'choice',
          choice: submitChoice,
          confidence: 0.9,
          // Full distribution over the three choices so validateChoice accepts it.
          probabilities: { fill_only: 0.05, submit: 0.05, unclear: 0.05, [submitChoice]: 0.9 },
        },
      });

    test.each([
      ['fill_only', false],
      ['submit', true],
    ])(
      'P1: submit_intent "%s" decides pressEnter regardless of goal keywords',
      async (submitChoice, expectedPressEnter) => {
        process.env.TYPESAFE_API_KEY = 'test_key';
        const engine = new FastDecisionEngine();
        const fillArgs: any[] = [];

        (engine as any).jevClient.query = async () => ({
          result: {
            answers: typeActionAnswers(submitChoice as string),
            usage: { input_tokens: 100, output_tokens: 10 },
          },
          errorReason: null,
        });

        // The goal deliberately contains "search": the old keyword rule would have submitted
        // even though the task only asked to fill the box.
        const caller = async (toolName: string, args: any) => {
          if (toolName === 'chrome_fill_index') {
            fillArgs.push(args);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
          }
          return createMockInternalCaller()(toolName, args);
        };

        await engine.run({ goal: '在搜索框中输入 BrowserPaw', maxSteps: 1 }, caller);

        expect(fillArgs).toHaveLength(1);
        expect(fillArgs[0].pressEnter).toBe(expectedPressEnter);
      },
    );

    test('P1: an unclear submit intent pauses instead of guessing', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      let fillCalled = false;

      (engine as any).jevClient.query = async () => ({
        result: {
          answers: typeActionAnswers('unclear'),
          usage: { input_tokens: 100, output_tokens: 10 },
        },
        errorReason: null,
      });

      const caller = async (toolName: string, args: any) => {
        if (toolName === 'chrome_fill_index') fillCalled = true;
        return createMockInternalCaller()(toolName, args);
      };

      const result = await engine.run({ goal: '在搜索框中输入 BrowserPaw', maxSteps: 1 }, caller);

      expect(result.status).toBe('paused');
      expect(result.reason).toContain('Submit intent unclear');
      expect(fillCalled).toBe(false);
      expect(result.pausedBeforeAction?.matchedKeyword).toBe('unclear_submit_intent');
    });

    test('P1: a malformed submit intent escalates rather than submitting', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      let fillCalled = false;

      (engine as any).jevClient.query = async () => ({
        result: {
          answers: createMockJevAnswers({
            action: {
              type: 'choice',
              choice: 'type',
              confidence: 0.92,
              probabilities: {
                click: 0.02,
                type: 0.92,
                select: 0.01,
                scroll_down: 0.01,
                scroll_up: 0.0,
                back: 0.0,
                wait: 0.01,
                done: 0.03,
                escalate: 0.0,
              },
            },
            submit_intent: {
              type: 'choice',
              choice: 'submit_now',
              confidence: 0.9,
              probabilities: {},
            },
          }),
          errorReason: null,
        },
      });

      const caller = async (toolName: string, args: any) => {
        if (toolName === 'chrome_fill_index') fillCalled = true;
        return createMockInternalCaller()(toolName, args);
      };

      const result = await engine.run({ goal: '在搜索框中输入 BrowserPaw', maxSteps: 1 }, caller);

      expect(result.status).toBe('escalate');
      expect(result.reason).toContain('submit intent choice validation failed');
      expect(fillCalled).toBe(false);
    });

    test('P1: an explicit pressEnter parameter still overrides the judged intent', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      const fillArgs: any[] = [];

      (engine as any).jevClient.query = async () => ({
        result: {
          answers: typeActionAnswers('fill_only'),
          usage: { input_tokens: 100, output_tokens: 10 },
        },
        errorReason: null,
      });

      const caller = async (toolName: string, args: any) => {
        if (toolName === 'chrome_fill_index') {
          fillArgs.push(args);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        }
        return createMockInternalCaller()(toolName, args);
      };

      await engine.run(
        { goal: '在搜索框中输入 BrowserPaw', maxSteps: 1, pressEnter: true },
        caller,
      );

      expect(fillArgs).toHaveLength(1);
      expect(fillArgs[0].pressEnter).toBe(true);
    });

    test.each([
      { pressEnter: true, shape: 'missing', submitIntent: undefined },
      { pressEnter: false, shape: 'missing', submitIntent: undefined },
      {
        pressEnter: true,
        shape: 'malformed',
        submitIntent: { type: 'choice', choice: 'submit_now', confidence: 0.9, probabilities: {} },
      },
      {
        pressEnter: false,
        shape: 'malformed',
        submitIntent: { type: 'choice', choice: 'submit_now', confidence: 0.9, probabilities: {} },
      },
      {
        pressEnter: true,
        shape: 'unclear',
        submitIntent: {
          type: 'choice',
          choice: 'unclear',
          confidence: 0.9,
          probabilities: { fill_only: 0.05, submit: 0.05, unclear: 0.9 },
        },
      },
      {
        pressEnter: false,
        shape: 'unclear',
        submitIntent: {
          type: 'choice',
          choice: 'unclear',
          confidence: 0.9,
          probabilities: { fill_only: 0.05, submit: 0.05, unclear: 0.9 },
        },
      },
    ])(
      'P1: explicit pressEnter=$pressEnter bypasses a $shape submit intent',
      async ({ pressEnter, submitIntent }) => {
        process.env.TYPESAFE_API_KEY = 'test_key';
        const engine = new FastDecisionEngine();
        const fillArgs: any[] = [];

        const answers: any = typeActionAnswers('submit');
        if (submitIntent === undefined) delete answers.submit_intent;
        else answers.submit_intent = submitIntent;

        (engine as any).jevClient.query = async () => ({
          result: { answers, usage: { input_tokens: 100, output_tokens: 10 } },
          errorReason: null,
        });

        const caller = async (toolName: string, args: any) => {
          if (toolName === 'chrome_fill_index') {
            fillArgs.push(args);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
          }
          return createMockInternalCaller()(toolName, args);
        };

        const result = await engine.run(
          { goal: '在搜索框中输入 BrowserPaw', maxSteps: 1, pressEnter },
          caller,
        );

        expect(result.status).toBe('max_steps');
        expect(fillArgs).toHaveLength(1);
        expect(fillArgs[0].pressEnter).toBe(pressEnter);
      },
    );

    test('P1: a valid confident submit intent still presses Enter without an override', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      const fillArgs: any[] = [];

      (engine as any).jevClient.query = async () => ({
        result: {
          answers: typeActionAnswers('submit'),
          usage: { input_tokens: 100, output_tokens: 10 },
        },
        errorReason: null,
      });

      const caller = async (toolName: string, args: any) => {
        if (toolName === 'chrome_fill_index') {
          fillArgs.push(args);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        }
        return createMockInternalCaller()(toolName, args);
      };

      await engine.run({ goal: '在搜索框中输入 BrowserPaw', maxSteps: 1 }, caller);

      expect(fillArgs).toHaveLength(1);
      expect(fillArgs[0].pressEnter).toBe(true);
    });

    test.each([
      {
        shape: 'a low-confidence submit judgment (0.40 < 0.45)',
        confidence: 0.4,
        probabilities: { fill_only: 0.05, submit: 0.85, unclear: 0.1 },
      },
      {
        shape: 'a selected probability below the target guard (0.34 < 0.35)',
        confidence: 0.9,
        probabilities: { fill_only: 0.33, submit: 0.34, unclear: 0.33 },
      },
    ])(
      'P1: $shape escalates without pressing Enter when pressEnter is absent',
      async (caseData) => {
        process.env.TYPESAFE_API_KEY = 'test_key';
        const engine = new FastDecisionEngine();
        let fillCalled = false;

        const answers: any = typeActionAnswers('submit');
        answers.submit_intent = {
          type: 'choice',
          choice: 'submit',
          confidence: caseData.confidence,
          probabilities: caseData.probabilities,
        };

        (engine as any).jevClient.query = async () => ({
          result: { answers, usage: { input_tokens: 100, output_tokens: 10 } },
          errorReason: null,
        });

        const caller = async (toolName: string, args: any) => {
          if (toolName === 'chrome_fill_index') fillCalled = true;
          return createMockInternalCaller()(toolName, args);
        };

        const result = await engine.run({ goal: '在搜索框中输入 BrowserPaw', maxSteps: 1 }, caller);

        expect(result.status).toBe('escalate');
        expect(result.reason).toContain('Submit intent');
        expect(fillCalled).toBe(false);
      },
    );

    test.each([
      ['a distribution that does not sum to 1', { fill_only: 0.4, submit: 0.6, unclear: 0.4 }],
      ['a missing choice key', { fill_only: 0.5, submit: 0.5 }],
      [
        'a chosen probability that is not the maximum',
        { fill_only: 0.7, submit: 0.2, unclear: 0.1 },
      ],
    ])('P1: submit_intent with %s escalates as invalid', async (_shape, probabilities) => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      let fillCalled = false;

      const answers: any = typeActionAnswers('submit');
      answers.submit_intent = {
        type: 'choice',
        choice: 'submit',
        confidence: 0.9,
        probabilities,
      };

      (engine as any).jevClient.query = async () => ({
        result: { answers, usage: { input_tokens: 100, output_tokens: 10 } },
        errorReason: null,
      });

      const caller = async (toolName: string, args: any) => {
        if (toolName === 'chrome_fill_index') fillCalled = true;
        return createMockInternalCaller()(toolName, args);
      };

      const result = await engine.run({ goal: '在搜索框中输入 BrowserPaw', maxSteps: 1 }, caller);

      expect(result.status).toBe('escalate');
      expect(result.reason).toContain('submit intent choice validation failed');
      expect(fillCalled).toBe(false);
    });

    test.each([
      ['missing', undefined],
      ['NaN', NaN],
      ['above 1', 1.5],
      ['below 0', -0.1],
      ['a string', '0.9'],
    ])('P1: submit_intent with %s confidence escalates as invalid', async (_shape, confidence) => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      let fillCalled = false;

      const answers: any = typeActionAnswers('submit');
      answers.submit_intent.confidence = confidence;

      (engine as any).jevClient.query = async () => ({
        result: { answers, usage: { input_tokens: 100, output_tokens: 10 } },
        errorReason: null,
      });

      const caller = async (toolName: string, args: any) => {
        if (toolName === 'chrome_fill_index') fillCalled = true;
        return createMockInternalCaller()(toolName, args);
      };

      const result = await engine.run({ goal: '在搜索框中输入 BrowserPaw', maxSteps: 1 }, caller);

      expect(result.status).toBe('escalate');
      expect(result.reason).toContain('submit intent confidence validation failed');
      expect(fillCalled).toBe(false);
    });

    test('12. Guard: escalates when action confidence < 0.55 threshold (§5.3)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return {
          result: {
            answers: createMockJevAnswers({
              action: {
                type: 'choice',
                choice: 'click',
                confidence: 0.48, // < 0.55
                probabilities: {
                  click: 0.48,
                  wait: 0.42,
                  done: 0.1,
                  type: 0.0,
                  select: 0.0,
                  scroll_down: 0.0,
                  scroll_up: 0.0,
                  back: 0.0,
                  escalate: 0.0,
                },
              },
            }),
          },
          errorReason: null,
        };
      };

      const result = await engine.run({ goal: '点击' }, createMockInternalCaller());
      expect(result.status).toBe('escalate');
      expect(result.reason).toMatch(/Action confidence 0.48 < threshold 0.55/);
    });

    test('13. Guard: escalates when target choice is none (§5.3)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return {
          result: {
            answers: createMockJevAnswers({
              click_target: {
                type: 'choice',
                choice: 'none',
                confidence: 0.9,
                probabilities: { '1': 0.05, '12': 0.03, '15': 0.02, none: 0.9 },
              },
            }),
          },
          errorReason: null,
        };
      };

      const result = await engine.run({ goal: '点击' }, createMockInternalCaller());
      expect(result.status).toBe('escalate');
      expect(result.reason).toMatch(/Target element resolved to "none"/);
    });

    test('14. Guard: escalates when target confidence < 0.45 or topProb < 0.35 (§5.3)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return {
          result: {
            answers: createMockJevAnswers({
              click_target: {
                type: 'choice',
                choice: '12',
                confidence: 0.4, // < 0.45
                probabilities: { '1': 0.3, '12': 0.34, '15': 0.3, none: 0.06 },
              },
            }),
          },
          errorReason: null,
        };
      };

      const result = await engine.run({ goal: '点击' }, createMockInternalCaller());
      expect(result.status).toBe('escalate');
      expect(result.reason).toMatch(/Target confidence ambiguous/);
    });

    test('15. Guard: escalates when Jev destructive noul >= 0.50 (§5.3)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return {
          result: {
            answers: createMockJevAnswers({
              destructive: { type: 'noul', noul: 0.75 },
            }),
          },
          errorReason: null,
        };
      };

      const result = await engine.run({ goal: '点击' }, createMockInternalCaller());
      expect(result.status).toBe('escalate');
      expect(result.reason).toMatch(/Destructive action detected/);
    });

    test('16. Two-stage select in Jev mode with Score accumulation (§2.3, §5.2)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return {
          result: {
            answers: createMockJevAnswers({
              action: {
                type: 'choice',
                choice: 'select',
                confidence: 0.9,
                probabilities: {
                  select: 0.9,
                  click: 0.05,
                  wait: 0.05,
                  type: 0.0,
                  scroll_down: 0.0,
                  scroll_up: 0.0,
                  back: 0.0,
                  done: 0.0,
                  escalate: 0.0,
                },
              },
              click_target: {
                type: 'choice',
                choice: '1',
                confidence: 0.85,
                probabilities: { '1': 0.85, '12': 0.1, none: 0.05 },
              },
              type_target: {
                type: 'choice',
                choice: '1',
                confidence: 0.85,
                probabilities: { '1': 0.85, '12': 0.1, none: 0.05 },
              },
              select_target: {
                type: 'choice',
                choice: '1',
                confidence: 0.85,
                probabilities: { '1': 0.85, '12': 0.1, none: 0.05 },
              },
            }),
            usage: { input_tokens: 400, output_tokens: 20 },
          },
          errorReason: null,
        };
      };

      (engine as any).jevClient.scoreOptions = async () => {
        return {
          bestIndex: 1,
          bestOption: { text: 'Option B', value: 'opt_b' },
          confidence: 0.92,
          score: 1,
          usage: { inputTokens: 250 },
        };
      };

      const caller = createMockInternalCaller({
        treeString: '[1] combobox "选择类型"\n[12] button "提交"',
      });

      const result = await engine.run({ goal: '选择 Option B', maxSteps: 1 }, caller);

      expect(result.steps.length).toBe(1);
      expect(result.steps[0].action).toBe('select');
      expect(result.jevUsage?.calls).toBe(2); // 1 main query + 1 scoreOptions
      expect(result.jevUsage?.inputTokens).toBe(650); // 400 + 250
    });

    test('19. Properly surfaces tool execution error in step outcome rather than masking as mutated:false', async () => {
      delete process.env.TYPESAFE_API_KEY;
      const engine = new FastDecisionEngine();

      const errorCaller = async (toolName: string, _args: any) => {
        if (toolName === 'chrome_read_dom') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  tabUrl: 'https://example.com',
                  tabTitle: 'Error Page',
                  treeString: '[12] button "点击我"',
                }),
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Node with index 12 is detached from document',
            },
          ],
        };
      };

      const result = await engine.run({ goal: '点击我', maxSteps: 1 }, errorCaller);
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].outcome).toContain(
        'error:Node with index 12 is detached from document',
      );
    });

    test('20. Properly surfaces success: false with reason field as error:reason', async () => {
      delete process.env.TYPESAFE_API_KEY;
      const engine = new FastDecisionEngine();

      const reasonCaller = async (toolName: string, _args: any) => {
        if (toolName === 'chrome_read_dom') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  tabUrl: 'https://example.com',
                  tabTitle: 'Error Page',
                  treeString: '[12] button "点击我"',
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                reason: 'Element no longer in DOM',
              }),
            },
          ],
        };
      };

      const result = await engine.run({ goal: '点击我', maxSteps: 1 }, reasonCaller);
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].outcome).toContain('error:Element no longer in DOM');
    });

    test('21. Unwraps nested JSON error string inside isError response', async () => {
      delete process.env.TYPESAFE_API_KEY;
      const engine = new FastDecisionEngine();

      const jsonErrorCaller = async (toolName: string, _args: any) => {
        if (toolName === 'chrome_read_dom') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  tabUrl: 'https://example.com',
                  tabTitle: 'Error Page',
                  treeString: '[12] button "点击我"',
                }),
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'CDP execution error (click): Target node invisible',
              }),
            },
          ],
        };
      };

      const result = await engine.run({ goal: '点击我', maxSteps: 1 }, jsonErrorCaller);
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].outcome).toContain(
        'error:CDP execution error (click): Target node invisible',
      );
    });

    test('22. Triggers stuck status when JEV answers stuck noul >= 0.85', async () => {
      process.env.TYPESAFE_API_KEY = 'test-key-mock';
      const engine = new FastDecisionEngine('test-key-mock');

      (engine as any).jevClient.query = async () => {
        return {
          result: {
            answers: {
              stuck: { type: 'noul', noul: 0.95 },
              goal_done: { type: 'noul', noul: 0.1 },
              destructive: { type: 'noul', noul: 0.0 },
              action: {
                type: 'choice',
                choice: 'click',
                confidence: 0.9,
                probabilities: { click: 0.9, none: 0.1 },
              },
            },
            usage: { input_tokens: 300 },
          },
          errorReason: null,
        };
      };

      const caller = createMockInternalCaller({
        treeString: '[12] button "重试"',
      });

      const result = await engine.run({ goal: '重试操作', maxSteps: 3 }, caller);
      expect(result.status).toBe('stuck');
      expect(result.reason).toContain('Jev detected execution loop');
    });

    test('23. findMatchingPauseKeyword matches case-insensitively and handles boundary cases', () => {
      expect(findMatchingPauseKeyword('click [12] button "Post"', ['Post', 'Submit'])).toBe('Post');
      expect(findMatchingPauseKeyword('click [5] button "Submit form"', ['submit', 'pay'])).toBe(
        'submit',
      );
      expect(findMatchingPauseKeyword('[1] button "确认提交"', ['确认提交', 'Pay'])).toBe(
        '确认提交',
      );
      // Word boundary prevents false positive substring matching
      expect(findMatchingPauseKeyword('type [2] textbox "postal_code"', ['Post'])).toBeNull();
      expect(findMatchingPauseKeyword('type [3] textbox "deposit amount"', ['Post'])).toBeNull();
      expect(findMatchingPauseKeyword('click [4] link "compost bin"', ['Post'])).toBeNull();
      expect(findMatchingPauseKeyword('click [1] button "Cancel"', ['Post', 'Submit'])).toBeNull();
      expect(findMatchingPauseKeyword('', ['Post'])).toBeNull();
      expect(findMatchingPauseKeyword('click [1] button "Post"', [])).toBeNull();
      expect(findMatchingPauseKeyword('click [1] button "Post"', undefined)).toBeNull();
    });

    test('24. Safety Breakpoint: halts with status paused before executing action matching pauseBeforeKeywords', async () => {
      delete process.env.TYPESAFE_API_KEY;
      const engine = new FastDecisionEngine();

      let actionExecuted = false;
      const caller = async (toolName: string, args: any): Promise<any> => {
        if (toolName === 'chrome_read_dom') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  tabUrl: 'https://reddit.com/r/test',
                  tabTitle: 'Reddit Test',
                  treeString: '[1] textbox "Title"\n[2] textbox "Body"\n[3] button "Post"',
                }),
              },
            ],
          };
        }
        if (toolName === 'chrome_interact_index') {
          actionExecuted = true;
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      };

      const result = await engine.run(
        {
          goal: '点击 Post 按钮发布帖子',
          pauseBeforeKeywords: ['Post', 'Submit'],
          maxSteps: 3,
        },
        caller,
      );

      expect(result.status).toBe('paused');
      expect(actionExecuted).toBe(false);
      expect(result.pausedBeforeAction).toBeDefined();
      expect(result.pausedBeforeAction?.action).toBe('click');
      expect(result.pausedBeforeAction?.matchedKeyword).toBe('Post');
      expect(result.pausedBeforeAction?.target).toContain('[3]');
      expect(result.currentElements?.length).toBeGreaterThan(0);
    });

    test('25. Safety Breakpoint: proceeds without pausing when action does not match pauseBeforeKeywords', async () => {
      delete process.env.TYPESAFE_API_KEY;
      const engine = new FastDecisionEngine();

      let clickedTarget: any = null;
      const caller = async (toolName: string, args: any): Promise<any> => {
        if (toolName === 'chrome_read_dom') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  tabUrl: 'https://example.com/wizard',
                  tabTitle: 'Wizard',
                  treeString: '[1] button "下一步"\n[2] button "确认提交"',
                }),
              },
            ],
          };
        }
        if (toolName === 'chrome_interact_index') {
          clickedTarget = args.index;
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, mutated: true }) }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      };

      const result = await engine.run(
        {
          goal: '点击下一步',
          pauseBeforeKeywords: ['确认提交', 'Pay'],
          maxSteps: 1,
        },
        caller,
      );

      // Should have clicked 下一步 without triggering the breakpoint for 确认提交
      expect(clickedTarget).toBe(1);
      expect(result.status).not.toBe('paused');
    });

    test('26. Parallel speculative decision protocol: populates speculativeTargets for click, type, and select in one RTT (§B10)', async () => {
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      (engine as any).jevClient.query = async () => {
        return {
          result: {
            model: 'jev-latest',
            answers: createMockJevAnswers({
              click_target: {
                type: 'choice',
                choice: '12',
                confidence: 0.95,
                probabilities: { '1': 0.02, '12': 0.95, '15': 0.03, none: 0.0 },
              },
              type_target: {
                type: 'choice',
                choice: '15',
                confidence: 0.9,
                probabilities: { '1': 0.05, '12': 0.05, '15': 0.9, none: 0.0 },
              },
              select_target: {
                type: 'choice',
                choice: '1',
                confidence: 0.88,
                probabilities: { '1': 0.88, '12': 0.06, '15': 0.06, none: 0.0 },
              },
            }),
            usage: { input_tokens: 300, output_tokens: 20 },
          },
          errorReason: null,
        };
      };

      const result = await engine.run(
        { goal: '点击登录按钮', maxSteps: 1 },
        createMockInternalCaller(),
      );

      expect(result.steps.length).toBe(1);
      const step = result.steps[0];
      expect(step.jevSuggestion).toBeDefined();
      expect(step.jevSuggestion?.action).toBe('click');
      expect(step.jevSuggestion?.target).toBe('12');
      expect(step.jevSuggestion?.speculativeTargets).toEqual({
        click: '12',
        type: '15',
        select: '1',
      });
    });
  });

  describe('3-Tier Seamless Routing Architecture (§1.1, §4.3)', () => {
    test('Mode "off" immediately runs heuristic mode with jev_disabled fallbackReason', async () => {
      jevModelManager.setActiveMode('off');
      process.env.TYPESAFE_API_KEY = 'valid-key-mock';
      const engine = new FastDecisionEngine();

      const result = await engine.run(
        { goal: '点击登录按钮', maxSteps: 3 },
        createMockInternalCaller(),
      );

      expect(result.engine).toBe('heuristic');
      expect(result.fallbackReason).toBe('jev_disabled');
      expect(result.engineSwitched).toBe(false);
      expect(result.steps.length).toBeGreaterThan(0);
    });

    test('Mode "local" routes to local decider and falls back gracefully if service is offline', async () => {
      jevModelManager.setActiveMode('local');
      delete process.env.TYPESAFE_API_KEY; // Local requires no cloud API key
      const engine = new FastDecisionEngine();

      // Simulate port 8009 offline in test environment
      const onlineSpy = jest
        .spyOn(jevModelManager, 'isLocalServiceOnline')
        .mockResolvedValue(false);
      const querySpy = jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
        result: null,
        errorReason: 'local_service_offline',
      });

      const result = await engine.run(
        { goal: '点击登录按钮', maxSteps: 3 },
        createMockInternalCaller(),
      );

      onlineSpy.mockRestore();
      querySpy.mockRestore();

      // Falls back to heuristic without crashing
      expect(result.engine).toBe('heuristic');
      expect(result.fallbackReason).toBe('local_service_offline');
      expect(result.engineSwitched).toBe(true);
      expect(result.steps.length).toBeGreaterThan(0);
    });

    test('Mode "remote" respects cloud API key configuration', async () => {
      jevModelManager.setActiveMode('remote');
      delete process.env.TYPESAFE_API_KEY;
      const engine = new FastDecisionEngine();

      const result = await engine.run(
        { goal: '点击登录按钮', maxSteps: 3 },
        createMockInternalCaller(),
      );

      expect(result.engine).toBe('heuristic');
      expect(result.fallbackReason).toBe('no_api_key');
    });
  });

  describe('14. Jev Vision Fallback & Safety Regression Tests', () => {
    /**
     * The visual fallback first asks upstream which release answers here and declines unless it
     * can do `box`. These tests exercise the safety logic after that gate, so they declare the
     * endpoint capable; the gate itself is covered by the jev-client and test-3 suites.
     */
    const boxCapable = (engine: FastDecisionEngine) =>
      jest
        .spyOn((engine as any).jevClient, 'resolveBoxCapableModel')
        .mockResolvedValue('jev-1.14.0');

    const fakeScreenshotResponse = {
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: Buffer.from('fake_image_bytes').toString('base64'),
        },
        {
          type: 'text',
          text: JSON.stringify({
            visionFrame: { id: 'frame_test_999', width: 1000, height: 800 },
          }),
        },
      ],
    };

    const createMockVisionJevAnswers = (overrides?: any) => {
      return {
        action: {
          type: 'choice',
          choice: 'click',
          confidence: 0.92,
          probabilities: {
            click: 0.92,
            type: 0.04,
            select: 0.01,
            scroll_down: 0.01,
            scroll_up: 0.0,
            back: 0.0,
            wait: 0.0,
            done: 0.02,
            escalate: 0.0,
          },
        },
        click_target: {
          type: 'choice',
          choice: 'none',
          confidence: 0.9,
          probabilities: { '1': 0.1, none: 0.9 },
        },
        type_target: {
          type: 'choice',
          choice: 'none',
          confidence: 0.9,
          probabilities: { '1': 0.1, none: 0.9 },
        },
        select_target: {
          type: 'choice',
          choice: 'none',
          confidence: 0.9,
          probabilities: { '1': 0.1, none: 0.9 },
        },
        goal_done: { type: 'noul', noul: 0.05 },
        stuck: { type: 'noul', noul: 0.02 },
        destructive: { type: 'noul', noul: 0.01 },
        ...overrides,
      };
    };

    const visionHarness = () => {
      jevModelManager.setActiveMode('remote');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      const engine = new FastDecisionEngine();
      // Upstream reports a release that can answer `box`; the gate itself is covered by the
      // jev-client suite, so here it stands in as an available capability.
      jest
        .spyOn((engine as any).jevClient, 'resolveBoxCapableModel')
        .mockResolvedValue('jev-1.14.0');
      jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
        result: { answers: createMockVisionJevAnswers() },
        errorReason: null,
      });
      const caller = jest.fn(async (tool: string, _args?: any) => {
        if (tool === 'chrome_screenshot') return fakeScreenshotResponse;
        if (tool === 'chrome_read_dom') {
          return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      });
      const vision = {
        exists: true,
        ambiguous: false,
        destructive: false,
        box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 },
        confidence: 0.9 as number | null,
      };
      const query = jest
        .spyOn((engine as any).jevClient, 'queryVision')
        .mockResolvedValue({ result: vision, errorReason: null });
      return { engine, caller, vision, query };
    };

    test.each([
      { isError: true, content: [{ type: 'text', text: '{"error":"DOM unavailable"}' }] },
      { content: [{ type: 'text', text: '{"success":false,"error":"DOM unavailable"}' }] },
    ])('does not treat a DOM tool error as an empty page: %j', async (response) => {
      const { engine, caller, query } = visionHarness();
      const result = await engine.run({ goal: 'click bell icon', maxSteps: 1 }, (tool, args) =>
        tool === 'chrome_read_dom' ? Promise.resolve(response) : caller(tool, args),
      );
      expect(result.status).toBe('blocked');
      expect(query).not.toHaveBeenCalled();
      expect(caller).not.toHaveBeenCalled();
    });

    test.each([null, NaN, Infinity, -1, 0, 0.59, 1.1])(
      'rejects unsafe localization confidence %s with zero interaction calls',
      async (confidence) => {
        const { engine, caller, vision } = visionHarness();
        vision.confidence = confidence;
        const result = await engine.run({ goal: 'click bell icon', maxSteps: 1 }, caller);
        expect(result.status).toBe('escalate');
        expect(result.reason).toContain('confidence');
        expect(caller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(false);
      },
    );

    test.each([
      'Type BrowserPaw into search',
      'select the blue option',
      'click settings then click save',
      'click settings and click save',
      '点击设置并点击保存',
      '点击设置随后点击保存',
    ])('does not capture or click for unsupported goal %s', async (goal) => {
      const { engine, caller, query } = visionHarness();
      await engine.run({ goal, maxSteps: 1, textHint: 'bell icon' }, caller);
      expect(query).not.toHaveBeenCalled();
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(false);
    });

    test('rejects a vision response arriving after the deadline and caps the request to remaining time', async () => {
      const { engine, caller, vision, query } = visionHarness();
      let now = 10000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      query.mockImplementation(async (...args: any[]) => {
        expect(args[3].timeout).toBe(100);
        expect(args[3].signal).toBeInstanceOf(AbortSignal);
        now += 101;
        return { result: vision, errorReason: null };
      });
      try {
        const result = await engine.run(
          { goal: 'click bell icon', maxSteps: 1, timeoutMs: 100 },
          caller,
        );
        expect(result.status).toBe('timeout');
        expect(result.jevUsage?.visionCalls).toBe(1);
        expect(result.jevUsage?.calls).toBe(1);
        expect(caller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(false);
      } finally {
        clock.mockRestore();
      }
    });

    test('revoked consent prevents click even after a valid cloud answer', async () => {
      const { engine, caller, vision, query } = visionHarness();
      query.mockImplementation(async () => {
        // Mode is revoked while the vision request is in flight; the post-capture re-check
        // must still refuse to dispatch the click.
        jevModelManager.setActiveMode('off');
        return { result: vision, errorReason: null };
      });
      const result = await engine.run({ goal: 'click bell icon', maxSteps: 1 }, caller);
      expect(result.reason).toContain('revoked');
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(false);
    });

    test('a late text answer cannot trigger heuristic or visual actions', async () => {
      const { engine, caller, query } = visionHarness();
      let now = 10000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      jest.spyOn((engine as any).jevClient, 'query').mockImplementation(async () => {
        now += 101;
        return { result: null, errorReason: 'network_error' };
      });
      try {
        const result = await engine.run(
          { goal: 'click bell icon', maxSteps: 2, timeoutMs: 100 },
          (tool, args) =>
            tool === 'chrome_read_dom'
              ? Promise.resolve({
                  content: [{ type: 'text', text: '{"treeString":"[1] button Bell"}' }],
                })
              : caller(tool, args),
        );
        expect(result.status).toBe('timeout');
        expect(result.steps).toHaveLength(0);
        expect(query).not.toHaveBeenCalled();
        expect(caller).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    });

    test('fractional timeout budgets produce valid integer AbortSignal deadlines', async () => {
      const { engine, caller, query } = visionHarness();
      await engine.run({ goal: 'click bell icon', maxSteps: 1, timeoutMs: 1000.5 }, caller);
      const options = query.mock.calls[0][3] as { timeout: number };
      expect(Number.isInteger(options.timeout)).toBe(true);
      expect(options.timeout).toBeLessThanOrEqual(1000);
    });

    test('the capability probe receives a deadline-bounded AbortSignal and remaining budget', async () => {
      const { engine, caller } = visionHarness();
      const probe = (engine as any).jevClient.resolveBoxCapableModel as jest.Mock;
      await engine.run({ goal: 'click bell icon', maxSteps: 1, timeoutMs: 2000 }, caller);

      expect(probe).toHaveBeenCalledTimes(1);
      const [signal, timeout] = probe.mock.calls[0];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(2000);
    });

    test.each([null, 'jev-1.14.0'])(
      'a capability probe that runs past the deadline returns timeout with no capture or action (model: %s)',
      async (model) => {
        const { engine, caller } = visionHarness();
        const probe = (engine as any).jevClient.resolveBoxCapableModel as jest.Mock;
        let now = 10000;
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        probe.mockImplementation(async () => {
          now += 101; // the probe answers only after the 100ms budget is gone
          return model;
        });

        try {
          const result = await engine.run(
            { goal: 'click bell icon', maxSteps: 2, timeoutMs: 100 },
            caller,
          );

          expect(result.status).toBe('timeout');
          expect(result.reason).toContain('vision capability probe');
          expect(result.steps).toHaveLength(0);
          // Only the DOM read may run: no frame is captured and no other action executes.
          expect(caller.mock.calls.map(([tool]) => tool)).toEqual(['chrome_read_dom']);
        } finally {
          clock.mockRestore();
        }
      },
    );

    test('forwards a finite dispatch deadline and retains usage on max_steps', async () => {
      const { engine, caller } = visionHarness();
      const result = await engine.run({ goal: 'click bell icon', maxSteps: 1 }, caller);
      const click = caller.mock.calls.find(([tool]) => tool === 'chrome_interact_index');
      expect(Number.isFinite(click?.[1].expectedDeadlineAt)).toBe(true);
      expect(result.status).toBe('max_steps');
      expect(result.jevUsage?.visionCalls).toBe(1);
      expect(result.jevUsage?.calls).toBe(1);
    });

    // Deterministic screenshot-race tests: fake timers plus a caller-controlled deferred,
    // so deadline behavior never depends on real CI timing.
    const deferredScreenshotHarness = () => {
      const { engine, caller, query } = visionHarness();
      let resolveShot!: (value: any) => void;
      let rejectShot!: (reason: any) => void;
      const shot = new Promise((resolve, reject) => {
        resolveShot = resolve;
        rejectShot = reject;
      });
      const racingCaller = jest.fn((tool: string, args?: any) => {
        if (tool === 'chrome_screenshot') return shot;
        return caller(tool, args);
      });
      return { engine, caller, query, racingCaller, resolveShot, rejectShot };
    };

    const flushUntilShotTimer = async () => {
      for (let i = 0; i < 20 && jest.getTimerCount() === 0; i++) {
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(jest.getTimerCount()).toBe(1);
    };

    test('the screenshot deadline fires on budget and the late capture never acts', async () => {
      jest.useFakeTimers();
      try {
        const { engine, query, racingCaller, resolveShot } = deferredScreenshotHarness();
        const runPromise = engine.run(
          { goal: 'click bell icon', maxSteps: 2, timeoutMs: 120 },
          racingCaller,
        );
        await flushUntilShotTimer();
        await jest.advanceTimersByTimeAsync(120);
        const result = await runPromise;

        expect(result.status).toBe('timeout');
        expect(result.reason).toContain('vision screenshot');
        expect(result.steps).toHaveLength(0);
        expect(query).not.toHaveBeenCalled();
        expect(racingCaller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(
          false,
        );

        // The late capture settles with nothing left to act on: no replay, no vision, no click.
        resolveShot(fakeScreenshotResponse);
        await jest.advanceTimersByTimeAsync(0);
        expect(query).not.toHaveBeenCalled();
        expect(
          racingCaller.mock.calls.filter(([tool]) => tool === 'chrome_screenshot'),
        ).toHaveLength(1);
        expect(racingCaller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(
          false,
        );
      } finally {
        jest.useRealTimers();
      }
    });

    test('a late screenshot rejection after the deadline is handled, not unhandled', async () => {
      jest.useFakeTimers();
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { engine, query, racingCaller, rejectShot } = deferredScreenshotHarness();
        const runPromise = engine.run(
          { goal: 'click bell icon', maxSteps: 2, timeoutMs: 120 },
          racingCaller,
        );
        await flushUntilShotTimer();
        await jest.advanceTimersByTimeAsync(120);
        const result = await runPromise;
        expect(result.status).toBe('timeout');

        rejectShot(new Error('late screenshot failure'));
        await jest.advanceTimersByTimeAsync(0);
        jest.useRealTimers();
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
        jest.useRealTimers();
      }
    });

    test('an in-budget capture clears the deadline timer before acting', async () => {
      jest.useFakeTimers();
      try {
        const { engine, query, racingCaller, resolveShot } = deferredScreenshotHarness();
        const runPromise = engine.run(
          { goal: 'click bell icon', maxSteps: 1, timeoutMs: 120 },
          racingCaller,
        );
        await flushUntilShotTimer();
        resolveShot(fakeScreenshotResponse);
        const result = await runPromise;

        expect(jest.getTimerCount()).toBe(0); // deadline timer cleared, not left pending
        expect(query).toHaveBeenCalledTimes(1);
        expect(
          racingCaller.mock.calls.filter(([tool]) => tool === 'chrome_interact_index'),
        ).toHaveLength(1);
        expect(result.status).toBe('max_steps');
      } finally {
        jest.useRealTimers();
      }
    });

    test('a synchronous screenshot throw still clears the deadline timer', async () => {
      jest.useFakeTimers();
      try {
        const { engine, caller } = visionHarness();
        const racingCaller = jest.fn((tool: string, args?: any) => {
          if (tool === 'chrome_screenshot') throw new Error('sync screenshot failure');
          return caller(tool, args);
        });
        const result = await engine.run(
          { goal: 'click bell icon', maxSteps: 1, timeoutMs: 120 },
          racingCaller,
        );

        expect(result.status).toBe('escalate');
        expect(result.reason).toContain('sync screenshot failure');
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    test.each([false, true])(
      'a visual click is not replayed when the next DOM is populated: %s',
      async (populated) => {
        const { engine, caller, query } = visionHarness();
        let reads = 0;
        jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
          result: {
            answers: createMockVisionJevAnswers({
              click_target: {
                type: 'choice',
                choice: '1',
                confidence: 0.9,
                probabilities: { '1': 0.9, none: 0.1 },
              },
            }),
          },
          errorReason: null,
        });
        const result = await engine.run({ goal: 'click bell icon', maxSteps: 5 }, (tool, args) => {
          if (tool === 'chrome_read_dom' && ++reads > 1 && populated) {
            return Promise.resolve({
              content: [{ type: 'text', text: '{"treeString":"[1] button Bell"}' }],
            });
          }
          return caller(tool, args);
        });
        expect(result.status).toBe('escalate');
        expect(query).toHaveBeenCalledTimes(1);
        expect(caller.mock.calls.filter(([tool]) => tool === 'chrome_interact_index')).toHaveLength(
          1,
        );
      },
    );

    test.each(['type', 'select'])(
      'a missing %s target never becomes a coordinate click',
      async (action) => {
        const { engine, caller, query } = visionHarness();
        const answers = createMockVisionJevAnswers();
        answers.action.probabilities[action] = answers.action.probabilities.click;
        answers.action.probabilities.click = action === 'type' ? 0.04 : 0.01;
        answers.action.choice = action;
        jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
          result: { answers },
          errorReason: null,
        });
        const result = await engine.run(
          { goal: 'click blue control', maxSteps: 1 },
          (tool, args) =>
            tool === 'chrome_read_dom'
              ? Promise.resolve({
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        treeString: '[1] textbox "Search"',
                      }),
                    },
                  ],
                })
              : caller(tool, args),
        );
        expect(result.status).toBe('escalate');
        expect(query).not.toHaveBeenCalled();
        expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(false);
      },
    );

    test('caller arguments cannot force vision when upstream serves a pre-1.14 release', async () => {
      const { engine, caller, query } = visionHarness();
      jest.spyOn((engine as any).jevClient, 'resolveBoxCapableModel').mockResolvedValue(null);
      await engine.run(
        { goal: 'click bell icon', visionEnabled: true, maxSteps: 1 } as any,
        caller,
      );
      expect(query).not.toHaveBeenCalled();
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(false);
    });

    test('1. Never captures screenshot or calls vision in off mode', async () => {
      jevModelManager.setActiveMode('off');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      let screenshotCalled = false;
      const caller = async (tool: string, args: any) => {
        if (tool === 'chrome_screenshot') screenshotCalled = true;
        if (tool === 'chrome_read_dom') {
          return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      };

      const result = await engine.run({ goal: 'click cart icon', maxSteps: 2 }, caller);
      expect(screenshotCalled).toBe(false);
      expect(result.engine).toBe('heuristic');
    });

    test('2. Never captures screenshot or calls vision in local mode', async () => {
      jevModelManager.setActiveMode('local');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      const engine = new FastDecisionEngine();

      let screenshotCalled = false;
      const caller = async (tool: string, args: any) => {
        if (tool === 'chrome_screenshot') screenshotCalled = true;
        if (tool === 'chrome_read_dom') {
          return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      };

      jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
        result: {
          answers: createMockVisionJevAnswers(),
        },
        errorReason: null,
      });

      const result = await engine.run({ goal: 'click cart icon', maxSteps: 2 }, caller);
      expect(screenshotCalled).toBe(false);
    });

    test('3. Never captures screenshot or calls vision when upstream serves a pre-1.14 release', async () => {
      jevModelManager.setActiveMode('remote');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();

      let screenshotCalled = false;
      const caller = async (tool: string, args: any) => {
        if (tool === 'chrome_screenshot') screenshotCalled = true;
        if (tool === 'chrome_read_dom') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ treeString: '[1] button "Search"' }),
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      };

      jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
        result: {
          answers: createMockVisionJevAnswers({
            click_target: {
              type: 'choice',
              choice: 'none',
              confidence: 0.9,
              probabilities: { '1': 0.1, none: 0.9 },
            },
          }),
        },
        errorReason: null,
      });
      // The endpoint answers with a release that cannot do `box`, so the fallback must decline
      // without ever capturing a frame.
      jest.spyOn((engine as any).jevClient, 'resolveBoxCapableModel').mockResolvedValue(null);

      const result = await engine.run({ goal: 'click cart icon', maxSteps: 2 }, caller);
      expect(screenshotCalled).toBe(false);
      expect(result.status).toBe('escalate');
      expect(result.reason).toContain('none');
    });

    test('4. Vision fallback safely escalates without clicking when target_exists is below 0.85', async () => {
      jevModelManager.setActiveMode('remote');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      boxCapable(engine);

      let clickIntercepted = false;
      const caller = async (tool: string, args: any) => {
        if (tool === 'chrome_read_dom') {
          return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
        }
        if (tool === 'chrome_screenshot') {
          return fakeScreenshotResponse;
        }
        if (tool === 'chrome_interact_index') {
          clickIntercepted = true;
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      };

      jest.spyOn((engine as any).jevClient, 'queryVision').mockResolvedValue({
        result: {
          exists: false, // Jev Box false-positive defense triggered
          ambiguous: false,
          destructive: false,
          box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 },
          confidence: 0.4,
        },
        errorReason: null,
      });

      const result = await engine.run({ goal: 'click cart icon', maxSteps: 2 }, caller);
      expect(clickIntercepted).toBe(false);
      expect(result.status).toBe('escalate');
      expect(result.reason).toContain('not found or presence below 0.85');
    });

    test('5. Vision fallback safely escalates without clicking when target_ambiguous >= 0.50', async () => {
      jevModelManager.setActiveMode('remote');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      boxCapable(engine);

      let clickIntercepted = false;
      const caller = async (tool: string, args: any) => {
        if (tool === 'chrome_read_dom') {
          return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
        }
        if (tool === 'chrome_screenshot') {
          return fakeScreenshotResponse;
        }
        if (tool === 'chrome_interact_index') {
          clickIntercepted = true;
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      };

      jest.spyOn((engine as any).jevClient, 'queryVision').mockResolvedValue({
        result: {
          exists: true,
          ambiguous: true, // Multiple candidates ambiguity defense
          destructive: false,
          box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 },
          confidence: 0.7,
        },
        errorReason: null,
      });

      const result = await engine.run({ goal: 'click star button', maxSteps: 2 }, caller);
      expect(clickIntercepted).toBe(false);
      expect(result.status).toBe('escalate');
      expect(result.reason).toContain('ambiguous');
    });

    test('6. Vision fallback safely escalates without clicking when box coordinates are invalid', async () => {
      jevModelManager.setActiveMode('remote');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      boxCapable(engine);

      let clickIntercepted = false;
      const caller = async (tool: string, args: any) => {
        if (tool === 'chrome_read_dom') {
          return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
        }
        if (tool === 'chrome_screenshot') {
          return fakeScreenshotResponse;
        }
        if (tool === 'chrome_interact_index') {
          clickIntercepted = true;
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      };

      jest.spyOn((engine as any).jevClient, 'queryVision').mockResolvedValue({
        result: {
          exists: true,
          ambiguous: false,
          destructive: false,
          box: null, // Invalid or missing box
          confidence: 0.7,
        },
        errorReason: null,
      });

      const result = await engine.run({ goal: 'click settings cog', maxSteps: 2 }, caller);
      expect(clickIntercepted).toBe(false);
      expect(result.status).toBe('escalate');
      expect(result.reason).toContain('invalid or out of bounds');
    });

    test('7. Dispatches coordinate click with exact expectedScreenshotId and observes subsequent page state (never blind done)', async () => {
      jevModelManager.setActiveMode('remote');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      boxCapable(engine);

      let capturedInteractArgs: any = null;
      let domCallCount = 0;

      const caller = async (tool: string, args: any) => {
        if (tool === 'chrome_read_dom') {
          domCallCount++;
          if (domCallCount === 1) {
            // First step: empty DOM, triggers vision
            return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
          }
          // Second step: page mutated and goal achieved
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  tabUrl: 'https://example.com/checkout',
                  tabTitle: 'Checkout Success',
                  treeString: '[1] text "Order Complete"',
                }),
              },
            ],
          };
        }
        if (tool === 'chrome_screenshot') {
          return fakeScreenshotResponse;
        }
        if (tool === 'chrome_interact_index') {
          capturedInteractArgs = args;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, mutated: true }),
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      };

      // Step 1: Vision fallback returns valid target
      jest.spyOn((engine as any).jevClient, 'queryVision').mockResolvedValue({
        result: {
          exists: true,
          ambiguous: false,
          destructive: false,
          box: { top: 0.2, bottom: 0.4, left: 0.1, right: 0.5 }, // center: x=300 (0.3*1000), y=240 (0.3*800)
          confidence: 0.95,
          usage: { input_tokens: 350, output_tokens: 15 },
        },
        errorReason: null,
      });

      // Step 2: Text Jev recognizes goal done on the mutated page
      jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
        result: {
          answers: createMockVisionJevAnswers({
            goal_done: { type: 'noul', noul: 0.95 },
          }),
          usage: { input_tokens: 200, output_tokens: 10 },
        },
        errorReason: null,
      });

      const result = await engine.run({ goal: 'click cart icon', maxSteps: 3 }, caller);

      expect(capturedInteractArgs).not.toBeNull();
      expect(capturedInteractArgs.action).toBe('click');
      expect(capturedInteractArgs.coordinateSpace).toBe('screenshot');
      expect(capturedInteractArgs.expectedScreenshotId).toBe('frame_test_999');
      expect(capturedInteractArgs.coordinate).toEqual({ x: 300, y: 240 });

      // Verifies step 1 was executed and followed by observation in step 2 (not instant done)
      expect(domCallCount).toBeGreaterThanOrEqual(2);
      expect(result.status).toBe('done');
      expect(result.steps.length).toBe(1);
      expect(result.steps[0].target).toContain('visual:"cart icon" (300, 240)');
      expect(result.jevUsage?.visionCalls).toBe(1);
      expect(result.jevUsage?.visionModel).toBe('jev-1.14.0');
    });

    test('8. Handles stale frame error without replaying and triggers pauseBeforeKeywords on visual target', async () => {
      jevModelManager.setActiveMode('remote');
      jevModelManager.setRemoteConfig({ apiKey: 'test_key' });
      process.env.TYPESAFE_API_KEY = 'test_key';
      const engine = new FastDecisionEngine();
      boxCapable(engine);

      // Test 8A: Safety pause on visual target matching pauseBeforeKeywords
      const pauseResult = await engine.run(
        {
          goal: 'click "Delete Account" button',
          pauseBeforeKeywords: ['delete', 'pay'],
          maxSteps: 2,
        },
        async (tool: string) => {
          if (tool === 'chrome_read_dom') {
            return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        },
      );

      expect(pauseResult.status).toBe('paused');
      expect(pauseResult.pausedBeforeAction?.matchedKeyword).toBe('delete');

      // Test 8B: Stale frame execution failure is recorded as error and never blindly retried
      jest.spyOn((engine as any).jevClient, 'queryVision').mockResolvedValue({
        result: {
          exists: true,
          ambiguous: false,
          destructive: false,
          box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 },
          confidence: 0.9,
        },
        errorReason: null,
      });

      let interactAttempts = 0;
      const staleResult = await engine.run(
        { goal: 'click download icon', maxSteps: 2 },
        async (tool: string) => {
          if (tool === 'chrome_read_dom') {
            return { content: [{ type: 'text', text: JSON.stringify({ treeString: '' }) }] };
          }
          if (tool === 'chrome_screenshot') {
            return fakeScreenshotResponse;
          }
          if (tool === 'chrome_interact_index') {
            interactAttempts++;
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'Screenshot frame expired (stale)' }),
                },
              ],
            };
          }
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        },
      );

      expect(interactAttempts).toBe(1); // Never retried on stale frame
      expect(staleResult.steps[0].outcome).toContain('error:Screenshot frame expired (stale)');
    });

    test('9. Preserves fast snapshot url and title in finalPage', async () => {
      const { engine, caller } = visionHarness();
      const fastDomResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: 'https://example.com/fast-fixture',
              title: 'Fast DOM Title',
              treeString: '',
            }),
          },
        ],
      };
      const result = await engine.run(
        { goal: 'click settings button', maxSteps: 1 },
        (tool, args) =>
          tool === 'chrome_read_dom' ? Promise.resolve(fastDomResponse) : caller(tool, args),
      );
      expect(result.finalPage.url).toBe('https://example.com/fast-fixture');
      expect(result.finalPage.title).toBe('Fast DOM Title');
    });

    test('10. Triggers vision fallback on wait-only DOM actions (canvas fixture) for explicit single click and preserves non-click immunity', async () => {
      const { engine, caller, query } = visionHarness();
      const canvasDomResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: 'https://example.com/canvas',
              title: 'Canvas Fixture',
              actions: [{ id: 'wait', kind: 'wait', label: 'Wait for page' }],
              treeString: '[1] wait "Wait for page"',
            }),
          },
        ],
      };
      const result = await engine.run(
        { goal: 'Click on the blue Settings button inside the canvas', maxSteps: 1 },
        (tool, args) =>
          tool === 'chrome_read_dom' ? Promise.resolve(canvasDomResponse) : caller(tool, args),
      );
      expect(query).toHaveBeenCalledTimes(1);
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(true);
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(true);
      expect(result.jevUsage?.visionCalls).toBe(1);

      // Non-click goal (type) on same wait-only DOM must never trigger vision
      query.mockClear();
      caller.mockClear();
      await engine.run(
        { goal: "Type 'BrowserPaw' into search input", maxSteps: 1 },
        (tool, args) =>
          tool === 'chrome_read_dom' ? Promise.resolve(canvasDomResponse) : caller(tool, args),
      );
      expect(query).not.toHaveBeenCalled();
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(false);
    });

    test.each(['click', 'escalate', 'type', 'select'])(
      'low action confidence only permits visual fallback for click or escalation: %s',
      async (action) => {
        const { engine, caller, query } = visionHarness();
        jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
          result: {
            answers: createMockVisionJevAnswers({
              action: {
                type: 'choice',
                choice: action,
                confidence: 0.43,
                probabilities: {
                  click: 0,
                  type: 0,
                  select: 0,
                  scroll_down: 0,
                  scroll_up: 0,
                  back: 0,
                  wait: 0.3,
                  done: 0.27,
                  escalate: 0,
                  [action]: 0.43,
                },
              },
            }),
          },
          errorReason: null,
        });
        await engine.run({ goal: 'click bell icon', maxSteps: 1 }, (tool, args) =>
          tool === 'chrome_read_dom'
            ? Promise.resolve({
                content: [{ type: 'text', text: JSON.stringify({ treeString: '[1] button ""' }) }],
              })
            : caller(tool, args),
        );
        expect(query).toHaveBeenCalledTimes(action === 'click' || action === 'escalate' ? 1 : 0);
      },
    );

    test('11. Triggers vision fallback when text model explicitly chooses escalate on perceptual absence (icon-only toolbar)', async () => {
      const { engine, caller, query } = visionHarness();
      const iconToolbarDomResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: 'https://example.com/icon-toolbar',
              title: 'Icon Toolbar',
              treeString: '[1] button ""\n[2] button ""\n[3] button ""',
            }),
          },
        ],
      };

      const escalateAnswers = createMockVisionJevAnswers({
        action: {
          type: 'choice',
          choice: 'escalate',
          confidence: 0.9,
          probabilities: {
            click: 0.05,
            type: 0.01,
            select: 0.01,
            scroll_down: 0.01,
            scroll_up: 0.0,
            back: 0.0,
            wait: 0.02,
            done: 0.0,
            escalate: 0.9,
          },
        },
      });

      jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
        result: { answers: escalateAnswers },
        errorReason: null,
      });

      const result = await engine.run(
        { goal: 'Click on the blue notification bell button in the toolbar', maxSteps: 1 },
        (tool, args) =>
          tool === 'chrome_read_dom' ? Promise.resolve(iconToolbarDomResponse) : caller(tool, args),
      );

      expect(query).toHaveBeenCalledTimes(1);
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(true);
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(true);
      expect(result.jevUsage?.visionCalls).toBe(1);

      // Destructive check remains unbypassed
      query.mockClear();
      caller.mockClear();
      jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
        result: {
          answers: createMockVisionJevAnswers({ destructive: { type: 'noul', noul: 0.95 } }),
        },
        errorReason: null,
      });
      const destResult = await engine.run(
        { goal: 'click settings button', maxSteps: 1 },
        (tool, args) =>
          tool === 'chrome_read_dom' ? Promise.resolve(iconToolbarDomResponse) : caller(tool, args),
      );
      expect(destResult.status).toBe('escalate');
      expect(destResult.reason).toContain('Destructive');
      expect(query).not.toHaveBeenCalled();
      expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(false);
    });

    test('12. Low-confidence wait on explicit single-click goal triggers vision fallback and executes click exactly once', async () => {
      const { engine, caller, query } = visionHarness();
      const toolbarDom = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: 'https://example.com/toolbar',
              title: 'Toolbar',
              treeString: '[1] toolbar ""\n[2] div ""',
            }),
          },
        ],
      };

      const lowConfWaitAnswers = createMockVisionJevAnswers({
        action: {
          type: 'choice',
          choice: 'wait',
          confidence: 0.28,
          probabilities: {
            click: 0.1,
            type: 0.05,
            select: 0.05,
            scroll_down: 0.05,
            scroll_up: 0.05,
            back: 0.05,
            wait: 0.28,
            done: 0.2,
            escalate: 0.17,
          },
        },
      });

      jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
        result: { answers: lowConfWaitAnswers },
        errorReason: null,
      });

      const result = await engine.run(
        {
          goal: 'Click on the blue notification bell button in the toolbar',
          maxSteps: 2,
        },
        (tool, args) =>
          tool === 'chrome_read_dom' ? Promise.resolve(toolbarDom) : caller(tool, args),
      );

      // Verify vision fallback triggered and clicked exactly once
      expect(query).toHaveBeenCalledTimes(1);
      expect(caller.mock.calls.filter(([tool]) => tool === 'chrome_screenshot')).toHaveLength(1);
      expect(caller.mock.calls.filter(([tool]) => tool === 'chrome_interact_index')).toHaveLength(
        1,
      );
      expect(result.jevUsage?.visionCalls).toBe(1);
      // Second step halted because visualClickExecuted prevents re-executing
      expect(result.status).toBe('escalate');
      expect(result.reason).toContain('Visual click already executed');
    });

    test('13. Negative controls: low-confidence type, select, done and ambiguous/compound goals never trigger vision', async () => {
      const { engine, caller, query } = visionHarness();
      const toolbarDom = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: 'https://example.com/toolbar',
              title: 'Toolbar',
              treeString: '[1] toolbar ""\n[2] div ""',
            }),
          },
        ],
      };

      // Low confidence negative actions: type, select, done
      for (const action of ['type', 'select', 'done'] as const) {
        query.mockClear();
        caller.mockClear();
        jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
          result: {
            answers: createMockVisionJevAnswers({
              action: {
                type: 'choice',
                choice: action,
                confidence: 0.28,
                probabilities: {
                  click: 0.1,
                  type: 0.1,
                  select: 0.1,
                  scroll_down: 0.05,
                  scroll_up: 0.05,
                  back: 0.05,
                  wait: 0.17,
                  done: 0.1,
                  escalate: 0.28,
                  [action]: 0.28,
                },
              },
            }),
          },
          errorReason: null,
        });

        const res = await engine.run(
          {
            goal: 'Click on the blue notification bell button in the toolbar',
            maxSteps: 1,
          },
          (tool, args) =>
            tool === 'chrome_read_dom' ? Promise.resolve(toolbarDom) : caller(tool, args),
        );

        expect(query).not.toHaveBeenCalled();
        expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(false);
        expect(caller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(false);
        expect(res.jevUsage?.visionCalls ?? 0).toBe(0);
      }

      // Ambiguous and compound goals with low-confidence wait must not trigger vision
      const disallowedGoals = [
        'Explore the toolbar options',
        'Click on the blue notification bell button and then click settings',
        'Click on the blue notification bell button; click settings',
      ];

      for (const goal of disallowedGoals) {
        query.mockClear();
        caller.mockClear();
        jest.spyOn((engine as any).jevClient, 'query').mockResolvedValue({
          result: {
            answers: createMockVisionJevAnswers({
              action: {
                type: 'choice',
                choice: 'wait',
                confidence: 0.28,
                probabilities: {
                  click: 0.1,
                  wait: 0.28,
                  escalate: 0.2,
                },
              },
            }),
          },
          errorReason: null,
        });

        const res = await engine.run({ goal, maxSteps: 1 }, (tool, args) =>
          tool === 'chrome_read_dom' ? Promise.resolve(toolbarDom) : caller(tool, args),
        );

        expect(query).not.toHaveBeenCalled();
        expect(caller.mock.calls.some(([tool]) => tool === 'chrome_screenshot')).toBe(false);
        expect(caller.mock.calls.some(([tool]) => tool === 'chrome_interact_index')).toBe(false);
        expect(res.jevUsage?.visionCalls ?? 0).toBe(0);
      }
    });
  });
});
