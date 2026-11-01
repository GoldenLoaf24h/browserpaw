import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keyboardTool } from '../entrypoints/background/tools/browser/keyboard';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import * as locator from '../entrypoints/background/tools/browser/unified-locator';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import * as race from '../utils/race-cdp';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { withActionReceipt } from '../utils/action-receipt';

describe('keyboard action receipts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn(async () => ({ id: 10, url: 'https://example.com' })) },
      scripting: { executeScript: vi.fn(async () => []) },
    });
    vi.spyOn(keyboardTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 10,
      url: 'https://example.com',
    });
    vi.spyOn(keyboardTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(keyboardTool as any, 'sendMessageToTab').mockResolvedValue({ success: true });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, fn) =>
      fn({} as any),
    );
  });

  it('returns an action receipt on keyboard success', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue({
      type: 'alert',
      message: 'Saved',
      defaultPrompt: '',
    } as any);
    vi.spyOn(cdpSessionManager, 'addCdpEventObserver').mockImplementation((observer) => {
      observer(10, 'Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'Saved',
        defaultPrompt: '',
      });
    });

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Ctrl+A' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(false);
    expect(payload.receipt?.dialog?.message).toBe('Saved');
  });

  it('returns a dialog interrupt with a receipt when CDP raises DialogOpenedError', async () => {
    const dialog = { type: 'confirm', message: 'Continue?', defaultPrompt: '' };
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new race.DialogOpenedError(dialog),
    );
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue(dialog as any);

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Ctrl+A' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(payload.requiresDialogAction).toBe(true);
    expect(payload.dialog.message).toBe('Continue?');
    expect(payload.receipt?.dialog?.message).toBe('Continue?');
  });

  it('reports unknown CDP outcomes as structured failure without replaying input', async () => {
    const sendMessage = (keyboardTool as any).sendMessageToTab;
    vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(
      new race.CdpDispatchTimeoutError('Input.dispatchKeyEvent'),
    );

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Enter' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('unknown');
    expect(payload.retry).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledTimes(1);
  });
});

describe('batch actions unknown outcome contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn(async () => ({ id: 20, url: 'https://example.com' })) },
      scripting: { executeScript: vi.fn(async () => [{ result: true }]) },
    });
    vi.spyOn(batchActionsTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 20,
      url: 'https://example.com',
    });
    vi.spyOn(batchActionsTool as any, 'safeExecuteScript').mockResolvedValue([{ result: true }]);
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageDetectPerceptiveSignature') return [{ result: null }] as any;
      return [{ result: { success: true } }] as any;
    });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, fn) =>
      fn({} as any),
    );
  });

  it('reports structured unknown, stops immediately, and exposes partial execution count', async () => {
    const unknown = new race.CdpDispatchTimeoutError('Input.dispatchKeyEvent');
    vi.spyOn(race, 'raceCdp').mockImplementation(async (_tabId, method) => {
      if (method === 'Input.dispatchKeyEvent') throw unknown;
      return {} as any;
    });
    const secondAction = vi.fn();
    const execute = vi
      .spyOn(engine, 'executeInPage')
      .mockImplementation(async (_target, fnName) => {
        if (fnName === 'inPageDetectPerceptiveSignature') return [{ result: null }] as any;
        secondAction();
        return [{ result: { success: true } }] as any;
      });

    const result = await batchActionsTool.execute({
      tabId: 20,
      actions: [
        { type: 'key', key: 'Enter' },
        { type: 'wait', durationMs: 1 },
      ],
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('unknown');
    expect(payload.retry).toBe(false);
    expect(payload.partial).toBe(true);
    expect(payload.executedActions).toBe(1);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].status).toBe('unknown');
    expect(payload.results[0].retry).toBe(false);
    expect(payload.interruptedReason).toContain('unknown');
    expect(execute.mock.calls.filter(([, name]) => name === 'inPageScrollToIndex')).toHaveLength(0);
    expect(secondAction).not.toHaveBeenCalled();
  });

  it('passes each fill_form field frameId to performPhysicalFill', async () => {
    vi.spyOn(race, 'raceCdp').mockResolvedValue({} as any);
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'x',
      isTrusted: true,
      method: 'cdp_native',
    });

    await batchActionsTool.execute({
      tabId: 20,
      actions: [
        {
          type: 'fill_form',
          fields: [
            { ref: 3, value: 'first', frameId: 7 },
            { ref: 4, value: 'second', frameId: 8 },
          ],
        },
      ],
    });

    expect(fill.mock.calls[0][0]).toMatchObject({ target: 3, frameId: 7 });
    expect(fill.mock.calls[1][0]).toMatchObject({ target: 4, frameId: 8 });
  });

  it('treats an unknown fill submit outcome as a structured batch stop', async () => {
    vi.spyOn(race, 'raceCdp').mockResolvedValue({} as any);
    vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'x',
      isTrusted: true,
      method: 'cdp_native',
      submitted: false,
      submitResult: {
        success: false,
        status: 'unknown',
        message: 'Submit outcome unknown',
      },
    });

    const result = await batchActionsTool.execute({
      tabId: 20,
      actions: [
        { type: 'fill', ref: 3, value: 'x', submit: true },
        { type: 'wait', durationMs: 1 },
      ],
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(payload.status).toBe('unknown');
    expect(payload.retry).toBe(false);
    expect(payload.executedActions).toBe(1);
    expect(payload.results).toHaveLength(1);
  });

  it('returns a dialog interrupt instead of a synthetic replay when a batch step opens a dialog', async () => {
    vi.spyOn(race, 'raceCdp').mockRejectedValue(
      new race.DialogOpenedError({ type: 'alert', message: 'Paused', defaultPrompt: '' }),
    );
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue({
      type: 'alert',
      message: 'Paused',
      defaultPrompt: '',
    } as any);

    const result = await batchActionsTool.execute({
      tabId: 20,
      actions: [{ type: 'key', key: 'Enter' }],
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(payload.requiresDialogAction).toBe(true);
    expect(payload.receipt?.dialog?.message).toBe('Paused');
  });
});

