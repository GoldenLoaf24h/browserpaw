import { describe, it, expect, beforeEach, vi } from 'vitest';
import { captureDeltaIfRequested } from '../utils/delta-helper';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { CdpDispatchTimeoutError } from '../utils/race-cdp';
import { clickTool } from '../entrypoints/background/tools/browser/interaction';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import * as unifiedLocator from '../entrypoints/background/tools/browser/unified-locator';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';

describe('captureDeltaIfRequested Helper', () => {
  it('returns undefined when includeDelta is false or omitted', async () => {
    const res1 = await captureDeltaIfRequested(1, false);
    const res2 = await captureDeltaIfRequested(1, undefined);
    expect(res1).toBeUndefined();
    expect(res2).toBeUndefined();
  });
});

describe('A-02: press/release compensation on a real click path', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('form-pipeline delegates click to interactIndexTool with skipLock: true and halts on failure without synthetic replay', async () => {
    let fallbackClicks = 0;
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
      if (fnName === 'inPageInteractIndex') {
        fallbackClicks++;
      }
      return [{ result: { success: true } }] as any;
    });

    const interactSpy = vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: 'CDP_DISPATCH_TIMEOUT: Input.dispatchMouseEvent' }],
      isError: true,
    });

    await expect((formPipelineTool as any).dispatchNativeClick(400, 1)).rejects.toThrow(
      'Form click failed',
    );

    expect(interactSpy).toHaveBeenCalledWith(
      {
        tabId: 400,
        index: 1,
        action: 'click',
        skipLock: true,
        includeDelta: false,
      },
      { signal: undefined },
    );
    expect(fallbackClicks).toBe(0);
  });

  it('form-pipeline fails closed without synthetic replay when interactIndexTool reports parsed failure', async () => {
    let fallbackClicks = 0;
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
      if (fnName === 'inPageInteractIndex') {
        fallbackClicks++;
      }
      return [{ result: { success: true } }] as any;
    });

    vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify({ success: false, error: 'target_occluded' }) },
      ],
      isError: false,
    });

    await expect((formPipelineTool as any).dispatchNativeClick(400, 1)).rejects.toThrow(
      'target_occluded',
    );
    expect(fallbackClicks).toBe(0);
  });

  it('form-pipeline returns true when delegated interactIndexTool succeeds', async () => {
    vi.spyOn(interactIndexTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });

    const dispatched = await (formPipelineTool as any).dispatchNativeClick(400, 1);

    expect(dispatched).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '{"success":true}' }],
    });
  });

  it('click tool fails closed instead of falling back to a content-script click on an uncertain dispatch', async () => {
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async () => ({ id: 500, url: 'https://example.com' })),
        query: vi.fn(async () => [{ id: 500, url: 'https://example.com' }]),
      },
    };
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _label, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && (params as any).type === 'mousePressed') {
          throw new CdpDispatchTimeoutError('Input.dispatchMouseEvent');
        }
        return {} as any;
      },
    );
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue(undefined as any);
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue(undefined as any);
    vi.spyOn(unifiedLocator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 30,
      y: 40,
      tagName: 'button',
      text: 'Submit',
      resolutionPath: 'index',
    } as any);
    const sendMessageSpy = vi.spyOn(clickTool as any, 'sendMessageToTab').mockResolvedValue({});

    const res = await clickTool.execute({ tabId: 500, index: 1 } as any);

    // Fail closed: no content-script fallback click may be dispatched.
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('CDP_DISPATCH_TIMEOUT');
  });
});
