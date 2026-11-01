import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import { fastSnapshot } from '../entrypoints/background/tools/browser/fast-snapshot';
import {
  getIsolatedIndexMap,
  inPageDOMPruner,
} from '../entrypoints/background/tools/browser/dom-indexer';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { getClawFastCache } from '../entrypoints/background/tools/browser/fast-snapshot';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { snapshotCacheManager, snapshotObservationKey } from '../utils/snapshot-cache-manager';

let originalRect: typeof Element.prototype.getBoundingClientRect;
let originalGetComputedStyle: typeof window.getComputedStyle;

function elementById(payload: any, id: string) {
  return (payload.indexedElements || []).find((element: any) => element.attributes?.id === id);
}

function elementLines(payload: any): string[] {
  return String(payload.treeString || '')
    .split('\n')
    .filter((line) => /^\[\d+\]/.test(line));
}

async function installReadDomHarness() {
  chrome.webNavigation = {
    ...chrome.webNavigation,
    getAllFrames: vi.fn(async () => [{ frameId: 0, documentId: 'doc-0' }]),
  } as any;

  vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({ nodes: [] } as any);
  vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
    id: 1,
    url: 'https://table.test',
    title: 'Table test',
  });
  vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
    async (_target: any, functionName: string, functionArgs: any[]) => {
      if (functionName === 'inPageDOMPruner') {
        return [
          {
            frameId: 0,
            documentId: 'doc-0',
            result: inPageDOMPruner(functionArgs?.[0]),
          },
        ] as any;
      }
      if (functionName === 'inPageFastSnapshot') {
        return [
          {
            frameId: 0,
            documentId: 'doc-0',
            result: fastSnapshot({ ...functionArgs?.[0], legacyVisibility: true }),
          },
        ] as any;
      }
      return [] as any;
    },
  );
}

async function readStandard(args: Record<string, unknown> = {}) {
  const response = await readDOMTool.execute({
    format: 'compact',
    includeDetails: true,
    ...args,
  } as any);
  return JSON.parse(response.content[0].text as string);
}

async function readFast(args: Record<string, unknown> = {}) {
  const response = await readDOMTool.execute({
    fast: true,
    includeDetails: true,
    legacyVisibility: true,
    ...args,
  } as any);
  return JSON.parse(response.content[0].text as string);
}

