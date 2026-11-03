import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as raceCdpModule from '../utils/race-cdp';
import * as domIndexer from '../entrypoints/background/tools/browser/dom-indexer';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

const tabId = 9801;

function installChrome() {
  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({
        id,
        windowId: 1,
        url: 'https://example.com/',
        active: true,
      })),
      query: vi.fn(async () => [
        { id: tabId, windowId: 1, url: 'https://example.com/', active: true },
      ]),
      sendMessage: vi.fn(async () => ({ success: true })),
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ frameId: 0, documentId: 'doc', result: undefined }]),
    },
    runtime: { getPlatformInfo: vi.fn(async () => ({ os: 'win' })) },
    debugger: { onEvent: { addListener: vi.fn(), removeListener: vi.fn() } },
  };
}

async function dispatchRealInPage(
  _target: chrome.scripting.InjectionTarget,
  fnName: string,
  args: unknown[],
) {
  let result: any;
  if (fnName === 'inPageCheckOcclusion') {
    result = { x: 180, y: 120 };
  } else {
    const fn = (domIndexer as any)[fnName];
    if (typeof fn !== 'function') throw new Error(`Unexpected in-page entrypoint: ${fnName}`);
    result = await fn(...args);
  }
  return [{ frameId: 0, documentId: 'doc', result }] as any;
}

describe('2. Plain object CDP rejection during Input.insertText must not fallback to in-page overwrite', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    domIndexer.getIsolatedIndexMap().clear();
    installChrome();
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(dispatchRealInPage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    domIndexer.getIsolatedIndexMap().clear();
  });

  it('fails closed with status unknown and preserves error message when Input.insertText rejects with plain object', async () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.innerText = '';
    editor.getBoundingClientRect = () => ({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 300,
      bottom: 200,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });
    document.body.append(editor);
    domIndexer.getIsolatedIndexMap().set(1, editor);

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_t, _c, fn) =>
      fn({} as any),
    );
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue();
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue();

    let inPageFillIndexCalled = false;
    const origInPageFillIndex = domIndexer.inPageFillIndex;
    vi.spyOn(domIndexer, 'inPageFillIndex').mockImplementation((...args) => {
      inPageFillIndexCalled = true;
      return origInPageFillIndex(...args);
    });

    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        editor.focus();
      }
      if (method === 'Input.insertText') {
        // Simulates cross-world CDP plain object rejection (not an instance of Error)
        return Promise.reject({
          code: -32000,
          message: 'CDP execution failed: frame detached during typing',
        });
      }
      return {} as any;
    });

    const result = await performPhysicalFill({
      tabId,
      target: 1,
      text: 'hello rich text',
    });

    // Cannot prove untyped -> MUST NOT fallback to synthetic rewrite!
    expect(inPageFillIndexCalled).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.success).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.error).not.toContain('[object Object]');
    expect(result.error).toContain('frame detached during typing');
  });

  it('correctly replaces prior text and commits multiline rich text without stale concatenation', async () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.innerText = 'Old initial content';
    editor.getBoundingClientRect = () => ({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 300,
      bottom: 200,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });
    document.body.append(editor);
    domIndexer.getIsolatedIndexMap().set(1, editor);

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_t, _c, fn) =>
      fn({} as any),
    );
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue();
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue();

    let hasSelectedAll = false;
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        editor.focus();
      }
      if (method === 'Input.dispatchKeyEvent' && params?.commands?.includes('SelectAll')) {
        hasSelectedAll = true;
      }
      if (method === 'Input.insertText') {
        // Native browser behavior: if selection covers old text, insertText replaces it
        if (hasSelectedAll) {
          editor.innerText = params.text;
        } else {
          editor.innerText = editor.innerText + params.text;
        }
      }
      return {} as any;
    });

    const result = await performPhysicalFill({
      tabId,
      target: 1,
      text: 'First line\nSecond line',
      clear: true,
    });

    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.filledText).toBe('First line\nSecond line');
    expect(editor.innerText).not.toContain('Old initial content');
    expect(editor.innerText).toBe('First line\nSecond line');
  });
});
