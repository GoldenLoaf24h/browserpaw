import { FastDecisionEngine } from './fast-decision-engine';
import { buildStepCandidates } from './step-candidates';
import { jevModelManager } from '../server/jev-model-manager';
import { isSessionKeyInvalid, resetInvalidKeyLatch } from './jev-client';
import { hasConcreteAssertion } from './verification';

// Test observations include explicit identities for their observed numeric refs.
function serializeObservedFixture(value: any): string {
  if (typeof value?.treeString === 'string' && value.guards === undefined) {
    const refs = [...value.treeString.matchAll(/^\[(\d+)\][^\n]*/gm)];
    value = {
      ...value,
      guards: Object.fromEntries(refs.map((m: any) => [m[1], [Number(m[1]), 'fixture', m[0]]])),
    };
  }
  return JSON.stringify(value);
}

function createMockJevAnswers(overrides: Record<string, any> = {}) {
  return {
    next_step: {
      type: 'choice',
      choice: 'click_1',
      confidence: 0.95,
      probabilities: {
        click_1: 0.95,
        scroll_down: 0.01,
        scroll_up: 0.0,
        back: 0.0,
        wait: 0.0,
        done: 0.02,
        none: 0.02,
      },
    },
    goal_done: { type: 'noul', noul: 0.05 },
    stuck: { type: 'noul', noul: 0.05 },
    ...overrides,
  };
}

