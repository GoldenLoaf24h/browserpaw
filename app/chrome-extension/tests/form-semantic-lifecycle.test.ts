import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeLocatorSemanticMatch,
  matchSemantically,
  type MatchCandidate,
} from '../utils/form-semantic-matcher';
import * as nativeHost from '../entrypoints/background/native-host';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';

describe('Form Semantic Lifecycle & Non-Heuristic Contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('chrome', {
      ...chrome,
      tabs: {
        ...chrome.tabs,
        get: vi.fn(async () => ({ id: 101, url: 'https://example.com/form' })),
      },
      scripting: { executeScript: vi.fn(async () => [{ result: undefined }]) },
    });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, run) =>
      run({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('preserves confirmed fields and the original uncertain click without trying another action', async () => {
    vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 101,
      url: 'https://example.com/form',
    });
    let filled = false;
    vi.spyOn(fillCore, 'performPhysicalFill').mockImplementation(async () => {
      filled = true;
      return { success: true, committed: true } as any;
    });
    const original = {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            status: 'unknown',
            requestDispatched: true,
            error: 'lost click response',
          }),
        },
      ],
    };
    const click = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue(original);
    const keys = vi.spyOn(cdpSessionManager, 'sendCommand');
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, name: string) =>
        [
          {
            documentId: 'doc',
            result:
              name === 'inPageDetectPerceptiveSignature'
                ? {
                    question: filled ? 'Agreement' : 'Name',
                    alerts: [],
                    activeInputs: [{ index: 1, type: 'text', name: 'name' }],
                  }
                : name === 'inPageLocateByText'
                  ? { success: true, index: 3 }
                  : { detected: false },
          },
        ] as any,
    );
    const response = await formPipelineTool.execute({
      fields: [
        { query: 'Name', value: 'Test' },
        { query: 'Agreement', type: 'choice', value: 'Yes' },
      ],
      tabId: 101,
      autoAdvance: false,
      maxSteps: 2,
    });
    const text = response.content.filter((c) => c.type === 'text').at(-1) as any;
    let data;
    try {
      data = JSON.parse(text.text);
    } catch {
      data = { error: text.text };
    }
    expect(data).toMatchObject({
      status: 'unknown',
      retry: false,
      completedFields: [{ query: 'Name' }],
      lastReceipt: original,
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
  });

  it.each(['', 'Pizza Size'])(
    'chooses among input identities once with question %j',
    async (question) => {
      vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 101,
        url: 'https://example.com/form',
      });
      const fill = vi
        .spyOn(fillCore, 'performPhysicalFill')
        .mockResolvedValue({ success: true, committed: true } as any);
      const infer = vi
        .spyOn(nativeHost, 'sendJevMatchToNative')
        .mockImplementation(async (payload: any) => ({
          success: true,
          status: 'matched',
          matchedId: payload.candidates.some((c: any) => c.id === 2) ? 2 : 0,
          confidence: 0.99,
          engine: 'jev',
          backend: 'remote',
          model: 'jev-1.14.0',
          latencyMs: 240,
          attempts: 1,
          usage: { inputTokens: 123, outputTokens: 7 },
        }));
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (_target: any, name: string) =>
          [
            {
              documentId: 'doc',
              result:
                name === 'inPageDetectPerceptiveSignature'
                  ? {
                      question,
                      alerts: [],
                      activeInputs: [
                        { index: 1, type: 'text', name: 'given_name' },
                        { index: 2, type: 'text', name: 'contact_email' },
                      ],
                    }
                  : name === 'inPageLocateByText'
                    ? { success: true, index: 99, tagName: 'label' }
                    : { detected: false },
            },
          ] as any,
      );
      const response = await formPipelineTool.execute({
        fields: [{ query: '电子邮箱', value: 'test@example.com' }],
        tabId: 101,
        autoAdvance: false,
        maxSteps: 1,
      });
      expect(response.isError).toBe(false);
      expect(infer).toHaveBeenCalledTimes(1);
      expect(infer.mock.calls[0][0]).toMatchObject({
        query: '电子邮箱',
        candidates: [{ id: 1 }, { id: 2 }],
      });
      expect(fill).toHaveBeenCalledWith(expect.objectContaining({ target: 2 }));
      const payload = JSON.parse(
        (response.content.filter((c) => c.type === 'text').at(-1) as any).text,
      );
      expect(payload.semanticDecisions).toEqual([
        expect.objectContaining({
          step: 1,
          status: 'matched',
          backend: 'remote',
          model: 'jev-1.14.0',
          latencyMs: 240,
          attempts: 1,
          usage: { inputTokens: 123, outputTokens: 7 },
        }),
      ]);
    },
  );

  it('never uploads an unobserved choice answer as a semantic query', async () => {
    const infer = vi
      .spyOn(nativeHost, 'sendJevMatchToNative')
      .mockResolvedValue({ success: false, status: 'none' });
    expect(
      await matchSemantically(
        'choice',
        'Security answer',
        [{ id: 'a', text: 'An observed answer' }],
        'private-unobserved-answer',
      ),
    ).toBeNull();
    expect(infer).not.toHaveBeenCalled();
  });

  it('targets the named input rather than the first input when a question identifies the field', async () => {
    vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 101,
      url: 'https://example.com/form',
    });
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'Name value',
      method: 'cdp_native',
      isTrusted: true,
    });
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
      async (_target: any, name: string) =>
        [
          {
            documentId: 'doc',
            result:
              name === 'inPageDetectPerceptiveSignature'
                ? {
                    question: 'Name',
                    activeInputs: [
                      { index: 1, tagName: 'input', type: 'text', name: 'email' },
                      { index: 2, tagName: 'input', type: 'text', name: 'name' },
                    ],
                    alerts: [],
                  }
                : name === 'inPageLocateByLabel'
                  ? { success: true, index: 2 }
                  : { detected: false },
          },
        ] as any,
    );
    const response = await formPipelineTool.execute({
      fields: [{ query: 'Name', value: 'Name value' }],
      tabId: 101,
      autoAdvance: false,
      maxSteps: 1,
    });
    expect(response.isError).toBe(false);
    expect(fill).toHaveBeenCalledWith(expect.objectContaining({ target: 2 }));
  });

  describe('1. executeLocatorSemanticMatch deadline bounding & payload reservation', () => {
    it('bounds effectiveDeadlineAt to min(callerDeadline, now + 1500) when caller passes a 30s deadline', async () => {
      let capturedPayload: any;
      let capturedTimeout: number | undefined;
      let capturedOptions: any;

      const mockSend = vi.fn(async (payload, timeoutMs, options) => {
        capturedPayload = payload;
        capturedTimeout = timeoutMs;
        capturedOptions = options;
        return { success: true, status: 'matched', matchedId: 'c1', confidence: 0.95 };
      });

      const now = Date.now();
      const callerDeadline = now + 30000; // 30s deadline
      const res = await executeLocatorSemanticMatch({
        query: 'Submit form',
        candidates: [{ id: 'c1', text: 'Submit' }],
        deadlineAt: callerDeadline,
        sendJevMatch: mockSend,
      });

      expect(res.success).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
      // effectiveDeadlineAt should be around now + 1500, not now + 30000
      expect(capturedPayload.deadlineAt).toBeLessThanOrEqual(now + 1600);
      expect(capturedPayload.deadlineAt).toBeGreaterThanOrEqual(now + 1400);
      expect(capturedOptions.deadlineAt).toBe(capturedPayload.deadlineAt);
      expect(capturedTimeout).toBeLessThanOrEqual(1500);
    });

    it('preserves shorter caller deadline and passes taskId/pageIdentity to payload without local caching', async () => {
      let capturedPayload: any;
      const mockSend = vi.fn(async (payload) => {
        capturedPayload = payload;
        return {
          success: true,
          status: 'matched',
          matchedId: 'c1',
          confidence: 0.96,
          cacheHit: true,
        };
      });

      const now = Date.now();
      const shortDeadline = now + 400;
      const res = await executeLocatorSemanticMatch({
        query: 'Confirm',
        candidates: [{ id: 'c1', text: 'Confirm' }],
        deadlineAt: shortDeadline,
        taskId: 'task_abc_123',
        pageIdentity: 'page_login_v1',
        sendJevMatch: mockSend,
      });

      expect(res.success).toBe(true);
      expect(res.cacheHit).toBe(true);
      expect(capturedPayload.deadlineAt).toBe(shortDeadline);
      expect(capturedPayload.taskId).toBe('task_abc_123');
      expect(capturedPayload.pageIdentity).toBe('page_login_v1');
    });
  });

  describe('2. matchSemantically contract: literal zero-inference, 32 cap, budget & cancellation', () => {
    it('literal match returns engine=literal with zero inference and does not consume budget', async () => {
      const sendSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
        success: true,
        status: 'matched',
        matchedId: '1',
        confidence: 0.95,
      });

      const budget = { remaining: 1 };
      const candidates: MatchCandidate[] = [
        { id: '1', text: 'Email Address' },
        { id: '2', text: 'Phone Number' },
      ];

      const res = await matchSemantically(
        'field',
        'Email Address',
        candidates,
        undefined,
        undefined,
        {
          inferenceBudget: budget,
        },
      );

      expect(res).toEqual({
        matchedId: '1',
        confidence: 1.0,
        engine: 'literal',
      });
      // Zero inference calls
      expect(sendSpy).not.toHaveBeenCalled();
      // Budget untouched
      expect(budget.remaining).toBe(1);
    });

    it('overflow with > 32 candidates does not send IPC and does not consume budget', async () => {
      const sendSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
        success: true,
        status: 'matched',
        matchedId: '1',
        confidence: 0.95,
      });

      const budget = { remaining: 1 };
      const candidates: MatchCandidate[] = Array.from({ length: 33 }, (_, i) => ({
        id: String(i),
        text: 'Field ' + i,
      }));

      const res = await matchSemantically(
        'field',
        'Different Non-Literal Query',
        candidates,
        undefined,
        undefined,
        {
          inferenceBudget: budget,
        },
      );

      expect(res).toBeNull();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(budget.remaining).toBe(1);
    });

    it('aborted signal or expired deadline passes through and does not send IPC', async () => {
      const sendSpy = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
        success: true,
        status: 'matched',
        matchedId: '1',
        confidence: 0.95,
      });

      const controller = new AbortController();
      controller.abort();
      const budget = { remaining: 1 };

      const resAborted = await matchSemantically(
        'field',
        'Non-literal Query',
        [{ id: '1', text: 'Some Target' }],
        undefined,
        undefined,
        {
          signal: controller.signal,
          inferenceBudget: budget,
        },
      );

      expect(resAborted).toBeNull();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(budget.remaining).toBe(1);

      const resExpired = await matchSemantically(
        'field',
        'Non-literal Query',
        [{ id: '1', text: 'Some Target' }],
        undefined,
        undefined,
        {
          deadlineAt: Date.now() - 100,
          inferenceBudget: budget,
        },
      );

      expect(resExpired).toBeNull();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(budget.remaining).toBe(1);
    });

    it('consumes budget only right before attempting Jev semantic IPC and passes signal/deadline/taskId', async () => {
      let capturedPayload: any;
      let capturedTimeout: number | undefined;
      let capturedOptions: any;

      vi.spyOn(nativeHost, 'sendJevMatchToNative').mockImplementation(
        async (payload, timeoutMs, options) => {
          capturedPayload = payload;
          capturedTimeout = timeoutMs;
          capturedOptions = options;
          return {
            success: true,
            status: 'matched',
            matchedId: 'cand_1',
            confidence: 0.92,
            cacheHit: true,
          };
        },
      );

      const budget = { remaining: 1 };
      const controller = new AbortController();
      const now = Date.now();
      const deadlineAt = now + 5000;

      const res = await matchSemantically(
        'field',
        '联系方式',
        [{ id: 'cand_1', text: 'Contact Information' }],
        undefined,
        undefined,
        {
          signal: controller.signal,
          deadlineAt,
          inferenceBudget: budget,
          taskId: 'task_form_42',
          pageIdentity: 'form_p1',
        },
      );

      expect(res).toEqual({
        matchedId: 'cand_1',
        confidence: 0.92,
        engine: 'jev',
        cacheHit: true,
      });
      // Budget was consumed
      expect(budget.remaining).toBe(0);
      expect(capturedPayload.query).toBe('联系方式');
      expect(capturedPayload.taskId).toBe('task_form_42');
      expect(capturedPayload.pageIdentity).toBe('form_p1');
      expect(capturedOptions.signal).toBe(controller.signal);
      expect(capturedOptions.deadlineAt).toBeLessThanOrEqual(now + 1600);
      expect(capturedTimeout).toBeLessThanOrEqual(1500);

      // Attempt second call with exhausted budget: should return null without IPC
      const callsBefore = vi.mocked(nativeHost.sendJevMatchToNative).mock.calls.length;
      const secondRes = await matchSemantically(
        'field',
        '手机号',
        [{ id: 'cand_2', text: 'Phone' }],
        undefined,
        undefined,
        {
          inferenceBudget: budget,
        },
      );
      expect(secondRes).toBeNull();
      expect(nativeHost.sendJevMatchToNative).toHaveBeenCalledTimes(callsBefore);
    });
  });

  describe('3. Real pipeline semantic revalidation', () => {
    const initial = {
      question: 'Phone contact',
      progress: '1 / 2',
      url: 'https://example.com/form',
      title: 'Form',
      activeInputs: [{ index: 5, name: 'phone', tagName: 'input', type: 'text' }],
      alerts: [],
    };

    it.each(['question', 'document', 'input'] as const)(
      'stops before fill when %s changes during inference',
      async (change) => {
        vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
          id: 101,
          url: initial.url,
        });
        let inferenceComplete = false;
        const send = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockImplementation(async () => {
          inferenceComplete = true;
          return { success: true, status: 'matched', matchedId: 0, confidence: 0.99 };
        });
        const fill = vi.spyOn(fillCore, 'performPhysicalFill');
        let reads = 0;
        vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
          async (_target: any, name: string) => {
            if (name !== 'inPageDetectPerceptiveSignature')
              return [{ result: { detected: false } }] as any;
            reads++;
            const updated = !inferenceComplete
              ? initial
              : {
                  ...initial,
                  ...(change === 'question' ? { question: 'Account password' } : {}),
                  ...(change === 'input'
                    ? {
                        activeInputs: [
                          { index: 5, name: 'password', tagName: 'input', type: 'password' },
                        ],
                      }
                    : {}),
                };
            return [
              {
                documentId:
                  inferenceComplete && change === 'document' ? 'new-document' : 'document',
                result: updated,
              },
            ] as any;
          },
        );
        const response = await formPipelineTool.execute({
          tabId: 101,
          fields: [{ query: '联系电话', value: 'private value' }],
          maxSteps: 1,
          autoAdvance: false,
        });
        expect(JSON.parse((response.content[0] as any).text)).toMatchObject({
          status: 'interrupted',
          reason: 'semantic_target_changed',
          completedFields: [],
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(fill).not.toHaveBeenCalled();
      },
    );

    it('uses one semantic request per step and never sends the filling values', async () => {
      vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 101,
        url: initial.url,
      });
      let stage = 0;
      const send = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockImplementation(async () => ({
        success: true,
        status: 'matched',
        matchedId: stage,
        confidence: 0.99,
      }));
      vi.spyOn(fillCore, 'performPhysicalFill').mockImplementation(async () => {
        stage++;
        return {
          success: true,
          committed: true,
          filledText: 'private value',
          method: 'cdp_native',
          isTrusted: true,
        };
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (_target: any, name: string) =>
          [
            {
              documentId: 'document',
              result:
                name === 'inPageDetectPerceptiveSignature'
                  ? {
                      ...initial,
                      question: stage === 0 ? 'Phone contact' : 'E-mail contact',
                      progress: String(stage + 1),
                      activeInputs: [
                        {
                          index: stage + 5,
                          name: stage === 0 ? 'phone' : 'email',
                          tagName: 'input',
                          type: 'text',
                        },
                      ],
                    }
                  : { detected: false },
            },
          ] as any,
      );
      const response = await formPipelineTool.execute({
        tabId: 101,
        fields: [
          { query: '联系电话', value: 'private phone value' },
          { query: '电子信箱', value: 'private mail value' },
        ],
        maxSteps: 2,
        autoAdvance: false,
      });
      expect(response.isError).toBe(false);
      expect(stage).toBe(2);
      expect(send).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(send.mock.calls)).not.toContain('private');
    });
  });
});
