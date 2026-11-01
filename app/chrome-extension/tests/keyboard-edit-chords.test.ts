import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { keyboardTool } from '../entrypoints/background/tools/browser/keyboard';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

describe('Edit Chords Native CDP Contract Tests with Focus & Modifier Invariants', () => {
  let dispatchedEvents: any[] = [];
  let clipboardReadCount = 0;
  let clipboardWriteCount = 0;
  let sentMessages: any[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    dispatchedEvents = [];
    sentMessages = [];
    clipboardReadCount = 0;
    clipboardWriteCount = 0;

    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 88, url: 'https://example.com' }),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([]),
      },
    };

    // Spy mock on navigator.clipboard: must NEVER be touched
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        readText: vi.fn(async () => {
          clipboardReadCount++;
          return 'MUST_NOT_BE_READ';
        }),
        writeText: vi.fn(async () => {
          clipboardWriteCount++;
        }),
      },
    });

    (keyboardTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 88,
      url: 'https://example.com',
    });
    (keyboardTool as any).injectContentScript = vi.fn().mockResolvedValue(undefined);

    (keyboardTool as any).sendMessageToTab = vi.fn(async (_tabId: number, msg: any) => {
      sentMessages.push(msg);
      if (msg.action === 'ensureRefForSelector') {
        if (msg.selector === '#non-existent') {
          return { success: false, error: 'selector not found: #non-existent' };
        }
        return { success: true, ref: 'ref_input_1' };
      }
      if (msg.action === 'focusByRef') {
        return { success: true };
      }
      return { success: true };
    });

    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation((async (
      _tabId: number,
      _owner: string,
      fn: () => Promise<any>,
    ) => fn()) as any);

    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation((async (
      _tabId: number,
      method: string,
      params?: any,
    ) => {
      if (method === 'Input.dispatchKeyEvent') {
        dispatchedEvents.push(params);
      }
      return {};
    }) as any);
  });

  it('guarantees selector is resolved and focused BEFORE native edit chord is dispatched', async () => {
    const res = await keyboardTool.execute({
      tabId: 88,
      keys: 'Ctrl+A',
      selector: '#target-editor',
    });

    expect(res.isError).toBe(false);

    // Verify focusByRef was issued before CDP dispatch
    const ensureRefMsg = sentMessages.find((m) => m.action === 'ensureRefForSelector');
    expect(ensureRefMsg).toBeDefined();
    expect(ensureRefMsg.selector).toBe('#target-editor');

    const focusRefMsg = sentMessages.find((m) => m.action === 'focusByRef');
    expect(focusRefMsg).toBeDefined();
    expect(focusRefMsg.ref).toBe('ref_input_1');

    // Verify CDP event was dispatched
    expect(dispatchedEvents).toHaveLength(2);
    expect(dispatchedEvents[0].commands).toEqual(['SelectAll']);
  });

  it('aborts edit chord dispatch and fails closed when target selector cannot be resolved', async () => {
    const res = await keyboardTool.execute({
      tabId: 88,
      keys: 'Ctrl+A',
      selector: '#non-existent',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('selector not found: #non-existent');

    // Crucial: no CDP key event dispatched to an untargeted element!
    expect(dispatchedEvents).toHaveLength(0);
  });

  it.each(['css', 'xpath'] as const)(
    'resolves, focuses and sends keys in the requested %s frame',
    async (selectorType) => {
      const selector = selectorType === 'xpath' ? '//*[@id="child-editor"]' : '#child-editor';
      const messages: Array<{ action: string; frameId?: number }> = [];
      (keyboardTool as any).sendMessageToTab.mockImplementation(
        async (_tab: number, msg: any, frameId?: number) => {
          messages.push({ action: msg.action, frameId });
          if (frameId !== 7) return { success: false, error: 'Target belongs to frame 7' };
          if (msg.action === 'ensureRefForSelector') return { success: true, ref: 'child-ref' };
          if (msg.action === 'resolveRef') return { success: true, selector: '#child-editor' };
          return { success: true };
        },
      );
      const result = await keyboardTool.execute({
        tabId: 88,
        frameId: 7,
        selector,
        selectorType,
        keys: 'End',
      });
      expect(result.isError).toBe(false);
      expect(messages.map((m) => m.action)).toContain('focusByRef');
      expect(messages.map((m) => m.action)).not.toContain('simulateKeyboard');
      expect(dispatchedEvents).toHaveLength(2);
      expect(dispatchedEvents[0].key).toBe('End');
      expect(messages.every((m) => m.frameId === 7)).toBe(true);
      for (const call of (keyboardTool as any).injectContentScript.mock.calls) {
        expect(call[5]).toEqual([7]);
      }
    },
  );

  it('does not search another frame when an explicit indexed frame has no target', async () => {
    const page = vi
      .spyOn(inPageEngine, 'executeInPage')
      .mockImplementation(async (target: any) =>
        target.allFrames
          ? ([{ frameId: 8, result: { success: true, focused: true, tagName: 'input' } }] as any)
          : ([{ frameId: 7, result: { success: false } }] as any),
      );
    const result = await keyboardTool.execute({ tabId: 88, frameId: 7, index: 99, keys: 'Ctrl+A' });
    expect(result.isError).toBe(true);
    expect(page).toHaveBeenCalledWith({ tabId: 88, frameIds: [7] }, 'inPageFocusIndex', [99]);
    expect(page.mock.calls.some(([target]) => target.allFrames)).toBe(false);
    expect(dispatchedEvents).toHaveLength(0);
  });

  it('strictly preserves modifier semantics: Cmd yields Meta mask (4), Ctrl yields Ctrl mask (2)', async () => {
    // 1. Explicit Cmd+A
    dispatchedEvents = [];
    const resCmd = await keyboardTool.execute({ tabId: 88, keys: 'Cmd+A' });
    expect(resCmd.isError).toBe(false);
    expect(dispatchedEvents[0].modifiers).toBe(4); // Meta mask
    expect(dispatchedEvents[1].modifiers).toBe(4);

    // 2. Explicit Meta+C
    dispatchedEvents = [];
    const resMeta = await keyboardTool.execute({ tabId: 88, keys: 'Meta+C' });
    expect(resMeta.isError).toBe(false);
    expect(dispatchedEvents[0].modifiers).toBe(4); // Meta mask

    // 3. Explicit Ctrl+A
    dispatchedEvents = [];
    const resCtrl = await keyboardTool.execute({ tabId: 88, keys: 'Ctrl+A' });
    expect(resCtrl.isError).toBe(false);
    expect(dispatchedEvents[0].modifiers).toBe(2); // Ctrl mask
    expect(dispatchedEvents[1].modifiers).toBe(2);

    // 4. Explicit Control+X
    dispatchedEvents = [];
    const resControl = await keyboardTool.execute({ tabId: 88, keys: 'Control+X' });
    expect(resControl.isError).toBe(false);
    expect(dispatchedEvents[0].modifiers).toBe(2); // Ctrl mask

    // Strict zero clipboard read/write
    expect(clipboardReadCount).toBe(0);
    expect(clipboardWriteCount).toBe(0);
  });

  it('dispatches native SelectAll chord for Ctrl+A with vk 65 and commands: ["SelectAll"]', async () => {
    const res = await keyboardTool.execute({ tabId: 88, keys: 'Ctrl+A' });
    expect(res.isError).toBe(false);
    const body = JSON.parse(res.content[0].text);
    expect(body.method).toBe('cdp_native_edit_chord');
    expect(body.command).toBe('SelectAll');

    expect(dispatchedEvents).toHaveLength(2);
    expect(dispatchedEvents[0]).toMatchObject({
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
      commands: ['SelectAll'],
    });
    expect(dispatchedEvents[1]).toMatchObject({
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
    });
  });

  it('dispatches native Cut chord for Ctrl+X with vk 88 and commands: ["Cut"]', async () => {
    const res = await keyboardTool.execute({ tabId: 88, keys: 'Ctrl+X' });
    expect(res.isError).toBe(false);
    const body = JSON.parse(res.content[0].text);
    expect(body.method).toBe('cdp_native_edit_chord');
    expect(body.command).toBe('Cut');

    expect(dispatchedEvents).toHaveLength(2);
    expect(dispatchedEvents[0]).toMatchObject({
      type: 'rawKeyDown',
      key: 'x',
      code: 'KeyX',
      windowsVirtualKeyCode: 88,
      commands: ['Cut'],
    });
    expect(dispatchedEvents[1].type).toBe('keyUp');
  });

  it('dispatches native Copy chord for Ctrl+C without content-script synthetic events', async () => {
    const res = await keyboardTool.execute({ tabId: 88, keys: 'Ctrl+C' });
    expect(res.isError).toBe(false);
    const body = JSON.parse(res.content[0].text);
    expect(body.method).toBe('cdp_native_edit_chord');
    expect(body.command).toBe('Copy');

    expect(dispatchedEvents).toHaveLength(2);
    expect(dispatchedEvents[0]).toMatchObject({
      type: 'rawKeyDown',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: 67,
      commands: ['Copy'],
    });
  });

  it('dispatches native Paste chord for Ctrl+V without content-script focus/permission requirement', async () => {
    const res = await keyboardTool.execute({ tabId: 88, keys: 'Ctrl+V' });
    expect(res.isError).toBe(false);
    const body = JSON.parse(res.content[0].text);
    expect(body.method).toBe('cdp_native_edit_chord');
    expect(body.command).toBe('Paste');

    expect(dispatchedEvents).toHaveLength(2);
    expect(dispatchedEvents[0]).toMatchObject({
      type: 'rawKeyDown',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      commands: ['Paste'],
    });

    expect(clipboardReadCount).toBe(0);
    expect(clipboardWriteCount).toBe(0);
  });

  it('proves keyboard-helper.js no longer contains orphan runClipboard and cleanly delegates', () => {
    const helperPath = path.resolve(__dirname, '../inject-scripts/keyboard-helper.js');
    const helperSource = fs.readFileSync(helperPath, 'utf8');

    expect(helperSource).not.toContain('runClipboard');
    expect(helperSource).not.toContain('clipboardCopy');
    expect(helperSource).not.toContain('clipboardPaste');

    expect(helperSource).toContain('simulateKeyboard');
    expect(helperSource).toContain('dispatchKeyEvents');
  });
});
