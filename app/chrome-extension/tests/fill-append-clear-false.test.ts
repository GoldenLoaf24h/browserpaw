import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getIsolatedIndexMap,
  inPageFillIndex,
  inPageVerifyInputCommitment,
} from '../entrypoints/background/tools/browser/dom-indexer';
import * as domIndexer from '../entrypoints/background/tools/browser/dom-indexer';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import * as agentCursor from '../entrypoints/background/tools/browser/agent-cursor';
import { cdpSessionManager } from '../utils/cdp-session-manager';
import * as raceCdpModule from '../utils/race-cdp';

const tabId = 7701;

function attachBox(el: HTMLElement) {
  el.getBoundingClientRect = () => ({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 260,
    bottom: 140,
    width: 160,
    height: 40,
    toJSON: () => ({}),
  });
}

function installChrome() {
  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => ({
        id,
        windowId: 1,
        url: 'https://example.com/',
        active: true,
      })),
      query: vi.fn(async () => [
        { id: tabId, windowId: 1, url: 'https://example.com/', active: true },
      ]),
      sendMessage: vi.fn(async () => ({ success: true })),
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ frameId: 0, documentId: 'doc', result: undefined }]),
    },
    runtime: { getPlatformInfo: vi.fn(async () => ({ os: 'win' })) },
    debugger: { onEvent: { addListener: vi.fn(), removeListener: vi.fn() } },
  };
}

async function dispatchRealInPage(
  _target: chrome.scripting.InjectionTarget,
  fnName: string,
  args: unknown[],
) {
  let result: any;
  if (fnName === 'inPageCheckOcclusion') {
    result = { x: 180, y: 120 };
  } else {
    const fn = (domIndexer as any)[fnName];
    if (typeof fn !== 'function') throw new Error(`Unexpected in-page entrypoint: ${fnName}`);
    result = await fn(...args);
  }
  return [{ frameId: 0, documentId: 'doc', result }] as any;
}

function installInputAndCdp(): { commands: any[] } {
  const commands: any[] = [];
  const input = document.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement;

  vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) =>
    fn({} as any),
  );
  vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue();
  vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue();
  vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
    commands.push({ method, params });
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
      input.focus();
    }
    if (method === 'Input.dispatchKeyEvent' && params?.commands?.includes('SelectAll')) {
      input.select();
    }
    if (
      method === 'Input.dispatchKeyEvent' &&
      params?.type === 'rawKeyDown' &&
      params?.key === 'Backspace'
    ) {
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + input.value.slice(end);
      input.setSelectionRange(start, start);
      if (start !== end) input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    if (method === 'Input.insertText') {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + params.text + input.value.slice(end);
      const caret = start + params.text.length;
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return {} as any;
  });
  return { commands };
}

