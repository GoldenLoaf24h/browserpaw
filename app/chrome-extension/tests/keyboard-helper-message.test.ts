import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { keyboardTool } from '../entrypoints/background/tools/browser/keyboard';
import { cdpSessionManager } from '../utils/cdp-session-manager';

describe('MOTION-04: Keyboard helper message handler & CDP fallback tests', () => {
  let messageListener: any = null;

  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = (globalThis as any).window || window;
    (globalThis as any).window.__KEYBOARD_HELPER_INITIALIZED__ = false;

    // Mock chrome.runtime.onMessage for the injected script
    (globalThis as any).chrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn((fn) => {
            messageListener = fn;
          }),
        },
      },
    };

    // Load and evaluate inject-scripts/keyboard-helper.js using the jsdom window and document
    const helperPath = path.resolve(__dirname, '../inject-scripts/keyboard-helper.js');
    const helperSource = fs.readFileSync(helperPath, 'utf8');
    const evalFn = new Function('window', 'document', 'chrome', helperSource);
    evalFn(window, document, (globalThis as any).chrome);
  });

  const sendHelperMessage = (keys: string) => {
    return new Promise<any>((resolve) => {
      messageListener({ action: 'simulateKeyboard', keys }, {}, resolve);
    });
  };

  describe('In-page keyboard-helper message handler verification', () => {
    it('dispatches literal plus key ("+") correctly', async () => {
      const resp = await sendHelperMessage('+');
      expect(resp.success).toBe(true);
      expect(resp.results).toHaveLength(1);
      expect(resp.results[0].keyCombination).toBe('+');
      expect(resp.results[0].success).toBe(true);
    });

    it('dispatches chord with plus key ("Ctrl++") correctly', async () => {
      const resp = await sendHelperMessage('Ctrl++');
      expect(resp.success).toBe(true);
      expect(resp.results).toHaveLength(1);
      expect(resp.results[0].keyCombination).toBe('Ctrl++');
      expect(resp.results[0].success).toBe(true);
    });

    it('dispatches literal comma key (",") without dropping it', async () => {
      const resp = await sendHelperMessage(',');
      expect(resp.success).toBe(true);
      expect(resp.results).toHaveLength(1);
      expect(resp.results[0].keyCombination).toBe(',');
      expect(resp.results[0].success).toBe(true);
    });

    it('dispatches comma-separated chords ("Ctrl+C, Ctrl+V") correctly', async () => {
      const resp = await sendHelperMessage('Ctrl+C, Ctrl+V');
      expect(resp.success).toBe(true);
      expect(resp.results).toHaveLength(2);
      expect(resp.results[0].keyCombination).toBe('Ctrl+C');
      expect(resp.results[0].success).toBe(true);
      expect(resp.results[1].keyCombination).toBe('Ctrl+V');
      expect(resp.results[1].success).toBe(true);
    });

    it('dispatches chord with comma key ("Ctrl+,") correctly without dropping comma', async () => {
      const resp = await sendHelperMessage('Ctrl+,');
      expect(resp.success).toBe(true);
      expect(resp.results).toHaveLength(1);
      expect(resp.results[0].keyCombination).toBe('Ctrl+,');
      expect(resp.results[0].success).toBe(true);
    });

    it('dispatches multi-chord sequence containing plus and comma ("Ctrl++, Shift+,")', async () => {
      const resp = await sendHelperMessage('Ctrl++, Shift+,');
      expect(resp.success).toBe(true);
      expect(resp.results).toHaveLength(2);
      expect(resp.results[0].keyCombination).toBe('Ctrl++');
      expect(resp.results[1].keyCombination).toBe('Shift+,');
    });

    it('dispatches standalone modifier key ("Control") without ReferenceError', async () => {
      const resp = await sendHelperMessage('Control');
      expect(resp.success).toBe(true);
      expect(resp.results).toHaveLength(1);
      expect(resp.results[0].keyCombination).toBe('Control');
    });
  });

  describe('KeyboardTool CDP fallback path verification', () => {
    const setupCdpFallbackHarness = () => {
      const dispatchedEvents: any[] = [];
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn().mockResolvedValue({ id: 99, url: 'https://example.com' }),
        },
        scripting: {
          executeScript: vi.fn().mockResolvedValue([]),
        },
      };

      // Mock sendMessageToTab to simulate helper failure/fallback trigger
      (keyboardTool as any).sendMessageToTab = vi.fn().mockResolvedValue({
        error: 'simulateKeyboard failed',
      });
      (keyboardTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
        id: 99,
        url: 'https://example.com',
      });
      (keyboardTool as any).injectContentScript = vi.fn().mockResolvedValue(undefined);

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

      return dispatchedEvents;
    };

    it('executes CDP fallback dispatch for "Ctrl++" with modifier mask', async () => {
      const dispatchedEvents = setupCdpFallbackHarness();

      const result = await keyboardTool.execute({
        tabId: 99,
        keys: 'Ctrl++',
      });

      expect(result.isError).toBe(false);
      expect(dispatchedEvents).toHaveLength(2); // keyDown and keyUp
      expect(dispatchedEvents[0].type).toBe('keyDown');
      expect(dispatchedEvents[0].key).toBe('+');
      expect(dispatchedEvents[0].modifiers).toBe(2);
      expect(dispatchedEvents[1].type).toBe('keyUp');
      expect(dispatchedEvents[1].key).toBe('+');
      expect(dispatchedEvents[1].modifiers).toBe(2);
    });

    it('executes CDP fallback dispatch for "Ctrl+," with modifier mask', async () => {
      const dispatchedEvents = setupCdpFallbackHarness();

      const result = await keyboardTool.execute({
        tabId: 99,
        keys: 'Ctrl+,',
      });

      expect(result.isError).toBe(false);
      expect(dispatchedEvents).toHaveLength(2);
      expect(dispatchedEvents[0].type).toBe('keyDown');
      expect(dispatchedEvents[0].key).toBe(',');
      expect(dispatchedEvents[0].modifiers).toBe(2);
      expect(dispatchedEvents[1].type).toBe('keyUp');
      expect(dispatchedEvents[1].key).toBe(',');
      expect(dispatchedEvents[1].modifiers).toBe(2);
    });

    it('executes CDP fallback dispatch for standalone "Control"', async () => {
      const dispatchedEvents = setupCdpFallbackHarness();

      const result = await keyboardTool.execute({
        tabId: 99,
        keys: 'Control',
      });

      expect(result.isError).toBe(false);
      expect(dispatchedEvents).toHaveLength(2);
      expect(dispatchedEvents[0].key).toBe('Control');
      expect(dispatchedEvents[0].windowsVirtualKeyCode).toBe(17);
    });

    it('executes CDP fallback dispatch for standalone "+" and "," without modifiers', async () => {
      const plusEvents = setupCdpFallbackHarness();
      const plusRes = await keyboardTool.execute({ tabId: 99, keys: '+' });
      expect(plusRes.isError).toBe(false);
      expect(plusEvents).toHaveLength(2);
      expect(plusEvents[0].key).toBe('+');
      expect(plusEvents[0].windowsVirtualKeyCode).toBe(187);

      const commaEvents = setupCdpFallbackHarness();
      const commaRes = await keyboardTool.execute({ tabId: 99, keys: ',' });
      expect(commaRes.isError).toBe(false);
      expect(commaEvents).toHaveLength(2);
      expect(commaEvents[0].key).toBe(',');
      expect(commaEvents[0].windowsVirtualKeyCode).toBe(188);
    });

    it('preserves CDP fallback dispatch for two-word key "Page Down"', async () => {
      const dispatchedEvents = setupCdpFallbackHarness();

      const result = await keyboardTool.execute({
        tabId: 99,
        keys: 'Page Down',
      });

      expect(result.isError).toBe(false);
      expect(dispatchedEvents).toHaveLength(2);
      expect(dispatchedEvents[0].type).toBe('keyDown');
      expect(dispatchedEvents[0].key).toBe('PageDown');
      expect(dispatchedEvents[0].windowsVirtualKeyCode).toBe(34);
    });

    it('preserves CDP fallback dispatch for space-separated sequence "ArrowDown ArrowDown Enter"', async () => {
      const dispatchedEvents = setupCdpFallbackHarness();

      const result = await keyboardTool.execute({
        tabId: 99,
        keys: 'ArrowDown ArrowDown Enter',
      });

      expect(result.isError).toBe(false);
      expect(dispatchedEvents).toHaveLength(6); // 3 keys * 2 (down + up)
      expect(dispatchedEvents[0].key).toBe('ArrowDown');
      expect(dispatchedEvents[2].key).toBe('ArrowDown');
      expect(dispatchedEvents[4].key).toBe('Enter');
    });
  });
});
