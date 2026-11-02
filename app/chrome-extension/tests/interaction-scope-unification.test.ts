import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  inPageDOMPruner,
  inPageGetActiveElementSummary,
  inPageFindSmartScrollTarget,
  detectActiveModalBlocker,
  computeInteractionScope,
  indexElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import {
  fastSnapshot,
  inPageCheckOcclusion,
} from '../entrypoints/background/tools/browser/fast-snapshot';

describe('Interaction Scope Unification (Modal, Fast Snapshot, Scroll)', () => {
  let prevRect: typeof Element.prototype.getBoundingClientRect;
  let prevRangeRect: typeof Range.prototype.getBoundingClientRect | undefined;

  const sizeElement = (id: string, width = 160, height = 32) => {
    const el = document.getElementById(id)!;
    el.getBoundingClientRect = () =>
      ({
        x: 20,
        y: 20,
        left: 20,
        top: 20,
        right: 20 + width,
        bottom: 20 + height,
        width,
        height,
      }) as DOMRect;
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    prevRect = Element.prototype.getBoundingClientRect;
    prevRangeRect = (Range.prototype as any).getBoundingClientRect;
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = prevRect;
    if (prevRangeRect) {
      (Range.prototype as any).getBoundingClientRect = prevRangeRect;
    } else {
      delete (Range.prototype as any).getBoundingClientRect;
    }
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('1. inPageGetActiveElementSummary and inPageDOMPruner have consistent activeModal/focus/modalIsolated semantics', () => {
    document.body.innerHTML = `
      <div id="main-content">
        <button id="bg-open">Open</button>
      </div>
      <dialog open id="settings-dialog" aria-modal="true" aria-label="Settings Dialog" style="position: fixed; top: 50px; left: 50px; width: 400px; height: 300px; z-index: 1000;">
        <h2>Settings</h2>
        <button id="modal-save">Save Settings</button>
      </dialog>
    `;

    const dlg = document.getElementById('settings-dialog') as HTMLElement;
    Object.defineProperty(dlg, 'offsetWidth', { configurable: true, value: 400 });
    Object.defineProperty(dlg, 'offsetHeight', { configurable: true, value: 300 });
    dlg.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 450,
        bottom: 350,
        width: 400,
        height: 300,
      }) as DOMRect;

    const saveBtn = document.getElementById('modal-save')!;
    saveBtn.focus();

    const prunerRes = inPageDOMPruner();
    const summaryRes = inPageGetActiveElementSummary();

    expect(prunerRes.activeModal).toBeTruthy();
    expect(summaryRes.hasActiveModal).toBe(true);
    expect(summaryRes.activeModal).toBe(prunerRes.activeModal);
    expect(summaryRes.focusTrapped).toBe(prunerRes.focusTrapped);
    expect(summaryRes.modalIsolated).toBe(prunerRes.modalIsolated);
  });

  it('2. non-modal in-flow dialog role does not isolate background interaction scope', () => {
    document.body.innerHTML = `
      <button id="page-action">Page Action</button>
      <div role="dialog" aria-modal="false" id="in-flow-card" style="position: static; width: 200px; height: 100px;">
        <p>Inline widget</p>
        <button id="widget-btn">Widget Action</button>
      </div>
    `;
    const card = document.getElementById('in-flow-card')!;
    card.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 50,
        left: 10,
        top: 50,
        right: 210,
        bottom: 150,
        width: 200,
        height: 100,
      }) as DOMRect;
    sizeElement('page-action');
    sizeElement('widget-btn');

    const blocker = detectActiveModalBlocker();
    expect(blocker).toBeNull();

    const prunerRes = inPageDOMPruner();
    expect(prunerRes.modalIsolated).not.toBe(true);
    expect(prunerRes.focusTrapped).not.toBe(true);
    expect(prunerRes.treeString).toContain('Page Action');
    expect(prunerRes.treeString).toContain('Widget Action');
  });

  it('3. fastSnapshot without explicit scope excludes background elements when modal is active', () => {
    document.body.innerHTML = `
      <div id="bg-section">
        <button id="bg-btn">Background Target</button>
      </div>
      <div role="dialog" aria-modal="true" id="active-modal" style="position: fixed; top: 100px; left: 100px; width: 600px; height: 400px; z-index: 5000;">
        <h2>Active Modal</h2>
        <button id="modal-confirm">Confirm Modal</button>
      </div>
    `;
    const modal = document.getElementById('active-modal')!;
    modal.getBoundingClientRect = () =>
      ({
        x: 100,
        y: 100,
        left: 100,
        top: 100,
        right: 700,
        bottom: 500,
        width: 600,
        height: 400,
      }) as DOMRect;
    sizeElement('modal-confirm');

    const snapshot = fastSnapshot();
    expect(snapshot).not.toBeNull();
    const actionLabels = snapshot!.actions.map((a) => a.label);
    expect(actionLabels.some((l) => l.includes('Confirm Modal'))).toBe(true);
    expect(actionLabels.some((l) => l.includes('Background Target'))).toBe(false);
  });

  it('4. Portal dropdowns are retained if stacked at/above modal, but excluded if stacked behind modal', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" id="modal-box" style="position: fixed; top: 50px; left: 50px; width: 500px; height: 400px; z-index: 2000;">
        <button id="open-select" aria-controls="above-dropdown" aria-expanded="true">Open Select</button>
      </div>
      <!-- Behind modal portal (stale or lower layer) -->
      <div class="ant-select-dropdown" id="behind-dropdown" style="position: fixed; top: 60px; left: 60px; width: 150px; height: 100px; z-index: 10;">
        <button id="behind-opt">Behind Option</button>
      </div>
      <!-- Active portal stacked above modal -->
      <div class="ant-select-dropdown" id="above-dropdown" style="position: fixed; top: 100px; left: 100px; width: 150px; height: 100px; z-index: 3000;">
        <button id="above-opt">Above Option</button>
      </div>
    `;

    const modal = document.getElementById('modal-box')!;
    modal.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 550,
        bottom: 450,
        width: 500,
        height: 400,
      }) as DOMRect;
    sizeElement('open-select');
    sizeElement('behind-opt');
    sizeElement('above-opt');
    sizeElement('behind-dropdown', 150, 100);
    sizeElement('above-dropdown', 150, 100);

    const pruner = inPageDOMPruner();
    expect(pruner.modalIsolated).toBe(true);
    expect(pruner.treeString).toContain('Above Option');
    expect(pruner.treeString).not.toContain('Behind Option');
  });

  it('11. class-only detached dropdowns do not enter the active modal scope', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" id="scoped-modal" style="position: fixed; top: 50px; left: 50px; width: 500px; height: 400px; z-index: 2000;">
        <button id="scoped-modal-button" aria-expanded="false">Open Select</button>
      </div>
      <div class="ant-select-dropdown" id="unowned-dropdown" style="position: fixed; top: 100px; left: 100px; width: 150px; height: 100px; z-index: 3000;">
        <button id="unowned-option">Unrelated Option</button>
      </div>
    `;

    const modal = document.getElementById('scoped-modal')!;
    modal.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 550,
        bottom: 450,
        width: 500,
        height: 400,
      }) as DOMRect;
    sizeElement('scoped-modal-button');
    sizeElement('unowned-option');
    sizeElement('unowned-dropdown', 150, 100);

    const pruner = inPageDOMPruner();
    expect(pruner.modalIsolated).toBe(true);
    expect(pruner.treeString).not.toContain('Unrelated Option');
  });

  it('12. keeps sibling controls inside the same generic overlay host when the blocker is only its backdrop', () => {
    document.body.innerHTML = '<x-modal-host id="overlay-host"></x-modal-host>';
    const host = document.getElementById('overlay-host')!;
    host.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
      }) as DOMRect;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <div id="overlay-backdrop" class="modal-backdrop" style="position: fixed; top: 0; left: 0; width: 1000px; height: 800px; z-index: 1000;"></div>
      <section id="overlay-surface" style="position: fixed; top: 100px; left: 100px; width: 500px; height: 400px; z-index: 1001;">
        <button id="overlay-apply">Apply changes</button>
      </section>
    `;
    const backdrop = shadow.getElementById('overlay-backdrop')!;
    backdrop.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
      }) as DOMRect;
    const surface = shadow.getElementById('overlay-surface')!;
    surface.getBoundingClientRect = () =>
      ({
        x: 100,
        y: 100,
        left: 100,
        top: 100,
        right: 600,
        bottom: 500,
        width: 500,
        height: 400,
      }) as DOMRect;
    const apply = shadow.getElementById('overlay-apply')!;
    apply.getBoundingClientRect = () =>
      ({
        x: 140,
        y: 160,
        left: 140,
        top: 160,
        right: 260,
        bottom: 200,
        width: 120,
        height: 40,
      }) as DOMRect;

    const blocker = detectActiveModalBlocker();
    expect(blocker?.el.id).toBe('overlay-backdrop');
    expect(computeInteractionScope().roots).toContain(host);

    const pruner = inPageDOMPruner();
    expect(pruner.modalIsolated).toBe(true);
    expect(pruner.treeString).toContain('Apply changes');
  });

  it('13. includes an arbitrary referenced overlay target without relying on framework-specific classes', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" id="relation-modal" style="position: fixed; top: 60px; left: 80px; width: 480px; height: 360px; z-index: 2000;">
        <button id="relation-trigger" aria-controls="relation-panel" aria-expanded="true">Open options</button>
      </div>
      <x-support-panel id="relation-panel" style="position: fixed; top: 180px; left: 90px; width: 260px; height: 180px; z-index: 2100;">
        <button id="relation-choice">Referenced choice</button>
      </x-support-panel>
    `;
    sizeElement('relation-modal', 480, 360);
    sizeElement('relation-trigger');
    sizeElement('relation-panel', 260, 180);
    sizeElement('relation-choice');

    const pruner = inPageDOMPruner();
    expect(pruner.modalIsolated).toBe(true);
    expect(pruner.treeString).toContain('Open options');
    expect(pruner.treeString).toContain('Referenced choice');
  });

  it('14. fastSnapshot honors explicit background observation while still reporting the active modal', () => {
    document.body.innerHTML = `
      <button id="background-action">Background action</button>
      <div role="dialog" aria-modal="true" id="fast-scope-modal" style="position: fixed; top: 50px; left: 50px; width: 500px; height: 360px; z-index: 2000;">
        <button id="modal-action">Modal action</button>
      </div>
    `;
    sizeElement('background-action');
    sizeElement('modal-action');
    sizeElement('fast-scope-modal', 500, 360);

    const isolated = fastSnapshot();
    const fullPage = fastSnapshot({ isolateModal: false });

    expect(isolated?.actions.some((action) => action.label.includes('Background action'))).toBe(
      false,
    );
    expect(isolated?.actions.some((action) => action.label.includes('Modal action'))).toBe(true);
    expect(fullPage?.actions.some((action) => action.label.includes('Background action'))).toBe(
      true,
    );
    expect(fullPage?.actions.some((action) => action.label.includes('Modal action'))).toBe(true);
    expect(fullPage?.marker).toContainEqual(
      expect.objectContaining({
        modal: expect.stringContaining('fast-scope-modal'),
        isolated: false,
      }),
    );
  });

  it('15. finds scrollable interaction regions inside an open Shadow DOM overlay', () => {
    document.body.innerHTML = '<x-generic-overlay id="shadow-overlay"></x-generic-overlay>';
    const shadow = document.getElementById('shadow-overlay')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <section role="dialog" aria-modal="true" id="shadow-dialog" style="position: fixed; top: 30px; left: 30px; width: 500px; height: 400px; z-index: 2000;">
        <div id="shadow-scroll-pane" style="overflow-y: auto;"><button id="shadow-action">Continue</button></div>
      </section>
    `;
    const dialog = shadow.getElementById('shadow-dialog') as HTMLElement;
    dialog.getBoundingClientRect = () =>
      ({
        x: 30,
        y: 30,
        left: 30,
        top: 30,
        right: 530,
        bottom: 430,
        width: 500,
        height: 400,
      }) as DOMRect;
    const pane = shadow.getElementById('shadow-scroll-pane') as HTMLElement;
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 220 });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 660 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, value: 0 });
    const action = shadow.getElementById('shadow-action')!;
    action.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 70,
        left: 50,
        top: 70,
        right: 170,
        bottom: 110,
        width: 120,
        height: 40,
      }) as DOMRect;

    const scope = computeInteractionScope();
    expect(scope.roots.map((root) => (root as HTMLElement).id)).toEqual(['shadow-overlay']);
    expect(scope.scrollContainers).toEqual([pane]);
  });

  it('5. scrollInfo prioritizes single primary scroll container in active modal with selector and range', () => {
    document.body.innerHTML = `
      <div id="main-bg" style="height: 3000px;">
        <button id="bg-scroll-btn">Background</button>
      </div>
      <div role="dialog" aria-modal="true" id="scrollable-modal" style="position: fixed; top: 50px; left: 50px; width: 600px; height: 400px; z-index: 2000;">
        <h2>Scrollable Modal</h2>
        <div id="modal-scroll-pane" class="modal-body" style="overflow-y: auto; height: 300px;">
          <div style="height: 900px;">
            <button id="modal-inner-btn">Inner Action</button>
          </div>
        </div>
      </div>
    `;

    const modal = document.getElementById('scrollable-modal')!;
    modal.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 650,
        bottom: 450,
        width: 600,
        height: 400,
      }) as DOMRect;

    const scrollPane = document.getElementById('modal-scroll-pane') as HTMLElement;
    Object.defineProperty(scrollPane, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scrollPane, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(scrollPane, 'scrollTop', { configurable: true, value: 150 });

    const res = inPageDOMPruner();
    expect(res.scrollInfo).toBeDefined();
    expect(res.scrollInfo?.containerTag).toBe('div');
    expect(res.scrollInfo?.containerSelector).toBe('#modal-scroll-pane');
    expect(res.scrollInfo?.scroll_y).toBe(150);
    expect(res.scrollInfo?.viewport_height).toBe(300);
    expect(res.scrollInfo?.total_height).toBe(900);
    expect(res.scrollInfo?.pages_up).toBe(0.5);
    expect(res.scrollInfo?.pages_down).toBe(1.5);
    expect(res.scrollInfo?.ambiguous).toBe(false);
  });

  it('6. scrollInfo returns ambiguous: true when multiple scrollable containers exist in modal', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" id="dual-scroll-modal" style="position: fixed; top: 50px; left: 50px; width: 700px; height: 500px; z-index: 2000;">
        <div id="left-pane" style="overflow-y: auto; height: 300px; width: 300px;">
          <div style="height: 800px;">Left Items</div>
        </div>
        <div id="right-pane" style="overflow-y: auto; height: 300px; width: 300px;">
          <div style="height: 800px;">Right Items</div>
        </div>
      </div>
    `;

    const modal = document.getElementById('dual-scroll-modal')!;
    modal.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 750,
        bottom: 550,
        width: 700,
        height: 500,
      }) as DOMRect;

    const left = document.getElementById('left-pane') as HTMLElement;
    Object.defineProperty(left, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(left, 'scrollHeight', { configurable: true, value: 800 });
    Object.defineProperty(left, 'scrollTop', { configurable: true, value: 0 });

    const right = document.getElementById('right-pane') as HTMLElement;
    Object.defineProperty(right, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(right, 'scrollHeight', { configurable: true, value: 800 });
    Object.defineProperty(right, 'scrollTop', { configurable: true, value: 0 });

    const res = inPageDOMPruner();
    expect(res.scrollInfo).toBeDefined();
    expect(res.scrollInfo?.ambiguous).toBe(true);
    // Does not return background window's fake page count
    expect(res.scrollInfo?.pages_up).toBe(0);
    expect(res.scrollInfo?.pages_down).toBe(0);
  });

  it('7. explicit selector can read background, but actions on background are blocked by active modal', () => {
    document.body.innerHTML = `
      <button id="bg-target-btn">Background Target</button>
      <div role="dialog" aria-modal="true" id="blocking-modal" style="position: fixed; top: 0px; left: 0px; width: 1000px; height: 800px; z-index: 9999;">
        <button id="modal-btn">Modal Confirm</button>
      </div>
    `;

    const modal = document.getElementById('blocking-modal')!;
    modal.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
      }) as DOMRect;

    const bgBtn = document.getElementById('bg-target-btn')!;
    bgBtn.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 150,
        bottom: 90,
        width: 100,
        height: 40,
      }) as DOMRect;

    // Explicit scope allows reading the background element
    const scopedRead = inPageDOMPruner({ scope: '#bg-target-btn' });
    expect(scopedRead.treeString).toContain('Background Target');

    // But action on background button is not authorized when active modal blocks it
    const bgIndex = indexElement(bgBtn);
    const occlusionRes = inPageCheckOcclusion({ node: bgIndex, kind: 'click' });
    expect(occlusionRes).toBeNull();
  });

  it('8. fastSnapshot text and chained summary share the modal scroll scope', () => {
    document.body.innerHTML = `
      <div id="background-copy">Background-only text</div>
      <div role="dialog" aria-modal="true" id="fast-modal" style="position: fixed; top: 50px; left: 50px; width: 600px; height: 400px; z-index: 2000;">
        <h2>Modal details</h2>
        <div id="fast-modal-scroll" style="overflow-y: auto; height: 240px;">
          <div id="fast-modal-copy" style="height: 720px;">Modal-only text</div>
        </div>
      </div>
    `;

    const modal = document.getElementById('fast-modal')!;
    modal.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 650,
        bottom: 450,
        width: 600,
        height: 400,
      }) as DOMRect;
    const pane = document.getElementById('fast-modal-scroll') as HTMLElement;
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 240 });
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 720 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, value: 120 });
    sizeElement('fast-modal-copy', 300, 100);
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        x: 60,
        y: 60,
        left: 60,
        top: 60,
        right: 240,
        bottom: 90,
        width: 180,
        height: 30,
        toJSON: () => ({}),
      } as DOMRect),
    });

    const snapshot = fastSnapshot();
    const summary = inPageGetActiveElementSummary();

    expect(snapshot?.text).toContain('Modal-only text');
    expect(snapshot?.text).not.toContain('Background-only text');
    expect(snapshot?.scrollInfo).toMatchObject({
      scope: 'element',
      containerIndex: indexElement(pane),
      scroll_y: 120,
      viewport_height: 240,
      total_height: 720,
      ambiguous: false,
    });
    expect(summary.scrollInfo).toEqual(snapshot?.scrollInfo);
  });

  it('9. fastSnapshot exposes ambiguous scrolling without offering background scroll actions', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true" id="fast-dual-modal" style="position: fixed; top: 50px; left: 50px; width: 700px; height: 500px; z-index: 2000;">
        <div id="fast-left-pane" style="overflow-y: auto; height: 300px;"></div>
        <div id="fast-right-pane" style="overflow-y: auto; height: 300px;"></div>
      </div>
    `;
    const modal = document.getElementById('fast-dual-modal')!;
    modal.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 50,
        left: 50,
        top: 50,
        right: 750,
        bottom: 550,
        width: 700,
        height: 500,
      }) as DOMRect;
    for (const id of ['fast-left-pane', 'fast-right-pane']) {
      const pane = document.getElementById(id) as HTMLElement;
      Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 300 });
      Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 900 });
      Object.defineProperty(pane, 'scrollTop', { configurable: true, value: 0 });
    }

    const snapshot = fastSnapshot();

    expect(snapshot?.scrollInfo).toMatchObject({
      scope: 'ambiguous',
      ambiguous: true,
      pages_up: 0,
      pages_down: 0,
    });
    expect(snapshot?.actions.some((action) => action.kind === 'scroll')).toBe(false);
    expect(inPageFindSmartScrollTarget({ direction: 'down' })).toMatchObject({
      found: false,
      ambiguous: true,
      reason: 'ambiguous_scroll_container',
    });
  });

  it('10. an open non-modal native dialog does not isolate page interaction', () => {
    document.body.innerHTML = `
      <button id="native-page-action">Page Action</button>
      <dialog open id="nonmodal-dialog" style="position: fixed; top: 80px; left: 80px; width: 420px; height: 260px;">
        <button id="native-dialog-action">Dialog Action</button>
      </dialog>
    `;
    const dialog = document.getElementById('nonmodal-dialog')!;
    dialog.getBoundingClientRect = () =>
      ({
        x: 80,
        y: 80,
        left: 80,
        top: 80,
        right: 500,
        bottom: 340,
        width: 420,
        height: 260,
      }) as DOMRect;
    sizeElement('native-page-action');
    sizeElement('native-dialog-action');

    expect(detectActiveModalBlocker()).toBeNull();
    const snapshot = fastSnapshot();
    expect(snapshot?.actions.some((action) => action.label.includes('Page Action'))).toBe(true);
    expect(snapshot?.actions.some((action) => action.label.includes('Dialog Action'))).toBe(true);
  });
});
