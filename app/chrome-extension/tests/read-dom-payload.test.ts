import { describe, it, expect, vi } from 'vitest';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';

/**
 * chrome_read_dom used to return three copies of the same page data
 * (treeString + indexMap + indexedElements) pretty-printed with a 2-space
 * indent — ~7x the payload for the same information, and indexMap was almost
 * entirely non-unique ("button" for 100 of 109 entries). The default response
 * is now the pruned tree plus counters, compact-encoded.
 */
const SAMPLE = {
  treeString: '[1] <button id="a">Go</button>\n[2] <input type="email">',
  elementCount: 2,
  interactiveCount: 2,
  compressionRatio: 0.9,
  indexMap: {
    1: { selector: 'button', tagName: 'button' },
    2: { selector: 'input', tagName: 'input' },
  },
  indexedElements: [
    { index: 1, tagName: 'button', text: 'Go', attributes: { id: 'a' }, isInteractive: true },
    { index: 2, tagName: 'input', attributes: { type: 'email' }, isInteractive: true },
  ],
  pages_up: 0,
  pages_down: 0,
  scrollInfo: { pages_up: 0, pages_down: 0 },
};

async function runReadDom(args: Record<string, unknown> = {}) {
  const mod = await import('../entrypoints/background/tools/browser/read-dom');
  const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
  const spy = vi.spyOn(engine, 'executeInPage');
  spy.mockResolvedValue([{ frameId: 0, result: { ...SAMPLE } }] as any);
  (mod.readDOMTool as any).resolveAffinityTab = async () => ({
    id: 1,
    url: 'https://x.test',
    title: 'X',
  });

  const res = await mod.readDOMTool.execute(args as any);
  spy.mockRestore();
  return JSON.parse(res.content[0].text as string);
}

