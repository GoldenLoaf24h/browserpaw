import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getIsolatedIndexMap,
  indexElement,
  inPageFocusIndex,
  inPageVerifyActiveElement,
  inPageGetActiveElementSummary,
  inPageEnsureModalFocus,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('closed component focus throughout the input pipeline', () => {
  let roots: WeakMap<Element, ShadowRoot>;
  let field: HTMLInputElement;
  beforeEach(() => {
    roots = new WeakMap();
    (chrome as any).dom = {
      openOrClosedShadowRoot: (element: Element) => roots.get(element) || element.shadowRoot,
    };
    document.body.innerHTML = '<x-outer></x-outer><input id="outside">';
    const outer = document.querySelector('x-outer')!;
    const root = outer.attachShadow({ mode: 'closed' });
    roots.set(outer, root);
    root.innerHTML = '<x-inner></x-inner>';
    const inner = root.querySelector('x-inner')!;
    const nested = inner.attachShadow({ mode: 'closed' });
    roots.set(inner, nested);
    nested.innerHTML = '<input id="field" value="initial">';
    field = nested.querySelector('input')!;
    getIsolatedIndexMap().clear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete (chrome as any).dom;
    vi.restoreAllMocks();
  });

  it('recognizes the actual input through nested closed roots', () => {
    field.focus();
    const result = inPageVerifyActiveElement(indexElement(field));
    expect(result.success).toBe(true);
    expect(result.isFocused).toBe(true);
    expect(result.activeId).toBe('field');
  });

  it('focuses by observed ref without adding tabindex to an already focusable input', () => {
    const result = inPageFocusIndex(indexElement(field));
    expect(result.focused).toBe(true);
    expect(field.hasAttribute('tabindex')).toBe(false);
  });

  it('reports the active inner field for post-action feedback', () => {
    field.focus();
    expect(inPageGetActiveElementSummary()).toMatchObject({
      id: 'field',
      tagName: 'input',
      value: 'initial',
    });
  });

  it('keeps refusal when the intended field cannot acquire focus', () => {
    document.getElementById('outside')!.focus();
    vi.spyOn(field, 'focus').mockImplementation(() => {});
    const result = inPageVerifyActiveElement(indexElement(field));
    expect(result.isFocused).toBe(false);
    expect(result.activeId).toBe('outside');
  });

  it('does not return a password value from deeper post-action focus feedback', () => {
    field.type = 'password';
    field.value = 'fixture-private-password';
    field.focus();
    const summary = inPageGetActiveElementSummary();
    expect(summary.id).toBe('field');
    expect(summary.value).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('fixture-private-password');
  });

  it('keeps the native input as the focus target if user-agent internals are exposed', () => {
    const internalHost = document.createElement('div');
    const internalRoot = internalHost.attachShadow({ mode: 'closed' });
    internalRoot.innerHTML = '<div contenteditable="true"></div>';
    Object.defineProperty(internalRoot, 'activeElement', { value: internalRoot.firstElementChild });
    roots.set(field, internalRoot);
    field.focus();
    expect(inPageVerifyActiveElement(indexElement(field)).isFocused).toBe(true);
    expect(inPageGetActiveElementSummary().id).toBe('field');
  });

  it('preserves an existing inner modal focus instead of moving it to the first control', () => {
    const root = field.getRootNode() as ShadowRoot;
    root.innerHTML = '<div id="modal" role="dialog"><input id="first"><input id="second"></div>';
    const second = root.querySelector('#second') as HTMLInputElement;
    second.focus();
    expect(inPageEnsureModalFocus(root.querySelector('#modal')!)).toBe(true);
    expect(root.activeElement).toBe(second);
  });
});
