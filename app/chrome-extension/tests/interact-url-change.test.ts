import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';

describe('Interaction URL Change Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports urlChanged=true when tab URL changes after fill action', async () => {
    const initialUrl = 'https://www.reddit.com/r/AI_Agents/submit';
    const finalUrl = 'https://www.reddit.com/r/AI_Agents/comments/12345/post_title';

    (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({
      id: 101,
      url: finalUrl,
      title: 'Reddit Post',
    });

    vi.spyOn(fillIndexTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 101,
      url: initialUrl,
    });

    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [{ result: { success: true, x: 100, y: 200, tagName: 'input' } }] as any;
      }
      if (fnName === 'inPageFillIndex') {
        return [{ result: { success: true, index: 5, value: 'Hello world' } }] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [{ result: { committed: true, currentValue: 'Hello world' } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    const res = await fillIndexTool.execute({
      index: 5,
      text: 'Hello world',
      tabId: 101,
    });

    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.urlChanged).toBe(true);
    expect(payload.previousUrl).toBe(initialUrl);
    expect(payload.currentUrl).toBe(finalUrl);
  });

  it('reports urlChanged=false when URL remains the same', async () => {
    const staticUrl = 'https://example.com/form';

    (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({
      id: 102,
      url: staticUrl,
      title: 'Example Form',
    });

    vi.spyOn(fillIndexTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 102,
      url: staticUrl,
    });

    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
      if (fnName === 'inPageGetElementCoordinates') {
        return [{ result: { success: true, x: 50, y: 60, tagName: 'input' } }] as any;
      }
      if (fnName === 'inPageFillIndex') {
        return [{ result: { success: true, index: 1, value: 'text' } }] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [{ result: { committed: true, currentValue: 'text' } }] as any;
      }
      return [{ result: { success: true } }] as any;
    });

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'text',
      tabId: 102,
    });

    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.urlChanged).toBe(false);
    expect(payload.previousUrl).toBe(staticUrl);
    expect(payload.currentUrl).toBe(staticUrl);
  });

  it('routes checkbox and special widgets to inPageFillIndex directly', async () => {
    const staticUrl = 'https://example.com/form';
    (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({
      id: 103,
      url: staticUrl,
      title: 'Form',
    });
    vi.spyOn(fillIndexTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 103,
      url: staticUrl,
    });

    let calledInPageFill = false;
    vi.spyOn(engine, 'executeInPage').mockImplementation(
      async (_target: any, fnName: string, args: any[]) => {
        if (fnName === 'inPageGetElementCoordinates') {
          return [
            {
              result: {
                success: true,
                x: 50,
                y: 60,
                tagName: 'input',
                inputType: 'checkbox',
              },
            },
          ] as any;
        }
        if (fnName === 'inPageFillIndex') {
          calledInPageFill = true;
          return [{ result: { success: true, index: args[0], value: 'true' } }] as any;
        }
        return [{ result: { success: true } }] as any;
      },
    );

    const res = await fillIndexTool.execute({
      index: 10,
      text: 'true',
      tabId: 103,
    });

    expect(res.isError).toBe(false);
    expect(calledInPageFill).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(true);
  });
});
