import { afterEach, describe, expect, it, jest } from '@jest/globals';
import nativeHost from '../native-messaging-host';
import { handleToolCall } from './register-tools';

describe('tool aliases preserve browser result data', () => {
  afterEach(() => {
    nativeHost.isConnected = false;
    jest.restoreAllMocks();
  });

  it.each(['chrome_read_dom', 'browserpaw_read_dom'])(
    'preserves page text, source URLs, non-text content and structured data for %s',
    async (name) => {
      const payload = {
        text: 'Documenting browserpaw_read_dom and chrome_read_dom exactly as written.',
        source: 'https://example.com/browserpaw_examples/chrome_reference',
      };
      const encoded = JSON.stringify(payload);
      const image = { type: 'image' as const, mimeType: 'image/png', data: 'AA==' };
      nativeHost.isConnected = true;
      const send = jest.spyOn(nativeHost, 'sendRequestToExtensionAndWait').mockResolvedValue({
        status: 'success',
        data: { content: [{ type: 'text', text: encoded }, image], structuredContent: payload },
      });
      const result = await handleToolCall(name, { tabId: 1 }, `fidelity-${name}`);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].name).toBe('chrome_read_dom');
      expect(
        result.content.filter((item) => item.type === 'text').some((item) => item.text === encoded),
      ).toBe(true);
      expect(result.content).toContainEqual(image);
      expect(result.structuredContent).toEqual(payload);
    },
  );

  it('renders tool-owned schemas locally and aligns their namespace', async () => {
    const send = jest.spyOn(nativeHost, 'sendRequestToExtensionAndWait');
    const result = await handleToolCall(
      'browserpaw_tool_docs',
      { names: ['chrome_read_dom'] },
      'fidelity-owned-docs',
    );
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('');
    expect(text).toContain('browserpaw_read_dom');
    expect(JSON.parse(text).tools[0].inputSchema).toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves an uncertain failure receipt and its original error text', async () => {
    const payload = {
      success: false,
      status: 'unknown',
      retry: false,
      error: 'Page operation browserpaw_read_dom returned chrome_error',
      receipt: { source: 'https://example.com/browserpaw_reference', requestDispatched: true },
    };
    const encoded = JSON.stringify(payload);
    nativeHost.isConnected = true;
    jest.spyOn(nativeHost, 'sendRequestToExtensionAndWait').mockResolvedValue({
      status: 'success',
      data: {
        content: [{ type: 'text', text: encoded }],
        structuredContent: payload,
        isError: true,
      },
    });
    const result = await handleToolCall('browserpaw_javascript', {}, 'fidelity-unknown');
    expect(result.isError).toBe(true);
    expect(result.content.some((item) => item.type === 'text' && item.text === encoded)).toBe(true);
    expect(result.structuredContent).toEqual(payload);
  });
});
