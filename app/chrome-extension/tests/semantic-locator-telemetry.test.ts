import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeLocatorSemanticMatch, matchSemantically } from '../utils/form-semantic-matcher';
import { resolveTargetLocation } from '../utils/unified-locator';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import * as locatorModule from '../entrypoints/background/tools/browser/unified-locator';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import * as nativeHost from '../entrypoints/background/native-host';

describe('Semantic locator telemetry pass-through', () => {
  beforeEach(() => {
    (globalThis as any).chrome = {
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: 'win' })),
      },
      tabs: {
        get: vi.fn(async () => ({ id: 20, url: 'https://example.com/' })),
        onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      webNavigation: {
        onCreatedNavigationTarget: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. executeLocatorSemanticMatch passes through backend, latencyMs, usage, attempts', async () => {
    const mockSendJev = vi.fn().mockResolvedValue({
      success: true,
      status: 'matched',
      matchedId: 'cand-1',
      confidence: 0.95,
      model: 'jev-test-model',
      engine: 'jev',
      backend: 'remote',
      latencyMs: 142,
      usage: { inputTokens: 520, outputTokens: 8 },
      attempts: 1,
      cacheHit: false,
    });

    const res = await executeLocatorSemanticMatch({
      query: '电子邮箱',
      candidates: [{ id: 'cand-1', text: '请输入邮箱' }],
      sendJevMatch: mockSendJev,
    });

    expect(res.success).toBe(true);
    expect(res.backend).toBe('remote');
    expect(res.latencyMs).toBe(142);
    expect(res.usage).toEqual({ inputTokens: 520, outputTokens: 8 });
    expect(res.attempts).toBe(1);
  });

  it('2. matchSemantically calls onDecision on model call but not on literal match', async () => {
    const onDecision = vi.fn();
    const infer = vi.spyOn(nativeHost, 'sendJevMatchToNative').mockResolvedValue({
      success: false,
      status: 'none',
      backend: 'remote',
      attempts: 1,
      usage: { inputTokens: null, outputTokens: null },
    });

    // Model path: query does not exactly match candidate text
    await matchSemantically(
      'field',
      '电子邮箱地址',
      [{ id: 1, text: '联系邮箱' }],
      undefined,
      undefined,
      { onDecision } as any,
    );

    // Literal path: exact match should NOT call onDecision
    const onDecisionLiteral = vi.fn();
    const literalRes = await matchSemantically(
      'field',
      'email',
      [{ id: 1, text: 'email' }],
      undefined,
      undefined,
      { onDecision: onDecisionLiteral } as any,
    );

    expect(literalRes?.matchedId).toBe(1);
    expect(onDecisionLiteral).not.toHaveBeenCalled();
    expect(infer).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'none',
        backend: 'remote',
        attempts: 1,
        usage: { inputTokens: null, outputTokens: null },
      }),
    );
  });

  it.each(['matched', 'none', 'unavailable', 'changed'])(
    'keeps real locator diagnostics after %s',
    async (scenario) => {
      const matching = scenario === 'matched' || scenario === 'changed';
      const mockDeps = {
        semanticEnabled: () => true,
        executeInPage: vi.fn().mockImplementation(async (_target, fnName) => {
          if (fnName === 'inPageLocateByText') {
            return [
              { frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } },
            ];
          }
          if (fnName === 'inPageDOMPruner') {
            return [
              {
                frameId: 0,
                documentId: 'doc-1',
                result: {
                  indexedElements: [
                    {
                      index: 5,
                      tagName: 'input',
                      role: 'textbox',
                      text: '电子邮箱输入框',
                      attributes: {},
                    },
                  ],
                },
              },
            ];
          }
          if (fnName === 'inPageGetElementCoordinates') {
            return [
              {
                frameId: 0,
                documentId: scenario === 'changed' ? 'doc-2' : 'doc-1',
                result: {
                  success: true,
                  x: 100,
                  y: 200,
                  tagName: 'input',
                  role: 'textbox',
                  text: '电子邮箱输入框',
                  attributes: {},
                  isClickable: true,
                },
              },
            ];
          }
          return [{ frameId: 0, documentId: 'doc-1', result: { success: false, notFound: true } }];
        }),
        sendJevMatch: vi.fn().mockResolvedValue({
          success: matching,
          status: matching ? 'matched' : scenario,
          matchedId: matching ? 'cand_0_5' : undefined,
          confidence: 0.96,
          model: 'jev-test-v2',
          backend: 'remote',
          latencyMs: 88,
          usage: { inputTokens: 340, outputTokens: 6 },
          attempts: 1,
          cacheHit: false,
        }),
      };

      const res = await resolveTargetLocation(1, { text: '电子邮箱' }, mockDeps as any);

      expect(res.success).toBe(scenario === 'matched');
      if (scenario === 'matched') expect(res.resolutionPath).toBe('semantic');
      expect(res.semanticBackend).toBe('remote');
      expect(res.semanticLatencyMs).toBe(88);
      expect(res.semanticUsage).toEqual({ inputTokens: 340, outputTokens: 6 });
      expect(res.semanticAttempts).toBe(1);
      expect(res.semanticModel).toBe('jev-test-v2');
    },
  );

  it('4. batchActionsTool.execute preserves semantic metadata in output on fill success', async () => {
    vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 20,
      url: 'https://example.com/',
    });
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageDetectPerceptiveSignature') return [{ result: null }] as any;
      return [{ result: { success: true } }] as any;
    });
    vi.spyOn(locatorModule, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 100,
      y: 200,
      index: 5,
      tagName: 'input',
      resolutionPath: 'semantic',
      semanticBackend: 'remote',
      semanticModel: 'jev-test-model',
      semanticLatencyMs: 120,
      semanticUsage: { inputTokens: 450, outputTokens: 8 },
      semanticAttempts: 1,
      semanticConfidence: 0.94,
      semanticCacheHit: false,
    } as any);
    vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      index: 5,
      ref: 5,
    } as any);

    const toolResult = await batchActionsTool.execute({
      tabId: 20,
      actions: [
        {
          type: 'fill',
          targetText: '联系邮箱',
          value: 'user@example.com',
        } as any,
      ],
    });

    expect(toolResult.isError).toBe(false);
    const parsed = JSON.parse(toolResult.content[0].text);
    expect(parsed.success).toBe(true);
    const step = parsed.results[0];
    expect(step.output.resolutionPath).toBe('semantic');
    expect(step.output.semanticBackend).toBe('remote');
    expect(step.output.semanticModel).toBe('jev-test-model');
    expect(step.output.semanticLatencyMs).toBe(120);
    expect(step.output.semanticUsage).toEqual({ inputTokens: 450, outputTokens: 8 });
    expect(step.output.semanticAttempts).toBe(1);
    expect(step.output.semanticCacheHit).toBe(false);
    expect(step.output.semanticConfidence).toBe(0.94);
  });

  it('5. batchActionsTool.execute preserves locator diagnostics on failure', async () => {
    vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 20,
      url: 'https://example.com/',
    });
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageDetectPerceptiveSignature') return [{ result: null }] as any;
      return [{ result: { success: true } }] as any;
    });
    vi.spyOn(locatorModule, 'resolveTargetLocation').mockResolvedValue({
      success: false,
      x: 0,
      y: 0,
      resolutionPath: 'text',
      notFound: true,
      error: 'Target not found',
      semanticStatus: 'none',
      semanticBackend: 'local',
      semanticModel: 'jev-local-v1',
      semanticLatencyMs: 35,
      semanticUsage: { inputTokens: 80, outputTokens: 2 },
      semanticAttempts: 1,
      semanticCacheHit: false,
    } as any);

    const toolResult = await batchActionsTool.execute({
      tabId: 20,
      actions: [
        {
          type: 'fill',
          targetText: '未匹配字段',
          value: 'test',
        } as any,
      ],
    });

    const parsed = JSON.parse(toolResult.content[0].text);
    expect(parsed.success).toBe(false);
    const failedStep = parsed.results[0];
    expect(failedStep.success).toBe(false);
    expect(failedStep.resolutionPath).toBe('text');
    expect(failedStep.semanticStatus).toBe('none');
    expect(failedStep.semanticBackend).toBe('local');
    expect(failedStep.semanticModel).toBe('jev-local-v1');
    expect(failedStep.semanticLatencyMs).toBe(35);
    expect(failedStep.semanticUsage).toEqual({ inputTokens: 80, outputTokens: 2 });
    expect(failedStep.semanticAttempts).toBe(1);
  });
});
