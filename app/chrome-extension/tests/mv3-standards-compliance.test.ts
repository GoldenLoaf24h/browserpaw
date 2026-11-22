import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { HumanInterventionTool } from '../entrypoints/background/tools/browser/human-intervention';

describe('MV3 Extension Standards Compliance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
    document.getElementById('codex-agent-overlay-root')?.remove();
    document.getElementById('__rr_picker_host__')?.remove();
    document.getElementById('__rr_overlay_root')?.remove();
    delete (globalThis as any).__MCP_SCREENSHOT_HELPER_LISTENER__;
    delete (globalThis as any).defineContentScript;
  });

  describe('1. HumanInterventionTool & agent-cursor.content.ts async message lifecycle', () => {
    it('HumanInterventionTool rejects preempted response instead of reporting success', async () => {
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
          query: vi.fn(async () => [{ id: 1, active: true, windowId: 1 }]),
          sendMessage: vi.fn().mockResolvedValueOnce({
            ok: false,
            cancelled: true,
            reason: 'preempted',
          }),
        },
      };

      const tool = new HumanInterventionTool();
      const result = await tool.execute({
        tabId: 1,
        reason: 'Finish two-factor authentication',
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as any).text;
      expect(text).toContain('preempted');
      expect(text).not.toContain('"resolved": true');
    });

    it('agent-cursor.content.ts settles pending sendResponse once on cancel and on preemption', async () => {
      vi.resetModules();
      let cursorListener:
        ((message: any, sender: any, sendResponse: (res: any) => void) => any) | null = null;

      (globalThis as any).defineContentScript = (config: any) => config;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
      (globalThis as any).chrome = {
        runtime: {
          id: 'test-extension-id',
          getURL: vi.fn((resource: string) => `chrome-extension://test-extension-id/${resource}`),
          sendMessage: vi.fn().mockResolvedValue(undefined),
          onMessage: {
            addListener: vi.fn((fn) => {
              cursorListener = fn;
            }),
            removeListener: vi.fn(),
          },
        },
        storage: {
          local: {
            get: vi.fn((_key, cb) => {
              if (typeof cb === 'function') cb({ agentCursorMode: 'auto' });
              return Promise.resolve({ agentCursorMode: 'auto' });
            }),
          },
          onChanged: {
            addListener: vi.fn(),
          },
        },
      };

      const mod = await import('../entrypoints/agent-cursor.content');
      mod.default.main();
      expect(typeof cursorListener).toBe('function');

      // Case A: HUMAN_INTERVENTION_CANCEL settles the pending request response once
      const firstResponse = vi.fn();
      const firstRet = cursorListener!(
        { type: 'HUMAN_INTERVENTION_REQUEST', reason: 'Verify login' },
        {},
        firstResponse,
      );
      expect(firstRet).toBe(true);

      const cancelResponse = vi.fn();
      const cancelRet = cursorListener!({ type: 'HUMAN_INTERVENTION_CANCEL' }, {}, cancelResponse);
      expect(cancelRet).toBe(false);
      expect(cancelResponse).toHaveBeenCalledTimes(1);
      expect(cancelResponse).toHaveBeenCalledWith({ ok: true });
      expect(firstResponse).toHaveBeenCalledTimes(1);
      expect(firstResponse).toHaveBeenCalledWith({
        ok: false,
        cancelled: true,
        reason: 'cancelled',
      });

      // Pressing Enter after cancel must not trigger firstResponse a second time
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(firstResponse).toHaveBeenCalledTimes(1);

      // Case B: A second HUMAN_INTERVENTION_REQUEST preempts the earlier active request
      const secondResponse = vi.fn();
      expect(
        cursorListener!(
          { type: 'HUMAN_INTERVENTION_REQUEST', reason: 'First prompt' },
          {},
          secondResponse,
        ),
      ).toBe(true);

      const thirdResponse = vi.fn();
      expect(
        cursorListener!(
          { type: 'HUMAN_INTERVENTION_REQUEST', reason: 'Second prompt' },
          {},
          thirdResponse,
        ),
      ).toBe(true);

      expect(secondResponse).toHaveBeenCalledTimes(1);
      expect(secondResponse).toHaveBeenCalledWith({
        ok: false,
        cancelled: true,
        reason: 'preempted',
      });
      expect(thirdResponse).not.toHaveBeenCalled();

      // Completing the active request responds once, and subsequent Enter / Cancel are no-ops
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(thirdResponse).toHaveBeenCalledTimes(1);
      expect(thirdResponse).toHaveBeenCalledWith({ ok: true, action: 'completed_by_user' });

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      cursorListener!({ type: 'HUMAN_INTERVENTION_CANCEL' }, {}, vi.fn());
      expect(thirdResponse).toHaveBeenCalledTimes(1);
      expect(secondResponse).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. accessibility-tree-helper.js picker cleanup, hover bridge, and sync returns', () => {
    let messageListener:
      ((request: any, sender: any, sendResponse: (res: any) => void) => any) | null = null;

    beforeEach(() => {
      messageListener = null;
      (window as any).__ACCESSIBILITY_TREE_HELPER_INITIALIZED__ = false;
      (globalThis as any).chrome = {
        runtime: {
          onMessage: {
            addListener: vi.fn((fn) => {
              messageListener = fn;
            }),
            removeListener: vi.fn(),
          },
        },
      };

      const helperPath = path.resolve(__dirname, '../inject-scripts/accessibility-tree-helper.js');
      const helperSource = fs.readFileSync(helperPath, 'utf8');
      const runner = new Function('chrome', helperSource);
      runner((globalThis as any).chrome);
      expect(typeof messageListener).toBe('function');
    });

    it('rr_picker_stop removes all 3 document capture listeners and settles pending rr_picker_start', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');

      const startRespond = vi.fn();
      const startRet = messageListener!({ action: 'rr_picker_start' }, {}, startRespond);
      expect(startRet).toBe(true);
      expect(document.getElementById('__rr_picker_host__')).not.toBeNull();

      const pickerAdds = addSpy.mock.calls.filter(
        ([eventName, _handler, capture]) =>
          (eventName === 'mousemove' || eventName === 'click' || eventName === 'keydown') &&
          capture === true,
      );
      expect(pickerAdds).toHaveLength(3);

      const stopRespond = vi.fn();
      const stopRet = messageListener!({ action: 'rr_picker_stop' }, {}, stopRespond);
      expect(stopRet).toBe(false);
      expect(stopRespond).toHaveBeenCalledWith({ success: true });
      expect(document.getElementById('__rr_picker_host__')).toBeNull();

      for (const [eventName, handler] of pickerAdds) {
        expect(removeSpy).toHaveBeenCalledWith(eventName, handler, true);
      }

      expect(startRespond).toHaveBeenCalledTimes(1);
      expect(startRespond).toHaveBeenCalledWith({
        success: false,
        cancelled: true,
        reason: 'stopped',
      });
    });

    it('preempting rr_picker_start settles earlier sendResponse with reason preempted and removes listeners', () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');

      const firstRespond = vi.fn();
      expect(messageListener!({ action: 'rr_picker_start' }, {}, firstRespond)).toBe(true);
      const firstAdds = addSpy.mock.calls.filter(
        ([eventName, _handler, capture]) =>
          (eventName === 'mousemove' || eventName === 'click' || eventName === 'keydown') &&
          capture === true,
      );
      expect(firstAdds).toHaveLength(3);

      const secondRespond = vi.fn();
      expect(messageListener!({ action: 'rr_picker_start' }, {}, secondRespond)).toBe(true);

      expect(firstRespond).toHaveBeenCalledTimes(1);
      expect(firstRespond).toHaveBeenCalledWith({
        success: false,
        cancelled: true,
        reason: 'preempted',
      });
      for (const [eventName, handler] of firstAdds) {
        expect(removeSpy).toHaveBeenCalledWith(eventName, handler, true);
      }
      expect(secondRespond).not.toHaveBeenCalled();

      // Clean up active second picker
      expect(messageListener!({ action: 'rr_picker_stop' }, {}, vi.fn())).toBe(false);
      expect(secondRespond).toHaveBeenCalledTimes(1);
      expect(secondRespond).toHaveBeenCalledWith({
        success: false,
        cancelled: true,
        reason: 'stopped',
      });
    });

    it('forwardHoverRefToChildren does not abort on first child failure and resolves when second child succeeds', async () => {
      const iframe1 = document.createElement('iframe');
      iframe1.setAttribute('src', 'https://frame-one.example/page');
      const iframe2 = document.createElement('iframe');
      iframe2.setAttribute('src', 'https://frame-two.example/page');
      document.body.appendChild(iframe1);
      document.body.appendChild(iframe2);

      const win1 = iframe1.contentWindow!;
      const win2 = iframe2.contentWindow!;
      expect(win1).toBeTruthy();
      expect(win2).toBeTruthy();

      const postSpy1 = vi.spyOn(win1, 'postMessage').mockImplementation((msg: any) => {
        queueMicrotask(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'rr-bridge-hover-ref-result',
                reqId: msg.reqId,
                result: { success: false, error: 'ref not in frame 1' },
              },
              source: win1,
            }),
          );
        });
      });

      const postSpy2 = vi.spyOn(win2, 'postMessage').mockImplementation((msg: any) => {
        setTimeout(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'rr-bridge-hover-ref-result',
                reqId: msg.reqId,
                result: {
                  success: true,
                  element: { tagName: 'BUTTON', id: 'second-frame-btn', className: '', text: 'Go' },
                },
              },
              source: win2,
            }),
          );
        }, 20);
      });

      const resultPromise = new Promise<any>((resolve) => {
        const ret = messageListener!(
          { action: 'dispatchHoverForRef', ref: 'ref_child_target' },
          {},
          resolve,
        );
        expect(ret).toBe(true);
      });

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.element?.id).toBe('second-frame-btn');
      expect(postSpy1).toHaveBeenCalledTimes(1);
      expect(postSpy2).toHaveBeenCalledTimes(1);
      // Derived explicit http(s) origin instead of wildcard when src/location is http(s)
      expect(postSpy1.mock.calls[0][1]).not.toBe('*');
      expect(postSpy2.mock.calls[0][1]).not.toBe('*');
    });

    it('returns false for sync actions and null or non-object requests', () => {
      const sendResponse = vi.fn();

      expect(messageListener!(null, {}, sendResponse)).toBe(false);
      expect(messageListener!(undefined, {}, sendResponse)).toBe(false);
      expect(messageListener!('not-an-object', {}, sendResponse)).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();

      expect(messageListener!({ action: 'rr_overlay', cmd: 'init' }, {}, sendResponse)).toBe(false);
      expect(sendResponse).toHaveBeenLastCalledWith({ success: true });

      expect(messageListener!({ action: 'rr_picker_stop' }, {}, sendResponse)).toBe(false);
      expect(sendResponse).toHaveBeenLastCalledWith({ success: true });

      expect(messageListener!({ action: 'generateAccessibilityTree' }, {}, sendResponse)).toBe(
        false,
      );
      expect(sendResponse.mock.calls[sendResponse.mock.calls.length - 1][0].success).toBe(true);

      expect(messageListener!({ action: 'resolveRef', ref: 'ref_missing' }, {}, sendResponse)).toBe(
        false,
      );
      expect(sendResponse.mock.calls[sendResponse.mock.calls.length - 1][0].success).toBe(false);
    });
  });

  describe('3. screenshot-helper.js re-injection safety and listener guards', () => {
    it('re-injecting twice in the same world does not throw SyntaxError and replaces prior listener', () => {
      const helperPath = path.resolve(__dirname, '../inject-scripts/screenshot-helper.js');
      const helperSource = fs.readFileSync(helperPath, 'utf8');

      const registered: Array<(...args: any[]) => any> = [];
      const addListener = vi.fn((fn) => {
        registered.push(fn);
      });
      const removeListener = vi.fn();

      const sandbox: Record<string, any> = {
        window,
        document,
        CSS: (globalThis as any).CSS,
        setTimeout,
        clearTimeout,
        chrome: {
          runtime: {
            onMessage: {
              addListener,
              removeListener,
            },
          },
        },
      };
      sandbox.globalThis = sandbox;
      const context = vm.createContext(sandbox);

      expect(() => vm.runInContext(helperSource, context)).not.toThrow();
      expect(() => vm.runInContext(helperSource, context)).not.toThrow();

      expect(addListener).toHaveBeenCalledTimes(2);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledWith(registered[0]);
      expect(sandbox.__MCP_SCREENSHOT_HELPER_LISTENER__).toBe(registered[1]);
      expect((window as any).__mcpStyleStack).toBeDefined();

      const activeListener = registered[1];
      const nullResp = vi.fn();
      expect(activeListener(null, {}, nullResp)).toBe(false);
      expect(activeListener('bad', {}, nullResp)).toBe(false);
      expect(nullResp).not.toHaveBeenCalled();

      // Invalid CSS selector in getElementDetails responds with error and returns false instead of hanging
      const errResp = vi.fn();
      const errRet = activeListener(
        { action: 'getElementDetails', selector: '[invalid-selector' },
        {},
        errResp,
      );
      expect(errRet).toBe(false);
      expect(errResp).toHaveBeenCalledTimes(1);
      expect(errResp.mock.calls[0][0]).toMatchObject({
        success: false,
        error: expect.any(String),
      });
    });
  });

  describe('4. network-helper.js and keyboard-helper.js listener hardening', () => {
    it('network-helper.js returns false on null/non-object and unknown actions', () => {
      let netListener: any = null;
      (window as any).__NETWORK_CAPTURE_HELPER_INITIALIZED__ = false;
      (globalThis as any).chrome = {
        runtime: {
          onMessage: {
            addListener: vi.fn((fn) => {
              netListener = fn;
            }),
          },
        },
      };

      const helperPath = path.resolve(__dirname, '../inject-scripts/network-helper.js');
      const helperSource = fs.readFileSync(helperPath, 'utf8');
      new Function('chrome', helperSource)((globalThis as any).chrome);
      expect(typeof netListener).toBe('function');

      const sendResponse = vi.fn();
      expect(netListener(null, {}, sendResponse)).toBe(false);
      expect(netListener(undefined, {}, sendResponse)).toBe(false);
      expect(netListener({ action: 'unhandled_action' }, {}, sendResponse)).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it('keyboard-helper.js returns false on null request and missing selector', () => {
      let keyListener: any = null;
      (window as any).__KEYBOARD_HELPER_INITIALIZED__ = false;
      (globalThis as any).chrome = {
        runtime: {
          onMessage: {
            addListener: vi.fn((fn) => {
              keyListener = fn;
            }),
          },
        },
      };

      const helperPath = path.resolve(__dirname, '../inject-scripts/keyboard-helper.js');
      const helperSource = fs.readFileSync(helperPath, 'utf8');
      new Function('chrome', helperSource)((globalThis as any).chrome);
      expect(typeof keyListener).toBe('function');

      const sendResponse = vi.fn();
      expect(keyListener(null, {}, sendResponse)).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();

      const missingRet = keyListener(
        { action: 'simulateKeyboard', selector: '#non-existent-target', keys: 'Enter' },
        {},
        sendResponse,
      );
      expect(missingRet).toBe(false);
      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(sendResponse.mock.calls[0][0]).toMatchObject({
        success: false,
        results: [],
      });
    });
  });

  describe('5. wxt.config.ts manifest and PRIVACY.md tightening', () => {
    it('omits activeTab and /inject-scripts/* while exposing only /images/cursor-chat.png', () => {
      const configPath = path.resolve(__dirname, '../wxt.config.ts');
      const configSrc = fs.readFileSync(configPath, 'utf8');

      const permissionsMatch = configSrc.match(/permissions:\s*\[([\s\S]*?)\]/);
      expect(permissionsMatch).toBeTruthy();
      expect(permissionsMatch![1]).not.toContain("'activeTab'");
      expect(permissionsMatch![1]).not.toContain('"activeTab"');
      expect(permissionsMatch![1]).toContain("'tabs'");

      const warMatch = configSrc.match(/web_accessible_resources:\s*\[([\s\S]*?)\]\s*,/);
      expect(warMatch).toBeTruthy();
      expect(warMatch![1]).not.toContain('/inject-scripts/*');
      expect(warMatch![1]).not.toContain('/images/*');
      expect(warMatch![1]).toContain('/images/cursor-chat.png');

      expect(configSrc).toContain("default_title: 'BrowserPaw'");

      const privacyPath = path.resolve(__dirname, '../../../PRIVACY.md');
      const privacySrc = fs.readFileSync(privacyPath, 'utf8');
      expect(privacySrc).not.toContain('activeTab');
      expect(privacySrc).toContain('**`tabs`**');
    });
  });
});
