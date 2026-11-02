import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  inPageDOMPruner,
  inPageFocusIndex,
  inPageGetElementCoordinates,
  getIsolatedIndexMap,
  findIndexedElement,
  inPageInteractIndex,
  wrapElement,
  inPageSetIndexNamespace,
  parseElementIndex,
  INDEX_NAMESPACE_SIZE,
  indexElement,
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
  ExpectedPageRestrictionError,
  isRestrictedChromeUrl,
  isExpectedPageRestrictionError,
  logUnexpectedToolError,
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
  beforeEach(() => {
    // Each test starts a new document execution context.
    const g = globalThis as any;
    delete g[Symbol.for('__browser_use_index_identity__')];
    delete g[Symbol.for('__browser_use_index_namespace__')];
    getIsolatedIndexMap().clear();
  });
  describe('published index safety', () => {
    beforeEach(() => {
      getIsolatedIndexMap().clear();
      getClawFastCache().actionElements?.clear();
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 110,
        bottom: 60,
        width: 100,
        height: 50,
        toJSON: () => ({}),
      } as DOMRect);
    });

    afterEach(() => {
      document.body.innerHTML = '';
    });

    it('rejects removed index 2 after a refresh instead of clicking spacer with success', () => {
      document.body.innerHTML =
        '<button>Swap</button><button id="gone">Gone target</button><div>spacer</div>';
      const first = inPageDOMPruner();
      const index = first.indexedElements!.find((el) => el.attributes?.id === 'gone')!.index;
      expect(index).toBe(2);
      const spacer = document.querySelector('div')!;
      const clicked = vi.fn();
      spacer.addEventListener('click', clicked);
      document.getElementById('gone')!.remove();
      inPageDOMPruner();

      const result = inPageInteractIndex(index);
      expect(clicked).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('refresh the index tree');
    });

    it('does not heal a removed node onto another button with identical text', () => {
      document.body.innerHTML = '<button id="gone">Duplicate</button><button>Duplicate</button>';
      const first = inPageDOMPruner();
      const index = first.indexedElements!.find((el) => el.attributes?.id === 'gone')!.index;
      const duplicate = document.querySelectorAll('button')[1];
      const clicked = vi.fn();
      duplicate.addEventListener('click', clicked);
      document.getElementById('gone')!.remove();

      expect(inPageInteractIndex(index).success).toBe(false);
      expect(clicked).not.toHaveBeenCalled();
    });

    it('keeps a live target index across insertion, removal and reordered snapshots', () => {
      document.body.innerHTML = '<button id="target">Target</button><button>Other</button>';
      const first = inPageDOMPruner();
      const index = first.indexedElements!.find((el) => el.attributes?.id === 'target')!.index;
      const target = document.getElementById('target')!;
      const clicked = vi.fn();
      target.addEventListener('click', clicked);
      expect(inPageInteractIndex(index).success).toBe(true);
      document.body.insertAdjacentHTML('afterbegin', '<button id="inserted">Inserted</button>');
      document.body.appendChild(target);
      const second = inPageDOMPruner();
      expect(second.indexedElements!.find((el) => el.attributes?.id === 'target')!.index).toBe(
        index,
      );
      document.getElementById('inserted')!.remove();
      inPageDOMPruner();
      expect(findIndexedElement(index)).toBe(target);
      expect(inPageInteractIndex(index).success).toBe(true);
      expect(clicked).toHaveBeenCalledTimes(2);
    });

    it('does not reuse a fast action reference when its node is removed', () => {
      document.body.innerHTML = '<button id="gone">Gone</button><button id="other">Other</button>';
      const first = fastSnapshot()!;
      const oldAction = first.actions.find((a) => a.label === 'Gone')!;
      document.getElementById('gone')!.remove();
      fastSnapshot();
      expect(findIndexedElement(oldAction.id)).toBeNull();
    });
  });

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
      expect(isRestrictedChromeUrl('chrome-error://chromewebdata/')).toBe(true);
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

      await expect(assertTabInjectable(9)).rejects.toBeInstanceOf(ExpectedPageRestrictionError);
      await expect(assertTabInjectable(9)).rejects.toThrow(
        /Cannot operate on this browser internal page or web store page/,
      );

      (globalThis as any).chrome = prevChrome;
    });

    it('does not log expected page restrictions as unexpected extension errors', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const restricted = new ExpectedPageRestrictionError(
        'Cannot operate on this browser internal page',
      );

      expect(isExpectedPageRestrictionError(restricted)).toBe(true);
      expect(
        isExpectedPageRestrictionError(new Error('Frame with ID 0 is showing error page')),
      ).toBe(true);
      expect(isExpectedPageRestrictionError(new Error('Element not found'))).toBe(false);

      logUnexpectedToolError('Tool execution failed:', restricted);
      logUnexpectedToolError('Tool execution failed:', new Error('Element not found'));

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith('Tool execution failed:', expect.any(Error));
    });

    it('assertTabInjectable rejects a Chromium error page with an actionable message', async () => {
      const prevChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        ...prevChrome,
        tabs: {
          ...prevChrome?.tabs,
          get: vi.fn().mockResolvedValue({ id: 12, url: 'chrome-error://chromewebdata/' }),
        },
      };

      await expect(assertTabInjectable(12)).rejects.toThrow(
        /Chrome is showing an error page.*Reload or navigate to a working page/,
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

  it('expires a replaced node even when its ID and text are unchanged', () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    const oldNode = document.getElementById('save')!;
    const oldIndex = indexElement(oldNode);
    oldNode.outerHTML = '<button id="save">Save</button>';
    expect(findIndexedElement(oldIndex)).toBeNull();
    const newNode = document.getElementById('save')!;
    const newIndex = indexElement(newNode);
    expect(newIndex).toBeGreaterThan(oldIndex);
    expect(findIndexedElement(newIndex)).toBe(newNode);
  });

  it('clearing the lookup cache cannot recycle an issued reference', () => {
    document.body.innerHTML = '<button>Old</button>';
    const old = indexElement(document.querySelector('button')!);
    getIsolatedIndexMap().clear();
    document.body.innerHTML = '<button>New</button>';
    const next = indexElement(document.querySelector('button')!);
    expect(next).toBeGreaterThan(old);
    expect(findIndexedElement(old)).toBeNull();
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
      (globalThis as any)[Symbol.for('__browser_use_last_snapshot_type__')] = undefined;
      resetFastCache();
    });

    it('read_dom({fast:true}) publishes numeric and e references to the same node', async () => {
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

      const res = await readDOMTool.execute({ fast: true, includeDetails: true, tabId: 1 } as any);
      expect(res.isError).toBe(false);
      const payload = JSON.parse(res.content[0].text as string);

      const inputAction = payload.actions.find((a: any) => a.kind === 'fill');
      const buttonAction = payload.actions.find((a: any) => a.label === 'Save');
      expect(inputAction).toBeDefined();
      expect(buttonAction).toBeDefined();
      expect(findIndexedElement(inputAction.id)).toBe(input);
      expect(findIndexedElement(Number(inputAction.id.slice(1)))).toBe(input);
      expect(findIndexedElement(buttonAction.id)).toBe(button);
    });

    it('standard -> fast -> standard keeps one stable element identity', () => {
      document.body.innerHTML = '<input id="field"><button id="btn">Save</button>';
      const input = document.getElementById('field')!;
      const button = document.getElementById('btn')!;

      inPageDOMPruner();
      expect(findIndexedElement(1)).toBe(input);
      expect(findIndexedElement(2)).toBe(button);

      const fast = fastSnapshot();
      expect(fast).toBeTruthy();
      expect(getIsolatedIndexMap().size).toBeGreaterThan(0);
      expect(findIndexedElement('e1')).toBe(input);
      expect(findIndexedElement('e2')).toBe(button);
      expect(findIndexedElement(2)).toBe(button);

      inPageDOMPruner();
      expect(findIndexedElement(1)).toBe(input);
      expect(findIndexedElement(2)).toBe(button);
    });
  });
  describe('Index Safety and Namespace Isolation Suite', () => {
    let prevRect: any;

    beforeEach(() => {
      getIsolatedIndexMap().clear();
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
    });

    afterEach(() => {
      document.body.innerHTML = '';
      if (prevRect) Element.prototype.getBoundingClientRect = prevRect;
    });

    it('parseElementIndex strictly rejects invalid strings, whitespace, and phantom zero inputs', () => {
      expect(parseElementIndex('')).toBeNull();
      expect(parseElementIndex('   ')).toBeNull();
      expect(parseElementIndex('e')).toBeNull();
      expect(parseElementIndex('ref_')).toBeNull();
      expect(parseElementIndex('ref_abc')).toBeNull();
      expect(parseElementIndex('e_123')).toBeNull();
      expect(parseElementIndex(0)).toBeNull();
      expect(parseElementIndex('0')).toBeNull();
      expect(parseElementIndex(-1)).toBeNull();
      expect(parseElementIndex('-1')).toBeNull();
      expect(parseElementIndex(null)).toBeNull();
      expect(parseElementIndex(undefined)).toBeNull();

      expect(parseElementIndex(5)).toEqual({ numericIndex: 5, isExplicitFast: false });
      expect(parseElementIndex('5')).toEqual({
        numericIndex: 5,
        isExplicitFast: false,
        rawString: '5',
      });
      expect(parseElementIndex('e12')).toEqual({
        numericIndex: 12,
        isExplicitFast: true,
        rawString: 'e12',
      });
      expect(parseElementIndex('ref_42')).toEqual({
        numericIndex: 42,
        isExplicitFast: false,
        rawString: 'ref_42',
      });
    });

    it('inPageGetElementCoordinates rejects invalid ref/e strings without mapping to index 0', () => {
      const emptyRes = inPageGetElementCoordinates('');
      expect(emptyRes.success).toBe(false);
      expect(emptyRes.error).toContain('Invalid index or ref format');

      const refOnlyRes = inPageGetElementCoordinates('ref_');
      expect(refOnlyRes.success).toBe(false);
      expect(refOnlyRes.error).toContain('Invalid index or ref format');

      const eOnlyRes = inPageGetElementCoordinates('e');
      expect(eOnlyRes.success).toBe(false);
      expect(eOnlyRes.error).toContain('Invalid index or ref format');

      const zeroRes = inPageGetElementCoordinates(0);
      expect(zeroRes.success).toBe(false);
      expect(zeroRes.error).toContain('Invalid index or ref format');
    });

    it('preserves document namespace across context resets to prevent subframe collision', () => {
      document.body.innerHTML = '<button id="b9">One</button>';
      const b9 = document.getElementById('b9')!;

      expect(inPageSetIndexNamespace(INDEX_NAMESPACE_SIZE)).toBe(true);
      inPageDOMPruner();
      expect(findIndexedElement(INDEX_NAMESPACE_SIZE + 1)).toBe(b9);

      const g = globalThis as any;
      delete g[Symbol.for('__browser_use_index_identity__')];
      expect(inPageSetIndexNamespace(INDEX_NAMESPACE_SIZE * 2)).toBe(true);

      const b10 = document.createElement('button');
      b10.id = 'b10';
      b10.textContent = 'Two';
      document.body.appendChild(b10);

      inPageDOMPruner();
      expect(findIndexedElement(INDEX_NAMESPACE_SIZE + 1)).toBe(b9);
      expect(findIndexedElement(INDEX_NAMESPACE_SIZE + 2)).toBe(b10);
    });

    it('ensures node churn never silently re-assigns published indices to other nodes', () => {
      document.body.innerHTML = '<button id="stay">Stay</button><button id="churn">Churn</button>';
      const stay = document.getElementById('stay')!;
      const churn = document.getElementById('churn')!;

      inPageDOMPruner();
      expect(findIndexedElement(1)).toBe(stay);
      expect(findIndexedElement(2)).toBe(churn);

      churn.remove();
      const fresh = document.createElement('button');
      fresh.id = 'fresh';
      fresh.textContent = 'Fresh';
      document.body.appendChild(fresh);

      inPageDOMPruner();

      expect(findIndexedElement(1)).toBe(stay);
      expect(findIndexedElement(2)).toBeNull();
      expect(findIndexedElement(3)).toBe(fresh);
    });
  });
});
