import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fastSnapshot,
  getClawFastCache,
  inPageCheckOcclusion,
} from '../entrypoints/background/tools/browser/fast-snapshot';
import { getIsolatedIndexMap } from '../entrypoints/background/tools/browser/dom-indexer';

const closedRoots = new WeakMap<Element, ShadowRoot>();

function resetFastState(): void {
  document.body.innerHTML = '';
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-hidden');
  getIsolatedIndexMap().clear();
  delete (globalThis as any).__pawFast;
  delete (globalThis as any).__clawFast;
  delete (globalThis as any)[Symbol.for('__browser_use_index_namespace__')];
  delete (globalThis as any)[Symbol.for('__browser_use_index_identity__')];
  getClawFastCache().nodes.clear();
  getClawFastCache().actionElements?.clear();
}

function attach(host: Element, mode: 'open' | 'closed', html: string): ShadowRoot {
  const root = host.attachShadow({ mode });
  if (mode === 'closed') closedRoots.set(host, root);
  root.innerHTML = html;
  return root;
}

function interactive(result: NonNullable<ReturnType<typeof fastSnapshot>>) {
  return result.actions.filter((action) => /^e\d+$/.test(action.id || ''));
}

describe('fast snapshot priority and shadow', () => {
  beforeEach(() => {
    resetFastState();
    (window as any).innerWidth = 1200;
    (window as any).innerHeight = 800;
    (chrome as any).dom = {
      openOrClosedShadowRoot: (element: HTMLElement) =>
        closedRoots.get(element) || element.shadowRoot || null,
    };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 110,
      bottom: 40,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    }));
  });

  afterEach(() => {
    resetFastState();
    delete (chrome as any).dom;
    vi.restoreAllMocks();
  });

  it('keeps focused, invalid, alert, and focus scope when more than 250 candidates share the viewport', () => {
    const early = Array.from(
      { length: 248 },
      (_, index) => '<button id="b' + index + '">B' + index + '</button>',
    ).join('');
    const late = Array.from(
      { length: 12 },
      (_, index) => '<button id="l' + index + '">L' + index + '</button>',
    ).join('');
    document.body.innerHTML =
      early +
      '<form id="box">' +
      '<input id="focus" type="text" value="focus">' +
      '<input id="sibling" type="text" value="sib">' +
      '<input id="bad" type="text" aria-invalid="true" value="bad">' +
      '</form>' +
      '<div id="alert" role="alert">Form failed</div>' +
      late;
    (document.getElementById('focus') as HTMLInputElement).focus();

    const result = fastSnapshot()!;
    const actions = interactive(result);
    const ids = new Set(actions.map((action) => action.id));
    for (const element of result.structuralElements || []) ids.add('e' + element.index);

    const focus = actions.filter((action) => action.domId === 'focus');
    const sibling = actions.find((action) => action.domId === 'sibling');
    const invalid = actions.find((action) => action.domId === 'bad');
    const alert = result.structuralElements?.find((element) => element.attributes.id === 'alert');

    expect(focus.map((action) => action.kind).sort()).toEqual(['click', 'fill']);
    expect(new Set(focus.map((action) => action.id)).size).toBe(1);
    expect(focus[0].focused).toBe(true);
    expect(focus[0].withinFocusScope).toBe(true);
    expect(sibling?.withinFocusScope).toBe(true);
    expect(sibling?.focused).toBeUndefined();
    expect(invalid?.invalid).toBe(true);
    expect(alert?.text).toContain('Form failed');
    expect(alert?.withinFocusScope).not.toBe(true);
    expect(actions.some((action) => action.domId === 'b0')).toBe(true);
    expect(actions.some((action) => action.domId === 'b246')).toBe(false);
    expect(actions.some((action) => action.domId === 'l0')).toBe(false);
    expect(ids.size).toBe(250);
    expect(result.omitted_elements).toBe(14);
    expect(result.omitted_actions).toBe(14);
  });

  it('reads open and closed shadow content without using a document-level aria id or a native control shadow', () => {
    document.body.innerHTML =
      '<p id="name">LIGHT NAME</p>' +
      '<div id="open-host"></div>' +
      '<div id="closed-host"></div>' +
      '<input id="native" type="text" value="native-value">';
    attach(
      document.getElementById('open-host')!,
      'open',
      '<span id="name">SHADOW NAME</span><button id="open-btn" aria-labelledby="name">fallback</button><p>Open shadow paragraph</p>',
    );
    const closed = attach(
      document.getElementById('closed-host')!,
      'closed',
      '<button id="closed-btn">Closed Action</button><p>Closed shadow paragraph</p><input id="closed-focus" type="text" value="closed">',
    );
    const userAgent = document.createElement('div');
    const userAgentRoot = userAgent.attachShadow({ mode: 'open' });
    userAgentRoot.innerHTML = '<span>UA SECRET</span>';
    const pierce = (chrome as any).dom.openOrClosedShadowRoot;
    (chrome as any).dom.openOrClosedShadowRoot = (element: HTMLElement) =>
      element.id === 'native' ? userAgentRoot : pierce(element);
    (closed.getElementById('closed-focus') as HTMLInputElement).focus();

    const result = fastSnapshot()!;
    const actions = interactive(result);
    const openButton = actions.find((action) => action.domId === 'open-btn');
    const closedField = actions.find((action) => action.domId === 'closed-focus');

    expect(openButton?.label).toBe('SHADOW NAME');
    expect(openButton?.label).not.toContain('LIGHT');
    expect(actions.some((action) => action.domId === 'closed-btn')).toBe(true);
    expect(closedField?.focused).toBe(true);
    expect(result.text).toContain('Open shadow paragraph');
    expect(result.text).toContain('Closed shadow paragraph');
    expect(result.text).not.toContain('UA SECRET');
  });

  it('drops password, file, and hidden values from actions, page key, and guards', () => {
    document.body.innerHTML =
      '<input id="pw" type="password" value="secret-pass">' +
      '<input id="file" type="file">' +
      '<input id="hid" type="hidden" value="secret-hidden">' +
      '<input id="ok" type="text" value="visible-ok">' +
      '<div id="secret-host"></div>';
    attach(
      document.getElementById('secret-host')!,
      'open',
      '<input id="spw" type="password" value="shadow-pass">',
    );

    const result = fastSnapshot()!;
    const blob = JSON.stringify({
      actions: result.actions,
      page_key: result.page_key,
      guards: result.guards,
      marker: result.marker,
    });
    const actions = interactive(result);

    expect(actions.some((action) => action.domId === 'ok')).toBe(true);
    expect(
      actions.some((action) => ['pw', 'file', 'hid', 'spw'].includes(action.domId || '')),
    ).toBe(false);
    expect(blob).toContain('visible-ok');
    expect(blob).not.toContain('secret-pass');
    expect(blob).not.toContain('secret-hidden');
    expect(blob).not.toContain('shadow-pass');
  });

  it('applies scope and exclude across shadow hosts, and hides inert or aria-hidden hosts', () => {
    document.body.innerHTML =
      '<div id="panel">' +
      '<button id="in">In</button>' +
      '<div id="panel-host"></div>' +
      '<div id="skip-host" class="skip"></div>' +
      '<button id="skip-light" class="skip">Skip light</button>' +
      '</div>' +
      '<button id="out">Out</button>' +
      '<div id="hidden-host" aria-hidden="true"></div>' +
      '<div id="inert-host" inert></div>' +
      '<button id="visible">Visible</button>';
    attach(
      document.getElementById('panel-host')!,
      'open',
      '<button id="in-shadow">Inside</button>',
    );
    attach(
      document.getElementById('skip-host')!,
      'closed',
      '<button id="skipped">Skip me</button>',
    );
    attach(
      document.getElementById('hidden-host')!,
      'open',
      '<button id="hidden-btn">Hidden</button>',
    );
    attach(
      document.getElementById('inert-host')!,
      'closed',
      '<button id="inert-btn">Inert</button>',
    );

    const scoped = fastSnapshot({ scope: '#panel', exclude: '.skip' })!;
    const scopedIds = interactive(scoped).map((action) => action.domId);
    expect(scoped.selectorMatched).toBe(true);
    expect(scopedIds).toEqual(expect.arrayContaining(['in', 'in-shadow']));
    for (const id of ['out', 'skipped', 'skip-light', 'visible'])
      expect(scopedIds).not.toContain(id);

    const hidden = fastSnapshot()!;
    const hiddenIds = interactive(hidden).map((action) => action.domId);
    expect(hiddenIds).toContain('visible');
    for (const id of ['hidden-btn', 'inert-btn']) expect(hiddenIds).not.toContain(id);
  });

  it('counts separators within the single body text budget', () => {
    document.body.innerHTML = '<span>ab</span>'.repeat(4001);
    const result = fastSnapshot()!;
    expect(result.text.length).toBeLessThanOrEqual(6000);
    expect(result.textTruncated).toBe(true);
    expect(result.omitted_text).toBeGreaterThan(0);
  });

  it('accepts an actual hit inside a closed root while still rejecting an unrelated occluder', () => {
    document.body.innerHTML = '<div id="closed-host"></div><aside id="blocker"></aside>';
    const host = document.getElementById('closed-host')!;
    const root = attach(host, 'closed', '<input id="target" type="text">');
    const field = root.querySelector('input')!;
    const snapshot = fastSnapshot()!;
    const ref = Number(
      interactive(snapshot)
        .find((action) => action.domId === 'target')!
        .id.slice(1),
    );
    const previous = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    const hit = vi.fn(() => host);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
    Object.defineProperty(root, 'elementFromPoint', { value: vi.fn(() => field) });
    try {
      expect(inPageCheckOcclusion({ node: ref, kind: 'fill' })).toEqual({ x: 60, y: 25 });
      hit.mockReturnValue(document.getElementById('blocker')!);
      expect(inPageCheckOcclusion({ node: ref, kind: 'fill' })).toBeNull();
    } finally {
      if (previous) Object.defineProperty(document, 'elementFromPoint', previous);
      else delete (document as any).elementFromPoint;
    }
  });
});
