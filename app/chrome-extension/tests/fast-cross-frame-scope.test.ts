import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fastSnapshot,
  getClawFastCache,
} from '../entrypoints/background/tools/browser/fast-snapshot';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import {
  findIndexedElement,
  inPageSetIndexNamespace,
  INDEX_NAMESPACE_SIZE,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('Fast DOM: Scope, Selector, Exclude, Viewport, Limit, and Cross-Frame Persistent References', () => {
  beforeEach(() => {
    chrome.webNavigation = {
      ...chrome.webNavigation,
      getAllFrames: vi.fn(async () => [{ frameId: 0 }]),
    } as any;
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    getClawFastCache().actionElements?.clear();
    getClawFastCache().nodes.clear();
    delete (globalThis as any)[Symbol.for('__browser_use_index_namespace__')];
    delete (globalThis as any)[Symbol.for('__browser_use_index_identity__')];
    delete (globalThis as any).__pawFast;
    delete (globalThis as any).__clawFast;
    (window as any).innerWidth = 1000;
    (window as any).innerHeight = 800;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 110,
        bottom: 40,
        width: 100,
        height: 30,
        toJSON: () => {},
      };
    });
  });

  describe('1. Real DOM scope / selector containment and match detection', () => {
    it('restricts actions and extracted text strictly to selector matching container', () => {
      document.body.innerHTML = `
        <header id="site-header">
          <button id="nav-btn">Header Nav</button>
          <span>Header Info</span>
        </header>
        <main id="target-scope">
          <button id="checkout-btn">Checkout Now</button>
          <input id="promo-code" type="text" placeholder="Promo code" value="SPRING2026" />
          <p>Order Summary Body Text</p>
        </main>
        <footer id="site-footer">
          <button id="footer-btn">Footer Link</button>
        </footer>
      `;

      const res = fastSnapshot({ selector: '#target-scope' });
      expect(res).not.toBeNull();
      expect(res!.selectorMatched).toBe(true);

      const actionLabels = res!.actions.map((a) => a.label);
      expect(actionLabels).toContain('Checkout Now');
      expect(actionLabels).toContain('Promo code');
      expect(res!.actions.some((a) => a.value === 'SPRING2026')).toBe(true);
      expect(actionLabels).not.toContain('Header Nav');
      expect(actionLabels).not.toContain('Footer Link');

      expect(res!.text).toContain('Order Summary Body Text');
      expect(res!.text).not.toContain('Header Info');
    });

    it('reports selectorMatched: false and returns zero actions when scope selector does not exist', () => {
      document.body.innerHTML = `
        <div id="content">
          <button id="btn1">Available Button</button>
        </div>
      `;

      const res = fastSnapshot({ scope: '#non-existent-modal' });
      expect(res).not.toBeNull();
      expect(res!.selectorMatched).toBe(false);
      expect(res!.actions).toHaveLength(0);
      expect(res!.text).toBe('');
    });

    it('deduplicates nested container scopes to prevent duplicate action indexing', () => {
      document.body.innerHTML = `
        <div class="card outer-card">
          <button id="outer-btn">Outer</button>
          <div class="card inner-card">
            <button id="inner-btn">Inner</button>
          </div>
        </div>
      `;

      const res = fastSnapshot({ selector: '.card' });
      expect(res).not.toBeNull();
      expect(res!.selectorMatched).toBe(true);

      const outerActions = res!.actions.filter((a) => a.label === 'Outer');
      const innerActions = res!.actions.filter((a) => a.label === 'Inner');
      expect(outerActions).toHaveLength(1);
      expect(innerActions).toHaveLength(1);
    });

    it('throws explicit error on invalid scope/selector syntax without swallowing', () => {
      document.body.innerHTML = '<button id="btn">Valid</button>';
      expect(() => {
        fastSnapshot({ selector: 'div:invalid(syntax[' });
      }).toThrow(/Invalid scope\/selector/);
    });
  });

  describe('2. Real DOM exclusion filtering', () => {
    it('excludes elements matching complex selectors (:is(), commas in attributes) without naive split breakage', () => {
      document.body.innerHTML = `
        <div id="app">
          <button id="good-btn">Submit Form</button>
          <div class="ad-container marketing-banner">
            <button id="ad-btn">Buy Sponsored Product</button>
            <span>Special Offer Advertisement</span>
          </div>
          <div data-badge="promo,sponsor">
            <button id="promo-btn">Special Deal</button>
          </div>
        </div>
      `;

      const res = fastSnapshot({
        exclude: [':is(.ad-container, .marketing-banner)', '[data-badge="promo,sponsor"]'],
      });
      expect(res).not.toBeNull();

      const labels = res!.actions.map((a) => a.label);
      expect(labels).toContain('Submit Form');
      expect(labels).not.toContain('Buy Sponsored Product');
      expect(labels).not.toContain('Special Deal');

      expect(res!.text).toContain('Submit Form');
      expect(res!.text).not.toContain('Special Offer Advertisement');
    });

    it('throws explicit error on invalid exclude selector syntax', () => {
      document.body.innerHTML = '<button id="btn">Keep</button>';
      expect(() => {
        fastSnapshot({ exclude: 'div:invalid(syntax[' });
      }).toThrow(/Invalid exclude selector/);
    });

    it('caps select options per element without hiding the omitted count', () => {
      document.body.innerHTML = `<select id="large">${Array.from(
        { length: 120 },
        (_, index) => `<option value="${index}">Option ${index}</option>`,
      ).join('')}</select>`;

      const res = fastSnapshot();
      expect(res!.actions.filter((action) => action.kind === 'select')).toHaveLength(50);
      expect(res!.omitted_actions).toBe(69);
    });
  });

  describe('3. maxTextLength per-element truncation vs body text 6000 budget', () => {
    it('truncates element action label to maxTextLength while retaining full paragraph text up to 6000 chars', () => {
      const longLabel = 'A'.repeat(200);
      const longParagraph = 'Paragraph word '.repeat(100); // ~1500 chars
      document.body.innerHTML = `
        <button id="long-btn">${longLabel}</button>
        <p id="long-p">${longParagraph}</p>
      `;

      const res = fastSnapshot({ maxTextLength: 40 });
      expect(res).not.toBeNull();

      // Button action label must be truncated to 40 characters
      const action = res!.actions.find((a) => a.id.startsWith('e'));
      expect(action).toBeDefined();
      expect(action!.label).toHaveLength(40);

      // Body text must retain the full ~1500 characters, NOT truncated to 40!
      expect(res!.text.length).toBeGreaterThan(1000);
      expect(res!.text).toContain('Paragraph word');
      expect(res!.textTruncated).toBe(true);
    });
  });

  describe('3. Viewport threshold bounds and culling', () => {
    it('respects viewportThreshold and activeViewportOnly boundary filtering', () => {
      document.body.innerHTML = `
        <button id="btn-in">In Viewport</button>
        <button id="btn-near">Near Viewport</button>
        <button id="btn-far">Far Offscreen</button>
      `;

      const btnIn = document.getElementById('btn-in')!;
      const btnNear = document.getElementById('btn-near')!;
      const btnFar = document.getElementById('btn-far')!;

      btnIn.getBoundingClientRect = () => ({
        x: 100,
        y: 100,
        width: 80,
        height: 30,
        top: 100,
        bottom: 130,
        left: 100,
        right: 180,
        toJSON: () => {},
      });
      btnNear.getBoundingClientRect = () => ({
        x: 100,
        y: 950,
        width: 80,
        height: 30,
        top: 950,
        bottom: 980,
        left: 100,
        right: 180,
        toJSON: () => {},
      });
      btnFar.getBoundingClientRect = () => ({
        x: 100,
        y: 2500,
        width: 80,
        height: 30,
        top: 2500,
        bottom: 2530,
        left: 100,
        right: 180,
        toJSON: () => {},
      });

      // window.innerHeight = 800.
      // With activeViewportOnly: true (pad = 0), btnNear (y=965) should be culled.
      const activeOnlyRes = fastSnapshot({ activeViewportOnly: true });
      const activeLabels = activeOnlyRes!.actions.map((a) => a.label);
      expect(activeLabels).toContain('In Viewport');
      expect(activeLabels).not.toContain('Near Viewport');
      expect(activeLabels).not.toContain('Far Offscreen');

      // With viewportThreshold: 300 (bounds y up to 800 + 300 = 1100), btnNear (y=965) is included!
      const thresholdRes = fastSnapshot({ viewportThreshold: 300 });
      const thresholdLabels = thresholdRes!.actions.map((a) => a.label);
      expect(thresholdLabels).toContain('In Viewport');
      expect(thresholdLabels).toContain('Near Viewport');
      expect(thresholdLabels).not.toContain('Far Offscreen');
    });
  });

  describe('4. Action budget limits and omitted_actions precision', () => {
    it('truncates interactive actions to specified limit and increments omitted_actions', () => {
      let html = '';
      for (let i = 1; i <= 20; i++) {
        html += `<button id="btn-${i}">Action Item ${i}</button>\n`;
      }
      document.body.innerHTML = html;

      const res = fastSnapshot({ limit: 5 });
      expect(res).not.toBeNull();
      const interactiveActions = res!.actions.filter((a) => /^e\d+$/.test(a.id));
      expect(interactiveActions).toHaveLength(5);
      expect(res!.omitted_actions).toBe(15);
    });

    it('budgets unique element ids while keeping fill and click for the same editable element', () => {
      let html = '';
      for (let i = 1; i <= 150; i++) {
        html += `<input id="field-${i}" type="text" value="v${i}" />\n`;
      }
      document.body.innerHTML = html;

      const res = fastSnapshot({ limit: 150 })!;
      const interactive = res.actions.filter((a) => /^e\d+$/.test(a.id));
      const ids = new Set(interactive.map((a) => a.id));

      expect(ids.size).toBe(150);
      expect(interactive.filter((a) => a.id === 'e1').map((a) => a.kind)).toEqual(
        expect.arrayContaining(['fill', 'click']),
      );
      expect(res.omitted_actions).toBe(0);
    });

    it('keeps marker semantics aligned with the retained element budget', () => {
      document.body.innerHTML = Array.from(
        { length: 10 },
        (_, i) => `<button id="marker-${i}">Marker ${i}</button>`,
      ).join('');

      const res = fastSnapshot({ limit: 5 })!;

      expect(res.marker[8] as any[]).toHaveLength(5);
      expect(res.omitted_elements).toBe(5);
      expect(res.omitted_actions).toBe(5);
    });
  });

  describe('5. Cross-Frame integration: persistent namespaces, frame attribute retention, and details consumption', () => {
    it('marks missing inventory frames incomplete even when all returned snapshots succeeded', async () => {
      document.body.innerHTML = '<button>Observed</button>';
      const snap = fastSnapshot()!;
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: snap },
      ] as any);
      vi.stubGlobal('chrome', {
        ...chrome,
        webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0 }, { frameId: 8 }]) },
      });
      try {
        const result = await readDOMTool.execute({ fast: true, tabId: 1 });
        expect(JSON.parse(result.content[0].text as string).coverage).toMatchObject({
          status: 'incomplete',
          missingFrameIds: [8],
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
    it('keeps all 150 input refs and their action capabilities through the real global merge', async () => {
      document.body.innerHTML = Array.from(
        { length: 150 },
        (_, i) => `<input aria-label="Field ${i}" />`,
      ).join('');
      const snap = fastSnapshot()!;
      expect(
        new Set(
          snap.actions.filter((action) => /^e\d+$/.test(action.id)).map((action) => action.id),
        ).size,
      ).toBe(150);
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
        title: 'Inputs',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: snap },
      ] as any);
      const result = await readDOMTool.execute({ fast: true, includeDetails: true, tabId: 1 });
      const payload = JSON.parse(result.content[0].text as string);
      expect(payload.elementCount).toBe(150);
      const actions = payload.actions.filter((action: any) => /^e\d+$/.test(action.id));
      expect(actions).toHaveLength(300);
      expect(new Set(actions.map((action: any) => action.id)).size).toBe(150);
      expect(payload.omitted_elements).toBe(0);
    });
    it('deduplicates multiple action kinds for same element while preserving control value in snapshotElements', async () => {
      document.body.innerHTML = '<input id="username" type="text" value="alice" />';
      const mainSnap = fastSnapshot()!;
      // An editable input produces both 'fill' and 'click' in fastSnapshot
      expect(mainSnap.actions.filter((a) => a.id.startsWith('e'))).toHaveLength(2);

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
        title: 'Title',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: mainSnap },
      ] as any);

      const res = await readDOMTool.execute({ fast: true, includeDetails: true, tabId: 1 } as any);
      const payload = JSON.parse(res.content[0].text as string);

      // snapshotElements and treeString must deduplicate into 1 element with value preserved
      expect(payload.elementCount).toBe(1);
      expect(payload.treeString).toMatch(/^\[1\] textbox\b.*value="alice"$/);
    });

    it('enforces global limit truncation across multiple frames and accumulates omitted_actions', async () => {
      const mainSnap = {
        observationReused: true,
        url: 'https://test.local',
        title: 'Title',
        w: 1000,
        h: 800,
        text: 'Main text',
        scroll: { y: 0, height: 1000 },
        actions: [
          { id: 'e1', kind: 'click', role: 'button', label: 'Main 1' },
          { id: 'e2', kind: 'click', role: 'button', label: 'Main 2' },
          { id: 'e3', kind: 'click', role: 'button', label: 'Main 3' },
        ],
        marker: [],
        page_key: [],
        guards: {},
        omitted_actions: 1,
      };

      const subSnap = {
        observationReused: false,
        url: 'https://test.local/sub',
        title: 'Sub',
        w: 500,
        h: 400,
        text: 'Sub text',
        scroll: { y: 0, height: 500 },
        actions: [
          { id: 'e16777217', kind: 'click', role: 'button', label: 'Sub 1' },
          { id: 'e16777218', kind: 'click', role: 'button', label: 'Sub 2' },
          { id: 'e16777219', kind: 'click', role: 'button', label: 'Sub 3' },
        ],
        marker: [],
        page_key: [],
        guards: {},
        omitted_actions: 2,
      };

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
        title: 'Title',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: mainSnap },
        { frameId: 1, result: subSnap },
      ] as any);

      // Total 6 interactive actions across frames, with initial omitted: 1 + 2 = 3.
      // Pass limit: 4 -> global truncation cuts 2 actions -> total omitted becomes 3 + 2 = 5.
      const res = await readDOMTool.execute({
        fast: true,
        limit: 4,
        tabId: 1,
        includeDetails: true,
      } as any);
      const payload = JSON.parse(res.content[0].text as string);

      expect(payload.elementCount).toBe(4);
      expect(payload.observations).toEqual([
        { frameId: 0, reused: true },
        { frameId: 1, reused: false },
      ]);
      expect(payload.omitted_actions).toBe(5);
      expect(payload.treeString).toContain('[1] button "Main 1"');
      expect(payload.treeString).toContain('[16777217] button "Sub 1" frame="1"');
    });
    it('aggregates multi-frame actions preserving isolated persistent namespaces without renumbering', async () => {
      // Simulate Main Frame
      document.body.innerHTML = '<button id="main-btn">Main Button</button>';
      const mainBtn = document.getElementById('main-btn')!;
      const mainSnap = fastSnapshot()!;
      const mainAction = mainSnap.actions.find((a) => a.label === 'Main Button')!;
      expect(mainAction).toBeDefined();
      expect(mainAction.id).toBe('e1');
      expect(findIndexedElement('e1')).toBe(mainBtn);

      // Simulate Subframe inside independent namespace
      const subDoc = document.implementation.createHTMLDocument('subframe');
      subDoc.body.innerHTML = '<button id="sub-btn">Subframe Checkout</button>';
      const subBtn = subDoc.getElementById('sub-btn')!;

      // Set subframe document namespace to INDEX_NAMESPACE_SIZE (16777216)
      (globalThis as any)[Symbol.for('__browser_use_index_namespace__')] = INDEX_NAMESPACE_SIZE;
      delete (globalThis as any)[Symbol.for('__browser_use_index_identity__')];

      // In subframe document context, snapshot assigns e16777217
      const origDoc = globalThis.document;
      (globalThis as any).document = subDoc;
      const subSnap = fastSnapshot()!;
      (globalThis as any).document = origDoc;

      const subAction = subSnap.actions.find((a) => a.label === 'Subframe Checkout')!;
      expect(subAction).toBeDefined();
      expect(subAction.id).toBe('e' + (INDEX_NAMESPACE_SIZE + 1));

      // Wire executeInPage returning multi-frame result
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://example.com/app',
        title: 'App',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(async (target: any) => {
        if (target.allFrames) {
          return [
            { frameId: 0, result: mainSnap },
            { frameId: 10, result: subSnap },
          ] as any;
        }
        return [{ frameId: 0, result: mainSnap }] as any;
      });

      const result = await readDOMTool.execute({
        fast: true,
        includeDetails: true,
        tabId: 1,
      } as any);

      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.content[0].text as string);

      // Verify persistent namespace: main is [1], subframe is [16777217], NOT remapped to [2]!
      expect(payload.treeString).toContain('[1] button "Main Button"');
      expect(payload.treeString).toContain('<!-- Frame 10 -->');
      expect(payload.treeString).toContain(
        `[${INDEX_NAMESPACE_SIZE + 1}] button "Subframe Checkout" #sub-btn frame="10"`,
      );
      expect(payload.elementCount).toBe(2);

      // Verify Native fast-data consumption
      expect(payload.actions).toBeDefined();
      expect(payload.actions.some((a: any) => a.id === 'e1')).toBe(true);
      expect(payload.actions.some((a: any) => a.id === 'e' + (INDEX_NAMESPACE_SIZE + 1))).toBe(
        true,
      );

      expect(payload.unsupportedInFastMode).toBeUndefined();
    });

    it('rejects unsupported fast-only semantic options before taking an observation', async () => {
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://example.com/app',
      });
      const executeSpy = vi.spyOn(inPageEngine, 'executeInPage');

      const result = await readDOMTool.execute({
        fast: true,
        flattenCards: true,
        virtualizeViewport: true,
        tabId: 1,
      } as any);

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text as string)).toEqual({
        status: 'blocked',
        code: 'unsupported_fast_options',
        unsupported: ['flattenCards', 'virtualizeViewport'],
      });
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('cleans internal action details when includeDetails: false while retaining frame structure and counts', async () => {
      const mainSnap = {
        url: 'https://test.local',
        title: 'Title',
        w: 1000,
        h: 800,
        text: 'Main frame text',
        scroll: { y: 0, height: 1200 },
        actions: [
          { id: 'e1', kind: 'click', role: 'button', label: 'Main Save' },
          { id: 'wait', kind: 'wait', label: 'Wait' },
        ],
        marker: ['marker-data'],
        page_key: ['key-data'],
        guards: { 1: ['guard-1'] },
        omitted_actions: 0,
      };

      const subSnap = {
        url: 'https://test.local/sub',
        title: 'Sub',
        w: 500,
        h: 400,
        text: 'Subframe text',
        scroll: { y: 0, height: 400 },
        actions: [
          {
            id: 'e' + (INDEX_NAMESPACE_SIZE + 5),
            kind: 'click',
            role: 'button',
            label: 'Sub Submit',
          },
        ],
        marker: ['sub-marker'],
        page_key: ['sub-key'],
        guards: { [INDEX_NAMESPACE_SIZE + 5]: ['guard-sub'] },
        omitted_actions: 2,
      };

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 2,
        url: 'https://test.local',
        title: 'Title',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: mainSnap },
        { frameId: 2, result: subSnap },
      ] as any);

      const res = await readDOMTool.execute({ fast: true, includeDetails: false, tabId: 2 } as any);
      const payload = JSON.parse(res.content[0].text as string);

      expect(payload.actions).toBeUndefined();
      expect(payload.guards).toBeUndefined();
      expect(payload.marker).toBeUndefined();
      expect(payload.page_key).toBeUndefined();

      expect(payload.elementCount).toBe(2);
      expect(payload.omitted_actions).toBe(2);
      expect(payload.treeString).toContain('[1] button "Main Save"');
      expect(payload.treeString).toContain(
        `[${INDEX_NAMESPACE_SIZE + 5}] button "Sub Submit" frame="2"`,
      );
      expect(payload.text).toContain('Main frame text');
      expect(payload.text).toContain('Subframe text');
    });

    it('reflects subframe input changes in merged page_key and marker for Native action cache', async () => {
      const mainSnap = {
        url: 'https://test.local',
        title: 'Title',
        w: 1000,
        h: 800,
        text: 'Main',
        scroll: { y: 0, height: 1000 },
        actions: [{ id: 'e1', kind: 'click', role: 'button', label: 'Main' }],
        marker: [100, 'https://test.local', 0, 0, 1000, 800, 'Title', 'Main', [], []],
        page_key: [100, 'https://test.local', 0, 0, 1000, 800, []],
        guards: {},
        omitted_actions: 0,
      };

      const subSnapStateA = {
        ...mainSnap,
        actions: [
          { id: 'e16777217', kind: 'fill', role: 'textbox', label: 'Search', value: 'hello' },
        ],
        page_key: [
          100,
          'https://test.local/sub',
          0,
          0,
          500,
          400,
          [[1, 'hello', false, -1, false, false]],
        ],
      };
      const subSnapStateB = {
        ...mainSnap,
        actions: [
          { id: 'e16777217', kind: 'fill', role: 'textbox', label: 'Search', value: 'world' },
        ],
        page_key: [
          100,
          'https://test.local/sub',
          0,
          0,
          500,
          400,
          [[1, 'world', false, -1, false, false]],
        ],
      };

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });

      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValueOnce([
        { frameId: 0, result: mainSnap },
        { frameId: 1, result: subSnapStateA },
      ] as any);
      const resA = await readDOMTool.execute({ fast: true, includeDetails: true, tabId: 1 } as any);
      const payloadA = JSON.parse(resA.content[0].text as string);

      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValueOnce([
        { frameId: 0, result: mainSnap },
        { frameId: 1, result: subSnapStateB },
      ] as any);
      const resB = await readDOMTool.execute({ fast: true, includeDetails: true, tabId: 1 } as any);
      const payloadB = JSON.parse(resB.content[0].text as string);

      // When subframe input changes from "hello" to "world", page_key and marker MUST differ!
      expect(JSON.stringify(payloadA.page_key)).not.toBe(JSON.stringify(payloadB.page_key));
      expect(JSON.stringify(payloadA.marker)).not.toBe(JSON.stringify(payloadB.marker));
    });

    it('throws real error on allFrames execution failure without silent main fallback', async () => {
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockRejectedValue(
        new Error('Script injection failed on iframe sandbox'),
      );

      const res = await readDOMTool.execute({ fast: true, tabId: 1 } as any);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Script injection failed on iframe sandbox');
    });

    it('falls back cleanly to standard path when deltaOnly: true is passed', async () => {
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      const prunerSpy = vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            treeString: '[1] <button>Standard</button>',
            elementCount: 1,
            interactiveCount: 1,
            compressionRatio: 1,
            indexMap: { 1: { selector: 'button', tagName: 'button' } },
            indexedElements: [{ index: 1, tagName: 'button', isInteractive: true }],
          },
        },
      ] as any);

      const res = await readDOMTool.execute({ fast: true, deltaOnly: true, tabId: 1 } as any);
      expect(res.isError).toBe(false);
      // Must invoke inPageDOMPruner, not inPageFastSnapshot!
      expect(prunerSpy).toHaveBeenCalledWith(
        expect.anything(),
        'inPageDOMPruner',
        expect.anything(),
      );
    });

    it('fails standard mode loudly when allFrames execution fails', async () => {
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      const executeSpy = vi
        .spyOn(inPageEngine, 'executeInPage')
        .mockRejectedValue(new Error('all frame pruner failed'));

      const res = await readDOMTool.execute({ tabId: 1 } as any);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('all frame pruner failed');
      expect(executeSpy.mock.calls.filter((call) => !(call[0] as any).allFrames)).toHaveLength(0);
    });

    it('reports explicit standard coverage for complete and partially failed frames', async () => {
      vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue([
        { frameId: 0 },
        { frameId: 1 },
      ] as any);
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      const pruner = (frameId: number, result: any = {}) => ({
        frameId,
        result: {
          treeString: '',
          elementCount: 1,
          interactiveCount: 1,
          compressionRatio: 1,
          indexMap: {},
          indexedElements: [{ index: frameId + 1, tagName: 'button', isInteractive: true }],
          ...result,
        },
      });
      const executeSpy = vi
        .spyOn(inPageEngine, 'executeInPage')
        .mockResolvedValueOnce([pruner(0), pruner(1)] as any)
        .mockResolvedValueOnce([
          pruner(0),
          { frameId: 1, result: { isErrorPage: true, error: 'Child network error' } },
        ] as any);

      const complete = JSON.parse(
        (await readDOMTool.execute({ tabId: 1 } as any)).content[0].text as string,
      );
      const incomplete = JSON.parse(
        (await readDOMTool.execute({ tabId: 1, deltaOnly: true } as any)).content[0].text as string,
      );

      expect(complete.coverage).toEqual({
        expectedFrames: 2,
        reportedFrames: 2,
        successfulFrames: 2,
        attemptedFrames: 'all',
        status: 'complete',
      });
      expect(incomplete.coverage).toMatchObject({
        reportedFrames: 2,
        successfulFrames: 1,
        attemptedFrames: 'all',
        status: 'incomplete',
      });
      expect(incomplete.isDelta).toBe(false);
      expect(incomplete.removedIndices).toBeUndefined();
      expect(incomplete.deltaError).toContain('no removals inferred');
      expect(executeSpy.mock.calls.every((call) => (call[0] as any).allFrames)).toBe(true);
    });

    it('falls back cleanly to standard path with normalized compact format when non-zero cursor is passed', async () => {
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      const prunerSpy = vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            treeString: '[3] button "Btn 3"',
            elementCount: 1,
            interactiveCount: 1,
            compressionRatio: 1,
            indexMap: { 3: { selector: 'button', tagName: 'button' } },
            indexedElements: [{ index: 3, tagName: 'button', isInteractive: true }],
          },
        },
      ] as any);

      const res = await readDOMTool.execute({ fast: true, cursor: 2, limit: 2, tabId: 1 } as any);
      expect(res.isError).toBe(false);
      // Must route to inPageDOMPruner with format normalized to compact
      expect(prunerSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 1, allFrames: true }),
        'inPageDOMPruner',
        expect.arrayContaining([expect.objectContaining({ format: 'compact' })]),
      );
    });

    it('renders highlights across all frames when highlight: true is specified in fast mode', async () => {
      const snap = {
        url: 'https://test.local',
        title: 'Title',
        w: 1000,
        h: 800,
        text: 'Text',
        scroll: { y: 0, height: 800 },
        actions: [{ id: 'e1', kind: 'click', role: 'button', label: 'Btn' }],
        omitted_actions: 0,
      };

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      const inPageSpy = vi
        .spyOn(inPageEngine, 'executeInPage')
        .mockImplementation(async (target: any, fnName: string) => {
          if (fnName === 'inPageFastSnapshot') {
            return [{ frameId: 0, result: snap }] as any;
          }
          if (fnName === 'inPageRenderHighlights') {
            return [{ frameId: 0, result: true }] as any;
          }
          return [] as any;
        });

      const res = await readDOMTool.execute({ fast: true, highlight: true, tabId: 1 } as any);
      expect(res.isError).toBe(false);
      expect(inPageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 1, allFrames: true }),
        'inPageRenderHighlights',
        expect.anything(),
      );
    });

    it('enforces hard global limit of 250 across many frames without N*250 inflation', async () => {
      vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue(
        Array.from({ length: 5 }, (_, frameId) => ({ frameId })) as any,
      );
      // Simulate 5 frames each having 100 interactive actions (total 500 actions)
      const createSnap = (frameId: number, baseIdx: number) => ({
        url: `https://test.local/frame${frameId}`,
        title: `Frame ${frameId}`,
        w: 1000,
        h: 800,
        text: `Frame ${frameId} text`,
        scroll: { y: 0, height: 1000 },
        actions: Array.from({ length: 100 }, (_, i) => ({
          id: `e${baseIdx + i}`,
          kind: 'click',
          role: 'button',
          label: `F${frameId} Btn ${i + 1}`,
        })),
        omitted_actions: 0,
      });

      const mainSnap = createSnap(0, 1);
      const sub1 = createSnap(1, 16777217);
      const sub2 = createSnap(2, 33554433);
      const sub3 = createSnap(3, 50331649);
      const sub4 = createSnap(4, 67108865);

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: mainSnap },
        { frameId: 1, result: sub1 },
        { frameId: 2, result: sub2 },
        { frameId: 3, result: sub3 },
        { frameId: 4, result: sub4 },
      ] as any);

      // Default call without args.limit: MUST clamp to hard global budget 250 (NOT 500!)
      const resDefault = await readDOMTool.execute({ fast: true, tabId: 1 } as any);
      const payloadDefault = JSON.parse(resDefault.content[0].text as string);

      expect(payloadDefault.totalElements).toBe(500);
      expect(payloadDefault.elementCount).toBe(250);
      expect(payloadDefault.omitted_actions).toBe(250); // 500 - 250 = 250 omitted
      expect(payloadDefault.coverage).toEqual({
        expectedFrames: 5,
        attemptedFrames: 'all',
        reportedFrames: 5,
        successfulFrames: 5,
        status: 'complete',
      });

      // Passing limit: 500 is clamped by min(limit, 250)
      const resClamped = await readDOMTool.execute({ fast: true, limit: 500, tabId: 1 } as any);
      const payloadClamped = JSON.parse(resClamped.content[0].text as string);
      expect(payloadClamped.elementCount).toBe(250);
    });

    it('rotates 250 unique refs across five 100-node frames and keeps each frame non-empty', async () => {
      vi.mocked(chrome.webNavigation.getAllFrames).mockResolvedValue(
        Array.from({ length: 5 }, (_, frameId) => ({ frameId })) as any,
      );
      const createSnap = (frameId: number, baseIdx: number) => ({
        url: `https://test.local/frame${frameId}`,
        title: `Frame ${frameId}`,
        w: 1000,
        h: 800,
        text: `Frame ${frameId} text`,
        scroll: { y: 0, height: 800 },
        actions: Array.from({ length: 100 }, (_, i) => ({
          id: `e${baseIdx + i}`,
          node: i + 1,
          kind: 'click',
          role: 'button',
          label: `F${frameId} Btn ${i + 1}`,
        })),
        omitted_actions: 0,
      });

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: createSnap(0, 1) },
        { frameId: 1, result: createSnap(1, 16777217) },
        { frameId: 2, result: createSnap(2, 33554433) },
        { frameId: 3, result: createSnap(3, 50331649) },
        { frameId: 4, result: createSnap(4, 67108865) },
      ] as any);

      const res = await readDOMTool.execute({ fast: true, tabId: 1 } as any);
      const payload = JSON.parse(res.content[0].text as string);
      const frameCounts = [0, 1, 2, 3, 4].map(
        (frameId) =>
          (payload.treeString.match(new RegExp(`^\\[\\d+\\] button "F${frameId} Btn`, 'gm')) || [])
            .length,
      );

      expect(payload.elementCount).toBe(250);
      expect(payload.omitted_actions).toBe(250);
      expect(frameCounts).toEqual([50, 50, 50, 50, 50]);
      expect(frameCounts.every((count) => count > 0)).toBe(true);
    });

    it('applies an explicit element limit without splitting fill and click capabilities', async () => {
      let html = '';
      for (let i = 1; i <= 150; i++) {
        html += `<input id="field-${i}" type="text" value="v${i}" />\n`;
      }
      document.body.innerHTML = html;
      const snap = fastSnapshot({ limit: 150 })!;
      expect(snap.actions.filter((a) => /^e\d+$/.test(a.id))).toHaveLength(300);
      expect(new Set(snap.actions.map((a) => a.id).filter((id) => /^e\d+$/.test(id))).size).toBe(
        150,
      );
      expect(snap.omitted_elements).toBe(0);

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: snap },
      ] as any);
      const res = await readDOMTool.execute({
        fast: true,
        limit: 120,
        includeDetails: true,
        tabId: 1,
      } as any);
      const payload = JSON.parse(res.content[0].text as string);
      expect(payload.elementCount).toBe(120);
      expect(payload.actions.filter((a: any) => /^e\d+$/.test(a.id))).toHaveLength(240);
      expect(payload.omitted_elements).toBe(30);
      expect(payload.omitted_actions).toBe(60);
    });

    it('distinguishes omitted actions from omitted elements', async () => {
      const actions = Array.from({ length: 300 }, (_, i) => ({
        id: `e${i + 1}`,
        node: i + 1,
        kind: 'click',
        role: 'button',
        label: `Button ${i + 1}`,
      }));

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            url: 'https://test.local',
            title: 'Title',
            w: 1000,
            h: 800,
            text: '',
            scroll: { y: 0, height: 800 },
            actions,
            omitted_actions: 0,
          },
        },
      ] as any);

      const res = await readDOMTool.execute({
        fast: true,
        limit: 250,
        includeDetails: true,
        tabId: 1,
      } as any);
      const payload = JSON.parse(res.content[0].text as string);

      expect(payload.elementCount).toBe(250);
      expect(payload.omitted_actions).toBe(50);
      expect(payload.omitted_elements).toBe(50);
    });

    it('aggregates per-document omitted elements into the fast response totals', async () => {
      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            url: 'https://test.local',
            title: 'Main',
            w: 1000,
            h: 800,
            text: '',
            scroll: { y: 0, height: 800 },
            actions: [{ id: 'e1', kind: 'click', role: 'button', label: 'Main' }],
            omitted_actions: 10,
            omitted_elements: 5,
          },
        },
        {
          frameId: 1,
          result: {
            url: 'https://test.local/sub',
            title: 'Sub',
            w: 500,
            h: 400,
            text: '',
            scroll: { y: 0, height: 400 },
            actions: [{ id: 'e16777217', kind: 'click', role: 'button', label: 'Sub' }],
            omitted_actions: 20,
            omitted_elements: 6,
          },
        },
      ] as any);

      const res = await readDOMTool.execute({ fast: true, tabId: 1 } as any);
      const payload = JSON.parse(res.content[0].text as string);

      expect(payload.elementCount).toBe(2);
      expect(payload.totalElements).toBe(13);
      expect(payload.omitted_actions).toBe(30);
      expect(payload.omitted_elements).toBe(11);
    });

    it('reports coverage.incomplete with failedFrameCount when any frame fails or errors', async () => {
      const mainSnap = {
        url: 'https://test.local',
        title: 'Title',
        w: 1000,
        h: 800,
        text: 'Main',
        scroll: { y: 0, height: 1000 },
        actions: [{ id: 'e1', kind: 'click', role: 'button', label: 'Main' }],
        omitted_actions: 0,
      };

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: mainSnap },
        { frameId: 1, result: null }, // Null result indicating inaccessible frame
        { frameId: 2, result: { isErrorPage: true, error: 'Sandbox blocked' } as any },
      ] as any);

      const res = await readDOMTool.execute({ fast: true, tabId: 1 } as any);
      const payload = JSON.parse(res.content[0].text as string);

      expect(payload.coverage).toMatchObject({
        attemptedFrames: 'all',
        reportedFrames: 3,
        successfulFrames: 1,
        status: 'incomplete',
        failedFrameCount: 2,
      });
    });

    it('counts a select with multiple options once and preserves subframe guards', async () => {
      const mainSnap = {
        url: 'https://test.local',
        title: 'Title',
        w: 1000,
        h: 800,
        text: 'Main text',
        scroll: { y: 0, height: 800 },
        actions: [{ id: 'e1', node: 1, kind: 'click', role: 'button', label: 'Main' }],
        guards: { 1: ['guard-for-main'] },
        omitted_actions: 0,
      };

      const manyOptionActions = Array.from({ length: 300 }, (_, i) => ({
        id: 'e16777217',
        node: 1,
        kind: 'select',
        role: 'combobox',
        value: `opt_${i + 1}`,
        label: `Select -> Option ${i + 1}`,
      }));

      const subSnap = {
        url: 'https://test.local/sub',
        title: 'Sub',
        w: 1000,
        h: 800,
        text: 'Sub text',
        scroll: { y: 0, height: 800 },
        actions: manyOptionActions,
        guards: { 1: ['guard-for-node-1'] },
        omitted_actions: 0,
      };

      vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 1,
        url: 'https://test.local',
      });
      vi.spyOn(inPageEngine, 'executeInPage').mockResolvedValue([
        { frameId: 0, result: mainSnap },
        { frameId: 1, result: subSnap },
      ] as any);

      const res = await readDOMTool.execute({ fast: true, includeDetails: true, tabId: 1 } as any);
      const payload = JSON.parse(res.content[0].text as string);

      expect(payload.elementCount).toBe(2);
      expect(payload.actions.filter((a: any) => /^e\d+$/.test(a.id))).toHaveLength(51);
      expect(payload.omitted_actions).toBe(250);
      // Guards must be accessible via both numeric persistent index and eN string key
      expect(payload.guards[16777217]).toEqual(['guard-for-node-1']);
      expect(payload.guards['e16777217']).toEqual(['guard-for-node-1']);
    });
  });
});
