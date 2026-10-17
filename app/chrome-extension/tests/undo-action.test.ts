import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActionHistoryManager } from '../utils/action-history-manager';
import { UndoLastActionTool } from '../entrypoints/background/tools/browser/undo-action';

describe('UndoAction (History Manager & Rollback Execution)', () => {
  let historyManager: ActionHistoryManager;
  let tool: UndoLastActionTool;

  beforeEach(() => {
    historyManager = ActionHistoryManager.getInstance();
    historyManager.clear();
    tool = new UndoLastActionTool();

    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
        query: vi.fn(async () => [{ id: 1, active: true, windowId: 1 }]),
        goBack: vi.fn(async () => {}),
      },
      scripting: {
        executeScript: vi.fn(async () => [
          { result: { success: true, restoredValue: 'original' } },
        ]),
      },
    };
  });

  it('maintains bounded stack and pops most recent action', () => {
    for (let i = 1; i <= 7; i++) {
      historyManager.pushAction(1, {
        type: 'navigate',
        prevUrl: 'https://site.com/' + i,
        timestamp: i,
      });
    }
    const last = historyManager.popAction(1);
    expect(last?.type).toBe('navigate');
    expect((last as any).prevUrl).toBe('https://site.com/7');
  });

  it('reverts navigate actions via tabs.goBack', async () => {
    historyManager.pushAction(1, {
      type: 'navigate',
      prevUrl: 'https://example.com/step1',
      timestamp: Date.now(),
    });

    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(false);
    expect(chrome.tabs.goBack).toHaveBeenCalledWith(1);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.revertedAction).toBe('navigate');
  });

  it('restores input values for fill actions', async () => {
    historyManager.pushAction(1, {
      type: 'fill',
      index: 3,
      prevValue: 'hello-previous',
      timestamp: Date.now(),
    });

    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.revertedAction).toBe('fill');
    expect(parsed.restoredValue).toBe('hello-previous');
  });

  it('returns friendly error when no action history exists', async () => {
    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('No undoable action recorded');
  });
});

describe('A-06: documentEpoch fail-closed undo', () => {
  type NavigationListener = (details: { tabId: number; frameId: number }) => void;

  async function setupFreshEnv() {
    const committed: NavigationListener[] = [];
    const historyState: NavigationListener[] = [];
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
        query: vi.fn(async () => [{ id: 1, active: true, windowId: 1 }]),
        goBack: vi.fn(async () => {}),
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn(async () => [
          { result: { success: true, restoredValue: 'original' } },
        ]),
      },
      webNavigation: {
        onCommitted: { addListener: vi.fn((cb: NavigationListener) => committed.push(cb)) },
        onHistoryStateUpdated: {
          addListener: vi.fn((cb: NavigationListener) => historyState.push(cb)),
        },
      },
    };

    vi.resetModules();
    const managerModule = await import('../utils/action-history-manager');
    const toolModule = await import('../entrypoints/background/tools/browser/undo-action');
    return {
      manager: managerModule.ActionHistoryManager.getInstance(),
      tool: new toolModule.UndoLastActionTool(),
      committed,
      historyState,
    };
  }

  it('rejects undo after a hard navigation (webNavigation.onCommitted) and keeps the record', async () => {
    const { manager, tool, committed } = await setupFreshEnv();
    manager.pushAction(1, { type: 'fill', index: 3, prevValue: 'stale', timestamp: Date.now() });
    expect(committed.length).toBeGreaterThan(0);

    committed[0]({ tabId: 1, frameId: 0 });

    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('navigated');
    expect(manager.peekAction(1)).toBeDefined();
  });

  it('allows undo within the same document epoch', async () => {
    const { manager, tool, committed } = await setupFreshEnv();
    committed[0]({ tabId: 1, frameId: 0 });

    manager.pushAction(1, { type: 'fill', index: 3, prevValue: 'same-doc', timestamp: Date.now() });

    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(false);
    expect(manager.peekAction(1)).toBeUndefined();
  });

  it('rejects undo after a history-state-only change (query/hash) - no pathname heuristic', async () => {
    const { manager, tool, historyState } = await setupFreshEnv();
    manager.pushAction(1, { type: 'fill', index: 3, prevValue: 'stale', timestamp: Date.now() });
    expect(historyState.length).toBeGreaterThan(0);

    historyState[0]({ tabId: 1, frameId: 0 });

    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('navigated');
  });

  it('ignores subframe navigation events (main-document scope)', async () => {
    const { manager, tool, committed } = await setupFreshEnv();
    manager.pushAction(1, { type: 'fill', index: 3, prevValue: 'main-doc', timestamp: Date.now() });
    expect(committed.length).toBeGreaterThan(0);

    committed[0]({ tabId: 1, frameId: 7 });

    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(false);
  });

  it('still undoes a recorded navigation after that navigation commits', async () => {
    const { manager, tool, committed } = await setupFreshEnv();
    manager.pushAction(1, {
      type: 'navigate',
      prevUrl: 'https://example.com/step1',
      timestamp: Date.now(),
    });
    // The recorded navigation itself bumps the epoch via main-frame onCommitted;
    // history records are not element-bound, so undo must still reach goBack.
    committed[0]({ tabId: 1, frameId: 0 });

    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(false);
    expect((globalThis as any).chrome.tabs.goBack).toHaveBeenCalledWith(1);
    expect(manager.peekAction(1)).toBeUndefined();
  });

  it('rejects a stale fill after navigation without popping it or falling through to navigate', async () => {
    const { manager, tool, committed } = await setupFreshEnv();
    manager.pushAction(1, {
      type: 'navigate',
      prevUrl: 'https://example.com/step1',
      timestamp: Date.now(),
    });
    manager.pushAction(1, {
      type: 'fill',
      index: 2,
      prevValue: 'stale',
      timestamp: Date.now(),
    });
    committed[0]({ tabId: 1, frameId: 0 });

    const res = await tool.execute({ tabId: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('navigated');
    // The stale element-bound record must stay on the stack and nothing may run.
    expect(manager.peekAction(1)?.type).toBe('fill');
    expect((globalThis as any).chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.tabs.goBack).not.toHaveBeenCalled();
  });
});

