import { afterEach, expect, it, vi } from 'vitest';
import { fileUploadTool } from '../entrypoints/background/tools/browser/file-upload';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import { cdpSessionManager, type CdpEventObserver } from '../utils/cdp-session-manager';
import * as inPage from '../entrypoints/background/tools/browser/in-page-engine';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(sessionId?: string) {
  let observer: CdpEventObserver | undefined;
  vi.spyOn(fileUploadTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 10 });
  vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tab, _owner, fn) => fn());
  vi.spyOn(cdpSessionManager, 'ensureFrameSessions').mockResolvedValue([
    { sessionId: 'child', targetId: 'frame-child' },
  ]);
  const add = vi.spyOn(cdpSessionManager, 'addCdpEventObserver').mockImplementation((fn) => {
    observer = fn;
  });
  const remove = vi.spyOn(cdpSessionManager, 'removeCdpEventObserver');
  const send = vi.spyOn(cdpSessionManager, 'sendFrameCommand').mockResolvedValue({});
  const synthetic = vi.spyOn(inPage, 'executeInPage');
  const click = vi.spyOn(interactIndexTool, 'execute').mockImplementation(async () => {
    observer?.(11, 'Page.fileChooserOpened', { backendNodeId: 999 }, { tabId: 11 });
    observer?.(
      10,
      'Page.fileChooserOpened',
      { backendNodeId: 998 },
      { tabId: 10, sessionId: 'foreign' },
    );
    observer?.(10, 'Page.fileChooserOpened', { backendNodeId: 42 }, { tabId: 10, sessionId });
    return { content: [{ type: 'text', text: '{"success":true}' }], isError: false };
  });
  return { send, click, synthetic, add, remove };
}

it.each([undefined, 'child'])(
  'routes chooser node to its owning session %s using the shared click path',
  async (sessionId) => {
    const { send, click, synthetic, add, remove } = setup(sessionId);
    const result = await fileUploadTool.execute({
      tabId: 10,
      clickTargetIndex: 1,
      filePath: 'sample.txt',
    });
    expect(result.isError).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith({
      tabId: 10,
      index: 1,
      action: 'click',
      skipLock: true,
      includeDelta: false,
    });
    expect(synthetic).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(10, sessionId, 'DOM.setFileInputFiles', {
      files: ['sample.txt'],
      backendNodeId: 42,
    });
    expect(send.mock.calls.filter((call) => call[2] === 'DOM.setFileInputFiles')).toHaveLength(1);
    expect(send.mock.calls.some((call) => call[2] === 'Runtime.callFunctionOn')).toBe(false);
    expect(remove).toHaveBeenCalledWith(add.mock.calls[0][0]);
    for (const sid of [undefined, 'child']) {
      expect(send).toHaveBeenCalledWith(10, sid, 'Page.setInterceptFileChooserDialog', {
        enabled: false,
      });
    }
  },
);