describe('clear:false appends through the real DOM fill functions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    installChrome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as any).execCommand;
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
  });

  it.each(['role', 'aria-haspopup'])(
    'verifies an editable search combobox by its native value (%s)',
    (attribute) => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'open' });
      const input = document.createElement('input');
      input.type = 'search';
      input.value = 'Array.prototype.map';
      input.setAttribute(attribute, attribute === 'role' ? 'combobox' : 'listbox');
      attachBox(input);
      root.append(input);
      document.body.append(host);
      getIsolatedIndexMap().set(1, input);

      expect(inPageVerifyInputCommitment(1, 'Array.prototype.map')).toMatchObject({
        committed: true,
        currentValue: 'Array.prototype.map',
      });
      expect(inPageVerifyInputCommitment(1, 'Promise.all').committed).toBe(false);
    },
  );

  it('input appends once and leaves the caret at the new end', () => {
    const input = document.createElement('input');
    input.value = 'prefix';
    attachBox(input);
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(2, 2);
    getIsolatedIndexMap().set(1, input);
    let inputEvents = 0;
    input.addEventListener('input', () => inputEvents++);

    const result = inPageFillIndex(1, '-suffix', false);

    expect(result.success).toBe(true);
    expect(input.value).toBe('prefix-suffix');
    expect(input.selectionStart).toBe('prefix-suffix'.length);
    expect(input.selectionEnd).toBe('prefix-suffix'.length);
    expect(inputEvents).toBe(1);
  });

  it('textarea appends once and leaves the caret at the new end', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'line one';
    attachBox(textarea);
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.setSelectionRange(0, 0);
    getIsolatedIndexMap().set(2, textarea);

    const result = inPageFillIndex(2, '\nline two', false);

    expect(result.success).toBe(true);
    expect(textarea.value).toBe('line one\nline two');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it('contenteditable appends when execCommand is unavailable instead of replacing', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'prefix';
    attachBox(editor);
    document.body.appendChild(editor);
    getIsolatedIndexMap().set(3, editor);
    delete (document as any).execCommand;

    const result = inPageFillIndex(3, '-suffix', false);

    expect(result.success).toBe(true);
    expect(editor.textContent).toBe('prefix-suffix');
  });

  it('contenteditable ignores an existing middle selection and appends at the end', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'prefix';
    attachBox(editor);
    document.body.appendChild(editor);
    getIsolatedIndexMap().set(4, editor);
    editor.focus();

    const range = document.createRange();
    range.setStart(editor.firstChild!, 2);
    range.setEnd(editor.firstChild!, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    (document as any).execCommand = vi.fn((command: string, _showUI: boolean, text: string) => {
      if (command !== 'insertText') return false;
      const activeRange = window.getSelection()?.getRangeAt(0);
      if (!activeRange) return false;
      activeRange.deleteContents();
      activeRange.insertNode(document.createTextNode(text));
      activeRange.collapse(false);
      return true;
    });

    const result = inPageFillIndex(4, '-suffix', false);

    expect(result.success).toBe(true);
    expect(editor.textContent).toBe('prefix-suffix');
  });

  it('does not change checkbox or select semantics when clear is false', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    attachBox(checkbox);
    document.body.appendChild(checkbox);
    getIsolatedIndexMap().set(5, checkbox);

    const select = document.createElement('select');
    select.innerHTML = '<option value="CN">China</option><option value="US">United States</option>';
    attachBox(select);
    document.body.appendChild(select);
    getIsolatedIndexMap().set(6, select);

    expect(inPageFillIndex(5, 'true', false).success).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(inPageFillIndex(6, 'US', false).success).toBe(true);
    expect(select.value).toBe('US');
  });
});

