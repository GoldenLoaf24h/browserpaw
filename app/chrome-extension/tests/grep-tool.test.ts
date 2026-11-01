import { describe, it, expect, vi } from 'vitest';
import { grepTool } from '../entrypoints/background/tools/browser/grep';

describe('GrepTool (chrome_grep)', () => {
  it('fails with validation error when query is empty', async () => {
    const res = await grepTool.execute({ query: '' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('query parameter is required');
  });

  it('reports invalid regex gracefully', async () => {
    // Mock resolveAffinityTab
    vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 123,
      url: 'https://example.com',
    });
    const res = await grepTool.execute({ query: '[invalid-regex(', isRegex: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid regular expression');
  });

  it('matches placeholder and aria-label attributes across multi-frame hierarchy', async () => {
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 123,
      url: 'https://example.com',
    });

    spy.mockImplementation(async (target: any, fnName: string, args: any) => {
      if (fnName === 'inPageDOMPruner') {
        return [
          {
            frameId: 0,
            result: {
              elementCount: 1,
              interactiveCount: 1,
              indexedElements: [
                {
                  index: 1,
                  tagName: 'input',
                  role: 'textbox',
                  text: '',
                  isInteractive: true,
                  attributes: { placeholder: 'Search products' },
                },
              ],
              indexMap: { 1: { selector: '#search', tagName: 'input' } },
            },
          },
          {
            frameId: 42,
            result: {
              elementCount: 1,
              interactiveCount: 1,
              indexedElements: [
                {
                  index: 4201,
                  tagName: 'button',
                  role: 'button',
                  text: '',
                  isInteractive: true,
                  attributes: { 'aria-label': 'Submit payment' },
                },
              ],
              indexMap: { 4201: { selector: '#pay', tagName: 'button' } },
            },
          },
        ] as any;
      }
      return [] as any;
    });

    const res = await grepTool.execute({ query: 'payment' });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.totalMatches).toBe(1);
    // Subframe element index is preserved from the subframe namespace
    expect(parsed.matches[0].index).toBe(4201);
    expect(parsed.matches[0].tagName).toBe('button');

    spy.mockRestore();
  });
});
