import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { PassThrough } from 'node:stream';
import * as http from 'node:http';
import { URL } from 'node:url';
import * as replModule from './repl';
import * as tokenModule from './server/token';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_SERVER_PORT } from 'chrome-mcp-shared';

describe('BrowserPaw Persistent REPL', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('resolveReplTargetUrl & parseStrictPort & assertLocalBridgeUrl', () => {
    it('defaults to 127.0.0.1:DEFAULT_SERVER_PORT/mcp when no env or override provided', () => {
      const origPort = process.env.CHROME_MCP_PORT;
      const origHttp = process.env.MCP_HTTP_PORT;
      delete process.env.CHROME_MCP_PORT;
      delete process.env.MCP_HTTP_PORT;
      try {
        const url = replModule.resolveReplTargetUrl();
        expect(url.toString()).toBe(`http://127.0.0.1:${DEFAULT_SERVER_PORT}/mcp`);
      } finally {
        if (origPort) process.env.CHROME_MCP_PORT = origPort;
        if (origHttp) process.env.MCP_HTTP_PORT = origHttp;
      }
    });

    it('honors valid integer overridePort parameter within loopback limits', () => {
      const url = replModule.resolveReplTargetUrl(9119);
      expect(url.toString()).toBe('http://127.0.0.1:9119/mcp');

      const urlStr = replModule.resolveReplTargetUrl('9120');
      expect(urlStr.toString()).toBe('http://127.0.0.1:9120/mcp');
    });

    it('rejects decimal numbers and non-numeric strings for port without swallowing via parseInt', () => {
      expect(() => replModule.resolveReplTargetUrl('123abc')).toThrow(
        'Invalid port: 123abc. Port must be an integer between 1 and 65535.',
      );
      expect(() => replModule.resolveReplTargetUrl('123.45')).toThrow(
        'Invalid port: 123.45. Port must be an integer between 1 and 65535.',
      );
      expect(() => replModule.resolveReplTargetUrl(123.45)).toThrow(
        'Invalid port: 123.45. Port must be an integer between 1 and 65535.',
      );
      expect(() => replModule.resolveReplTargetUrl(0)).toThrow('Invalid port: 0');
      expect(() => replModule.resolveReplTargetUrl(70000)).toThrow('Invalid port: 70000');
    });

    it('rejects corrupt port in environment variables without parseInt fallback', () => {
      const origPort = process.env.CHROME_MCP_PORT;
      process.env.CHROME_MCP_PORT = '999invalid';
      try {
        expect(() => replModule.resolveReplTargetUrl()).toThrow(
          'Invalid port in environment: "999invalid". Port must be an integer between 1 and 65535.',
        );
      } finally {
        if (origPort) process.env.CHROME_MCP_PORT = origPort;
        else delete process.env.CHROME_MCP_PORT;
      }
    });

    it('assertLocalBridgeUrl rejects credentials (user/pass), remote IPs, and non-http protocols', () => {
      expect(() =>
        replModule.assertLocalBridgeUrl(new URL('http://192.168.1.50:12306/mcp')),
      ).toThrow('BrowserPaw credentials may only be sent to a local HTTP bridge.');

      expect(() => replModule.assertLocalBridgeUrl(new URL('https://127.0.0.1:12306/mcp'))).toThrow(
        'BrowserPaw credentials may only be sent to a local HTTP bridge.',
      );

      expect(() =>
        replModule.assertLocalBridgeUrl(new URL('http://admin:secret@127.0.0.1:12306/mcp')),
      ).toThrow('BrowserPaw credentials may only be sent to a local HTTP bridge.');

      expect(() =>
        replModule.assertLocalBridgeUrl(new URL('http://127.0.0.1:12306/mcp')),
      ).not.toThrow();

      expect(() =>
        replModule.assertLocalBridgeUrl(new URL('http://localhost:12306/mcp')),
      ).not.toThrow();

      expect(() =>
        replModule.assertLocalBridgeUrl(new URL('http://[::1]:12306/mcp')),
      ).not.toThrow();
    });

    it('verifies configUrl reading from existing stdio-config.json and strict assertion against credentials', () => {
      const origPort = process.env.CHROME_MCP_PORT;
      const origHttp = process.env.MCP_HTTP_PORT;
      delete process.env.CHROME_MCP_PORT;
      delete process.env.MCP_HTTP_PORT;

      try {
        // Reads the real stdio-config.json in src/mcp/
        const url = replModule.resolveReplTargetUrl();
        expect(url.toString()).toBe('http://127.0.0.1:12306/mcp');

        // Confirm assertLocalBridgeUrl guards any config URL against embedded credentials
        expect(() =>
          replModule.assertLocalBridgeUrl(new URL('http://user:pass@127.0.0.1:12306/mcp')),
        ).toThrow('BrowserPaw credentials may only be sent to a local HTTP bridge.');
      } finally {
        if (origPort) process.env.CHROME_MCP_PORT = origPort;
        if (origHttp) process.env.MCP_HTTP_PORT = origHttp;
      }
    });
  });

  describe('Credential handling (zero-leak and read-only)', () => {
    it('throws immediately when bridge token is missing without creating new token', async () => {
      jest.spyOn(tokenModule, 'readBridgeToken').mockImplementation(() => {
        throw new Error('Bridge token not found or unreadable');
      });
      const initSpy = jest.spyOn(tokenModule, 'initializeBridgeToken');

      await expect(replModule.createReplMcpClient({ port: 12306 })).rejects.toThrow(
        'Bridge token not found or unreadable',
      );
      expect(initSpy).not.toHaveBeenCalled();
    });
  });

  describe('Mock Client Suite: Data contract & Error guarantees', () => {
    it('decodes the business payload despite category notes and preserves every raw block', async () => {
      const content = [
        {
          type: 'text',
          text: '[System Note: Tool category "diagnose" has been dynamically unlocked for this session.]',
        },
        { type: 'text', text: '{"healthy":true,"buildId":"paw-test"}' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      ];
      const fakeClient = {
        callTool: jest.fn<() => Promise<any>>().mockResolvedValue({ content }),
      } as unknown as Client;
      const { mcp } = await replModule.createReplMcpClient({ client: fakeClient });
      const result = await mcp.call('chrome_doctor', { verbose: true });
      expect(result.data).toEqual({ healthy: true, buildId: 'paw-test' });
      expect(result.content).toEqual(content);
      expect(result.text).toContain('[System Note:');
    });

    it('preserves raw CallToolResult properties (...raw, text, data) including _meta and structuredContent', async () => {
      const mockCallTool = jest.fn<() => Promise<any>>();
      const fakeClient = {
        callTool: mockCallTool,
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as Client;

      const { mcp } = await replModule.createReplMcpClient({ client: fakeClient });

      const rawResult = {
        content: [{ type: 'text', text: '{"count":42}' }],
        _meta: { latencyMs: 12, traceId: 'trace-abc' },
        structuredContent: { count: 42 },
        customField: 'preserved',
      };
      mockCallTool.mockResolvedValueOnce(rawResult);

      const res = await mcp.call('chrome_read_dom');
      expect(res.text).toBe('{"count":42}');
      expect(res.data).toEqual({ count: 42 });
      expect(res._meta).toEqual({ latencyMs: 12, traceId: 'trace-abc' });
      expect((res as any).structuredContent).toEqual({ count: 42 });
      expect((res as any).customField).toBe('preserved');
      expect(res.content).toHaveLength(1);
    });

    it('forwards an AbortSignal as MCP request options without inventing a cancel method', async () => {
      const mockCallTool = jest.fn<() => Promise<any>>().mockResolvedValue({
        content: [{ type: 'text', text: '{"ok":true}' }],
      });
      const fakeClient = {
        callTool: mockCallTool,
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as Client;
      const { mcp } = await replModule.createReplMcpClient({ client: fakeClient });
      const signal = new AbortController().signal;

      await mcp.call('chrome_skill', { action: 'validate', id: 'example-skill' }, { signal });

      expect(mockCallTool).toHaveBeenCalledWith(
        { name: 'chrome_skill', arguments: { action: 'validate', id: 'example-skill' } },
        undefined,
        { signal },
      );

      mockCallTool.mockClear();
      await mcp.skills.run('example-skill', { query: 'a' }, { signal });
      expect(mockCallTool).toHaveBeenCalledWith(
        {
          name: 'chrome_skill',
          arguments: { action: 'run', id: 'example-skill', inputs: { query: 'a' } },
        },
        undefined,
        { signal },
      );
      expect((mcp as any).cancel).toBeUndefined();
    });

    it('throws on isError: true without retrying or replaying mutating calls', async () => {
      const mockCallTool = jest.fn<() => Promise<any>>().mockResolvedValue({
        content: [{ type: 'text', text: 'Element not clickable at point (100, 200)' }],
        isError: true,
      });

      const fakeClient = {
        callTool: mockCallTool,
        close: jest.fn<() => Promise<void>>(),
      } as unknown as Client;

      const { mcp } = await replModule.createReplMcpClient({ client: fakeClient });

      await expect(
        mcp.call('chrome_interact_index', { index: 5, action: 'click' }),
      ).rejects.toThrow('Element not clickable at point (100, 200)');

      expect(mockCallTool).toHaveBeenCalledTimes(1);
    });

    it('throws on RPC error without retrying or replaying calls', async () => {
      const mockCallTool = jest
        .fn<() => Promise<any>>()
        .mockRejectedValue(new Error('RPC network failed'));
      const fakeClient = {
        callTool: mockCallTool,
        close: jest.fn<() => Promise<void>>(),
      } as unknown as Client;
      const { mcp } = await replModule.createReplMcpClient({ client: fakeClient });
      await expect(mcp.call('chrome_read_dom')).rejects.toThrow('RPC network failed');
      expect(mockCallTool).toHaveBeenCalledTimes(1);
    });

    it('returns full tool schema (list.tools) on demand for argument discovery', async () => {
      const toolSchemas = [
        {
          name: 'chrome_navigate',
          description: 'Navigate to URL',
          inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'Destination URL' } },
            required: ['url'],
          },
        },
        {
          name: 'chrome_read_dom',
          description: 'Read DOM tree',
          inputSchema: {
            type: 'object',
            properties: { deltaOnly: { type: 'boolean' } },
          },
        },
      ];
      const mockListTools = jest.fn<() => Promise<any>>().mockResolvedValue({
        tools: toolSchemas,
      });

      const fakeClient = {
        listTools: mockListTools,
        close: jest.fn<() => Promise<void>>(),
      } as unknown as Client;

      const { mcp } = await replModule.createReplMcpClient({ client: fakeClient });

      expect(typeof mcp.call).toBe('function');
      expect(typeof mcp.tools).toBe('function');
      expect(typeof mcp.notes).toBe('function');
      expect(mcp.task).toBeDefined();
      expect(mcp.skills).toBeDefined();
      expect(typeof mcp.help).toBe('function');

      expect(mockListTools).not.toHaveBeenCalled();

      const tools = await mcp.tools();
      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(tools).toEqual(toolSchemas);
      expect(tools[0].inputSchema?.properties).toBeDefined();
    });
  });

  describe('Connection and startRepl exception teardown (regression for review point 5)', () => {
    it('closes client if transport connection fails during createReplMcpClient', async () => {
      jest.spyOn(tokenModule, 'readBridgeToken').mockReturnValue('a'.repeat(64));
      const closeSpy = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

      // Spy on Client constructor prototype
      const origConnect = Client.prototype.connect;
      const origClose = Client.prototype.close;
      Client.prototype.connect = jest
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('Connection refused'));
      Client.prototype.close = closeSpy;

      try {
        await expect(replModule.createReplMcpClient({ port: 12306 })).rejects.toThrow(
          'Connection refused',
        );
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        Client.prototype.connect = origConnect;
        Client.prototype.close = origClose;
      }
    });

    it('closes client if startRepl encounters an error during startup/banner rendering', async () => {
      const mockClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const fakeClient = {
        close: mockClose,
      } as unknown as Client;

      const faultyOutput = new PassThrough();
      faultyOutput.write = () => {
        throw new Error('Broken stdout pipe');
      };

      await expect(
        replModule.startRepl({
          output: faultyOutput,
          client: fakeClient,
          silent: false, // will trigger write
        }),
      ).rejects.toThrow('Broken stdout pipe');

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Real HTTP Server & Real StreamableHTTPClientTransport: End-to-End Persistence', () => {
    let server: http.Server;
    let port: number;
    const testToken = 'a'.repeat(64);
    const requestsReceived: Array<{
      method: string;
      path: string;
      headers: http.IncomingHttpHeaders;
      body: any;
    }> = [];

    beforeEach(async () => {
      requestsReceived.length = 0;
      jest.spyOn(tokenModule, 'readBridgeToken').mockReturnValue(testToken);

      server = http.createServer((req, res) => {
        let rawBody = '';
        req.on('data', (chunk) => (rawBody += chunk));
        req.on('end', () => {
          let parsedBody: any = {};
          if (rawBody.trim().length > 0) {
            try {
              parsedBody = JSON.parse(rawBody);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }),
              );
              return;
            }
          }
          requestsReceived.push({
            method: req.method || 'GET',
            path: req.url || '/',
            headers: req.headers,
            body: parsedBody,
          });

          const auth = req.headers['authorization'];
          if (auth !== `Bearer ${testToken}`) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }

          const method = (parsedBody as any).method;
          const id = (parsedBody as any).id;

          if (method === 'initialize') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'mcp-session-id': 'persisted-session-1234',
            });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'real-mock-bridge', version: '1.0.0' },
                },
              }),
            );
          } else if (method === 'notifications/initialized') {
            res.writeHead(204);
            res.end();
          } else if (method === 'tools/call') {
            const toolName = (parsedBody as any).params?.name;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  content: [
                    { type: 'text', text: JSON.stringify({ executed: toolName, status: 'ok' }) },
                  ],
                  _meta: { executionSeq: requestsReceived.length },
                },
              }),
            );
          } else if (method === 'tools/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  tools: [
                    {
                      name: 'chrome_read_dom',
                      description: 'Read the DOM',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                },
              }),
            );
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as any;
          port = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('establishes real StreamableHTTPClientTransport connection and preserves session across calls', async () => {
      const { client, mcp } = await replModule.createReplMcpClient({ port });

      // Verify handshake request had valid Authorization header
      const initReq = requestsReceived.find((r) => r.body.method === 'initialize');
      expect(initReq).toBeDefined();
      expect(initReq?.headers['authorization']).toBe(`Bearer ${testToken}`);

      // Call 1
      const res1 = await mcp.call('chrome_navigate', { url: 'https://example.com' });
      expect(res1.data).toEqual({ executed: 'chrome_navigate', status: 'ok' });
      expect(res1._meta).toBeDefined();

      // Call 2
      const res2 = await mcp.call('chrome_read_dom');
      expect(res2.data).toEqual({ executed: 'chrome_read_dom', status: 'ok' });

      // Verify same session ID was preserved in subsequent requests
      const toolCalls = requestsReceived.filter((r) => r.body.method === 'tools/call');
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].headers['mcp-session-id']).toBe('persisted-session-1234');
      expect(toolCalls[1].headers['mcp-session-id']).toBe('persisted-session-1234');

      await client.close();
    });
  });

  describe('Real REPL Stream & stdin interaction with default Banner and zero-leak', () => {
    it('prints default banner without leaking token, persists variables, evaluates top-level await, and closes cleanly via .exit', async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let capturedOut = '';
      output.on('data', (c) => (capturedOut += c.toString()));

      const mockClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const fakeClient = {
        callTool: jest.fn<() => Promise<any>>().mockResolvedValue({
          content: [{ type: 'text', text: '42' }],
        }),
        close: mockClose,
      } as unknown as Client;

      const replServer = await replModule.startRepl({
        input,
        output,
        client: fakeClient,
        silent: false,
        terminal: false,
      });

      expect(replServer.context.browser).toBe(replServer.context.mcp);
      expect(replServer.context.browser.call).toBe(replServer.context.mcp.call);
      expect(replServer.context.browser.task).toBe(replServer.context.mcp.task);

      // 1. Verify Banner
      expect(capturedOut).toContain('BrowserPaw Persistent REPL');
      expect(capturedOut).toContain(
        'Note: Exiting closes the MCP session without closing browser tabs',
      );
      expect(capturedOut).not.toContain('bridge-token');
      expect(capturedOut).not.toMatch(/[a-f0-9]{48,64}/i);

      // 2. Real stdin stream multi-line variables and top-level await
      input.write('var testA = 100;\n');
      input.write('var testB = await Promise.resolve(testA + 23);\n');
      await new Promise((r) => setTimeout(r, 120));

      expect(replServer.context.testA).toBe(100);
      expect(replServer.context.testB).toBe(123);

      input.write('testB;\n');
      await new Promise((r) => setTimeout(r, 120));
      expect(capturedOut).toContain('123');

      // 3. User closes session via .exit
      input.write('.exit\n');
      await new Promise((r) => setTimeout(r, 100));

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('factory-owned session close', () => {
    const token = 'a'.repeat(64);
    type Seen = { method: string; headers: http.IncomingHttpHeaders; body: any };
    type DeleteMode = 'ok' | 'hang' | 'fail' | 'delay';

    async function listen(server: http.Server): Promise<number> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      return (server.address() as { port: number }).port;
    }

    function referencedClientSockets(port: number): number {
      return (
        (
          process as NodeJS.Process & { _getActiveHandles(): unknown[] }
        )._getActiveHandles() as Array<{
          constructor?: { name?: string };
          remotePort?: number;
          destroyed?: boolean;
          _handle?: { hasRef?: () => boolean };
        }>
      ).filter((handle) => {
        if (
          handle.constructor?.name !== 'Socket' ||
          handle.destroyed ||
          handle.remotePort !== port
        ) {
          return false;
        }
        return handle._handle?.hasRef ? handle._handle.hasRef() : true;
      }).length;
    }

    async function waitFor(ready: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 1000;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error(label);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    function startBridge(mode: DeleteMode): {
      port: Promise<number>;
      seen: Seen[];
      releaseDelete: () => void;
      stop: () => Promise<void>;
    } {
      const seen: Seen[] = [];
      const held: http.ServerResponse[] = [];
      let deleted = false;
      let releaseDelete = () => {};
      const deleteGate = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          void (async () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: any = {};
            if (raw.trim()) {
              try {
                body = JSON.parse(raw);
              } catch {
                body = {};
              }
            }
            seen.push({ method: req.method || '', headers: req.headers, body });
            if (req.headers.authorization !== `Bearer ${token}`) {
              res.writeHead(401);
              res.end();
              return;
            }
            if (req.method === 'DELETE') {
              deleted = true;
              for (const open of held.splice(0)) {
                if (!open.writableEnded) open.end();
              }
              if (mode === 'hang') {
                held.push(res);
                return;
              }
              if (mode === 'delay') await deleteGate;
              if (mode === 'fail') {
                res.writeHead(500);
                res.end('no');
                return;
              }
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end('{}');
              return;
            }
            if (deleted) {
              res.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
              res.end('{}');
              return;
            }
            if (req.method === 'GET') {
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'mcp-session-id': 'owned-session',
              });
              res.write(': open\n\n');
              held.push(res);
              return;
            }
            const method = body.method;
            const id = body.id;
            if (method === 'initialize') {
              res.writeHead(200, {
                'content-type': 'application/json',
                'mcp-session-id': 'owned-session',
              });
              res.end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'owned-close-bridge', version: '0' },
                  },
                }),
              );
              return;
            }
            if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
              res.writeHead(202);
              res.end();
              return;
            }
            if (method === 'tools/call') {
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'mcp-session-id': 'owned-session',
              });
              res.write(': open\n\n');
              held.push(res);
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
          })().catch(() => {
            if (!res.writableEnded) res.destroy();
          });
        });
      });
      return {
        port: listen(server),
        seen,
        releaseDelete,
        stop: async () => {
          releaseDelete();
          for (const open of held.splice(0)) open.destroy();
          server.closeAllConnections?.();
          if (server.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      };
    }

    beforeEach(() => {
      jest.spyOn(tokenModule, 'readBridgeToken').mockReturnValue(token);
    });

    it('does not wrap a client the caller owns', async () => {
      const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const client = { close } as unknown as Client;
      const created = await replModule.createReplMcpClient({ client });
      expect(created.client).toBe(client);
      expect(created.client.close).toBe(close);
      await created.client.close();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('DELETEs the owned session after an aborted SSE call and drops the socket', async () => {
      const bridge = startBridge('ok');
      const port = await bridge.port;
      try {
        const { client, mcp } = await replModule.createReplMcpClient({ port });
        const abort = new AbortController();
        const pending = mcp.call('chrome_batch_actions', { actions: [] }, { signal: abort.signal });
        await waitFor(
          () => bridge.seen.some((entry) => entry.body?.method === 'tools/call'),
          'tool call was not received',
        );
        abort.abort();
        await pending.catch(() => undefined);
        await client.close();
        const deadline = Date.now() + 4000;
        while (referencedClientSockets(port) !== 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(referencedClientSockets(port)).toBe(0);
        const deleted = bridge.seen.filter((entry) => entry.method === 'DELETE');
        expect(deleted).toHaveLength(1);
        expect(deleted[0].headers.authorization).toBe(`Bearer ${token}`);
        expect(deleted[0].headers['mcp-session-id']).toBe('owned-session');
      } finally {
        await bridge.stop();
      }
    });

    it('shares one in-flight close and does not DELETE twice', async () => {
      const bridge = startBridge('delay');
      const port = await bridge.port;
      try {
        const { client } = await replModule.createReplMcpClient({ port });
        const first = client.close();
        const second = client.close();
        expect(second).toBe(first);
        bridge.releaseDelete();
        await first;
        await client.close();
        expect(bridge.seen.filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
      } finally {
        await bridge.stop();
      }
    });

    it('bounds a hung DELETE at one second and still closes locally', async () => {
      const bridge = startBridge('hang');
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      const port = await bridge.port;
      try {
        const { client } = await replModule.createReplMcpClient({ port });
        const started = Date.now();
        await expect(client.close()).resolves.toBeUndefined();
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(1500);
        expect(bridge.seen.filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        await bridge.stop();
      }
    });

    it('does not fail close when DELETE is rejected', async () => {
      const bridge = startBridge('fail');
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      const port = await bridge.port;
      try {
        const { client } = await replModule.createReplMcpClient({ port });
        await expect(client.close()).resolves.toBeUndefined();
        expect(bridge.seen.filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        await bridge.stop();
      }
    });
  });
});