describe('clear:false physical fill commitment', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    installChrome();
    vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(dispatchRealInPage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
  });

  it.each(['input', 'textarea'] as const)(
    'replaces %s without synthetic clearing or duplicate input events',
    async (tag) => {
      const input = document.createElement(tag);
      input.value = 'before';
      attachBox(input);
      document.body.append(input);
      getIsolatedIndexMap().set(1, input);
      const inputEvents = vi.fn();
      input.addEventListener('input', inputEvents);
      const { commands } = installInputAndCdp();

      const result = await performPhysicalFill({
        tabId,
        target: 1,
        text: 'replacement',
        clear: true,
      });

      expect(result).toMatchObject({ success: true, committed: true, method: 'cdp_native' });
      expect(input.value).toBe('replacement');
      expect(inputEvents).toHaveBeenCalledTimes(1);
      expect(commands.filter((entry) => entry.method === 'Input.insertText')).toHaveLength(1);
      expect(commands.some((entry) => entry.params?.key === 'Backspace')).toBe(false);
    },
  );

  it.each(['#native-field', 'input', 'em input'])(
    'resolves CSS %s as a selector before native insertion',
    async (selector) => {
      const input = document.createElement('input');
      input.id = 'native-field';
      attachBox(input);
      if (selector.startsWith('em')) {
        const parent = document.createElement('em');
        parent.append(input);
        document.body.append(parent);
      } else {
        document.body.append(input);
      }
      const { commands } = installInputAndCdp();
      const result = await performPhysicalFill({
        tabId,
        target: selector,
        text: 'replacement',
        clear: true,
      });

      expect(commands.filter((entry) => entry.method === 'Input.insertText')).toHaveLength(1);
      expect(result).toMatchObject({ success: true, committed: true, method: 'cdp_native' });
      expect(input.value).toBe('replacement');
      expect(
        vi
          .mocked(inPageEngine.executeInPage)
          .mock.calls.some(([, name]) => name === 'inPageFillIndex'),
      ).toBe(false);
    },
  );

  it('refuses ambiguous selectors without mutating the first match', async () => {
    for (let i = 0; i < 2; i++) {
      const input = document.createElement('input');
      input.value = 'original';
      attachBox(input);
      document.body.append(input);
    }
    const { commands } = installInputAndCdp();
    const result = await performPhysicalFill({ tabId, target: 'input', text: 'replacement' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/strict|multiple|resolved to 2/i);
    expect(Array.from(document.querySelectorAll('input')).map((input) => input.value)).toEqual([
      'original',
      'original',
    ]);
    expect(commands).toHaveLength(0);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('clears with native deletion and verifies the empty value', async () => {
    const input = document.createElement('textarea');
    input.value = 'before';
    attachBox(input);
    document.body.append(input);
    getIsolatedIndexMap().set(1, input);
    const events = vi.fn();
    input.addEventListener('input', events);
    const { commands } = installInputAndCdp();
    const result = await performPhysicalFill({ tabId, target: 1, text: '', clear: true });
    expect(result).toMatchObject({ success: true, committed: true, method: 'cdp_native' });
    expect(input.value).toBe('');
    expect(events).toHaveBeenCalledTimes(1);
    expect(commands.some((entry) => entry.method === 'Input.insertText')).toBe(false);
  });

  it('does not replay a native clear when its postcondition cannot be verified', async () => {
    const input = document.createElement('textarea');
    input.value = 'before';
    attachBox(input);
    document.body.append(input);
    getIsolatedIndexMap().set(1, input);
    const { commands } = installInputAndCdp();
    vi.mocked(inPageEngine.executeInPage).mockImplementation(async (target, name, args) =>
      name === 'inPageVerifyInputCommitment'
        ? ([{ frameId: 0, result: { committed: false } }] as any)
        : dispatchRealInPage(target, name, args),
    );

    const result = await performPhysicalFill({ tabId, target: 1, text: '', clear: true });
    expect(result).toMatchObject({
      success: false,
      committed: false,
      status: 'unknown',
      retry: false,
    });
    expect(
      commands.filter(
        (entry) =>
          entry.method === 'Input.dispatchKeyEvent' &&
          entry.params?.type === 'rawKeyDown' &&
          entry.params?.key === 'Backspace',
      ),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(inPageEngine.executeInPage)
        .mock.calls.some(([, name]) => name === 'inPageFillIndex'),
    ).toBe(false);
  });

  it('native success inserts exactly once and verifies prefix + suffix', async () => {
    const input = document.createElement('input');
    input.value = 'prefix';
    attachBox(input);
    document.body.appendChild(input);
    getIsolatedIndexMap().set(1, input);
    input.focus();
    input.setSelectionRange(2, 4);
    const { commands } = installInputAndCdp();

    const result = await performPhysicalFill({
      tabId,
      target: 1,
      text: '-suffix',
      clear: false,
    });
    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
    expect(input.value).toBe('prefix-suffix');
    expect(commands.filter((entry) => entry.method === 'Input.insertText')).toHaveLength(1);
    expect(
      commands.filter(
        (entry) =>
          entry.method === 'Input.dispatchKeyEvent' &&
          typeof entry.params?.text === 'string' &&
          entry.params.text !== '\r',
      ),
    ).toHaveLength(0);
  });

  it.each([false, true])(
    'failed verification never replays inserted text (clear=%s)',
    async (clear) => {
      const input = document.createElement('input');
      input.value = 'prefix';
      attachBox(input);
      document.body.appendChild(input);
      getIsolatedIndexMap().set(1, input);
      const { commands } = installInputAndCdp();
      vi.mocked(raceCdpModule.raceCdp).mockImplementation(async (_tabId, method, params: any) => {
        commands.push({ method, params });
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
          input.focus();
        }
        return {} as any;
      });

      const result = await performPhysicalFill({
        tabId,
        target: 1,
        text: '-suffix',
        clear,
      });

      expect(result.success).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.retry).toBe(false);
      expect(result.diagnostics).toContain('observed length');
      expect(result.diagnostics).not.toContain('prefix');
      expect(result.error).not.toContain('prefix');
      expect(input.value).toBe('prefix');
      expect(commands.filter((entry) => entry.method === 'Input.insertText')).toHaveLength(1);
      expect(
        commands.filter(
          (entry) =>
            entry.method === 'Input.dispatchKeyEvent' &&
            typeof entry.params?.text === 'string' &&
            entry.params.text !== '\r',
        ),
      ).toHaveLength(0);
      expect(
        (inPageEngine.executeInPage as any).mock.calls.filter(
          ([, name]: any[]) => name === 'inPageFillIndex',
        ),
      ).toHaveLength(0);
    },
  );

  it('allows synthetic append only when insertion failed before dispatch', async () => {
    const input = document.createElement('input');
    input.value = 'prefix';
    attachBox(input);
    document.body.appendChild(input);
    getIsolatedIndexMap().set(1, input);
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) =>
      fn({} as any),
    );
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue();
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue();
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        input.focus();
      }
      if (method === 'Input.insertText') {
        throw new Error('Input.insertText rejected before dispatch');
      }
      return {} as any;
    });

    const result = await performPhysicalFill({
      tabId,
      target: 1,
      text: '-suffix',
      clear: false,
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe('synthetic_inpage');
    expect(input.value).toBe('prefix-suffix');
    expect(
      (inPageEngine.executeInPage as any).mock.calls.filter(
        ([, name]: any[]) => name === 'inPageFillIndex',
      ),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'does not claim commitment when validation is unavailable (clear=%s)',
    async (clear) => {
      const input = document.createElement('input');
      attachBox(input);
      document.body.appendChild(input);
      getIsolatedIndexMap().set(1, input);
      const { commands } = installInputAndCdp();
      vi.mocked(inPageEngine.executeInPage).mockImplementation(async (target, name, args) =>
        name === 'inPageVerifyInputCommitment'
          ? ([{ frameId: 0, result: {} }] as any)
          : dispatchRealInPage(target, name, args),
      );

      const result = await performPhysicalFill({ tabId, target: 1, text: 'applied', clear });

      expect(result).toMatchObject({
        success: false,
        committed: false,
        status: 'unknown',
        retry: false,
      });
      expect(input.value).toBe('applied');
      expect(commands.filter((entry) => entry.method === 'Input.insertText')).toHaveLength(1);
      expect(
        vi
          .mocked(inPageEngine.executeInPage)
          .mock.calls.some(([, name]) => name === 'inPageFillIndex'),
      ).toBe(false);
    },
  );

  it('inserts multiline text as one native operation without dispatching Enter', async () => {
    const input = document.createElement('textarea');
    attachBox(input);
    document.body.appendChild(input);
    getIsolatedIndexMap().set(1, input);
    const { commands } = installInputAndCdp();
    const send = vi.mocked(raceCdpModule.raceCdp).getMockImplementation()!;
    vi.mocked(raceCdpModule.raceCdp).mockImplementation(async (id, method, params: any) => {
      if (method === 'Input.dispatchKeyEvent' && params?.key === 'Enter') {
        throw new Error('Newline dispatch rejected');
      }
      return send(id, method, params);
    });

    const result = await performPhysicalFill({
      tabId,
      target: 1,
      text: 'first\nsecond',
      clear: false,
    });

    expect(result).toMatchObject({ success: true, committed: true });
    expect(input.value).toBe('first\nsecond');
    expect(commands.filter((entry) => entry.method === 'Input.insertText')).toHaveLength(1);
    expect(commands.some((entry) => entry.params?.key === 'Enter')).toBe(false);
    expect(
      vi
        .mocked(inPageEngine.executeInPage)
        .mock.calls.some(([, name]) => name === 'inPageFillIndex'),
    ).toBe(false);
  });

  it('routes number input append through the synthetic native setter path', async () => {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = '12';
    attachBox(input);
    document.body.appendChild(input);
    getIsolatedIndexMap().set(1, input);
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) =>
      fn({} as any),
    );
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue();
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue();
    vi.spyOn(raceCdpModule, 'raceCdp').mockResolvedValue({} as any);

    const result = await performPhysicalFill({
      tabId,
      target: 1,
      text: '3',
      clear: false,
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe('synthetic_inpage');
    expect(input.value).toBe('123');
    expect(raceCdpModule.raceCdp).not.toHaveBeenCalledWith(
      tabId,
      'Input.insertText',
      expect.anything(),
    );
  });

  it('fails closed without replay when insertText outcome is unknown after dispatch', async () => {
    const input = document.createElement('input');
    input.value = 'prefix';
    attachBox(input);
    document.body.appendChild(input);
    getIsolatedIndexMap().set(1, input);
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _caller, fn) =>
      fn({} as any),
    );
    vi.spyOn(agentCursor, 'animateAgentCursor').mockResolvedValue();
    vi.spyOn(agentCursor, 'animateAgentCursorClick').mockResolvedValue();
    vi.spyOn(raceCdpModule, 'raceCdp').mockImplementation(async (_tabId, method, params: any) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
        input.focus();
      }
      if (method === 'Input.insertText') {
        const start = input.selectionStart ?? input.value.length;
        input.value = `${input.value.slice(0, start)}${params.text}${input.value.slice(start)}`;
        input.setSelectionRange(input.value.length, input.value.length);
        throw new raceCdpModule.CdpDispatchTimeoutError('Input.insertText');
      }
      return {} as any;
    });

    const result = await performPhysicalFill({
      tabId,
      target: 1,
      text: '-suffix',
      clear: false,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.retry).toBe(false);
    expect(input.value).toBe('prefix-suffix');
    expect(
      (inPageEngine.executeInPage as any).mock.calls.filter(
        ([, name]: any[]) => name === 'inPageFillIndex',
      ),
    ).toHaveLength(0);
  });
});
