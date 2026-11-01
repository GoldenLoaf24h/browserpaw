import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getIsolatedIndexMap,
  inPageDOMPruner,
} from '../entrypoints/background/tools/browser/dom-indexer';

const body =
  '6/8 \u2014 Team Management\n\nWorking with editors, channel managers, or other team members?\n\n' +
  'Octo Browser offers team-management features and permission controls to help organize access to profiles and coordinate your workflow.';

describe('long informational text in compact observations', () => {
  beforeEach(() => {
    getIsolatedIndexMap().clear();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 610,
      bottom: 210,
      width: 600,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each([true, false])('retains a focal post body with flattenCards=%s', (flattenCards) => {
    document.body.innerHTML =
      '<main><article><a href="/author">Author</a><div><span id="body"></span></div>' +
      '<a href="/author/status/123"><time>Today</time></a><button>Reply</button></article></main>';
    document.getElementById('body')!.textContent = body;

    const result = inPageDOMPruner({
      format: 'compact',
      selector: 'main',
      maxTextLength: 260,
      flattenCards,
    });

    expect(result.treeString).toContain('Team Management');
    expect(result.treeString).toContain('Working with editors');
    expect(result.treeString).toContain('button "Reply"');
  });

  it('truncates a long text leaf using the requested text budget', () => {
    document.body.innerHTML = '<main><p id="body"></p></main>';
    document.getElementById('body')!.textContent = 'Readable paragraph. '.repeat(100);

    const result = inPageDOMPruner({
      format: 'compact',
      selector: 'main',
      maxTextLength: 100,
    });
    const paragraph = result.indexedElements?.find((element) => element.attributes?.id === 'body');

    expect(paragraph).toBeDefined();
    expect(paragraph!.text).toContain('Readable paragraph.');
    expect(paragraph!.text!.length).toBeLessThanOrEqual(103);
    expect(paragraph!.isInteractive).toBe(false);
  });

  it('continues to exclude hidden and inert long text', () => {
    document.body.innerHTML =
      '<main><p id="body"></p><div hidden><span id="hidden"></span></div>' +
      '<div inert><span id="inert"></span></div><script id="script"></script></main>';
    document.getElementById('body')!.textContent = body;
    for (const id of ['hidden', 'inert', 'script']) {
      document.getElementById(id)!.textContent = `${id}-excluded `.repeat(20);
    }

    const result = inPageDOMPruner({ format: 'compact', selector: 'main', maxTextLength: 260 });

    expect(result.treeString).toContain('Team Management');
    for (const id of ['hidden', 'inert', 'script']) {
      expect(result.treeString).not.toContain(`${id}-excluded`);
    }
  });
});
