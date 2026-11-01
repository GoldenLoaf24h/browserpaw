import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import {
  inPageDOMPruner,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';
import {
  getLocatorAccessibleName,
  extractCleanElementText,
  observationFocusScope,
  withinObservationFocusScope,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import { observationPriority } from '../utils/observation-priority';

describe('observation relevance before the shared frame budget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    chrome.webNavigation = {
      ...chrome.webNavigation,
      getAllFrames: vi.fn(async () => [{ frameId: 0 }, { frameId: 7 }]),
    } as any;
    vi.spyOn(readDOMTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 1,
      url: 'https://test.local',
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 110,
      bottom: 40,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function action(index: number, flags = {}) {
    return {
      id: `e${index}`,
      node: index,
      kind: 'click',
      role: 'button',
      label: `Button ${index}`,
      ...flags,
    };
  }
  function frame(frameId: number, actions: any[], structuralElements: any[] = []) {
    return {
      frameId,
      result: {
        url: 'https://test.local',
        title: 'Test',
        w: 1000,
        h: 800,
        text: '',
        scroll: { y: 0, height: 800 },
        actions,
        structuralElements,
        marker: [],
        page_key: [],
        guards: {},
      },
    };
  }

  it('retains a focused child-frame target even when the global limit is one', async () => {
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      frame(0, [action(1)]),
      frame(7, [action(1001), action(1002, { focused: true })]),
    ] as any);
    const result = await readDOMTool.execute({
      fast: true,
      tabId: 1,
      limit: 1,
      includeDetails: true,
    });
    const payload = JSON.parse(result.content[0].text as string);
    expect(result.isError).toBe(false);
    expect(payload.elementCount).toBe(1);
    expect(payload.treeString).toContain('[1002]');
    expect(
      payload.actions.filter((item: any) => /^e\d+$/.test(item.id)).map((item: any) => item.id),
    ).toEqual(['e1002']);
    expect(payload.omitted_elements).toBe(2);
  });

  it.each([
    ['invalid', { invalid: true }],
    ['related form', { withinFocusScope: true }],
  ])(
    'promotes the last %s element before the second budget trims a frame',
    async (_label, flags) => {
      const actions = (base: number) => Array.from({ length: 250 }, (_, i) => action(base + i));
      const main = actions(1);
      const child = actions(1001);
      Object.assign(child[249], flags);
      vi.spyOn(engine, 'executeInPage').mockResolvedValue([frame(0, main), frame(7, child)] as any);
      const payload = JSON.parse(
        (await readDOMTool.execute({ fast: true, tabId: 1, includeDetails: true })).content[0]
          .text as string,
      );
      const selected = payload.actions.filter((item: any) => /^e\d+$/.test(item.id));
      expect(selected).toHaveLength(250);
      expect(selected.some((item: any) => item.id === 'e1250')).toBe(true);
      expect(
        selected.filter((item: any) => Number(item.id.slice(1)) < 1000).length,
      ).toBeGreaterThan(0);
      expect(payload.omitted_elements).toBe(250);
    },
  );

  it('keeps a structural alert ahead of ordinary actions without inventing a click action', async () => {
    const alert = {
      index: 1003,
      tagName: 'div',
      role: 'alert',
      text: 'Payment declined',
      attributes: { role: 'alert' },
      rect: { x: 10, y: 10, width: 100, height: 30 },
      isInteractive: false,
    };
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      frame(0, [action(1)]),
      frame(7, [action(1001)], [alert]),
    ] as any);
    const payload = JSON.parse(
      (await readDOMTool.execute({ fast: true, tabId: 1, limit: 1, includeDetails: true }))
        .content[0].text as string,
    );
    expect(payload.treeString).toContain('Payment declined');
    expect(payload.elementCount).toBe(1);
    expect(payload.actions.some((item: any) => item.id === 'e1003')).toBe(false);
  });

  it('carries a focused form context from the real standard collector', () => {
    document.body.innerHTML =
      '<form id="related"><input id="focus"><input id="other"></form><input id="outside">';
    document.getElementById('focus')!.focus();
    const result = inPageDOMPruner({ virtualizeViewport: false, flattenCards: false });
    const other = result.indexedElements!.find((item) => item.attributes.id === 'other');
    const outside = result.indexedElements!.find((item) => item.attributes.id === 'outside');
    expect(other).toBeDefined();
    expect(other!.withinFocusScope).toBe(true);
    expect(outside!.withinFocusScope).not.toBe(true);
  });

  it('prioritizes standard pagination across frames and preserves a usable continuation', async () => {
    const element = (index: number, attributes = {}) => ({
      index,
      tagName: 'button',
      text: `Button ${index}`,
      attributes,
      isInteractive: true,
      rect: { x: 10, y: 10, width: 100, height: 30 },
    });
    const main = Array.from({ length: 250 }, (_, i) => element(i + 1));
    const child = Array.from({ length: 250 }, (_, i) => element(i + 1001));
    child[249] = element(1250, { focused: 'true' });
    const result = (frameId: number, elements: any[]) => ({
      frameId,
      result: {
        treeString: elements.map((item) => `[${item.index}] button "${item.text}"`).join('\n'),
        indexedElements: elements,
        elementCount: elements.length,
        interactiveCount: elements.length,
        compressionRatio: 0,
        indexMap: Object.fromEntries(
          elements.map((item) => [item.index, { tagName: 'button', frameId: String(frameId) }]),
        ),
      },
    });
    vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([result(0, main), result(7, child)] as any);
    const first = JSON.parse(
      (await readDOMTool.execute({ tabId: 1, limit: 2 })).content[0].text as string,
    );
    expect(first.treeString.split('\n')[0]).toContain('[1250]');
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(2);
    const second = JSON.parse(
      (await readDOMTool.execute({ tabId: 1, cursor: 2, limit: 2 })).content[0].text as string,
    );
    expect(second.treeString).not.toContain('[1250]');
  });

  it('treats composed descendants and externally associated controls as the same form scope', () => {
    document.body.innerHTML =
      '<form id="f"><x-field></x-field></form><input id="linked" form="f"><input id="outside">';
    const shadow = document.querySelector('x-field')!.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<input id="inner">';
    const form = document.getElementById('f')!;
    expect(observationFocusScope(shadow.querySelector('input'))).toBe(form);
    expect(withinObservationFocusScope(shadow.querySelector('input')!, form)).toBe(true);
    expect(withinObservationFocusScope(document.getElementById('linked')!, form)).toBe(true);
    expect(withinObservationFocusScope(document.getElementById('outside')!, form)).toBe(false);
  });

  it('uses the component tree for ARIA names in both observation and locator resolution', () => {
    document.body.innerHTML = '<span id="label">Outside action</span><x-action></x-action>';
    const root = document.querySelector('x-action')!.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<span id="label">Component action</span><button aria-labelledby="label"></button>';
    const button = root.querySelector('button')!;
    expect(getLocatorAccessibleName(button)).toBe('Component action');
    expect(extractCleanElementText(button)).toBe('Component action');
  });

  it('does not fall back to a light-DOM name when a component reference is missing', () => {
    document.body.innerHTML =
      '<span id="label">Outside action</span><label for="inner">Outside label</label><x-action></x-action>';
    const root = document.querySelector('x-action')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<button aria-labelledby="label"></button><input id="inner">';
    expect(getLocatorAccessibleName(root.querySelector('button')!)).toBe('');
    expect(getLocatorAccessibleName(root.querySelector('input')!)).not.toContain('Outside label');
  });

  it('normalizes ARIA false and off consistently with form metadata', () => {
    expect(
      observationPriority({ attributes: { 'aria-invalid': ' FALSE ', 'aria-live': ' OFF ' } }),
    ).toBe(0);
    expect(observationPriority({ attributes: { 'aria-invalid': ' grammar ' } })).toBe(3);
    expect(observationPriority({ role: 'alert' })).toBe(2);
  });
});
