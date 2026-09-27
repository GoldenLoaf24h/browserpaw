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
});
