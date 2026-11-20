import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import fetch from 'node-fetch';
import nativeHost from './native-messaging-host';
import { handleBrowserCall } from './browser-dispatch';
import { FileHandler, assertNotSensitivePath } from './file-handler';

jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const fetchMock = jest.mocked(fetch);
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('sensitive upload paths', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it.each([
    '~/.ssh/id_rsa',
    '/home/alice/.ssh/id_rsa',
    'C:\\Users\\Alice\\.ssh\\id_rsa',
    '~/.browserpaw/token',
    '/home/alice/.browserpaw/token',
    'C:\\Users\\Alice\\.browserpaw\\token',
  ])('blocks %s', (candidate) => {
    expect(() => assertNotSensitivePath(candidate)).toThrow(
      'Access to sensitive directories is prohibited',
    );
  });

  it('allows a normal temporary upload file', () => {
    const directory = temporaryDirectory('browserpaw-safe-upload-');
    const filePath = join(directory, 'document.txt');
    writeFileSync(filePath, 'safe');
    expect(() => assertNotSensitivePath(filePath)).not.toThrow();
  });

  it('rejects sensitive filePath and filePaths before dispatching chrome_upload_file', async () => {
    nativeHost.isConnected = true;
    const send = jest
      .spyOn(nativeHost, 'sendRequestToExtensionAndWait')
      .mockResolvedValue({ status: 'success', data: { content: [] } });
    const signal = new AbortController().signal;

    const direct = await handleBrowserCall(
      'chrome_upload_file',
      { selector: 'input[type=file]', filePath: '~/.ssh/id_rsa' },
      undefined,
      signal,
    );
    const multiple = await handleBrowserCall(
      'chrome_upload_file',
      {
        selector: 'input[type=file]',
        filePaths: [
          join(temporaryDirectory('browserpaw-upload-safe-'), 'safe.txt'),
          '~/.browserpaw/token',
        ],
      },
      undefined,
      signal,
    );

    expect(send).not.toHaveBeenCalled();
    expect(direct.structuredContent).toMatchObject({
      success: false,
      error: 'Access to sensitive directories is prohibited',
    });
    expect(multiple.structuredContent).toMatchObject({
      success: false,
      error: 'Access to sensitive directories is prohibited',
    });
  });

  it('enforces the same check in the native file verifier', async () => {
    const handler = new FileHandler({ tempDir: temporaryDirectory('browserpaw-verify-') });
    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      filePath: '~/.browserpaw/token',
    });
    expect(result).toMatchObject({
      success: false,
      error: 'Failed to verify file: Error: Access to sensitive directories is prohibited',
    });
  });
});

describe('bounded URL downloads', () => {
  it('aborts a stalled stream, cleans its partial file, and releases the write stream', async () => {
    jest.useFakeTimers();
    const directory = temporaryDirectory('browserpaw-download-');
    const handler = new FileHandler({ tempDir: directory });
    const body = new Readable({ read() {} });
    body.push(Buffer.from('partial'));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body,
    } as any);

    const resultPromise = handler.handleFileRequest({
      action: 'prepareFile',
      fileUrl: 'https://93.184.216.34/payload.bin',
      fileName: 'payload.bin',
    });
    await jest.advanceTimersByTimeAsync(30000);
    const result = await resultPromise;

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('Download timed out after 30000ms');
    expect(body.destroyed).toBe(true);
    expect(readdirSync(directory, { recursive: true }).map(String)).not.toContainEqual(
      expect.stringMatching(/payload\.bin$/),
    );
  });
});
