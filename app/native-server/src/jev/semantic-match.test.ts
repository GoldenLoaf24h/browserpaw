import { classifySemanticAnswer, matchSemanticTarget } from './semantic-match';
import { JevClientWrapper } from './jev-client';
import { jevModelManager } from '../server/jev-model-manager';

describe('semantic target response contract', () => {
  test('asks for the target label in task, not the input content or a later submit action', async () => {
    const mode = jest.spyOn(jevModelManager, 'getActiveMode').mockReturnValue('remote');
    const query = jest
      .spyOn(JevClientWrapper.prototype, 'query')
      .mockResolvedValue({ result: null, errorReason: 'network_error' });
    try {
      await matchSemanticTarget({
        query: '搜索文档',
        operation: 'fill',
        candidates: [{ id: 's', text: 'Search documentation' }],
      });
      const [state, questions] = query.mock.calls[0];
      expect(state.task).toBe('搜索文档');
      expect(questions.matched_target.instructions).toMatchObject({
        target: expect.stringContaining('`task`'),
        operation: 'fill',
        interpretation: expect.stringContaining('field'),
      });
      expect(Object.keys(questions.matched_target.criteria)).toEqual(['s', 'none']);
    } finally {
      query.mockRestore();
      mode.mockRestore();
    }
  });
  test('reuses only the same task, page and configuration judgment and reports zero new tokens', async () => {
    let revision = 100;
    const mode = jest.spyOn(jevModelManager, 'getActiveMode').mockReturnValue('remote');
    const token = jest
      .spyOn(jevModelManager, 'captureModeToken')
      .mockImplementation(() => ({ activeMode: 'remote', revision }));
    const query = jest.spyOn(JevClientWrapper.prototype, 'query').mockResolvedValue({
      result: {
        model: 'jev-test',
        answers: {
          matched_target: {
            type: 'choice',
            choice: 'a',
            confidence: 0.99,
            probabilities: { a: 0.99, none: 0.01 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      } as any,
      errorReason: null,
    });
    const request = {
      taskId: 'cache-test-scope',
      pageIdentity: 'tab1-document1',
      query: 'Email',
      candidates: [{ id: 'a', text: 'Email address' }],
    };
    try {
      await matchSemanticTarget(request);
      const cached = await matchSemanticTarget(request);
      expect(query).toHaveBeenCalledTimes(1);
      expect(cached).toMatchObject({
        cacheHit: true,
        attempts: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      await matchSemanticTarget({ ...request, pageIdentity: 'tab1-document2' });
      revision++;
      await matchSemanticTarget({ ...request, pageIdentity: 'tab1-document2' });
      await matchSemanticTarget({ ...request, taskId: 'another-task' });
      expect(query).toHaveBeenCalledTimes(4);
    } finally {
      query.mockRestore();
      mode.mockRestore();
      token.mockRestore();
    }
  });
  const answer = (confidence: unknown, choice = 'a') => ({
    type: 'choice',
    choice,
    confidence,
    probabilities: { a: 0.98, b: 0.01, none: 0.01 },
  });
  test.each([0, undefined, NaN, Infinity, -1, 1.1])(
    'never promotes confidence %s',
    (confidence) => {
      expect(classifySemanticAnswer(answer(confidence), ['a', 'b']).status).not.toBe('matched');
    },
  );
  test('accepts only a known, confident candidate', () => {
    expect(classifySemanticAnswer(answer(0.97), ['a', 'b'])).toMatchObject({
      status: 'matched',
      matchedId: 'a',
    });
    expect(classifySemanticAnswer(answer(0.97, 'invented'), ['a', 'b']).status).toBe('unavailable');
  });
  test('none and ambiguity are valid judgments', () => {
    expect(
      classifySemanticAnswer(
        { type: 'choice', choice: 'none', confidence: 1, probabilities: { a: 0, b: 0, none: 1 } },
        ['a', 'b'],
      ).status,
    ).toBe('none');
    expect(
      classifySemanticAnswer(
        {
          type: 'choice',
          choice: 'a',
          confidence: 0.1,
          probabilities: { a: 0.5, b: 0.49, none: 0.01 },
        },
        ['a', 'b'],
      ).status,
    ).toBe('ambiguous');
  });
  test('does not call a model for invalid coverage or cancelled work', async () => {
    const query = jest.spyOn(JevClientWrapper.prototype, 'query');
    try {
      expect(
        (
          await matchSemanticTarget({
            candidates: Array.from({ length: 33 }, (_, id) => ({ id, text: 'Email' })),
          })
        ).status,
      ).toBe('unavailable');
      const controller = new AbortController();
      controller.abort();
      expect(
        (await matchSemanticTarget({ candidates: [{ id: 'a', text: 'Email' }] }, controller.signal))
          .status,
      ).toBe('cancelled');
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });
  test('service errors do not produce an alternative target', async () => {
    const mode = jest.spyOn(jevModelManager, 'getActiveMode').mockReturnValue('remote');
    const query = jest
      .spyOn(JevClientWrapper.prototype, 'query')
      .mockResolvedValue({ result: null, errorReason: 'network_error' });
    try {
      const result = await matchSemanticTarget({
        query: '电子邮箱',
        candidates: [{ id: 'a', text: 'Email' }],
      });
      expect(result).toMatchObject({ success: false, status: 'unavailable' });
      expect(result.matchedId).toBeUndefined();
      expect(query.mock.calls[0][3]).toMatchObject({ retry: { maxRetries: 0 } });
    } finally {
      query.mockRestore();
      mode.mockRestore();
    }
  });
});
