import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { clickTool } from '../entrypoints/background/tools/browser/interaction';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import * as race from '../utils/race-cdp';
import { cdpSessionManager } from '../utils/cdp-session-manager';

const activeInput = {
  index: 1,
  name: 'slowField',
  tagName: 'input',
};

function installChrome(tabId = 77) {
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async () => ({ id: tabId, url: 'https://example.com/form' })),
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: { success: true } }]),
    },
  });
}

function installFastTransport() {
  vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, fn) =>
    fn({} as any),
  );
  vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({} as any);
  vi.spyOn(race, 'raceCdp').mockResolvedValue({} as any);
  vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
  vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);
}

describe('fill-core deadline consumption', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installChrome();
    installFastTransport();
  });

  it('does not auto-submit after a slow fill completes beyond its deadline', async () => {
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [
          {
            result: {
              success: true,
              x: 10,
              y: 20,
              value: '',
              tagName: 'input',
              inputType: 'text',
            },
          },
        ] as any;
      }
      if (fnName === 'inPageWaitForActionable') {
        return [{ result: { success: true, x: 10, y: 20 } }] as any;
      }
      if (fnName === 'inPageCheckOcclusion') {
        return [{ result: { success: true, x: 10, y: 20 } }] as any;
      }
      if (fnName === 'inPageVerifyActiveElement') {
        return [{ result: { isFocused: true } }] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return [
          {
            result: {
              committed: true,
              submitButtonState: { found: true, index: 2, disabled: false },
            },
          },
        ] as any;
      }
      return [{ result: { success: true } }] as any;
    });
    const click = vi.spyOn(clickTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });

    const result = await performPhysicalFill({
      tabId: 77,
      target: 1,
      text: 'slow value',
      clear: true,
      submit: true,
      submitTarget: { index: 2 },
      deadlineAt: Date.now() + 180,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('timeout');
    expect(result.submitted).not.toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  it('passes the absolute deadline to nested interact and bounded page execution', async () => {
    const inPage = vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [
          {
            result: {
              success: true,
              x: 10,
              y: 20,
              value: '',
              tagName: 'input',
              inputType: 'text',
            },
          },
        ] as any;
      }
      if (fnName === 'inPageWaitForActionable') {
        return [{ result: { success: true, x: 10, y: 20 } }] as any;
      }
      if (fnName === 'inPageCheckOcclusion') {
        return [{ result: { success: true, x: 10, y: 20 } }] as any;
      }
      if (fnName === 'inPageVerifyActiveElement') {
        return [{ result: { isFocused: true } }] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [
          {
            result: {
              committed: true,
              submitButtonState: { found: true, index: 2, disabled: false },
            },
          },
        ] as any;
      }
      return [{ result: { success: true } }] as any;
    });
    const deadlineAt = Date.now() + 10_000;
    const click = vi.spyOn(clickTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });

    const result = await performPhysicalFill({
      tabId: 77,
      target: 1,
      text: 'value',
      clear: true,
      submit: true,
      submitTarget: { index: 2 },
      deadlineAt,
    });

    expect(result.submitted).toBe(true);
    expect(click).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 2,
        expectedDeadlineAt: deadlineAt,
        tabId: 77,
      }),
      expect.any(Object),
    );
    const waitCall = inPage.mock.calls.find(([, name]) => name === 'inPageWaitForActionable');
    expect(waitCall?.at(-1)).toEqual(expect.any(Number));
    expect(Number(waitCall?.at(-1))).toBeGreaterThan(0);
    expect(Number(waitCall?.at(-1))).toBeLessThanOrEqual(10_000);
  });
});

describe('fill-index public outcome contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installChrome();
    installFastTransport();
    vi.spyOn(fillIndexTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 77,
      url: 'https://example.com/form',
    });
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageDetectPerceptiveSignature') {
        return [{ result: { activeInputs: [], alerts: [] } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });
  });

  it('reports committed field verification through the shared interaction contract', async () => {
    const fill = vi.spyOn(fillCore, 'performPhysicalFill');
    fill.mockResolvedValueOnce({
      success: true,
      committed: true,
      index: 1,
      filledText: 'Ada',
      isTrusted: true,
      method: 'cdp_native',
    });

    const result = await fillIndexTool.execute({
      tabId: 77,
      index: 1,
      text: 'Ada',
      includeDelta: false,
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(false);
    expect(payload.interaction).toMatchObject({
      execution: { status: 'dispatched' },
      verification: { status: 'verified' },
    });
  });
});

describe('form-pipeline deadline stop on the real fill chain', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installChrome();
    installFastTransport();
    vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 77,
      url: 'https://example.com/form',
    });
  });

  it('does not submit or move to the next field when a controlled fill finishes after deadline', async () => {
    let locateCalls = 0;
    const inPage = vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageCheckCaptcha') {
        return [{ result: { detected: false } }] as any;
      }
      if (fnName === 'inPageDetectPerceptiveSignature') {
        return [
          {
            result: {
              question: 'slow field question',
              progress: '1 / 2',
              activeInputs: [activeInput],
              alerts: [],
            },
          },
        ] as any;
      }
      if (fnName === 'inPageLocateByText') {
        locateCalls++;
        return [{ result: { success: true, index: 9, tagName: 'button' } }] as any;
      }
      if (fnName === 'inPageGetElementCoordinates') {
        return [
          {
            result: {
              success: true,
              x: 10,
              y: 20,
              value: '',
              tagName: 'input',
              inputType: 'text',
            },
          },
        ] as any;
      }
      if (fnName === 'inPageWaitForActionable') {
        return [{ result: { success: true, x: 10, y: 20 } }] as any;
      }
      if (fnName === 'inPageCheckOcclusion') {
        return [{ result: { success: true, x: 10, y: 20 } }] as any;
      }
      if (fnName === 'inPageVerifyActiveElement') {
        return [{ result: { isFocused: true } }] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return [{ result: { committed: true } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });
    const interact = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });

    const result = await formPipelineTool.execute({
      tabId: 77,
      timeoutMs: 180,
      fields: [
        { query: 'slow field', value: 'first' },
        { query: 'second field', value: 'second' },
      ],
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('timeout');
    expect(payload.reason).toBe('deadline_exceeded');
    expect(interact).not.toHaveBeenCalled();
    expect(locateCalls).toBe(0);
    expect(
      inPage.mock.calls.filter(([, name]) => name === 'inPageVerifyInputCommitment'),
    ).toHaveLength(1);
  });
});

describe('fill-core uncertain dispatch remains unknown', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installChrome();
    installFastTransport();
  });

  it('does not reinterpret an uncertain insertText cancellation as a safe rollback', async () => {
    vi.spyOn(race, 'raceCdp').mockImplementation(async (_tabId, method) => {
      if (method === 'Input.insertText') {
        throw new race.CdpDispatchTimeoutError('Input.insertText');
      }
      return {} as any;
    });
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [
          {
            result: {
              success: true,
              x: 10,
              y: 20,
              value: '',
              tagName: 'input',
              inputType: 'text',
            },
          },
        ] as any;
      }
      if (fnName === 'inPageWaitForActionable' || fnName === 'inPageCheckOcclusion') {
        return [{ result: { success: true, x: 10, y: 20 } }] as any;
      }
      if (fnName === 'inPageVerifyActiveElement') {
        return [{ result: { isFocused: true } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    await expect(
      performPhysicalFill({
        tabId: 77,
        target: 1,
        text: 'unknown value',
        clear: true,
        deadlineAt: Date.now() + 10_000,
      }),
    ).rejects.toThrow(/CDP_DISPATCH_TIMEOUT/);
  });
});
