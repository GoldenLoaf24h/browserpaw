import { describe, expect, it, jest } from '@jest/globals';
import type { CallToolResult, ParsedCommand } from 'chrome-mcp-shared';
import { dispatchPage } from './commands-page';
import type { CommandRun } from './command-utils';

function result(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
    isError,
  };
}

function command(
  name: string,
  operands: string[] = [],
  options: ParsedCommand['options'] = Object.create(null),
): ParsedCommand {
  return { name: name as ParsedCommand['name'], operands, options };
}

describe('page command dispatch', () => {
  it('returns a bounded tab search without returning the unbounded inventory', async () => {
    const run = jest.fn(async () =>
      result({
        windows: [
          {
            windowId: 1,
            tabs: [
              { tabId: 11, title: 'Alpha one', url: 'https://one.example/' },
              { tabId: 12, title: 'Alpha two', url: 'https://two.example/' },
            ],
          },
          { windowId: 2, tabs: [{ tabId: 21, title: 'Beta', url: 'https://beta.example/' }] },
        ],
      }),
    ) as CommandRun;

    const response = await dispatchPage(command('tabs', ['alpha'], { limit: '1' }), run);

    expect(run).toHaveBeenCalledWith('get_windows_and_tabs', {}, false);
    expect(response?.structuredContent).toMatchObject({
      query: 'alpha',
      count: 1,
      totalMatches: 2,
      truncated: true,
      tabs: [{ tabId: 11, windowId: 1 }],
    });
  });

  it('leaves plain text on the coordinator dispatcher', async () => {
    const run = jest.fn(async () => result({})) as CommandRun;
    expect(dispatchPage(command('text', ['css:main']), run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves an inventory failure instead of converting it to an empty list', async () => {
    const failure = result({ error: 'browser unavailable' }, true);
    const run = jest.fn(async () => failure) as CommandRun;
    await expect(dispatchPage(command('tabs', ['alpha']), run)).resolves.toBe(failure);
  });

  it('routes --content to content-only markdown and honors max-chars', async () => {
    const run = jest.fn(async () => ({
      content: [{ type: 'text' as const, text: 'abcdef' }],
      isError: false,
    })) as CommandRun;
    const response = await dispatchPage(
      command('text', [], { content: true, 'max-chars': '4' }),
      run,
    );
    expect(run).toHaveBeenCalledWith('chrome_get_markdown', { fit: true });
    expect(response).toMatchObject({
      content: [{ type: 'text', text: 'abcd' }],
      structuredContent: { truncated: true, originalChars: 6 },
    });
  });

  it('routes links to chrome_page with the target and a bounded limit', async () => {
    const run = jest.fn(async () => result({ success: true })) as CommandRun;
    await dispatchPage(command('text', ['css:main'], { links: true, limit: '25' }), run);
    expect(run).toHaveBeenCalledWith('chrome_page', {
      action: 'text_links',
      selector: 'main',
      limit: 25,
    });
  });

  it('uses explicit IDs for window close and refuses it inside a task', async () => {
    const run = jest.fn(async () => result({ success: true })) as CommandRun;
    await dispatchPage(command('window close', ['42']), run);
    expect(run).toHaveBeenCalledWith(
      'chrome_page',
      { action: 'window_close', windowId: 42 },
      false,
    );

    expect(() => dispatchPage(command('window close', ['42'], { task: 'task-id' }), run)).toThrow(
      'cannot run inside a task',
    );
  });

  it('uses explicit IDs for group close and tab move', async () => {
    const run = jest.fn(async () => result({ success: true })) as CommandRun;
    await dispatchPage(command('group close', ['7']), run);
    await dispatchPage(command('tab move', ['12', '0'], { window: '3' }), run);
    expect(run).toHaveBeenNthCalledWith(1, 'chrome_tab_group_close', { groupId: 7 }, false);
    expect(run).toHaveBeenNthCalledWith(
      2,
      'chrome_page',
      { action: 'tab_move', tabId: 12, index: 0, windowId: 3 },
      false,
    );
  });

  it('routes scroll --until to the bounded scroll-until-found backend', async () => {
    const run = jest.fn(async () => result({ found: true })) as CommandRun;
    await dispatchPage(
      command('scroll', [], {
        until: 'Continue',
        up: true,
        max: '20',
        step: '400',
        timeout: '5000',
      }),
      run,
    );
    expect(run).toHaveBeenCalledWith('chrome_smart_scroll', {
      until: {
        query: 'Continue',
        direction: 'up',
        maxSteps: 20,
        stepPx: 400,
        timeoutMs: 5000,
      },
    });
  });
});
