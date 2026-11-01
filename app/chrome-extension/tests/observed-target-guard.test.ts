import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fastSnapshot,
  inPageValidateObservedGuard,
} from '../entrypoints/background/tools/browser/fast-snapshot';
import { assertObservedTarget } from '../utils/observed-target-guard';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import {
  INDEX_NAMESPACE_SIZE,
  findIndexedElement,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('observed target guard', () => {
  beforeEach(() => {
    getIsolatedIndexMap().clear();
    delete (globalThis as any)[Symbol.for('__browser_use_index_namespace__')];
    delete (globalThis as any)[Symbol.for('__browser_use_index_identity__')];
    delete (globalThis as any).__pawFast;
    delete (globalThis as any).__clawFast;
    document.body.innerHTML = '<button>Search</button>';
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
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects a changed label and a replacement node using the real snapshot guard', () => {
    const snapshot = fastSnapshot()!;
    const action = snapshot.actions.find((a) => a.kind === 'click')!;
    const guard = snapshot.guards[action.node];
    expect(inPageValidateObservedGuard(action.node, guard)).toBe(true);
    document.querySelector('button')!.textContent = 'Send';
    expect(inPageValidateObservedGuard(action.node, guard)).toBe(false);
    document.body.innerHTML = '<button>Search</button>';
    expect(inPageValidateObservedGuard(action.node, guard)).toBe(false);
  });

  it('uses the same namespaced ref for action id, node, executor lookup and guard', () => {
    (globalThis as any)[Symbol.for('__browser_use_index_namespace__')] = 5 * INDEX_NAMESPACE_SIZE;
    const snapshot = fastSnapshot()!;
    const action = snapshot.actions.find((a) => a.kind === 'click')!;
    expect(action.node).toBe(Number(action.id.slice(1)));
    expect(action.node).toBeGreaterThan(5 * INDEX_NAMESPACE_SIZE);
    expect(findIndexedElement(action.node!)).toBe(document.querySelector('button'));
    expect(inPageValidateObservedGuard(action.node!, snapshot.guards[action.node!])).toBe(true);
  });

  it('does no page work without an observed guard, and binds checks to the selected frame', async () => {
    const probe = vi.spyOn(engine, 'executeInPage').mockResolvedValue([{ result: false }] as any);
    await assertObservedTarget(7, 10, 4, undefined);
    expect(probe).not.toHaveBeenCalled();
    await expect(assertObservedTarget(7, 10, 4, [10, 'button', 'Search'])).rejects.toMatchObject({
      status: 'blocked',
      requestDispatched: false,
    });
    expect(probe).toHaveBeenCalledWith({ tabId: 7, frameIds: [4] }, 'inPageValidateObservedGuard', [
      10,
      [10, 'button', 'Search'],
    ]);
  });
});
