import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as domIndexer from '../entrypoints/background/tools/browser/dom-indexer';
import { getIsolatedIndexMap } from '../entrypoints/background/tools/browser/dom-indexer';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as raceCdpModule from '../utils/race-cdp';

const tabId = 7702;

function attachBox(el: HTMLElement) {
  el.getBoundingClientRect = () => ({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 260,
    bottom: 140,
    width: 160,
    height: 40,
    toJSON: () => ({}),
  });
}

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

describe('cursor action target', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    installChrome();
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(dispatchRealInPage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
  });

  it('uses the fill target name without exposing either fill value or existing value', async () => {
    const input = document.createElement('input');
    input.type = 'email';
    input.placeholder = 'Account email';
    input.value = 'existing-secret';
    attachBox(input);
    document.body.appendChild(input);
    getIsolatedIndexMap().set(1, input);

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) =>
      fn({} as any),
    );
    const cursor = vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue();
    const cursorClick = vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue();
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        input.focus();
      }
      if (method === 'Input.insertText') {
        input.value += params.text;
      }
      return {} as any;
    });

    const result = await performPhysicalFill({
      tabId,
      target: 1,
      text: 'new-secret',
      clear: false,
    });

    expect(result.success).toBe(true);
    expect(cursor).toHaveBeenCalledWith(
      tabId,
      180,
      120,
      expect.objectContaining({ actionNote: 'Filling email field "Account email"' }),
    );
    expect(cursorClick).toHaveBeenCalledWith(
      tabId,
      180,
      120,
      'Filling email field "Account email"',
    );
    const cursorPayload = JSON.stringify([cursor.mock.calls, cursorClick.mock.calls]);
    expect(cursorPayload).not.toContain('new-secret');
    expect(cursorPayload).not.toContain('existing-secret');
  });
});
