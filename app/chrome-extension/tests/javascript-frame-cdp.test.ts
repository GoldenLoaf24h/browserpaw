import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { javascriptTool } from '../entrypoints/background/tools/browser/javascript';
import { cdpSessionManager } from '../utils/cdp-session-manager';

let send: ReturnType<typeof vi.spyOn>;
let navigated: boolean;
let ambiguous: boolean;
let dispatchError: Error | undefined;
let delayedLookup: boolean;
let injection: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigated = false;
  ambiguous = false;
  delayedLookup = false;
  dispatchError = undefined;
  injection = vi.fn(async ({ func, args }) => [{ result: func(...args) }]);
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => ({ id: 42, url: 'https://parent.test/' })) },
    webNavigation: {
      getFrame: vi.fn(async () => ({
        documentId: navigated ? 'new' : 'current',
        url: 'https://child.test/',
      })),
    },
    scripting: { executeScript: injection },
  });
  vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tab, _owner, fn) => fn());
  vi.spyOn(cdpSessionManager, 'ensureFrameSessions').mockResolvedValue([
    { sessionId: 'child', targetId: 'frame-child' },
  ]);
  send = vi
    .spyOn(cdpSessionManager, 'sendFrameCommand')
    .mockImplementation(async (_tab, sid, method, params: any) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.performSearch')
        return { searchId: sid || 'root', resultCount: sid === 'child' || ambiguous ? 1 : 0 };
      if (method === 'DOM.getSearchResults') return { nodeIds: [7] };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'child-document' } };
      if (method === 'DOM.discardSearchResults' && sid === 'child' && delayedLookup)
        await new Promise((resolve) => setTimeout(resolve, 30));
      if (method === 'Runtime.callFunctionOn') {
        expect(sid).toBe('child');
        expect(params.objectId).toBe('child-document');
        if (dispatchError) throw dispatchError;
        return { result: { value: { scope: 'child', count: 1 } } };
      }
      return {};
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('routes frame JavaScript to its document main world using one confirmed CDP dispatch', async () => {
  const result = await javascriptTool.execute({
    tabId: 42,
    frameId: 81,
    code: 'return {scope: "child", count: window.counter};',
  });
  expect(result.isError).toBe(false);
  const payload = JSON.parse(result.content[0].text as string);
  expect(payload.engine).toBe('cdp');
  expect(JSON.parse(payload.result)).toEqual({ scope: 'child', count: 1 });
  expect(send.mock.calls.filter((call) => call[2] === 'Runtime.callFunctionOn')).toHaveLength(1);
  expect(injection.mock.calls.every(([opts]) => opts.world !== 'MAIN')).toBe(true);
  expect(send).toHaveBeenCalledWith(
    42,
    'child',
    'Runtime.releaseObject',
    { objectId: 'child-document' },
    1000,
  );
  expect(
    [...document.documentElement.attributes].some((a) => a.name.startsWith('data-bp-evaluate-')),
  ).toBe(false);
});

it('does not execute after the observed document navigates during lookup', async () => {
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[2] === 'DOM.resolveNode') navigated = true;
    return result;
  });
  const result = await javascriptTool.execute({
    tabId: 42,
    frameId: 81,
    code: 'return window.counter++;',
  });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Frame navigated');
  expect(send.mock.calls.some((call) => call[2] === 'Runtime.callFunctionOn')).toBe(false);
});

it('rejects ambiguous document identity without executing user code', async () => {
  ambiguous = true;
  const result = await javascriptTool.execute({
    tabId: 42,
    frameId: 81,
    code: 'return window.counter++;',
  });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Ambiguous frame document');
  expect(send.mock.calls.some((call) => call[2] === 'Runtime.callFunctionOn')).toBe(false);
});

it('never falls back to scripting after a dispatched command fails with conflict-like text', async () => {
  dispatchError = new Error('Another debugger is already attached; outcome unknown');
  const result = await javascriptTool.execute({
    tabId: 42,
    frameId: 81,
    code: 'return window.counter++;',
  });
  const payload = JSON.parse(result.content[0].text as string);
  expect(result.isError).toBe(true);
  expect(payload).toMatchObject({
    status: 'unknown',
    outcome: 'unknown',
    retry: false,
    engine: 'cdp',
  });
  expect(send.mock.calls.filter((call) => call[2] === 'Runtime.callFunctionOn')).toHaveLength(1);
  expect(injection.mock.calls.some(([opts]) => opts.world === 'MAIN')).toBe(false);
});

it('reports a dispatched child timeout as unknown without replaying', async () => {
  dispatchError = new Error(
    'CDP Runtime.callFunctionOn outcome unknown: connection lost after dispatch (CDP_FRAME_SEND_TIMEOUT)',
  );
  const result = await javascriptTool.execute({
    tabId: 42,
    frameId: 81,
    code: 'return window.counter++;',
  });
  const payload = JSON.parse(result.content[0].text as string);
  expect(result.isError).toBe(true);
  expect(payload).toMatchObject({
    status: 'unknown',
    outcome: 'unknown',
    retry: false,
    engine: 'cdp',
  });
  expect(send.mock.calls.filter((call) => call[2] === 'Runtime.callFunctionOn')).toHaveLength(1);
  expect(injection.mock.calls.some(([opts]) => opts.world === 'MAIN')).toBe(false);
});

it('does not dispatch user code when document lookup exhausts the deadline', async () => {
  delayedLookup = true;
  const result = await javascriptTool.execute({
    tabId: 42,
    frameId: 81,
    code: 'return window.counter++;',
    timeoutMs: 5,
  });
  const payload = JSON.parse(result.content[0].text as string);
  expect(result.isError).toBe(true);
  expect(payload.status).toBeUndefined();
  expect(payload.outcome).toBeUndefined();
  expect(payload.retry).toBeUndefined();
  expect(send.mock.calls.some((call) => call[2] === 'Runtime.callFunctionOn')).toBe(false);
});

it('treats a missing execution response as unknown instead of replaying', async () => {
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (...args) =>
    args[2] === 'Runtime.callFunctionOn' ? {} : original(...args),
  );
  const result = await javascriptTool.execute({
    tabId: 42,
    frameId: 81,
    code: 'return window.counter++;',
  });
  const payload = JSON.parse(result.content[0].text as string);
  expect(result.isError).toBe(true);
  expect(payload).toMatchObject({
    status: 'unknown',
    outcome: 'unknown',
    retry: false,
    engine: 'cdp',
  });
  expect(send.mock.calls.filter((call) => call[2] === 'Runtime.callFunctionOn')).toHaveLength(1);
  expect(injection.mock.calls.some(([opts]) => opts.world === 'MAIN')).toBe(false);
});

it.each(['chrome-extension://other/private.html', 'http://169.254.169.254/latest/'])(
  'rejects a restricted child URL %s before code dispatch',
  async (url) => {
    vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({
      documentId: 'current',
      url,
    } as any);
    const result = await javascriptTool.execute({
      tabId: 42,
      frameId: 81,
      code: 'return document.title;',
    });
    expect(result.isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
  },
);
