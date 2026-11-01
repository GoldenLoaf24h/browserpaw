import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotCacheManager, snapshotCacheManager } from '../utils/snapshot-cache-manager';
import { captureChainedSnapshot } from '../utils/delta-helper';

vi.mock('../entrypoints/background/tools/browser/in-page-engine', () => ({
  executeInPage: vi.fn(),
}));

import { executeInPage } from '../entrypoints/background/tools/browser/in-page-engine';

function element(index: number, attributes: Record<string, string>, overrides = {}) {
  return {
    index,
    tagName: 'input',
    text: 'Field',
    isInteractive: true,
    value: '',
    attributes,
    ...overrides,
  };
}

describe('delta semantic state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotCacheManager.clear();
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ url: 'https://example.com/form' }),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0 }]),
      },
    };
  });

  it('reports a checkbox checked-only change as modified', () => {
    const manager = new SnapshotCacheManager();
    manager.setSnapshot(1, {
      url: 'https://example.com/form',
      elementCount: 1,
      elements: [element(1, { id: 'terms', type: 'checkbox', checked: 'false' })],
    });

    const diff = manager.diffWithPrevious(1, [
      element(1, { id: 'terms', type: 'checkbox', checked: 'true' }),
    ]);

    expect(diff).toMatchObject({
      isDelta: true,
      unchanged: false,
      added: [],
      removed: [],
    });
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].attributes).toMatchObject({ checked: 'true' });
    expect(diff.modified[0].diffHints?.oldAttributes).toMatchObject({ checked: 'false' });
  });

  it('reports aria-invalid and native validation message changes as modified', () => {
    const manager = new SnapshotCacheManager();
    manager.setSnapshot(2, {
      url: 'https://example.com/form',
      elementCount: 1,
      elements: [
        element(1, {
          id: 'email',
          type: 'email',
          required: 'true',
          valid: 'true',
          'data-internal-tracking': 'drop-me',
        }),
      ],
    });

    const diff = manager.diffWithPrevious(2, [
      element(1, {
        id: 'email',
        type: 'email',
        required: 'true',
        invalid: 'true',
        invalidReason: 'valueMissing',
        validationMessage: 'Required',
        'aria-invalid': 'true',
        'data-internal-tracking': 'drop-me',
      }),
    ]);

    expect(diff.unchanged).toBe(false);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].attributes).toMatchObject({
      required: 'true',
      invalid: 'true',
      invalidReason: 'valueMissing',
      validationMessage: 'Required',
      'aria-invalid': 'true',
    });
    expect(diff.modified[0].attributes?.['data-internal-tracking']).toBeUndefined();
    expect(diff.modified[0].diffHints?.oldAttributes).toMatchObject({ valid: 'true' });
  });

  it.each([
    ['disabled', { disabled: 'false' }, { disabled: 'true' }],
    ['aria-expanded', { 'aria-expanded': 'false' }, { 'aria-expanded': 'true' }],
    ['aria-selected', { 'aria-selected': 'false' }, { 'aria-selected': 'true' }],
    ['required', {}, { required: 'true' }],
  ])('reports %s-only changes as modified', (_name, before, after) => {
    const manager = new SnapshotCacheManager();
    manager.setSnapshot(3, {
      url: 'https://example.com/form',
      elementCount: 1,
      elements: [element(1, before)],
    });

    const diff = manager.diffWithPrevious(3, [element(1, after)]);

    expect(diff.unchanged).toBe(false);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].attributes).toMatchObject(after);
  });

  it('stores semantic attributes by value instead of retaining caller objects', () => {
    const manager = new SnapshotCacheManager();
    const baselineAttributes = { id: 'terms', checked: 'false', disabled: 'false' };
    manager.setSnapshot(4, {
      url: 'https://example.com/form',
      elementCount: 1,
      elements: [element(1, baselineAttributes)],
    });

    baselineAttributes.checked = 'true';
    baselineAttributes.disabled = 'true';

    expect(manager.getSnapshot(4)?.fingerprints?.get(1)?.attributes).toEqual({
      checked: 'false',
      disabled: 'false',
    });

    const diff = manager.diffWithPrevious(4, [element(1, { checked: 'true', disabled: 'false' })]);
    const oldAttributes = diff.modified[0].diffHints?.oldAttributes as Record<string, string>;
    oldAttributes.checked = 'mutated';
    expect(manager.getSnapshot(4)?.fingerprints?.get(1)?.attributes?.checked).toBe('false');
  });

  it.each(['focused', 'label', 'description', 'errormessage'])(
    'reports a %s change without relying on text or value changes',
    (attribute) => {
      const manager = new SnapshotCacheManager();
      manager.setSnapshot(8, {
        url: 'https://example.com/form',
        elementCount: 1,
        elements: [element(1, { [attribute]: 'before' })],
      });
      const diff = manager.diffWithPrevious(8, [element(1, { [attribute]: 'after' })]);
      expect(diff.unchanged).toBe(false);
      expect(diff.modified[0].attributes[attribute]).toBe('after');
    },
  );

  it('still reports semantic state when text also ticked as timer noise', () => {
    const manager = new SnapshotCacheManager();
    manager.setSnapshot(5, {
      url: 'https://example.com/form',
      elementCount: 1,
      elements: [
        element(1, { type: 'checkbox', checked: 'false' }, { text: 'Offer ends in 00:15' }),
      ],
    });

    const diff = manager.diffWithPrevious(5, [
      element(1, { type: 'checkbox', checked: 'true' }, { text: 'Offer ends in 00:14' }),
    ]);

    expect(diff.unchanged).toBe(false);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].attributes).toMatchObject({ checked: 'true' });
  });

  it('detects changes after the output excerpt boundary in a collected validation message', () => {
    const manager = new SnapshotCacheManager();
    const prefix = 'Validation detail '.repeat(6);
    manager.setSnapshot(9, {
      url: 'https://example.com/form',
      elementCount: 1,
      elements: [element(1, { validationMessage: `${prefix}before` })],
    });
    const diff = manager.diffWithPrevious(9, [element(1, { validationMessage: `${prefix}after` })]);
    expect(diff.unchanged).toBe(false);
    expect(diff.modified).toHaveLength(1);
  });

  it('settles the single DOM delta capture before probing the active element', async () => {
    const tabId = 6;
    const url = 'https://example.com/form';
    snapshotCacheManager.setSnapshot(tabId, {
      url,
      elementCount: 1,
      elements: [element(1, { id: 'terms', type: 'checkbox', checked: 'false' })],
    });

    const calls: string[] = [];
    vi.mocked(executeInPage).mockImplementation(async (_target: any, fnName: string) => {
      calls.push(fnName);
      if (fnName === 'inPageDOMPruner') {
        return [
          {
            frameId: 0,
            result: {
              indexedElements: [element(1, { id: 'terms', type: 'checkbox', checked: 'true' })],
            },
          },
        ] as any;
      }
      if (fnName === 'inPageGetActiveElementSummary') {
        return [
          {
            result: {
              tagName: 'input',
              id: 'terms',
              role: 'checkbox',
              isInput: true,
              value: 'on',
              hasActiveModal: false,
            },
          },
        ] as any;
      }
      return [] as any;
    });

    const result = await captureChainedSnapshot(tabId, url, { delayMs: 0 });

    expect(calls).toEqual(['inPageDOMPruner', 'inPageGetActiveElementSummary']);
    expect(calls.filter((name) => name === 'inPageDOMPruner')).toHaveLength(1);
    expect(result.summary.activeElement?.id).toBe('terms');
    expect(result.delta?.modified[0].attributes).toMatchObject({ checked: 'true' });
  });

  it('starts a new baseline when the observed region changes', () => {
    const manager = new SnapshotCacheManager();
    manager.setSnapshot(10, {
      url: 'https://example.com/form',
      elementCount: 1,
      elements: [element(1, { id: 'first' })],
      observationKey: 'region-a',
    });
    const diff = manager.diffWithPrevious(10, [element(2, { id: 'second' })], {
      observationKey: 'region-b',
    });
    expect(diff.isDelta).toBe(false);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
  });
});
