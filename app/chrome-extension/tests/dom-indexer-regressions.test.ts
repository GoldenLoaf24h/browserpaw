import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  inPageDOMPruner,
  inPageFocusIndex,
  inPageGetElementCoordinates,
  getIsolatedIndexMap,
  getIndexFingerprintMap,
  findIndexedElement,
  inPageReindexFrame,
  wrapElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import {
  fastSnapshot,
  getClawFastCache,
} from '../entrypoints/background/tools/browser/fast-snapshot';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import {
  isLiteralText,
  normalizeKeySequence,
} from '../entrypoints/background/tools/browser/keyboard';
import { clickTool } from '../entrypoints/background/tools/browser/interaction';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import {
  assertTabInjectable,
  isRestrictedChromeUrl,
  pingActionForFiles,
  PING_ACTION_PREFIX,
} from '../utils/restricted-url';

/**
 * Regressions for defects found during the GL Gauntlet audit:
 * - elementCount was always 0 because prunedElementCount was never incremented
 * - interactiveCount was identical to elementCount because it counted informational nodes
 * - CDP double-click sent one press/release pair with clickCount 2, so dblclick never fired
 * - inPageFocusIndex must focus without firing click handlers
 * - live checkbox state must be exposed as an attribute
 */
describe('dom-indexer regressions', () => {
  it('counts informational nodes in elementCount but not in interactiveCount', () => {
    const prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 110,
        bottom: 60,
        width: 100,
        height: 50,
        toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      document.body.innerHTML = '<h1>Heading</h1><button>Go</button>';

      const res = inPageDOMPruner();

      expect(res.elementCount).toBe(2);
      expect(res.interactiveCount).toBe(1);
    } finally {
      Element.prototype.getBoundingClientRect = prevRect;
      document.body.innerHTML = '';
    }
  });

  it('double click dispatches clickCount 1 then 2 so dblclick can fire', async () => {
    const prevChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      ...prevChrome,
      tabs: {
        ...prevChrome?.tabs,
        get: vi.fn().mockResolvedValue({ id: 77, url: 'https://x.test' }),
      },
    };
    const dispatched: Array<Record<string, any>> = [];
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation((async (
      _tabId: number,
      _owner: string,
      fn: () => Promise<any>,
    ) => fn()) as any);
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation((async (
      _tabId: number,
      method: string,
      params?: Record<string, any>,
    ) => {
      if (method === 'Input.dispatchMouseEvent') dispatched.push(params || {});
      return {};
    }) as any);

    const res = await clickTool.execute({ tabId: 77, coordinate: { x: 30, y: 40 }, double: true });

    expect(res.isError).toBe(false);
    const presses = dispatched.filter((e) => e.type === 'mousePressed');
    expect(presses.map((e) => e.clickCount)).toEqual([1, 2]);
    expect(dispatched.filter((e) => e.type === 'mouseReleased').map((e) => e.clickCount)).toEqual([
      1, 2,
    ]);
    expect(presses.every((e) => e.buttons === 1)).toBe(true);

    (globalThis as any).chrome = prevChrome;
  });

  it('inPageFocusIndex focuses the indexed element and reports it', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    getIsolatedIndexMap().set(901, wrapElement(input));

    const res = inPageFocusIndex(901);

    expect(res.success).toBe(true);
    expect(res.tagName).toBe('input');
    expect(res.focused).toBe(true);
    expect(document.activeElement).toBe(input);

    input.remove();
    getIsolatedIndexMap().delete(901);
  });

  it('inPageFocusIndex rejects non-positive indexes', () => {
    const res = inPageFocusIndex(0);
    expect(res.success).toBe(false);
    expect(res.error).toContain('positive 1-based');
  });

  it('inPageFocusIndex reports a stale index instead of silently succeeding', () => {
    const res = inPageFocusIndex(999999);
    expect(res.success).toBe(false);
    expect(res.error).toContain('not found');
  });

  it('inPageGetElementCoordinates returns the live centre for an indexed element', () => {
    const btn = document.createElement('button');
    btn.textContent = 'PING';
    document.body.appendChild(btn);
    getIsolatedIndexMap().set(902, wrapElement(btn));

    const res = inPageGetElementCoordinates(902);

    expect(res.success).toBe(true);
    expect(res.tagName).toBe('button');
    expect(typeof res.x).toBe('number');
    expect(typeof res.y).toBe('number');

    btn.remove();
    getIsolatedIndexMap().delete(902);
  });

  describe('chrome_keyboard key vs literal text classification', () => {
    it('treats prose as literal text to type', () => {
      expect(isLiteralText('AGENT-OK')).toBe(true);
      expect(isLiteralText('Hello World')).toBe(true);
      expect(isLiteralText('ops@gauntlet.lab')).toBe(true);
    });

    it('keeps named keys and chords out of the text path', () => {
      expect(isLiteralText('Enter')).toBe(false);
      expect(isLiteralText('a')).toBe(false);
      expect(isLiteralText('Ctrl+C')).toBe(false);
      expect(isLiteralText('ArrowDown ArrowDown Enter')).toBe(false);
      expect(isLiteralText('Page Down')).toBe(false);
      expect(isLiteralText('Page Up')).toBe(false);
      expect(isLiteralText('Arrow Up')).toBe(false);
    });

    it('normalizes space-separated key sequences to the comma form the helper parses', () => {
      expect(normalizeKeySequence('ArrowDown ArrowDown Enter')).toBe('ArrowDown,ArrowDown,Enter');
      expect(normalizeKeySequence('Enter')).toBe('Enter');
      expect(normalizeKeySequence('Enter,Tab')).toBe('Enter,Tab');
      expect(normalizeKeySequence('AGENT-OK')).toBe('AGENT-OK');
      expect(normalizeKeySequence('Page Down')).toBe('PageDown');
      expect(normalizeKeySequence('Arrow Up')).toBe('ArrowUp');
    });
  });

  describe('restricted page guard', () => {
    it('flags browser internal and web store pages only', () => {
      expect(isRestrictedChromeUrl('chrome://settings')).toBe(true);
      expect(isRestrictedChromeUrl('Chrome://settings')).toBe(true);
      expect(isRestrictedChromeUrl('edge://flags')).toBe(true);
      expect(isRestrictedChromeUrl('EDGE://flags')).toBe(true);
      expect(isRestrictedChromeUrl('VIEW-SOURCE:https://example.com')).toBe(true);
      expect(isRestrictedChromeUrl('https://chrome.google.com/webstore/detail/x')).toBe(true);
      expect(isRestrictedChromeUrl('https://microsoftedge.microsoft.com/addons/x')).toBe(true);
      expect(isRestrictedChromeUrl('https://example.com')).toBe(false);
      expect(isRestrictedChromeUrl(undefined)).toBe(false);
    });

    it('assertTabInjectable throws the friendly error and never lets a raw chrome:// failure through', async () => {
      const prevChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        ...prevChrome,
        tabs: {
          ...prevChrome?.tabs,
          get: vi.fn().mockResolvedValue({ id: 9, url: 'chrome://settings' }),
        },
      };

      await expect(assertTabInjectable(9)).rejects.toThrow(
        /Cannot operate on this browser internal page or web store page/,
      );

      (globalThis as any).chrome = prevChrome;
    });

    it('assertTabInjectable passes ordinary http(s) tabs through', async () => {
      const prevChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        ...prevChrome,
        tabs: {
          ...prevChrome?.tabs,
          get: vi.fn().mockResolvedValue({ id: 10, url: 'https://example.com/app' }),
        },
      };

      await expect(assertTabInjectable(10)).resolves.toBeUndefined();

      (globalThis as any).chrome = prevChrome;
    });

    it('assertTabInjectable blocks cloud instance metadata endpoints (169.254.169.254) to prevent SSRF', async () => {
      const prevChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        ...prevChrome,
        tabs: {
          ...prevChrome?.tabs,
          get: vi
            .fn()
            .mockResolvedValue({ id: 11, url: 'http://169.254.169.254/latest/meta-data/' }),
        },
      };

      await expect(assertTabInjectable(11)).rejects.toThrow(
        /Security Restriction: Navigation or requests to cloud instance metadata service/,
      );

      (globalThis as any).chrome = prevChrome;
    });
  });

  describe('ping action keyed on the injected file set', () => {
    it('is stable for the same file set and distinct across file sets', () => {
      const a = pingActionForFiles(['inject-scripts/click-helper.js']);
      const b = pingActionForFiles(['inject-scripts/click-helper.js']);
      const c = pingActionForFiles(['inject-scripts/fill-helper.js']);

      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a.startsWith(PING_ACTION_PREFIX)).toBe(true);
    });

    it('every shipped helper answers the mcp_ping_ prefix so no tool waits out the 300ms timeout', async () => {
      const fs = await import('node:fs');
      const dir = 'inject-scripts';
      const helpers = fs
        .readdirSync(dir)
        .filter((f: string) => f.endsWith('.js') && f !== 'inject-bridge.js');

      // interactive-elements-helper and inject-bridge were removed with the
      // userscript/inject-script dead-code cleanup; 8 helpers remain shipped.
      expect(helpers.length).toBeGreaterThanOrEqual(8);
      for (const helper of helpers) {
        const src = fs.readFileSync(`${dir}/${helper}`, 'utf-8');
        expect(src.includes('mcp_ping_'), `${helper} must answer the file-set ping`).toBe(true);
      }
    });
  });

  describe('safeClickPoint survives re-injection', () => {
    it('stores the map on globalThis so a rebuilt in-page engine reuses it', async () => {
      const { safeClickPointWeakMap } =
        await import('../entrypoints/background/tools/browser/dom-indexer');
      const key = Symbol.for('__browser_use_safe_click_point_map__');

      expect((globalThis as any)[key]).toBe(safeClickPointWeakMap);
    });
  });

  describe('D-03: inPageReindexFrame subframe index migration and self-healing', () => {
    it('migrates getIndexFingerprintMap keys when offsetting subframe indices', () => {
      document.body.innerHTML = '<button id="btn-save">Save</button>';
      const btn = document.getElementById('btn-save')!;

      const isolatedMap = getIsolatedIndexMap();
      isolatedMap.clear();
      isolatedMap.set(1, wrapElement(btn));

      const fpMap = getIndexFingerprintMap();
      fpMap.clear();
      fpMap.set(1, {
        tag: 'button',
        id: 'btn-save',
        text: 'Save',
        role: 'button',
        isInteractive: true,
      });

      // Shift indices by offset +10 (subframe reindexing)
      inPageReindexFrame(10);

      // Verify fingerprint map entries were migrated from 1 -> 11
      expect(fpMap.get(1)).toBeUndefined();
      expect(fpMap.get(11)).toBeDefined();
      expect(fpMap.get(11)?.id).toBe('btn-save');

      // Simulate DOM element disconnection / React re-render: replace DOM node
      btn.remove();
      const newBtn = document.createElement('button');
      newBtn.id = 'btn-save';
      newBtn.textContent = 'Save';
      document.body.appendChild(newBtn);

      // Self-healing should recover the new element using the reindexed fingerprint key (11)
      const recovered = findIndexedElement(11);
      expect(recovered).toBe(newBtn);
    });
  });

  describe('D-20: fast snapshot must not corrupt the standard action index namespace', () => {
    let prevRect: any;

    const resetFastCache = () => {
      const cache = getClawFastCache();
      cache.ids = new WeakMap<Element, number>();
      cache.nodes.clear();
      cache.actionElements?.clear();
      cache.next = 1;
    };

    beforeEach(() => {
      prevRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        return {
          x: 10,
          y: 10,
          left: 10,
          top: 10,
          right: 110,
          bottom: 60,
          width: 100,
          height: 50,
          toJSON: () => ({}),
        } as DOMRect;
      };
      resetFastCache();
    });

    afterEach(() => {
      Element.prototype.getBoundingClientRect = prevRect;
      document.body.innerHTML = '';
      getIsolatedIndexMap().clear();
      getIndexFingerprintMap().clear();
      (globalThis as any)[Symbol.for('__browser_use_last_snapshot_type__')] = undefined;
      resetFastCache();
    });

    it('read_dom({fast:true}) keeps action index 2 on the input whose fast node id is 1', async () => {
      document.body.innerHTML = '<input id="field"><button id="btn">Save</button>';
      const input = document.getElementById('field')!;
      const button = document.getElementById('btn')!;

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://x.test',
        title: 'X',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (_target: any, fnName: string, fnArgs?: any[]) => {
          if (fnName === 'inPageFastSnapshot') {
            return [{ frameId: 0, result: fastSnapshot(fnArgs?.[0]) }] as any;
          }
          return [] as any;
        },
      );

      const res = await readDOMTool.execute({ fast: true, tabId: 1 } as any);
      expect(res.isError).toBe(false);
      const payload = JSON.parse(res.content[0].text as string);

      // Action 2 is the input's "Open" click action; its node identity is 1.
      // That divergence is what the old code mis-resolved through the standard map.
      const openAction = payload.actions.find((a: any) => a.id === 'e2');
      expect(openAction).toBeDefined();
      expect(openAction.node).toBe(1);
      expect(openAction.node).not.toBe(2);

      expect(findIndexedElement(2)).toBe(input);
      expect(findIndexedElement(3)).toBe(button);
    });

    it('standard -> fast -> standard keeps both index namespaces isolated', () => {
      document.body.innerHTML = '<input id="field"><button id="btn">Save</button>';
      const input = document.getElementById('field')!;
      const button = document.getElementById('btn')!;

      inPageDOMPruner();
      expect(findIndexedElement(1)).toBe(input);
      expect(findIndexedElement(2)).toBe(button);

      const fast = fastSnapshot();
      expect(fast).toBeTruthy();
      // Fast snapshot must never publish traversal node ids into the standard map.
      expect(getIsolatedIndexMap().size).toBe(0);
      expect(fast!.actions.find((a) => a.id === 'e2')!.node).not.toBe(2);
      // Index 2 is the input's "Open" action, not the standard-indexed button.
      expect(findIndexedElement(2)).toBe(input);

      inPageDOMPruner();
      expect(findIndexedElement(1)).toBe(input);
      expect(findIndexedElement(2)).toBe(button);
    });
  });
});
