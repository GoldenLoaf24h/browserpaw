import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { networkRequestTool } from '../entrypoints/background/tools/browser/network-request';
import * as nativeHostMod from '../entrypoints/background/native-host';
import * as fs from 'fs';
import * as path from 'path';

describe('P1-E01: Background pre-reads files for networkRequestTool FormData', () => {
  let ensureSpy: any;
  let sendFileSpy: any;
  let sendMsgSpy: any;
  let injectSpy: any;
  let resolveTabSpy: any;

  beforeEach(() => {
    vi.restoreAllMocks();

    ensureSpy = vi.spyOn(nativeHostMod, 'ensureNativeConnected').mockResolvedValue(true);
    sendFileSpy = vi.spyOn(nativeHostMod, 'sendFileOperationToNative');

    resolveTabSpy = vi
      .spyOn(networkRequestTool as any, 'resolveAffinityTab')
      .mockResolvedValue({ id: 10, url: 'https://example.com' });
    injectSpy = vi
      .spyOn(networkRequestTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    sendMsgSpy = vi
      .spyOn(networkRequestTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, response: { status: 200 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pre-reads local file in array-form formData via sendFileOperationToNative and replaces with base64', async () => {
    sendFileSpy.mockImplementation((msg: any, cb: any) => {
      expect(msg.type).toBe('file_operation');
      expect(msg.payload.action).toBe('readBase64File');
      expect(msg.payload.filePath).toBe('/temp/my-upload.txt');
      cb({
        payload: {
          success: true,
          base64Data: 'aGVsbG8gd29ybGQ=',
          fileName: 'my-upload.txt',
        },
      });
      return true;
    });

    const res = await networkRequestTool.execute({
      url: 'https://example.com/api/upload',
      method: 'POST',
      formData: [['file', 'file:/temp/my-upload.txt', 'custom-name.txt']],
    });

    expect(ensureSpy).toHaveBeenCalledWith('network_request_file');
    expect(sendFileSpy).toHaveBeenCalled();
    expect(sendMsgSpy).toHaveBeenCalledTimes(1);

    const sentPayload = sendMsgSpy.mock.calls[0][1];
    expect(sentPayload.formData).toEqual([['file', 'base64:aGVsbG8gd29ybGQ=', 'custom-name.txt']]);
    expect(res.isError).toBe(false);
  });

  it('pre-reads local file in object-form formData and replaces filePath with base64Data', async () => {
    sendFileSpy.mockImplementation((msg: any, cb: any) => {
      cb({
        payload: {
          success: true,
          base64Data: 'cGRmZGF0YQ==',
          fileName: 'report.pdf',
        },
      });
      return true;
    });

    const res = await networkRequestTool.execute({
      url: 'https://example.com/api/upload',
      method: 'POST',
      formData: {
        fields: { title: 'Report' },
        files: [{ name: 'attachment', filePath: '/temp/report.pdf' }],
      },
    });

    expect(sendFileSpy).toHaveBeenCalled();
    expect(sendMsgSpy).toHaveBeenCalledTimes(1);

    const sentPayload = sendMsgSpy.mock.calls[0][1];
    expect(sentPayload.formData.files[0]).toEqual({
      name: 'attachment',
      base64Data: 'cGRmZGF0YQ==',
      filename: 'report.pdf',
    });
    expect(sentPayload.formData.files[0].filePath).toBeUndefined();
    expect(res.isError).toBe(false);
  });

  it('fails tool call immediately when native file read fails, and never calls sendMessageToTab', async () => {
    sendFileSpy.mockImplementation((msg: any, cb: any) => {
      cb({
        payload: {
          success: false,
          error: 'Access denied: filePath must be strictly within the temp directory',
        },
      });
      return true;
    });

    const res = await networkRequestTool.execute({
      url: 'https://example.com/api/upload',
      method: 'POST',
      formData: [['file', 'file:/etc/passwd']],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Access denied');
    // CRITICAL: MUST NOT swallow failure and send request to tab
    expect(sendMsgSpy).not.toHaveBeenCalled();
  });

  it('fails tool call when native host is not connected and never calls sendMessageToTab', async () => {
    ensureSpy.mockResolvedValue(false);

    const res = await networkRequestTool.execute({
      url: 'https://example.com/api/upload',
      method: 'POST',
      formData: [['file', 'file:/temp/file.txt']],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Native host');
    expect(sendMsgSpy).not.toHaveBeenCalled();
  });

  it('verifies inject network-helper.js does not contain forward_to_native call', () => {
    const helperPath = path.resolve(__dirname, '../inject-scripts/network-helper.js');
    const content = fs.readFileSync(helperPath, 'utf-8');
    expect(content).not.toContain('forward_to_native');
    expect(content).not.toContain('readFileBase64');
  });

  it('pre-reads a 0-byte local file and forwards an empty base64 payload instead of failing', async () => {
    sendFileSpy.mockImplementation((msg: any, cb: any) => {
      cb({
        payload: { success: true, base64Data: '', fileName: 'empty.bin', size: 0 },
      });
      return true;
    });

    const res = await networkRequestTool.execute({
      url: 'https://example.com/api/upload',
      method: 'POST',
      formData: [['file', 'file:/temp/empty.bin']],
    });

    expect(res.isError).toBe(false);
    expect(sendMsgSpy).toHaveBeenCalledTimes(1);
    expect(sendMsgSpy.mock.calls[0][1].formData).toEqual([['file', 'base64:', 'empty.bin']]);
  });

  it('pre-reads a 0-byte file in object form without dropping the field', async () => {
    sendFileSpy.mockImplementation((msg: any, cb: any) => {
      cb({
        payload: { success: true, base64Data: '', fileName: 'empty.bin', size: 0 },
      });
      return true;
    });

    const res = await networkRequestTool.execute({
      url: 'https://example.com/api/upload',
      method: 'POST',
      formData: { fields: {}, files: [{ name: 'attachment', filePath: '/temp/empty.bin' }] },
    });

    expect(res.isError).toBe(false);
    expect(sendMsgSpy.mock.calls[0][1].formData.files[0]).toEqual({
      name: 'attachment',
      base64Data: '',
      filename: 'empty.bin',
    });
  });

  it('preserves extra top-level formData properties when pre-reading object-form files', async () => {
    sendFileSpy.mockImplementation((msg: any, cb: any) => {
      cb({ payload: { success: true, base64Data: 'QQ==', fileName: 'a.txt' } });
      return true;
    });

    await networkRequestTool.execute({
      url: 'https://example.com/api/upload',
      method: 'POST',
      formData: {
        fields: { title: 'Report' },
        files: [{ name: 'attachment', filePath: '/temp/a.txt' }],
        boundaryHint: 'keep-me',
      },
    });

    const sentFormData = sendMsgSpy.mock.calls[0][1].formData;
    expect(sentFormData.boundaryHint).toBe('keep-me');
    expect(sentFormData.fields).toEqual({ title: 'Report' });
    expect(sentFormData.files[0].base64Data).toBe('QQ==');
  });

  it('preserves non-object files entries instead of dropping them', async () => {
    await networkRequestTool.execute({
      url: 'https://example.com/api/upload',
      method: 'POST',
      formData: {
        fields: {},
        files: ['raw-entry', { name: 'attachment', base64Data: 'QQ==' }],
      },
    });

    expect(sendMsgSpy.mock.calls[0][1].formData.files).toEqual([
      'raw-entry',
      { name: 'attachment', base64Data: 'QQ==' },
    ]);
  });
});

describe('S-01: Injected network-helper FormData boundary tests', () => {
  let messageListener: any = null;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as any).__NETWORK_CAPTURE_HELPER_INITIALIZED__;
    messageListener = null;

    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((listener: any) => {
      messageListener = listener;
    });

    const helperPath = path.resolve(__dirname, '../inject-scripts/network-helper.js');
    const helperCode = fs.readFileSync(helperPath, 'utf-8');
    const runHelper = new Function('window', 'chrome', helperCode);
    runHelper(window, chrome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as any).__NETWORK_CAPTURE_HELPER_INITIALIZED__;
  });

  it('correctly appends 0-byte file, 16-byte file, normal fields, and avoids counterfeiting file on missing payload', async () => {
    let capturedOptions: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, options: any) => {
      capturedOptions = options;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    expect(typeof messageListener).toBe('function');

    const response = await new Promise<any>((resolve) => {
      const handled = messageListener(
        {
          action: 'sendPureNetworkRequest',
          url: 'https://example.com/api/upload',
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data' },
          formData: {
            fields: { username: 'alice', note: 'boundary-check' },
            files: [
              {
                name: 'emptyFile',
                base64Data: '',
                filename: 'zero.txt',
                contentType: 'text/plain',
              },
              {
                name: 'file16b',
                base64Data: 'MDEyMzQ1Njc4OWFiY2RlZg==',
                filename: 'sixteen.bin',
                contentType: 'application/octet-stream',
              },
              {
                name: 'missingPayloadFile',
                filename: 'missing.bin',
              },
              {
                name: 'nullPayloadFile',
                base64Data: null,
                filename: 'null.bin',
              },
            ],
          },
        },
        {},
        resolve,
      );
      expect(handled).toBe(true);
    });

    expect(response.success).toBe(true);
    const fd = capturedOptions?.body as FormData;
    expect(fd).toBeInstanceOf(FormData);

    expect(fd.get('username')).toBe('alice');
    expect(fd.get('note')).toBe('boundary-check');

    expect(fd.has('missingPayloadFile')).toBe(false);
    expect(fd.get('missingPayloadFile')).toBeNull();
    expect(fd.has('nullPayloadFile')).toBe(false);
    expect(fd.get('nullPayloadFile')).toBeNull();

    expect(fd.has('file16b')).toBe(true);
    const file16 = fd.get('file16b') as any;
    expect(file16).toBeInstanceOf(Blob);
    expect(file16.size).toBe(16);
    expect(file16.name).toBe('sixteen.bin');
    expect(file16.type).toBe('application/octet-stream');

    expect(fd.has('emptyFile')).toBe(true);
    const emptyFile = fd.get('emptyFile') as any;
    expect(emptyFile).toBeInstanceOf(Blob);
    expect(emptyFile.size).toBe(0);
    expect(emptyFile.name).toBe('zero.txt');
    expect(emptyFile.type).toBe('text/plain');
  });

  it('correctly handles array-form formData with 0-byte base64 and ordinary fields', async () => {
    let capturedOptions: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, options: any) => {
      capturedOptions = options;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await new Promise<any>((resolve) => {
      messageListener(
        {
          action: 'sendPureNetworkRequest',
          url: 'https://example.com/api/upload',
          method: 'POST',
          formData: [
            ['field1', 'hello'],
            ['emptyArrayFile', 'base64:', 'empty-arr.bin'],
            ['file16', 'base64:MDEyMzQ1Njc4OWFiY2RlZg==', 'sixteen.bin'],
          ],
        },
        {},
        resolve,
      );
    });

    const fd = capturedOptions?.body as FormData;
    expect(fd.get('field1')).toBe('hello');
    expect(fd.has('emptyArrayFile')).toBe(true);
    expect((fd.get('emptyArrayFile') as any).size).toBe(0);
    expect((fd.get('emptyArrayFile') as any).name).toBe('empty-arr.bin');
    expect(fd.has('file16')).toBe(true);
    expect((fd.get('file16') as any).size).toBe(16);
  });
});