it.each(['failure', 'unknown'])(
  'does not set files or replay a %s click and clears the timer',
  async (kind) => {
    vi.useFakeTimers();
    const { send, click, synthetic } = setup();
    if (kind === 'unknown') click.mockRejectedValue(new Error('CDP click outcome unknown'));
    else
      click.mockResolvedValue({
        content: [{ type: 'text', text: '{"success":false,"error":"disabled"}' }],
        isError: true,
      });
    const result = await fileUploadTool.execute({
      tabId: 10,
      clickTargetIndex: 1,
      filePath: 'sample.txt',
    });
    expect(result.isError).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(synthetic).not.toHaveBeenCalled();
    expect(send.mock.calls.some((call) => call[2] === 'DOM.setFileInputFiles')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([undefined, 'child'])(
  'sets a hidden indexed input in its renderer %s without clicking or duplicate events',
  async (sessionId) => {
    const { click, send } = setup();
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tab, method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 0 };
      if (method === 'DOM.describeNode' || method === 'DOM.setFileInputFiles') {
        return send(10, undefined, method, params);
      }
      return {};
    });
    vi.spyOn(fileUploadTool as any, 'safeExecuteScript').mockResolvedValue([
      { frameId: 7, result: true },
    ]);
    send.mockImplementation(async (_tab, sid, method) => {
      if (method === 'DOM.performSearch') {
        return { searchId: sid || 'root', resultCount: sid === sessionId ? 1 : 0 };
      }
      if (method === 'DOM.getSearchResults') return { nodeIds: [42] };
      if (method === 'DOM.describeNode') {
        return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
      }
      return {};
    });
    const result = await fileUploadTool.execute({ tabId: 10, index: 1, filePath: 'sample.txt' });
    expect(result.isError).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(10, sessionId, 'DOM.setFileInputFiles', {
      nodeId: 42,
      files: ['sample.txt'],
    });
    expect(send.mock.calls.filter((call) => call[2] === 'DOM.discardSearchResults')).toHaveLength(
      2,
    );
    expect(send.mock.calls.some((call) => call[2] === 'Runtime.callFunctionOn')).toBe(false);
  },
);

it('retains prepared bytes and never replays when setting a static input rejects after dispatch', async () => {
  setup();
  vi.spyOn(fileUploadTool as any, 'prepareFileFromRemote').mockResolvedValue({
    filePath: 'prepared.txt',
  });
  const cleanup = vi.spyOn(fileUploadTool as any, 'cleanupTempFile').mockResolvedValue(undefined);
  const fallback = vi.spyOn(fileUploadTool, 'uploadViaDataTransfer');
  const send = vi
    .spyOn(cdpSessionManager, 'sendCommand')
    .mockImplementation(async (_tab, method) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 42 };
      if (method === 'DOM.describeNode')
        return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
      if (method === 'DOM.setFileInputFiles')
        throw new Error('Renderer disconnected after dispatch');
      return {};
    });
  const result = await fileUploadTool.execute({
    tabId: 10,
    selector: '#file',
    base64Data: 'dGVzdA==',
    fileName: 'test.txt',
  });
  expect(result.isError).toBe(true);
  expect(send.mock.calls.filter((call) => call[1] === 'DOM.setFileInputFiles')).toHaveLength(1);
  expect(cleanup).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
});

it('rejects ambiguous indexed search results without selecting a file', async () => {
  const { send } = setup();
  vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tab, method) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 0 };
    return {};
  });
  vi.spyOn(fileUploadTool as any, 'safeExecuteScript').mockResolvedValue([{ result: true }]);
  send.mockImplementation(async (_tab, _sid, method) =>
    method === 'DOM.performSearch' ? { searchId: 'ambiguous', resultCount: 2 } : {},
  );
  const result = await fileUploadTool.execute({ tabId: 10, index: 1, filePath: 'sample.txt' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Ambiguous indexed upload target');
  expect(send.mock.calls.some((call) => call[2] === 'DOM.setFileInputFiles')).toBe(false);
  expect(send).toHaveBeenCalledWith(10, undefined, 'DOM.discardSearchResults', {
    searchId: 'ambiguous',
  });
});

it.each([true, false])(
  'retains selected prepared bytes for lazy browser reads, but cleans unused files (selected=%s)',
  async (selected) => {
    const { click } = setup();
    vi.spyOn(fileUploadTool as any, 'prepareFileFromRemote').mockResolvedValue({
      filePath: 'prepared.txt',
    });
    const cleanup = vi.spyOn(fileUploadTool as any, 'cleanupTempFile').mockResolvedValue(undefined);
    if (!selected) click.mockRejectedValue(new Error('Target unavailable before selection'));
    const result = await fileUploadTool.execute({
      tabId: 10,
      clickTargetIndex: 1,
      base64Data: 'dGVzdA==',
      fileName: 'test.txt',
    });
    expect(result.isError).toBe(!selected);
    expect(cleanup).toHaveBeenCalledTimes(selected ? 0 : 1);
  },
);
