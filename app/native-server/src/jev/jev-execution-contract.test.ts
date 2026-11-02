import { FastDecisionEngine } from './fast-decision-engine';
import { jevModelManager } from '../server/jev-model-manager';

const result = (data: any) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

function engineFor(step: string) {
  const engine = new FastDecisionEngine();
  (engine as any).jevClient.getRemoteClient = () => ({});
  (engine as any).jevClient.query = async (_state: any, questions: any) => {
    expect(questions).not.toHaveProperty('submit_intent');
    const keys = Object.keys(questions.next_step.criteria);
    return {
      result: {
        model: 'jev-test',
        usage: { input_tokens: 12, output_tokens: 3 },
        answers: {
          next_step: {
            type: 'choice',
            choice: step,
            confidence: 0.98,
            probabilities: Object.fromEntries(
              keys.map((k) => [k, k === step ? 0.98 : 0.02 / (keys.length - 1)]),
            ),
          },
          goal_done: { type: 'noul', noul: step === 'done' ? 0.99 : 0.01 },
          stuck: { type: 'noul', noul: 0.01 },
        },
      },
      errorReason: null,
    };
  };
  return engine;
}

describe('Jev executor trust boundaries', () => {
  beforeEach(() => jest.spyOn(jevModelManager, 'getActiveMode').mockReturnValue('remote'));
  afterEach(() => jest.restoreAllMocks());

  test('refuses a model-selected target when a legacy observation has no identity guard', async () => {
    const engine = engineFor('click_7');
    const caller = jest.fn(async (name: string) =>
      name === 'chrome_read_dom'
        ? result({ treeString: '[7] button "Search"' })
        : result({ success: true }),
    );
    const response = await engine.run({ goal: 'Open Search', tabId: 20, maxSteps: 1 }, caller);
    expect(response).toMatchObject({ status: 'blocked', requestDispatched: false });
    expect(caller.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(0);
  });

  test('keeps a confirmed action without chained observation or an explicit tabId', async () => {
    const caller = jest.fn(async (name: string) =>
      name === 'chrome_read_dom'
        ? result({ treeString: '[7] button "Search"', guards: { 7: [7, 'button', 'Search'] } })
        : result({ success: true, mutated: true }),
    );
    const response = await engineFor('click_7').run({ goal: 'Open Search', maxSteps: 1 }, caller);
    expect(response).toMatchObject({ status: 'max_steps', steps: [{ action: 'click' }] });
    expect(caller.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(1);
  });

  test('verifies the first confirmed fill without requesting another model decision', async () => {
    const engine = engineFor('type_7');
    const decide = (engine as any).jevClient.query;
    const query = jest.fn(decide);
    (engine as any).jevClient.query = query;
    let filled = false;
    const caller = jest.fn(async (name: string, args: any) => {
      if (name === 'chrome_fill_index') {
        filled = true;
        return result({ success: true });
      }
      if (args.selector) return result({ value: filled ? 'acceptance@example.invalid' : '' });
      return result({ treeString: '[7] textbox "Email"', guards: { 7: [7, 'textbox', 'Email'] } });
    });
    const response = await engine.run(
      {
        goal: 'Fill email without submitting',
        textHint: 'acceptance@example.invalid',
        tabId: 20,
        maxSteps: 1,
        verification: [
          {
            tool: 'chrome_read_dom',
            args: { selector: 'input' },
            expect: {
              required: ['value'],
              properties: { value: { const: 'acceptance@example.invalid' } },
            },
          },
        ],
      },
      caller,
    );
    expect(response).toMatchObject({
      status: 'done',
      success: true,
      steps: [{ action: 'type' }],
      interaction: {
        execution: { status: 'dispatched', dispatchedCount: 1 },
        verification: { status: 'verified' },
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(caller.mock.calls.filter(([name]) => name === 'chrome_fill_index')).toHaveLength(1);
    expect(
      caller.mock.calls.filter(([name, args]) => name === 'chrome_read_dom' && args.selector),
    ).toHaveLength(1);
  });

  test('keeps caller text and existing editor values out of model state and action criteria', async () => {
    const engine = engineFor('type_7');
    const decide = (engine as any).jevClient.query;
    const query = jest.fn(decide);
    (engine as any).jevClient.query = query;
    const caller = jest.fn(async (name: string) =>
      name === 'chrome_read_dom'
        ? result({
            treeString:
              '[7] textbox "Email" value="existing-private-value"\n[8] [composer] textbox "private-editor-draft" value="private-editor-draft"',
            text: 'Preview private-editor-draft',
            actions: [
              { kind: 'fill', node: 7, label: 'Email', value: 'existing-private-value' },
              {
                kind: 'fill',
                node: 8,
                label: 'private-editor-draft',
                value: 'private-editor-draft',
              },
            ],
            guards: { 7: [7, 'textbox', 'Email'], 8: [8, 'textbox', 'private-editor-draft'] },
          })
        : result({ success: true, committed: true }),
    );
    await engine.run(
      {
        goal: 'Fill the email field with "caller-private-value" without submitting',
        textHint: 'caller-private-value',
        tabId: 20,
        maxSteps: 1,
      },
      caller,
    );
    expect(query).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(query.mock.calls[0].slice(0, 2));
    for (const secret of [
      'existing-private-value',
      'private-editor-draft',
      'caller-private-value',
    ]) {
      expect(sent).not.toContain(secret);
    }
    expect(caller).toHaveBeenCalledWith(
      'chrome_fill_index',
      expect.objectContaining({ text: 'caller-private-value' }),
      expect.anything(),
    );
  });

  test('continues to a different observed target when the completion condition is not met', async () => {
    const engine = engineFor('click_7');
    let clicks = 0;
    const query = jest.fn((...args: any[]) =>
      (engineFor(clicks === 0 ? 'click_7' : 'click_8') as any).jevClient.query(...args),
    );
    (engine as any).jevClient.query = query;
    const caller = jest.fn(async (name: string, args: any) => {
      if (name === 'chrome_interact_index') {
        clicks++;
        return result({ success: true });
      }
      if (args.selector) return result({ title: clicks === 2 ? 'Done' : 'Loading' });
      const id = clicks === 0 ? 7 : 8;
      return result({
        treeString: `[${id}] button "Continue"`,
        guards: { [id]: [id, 'button', 'Continue'] },
      });
    });
    const response = await engine.run(
      {
        goal: 'Open the next panel',
        tabId: 20,
        maxSteps: 2,
        verification: [
          {
            tool: 'chrome_read_dom',
            args: { selector: '#completion' },
            expect: { required: ['title'], properties: { title: { const: 'Done' } } },
          },
        ],
      },
      caller,
    );
    expect(response).toMatchObject({ status: 'done', success: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      caller.mock.calls
        .filter(([name]) => name === 'chrome_interact_index')
        .map(([, args]) => args.index),
    ).toEqual([7, 8]);
  });

  test.each(['unknown', 'cancelled', 'timeout'] as const)(
    'stops at %s from post-action verification',
    async (status) => {
      const engine = engineFor('click_7');
      const query = jest.spyOn((engine as any).jevClient, 'query');
      const caller = jest.fn(async (name: string, args: any) => {
        if (name === 'chrome_interact_index') return result({ success: true });
        if (args.selector) return result({ success: false, status });
        return result({
          treeString: '[7] button "Continue"',
          guards: { 7: [7, 'button', 'Continue'] },
        });
      });
      const response = await engine.run(
        {
          goal: 'Open the next panel',
          tabId: 20,
          maxSteps: 3,
          verification: [
            {
              tool: 'chrome_read_dom',
              args: { selector: '#completion' },
              expect: { const: 'Done' },
            },
          ],
        },
        caller,
      );
      expect(response.status).toBe(status);
      expect(response.steps).toHaveLength(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(caller.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(
        1,
      );
    },
  );

  test.each([{ coverage: { status: 'partial' } }, { omitted_actions: 1 }])(
    'does not decide from incomplete candidate coverage: %j',
    async (coverage) => {
      const engine = engineFor('click_7');
      const query = jest.spyOn((engine as any).jevClient, 'query');
      const caller = jest.fn(async () =>
        result({
          treeString: '[7] button "Search"',
          actions: [{ kind: 'click', node: 7, label: 'Search' }],
          guards: { 7: [7, 'button', 'Search'] },
          ...coverage,
        }),
      );
      const response = await engine.run({ goal: 'Open Search', tabId: 20 }, caller);
      expect(response).toMatchObject({ status: 'blocked', requestDispatched: false });
      expect(caller).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    },
  );

  test.each([20, 99])(
    'reuses only the current page observation (%i) and still verifies completion independently',
    async (sourceTab) => {
      const snapshot = result({
        treeString: '[7] button "Search"',
        actions: [{ kind: 'click', node: 7, label: 'Search' }],
        guards: { 7: [7, 'button', 'Search'] },
      });
      const engine = engineFor('click_7');
      const first = (engine as any).jevClient.query;
      let turns = 0;
      (engine as any).jevClient.query = (...args: any[]) => {
        if (++turns === 1) return first(...args);
        return (engineFor('done') as any).jevClient.query(...args);
      };
      let reads = 0;
      let checks = 0;
      const caller = jest.fn(async (name: string, args: any) => {
        if (name === 'chrome_read_dom') {
          reads++;
          return args.selector ? result({ title: ++checks === 1 ? 'Loading' : 'Done' }) : snapshot;
        }
        return result({ success: true, goalObservation: { tabId: sourceTab, result: snapshot } });
      });
      const response = await engine.run(
        {
          goal: 'Open Search',
          tabId: 20,
          maxSteps: 2,
          verification: [
            {
              tool: 'chrome_read_dom',
              args: { selector: '#completion-marker' },
              expect: { required: ['title'], properties: { title: { const: 'Done' } } },
            },
          ],
        },
        caller,
      );
      expect(response.status).toBe('done');
      expect(reads).toBe(sourceTab === 20 ? 3 : 4);
      expect(caller.mock.calls.filter(([name]) => name === 'chrome_interact_index')).toHaveLength(
        1,
      );
    },
  );

  test('passes the observed guard and stops at the original blocked receipt without another action', async () => {
    const guard = [7, 'button', 'Search'];
    const blocked = {
      ...result({ success: false, status: 'blocked', requestDispatched: false }),
      isError: true,
    };
    const caller = jest.fn(async (name: string) =>
      name === 'chrome_read_dom'
        ? result({
            treeString: '[7] button "Search"',
            actions: [{ kind: 'click', node: 7, label: 'Search' }],
            guards: { 7: guard },
          })
        : blocked,
    );
    const response = await engineFor('click_7').run({ goal: 'Open Search', tabId: 20 }, caller);
    expect(response.status).toBe('blocked');
    expect(response.lastReceipt).toBe(blocked);
    expect(caller).toHaveBeenCalledTimes(2);
    expect(caller.mock.calls[1]).toEqual([
      'chrome_interact_index',
      expect.objectContaining({
        index: 7,
        expectedGuard: guard,
        tabId: 20,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
  });

  test('never verifies success against another page', async () => {
    const caller = jest.fn(async () => result({ treeString: '[7] button "Search"' }));
    const response = await engineFor('done').run(
      {
        goal: 'Read document',
        tabId: 20,
        verification: [
          {
            tool: 'chrome_read_dom',
            args: { tabId: 99 },
            expect: { required: ['title'], properties: { title: { const: 'Done' } } },
          },
        ],
      },
      caller,
    );
    expect(response.status).toBe('escalate');
    expect(response.success).toBe(false);
    expect(caller).toHaveBeenCalledTimes(1);
    expect(response.reason).toContain('current task page');
  });

  test('a mode change after inference stops before the first action', async () => {
    let revision = 0;
    jest
      .spyOn(jevModelManager, 'captureModeToken')
      .mockImplementation(() => ({ activeMode: 'remote', revision }));
    const engine = engineFor('click_7');
    const query = (engine as any).jevClient.query;
    (engine as any).jevClient.query = async (...args: any[]) => {
      const answer = await query(...args);
      revision++;
      return answer;
    };
    const caller = jest.fn(async () =>
      result({ treeString: '[7] button "Search"', guards: { 7: [7, 'button', 'Search'] } }),
    );
    const response = await engine.run({ goal: 'Open Search', tabId: 20 }, caller);
    expect(response).toMatchObject({ status: 'cancelled', requestDispatched: false, retry: false });
    expect(caller).toHaveBeenCalledTimes(1);
  });

  test('reports actual input/output usage and leaves unknown endpoint prices unset', async () => {
    const caller = jest.fn(async () => result({ treeString: '[7] button "Search"' }));
    const response = await engineFor('done').run({ goal: 'Read document', tabId: 20 }, caller);
    expect(response.jevUsage).toMatchObject({
      attempts: 1,
      successfulRequests: 1,
      inputTokens: 12,
      outputTokens: 3,
      estCostUsd: null,
    });
  });

  test.each(['cancelled', 'unknown', 'timeout'] as const)(
    'preserves %s during completion verification',
    async (status) => {
      const failure = Object.assign(new Error('Verification interrupted'), { status });
      const caller = jest
        .fn()
        .mockResolvedValueOnce(result({ treeString: '[7] button "Search"' }))
        .mockRejectedValueOnce(failure);
      const response = await engineFor('done').run(
        {
          goal: 'Read document',
          tabId: 20,
          verification: [{ tool: 'chrome_read_dom', expect: { required: ['title'] } }],
        },
        caller,
      );
      expect(response).toMatchObject({ status, success: false, retry: false });
      expect(response.lastReceipt).toBe(failure);
      expect(caller).toHaveBeenCalledTimes(2);
    },
  );

  test('does not accept a verification response arriving after cancellation', async () => {
    const controller = new AbortController();
    const caller = jest
      .fn()
      .mockResolvedValueOnce(result({ treeString: '[7] button "Search"' }))
      .mockImplementationOnce(async () => {
        controller.abort();
        return result({ title: 'Done' });
      });
    const response = await engineFor('done').run(
      {
        goal: 'Read document',
        tabId: 20,
        verification: [{ tool: 'chrome_read_dom', expect: { required: ['title'] } }],
      },
      caller,
      undefined,
      { signal: controller.signal },
    );
    expect(response).toMatchObject({ status: 'cancelled', success: false });
  });

  test('retains an unknown dispatch result when cancellation arrives at the same time', async () => {
    const controller = new AbortController();
    const receipt = {
      ...result({ status: 'unknown', success: false, requestDispatched: true }),
      isError: true,
    };
    const caller = jest.fn(async (name: string) => {
      if (name === 'chrome_read_dom')
        return result({
          treeString: '[7] button "Search"',
          actions: [{ kind: 'click', node: 7, label: 'Search' }],
          guards: { 7: [7, 'button', 'Search'] },
        });
      controller.abort();
      return receipt;
    });
    const response = await engineFor('click_7').run(
      { goal: 'Open Search', tabId: 20 },
      caller,
      undefined,
      { signal: controller.signal },
    );
    expect(response).toMatchObject({
      status: 'unknown',
      success: false,
      retry: false,
      requestDispatched: true,
      interaction: {
        execution: { status: 'unknown', dispatchedCount: 1 },
        verification: { status: 'not_requested' },
      },
    });
    expect(response.lastReceipt).toBe(receipt);
    expect(caller).toHaveBeenCalledTimes(2);
  });
});