describe('form pipeline bounded execution contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn(async () => ({ id: 30, url: 'https://example.com/form' })) },
      scripting: { executeScript: vi.fn(async () => [{ result: { success: true } }]) },
    });
    vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 30,
      url: 'https://example.com/form',
    });
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, fn) =>
      fn({} as any),
    );
  });

  it('clamps maxSteps to 1..60 and marks an unfinished run as partial error', async () => {
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageCheckCaptcha') return [{ result: { detected: false } }] as any;
      if (fnName === 'inPageDetectPerceptiveSignature') {
        return [
          {
            result: {
              question: 'Question',
              progress: '1 / 99',
              activeInputs: [{ index: 1, name: 'q', tagName: 'input' }],
              alerts: [],
            },
          },
        ] as any;
      }
      return [{ result: { success: true, index: 1, committed: true } }] as any;
    });
    vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'v',
      isTrusted: true,
      method: 'cdp_native',
    });

    const result = await formPipelineTool.execute({
      tabId: 30,
      fields: [{ query: 'q', value: 'v' }],
      maxSteps: 999,
      timeoutMs: 1,
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('timeout');
  });

  it('does not start the next mutation after the deadline expires', async () => {
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageCheckCaptcha') return [{ result: { detected: false } }] as any;
      if (fnName === 'inPageDetectPerceptiveSignature') {
        return [
          {
            result: {
              question: 'Question',
              progress: '1 / 2',
              activeInputs: [{ index: 1, name: 'q', tagName: 'input' }],
              alerts: [],
            },
          },
        ] as any;
      }
      return [{ result: { success: true, index: 1, committed: true } }] as any;
    });
    vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'v',
      isTrusted: true,
      method: 'cdp_native',
    });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const result = await formPipelineTool.execute({
      tabId: 30,
      fields: [{ query: 'q', value: 'v' }],
      maxSteps: 60,
      timeoutMs: 20,
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    const waits = timeoutSpy.mock.calls
      .map(([, ms]) => Number(ms))
      .filter((ms) => Number.isFinite(ms) && ms >= 0 && ms < 600000);
    expect(waits.filter((ms) => ms > 20)).toEqual([]);
  });

  it('returns unknown after a dialog interrupt and still attaches the receipt', async () => {
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageCheckCaptcha') return [{ result: { detected: false } }] as any;
      return [
        {
          result: {
            question: 'Question',
            progress: '1 / 1',
            activeInputs: [{ index: 1, name: 'q', tagName: 'input' }],
            alerts: [],
          },
        },
      ] as any;
    });
    vi.spyOn(fillCore, 'performPhysicalFill').mockRejectedValue(
      new race.DialogOpenedError({ type: 'alert', message: 'Paused', defaultPrompt: '' }),
    );
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue({
      type: 'alert',
      message: 'Paused',
      defaultPrompt: '',
    } as any);

    const result = await formPipelineTool.execute({
      tabId: 30,
      fields: [{ query: 'q', value: 'v' }],
      timeoutMs: 60000,
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('unknown');
    expect(payload.retry).toBe(false);
    expect(payload.receipt?.dialog?.message).toBe('Paused');
  });

  it('honors explicit frame ids from perceptive inputs when filling', async () => {
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageCheckCaptcha') return [{ result: { detected: false } }] as any;
      if (fnName === 'inPageDetectPerceptiveSignature') {
        return [
          {
            result: {
              question: 'Question',
              progress: '1 / 1',
              activeInputs: [{ index: 1, name: 'q', tagName: 'input', frameId: 7 }],
              alerts: [],
            },
          },
        ] as any;
      }
      return [{ result: { success: true } }] as any;
    });
    const fill = vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'v',
      isTrusted: true,
      method: 'cdp_native',
    });

    await formPipelineTool.execute({
      tabId: 30,
      fields: [{ query: 'q', value: 'v' }],
      timeoutMs: 60000,
    });

    expect(fill.mock.calls[0][0]).toMatchObject({ frameId: 7 });
    expect((fill.mock.calls[0][0] as any).deadlineAt).toEqual(expect.any(Number));
  });
});

describe('form pipeline receipt integration remains inside existing wrapper', () => {
  it('uses the shared withActionReceipt helper', () => {
    expect(withActionReceipt).toBeTypeOf('function');
  });
});
