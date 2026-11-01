import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keyboardTool,
  parseCdpTargetCombinations,
} from '../entrypoints/background/tools/browser/keyboard';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as locator from '../entrypoints/background/tools/browser/unified-locator';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { CdpDispatchTimeoutError, DialogOpenedError } from '../utils/race-cdp';

describe('keyboard CDP routing', () => {
  let dispatchedEvents: any[];
  let sendMessage: ReturnType<typeof vi.fn>;
  let injectContentScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    dispatchedEvents = [];

    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async () => ({ id: 10, url: 'https://example.com' })),
        sendMessage: vi.fn(async () => ({ success: true })),
      },
      scripting: { executeScript: vi.fn(async () => []) },
    });

    vi.spyOn(keyboardTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 10,
      url: 'https://example.com',
    });
    sendMessage = vi.fn(async () => ({ success: true, results: [] }));
    (keyboardTool as any).sendMessageToTab = sendMessage;
    injectContentScript = vi.fn().mockResolvedValue(undefined);
    (keyboardTool as any).injectContentScript = injectContentScript;

    vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
      { result: { success: true, focused: true } },
    ] as any);
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _owner, fn) =>
      fn({} as any),
    );
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method, params) => {
        if (method === 'Input.dispatchKeyEvent') dispatchedEvents.push(params);
        return {} as any;
      },
    );
  });

  it('rejects an unknown token instead of silently dispatching a parsed prefix', () => {
    expect(parseCdpTargetCombinations('Enter, NotARealKey')).toEqual([]);
    expect(parseCdpTargetCombinations('Ctrl+NotARealKey')).toEqual([]);
    expect(parseCdpTargetCombinations('Enter,ArrowDown')).toHaveLength(2);
  });

  it.each(['Enter', 'ArrowDown'])(
    'dispatches %s directly through CDP without the synthetic helper',
    async (keys) => {
      const result = await keyboardTool.execute({ tabId: 10, keys });
      const payload = JSON.parse((result.content[0] as any).text);

      expect(result.isError).toBe(false);
      expect(payload.method).toBe('cdp_dispatch_key_event');
      expect(payload.isTrusted).toBe(true);
      expect(dispatchedEvents.map((event) => event.type)).toEqual(['keyDown', 'keyUp']);
      expect(dispatchedEvents[0].key).toBe(keys);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(injectContentScript).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      keys: 'a',
      key: 'a',
      code: 'KeyA',
      vk: 65,
      text: 'a',
      unmodifiedText: 'a',
      modifiers: undefined,
    },
    {
      keys: 'A',
      key: 'A',
      code: 'KeyA',
      vk: 65,
      text: 'A',
      unmodifiedText: 'A',
      modifiers: undefined,
    },
    {
      keys: 'Shift+a',
      key: 'A',
      code: 'KeyA',
      vk: 65,
      text: 'A',
      unmodifiedText: 'A',
      modifiers: 8,
    },
    {
      keys: 'Ctrl+Shift+A',
      key: 'A',
      code: 'KeyA',
      vk: 65,
      text: undefined,
      unmodifiedText: 'A',
      modifiers: 10,
    },
    {
      keys: 'Alt+a',
      key: 'a',
      code: 'KeyA',
      vk: 65,
      text: undefined,
      unmodifiedText: 'a',
      modifiers: 1,
    },
    {
      keys: 'Meta+b',
      key: 'b',
      code: 'KeyB',
      vk: 66,
      text: undefined,
      unmodifiedText: 'b',
      modifiers: 4,
    },
    {
      keys: '0',
      key: '0',
      code: 'Digit0',
      vk: 48,
      text: '0',
      unmodifiedText: '0',
      modifiers: undefined,
    },
    {
      keys: 'Shift+1',
      key: '!',
      code: 'Digit1',
      vk: 49,
      text: '!',
      unmodifiedText: '!',
      modifiers: 8,
    },
    {
      keys: 'Shift+0',
      key: ')',
      code: 'Digit0',
      vk: 48,
      text: ')',
      unmodifiedText: ')',
      modifiers: 8,
    },
    {
      keys: 'Ctrl+Shift+1',
      key: '!',
      code: 'Digit1',
      vk: 49,
      text: undefined,
      unmodifiedText: '!',
      modifiers: 10,
    },
    {
      keys: '!',
      key: '!',
      code: '',
      vk: 0,
      text: '!',
      unmodifiedText: '!',
      modifiers: undefined,
    },
    {
      keys: '中',
      key: '中',
      code: '',
      vk: 0,
      text: '中',
      unmodifiedText: '中',
      modifiers: undefined,
    },
  ])(
    'dispatches printable $keys natively with protocol-safe fields',
    async ({ keys, key, code, vk, text, unmodifiedText, modifiers }) => {
      const result = await keyboardTool.execute({ tabId: 10, keys });
      const payload = JSON.parse((result.content[0] as any).text);

      expect(result.isError).toBe(false);
      expect(payload.isTrusted).toBe(true);
      expect(dispatchedEvents).toHaveLength(2);
      expect(dispatchedEvents[0]).toMatchObject({
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        text,
        unmodifiedText,
        modifiers,
      });
      expect(dispatchedEvents[1]).toMatchObject({
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(injectContentScript).not.toHaveBeenCalled();
    },
  );

  it.each([
    { keys: 'Ctrl+Space', key: ' ', code: 'Space', vk: 32, unmodifiedText: ' ' },
    { keys: 'Ctrl++', key: '+', code: 'Equal', vk: 187, unmodifiedText: '+' },
    { keys: 'Ctrl+,', key: ',', code: 'Comma', vk: 188, unmodifiedText: ',' },
    { keys: 'Ctrl+Enter', key: 'Enter', code: 'Enter', vk: 13, unmodifiedText: '\r' },
  ])(
    'suppresses text but preserves unmodifiedText for shortcut $keys',
    async ({ keys, key, code, vk, unmodifiedText }) => {
      const result = await keyboardTool.execute({ tabId: 10, keys });

      expect(result.isError).toBe(false);
      expect(dispatchedEvents).toHaveLength(2);
      expect(dispatchedEvents[0]).toMatchObject({
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        unmodifiedText,
        modifiers: 2,
      });
      expect(dispatchedEvents[0].text).toBeUndefined();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(injectContentScript).not.toHaveBeenCalled();
    },
  );

  it('fails closed on a CDP timeout without synthetic replay', async () => {
    vi.mocked(cdpSessionManager.sendCommand).mockRejectedValueOnce(
      new CdpDispatchTimeoutError('Input.dispatchKeyEvent'),
    );

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Enter' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ success: false, status: 'unknown', retry: false });
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('fails closed on a dialog without synthetic replay', async () => {
    const dialog = { type: 'alert', message: 'Paused', defaultPrompt: '' };
    vi.mocked(cdpSessionManager.sendCommand).mockRejectedValueOnce(new DialogOpenedError(dialog));
    vi.spyOn(cdpSessionManager, 'getPendingDialog').mockReturnValue(dialog as any);

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Enter' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(payload).toMatchObject({
      success: false,
      status: 'unknown',
      retry: false,
      requiresDialogAction: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('does not replay through CDP when the one helper send fails', async () => {
    sendMessage.mockResolvedValue({ success: false, error: 'helper failed' });

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Ctrl+Shift+NotAKey' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ success: false, status: 'unknown', retry: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });

  it('treats a helper message throw after send as unknown without replay', async () => {
    sendMessage.mockRejectedValue(new Error('message channel closed after delivery'));

    const result = await keyboardTool.execute({
      tabId: 10,
      keys: 'Ctrl+Shift+NotAKey',
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ success: false, status: 'unknown', retry: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });

  it('treats a missing helper response as unknown without replay', async () => {
    sendMessage.mockResolvedValue(undefined);

    const result = await keyboardTool.execute({
      tabId: 10,
      keys: 'Ctrl+Shift+NotAKey',
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ success: false, status: 'unknown', retry: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });

  it('treats a partially failed helper sequence as unknown without replay', async () => {
    sendMessage.mockResolvedValue({
      success: false,
      results: [{ keyCombination: 'Enter', success: true }, { success: false }],
    });

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Enter,Bogus' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ success: false, status: 'unknown', retry: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });

  it('maps helper preflight rejection to blocked/retry true without CDP replay', async () => {
    sendMessage.mockResolvedValue({
      success: false,
      status: 'blocked',
      retry: true,
      dispatched: false,
      error: 'Invalid key string or combination: Bogus',
    });

    const result = await keyboardTool.execute({ tabId: 10, keys: 'Enter,Bogus' });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      status: 'blocked',
      retry: true,
      dispatched: false,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cdpSessionManager.sendCommand).not.toHaveBeenCalled();
  });

  it('marks an ordinary CDP error after an acknowledged dispatch as unknown', async () => {
    let commandCount = 0;
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (_tabId, method, params) => {
      commandCount++;
      if (commandCount === 2) throw new Error('protocol rejected keyUp');
      if (method === 'Input.dispatchKeyEvent') dispatchedEvents.push(params);
      return {} as any;
    });

    const result = await keyboardTool.execute({
      tabId: 10,
      keys: 'ArrowDown ArrowDown Enter',
    });
    const payload = JSON.parse((result.content[0] as any).text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      status: 'unknown',
      retry: false,
      dispatched: true,
      acknowledgedEvents: 1,
    });
    expect(cdpSessionManager.sendCommand).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps literal input out of the cursor note and reuses available target metadata', async () => {
    const fallbackSecret = 'literal-secret-4821';
    const metadataSecret = 'literal-secret-9157';
    vi.spyOn(locator, 'resolveTargetLocation').mockResolvedValue({
      success: true,
      x: 10,
      y: 20,
      resolutionPath: 'label',
      index: 3,
      tagName: 'input',
      inputType: 'email',
      attributes: { placeholder: 'Account email' },
    } as any);

    await keyboardTool.execute({ tabId: 10, keys: fallbackSecret });
    await keyboardTool.execute({
      tabId: 10,
      keys: metadataSecret,
      text: 'Account email',
    });

    const cursorMessages = vi
      .mocked((globalThis as any).chrome.tabs.sendMessage)
      .mock.calls.filter(([, message]) => message?.type === 'AGENT_CURSOR_SET_NOTE');
    expect(cursorMessages.map(([, message]) => message.note)).toEqual([
      'Typing',
      'Typing email field "Account email"',
    ]);
    const cursorPayload = JSON.stringify(cursorMessages);
    expect(cursorPayload).not.toContain(fallbackSecret);
    expect(cursorPayload).not.toContain(metadataSecret);
  });

  it('mock ordering contract only: native ArrowDown follows an established deep-frame focus', async () => {
    const order: string[] = [];
    vi.mocked(inPageEngine.executeInPage).mockImplementation(async (_target, fnName) => {
      if (fnName === 'inPageFocusIndex') {
        order.push('focus');
        return [
          {
            frameId: 7,
            result: {
              success: true,
              focused: true,
              tagName: 'INPUT',
              shadowPath: ['mdn-search', '#shadow-root', 'input'],
            },
          },
        ] as any;
      }
      return [{ result: { success: true } }] as any;
    });
    vi.mocked(cdpSessionManager.sendCommand).mockImplementation(async (_tabId, method, params) => {
      if (method === 'Input.dispatchKeyEvent') order.push(`cdp:${params?.type}`);
      return {} as any;
    });

    const result = await keyboardTool.execute({
      tabId: 10,
      frameId: 7,
      index: 3,
      keys: 'ArrowDown',
    });

    expect(result.isError).toBe(false);
    expect(inPageEngine.executeInPage).toHaveBeenCalledWith(
      { tabId: 10, frameIds: [7] },
      'inPageFocusIndex',
      [3],
    );
    expect(order).toEqual(['focus', 'cdp:keyDown', 'cdp:keyUp']);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
