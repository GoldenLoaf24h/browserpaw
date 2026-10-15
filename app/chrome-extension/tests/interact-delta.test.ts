import { describe, it, expect, beforeEach, vi } from 'vitest';
import { captureDeltaIfRequested } from '../utils/delta-helper';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { CdpDispatchTimeoutError } from '../utils/race-cdp';
import { clickTool } from '../entrypoints/background/tools/browser/interaction';
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

  it('form-pipeline compensates the release and never re-dispatches a synthetic click on timeout', async () => {
    const mouseCalls: Array<Record<string, unknown>> = [];
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _label, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          mouseCalls.push(params as Record<string, unknown>);
          if ((params as any).type === 'mousePressed') {
            // Press acknowledged, but the renderer then stops acking the release.
            throw new CdpDispatchTimeoutError('Input.dispatchMouseEvent');
          }
        }
        return {} as any;
      },
    );

    let fallbackClicks = 0;
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [{ result: { success: true, x: 50, y: 60, tagName: 'button' } }] as any;
      }
      if (fnName === 'inPageInteractIndex') {
        fallbackClicks++;
        return [{ result: { success: true } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    const dispatched = await (formPipelineTool as any).dispatchNativeClick(400, 1).catch((e) => e);

    // The uncertain press must surface as an error instead of a synthetic retry.
    expect(dispatched).toBeInstanceOf(CdpDispatchTimeoutError);
    expect(fallbackClicks).toBe(0);

    const presses = mouseCalls.filter((c) => c.type === 'mousePressed');
    const releases = mouseCalls.filter((c) => c.type === 'mouseReleased');
    expect(presses).toHaveLength(1);
    // Exactly one compensating release, with the button bitmask cleared.
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ type: 'mouseReleased', buttons: 0, x: 50, y: 60 });
  });

  it('form-pipeline fails closed when a click delivery outcome is unknown', async () => {
    const outcomeUnknown = new Error(
      'CDP Input.dispatchMouseEvent outcome unknown: connection lost after dispatch (cdp-test). The command may have executed; inspect page state before retrying.',
    );
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _label, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && (params as any).type === 'mousePressed') {
          throw outcomeUnknown;
        }
        return {} as any;
      },
    );

    let fallbackClicks = 0;
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [{ result: { success: true, x: 50, y: 60, tagName: 'button' } }] as any;
      }
      if (fnName === 'inPageInteractIndex') {
        fallbackClicks++;
        return [{ result: { success: true } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    const dispatched = await (formPipelineTool as any).dispatchNativeClick(400, 1).catch((e) => e);

    expect(dispatched).toBe(outcomeUnknown);
    expect(fallbackClicks).toBe(0);
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
