import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from 'chrome-mcp-shared';
import { parseCommand } from 'chrome-mcp-shared';
import { handleBrowserCall } from './browser-dispatch';
import { dispatchCommand } from './command-dispatch';
import { validateSavedRecipe } from './learned-recipes';

jest.mock('./browser-dispatch', () => ({
  handleBrowserCall: jest.fn(),
}));

const mockedBrowserCall = jest.mocked(handleBrowserCall);

function result(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError,
  };
}

describe('BrowserPaw CLI dispatch regressions', () => {
  let homeDir: string;
  let previousHome: string | undefined;

  it.each([
    { step: ['history', 'search', 'example.com'], name: 'history search' },
    { step: ['pdf', '--out', 'page.pdf'], name: 'pdf' },
    { step: ['screenshot', '--out=page.png'], name: 'screenshot' },
    { step: ['task', 'resume', '--adopt'], name: 'task resume' },
  ])('rejects $name at recipe save and batch dispatch', async ({ step, name }) => {
    const error = `Command ${name} is unavailable inside a batch.`;
    expect(() => validateSavedRecipe({ id: 'audit-recipe', steps: [step] })).toThrow(error);
    await expect(
      dispatchCommand(parseCommand(['batch', '-']), new AbortController().signal, [step]),
    ).rejects.toThrow(error);
    expect(mockedBrowserCall).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    previousHome = process.env.BROWSERPAW_HOME;
    homeDir = mkdtempSync(join(tmpdir(), 'browserpaw-dispatch-'));
    process.env.BROWSERPAW_HOME = homeDir;
    mockedBrowserCall.mockReset();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.BROWSERPAW_HOME;
    else process.env.BROWSERPAW_HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('requires task context and rejects a narrower tab or frame for task resume', async () => {
    const id = '01234567-89ab-4cde-8f01-23456789abcd';
    const resume = (...args: string[]) =>
      dispatchCommand(parseCommand(['task', 'resume', ...args]), new AbortController().signal);

    await expect(resume('--adopt')).rejects.toThrow('Select a task with --task ID.');
    for (const [option, value] of [['--tab', '12'], ['--frame', '0']]) {
      await expect(resume('--task', id, option, value, '--adopt')).rejects.toThrow(
        'Task resume applies to the whole task.',
      );
    }
    expect(mockedBrowserCall).not.toHaveBeenCalled();
  });

  it('passes network filters as requestUrlPattern without replacing the page URL', async () => {
    mockedBrowserCall.mockResolvedValueOnce(result({ success: true }));

    await dispatchCommand(
      parseCommand(['network', 'start', '--filter', 'api.example.com', '--tab', '12']),
      new AbortController().signal,
    );

    expect(mockedBrowserCall).toHaveBeenCalledWith(
      'chrome_network_capture',
      {
        action: 'start',
        needResponseBody: false,
        requestUrlPattern: 'api.example.com',
        tabId: 12,
      },
      'cli-tab:12',
      expect.any(AbortSignal),
    );
  });

  it('truncates Markdown text and reports the original character count', async () => {
    mockedBrowserCall.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'abcdef' }],
      isError: false,
    });

    const response = await dispatchCommand(
      parseCommand(['text', '--max-chars', '4', '--tab', '12']),
      new AbortController().signal,
    );

    expect(response.content).toEqual([{ type: 'text', text: 'abcd' }]);
    expect(response.structuredContent).toEqual({ truncated: true, originalChars: 6 });
  });

  it('truncates selector extraction data and preserves machine-readable metadata', async () => {
    mockedBrowserCall.mockResolvedValueOnce(
      result({
        success: true,
        extractedData: { text: 'abcdef' },
        results: [{ variableName: 'text', value: 'abcdef' }],
      }),
    );

    const response = await dispatchCommand(
      parseCommand(['text', 'css:h1', '--max-chars', '3', '--tab', '12']),
      new AbortController().signal,
    );

    expect(response.structuredContent).toMatchObject({
      extractedData: { text: 'abc' },
      results: [{ variableName: 'text', value: 'abc' }],
      truncated: true,
      originalChars: 6,
    });
    const content = response.content?.[0];
    expect(JSON.parse(String(content?.type === 'text' ? content.text : ''))).toMatchObject({
      extractedData: { text: 'abc' },
    });
  });

  it.each([{ options: [] }, { options: ['--content'] }])(
    'treats a JSON document as text $options',
    async ({ options }) => {
      const text = '{"fixture":"long text"}';
      mockedBrowserCall.mockResolvedValueOnce({ content: [{ type: 'text', text }] });
      const response = await dispatchCommand(
        parseCommand(['text', ...options, '--max-chars', '4', '--tab', '12']),
        new AbortController().signal,
      );
      expect(mockedBrowserCall.mock.lastCall?.[1]).toEqual({
        tabId: 12,
        ...(options.length ? { fit: true } : {}),
      });
      expect(response).toMatchObject({
        content: [{ type: 'text', text: text.slice(0, 4) }],
        structuredContent: { truncated: true, originalChars: text.length },
      });
    },
  );

  it('keeps caller tab context authoritative over legacy batch step options', async () => {
    mockedBrowserCall.mockResolvedValueOnce(result({ success: true }));

    await dispatchCommand(
      parseCommand(['batch', 'placeholder.json', '--tab', '7']),
      new AbortController().signal,
      [['click', 'css:#go', '--tab', '99']],
    );

    expect(mockedBrowserCall).toHaveBeenCalledWith(
      'chrome_batch_actions',
      {
        actions: [{ type: 'click', selector: '#go' }],
        tabId: 7,
      },
      'cli-tab:7',
      expect.any(AbortSignal),
    );
  });

  it('preserves actual receipts from completed steps when a direct batch fails', async () => {
    mockedBrowserCall
      .mockResolvedValueOnce(result({ success: true, text: 'first receipt' }))
      .mockResolvedValueOnce(result({ success: false, error: 'second failed' }, true));

    const response = await dispatchCommand(
      parseCommand(['batch', 'placeholder.json', '--tab', '7']),
      new AbortController().signal,
      [
        ['text', 'css:h1'],
        ['click', 'css:#missing'],
      ],
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent?.failedStepIndex).toBeUndefined();
    expect(response.structuredContent?.steps).toEqual([
      expect.objectContaining({
        command: 'text',
        result: expect.objectContaining({ content: expect.any(Array) }),
      }),
      expect.objectContaining({
        command: 'click',
        result: expect.objectContaining({ isError: true }),
      }),
    ]);
  });
});