describe('A-07: undo restores controlled inputs through the native value setter', () => {
  let historyManager: ActionHistoryManager;
  let tool: UndoLastActionTool;

  function installValueTracker(node: HTMLInputElement | HTMLTextAreaElement) {
    // Mirrors React's inputValueTracking: a node-level accessor that records every
    // write in the tracker before delegating to the prototype setter.
    const proto = Object.getOwnPropertyDescriptor(
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!;
    let tracked = String(node.value);
    Object.defineProperty(node, 'value', {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(value: string) {
        tracked = String(value);
        proto.set!.call(this, value);
      },
    });
    const tracker = { getValue: () => tracked };
    (node as any)._valueTracker = tracker;
    return tracker;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    historyManager = ActionHistoryManager.getInstance();
    historyManager.clear();
    tool = new UndoLastActionTool();

    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
        query: vi.fn(async () => [{ id: 1, active: true, windowId: 1 }]),
        goBack: vi.fn(async () => {}),
      },
      scripting: {
        // Execute the real injected revert function against the jsdom document.
        executeScript: vi.fn(async (injection: any) => {
          const result = injection.func(...(injection.args ?? []));
          return [{ result }];
        }),
      },
    };
  });

  it('bypasses the tracker and dispatches bubbling input/change with the restored value', async () => {
    const input = document.createElement('input');
    input.setAttribute('data-mcp-idx', '3');
    input.value = 'user-typed';
    document.body.appendChild(input);
    const tracker = installValueTracker(input);

    const events: string[] = [];
    document.body.addEventListener('input', (e) =>
      events.push(`input:${(e.target as HTMLInputElement).value}`),
    );
    document.body.addEventListener('change', (e) =>
      events.push(`change:${(e.target as HTMLInputElement).value}`),
    );

    historyManager.pushAction(1, {
      type: 'fill',
      index: 3,
      prevValue: 'restored-value',
      timestamp: Date.now(),
    });

    const res = await tool.execute({ tabId: 1 });

    expect(res.isError).toBe(false);
    expect(input.value).toBe('restored-value');
    // React dedupes synthetic input events when the tracker value equals the node
    // value; the native setter must leave the tracker on the pre-restore value so
    // the framework's onChange actually fires.
    expect(tracker.getValue()).toBe('user-typed');
    expect(events).toEqual(['input:restored-value', 'change:restored-value']);
  });

  it('restores textarea values through the matching prototype setter', async () => {
    const textarea = document.createElement('textarea');
    textarea.setAttribute('data-mcp-idx', '4');
    textarea.value = 'typed';
    document.body.appendChild(textarea);
    const tracker = installValueTracker(textarea);

    const events: string[] = [];
    document.body.addEventListener('input', (e) =>
      events.push(`input:${(e.target as HTMLTextAreaElement).value}`),
    );

    historyManager.pushAction(1, {
      type: 'fill',
      index: 4,
      prevValue: 'restored-textarea',
      timestamp: Date.now(),
    });

    const res = await tool.execute({ tabId: 1 });

    expect(res.isError).toBe(false);
    expect(textarea.value).toBe('restored-textarea');
    expect(tracker.getValue()).toBe('typed');
    expect(events).toEqual(['input:restored-textarea']);
  });
});
