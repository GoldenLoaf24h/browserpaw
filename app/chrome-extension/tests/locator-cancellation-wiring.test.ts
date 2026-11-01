import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickTool, fillTool } from '../entrypoints/background/tools/browser/interaction';
import { keyboardTool } from '../entrypoints/background/tools/browser/keyboard';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import * as unifiedLocator from '../entrypoints/background/tools/browser/unified-locator';
import * as fillCoreModule from '../entrypoints/background/tools/browser/fill-core';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as raceCdpModule from '../utils/race-cdp';

describe('locator cancellation, operation and deadline wiring', () => {
  const TAB_ID = 101;
  const TEST_URL = 'https://example.com';

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: { getPlatformInfo: vi.fn(async () => ({ os: 'linux' })) },
      tabs: {
        get: vi.fn(async () => ({ id: TAB_ID, url: TEST_URL })),
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: undefined }]),
      },
    });

    vi.spyOn(clickTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: TAB_ID,
      url: TEST_URL,
    });
    vi.spyOn(fillTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: TAB_ID,
      url: TEST_URL,
    });
    vi.spyOn(keyboardTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: TAB_ID,
      url: TEST_URL,
    });
    vi.spyOn(fillIndexTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: TAB_ID,
      url: TEST_URL,
    });
    vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: TAB_ID,
      url: TEST_URL,
    });
    vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: TAB_ID,
      url: TEST_URL,
    });

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, run) =>
      run({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);

    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageGetElementCoordinates')
        return [{ result: { success: true, x: 100, y: 100 } }] as any;
      if (fnName === 'inPageCheckOcclusion') return [{ result: { x: 100, y: 100 } }] as any;
      if (fnName === 'inPageGetScrollState')
        return [
          {
            result: {
              success: true,
              scrollX: 0,
              scrollY: 0,
              viewportWidth: 1280,
              viewportHeight: 800,
            },
          },
        ] as any;
      if (fnName === 'inPageCheckCaptcha') return [{ result: { detected: false } }] as any;
      if (fnName === 'inPageDetectPerceptiveSignature') {
        return [
          {
            result: {
              question: 'What is your email?',
              activeInputs: [
                { index: 10, name: 'email', placeholder: 'Email', text: 'Email', type: 'text' },
              ],
              alerts: [],
            },
          },
        ] as any;
      }
      if (fnName === 'inPageLocateByText') {
        return [{ result: { success: true, index: 10, tagName: 'input' } }] as any;
      }
      return [
        {
          result: {
            success: true,
            scrollX: 0,
            scrollY: 0,
            viewportWidth: 1280,
            viewportHeight: 800,
          },
        },
      ] as any;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the original cancellation context when a click delegates to the shared executor', async () => {
    vi.spyOn(unifiedLocator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      index: 10,
      x: 100,
      y: 100,
      resolutionPath: 'text',
    });
    const delegated = vi
      .spyOn(interactIndexTool, 'execute')
      .mockResolvedValue({ content: [], isError: false });
    const context = { signal: new AbortController().signal, taskId: 'task-scope' };
    await clickTool.execute({ label: 'Search', exact: true, tabId: TAB_ID }, context);
    expect(unifiedLocator.resolveTargetLocation).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({ label: 'Search', exact: true, taskId: 'task-scope' }),
    );
    expect(delegated.mock.calls[0]?.[1]).toBe(context);
  });

  it('wires context.signal, deadlineAt and operation click into clickTool locator and aborts before dispatch', async () => {
    let capturedOptions: any = null;
    vi.spyOn(unifiedLocator, 'resolveTargetLocation').mockImplementation(
      async (_tabId, options: any) => {
        capturedOptions = options;
        return { success: true, index: 5, x: 100, y: 100, resolutionPath: 'text' };
      },
    );

    const interactSpy = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });

    const controller = new AbortController();
    const deadlineAt = Date.now() + 5000;

    // First call: locator gets signal, deadlineAt and operation click
    const res = await clickTool.execute(
      { text: 'Submit', tabId: TAB_ID, ...({ deadlineAt } as any) },
      { signal: controller.signal },
    );
    expect(res.isError).toBe(false);
    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.signal).toBe(controller.signal);
    expect(capturedOptions.deadlineAt).toBe(deadlineAt);
    expect(capturedOptions.operation).toBe('click');
    expect(interactSpy).toHaveBeenCalledTimes(1);

    // Second call: aborted signal must not dispatch click
    controller.abort();
    interactSpy.mockClear();

    const abortedRes = await clickTool.execute(
      { text: 'Submit', tabId: TAB_ID },
      { signal: controller.signal },
    );
    expect(abortedRes.isError).toBe(true);
    expect(interactSpy).not.toHaveBeenCalled();
  });

  it('wires context.signal, deadlineAt and operation fill into fillTool and performPhysicalFill', async () => {
    let capturedLocOptions: any = null;
    vi.spyOn(unifiedLocator, 'resolveTargetLocation').mockImplementation(
      async (_tabId, options: any) => {
        capturedLocOptions = options;
        return { success: true, index: 3, x: 50, y: 50, resolutionPath: 'text' };
      },
    );

    let capturedFillOptions: any = null;
    vi.spyOn(fillCoreModule, 'performPhysicalFill').mockImplementation(async (options: any) => {
      capturedFillOptions = options;
      return {
        success: true,
        committed: true,
        filledText: options.text,
        isTrusted: true,
        method: 'cdp_native',
      };
    });

    const controller = new AbortController();
    const deadlineAt = Date.now() + 4000;

    const res = await fillTool.execute(
      { text: 'test value', targetText: 'Username', tabId: TAB_ID, ...({ deadlineAt } as any) },
      { signal: controller.signal },
    );
    expect(res.isError).toBe(false);
    expect(capturedLocOptions.signal).toBe(controller.signal);
    expect(capturedLocOptions.deadlineAt).toBe(deadlineAt);
    expect(capturedLocOptions.operation).toBe('fill');
    expect(capturedFillOptions.signal).toBe(controller.signal);
    expect(capturedFillOptions.deadlineAt).toBe(deadlineAt);

    // When signal is aborted, performPhysicalFill is not called
    controller.abort();
    const fillSpy = vi.spyOn(fillCoreModule, 'performPhysicalFill');
    fillSpy.mockClear();

    const abortedRes = await fillTool.execute(
      { text: 'test value', targetText: 'Username', tabId: TAB_ID },
      { signal: controller.signal },
    );
    expect(abortedRes.isError).toBe(true);
    expect(fillSpy).not.toHaveBeenCalled();
  });

  it('wires context.signal, deadlineAt and operation press into keyboardTool and aborts before key dispatch', async () => {
    let capturedLocOptions: any = null;
    vi.spyOn(unifiedLocator, 'resolveTargetLocation').mockImplementation(
      async (_tabId, options: any) => {
        capturedLocOptions = options;
        return { success: true, index: 2, x: 20, y: 20, resolutionPath: 'text' };
      },
    );

    const sendCommandSpy = vi.spyOn(cdpSessionManager, 'sendCommand');

    const controller = new AbortController();
    const deadlineAt = Date.now() + 3000;

    const res = await keyboardTool.execute(
      { keys: 'Enter', text: 'Search Input', tabId: TAB_ID, ...({ deadlineAt } as any) },
      { signal: controller.signal },
    );
    expect(res.isError).toBe(false);
    expect(capturedLocOptions.signal).toBe(controller.signal);
    expect(capturedLocOptions.deadlineAt).toBe(deadlineAt);
    expect(capturedLocOptions.operation).toBe('press');
    expect(sendCommandSpy).toHaveBeenCalled();

    // Aborted signal must abort before key dispatch
    controller.abort();
    sendCommandSpy.mockClear();

    const abortedRes = await keyboardTool.execute(
      { keys: 'Enter', text: 'Search Input', tabId: TAB_ID },
      { signal: controller.signal },
    );
    expect(abortedRes.isError).toBe(true);
    expect(sendCommandSpy).not.toHaveBeenCalled();
  });

  it('wires context.signal and deadlineAt into fillIndexTool', async () => {
    let capturedFillOptions: any = null;
    vi.spyOn(fillCoreModule, 'performPhysicalFill').mockImplementation(async (options: any) => {
      capturedFillOptions = options;
      return {
        success: true,
        committed: true,
        filledText: options.text,
        isTrusted: true,
        method: 'cdp_native',
      };
    });

    const controller = new AbortController();
    const deadlineAt = Date.now() + 2500;

    const res = await fillIndexTool.execute(
      { index: 1, text: 'hello', tabId: TAB_ID, ...({ deadlineAt } as any) },
      { signal: controller.signal },
    );
    expect(res.isError).toBe(false);
    expect(capturedFillOptions.signal).toBe(controller.signal);
    expect(capturedFillOptions.deadlineAt).toBe(deadlineAt);

    controller.abort();
    const abortedRes = await fillIndexTool.execute(
      { index: 1, text: 'hello', tabId: TAB_ID },
      { signal: controller.signal },
    );
    expect(abortedRes.isError).toBe(true);
  });

  it('wires context.signal and deadlineAt into batchActionsTool locator and performPhysicalFill', async () => {
    let capturedLocOptions: any = null;
    vi.spyOn(unifiedLocator, 'resolveTargetLocation').mockImplementation(
      async (_tabId, options: any) => {
        capturedLocOptions = options;
        return { success: true, index: 4, x: 40, y: 40, resolutionPath: 'text' };
      },
    );

    let capturedFillOptions: any = null;
    vi.spyOn(fillCoreModule, 'performPhysicalFill').mockImplementation(async (options: any) => {
      capturedFillOptions = options;
      return {
        success: true,
        committed: true,
        filledText: options.text,
        isTrusted: true,
        method: 'cdp_native',
      };
    });

    const controller = new AbortController();
    const deadlineAt = Date.now() + 6000;

    const res = await batchActionsTool.execute(
      {
        tabId: TAB_ID,
        actions: [
          { type: 'click', text: 'Button A', ...({ deadlineAt } as any) },
          { type: 'fill', text: 'Text B', targetText: 'Input B', ...({ deadlineAt } as any) },
        ],
      },
      { signal: controller.signal },
    );

    expect(res.isError).toBe(false);
    expect(capturedLocOptions.signal).toBe(controller.signal);
    expect(capturedLocOptions.deadlineAt).toBe(deadlineAt);
    expect(capturedFillOptions.signal).toBe(controller.signal);
    expect(capturedFillOptions.deadlineAt).toBe(deadlineAt);
  });

  it('performPhysicalFill aborts before dispatching mouse or key events if signal is aborted', async () => {
    const sendCommandSpy = vi.spyOn(cdpSessionManager, 'sendCommand');
    const controller = new AbortController();
    controller.abort();

    await expect(
      performPhysicalFill({
        tabId: TAB_ID,
        target: 1,
        text: 'should-not-type',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Task cancelled/);

    expect(sendCommandSpy).not.toHaveBeenCalled();
  });

  it('wires context.signal into formPipeline dispatchNativeClick and performPhysicalFill', async () => {
    let capturedInteractContext: any = null;
    vi.spyOn(interactIndexTool, 'execute').mockImplementation(async (_args: any, context?: any) => {
      capturedInteractContext = context;
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        isError: false,
      };
    });

    let capturedFillOptions: any = null;
    vi.spyOn(fillCoreModule, 'performPhysicalFill').mockImplementation(async (options: any) => {
      capturedFillOptions = options;
      return {
        success: true,
        committed: true,
        filledText: options.text,
        isTrusted: true,
        method: 'cdp_native',
      };
    });

    const controller = new AbortController();
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageCheckCaptcha') return [{ result: { detected: false } }] as any;
      if (fnName === 'inPageDetectPerceptiveSignature') {
        return [
          {
            result: {
              question: 'What is your email address?',
              activeInputs: [
                { index: 10, name: 'email', placeholder: 'Email', text: 'Email', type: 'text' },
              ],
              alerts: [],
            },
          },
        ] as any;
      }
      if (fnName === 'inPageLocateByText') {
        return [{ result: { success: true, index: 10, tagName: 'input' } }] as any;
      }
      return [
        {
          result: {
            success: true,
            scrollX: 0,
            scrollY: 0,
            viewportWidth: 1280,
            viewportHeight: 800,
          },
        },
      ] as any;
    });

    const res = await formPipelineTool.execute(
      {
        fields: [{ query: 'email', value: 'user@example.com' }],
        tabId: TAB_ID,
        autoAdvance: false,
      },
      { signal: controller.signal },
    );

    expect(res.isError).toBe(false);
    expect(capturedFillOptions).not.toBeNull();
    expect(capturedFillOptions.signal).toBe(controller.signal);
  });

  it.each(['click', 'fill'] as const)(
    'rejects a changed observed target before native %s dispatch',
    async (operation) => {
      const previous = vi.mocked(inPageEngine.executeInPage).getMockImplementation()!;
      vi.mocked(inPageEngine.executeInPage).mockImplementation(
        async (target, fnName, args, ...rest) => {
          if (fnName === 'inPageValidateObservedGuard') return [{ result: false }] as any;
          if (fnName === 'inPageWaitForActionable')
            return [{ result: { success: true, x: 100, y: 100 } }] as any;
          return previous(target, fnName, args, ...rest);
        },
      );
      const dispatch = vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);
      const response =
        operation === 'click'
          ? await interactIndexTool.execute({
              tabId: TAB_ID,
              index: 10,
              expectedGuard: [10, 'button', 'Search'],
              includeDelta: false,
            })
          : await fillIndexTool.execute({
              tabId: TAB_ID,
              index: 10,
              text: 'value',
              expectedGuard: [10, 'textbox', 'Email'],
              includeDelta: false,
            });
      expect(response.isError).toBe(true);
      const payload = JSON.parse((response.content[0] as any).text);
      expect(payload).toMatchObject({ status: 'blocked', requestDispatched: false });
      expect(
        dispatch.mock.calls.some(
          ([, name, args]) =>
            name === 'Input.insertText' ||
            (name === 'Input.dispatchMouseEvent' && (args as any)?.type === 'mousePressed'),
        ),
      ).toBe(false);
    },
  );

  it('interactIndexTool respects signal before mousePressed and preserves unknown post-dispatch', async () => {
    let mousePressCalled = false;
    let mouseReleasedCalled = false;

    // Case A: aborted before action starts
    const controllerA = new AbortController();
    controllerA.abort();

    const resA = await interactIndexTool.execute(
      { coordinate: { x: 100, y: 100 }, action: 'click', tabId: TAB_ID },
      { signal: controllerA.signal },
    );
    expect(resA.isError).toBe(true);

    // Case B: aborted right after mousePressed dispatches
    const controllerB = new AbortController();
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent') {
        if (params?.type === 'mousePressed') {
          mousePressCalled = true;
          controllerB.abort(); // Cancel during/after mousePressed
        }
        if (params?.type === 'mouseReleased') {
          mouseReleasedCalled = true;
        }
      }
      return {} as any;
    });

    const resB = await interactIndexTool.execute(
      { coordinate: { x: 100, y: 100 }, action: 'click', tabId: TAB_ID },
      { signal: controllerB.signal },
    );

    // Must release mouse so button is not stuck
    expect(mousePressCalled).toBe(true);
    expect(mouseReleasedCalled).toBe(true);
    // Post-dispatch cancellation must preserve status: unknown and retry: false
    expect(resB.isError).toBe(true);
    const parsed = JSON.parse(resB.content[0].type === 'text' ? resB.content[0].text : '{}');
    expect(parsed.status).toBe('unknown');
    expect(parsed.retry).toBe(false);
    expect(parsed.dispatched).toBe(true);
  });
});
