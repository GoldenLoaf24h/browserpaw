import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import * as raceCdpModule from '../utils/race-cdp';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { inPageInsertMedia } from '../entrypoints/background/tools/browser/dom-indexer';

describe('Clipboard Production Contract Tests: fill-core & inPageInsertMedia', () => {
  let clipboardReadCount = 0;
  let clipboardWriteCount = 0;
  const initialClipboardToken = 'CANARY_USER_CLIPBOARD_SECRET_9876';

  // Production contract: spy/mock navigator.clipboard strictly to observe whether production functions touch it
  const mockClipboard = {
    readText: vi.fn(async () => {
      clipboardReadCount++;
      return initialClipboardToken;
    }),
    writeText: vi.fn(async () => {
      clipboardWriteCount++;
    }),
  };

  beforeEach(() => {
    clipboardReadCount = 0;
    clipboardWriteCount = 0;

    (globalThis as any).__MCP_INPAGE__ = {
      inPageSetIndexNamespace: () => true,
      inPageGetElementCoordinates: () => ({
        success: true,
        x: 150,
        y: 200,
        tagName: 'input',
        inputType: 'text',
        value: '',
      }),
      inPageWaitForActionable: () => ({ success: true, actionable: true, x: 150, y: 200 }),
      inPageVerifyActiveElement: () => ({ isFocused: true }),
      inPageCheckOcclusion: () => [{ node: 1, result: true }],
      inPageVerifyInputCommitment: () => ({ committed: true }),
    };

    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: mockClipboard,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Contract 1 (fill-core): performPhysicalFill invokes CDP Input.insertText directly and never calls navigator.clipboard', async () => {
    const sentCdpCommands: Array<{ method: string; params: any }> = [];

    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(
      async (_tabId: number, method: string, params?: any) => {
        sentCdpCommands.push({ method, params });
        return {} as any;
      },
    );

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) =>
      fn({} as any),
    );

    const existingChrome = (globalThis as any).chrome || {};
    vi.stubGlobal('chrome', {
      ...existingChrome,
      tabs: {
        ...(existingChrome.tabs || {}),
        get: vi.fn().mockResolvedValue({ id: 999, url: 'https://example.com' }),
        sendMessage: vi.fn().mockResolvedValue({ success: true }),
      },
      scripting: {
        executeScript: vi.fn().mockImplementation(async (opts: any) => {
          if (opts?.files) {
            return [{ frameId: 0, documentId: 'doc-contract-test', result: undefined }];
          }
          if (opts?.func) {
            const res = opts.func(...(opts.args || []));
            return [{ frameId: 0, documentId: 'doc-contract-test', result: res }];
          }
          return [{ frameId: 0, documentId: 'doc-contract-test', result: undefined }];
        }),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ domIndexNextNamespace: 1 }),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const coords = {
      success: true,
      x: 150,
      y: 200,
      tagName: 'input',
      inputType: 'text',
      value: '',
    };

    const fillResult = await performPhysicalFill({
      tabId: 999,
      target: 1,
      text: 'hello production contract',
      numericIndex: 1,
      coords: coords as any,
    });

    expect(fillResult.success).toBe(true);

    // Verify CDP Input.insertText received the exact text
    const insertTextCmds = sentCdpCommands.filter((c) => c.method === 'Input.insertText');
    expect(insertTextCmds.length).toBeGreaterThanOrEqual(1);
    expect(insertTextCmds[0].params.text).toBe('hello production contract');

    // Strict contract: navigator.clipboard must NOT be read or written
    expect(clipboardReadCount).toBe(0);
    expect(clipboardWriteCount).toBe(0);
  });

  it('Contract 2 (dom-indexer): inPageInsertMedia dispatches synthetic paste event with in-memory DataTransfer without calling navigator.clipboard', () => {
    const container = document.createElement('div');
    container.id = 'production-media-target';
    container.setAttribute('contenteditable', 'true');
    document.body.appendChild(container);

    let dispatchedPasteEvent: any = null;
    container.addEventListener('paste', (e) => {
      dispatchedPasteEvent = e;
    });

    const samplePng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const res = inPageInsertMedia({
      selector: '#production-media-target',
      base64Data: samplePng,
      mimeType: 'image/png',
      fileName: 'contract.png',
    });

    expect(res.success).toBe(true);
    expect(dispatchedPasteEvent).not.toBeNull();
    expect(dispatchedPasteEvent.type).toBe('paste');
    expect(dispatchedPasteEvent.clipboardData).toBeDefined();

    // Strict contract: navigator.clipboard must NOT be read or written
    expect(clipboardReadCount).toBe(0);
    expect(clipboardWriteCount).toBe(0);

    document.body.removeChild(container);
  });
});