describe('chrome_read_dom payload shape', () => {
  it('omits the bulky detail blocks by default', async () => {
    const payload = await runReadDom();

    expect(payload.treeString).toContain('[1] <button');
    expect(payload.indexedElements).toBeUndefined();
    expect(payload.indexMap).toBeUndefined();
    expect(payload.interactiveCount).toBe(2);
    expect(payload.totalElements).toBe(2);
  });

  it('returns the detail blocks when includeDetails is set', async () => {
    const payload = await runReadDom({ includeDetails: true });

    expect(Array.isArray(payload.indexedElements)).toBe(true);
    expect(payload.indexedElements).toHaveLength(2);
    expect(payload.indexMap).toBeTruthy();
  });

  it('encodes compact JSON, not the 2-space pretty form', async () => {
    const mod = await import('../entrypoints/background/tools/browser/read-dom');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    spy.mockResolvedValue([{ frameId: 0, result: { ...SAMPLE } }] as any);
    (mod.readDOMTool as any).resolveAffinityTab = async () => ({
      id: 1,
      url: 'https://x.test',
      title: 'X',
    });

    const res = await mod.readDOMTool.execute({} as any);
    const text = res.content[0].text as string;
    spy.mockRestore();

    expect(text.startsWith('{"')).toBe(true);
    expect(text.includes('\n  "')).toBe(false);
  });

  it('is a smaller payload than the pre-change shape for the same page', async () => {
    const payload = await runReadDom();
    const compact = JSON.stringify(payload);
    const legacyShape = JSON.stringify(
      { ...payload, indexedElements: SAMPLE.indexedElements, indexMap: SAMPLE.indexMap },
      null,
      2,
    );

    expect(compact.length).toBeLessThan(legacyShape.length);
  });

  it('declares includeDetails in the tool schema', () => {
    const schema = TOOL_SCHEMAS.find((t: any) => t.name === 'chrome_read_dom') as any;
    expect(schema).toBeTruthy();
    expect(schema.inputSchema.properties.includeDetails).toBeTruthy();
    expect(schema.inputSchema.properties.includeDetails.type).toBe('boolean');
  });

  it('remaps subframe visual asset indices sequentially without colliding with main frame asset indices', async () => {
    const mod = await import('../entrypoints/background/tools/browser/read-dom');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');

    const mainResult = {
      ...SAMPLE,
      assets: [
        {
          index: 1,
          kind: 'img',
          rect: { x: 10, y: 10, width: 100, height: 100 },
          src: 'https://example.com/a.png',
        },
      ],
    };
    const subframeResult = {
      ...SAMPLE,
      assets: [
        {
          index: 1,
          kind: 'img',
          rect: { x: 5, y: 5, width: 50, height: 50 },
          src: 'https://sub.example.com/b.png',
        },
      ],
    };

    spy.mockImplementation(async (_target, funcName) => {
      if (funcName === 'inPageReindexFrame') return [{ result: { success: true } }];
      return [
        { frameId: 0, result: mainResult },
        { frameId: 99, result: subframeResult },
      ] as any;
    });

    (mod.readDOMTool as any).resolveAffinityTab = async () => ({
      id: 1,
      url: 'https://x.test',
      title: 'X',
    });

    const res = await mod.readDOMTool.execute({ includeDetails: true } as any);
    spy.mockRestore();

    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.treeString).toContain('[asset 1]');
    expect(payload.treeString).toContain('[asset 2]');
    expect(payload.treeString).not.toContain('[asset 1] img 50x50');
  });

  describe('D-04: read_dom pagination decouples element slicing from banner lines', () => {
    it('paginates elements by element index without line-count shifting on pages with guidance and assets', async () => {
      const mod = await import('../entrypoints/background/tools/browser/read-dom');
      const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
      const spy = vi.spyOn(engine, 'executeInPage');

      const sampleWithBanners = {
        treeString: [
          '[Scroll Guidance: 1 pages above, 3 pages below. Use interact_index / scroll to reveal more content.]',
          '[1] button "Submit"',
          '[2] link "Home"',
          '[3] div "Body"',
          '[Visual Assets: 1 found. Pass assetIndex to screenshot to view one.]',
          '[asset 1] img 200x100 @(10,20) https://cdn.example.com/a.png',
        ].join('\n'),
        elementCount: 3,
        interactiveCount: 2,
        compressionRatio: 0.9,
        indexMap: {
          1: { selector: 'button', tagName: 'button' },
          2: { selector: 'a', tagName: 'a' },
          3: { selector: 'div', tagName: 'div' },
        },
        indexedElements: [
          { index: 1, tagName: 'button', text: 'Submit', isInteractive: true },
          { index: 2, tagName: 'a', text: 'Home', isInteractive: true },
          { index: 3, tagName: 'div', text: 'Body', isInteractive: false },
        ],
        assets: [
          {
            index: 1,
            kind: 'img',
            rect: { x: 10, y: 20, width: 200, height: 100 },
            src: 'https://cdn.example.com/a.png',
          },
        ],
        pages_up: 1,
        pages_down: 3,
        scrollInfo: { pages_up: 1, pages_down: 3 },
      };

      spy.mockResolvedValue([{ frameId: 0, result: sampleWithBanners }] as any);
      (mod.readDOMTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://x.test',
        title: 'X',
      });

      // Page 1: cursor 0, limit 2
      const resPage1 = await mod.readDOMTool.execute({
        cursor: 0,
        limit: 2,
        includeDetails: true,
      } as any);
      const p1 = JSON.parse(resPage1.content[0].text as string);

      expect(p1.totalElements).toBe(3);
      expect(p1.indexedElements).toHaveLength(2);
      expect(p1.indexedElements[0].index).toBe(1);
      expect(p1.indexedElements[1].index).toBe(2);
      expect(p1.hasMore).toBe(true);
      expect(p1.nextCursor).toBe(2);

      // Page 2: cursor 2, limit 2
      const resPage2 = await mod.readDOMTool.execute({
        cursor: 2,
        limit: 2,
        includeDetails: true,
      } as any);
      const p2 = JSON.parse(resPage2.content[0].text as string);

      expect(p2.totalElements).toBe(3);
      expect(p2.indexedElements).toHaveLength(1);
      expect(p2.indexedElements[0].index).toBe(3);
      expect(p2.hasMore).toBe(false);
      expect(p2.nextCursor).toBeUndefined();

      spy.mockRestore();
    });
  });

  describe('D-05: AX tree alignment conservatively rejects ambiguous names', () => {
    it('does not clobber inputs or elevate div roles when multiple elements share identical names without unique node id', async () => {
      const mod = await import('../entrypoints/background/tools/browser/read-dom');
      const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
      const { cdpSessionManager } = await import('../utils/cdp-session-manager');
      const spy = vi.spyOn(engine, 'executeInPage');

      const sampleElements = {
        treeString: [
          '[1] div "Delete"',
          '[2] button "Delete"',
          '[3] input "Email"',
          '[4] input "Email"',
        ].join('\n'),
        elementCount: 4,
        interactiveCount: 3,
        compressionRatio: 0.9,
        indexMap: {
          1: { selector: 'div', tagName: 'div' },
          2: { selector: 'button', tagName: 'button' },
          3: { selector: 'input', tagName: 'input' },
          4: { selector: 'input', tagName: 'input' },
        },
        indexedElements: [
          { index: 1, tagName: 'div', text: 'Delete', attributes: {}, isInteractive: false },
          {
            index: 2,
            tagName: 'button',
            text: 'Delete',
            attributes: { id: 'btn-del' },
            isInteractive: true,
          },
          {
            index: 3,
            tagName: 'input',
            attributes: { 'aria-label': 'Email', name: 'email_primary' },
            isInteractive: true,
          },
          {
            index: 4,
            tagName: 'input',
            attributes: { 'aria-label': 'Email', name: 'email_backup' },
            isInteractive: true,
          },
        ],
      };

      spy.mockResolvedValue([{ frameId: 0, result: sampleElements }] as any);
      (mod.readDOMTool as any).resolveAffinityTab = async () => ({
        id: 1,
        url: 'https://x.test',
        title: 'X',
      });

      const cdpSpy = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({
        nodes: [
          {
            role: { value: 'button' },
            name: { value: 'Delete' },
            properties: [{ name: 'id', value: { value: 'btn-del' } }],
          },
          {
            role: { value: 'StaticText' },
            name: { value: 'Delete' },
          },
          {
            role: { value: 'textbox' },
            name: { value: 'Email' },
            value: { value: 'user@corp.com' },
          },
          {
            role: { value: 'textbox' },
            name: { value: 'Email' },
            value: { value: 'other@corp.com' },
          },
        ],
      } as any);

      const res = await mod.readDOMTool.execute({ includeDetails: true } as any);
      const payload = JSON.parse(res.content[0].text as string);

      const divEl = payload.indexedElements.find((e: any) => e.index === 1);
      const input3 = payload.indexedElements.find((e: any) => e.index === 3);
      const input4 = payload.indexedElements.find((e: any) => e.index === 4);

      // Div should NOT be elevated to button due to ambiguous "Delete" text
      expect(divEl.role).toBeUndefined();
      expect(divEl.isInteractive).toBe(false);

      // Inputs should NOT be clobbered with other values because "Email" is ambiguous
      expect(input3.value).toBeUndefined();
      expect(input4.value).toBeUndefined();

      cdpSpy.mockRestore();
      spy.mockRestore();
    });
  });
});
