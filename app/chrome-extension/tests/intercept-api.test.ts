import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InterceptApiTool } from '../entrypoints/background/tools/browser/intercept-api';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

describe('InterceptApiTool (Structured API Sniffing)', () => {
  let tool: InterceptApiTool;

  beforeEach(() => {
    tool = new InterceptApiTool();
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
        query: vi.fn(async () => [{ id: 1, active: true, windowId: 1 }]),
      },
      debugger: {
        onEvent: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    };
  });

  it('rejects calls without urlPattern', async () => {
    const res = await tool.execute({ urlPattern: '' } as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('urlPattern is required');
  });

  it('intercepts live responses via CDP Network domain and decodes JSON', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method, params: any) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          return {
            body: JSON.stringify({ code: 200, items: [{ id: 1, name: 'Item A' }] }),
            base64Encoded: false,
          };
        }
        return {};
      },
    );

    let attachedListener: any;
    (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
      attachedListener = fn;
    });

    const execPromise = tool.execute({
      tabId: 1,
      urlPattern: '*/api/goods/list*',
      triggerAction: 'wait_next',
      timeoutMs: 1000,
    });

    // Simulate incoming network response event matching pattern
    setTimeout(() => {
      if (attachedListener) {
        attachedListener({ tabId: 1 }, 'Network.responseReceived', {
          requestId: 'req-123',
          response: {
            url: 'https://example.com/api/goods/list?page=1',
            status: 200,
            mimeType: 'application/json',
          },
        });
      }
    }, 50);

    const res = await execPromise;
    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.code).toBe(200);
    expect(parsed.data.items[0].name).toBe('Item A');
  });

  it('correctly decodes base64 UTF-8 multibyte JSON payloads without mojibake', async () => {
    const originalPayload = { message: '你好，世界！🚀 BrowserPaw', count: 42 };
    const jsonStr = JSON.stringify(originalPayload);
    const base64Str = Buffer.from(jsonStr, 'utf-8').toString('base64');

    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method, params: any) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          return {
            body: base64Str,
            base64Encoded: true,
          };
        }
        return {};
      },
    );

    let attachedListener: any;
    (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
      attachedListener = fn;
    });

    const execPromise = tool.execute({
      tabId: 1,
      urlPattern: '*/api/utf8*',
      triggerAction: 'wait_next',
      timeoutMs: 1000,
    });

    setTimeout(() => {
      if (attachedListener) {
        attachedListener({ tabId: 1 }, 'Network.responseReceived', {
          requestId: 'req-utf8',
          response: {
            url: 'https://example.com/api/utf8',
            status: 200,
            mimeType: 'application/json; charset=utf-8',
          },
        });
      }
    }, 50);

    const res = await execPromise;
    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.message).toBe('你好，世界！🚀 BrowserPaw');
    expect(parsed.data.count).toBe(42);
  });

  it('correctly matches multi-wildcard globs in urlPattern (e.g. */api/*/items*)', async () => {
    vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(
      async (_tabId, method, _params: any) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          return {
            body: JSON.stringify({ items: [1, 2, 3] }),
            base64Encoded: false,
          };
        }
        return {};
      },
    );

    let attachedListener: any;
    (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
      attachedListener = fn;
    });

    const execPromise = tool.execute({
      tabId: 1,
      urlPattern: '*/api/*/items*',
      triggerAction: 'wait_next',
      timeoutMs: 1000,
    });

    setTimeout(() => {
      if (attachedListener) {
        attachedListener({ tabId: 1 }, 'Network.responseReceived', {
          requestId: 'req-multi-wildcard',
          response: {
            url: 'https://example.com/api/v2/items?page=1',
            status: 200,
            mimeType: 'application/json',
          },
        });
      }
    }, 50);

    const res = await execPromise;
    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.items).toEqual([1, 2, 3]);
  });

  it('correctly matches path-style glob patterns without leading asterisk (e.g. /api/*/items)', () => {
    expect(
      (tool as any).matchesPattern('https://example.com/api/v1/items?page=1', '/api/*/items'),
    ).toBe(true);
    expect((tool as any).matchesPattern('https://example.com/api/v2/items', 'api/*/items')).toBe(
      true,
    );
    expect((tool as any).matchesPattern('https://example.com/api/v1/users', '/api/*/items')).toBe(
      false,
    );
    expect(
      (tool as any).matchesPattern('https://example.com/api/v1/items-not-matching', '/api/*/items'),
    ).toBe(false);
    expect(
      (tool as any).matchesPattern(
        'https://example.com/api/v1/items-not-matching',
        '*/api/*/items',
      ),
    ).toBe(false);
  });
});
