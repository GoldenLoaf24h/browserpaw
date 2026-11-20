import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from 'chrome-mcp-shared';
import { parseCommand } from 'chrome-mcp-shared';
import { handleBrowserCall } from './browser-dispatch';
import { dispatchCommand } from './command-dispatch';

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
});