describe('M3 table observation semantics', () => {
  beforeEach(() => {
    originalRect = Element.prototype.getBoundingClientRect;
    originalGetComputedStyle = window.getComputedStyle;
    Element.prototype.getBoundingClientRect = function () {
      const isTable = this.tagName === 'TABLE' || this.getAttribute('role') === 'grid';
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: isTable ? 600 : 120,
        bottom: isTable ? 600 : 30,
        width: isTable ? 600 : 120,
        height: isTable ? 600 : 30,
        toJSON: () => ({}),
      } as DOMRect;
    };
    window.getComputedStyle = ((element: Element, pseudo?: string | null) =>
      pseudo
        ? ({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
        : originalGetComputedStyle(element)) as any;
    (window as any).innerWidth = 1200;
    (window as any).innerHeight = 800;
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    snapshotCacheManager.clear();
    getClawFastCache().actionElements?.clear();
    getClawFastCache().nodes.clear();
    delete (globalThis as any)[Symbol.for('__browser_use_index_namespace__')];
    delete (globalThis as any)[Symbol.for('__browser_use_index_identity__')];
    delete (globalThis as any).__pawFast;
    delete (globalThis as any).__clawFast;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
    window.getComputedStyle = originalGetComputedStyle;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('exposes native table hierarchy, explicit headers, spans, and no fake cell click', async () => {
    document.body.innerHTML = `
      <table id="orders" aria-label="Orders">
        <thead>
          <tr id="orders-head">
            <th id="col-product" scope="col">Product</th>
            <th id="col-price" scope="col">Price</th>
          </tr>
        </thead>
        <tbody>
          <tr id="row-widget">
            <th id="row-widget-head" scope="row">Widget</th>
            <td id="cell-widget" headers="col-product row-widget-head" colspan="1">$10</td>
          </tr>
          <tr id="row-gadget">
            <th id="row-gadget-head" scope="row">Gadget</th>
            <td id="cell-gadget"><button id="edit-gadget">Edit</button></td>
          </tr>
        </tbody>
      </table>
      <table id="span-table">
        <thead><tr><th id="group-header" scope="colgroup" colspan="2">Group</th></tr></thead>
        <tbody>
          <tr><th id="span-row-head" scope="row" rowspan="2">Alpha</th>
            <td id="span-explicit" headers="group-header span-row-head" aria-colindex="2">A</td>
          </tr>
          <tr><td id="span-unknown">B</td>
            <td id="span-dangling" headers="missing-header">D</td></tr>
        </tbody>
      </table>
    `;
    await installReadDomHarness();

    const standard = await readStandard();
    const fast = await readFast();
    const selectedStandard = await readStandard({ selector: 'table' });
    const selectedFast = await readFast({ selector: 'table' });

    for (const payload of [standard, fast]) {
      expect(elementById(payload, 'orders')?.role).toBe('table');
      expect(elementById(payload, 'col-product')?.role).toBe('columnheader');
      expect(elementById(payload, 'row-widget-head')?.role).toBe('rowheader');
      expect(elementById(payload, 'cell-widget')?.role).toBe('cell');
      expect(elementById(payload, 'orders')?.text || '').toBe('Orders');
      expect(elementById(payload, 'row-widget')?.text || '').toBe('');
      expect(elementById(payload, 'row-widget')?.attributes.parentTable).toBe(
        String(elementById(payload, 'orders')?.index),
      );
      expect(elementById(payload, 'cell-widget')?.attributes).toMatchObject({
        row: '2',
        rowSource: 'dom-local',
        column: '2',
        columnSource: 'dom-local',
        headers: 'col-product row-widget-head',
        headerRelation: 'explicit',
        rowHeader: 'Widget',
        columnHeader: 'Product',
      });
      expect(elementById(payload, 'cell-widget')?.attributes.headerText).toContain('Product');
      expect(elementById(payload, 'cell-widget')?.attributes.headerText).toContain('Widget');
      expect(elementById(payload, 'cell-gadget')?.isInteractive).toBe(false);
      expect(elementById(payload, 'cell-gadget')?.attributes).toMatchObject({
        rowHeader: 'Gadget',
        columnHeader: 'Price',
        headerRelation: 'derived',
      });
      expect(elementById(payload, 'edit-gadget')?.isInteractive).toBe(true);
      expect(elementById(payload, 'group-header')?.attributes.colspan).toBe('2');
      expect(elementById(payload, 'span-row-head')?.attributes.rowspan).toBe('2');
      expect(elementById(payload, 'span-explicit')?.attributes).toMatchObject({
        row: '2',
        column: '2',
        columnSource: 'aria',
        headerRelation: 'explicit',
      });
      expect(elementById(payload, 'span-unknown')?.attributes.column).toBe('unknown');
      expect(elementById(payload, 'span-unknown')?.attributes.headerRelation).toBe('unknown');
      expect(elementById(payload, 'span-unknown')?.attributes.columnHeader).toBeUndefined();
      expect(elementById(payload, 'span-dangling')?.attributes).toMatchObject({
        headers: 'missing-header',
        headerRelation: 'unknown',
      });
      expect(elementById(payload, 'span-dangling')?.attributes.headerText).toBeUndefined();
      expect(elementById(payload, 'span-dangling')?.attributes.headerRefs).toBeUndefined();
      expect(payload.treeString).toContain('table "Orders"');
      expect(payload.treeString).toContain('columnheader "Product"');
      expect(payload.treeString).toContain('rowheader "Widget"');
      expect(payload.treeString).toContain('headers="col-product row-widget-head"');
    }
    for (const payload of [selectedStandard, selectedFast]) {
      expect(payload.selectorMatched).toBe(true);
      expect(elementById(payload, 'orders')?.role).toBe('table');
      expect(elementById(payload, 'span-table')?.role).toBe('table');
    }

    for (const id of [
      'orders',
      'orders-head',
      'col-product',
      'row-widget',
      'row-widget-head',
      'cell-widget',
      'cell-gadget',
      'edit-gadget',
      'span-table',
      'span-explicit',
      'span-unknown',
    ]) {
      expect(elementById(fast, id)?.index, id).toBe(elementById(standard, id)?.index);
    }

    const fastActions = (fast.actions || []).filter((action: any) => /^e\d+$/.test(action.id));
    expect(fastActions.some((action: any) => action.label === 'Edit')).toBe(true);
    expect(
      fastActions.some((action: any) => action.id === `e${elementById(fast, 'orders')?.index}`),
    ).toBe(false);
    expect(
      fastActions.some(
        (action: any) => action.id === `e${elementById(fast, 'cell-gadget')?.index}`,
      ),
    ).toBe(false);
    expect(
      fastActions.some((action: any) => action.id === `e${elementById(fast, 'row-gadget')?.index}`),
    ).toBe(false);
    expect(fast.text).not.toContain('Product');
    expect(fast.text).not.toContain('$10');
  });

  it('uses explicit ARIA grid positions and marks incomplete ARIA positions unknown', async () => {
    document.body.innerHTML = `
      <div id="people-grid" role="grid" aria-label="People" aria-rowcount="-1" aria-colcount="2">
        <div role="row" aria-rowindex="1">
          <div id="aria-name-col" role="columnheader" aria-colindex="1">Name</div>
          <div id="aria-status-col" role="columnheader" aria-colindex="2">Status</div>
        </div>
        <div role="row" aria-rowindex="2">
          <div id="aria-alice" role="rowheader" aria-colindex="1">Alice</div>
          <div id="aria-ok" role="gridcell" aria-colindex="2">OK</div>
        </div>
        <div role="row" aria-rowindex="3">
          <div id="aria-bob" role="rowheader" aria-colindex="1">Bob</div>
          <div id="aria-unknown" role="gridcell" tabindex="0">Unknown</div>
        </div>
      </div>
    `;
    await installReadDomHarness();

    const standard = await readStandard({ selector: '#people-grid' });
    const fast = await readFast({ selector: '#people-grid' });

    for (const payload of [standard, fast]) {
      expect(elementById(payload, 'people-grid')?.role).toBe('grid');
      expect(elementById(payload, 'people-grid')?.attributes).toMatchObject({
        'aria-rowcount': '-1',
        'aria-colcount': '2',
        tableSemantics: 'aria-partial',
      });
      expect(elementById(payload, 'people-grid')?.attributes.tableNotice).toContain('unknown');
      expect(elementById(payload, 'aria-ok')?.attributes).toMatchObject({
        row: '2',
        rowSource: 'aria',
        column: '2',
        columnSource: 'aria',
      });
      expect(elementById(payload, 'aria-unknown')?.attributes).toMatchObject({
        row: '3',
        rowSource: 'aria',
        column: 'unknown',
      });
      expect(elementById(payload, 'aria-unknown')?.isInteractive).toBe(false);
    }

    const fastActions = (fast.actions || []).filter((action: any) => /^e\d+$/.test(action.id));
    expect(
      fastActions.some((action: any) => action.id === `e${elementById(fast, 'aria-ok')?.index}`),
    ).toBe(false);
    expect(
      fastActions.some(
        (action: any) => action.id === `e${elementById(fast, 'aria-unknown')?.index}`,
      ),
    ).toBe(false);
  });

  it('honors selector, exclude, and visibility in both observation paths', async () => {
    document.body.innerHTML = `
      <table id="outside-table"><tr><td id="outside-cell">Outside</td></tr></table>
      <section id="scope">
        <table id="included-table"><tr><td id="included-cell">Included</td></tr></table>
        <table id="excluded-table" class="drop"><tr><td id="excluded-cell">Excluded</td></tr></table>
        <table id="hidden-table" style="display:none"><tr><td id="hidden-cell">Hidden</td></tr></table>
      </section>
    `;
    await installReadDomHarness();

    const standard = await readStandard({ selector: '#scope', exclude: '.drop' });
    const fast = await readFast({ selector: '#scope', exclude: '.drop' });

    for (const payload of [standard, fast]) {
      expect(elementById(payload, 'included-table')).toBeTruthy();
      expect(elementById(payload, 'included-cell')).toBeTruthy();
      for (const absent of [
        'outside-table',
        'outside-cell',
        'excluded-table',
        'excluded-cell',
        'hidden-table',
        'hidden-cell',
      ]) {
        expect(elementById(payload, absent), absent).toBeUndefined();
      }
      expect(payload.treeString).not.toContain('Outside');
      expect(payload.treeString).not.toContain('Excluded');
      expect(payload.treeString).not.toContain('Hidden');
      expect(payload.selectorMatched).toBe(true);
    }
  });

  it('shares the unique-element budget with table structure and paginates without loss', async () => {
    const rows = Array.from({ length: 100 }, (_, row) => {
      const cells = [0, 1]
        .map((column) => `<td id="wide-${row}-${column}">R${row}C${column}</td>`)
        .join('');
      return `<tr id="wide-row-${row}">${cells}</tr>`;
    }).join('');
    document.body.innerHTML = `<table id="wide-table">${rows}</table>`;
    await installReadDomHarness();

    const page1 = await readStandard();
    const page2 = await readStandard({ cursor: page1.nextCursor });
    const fast = await readFast();
    const pageIndices = [
      ...page1.indexedElements.map((element: any) => element.index),
      ...page2.indexedElements.map((element: any) => element.index),
    ];

    expect(page1.totalElements).toBe(301);
    expect(page1.indexedElements).toHaveLength(250);
    expect(page1.nextCursor).toBe(250);
    expect(page2.indexedElements).toHaveLength(51);
    expect(page2.hasMore).toBe(false);
    expect(new Set(pageIndices).size).toBe(301);

    expect(fast.totalElements).toBe(301);
    expect(fast.elementCount).toBe(250);
    expect(fast.omitted_elements).toBe(51);
    expect(fast.indexedElements).toHaveLength(250);
    expect(elementLines(fast)).toHaveLength(250);
    expect(new Set(fast.indexedElements.map((element: any) => element.index)).size).toBe(250);
  });

  it('scans each table once per capture for span and row metadata', async () => {
    const rows = Array.from({ length: 250 }, (_, row) => {
      const cells = [0, 1]
        .map((column) => `<td id="perf-${row}-${column}">R${row}C${column}</td>`)
        .join('');
      return `<tr id="perf-row-${row}">${cells}</tr>`;
    }).join('');
    document.body.innerHTML = `<table id="perf-table">${rows}</table>`;
    await installReadDomHarness();

    const table = document.getElementById('perf-table') as HTMLTableElement;
    expect(table.rows).toHaveLength(250);
    expect(table.rows[0].cells).toHaveLength(2);

    const originalQuerySelectorAll = Element.prototype.querySelectorAll;
    const rowsDescriptor = Object.getOwnPropertyDescriptor(HTMLTableElement.prototype, 'rows')!;
    let spanQueries = 0;
    let rowScans = 0;
    Element.prototype.querySelectorAll = function (selector: string) {
      if (this === table && String(selector).includes('[rowspan]')) spanQueries++;
      return originalQuerySelectorAll.call(this, selector as any);
    } as typeof Element.prototype.querySelectorAll;
    Object.defineProperty(HTMLTableElement.prototype, 'rows', {
      ...rowsDescriptor,
      get() {
        if (this === table) rowScans++;
        return rowsDescriptor.get!.call(this);
      },
    });

    try {
      const standard = await readStandard();
      expect(standard.totalElements).toBe(751);
      expect(spanQueries).toBeLessThanOrEqual(1);
      expect(rowScans).toBeLessThanOrEqual(1);

      spanQueries = 0;
      rowScans = 0;
      const fast = await readFast();
      expect(fast.totalElements).toBe(751);
      expect(spanQueries).toBeLessThanOrEqual(1);
      expect(rowScans).toBeLessThanOrEqual(1);
    } finally {
      Element.prototype.querySelectorAll = originalQuerySelectorAll;
      Object.defineProperty(HTMLTableElement.prototype, 'rows', rowsDescriptor);
    }
  });

  it('rejects cross-table headers and suppresses implicit roles under presentation tables', async () => {
    document.body.innerHTML = `
      <table id="foreign-table">
        <tr><th id="foreign-header" scope="col">Foreign</th></tr>
      </table>
      <table id="local-table">
        <thead><tr>
          <th id="local-header" scope="col">Local</th>
          <th id="ambiguous-header">Unknown direction</th>
        </tr></thead>
        <tbody><tr>
          <td id="local-cell">Y</td>
          <td id="cross-table-cell" headers="foreign-header">X</td>
          <td id="ambiguous-cell" headers="ambiguous-header">Z</td>
        </tr></tbody>
      </table>
      <table id="presentation-table" role="presentation">
        <tr id="presentation-row"><td id="presentation-cell">
          <span id="presentation-text">Presentation text</span>
          <button id="presentation-button">Act</button>
        </td></tr>
      </table>
    `;
    await installReadDomHarness();

    const standard = await readStandard();
    const fast = await readFast();

    for (const payload of [standard, fast]) {
      expect(elementById(payload, 'local-cell')?.attributes.columnHeader).toBe('Local');
      expect(elementById(payload, 'cross-table-cell')?.attributes.headerRelation).toBe('unknown');
      expect(elementById(payload, 'cross-table-cell')?.attributes.headerText).toBeUndefined();
      expect(elementById(payload, 'cross-table-cell')?.attributes.headerRefs).toBeUndefined();
      expect(elementById(payload, 'ambiguous-header')?.role).toBe('header');
      expect(elementById(payload, 'ambiguous-header')?.attributes).toMatchObject({
        headerDirection: 'unknown',
        headerScopeSource: 'implicit-html',
      });
      expect(elementById(payload, 'ambiguous-cell')?.attributes).toMatchObject({
        headerRelation: 'explicit',
        headerText: 'Unknown direction',
      });
      expect(elementById(payload, 'ambiguous-cell')?.attributes.columnHeader).toBeUndefined();
      expect(elementById(payload, 'presentation-table')).toBeUndefined();
      expect(elementById(payload, 'presentation-row')).toBeUndefined();
      expect(elementById(payload, 'presentation-cell')).toBeUndefined();
      expect(elementById(payload, 'presentation-button')?.isInteractive).toBe(true);
      expect(elementById(payload, 'presentation-text')?.attributes.parentTable).toBeUndefined();
    }
    expect(fast.text).toContain('Presentation text');
  });

  it('does not reuse table metadata across captures', async () => {
    document.body.innerHTML = `
      <table id="changing-table">
        <thead><tr><th id="changing-header" scope="col">Before</th></tr></thead>
        <tbody><tr><td id="changing-cell">Value</td></tr></tbody>
      </table>
    `;
    await installReadDomHarness();

    const firstStandard = await readStandard();
    const firstFast = await readFast();
    expect(elementById(firstStandard, 'changing-cell')?.attributes.columnHeader).toBe('Before');
    expect(elementById(firstFast, 'changing-cell')?.attributes.columnHeader).toBe('Before');

    document.getElementById('changing-header')!.textContent = 'After';
    const secondStandard = await readStandard();
    const secondFast = await readFast();
    expect(elementById(secondStandard, 'changing-cell')?.attributes.columnHeader).toBe('After');
    expect(elementById(secondFast, 'changing-cell')?.attributes.columnHeader).toBe('After');

    document.getElementById('changing-cell')!.setAttribute('colspan', '2');
    const spannedStandard = await readStandard();
    const spannedFast = await readFast();
    for (const payload of [spannedStandard, spannedFast]) {
      expect(elementById(payload, 'changing-cell')?.attributes.column).toBe('unknown');
      expect(elementById(payload, 'changing-cell')?.attributes.headerRelation).toBe('unknown');
    }
  });

  it('only promotes table structures when event-listener evidence is non-empty', async () => {
    document.body.innerHTML = `
      <div id="event-grid" role="grid">
        <div role="row">
          <div id="empty-listener" role="gridcell">Empty</div>
          <div id="active-listener" role="gridcell">Active</div>
          <div id="static-cell" role="gridcell">Static</div>
        </div>
      </div>
      <table id="native-event-table">
        <tr>
          <td id="native-direct" onclick="void 0">Direct</td>
          <td id="native-static">Static</td>
        </tr>
      </table>
    `;
    await installReadDomHarness();
    (globalThis as any).getEventListeners = (element: Element) => {
      if (element.id === 'empty-listener') return { click: [] };
      if (element.id === 'active-listener') return { click: [() => {}] };
      return {};
    };

    try {
      const standard = await readStandard();
      const fast = await readFast();
      for (const payload of [standard, fast]) {
        expect(elementById(payload, 'empty-listener')?.isInteractive).toBe(false);
        expect(elementById(payload, 'active-listener')?.isInteractive).toBe(true);
        expect(elementById(payload, 'static-cell')?.isInteractive).toBe(false);
        expect(elementById(payload, 'native-direct')?.isInteractive).toBe(true);
        expect(elementById(payload, 'native-static')?.isInteractive).toBe(false);
      }
      const fastActions = (fast.actions || []).filter((action: any) => /^e\d+$/.test(action.id));
      const emptyId = `e${elementById(fast, 'empty-listener')?.index}`;
      const activeId = `e${elementById(fast, 'active-listener')?.index}`;
      const nativeDirectId = `e${elementById(fast, 'native-direct')?.index}`;
      expect(fastActions.some((action: any) => action.id === emptyId)).toBe(false);
      expect(fastActions.some((action: any) => action.id === activeId)).toBe(true);
      expect(fastActions.some((action: any) => action.id === nativeDirectId)).toBe(true);
    } finally {
      delete (globalThis as any).getEventListeners;
    }
  });

  it('isolates delta baselines by observation scope without truncating pagination baselines', async () => {
    document.body.innerHTML = `
      <section id="region-a">
        <button id="a-one">A one</button>
        <button id="a-two">A two</button>
      </section>
      <section id="region-b"><button id="b-one">B one</button></section>
    `;
    await installReadDomHarness();

    const firstA = await readStandard({ deltaOnly: true, selector: '#region-a' });
    expect(firstA).toMatchObject({ isDelta: false });
    expect(firstA.coverage.status).toBe('complete');
    expect(snapshotCacheManager.getSnapshot(1)?.elementCount).toBe(2);

    const sameA = await readStandard({ deltaOnly: true, selector: '#region-a' });
    expect(sameA).toMatchObject({ success: true, unchanged: true });
    const pagedA = await readStandard({
      deltaOnly: true,
      selector: '#region-a',
      limit: 1,
      cursor: 99,
    });
    expect(pagedA).toMatchObject({ success: true, unchanged: true });
    expect(snapshotCacheManager.getSnapshot(1)?.elementCount).toBe(2);

    const firstB = await readStandard({ deltaOnly: true, selector: '#region-b' });
    expect(firstB).toMatchObject({ isDelta: false });
    expect(firstB.removed).toBeUndefined();
    expect(elementById(firstB, 'b-one')).toBeTruthy();
    expect(elementById(firstB, 'a-one')).toBeUndefined();

    const excludedB = await readStandard({
      deltaOnly: true,
      selector: '#region-b',
      exclude: '.not-present',
    });
    expect(excludedB).toMatchObject({ isDelta: false });
    expect(excludedB.removed).toBeUndefined();

    const viewportB = await readStandard({
      deltaOnly: true,
      selector: '#region-b',
      exclude: '.not-present',
      viewportThreshold: 900,
    });
    expect(viewportB).toMatchObject({ isDelta: false });
    expect(viewportB.removed).toBeUndefined();
  });

  it('records an independent fast observation key for each selector scope', async () => {
    document.body.innerHTML = `
      <section id="fast-a"><button id="fast-a-button">A</button></section>
      <section id="fast-b"><button id="fast-b-button">B</button></section>
    `;
    await installReadDomHarness();

    await readFast({ selector: '#fast-a' });
    const keyA = snapshotCacheManager.getSnapshot(1)?.observationKey;
    await readFast({ selector: '#fast-b' });
    const keyB = snapshotCacheManager.getSnapshot(1)?.observationKey;

    expect(keyA).toBe(snapshotObservationKey({ selector: '#fast-a' }));
    expect(keyB).toBe(snapshotObservationKey({ selector: '#fast-b' }));
    expect(keyA).not.toBe(keyB);
  });

  it('keeps native validation and toggle state visible in fast observations', async () => {
    document.body.innerHTML = `<input id="native-email" type="email" required>
      <input id="native-checkbox" type="checkbox" aria-label="Opt in" checked>`;
    await installReadDomHarness();
    const fast = await readFast();
    expect(elementById(fast, 'native-email')?.attributes).toMatchObject({
      invalid: 'true',
      required: 'true',
      invalidReason: 'valueMissing',
    });
    expect(elementById(fast, 'native-email')?.attributes.validationMessage).toBeTruthy();
    expect(fast.treeString).toContain('invalidReason="valueMissing"');
    expect(fast.treeString).toContain('required');
    expect(fast.treeString).toContain('validationMessage=');
    expect(fast.treeString).toMatch(/checkbox "Opt in"[^\n]* checked/);
    expect(elementById(fast, 'native-checkbox')?.attributes.checked).toBe('true');
    (document.getElementById('native-checkbox') as HTMLInputElement).checked = false;
    expect(elementById(await readFast(), 'native-checkbox')?.attributes.checked).toBe('false');
  });

  it('observes a native select even when it has only its currently selected option', async () => {
    document.body.innerHTML = `<label for="single-choice">Single choice</label>
      <select id="single-choice"><option value="a" selected>Alpha</option></select>`;
    await installReadDomHarness();
    const fast = await readFast();
    const select = elementById(fast, 'single-choice');
    expect(select).toBeDefined();
    expect(select?.value).toBe('Alpha');
    expect(fast.treeString).toContain('value="Alpha"');
    expect(
      fast.actions.filter(
        (action: any) => action.domId === 'single-choice' && action.kind === 'click',
      ),
    ).toHaveLength(1);
  });

  it('reports native table row order changes without text or value changes', async () => {
    document.body.innerHTML = `<table><tbody>
      <tr id="row-a"><td>Alpha</td></tr><tr id="row-b"><td>Beta</td></tr>
      </tbody></table>`;
    await installReadDomHarness();
    const first = await readStandard();
    const row = elementById(first, 'row-a');
    document.querySelector('tbody')!.append(document.getElementById('row-a')!);
    const delta = await readStandard({ deltaOnly: true });
    expect(delta.unchanged).not.toBe(true);
    expect(
      delta.modified.some(
        (element: any) => element.index === row.index && element.attributes.row === '2',
      ),
    ).toBe(true);
  });

  it('includes changed aria-sort state in ordinary observations and deltas', async () => {
    document.body.innerHTML = `<table><tr><th id="sortable" scope="col" aria-sort="ascending">Name</th></tr>
      <tr><td>Alpha</td></tr></table>`;
    await installReadDomHarness();
    const first = await readStandard();
    const header = elementById(first, 'sortable');
    expect(first.treeString).toContain('sort="ascending"');
    document.getElementById('sortable')!.setAttribute('aria-sort', 'descending');
    const delta = await readStandard({ deltaOnly: true });
    expect(delta.unchanged).not.toBe(true);
    expect(
      delta.modified.some(
        (element: any) =>
          element.index === header.index && element.attributes['aria-sort'] === 'descending',
      ),
    ).toBe(true);
  });

  it('applies ARIA invalid grammar and linked error metadata to custom editable fields', async () => {
    document.body.innerHTML = `
      <section id="form">
        <div id="spell-field" role="textbox" aria-label="Spelling field" contenteditable="true"
          aria-invalid="spelling" aria-errormessage="spell-error"
          aria-describedby="spell-help">helo</div>
        <div id="custom-combo" role="combobox" aria-label="Role picker" contenteditable="true"
          aria-invalid="custom-token" aria-errormessage="combo-error">choose</div>
        <div id="false-field" role="textbox" contenteditable="true"
          aria-invalid="false" aria-errormessage="hidden-error">ok</div>
        <div id="empty-field" role="textbox" contenteditable="true"
          aria-invalid="" aria-errormessage="hidden-error">ok</div>
      </section>
      <p id="spell-error">Spelling error</p>
      <p id="spell-help">Use a dictionary word</p>
      <p id="combo-error">Choose a valid role</p>
      <p id="hidden-error">Must not appear</p>
    `;
    await installReadDomHarness();
    (document.getElementById('spell-field') as HTMLElement).focus();

    const standard = await readStandard({ selector: '#form' });
    const fast = await readFast({ selector: '#form' });

    expect(elementById(standard, 'spell-field')?.attributes).toMatchObject({
      invalid: 'true',
      invalidReason: 'aria-invalid',
      'aria-invalid': 'spelling',
      label: 'Spelling field',
      focused: 'true',
      errormessage: 'Spelling error',
      description: 'Use a dictionary word',
    });
    expect(elementById(standard, 'custom-combo')?.attributes).toMatchObject({
      invalid: 'true',
      'aria-invalid': 'custom-token',
      errormessage: 'Choose a valid role',
    });
    expect(elementById(standard, 'false-field')?.attributes.invalid).toBeUndefined();
    expect(elementById(standard, 'false-field')?.attributes.errormessage).toBeUndefined();
    expect(elementById(standard, 'false-field')?.attributes['aria-errormessage']).toBeUndefined();
    expect(elementById(standard, 'empty-field')?.attributes.invalid).toBeUndefined();
    expect(elementById(standard, 'empty-field')?.attributes.errormessage).toBeUndefined();

    const fastActions = (fast.actions || []).filter((action: any) => /^e\d+$/.test(action.id));
    const spellAction = fastActions.find(
      (action: any) => action.id === `e${elementById(fast, 'spell-field')?.index}`,
    );
    const falseAction = fastActions.find(
      (action: any) => action.id === `e${elementById(fast, 'false-field')?.index}`,
    );
    const comboAction = fastActions.find(
      (action: any) => action.id === `e${elementById(fast, 'custom-combo')?.index}`,
    );
    expect(spellAction).toMatchObject({
      label: 'Spelling field',
      focused: true,
      invalid: true,
      invalidReason: 'aria-invalid',
      ariaInvalid: 'spelling',
      errormessage: 'Spelling error',
      description: 'Use a dictionary word',
    });
    expect(comboAction).toMatchObject({
      invalid: true,
      ariaInvalid: 'custom-token',
      errormessage: 'Choose a valid role',
    });
    expect(falseAction?.errormessage).toBeUndefined();
    expect(fast.treeString).toContain('invalid');
    expect(fast.treeString).toContain('errormessage="Spelling error"');
    expect(fast.treeString).toContain('description="Use a dictionary word"');
    expect(fast.treeString).not.toContain('Must not appear');
  });
});