describe('Plan C Micro-Loop Reliability Dedicated Tests', () => {
  beforeEach(() => {
    jevModelManager.setActiveMode('remote');
    process.env.TYPESAFE_API_KEY = 'test_key';
    resetInvalidKeyLatch();
  });

  afterEach(() => {
    resetInvalidKeyLatch();
    delete process.env.TYPESAFE_API_KEY;
  });

  test('C1. AbortSignal cancels immediately before start with dispatched=false', async () => {
    const engine = new FastDecisionEngine();
    const controller = new AbortController();
    controller.abort();
    const caller = jest.fn();

    const result = await engine.run({ goal: 'test abort' }, caller, undefined, {
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.success).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.requestDispatched).toBe(false);
    expect(caller).not.toHaveBeenCalled();
  });

  test('C2. AbortSignal cancels mid-loop with dispatched=true when action was executed', async () => {
    const engine = new FastDecisionEngine();
    const controller = new AbortController();

    let stepCount = 0;
    const caller = async (tool: string) => {
      if (tool === 'chrome_read_dom') {
        stepCount++;
        if (stepCount > 1) {
          controller.abort();
        }
        return {
          content: [
            {
              type: 'text',
              text: serializeObservedFixture({
                tabUrl: 'https://example.com',
                tabTitle: 'Test',
                treeString: '[1] button "Click me"',
              }),
            },
          ],
        };
      }
      return {
        content: [
          { type: 'text', text: serializeObservedFixture({ success: true, mutated: true }) },
        ],
      };
    };

    (engine as any).jevClient.query = async () => ({
      result: { model: 'jev-latest', answers: createMockJevAnswers() },
      errorReason: null,
    });

    const result = await engine.run({ goal: 'click button', maxSteps: 5 }, caller, undefined, {
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.success).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.requestDispatched).toBe(true);
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
  });

  test('C3. Deadline parameter enforces timeout when deadline exceeded', async () => {
    const engine = new FastDecisionEngine();
    const caller = jest.fn();

    const result = await engine.run({ goal: 'test deadline', deadline: Date.now() - 100 }, caller);

    expect(result.status).toBe('timeout');
    expect(caller).not.toHaveBeenCalled();
  });

  test('C4. Real MCP textJSON unknown after click executes zero second action', async () => {
    const engine = new FastDecisionEngine();

    let actionCallCount = 0;
    const caller = async (tool: string) => {
      if (tool === 'chrome_read_dom') {
        return {
          content: [
            {
              type: 'text',
              text: serializeObservedFixture({
                tabUrl: 'https://example.com',
                tabTitle: 'Test',
                treeString: '[1] button "Action"',
              }),
            },
          ],
        };
      }
      actionCallCount++;
      return {
        content: [
          {
            type: 'text',
            text: serializeObservedFixture({
              success: false,
              status: 'unknown',
              retry: false,
              requestDispatched: true,
              error: 'Connection interrupted after action was sent',
            }),
          },
        ],
        isError: true,
      };
    };

    (engine as any).jevClient.query = async () => ({
      result: { model: 'jev-latest', answers: createMockJevAnswers() },
      errorReason: null,
    });

    const result = await engine.run({ goal: 'click action', maxSteps: 5 }, caller);

    expect(actionCallCount).toBe(1);
    expect(result.status).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.requestDispatched).toBe(true);
    expect(result.lastReceipt).toBeDefined();
    expect(result.steps.length).toBe(0);
  });

  test('C5. Real MCP textJSON cancelled after click halts immediately with status cancelled', async () => {
    const engine = new FastDecisionEngine();

    let actionCallCount = 0;
    const caller = async (tool: string) => {
      if (tool === 'chrome_read_dom') {
        return {
          content: [
            {
              type: 'text',
              text: serializeObservedFixture({
                tabUrl: 'https://example.com',
                tabTitle: 'Test',
                treeString: '[1] button "Action"',
              }),
            },
          ],
        };
      }
      actionCallCount++;
      return {
        content: [
          {
            type: 'text',
            text: serializeObservedFixture({
              success: false,
              status: 'cancelled',
              retry: false,
              requestDispatched: true,
              error: 'Operation cancelled',
            }),
          },
        ],
      };
    };

    (engine as any).jevClient.query = async () => ({
      result: { model: 'jev-latest', answers: createMockJevAnswers() },
      errorReason: null,
    });

    const result = await engine.run({ goal: 'click action', maxSteps: 5 }, caller);

    expect(actionCallCount).toBe(1);
    expect(result.status).toBe('cancelled');
    expect(result.success).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.requestDispatched).toBe(true);
  });

  test('C6. Invalid model action is blocked before dispatch', async () => {
    const engine = new FastDecisionEngine();

    const caller = async () => ({
      content: [
        {
          type: 'text',
          text: serializeObservedFixture({
            tabUrl: 'https://example.com',
            tabTitle: 'Test',
            treeString: '[1] button "Action"',
          }),
        },
      ],
    });

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: {
          next_step: {
            type: 'choice',
            choice: 'non_existent_action',
            confidence: 0.95,
            probabilities: { non_existent_action: 0.95, none: 0.05 },
          },
        },
      },
      errorReason: null,
    });

    const result = await engine.run({ goal: 'test unknown action' }, caller);

    expect(result.status).toBe('blocked');
    expect(result.requestDispatched).toBe(false);
    expect(result.fallbackReason).toBe('invalid_response');
  });

  test('C7. Malformed candidate distribution is blocked before dispatch', async () => {
    const engine = new FastDecisionEngine();

    const caller = async () => ({
      content: [
        {
          type: 'text',
          text: serializeObservedFixture({
            tabUrl: 'https://example.com',
            tabTitle: 'Test',
            treeString: '[1] button "Action"',
          }),
        },
      ],
    });

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: {
          next_step: {
            type: 'choice',
            choice: 'click_1',
            confidence: NaN,
            probabilities: { click_1: 1 },
          },
        },
      },
      errorReason: null,
    });

    const result = await engine.run({ goal: 'click action' }, caller);

    expect(result.status).toBe('blocked');
    expect(result.requestDispatched).toBe(false);
    expect(result.fallbackReason).toBe('invalid_response');
  });

  test('C8. Verification succeeds with valid JSON Pointer /treeString and expect schema', async () => {
    const engine = new FastDecisionEngine();

    const caller = async (tool: string) => {
      if (tool === 'chrome_read_dom') {
        return {
          content: [
            {
              type: 'text',
              text: serializeObservedFixture({
                tabUrl: 'https://example.com/success',
                treeString: '[1] text "Order Confirmed #12345"',
              }),
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: serializeObservedFixture({ success: true }) }] };
    };

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: createMockJevAnswers({ goal_done: { type: 'noul', noul: 0.95 } }),
      },
      errorReason: null,
    });

    const result = await engine.run(
      {
        goal: 'confirm order',
        verification: [
          {
            tool: 'chrome_read_dom',
            resultPath: '/treeString',
            expect: { type: 'string', pattern: 'Order Confirmed' },
          },
        ],
      },
      caller,
    );

    expect(result.status).toBe('done');
    expect(result.success).toBe(true);
    expect(result.verification).toHaveLength(1);
    expect(result.verification?.[0].pass).toBe(true);
  });

  test('C9. Vacuous assertion rejected: properties without required does not pass hasConcreteAssertion', () => {
    expect(hasConcreteAssertion({ properties: { h1: { const: 'Fetch' } } })).toBe(false);
    expect(hasConcreteAssertion({ properties: { h1: { const: 'Fetch' } }, required: ['h1'] })).toBe(
      true,
    );
    expect(
      hasConcreteAssertion({
        anyOf: [{ properties: { h1: { const: 'Fetch' } }, required: ['h1'] }, {}],
      }),
    ).toBe(false);
    expect(
      hasConcreteAssertion({
        allOf: [{ type: 'object' }, { properties: { h1: { const: 'Fetch' } }, required: ['h1'] }],
      }),
    ).toBe(true);
  });

  test('C10. Verification failure escalates and exposes error details', async () => {
    const engine = new FastDecisionEngine();

    const caller = async () => ({
      content: [
        {
          type: 'text',
          text: serializeObservedFixture({
            tabUrl: 'https://example.com/failed',
            treeString: '[1] text "Order Failed"',
          }),
        },
      ],
    });

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: createMockJevAnswers({ goal_done: { type: 'noul', noul: 0.95 } }),
      },
      errorReason: null,
    });

    const result = await engine.run(
      {
        goal: 'confirm order',
        verification: [
          {
            tool: 'chrome_read_dom',
            resultPath: '/treeString',
            expect: { type: 'string', pattern: 'Order Confirmed' },
          },
        ],
      },
      caller,
    );

    expect(result.status).toBe('escalate');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Goal verification failed');
    expect(result.verification).toHaveLength(1);
    expect(result.verification?.[0].pass).toBe(false);
  });

  test('C11. Verification rejects empty expect and schemas without concrete assertions', async () => {
    const engine = new FastDecisionEngine();

    const caller = async () => ({
      content: [
        {
          type: 'text',
          text: serializeObservedFixture({ tabUrl: 'https://example.com', treeString: 'text' }),
        },
      ],
    });

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: createMockJevAnswers({ goal_done: { type: 'noul', noul: 0.95 } }),
      },
      errorReason: null,
    });

    const result = await engine.run(
      {
        goal: 'confirm order',
        verification: [
          {
            tool: 'chrome_read_dom',
            expect: {},
          },
        ],
      },
      caller,
    );

    expect(result.status).toBe('escalate');
    expect(result.reason).toContain('concrete assertions');
  });

  test('C12. Verification rejects partial observation coverage', async () => {
    const engine = new FastDecisionEngine();

    const caller = async () => ({
      coverage: { partial: true },
      content: [
        {
          type: 'text',
          text: serializeObservedFixture({ tabUrl: 'https://example.com', treeString: 'text' }),
        },
      ],
    });

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: createMockJevAnswers({ goal_done: { type: 'noul', noul: 0.95 } }),
      },
      errorReason: null,
    });

    const result = await engine.run(
      {
        goal: 'confirm order',
        verification: [
          {
            tool: 'chrome_read_dom',
            expect: {
              type: 'object',
              properties: { tabUrl: { pattern: '.*' } },
              required: ['tabUrl'],
            },
          },
        ],
      },
      caller,
    );

    expect(result.status).toBe('escalate');
    expect(result.reason).toContain('partial');
  });

  test('C13. Verification rejects network requests with body or write parameters', async () => {
    const engine = new FastDecisionEngine();

    const caller = async () => ({
      content: [
        {
          type: 'text',
          text: serializeObservedFixture({ tabUrl: 'https://example.com', treeString: 'text' }),
        },
      ],
    });

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: createMockJevAnswers({ goal_done: { type: 'noul', noul: 0.95 } }),
      },
      errorReason: null,
    });

    const result = await engine.run(
      {
        goal: 'confirm order',
        verification: [
          {
            tool: 'chrome_network_request',
            args: { method: 'POST', body: 'write' } as any,
            expect: {
              type: 'object',
              properties: { status: { const: 200 } },
              required: ['status'],
            },
          },
        ],
      },
      caller,
    );

    expect(result.status).toBe('escalate');
    expect(result.reason).toContain('not permitted');
  });

  test('C14. Verification rejects when spec count exceeds maximum 8', async () => {
    const engine = new FastDecisionEngine();

    const caller = async () => ({
      content: [
        {
          type: 'text',
          text: serializeObservedFixture({ tabUrl: 'https://example.com', treeString: 'text' }),
        },
      ],
    });

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: createMockJevAnswers({ goal_done: { type: 'noul', noul: 0.95 } }),
      },
      errorReason: null,
    });

    const nineSpecs = Array(9).fill({
      tool: 'chrome_read_dom',
      expect: { type: 'object', properties: { tabUrl: { const: 'x' } }, required: ['tabUrl'] },
    });

    const result = await engine.run(
      {
        goal: 'confirm order',
        verification: nineSpecs,
      },
      caller,
    );

    expect(result.status).toBe('escalate');
    expect(result.reason).toContain('maximum 8');
  });

  test('C15. Global mode off blocks execution without running heuristic guess', async () => {
    jevModelManager.setActiveMode('off');
    const engine = new FastDecisionEngine();
    const caller = jest.fn();

    const result = await engine.run({ goal: 'test global off', mode: 'remote' }, caller);

    expect(result.status).toBe('blocked');
    expect(result.engine).toBe('jev');
    expect(result.fallbackReason).toBe('jev_disabled');
    expect(caller).not.toHaveBeenCalled();
  });

  test('C16. P3 telemetry tracks attempts, successfulRequests, model, and null cost for local', async () => {
    jest
      .spyOn(jevModelManager, 'ensureLocalServiceRunning')
      .mockResolvedValue({ success: true, message: 'ok' });
    jest.spyOn(jevModelManager, 'isLocalServiceOnline').mockResolvedValue(true);
    jevModelManager.setActiveMode('local');

    const engine = new FastDecisionEngine();
    const caller = async () => ({
      content: [
        {
          type: 'text',
          text: serializeObservedFixture({
            tabUrl: 'https://example.com',
            treeString: '[1] button "Action"',
          }),
        },
      ],
    });

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'local-decider-2b',
        answers: createMockJevAnswers({ goal_done: { type: 'noul', noul: 0.95 } }),
        usage: { input_tokens: 250, output_tokens: 10 },
      },
      errorReason: null,
    });

    const result = await engine.run(
      {
        goal: 'test local telemetry',
        mode: 'local',
        verification: [
          {
            tool: 'chrome_read_dom',
            expect: {
              type: 'object',
              properties: { tabUrl: { const: 'https://example.com' } },
              required: ['tabUrl'],
            },
          },
        ],
      },
      caller,
    );

    expect(result.status).toBe('done');
    expect(result.jevUsage).toBeDefined();
    expect(result.jevUsage?.backend).toBe('local');
    expect(result.jevUsage?.model).toBe('local-decider-2b');
    expect(result.jevUsage?.estCostUsd).toBeNull();
    expect(result.jevUsage?.attempts).toBe(1);
    expect(result.jevUsage?.successfulRequests).toBe(1);
  });

  test('C17. buildStepCandidates generates unified next_step choices with action capability mappings', () => {
    const elements = [
      '[1] button "Continue"',
      '[2] textbox "Email Address"',
      '[3] select "Country Selection"',
    ];
    const { candidateKeys, candidateMap, questions } = buildStepCandidates(
      elements,
      'Fill and submit',
    );
    expect(candidateMap.get('click_1')).toMatchObject({ action: 'click', targetIndex: 1 });
    expect(candidateMap.get('type_2')).toMatchObject({ action: 'type', targetIndex: 2 });
    expect(candidateMap.get('select_3')).toMatchObject({ action: 'select', targetIndex: 3 });
    expect(candidateMap.get('wait')).toMatchObject({ action: 'wait' });
    expect(candidateMap.get('done')).toMatchObject({ action: 'done' });
    expect(candidateMap.get('none')).toMatchObject({ action: 'none' });
    expect(candidateKeys).toContain('click_1');
    expect(candidateKeys).toContain('type_2');
    expect(candidateKeys).toContain('select_3');
    expect(questions.next_step).toBeDefined();
    expect(questions.next_step.type).toBe('choice');
    expect(questions).not.toHaveProperty('submit_intent');
  });

  test('C18. Unified next_step executes candidate action directly without separate target query', async () => {
    const engine = new FastDecisionEngine();
    let interactIndexCalled: number | null = null;
    const caller = async (tool: string, args: any) => {
      if (tool === 'chrome_read_dom') {
        return {
          content: [
            {
              type: 'text',
              text: serializeObservedFixture({ treeString: '[12] button "Login Now"' }),
            },
          ],
        };
      }
      if (tool === 'chrome_interact_index') {
        interactIndexCalled = args.index;
        return {
          content: [
            { type: 'text', text: serializeObservedFixture({ success: true, mutated: true }) },
          ],
        };
      }
      return { content: [{ type: 'text', text: serializeObservedFixture({ success: true }) }] };
    };

    (engine as any).jevClient.query = async (_state: any, questions: any) => {
      expect(questions.next_step).toBeDefined();
      return {
        result: {
          model: 'jev-latest',
          answers: {
            next_step: {
              type: 'choice',
              choice: 'click_12',
              confidence: 0.95,
              probabilities: {
                click_12: 0.9,
                scroll_down: 0.02,
                scroll_up: 0.01,
                back: 0.01,
                wait: 0.01,
                done: 0.02,
                none: 0.03,
              },
            },
          },
          usage: { input_tokens: 150, output_tokens: 10 },
        },
        errorReason: null,
      };
    };

    const result = await engine.run({ goal: 'click login', maxSteps: 1 }, caller);
    expect(interactIndexCalled).toBe(12);
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].action).toBe('click');
    expect(result.steps[0].target).toContain('[12]');
  });

  test('C19. Destructive action detection directly escalates on candidate target', async () => {
    const engine = new FastDecisionEngine();
    const caller = async (tool: string) => {
      if (tool === 'chrome_read_dom') {
        return {
          content: [
            {
              type: 'text',
              text: serializeObservedFixture({ treeString: '[1] button "确认支付 $99"' }),
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: serializeObservedFixture({ success: true }) }] };
    };

    (engine as any).jevClient.query = async () => ({
      result: {
        model: 'jev-latest',
        answers: {
          next_step: {
            type: 'choice',
            choice: 'click_1',
            confidence: 0.95,
            probabilities: {
              click_1: 0.9,
              scroll_down: 0.02,
              scroll_up: 0.01,
              back: 0.01,
              wait: 0.01,
              done: 0.02,
              none: 0.03,
            },
          },
        },
        usage: { input_tokens: 150, output_tokens: 10 },
      },
      errorReason: null,
    });

    const result = await engine.run({ goal: 'pay order', maxSteps: 1 }, caller);
    expect(result.status).toBe('blocked');
    expect(result.requestDispatched).toBe(false);
    expect(result.fallbackReason).toBe('invalid_response');
  });

  test('C20. options.signal combines with query timeout and aborts query immediately', async () => {
    const engine = new FastDecisionEngine();
    const abortCtrl = new AbortController();
    const caller = async (tool: string) => {
      if (tool === 'chrome_read_dom') {
        return {
          content: [
            { type: 'text', text: serializeObservedFixture({ treeString: '[1] button "Start"' }) },
          ],
        };
      }
      return { content: [{ type: 'text', text: serializeObservedFixture({ success: true }) }] };
    };

    let receivedSignal: AbortSignal | null = null;
    (engine as any).jevClient.query = async (
      _state: any,
      _questions: any,
      _mode: any,
      options: any,
    ) => {
      receivedSignal = options.signal;
      abortCtrl.abort();
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            result: null,
            errorReason: options.signal.aborted ? 'cancelled' : 'network_error',
          });
        }, 10);
      });
    };

    const result = await engine.run(
      { goal: 'test signal propagation', maxSteps: 1 },
      caller,
      undefined,
      { signal: abortCtrl.signal },
    );

    expect(receivedSignal).not.toBeNull();
    expect((receivedSignal as any)?.aborted).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.requestDispatched).toBe(false);
  });
  test('C21. Mutation tool failure with dispatched:false halts as blocked with lastReceipt', async () => {
    const engine = new FastDecisionEngine();
    let actionCallCount = 0;
    const caller = async (tool: string) => {
      if (tool === 'chrome_read_dom') {
        return {
          content: [
            {
              type: 'text',
              text: serializeObservedFixture({
                tabUrl: 'https://example.com',
                tabTitle: 'Test',
                treeString: '[1] button "Action"',
              }),
            },
          ],
        };
      }
      actionCallCount++;
      return {
        content: [
          {
            type: 'text',
            text: serializeObservedFixture({
              success: false,
              requestDispatched: false,
              error: 'Element not interactable before dispatch',
            }),
          },
        ],
        isError: true,
      };
    };

    (engine as any).jevClient.query = async () => ({
      result: { model: 'jev-latest', answers: createMockJevAnswers() },
      errorReason: null,
    });

    const result = await engine.run({ goal: 'click action', maxSteps: 5 }, caller);

    expect(actionCallCount).toBe(1);
    expect(result.status).toBe('blocked');
    expect(result.success).toBe(false);
    expect(result.requestDispatched).toBe(false);
    expect(result.lastReceipt).toBeDefined();
  });

  test('C22. Ordinary throw without status halts as blocked with dispatched=false', async () => {
    const engine = new FastDecisionEngine();
    const caller = async (tool: string) => {
      if (tool === 'chrome_read_dom') {
        throw new Error('Unexpected DOM read throw without status');
      }
      return { content: [{ type: 'text', text: serializeObservedFixture({ success: true }) }] };
    };

    (engine as any).jevClient.query = async () => ({
      result: { model: 'jev-latest', answers: createMockJevAnswers() },
      errorReason: null,
    });

    const result = await engine.run({ goal: 'click action', maxSteps: 5 }, caller);

    expect(result.status).toBe('blocked');
    expect(result.requestDispatched).toBeFalsy();
  });
});
