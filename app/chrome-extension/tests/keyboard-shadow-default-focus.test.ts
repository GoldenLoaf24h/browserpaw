import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(
  path.resolve(__dirname, '../inject-scripts/keyboard-helper.js'),
  'utf8',
);

describe('injected keyboard helper default focus', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as any).__KEYBOARD_HELPER_INITIALIZED__;
    vi.restoreAllMocks();
  });

  it.each(['open', 'closed'] as const)(
    'sends events to the actual %s component field',
    async (mode) => {
      document.body.innerHTML = '<x-field></x-field><input id="outside">';
      const host = document.querySelector('x-field')!;
      const root = host.attachShadow({ mode });
      root.innerHTML = '<input id="inner">';
      const field = root.querySelector('input')!;
      field.focus();
      const keys: string[] = [];
      field.addEventListener('keydown', (event) => keys.push((event as KeyboardEvent).key));
      const directHostEvents = vi.spyOn(host, 'dispatchEvent');
      let listener: any;
      new Function('window', 'document', 'chrome', source)(window, document, {
        dom: {
          openOrClosedShadowRoot: (element: Element) =>
            element === host ? root : element.shadowRoot,
        },
        runtime: {
          onMessage: {
            addListener: (handler: any) => {
              listener = handler;
            },
          },
        },
      });
      const send = (args: any) =>
        new Promise<any>((resolve) =>
          listener({ action: 'simulateKeyboard', ...args }, {}, resolve),
        );
      expect((await send({ keys: 'Enter' })).success).toBe(true);
      expect(keys).toEqual(['Enter']);
      expect(directHostEvents).not.toHaveBeenCalled();
      const invalid = await send({ keys: 'Enter,Bogus' });
      expect(invalid.dispatched).toBe(false);
      expect(keys).toEqual(['Enter']);
      const outside = document.getElementById('outside')!;
      const outsideKey = vi.fn();
      outside.addEventListener('keydown', outsideKey);
      expect((await send({ keys: 'Tab', selector: '#outside' })).success).toBe(true);
      expect(outsideKey).toHaveBeenCalledTimes(1);
      expect(keys).toEqual(['Enter']);
    },
  );
});
