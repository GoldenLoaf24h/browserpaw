import { describe, expect, it, jest, beforeAll, afterAll } from '@jest/globals';
import os from 'os';
import path from 'path';
import * as tokenModule from '../server/token';
if (!process.env.BROWSERPAW_HOME) {
  process.env.BROWSERPAW_HOME = path.join(os.tmpdir(), '.browserpaw-stdio-test');
}

// Emergency isolation gate: Mock Client.prototype.connect globally
// to prevent any test from hitting real port 12306 or network.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let globalOrigConnect: any = null;
beforeAll(() => {
  globalOrigConnect = Client.prototype.connect;
  jest.spyOn(tokenModule, 'readBridgeToken').mockReturnValue('a'.repeat(64));
  Client.prototype.connect = jest.fn().mockImplementation(async function (this: any) {
    return Promise.resolve();
  }) as any;
});

afterAll(() => {
  jest.restoreAllMocks();
  if (globalOrigConnect) {
    Client.prototype.connect = globalOrigConnect;
  }
});

import {
  setupTools,
  setMcpClientForTesting,
  resetMcpClientForTesting,
  getActiveMcpClient,
} from './mcp-server-stdio';

describe('mcp-server-stdio: BUG-18, BUG-19, and PERF-02', () => {
  it.each(['http://example.com/mcp', 'https://127.0.0.1/mcp', 'http://user@localhost/mcp'])(
    'rejects unsafe bridge URL %s before reading local credentials',
    async (url) => {
      const previous = process.env.MCP_SERVER_URL;
      const read = jest.mocked(tokenModule.readBridgeToken);
      const before = read.mock.calls.length;
      process.env.MCP_SERVER_URL = url;
      try {
        resetMcpClientForTesting();
        const { ensureMcpClient } = await import('./mcp-server-stdio');
        expect(await ensureMcpClient()).toBeNull();
        expect(read.mock.calls.length).toBe(before);
      } finally {
        if (previous === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = previous;
        resetMcpClientForTesting();
      }
    },
  );

  it('invalidates a rejected credential without replaying a write and rereads it on the next call', async () => {
    resetMcpClientForTesting();
    const handlers: Array<(req: any) => Promise<any>> = [];
    setupTools({
      setRequestHandler: (_schema: any, handler: any) => handlers.push(handler),
    } as any);
    const read = jest.mocked(tokenModule.readBridgeToken);
    const readsBefore = read.mock.calls.length;
    const call = jest
      .spyOn(Client.prototype, 'callTool')
      .mockRejectedValueOnce(new StreamableHTTPError(401, 'bridge token missing or invalid'))
      .mockResolvedValue({ content: [{ type: 'text', text: 'new credential accepted' }] });
    try {
      const failed = await handlers[1]({
        params: {
          name: 'chrome_interact_index',
          arguments: { tabId: 42, index: 1, action: 'click' },
        },
      });
      expect(failed.isError).toBe(true);
      expect(call).toHaveBeenCalledTimes(1);
      expect(getActiveMcpClient()).toBeNull();
      read.mockReturnValueOnce('b'.repeat(64));
      const next = await handlers[1]({ params: { name: 'get_windows_and_tabs', arguments: {} } });
      expect(next.isError).not.toBe(true);
      expect(call).toHaveBeenCalledTimes(2);
      expect(read.mock.calls.length).toBe(readsBefore + 2);
    } finally {
      call.mockRestore();
      await getActiveMcpClient()?.close();
      resetMcpClientForTesting();
    }
  });

  it('rereads credentials and retries a safe read once after HTTP 401', async () => {
    resetMcpClientForTesting();
    const handlers: Array<(req: any) => Promise<any>> = [];
    setupTools({
      setRequestHandler: (_schema: any, handler: any) => handlers.push(handler),
    } as any);
    const read = jest.mocked(tokenModule.readBridgeToken);
    const readsBefore = read.mock.calls.length;
    const call = jest
      .spyOn(Client.prototype, 'callTool')
      .mockRejectedValueOnce(new StreamableHTTPError(401, 'bridge token missing or invalid'))
      .mockResolvedValue({ content: [{ type: 'text', text: 'new credential accepted' }] });
    try {
      const result = await handlers[1]({ params: { name: 'get_windows_and_tabs', arguments: {} } });
      expect(result.isError).not.toBe(true);
      expect(call).toHaveBeenCalledTimes(2);
      expect(read.mock.calls.length).toBe(readsBefore + 2);
    } finally {
      call.mockRestore();
      await getActiveMcpClient()?.close();
      resetMcpClientForTesting();
    }
  });

  it('reads the credential again when establishing a replacement connection', async () => {
    const read = jest.mocked(tokenModule.readBridgeToken);
    const before = read.mock.calls.length;
    const { ensureMcpClient } = await import('./mcp-server-stdio');
    resetMcpClientForTesting();
    const first = await ensureMcpClient();
    read.mockReturnValueOnce('b'.repeat(64));
    resetMcpClientForTesting();
    const second = await ensureMcpClient();
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(read.mock.calls.length).toBe(before + 2);
    await first?.close();
    await second?.close();
    resetMcpClientForTesting();
  });

  it('BUG-19: does NOT blindly retry mutating tool on connection loss, returns unknown state error', async () => {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    const callHandler = Object.values(handlers)[1];
    expect(typeof callHandler).toBe('function');

    let callToolCount = 0;
    const mockClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        callToolCount++;
        const err: any = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(mockClient as any);

    try {
      const result = await callHandler({
        params: {
          name: 'chrome_interact_index',
          arguments: { index: 10, action: 'click' },
        },
      });

      // Mutating action should NOT have retried!
      expect(callToolCount).toBe(1);
      expect(result.isError).toBe(true);
      expect(
        result.content.some((item: any) =>
          /unknown|may have already been executed/i.test(item.text),
        ),
      ).toBe(true);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('BUG-19: DOES retry safe read-only tool once on connection loss', async () => {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    const callHandler = Object.values(handlers)[1];

    let callToolCount = 0;
    const mockClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        callToolCount++;
        if (callToolCount === 1) {
          const err: any = new Error('connection reset');
          err.code = 'ECONNRESET';
          throw err;
        }
        return { content: [{ type: 'text', text: 'markdown content ok' }] };
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(mockClient as any);

    try {
      // Tab-sensitive read_dom with explicit tabId is safe to retry across reconnect
      const result = await callHandler({
        params: {
          name: 'chrome_read_dom',
          arguments: { tabId: 101 },
        },
      });

      // Safe read-only tool should have retried once and succeeded
      expect(callToolCount).toBe(2);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('markdown content ok');
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('BUG-19: does NOT retry tab-sensitive read tool if tabId is missing (prevents falling back to foreground tab)', async () => {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    const callHandler = Object.values(handlers)[1];

    let callToolCount = 0;
    const mockClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        callToolCount++;
        const err: any = new Error('connection reset');
        err.code = 'ECONNRESET';
        throw err;
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(mockClient as any);

    try {
      // Calling read_dom WITHOUT tabId
      const result = await callHandler({
        params: {
          name: 'chrome_read_dom',
          arguments: {}, // Missing tabId
        },
      });

      // Must NOT retry without explicit target
      expect(callToolCount).toBe(1);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(
        /lacks an explicit valid "tabId"|risk reading the wrong foreground tab/i,
      );
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('BUG-19 (TOOL-02): chrome_read_dom with dismissOverlays:true is mutating and MUST NOT retry', async () => {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    const callHandler = Object.values(handlers)[1];

    let callToolCount = 0;
    const mockClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        callToolCount++;
        const err: any = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(mockClient as any);

    try {
      const result = await callHandler({
        params: {
          name: 'chrome_read_dom',
          arguments: { tabId: 101, dismissOverlays: true }, // Has mutating overlay click side effect!
        },
      });

      // Mutating overlay action must NOT have retried, execution count strictly 1
      expect(callToolCount).toBe(1);
      expect(result.isError).toBe(true);
      expect(
        result.content.some((item: any) =>
          /unknown|may have already been executed/i.test(item.text),
        ),
      ).toBe(true);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('BUG-19: chrome_console with clear:true or clearAfterRead:true is mutating and MUST NOT retry', async () => {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    const callHandler = Object.values(handlers)[1];

    let callToolCount = 0;
    const mockClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        callToolCount++;
        const err: any = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(mockClient as any);

    try {
      const result = await callHandler({
        params: {
          name: 'chrome_console',
          arguments: { tabId: 1, clear: true },
        },
      });

      expect(callToolCount).toBe(1);
      expect(result.isError).toBe(true);
      expect(
        result.content.some((item: any) =>
          /unknown|may have already been executed/i.test(item.text),
        ),
      ).toBe(true);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('BUG-19: performance_analyze_insight is excluded from safe read-only tools and MUST NOT retry', async () => {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    const callHandler = Object.values(handlers)[1];

    let callToolCount = 0;
    const mockClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        callToolCount++;
        const err: any = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(mockClient as any);

    try {
      const result = await callHandler({
        params: {
          name: 'performance_analyze_insight',
          arguments: { traceFilePath: 'trace.json' },
        },
      });

      expect(callToolCount).toBe(1);
      expect(result.isError).toBe(true);
      expect(
        result.content.some((item: any) =>
          /unknown|may have already been executed/i.test(item.text),
        ),
      ).toBe(true);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('BUG-19: chrome_tool_docs with activateForSession:true mutates session and MUST NOT retry; pure tool_docs retries', async () => {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    const callHandler = Object.values(handlers)[1];

    let callToolCount = 0;
    const mockClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        callToolCount++;
        if (callToolCount === 1) {
          const err: any = new Error('socket hang up');
          err.code = 'ECONNRESET';
          throw err;
        }
        return { content: [{ type: 'text', text: 'docs result' }] };
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(mockClient as any);

    try {
      // 1. Calling tool_docs with activateForSession: true -> must NOT retry (count === 1)
      callToolCount = 0;
      const activatingResult = await callHandler({
        params: {
          name: 'chrome_tool_docs',
          arguments: { category: 'manage', activateForSession: true },
        },
      });

      expect(callToolCount).toBe(1);
      expect(activatingResult.isError).toBe(true);
      expect(
        activatingResult.content.some((item: any) =>
          /unknown|may have already been executed/i.test(item.text),
        ),
      ).toBe(true);

      // 2. Calling pure tool_docs without activateForSession -> is safe read-only and retries (count === 2)
      callToolCount = 0;
      const pureResult = await callHandler({
        params: {
          name: 'chrome_tool_docs',
          arguments: { category: 'core' },
        },
      });

      expect(callToolCount).toBe(2);
      expect(pureResult.isError).toBeUndefined();
      expect(pureResult.content.some((item: any) => item.text.includes('docs result'))).toBe(true);
    } finally {
      ensureSpy.mockRestore();
    }
  });

  it('BUG-18: generational tracking guarantees stale failure does not close or nullify a newer client', async () => {
    const { ensureMcpClient, getMcpClientGeneration } = await import('./mcp-server-stdio');
    const activeClient = await ensureMcpClient();
    expect(activeClient).toBeDefined();
    const initialGen = getMcpClientGeneration();
    expect(initialGen).toBeGreaterThan(0);

    // Verify generation stays stable when reused
    const secondClient = await ensureMcpClient();
    expect(secondClient).toBe(activeClient);
    expect(getMcpClientGeneration()).toBe(initialGen);
  });

  it('BUG-18: late failure from request A does NOT invalidate or close newer client B', async () => {
    const {
      resetMcpClientForTesting,
      setMcpClientForTesting,
      getActiveMcpClient,
      getMcpClientGeneration,
    } = await import('./mcp-server-stdio');
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    const callHandler = Object.values(handlers)[1];

    // Client A that will fail late
    let triggerLateFailure: ((err: Error) => void) | null = null;
    const clientA: any = {
      callTool: jest.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            triggerLateFailure = (err) => reject(err);
          }),
      ),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    // Client B created subsequently
    const clientB: any = {
      callTool: jest
        .fn<() => Promise<any>>()
        .mockResolvedValue({ content: [{ type: 'text', text: 'B ok' }] }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    // Set Client A as initial generation 1
    setMcpClientForTesting(clientA, 1);

    try {
      // Step 1: Request A starts with Client A
      const promiseA = callHandler({
        params: { name: 'chrome_interact_index', arguments: { index: 1, action: 'click' } },
      });

      // Wait for Request A to acquire Client A
      await new Promise((r) => setTimeout(r, 20));
      expect(triggerLateFailure).not.toBeNull();

      // Step 2: Meanwhile, a reconnection event succeeds and establishes Client B at generation 2
      setMcpClientForTesting(clientB, 2);
      expect(getActiveMcpClient()).toBe(clientB);
      expect(getMcpClientGeneration()).toBe(2);

      // Step 3: Now trigger delayed connection error on Client A
      const connErr: any = new Error('socket hang up');
      connErr.code = 'ECONNRESET';
      triggerLateFailure!(connErr);

      const resA = await promiseA;
      expect(resA.isError).toBe(true);

      // Step 4: Verify Client A was closed, but Client B was NEVER closed or nullified!
      expect(getActiveMcpClient()).toBe(clientB);
      expect(getMcpClientGeneration()).toBe(2);
      expect(clientA.close).toHaveBeenCalledTimes(1);
      expect(clientB.close).not.toHaveBeenCalled();
    } finally {
      resetMcpClientForTesting();
    }
  });

  it('BUG-18: deduplicates concurrent connection attempts via single-flight connectingPromise', async () => {
    const { ensureMcpClient, resetMcpClientForTesting } = await import('./mcp-server-stdio');
    resetMcpClientForTesting();
    // If Client constructor or Streamable transport is imported, mock Client.connect
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

    let connectCallCount = 0;
    const origConnect = Client.prototype.connect;
    Client.prototype.connect = jest.fn().mockImplementation(async () => {
      connectCallCount++;
      await new Promise((r) => setTimeout(r, 20));
    }) as any;

    try {
      // Trigger 5 concurrent connection requests
      const [c1, c2, c3, c4, c5] = await Promise.all([
        ensureMcpClient(),
        ensureMcpClient(),
        ensureMcpClient(),
        ensureMcpClient(),
        ensureMcpClient(),
      ]);

      // Exactly one connect should have been initiated
      expect(connectCallCount).toBe(1);
      // All 5 should resolve to the exact same client instance
      expect(c1).toBeDefined();
      expect(c1).toBe(c2);
      expect(c2).toBe(c3);
      expect(c3).toBe(c4);
      expect(c4).toBe(c5);
    } finally {
      Client.prototype.connect = origConnect;
    }
  });

  it('PERF-02: reuses healthy client immediately without ping overhead', async () => {
    const { ensureMcpClient } = await import('./mcp-server-stdio');
    const activeClient = await ensureMcpClient();
    expect(activeClient).toBeDefined();

    // Mock ping on activeClient to observe if ensureMcpClient calls it
    const pingSpy = jest.spyOn(activeClient!, 'ping');
    try {
      const clientAgain = await ensureMcpClient();
      expect(clientAgain).toBe(activeClient);
      // Fast path: ping must NOT be invoked on healthy cached client
      expect(pingSpy).not.toHaveBeenCalled();
    } finally {
      pingSpy.mockRestore();
    }
  });

  it('BUG-18: initial invalid MCP URL / sync error clears connectingPromise and allows subsequent valid attempt to recover cleanly', async () => {
    const { ensureMcpClient, resetMcpClientForTesting } = await import('./mcp-server-stdio');
    resetMcpClientForTesting();

    // Mock Client.prototype.connect to fail on first attempt and succeed on second attempt
    let attempts = 0;
    const testConnectMock = jest.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Connection refused by simulated offline server');
      }
      return Promise.resolve();
    });
    const origConnect = Client.prototype.connect;
    Client.prototype.connect = testConnectMock as any;

    try {
      // 1. Initial attempt fails
      const failClient = await ensureMcpClient();
      expect(failClient).toBeNull();
      expect(attempts).toBe(1);

      // 2. Subsequent attempt recovers cleanly without getting stuck on poisoned connectingPromise
      const recoveredClient = await ensureMcpClient();
      expect(recoveredClient).toBeDefined();
      expect(recoveredClient).not.toBeNull();
      expect(attempts).toBe(2);
    } finally {
      Client.prototype.connect = origConnect;
      resetMcpClientForTesting();
    }
  });
});

describe('mcp-server-stdio: NEW-STDIO-SESSION-01 transport session recovery and discrimination', () => {
  const handlers: Record<string, (req: any) => Promise<any>> = {};
  let callHandler: (req: any) => Promise<any>;

  beforeAll(() => {
    const mockServer = {
      setRequestHandler: (schema: any, handler: any) => {
        const key =
          schema._def?.description || schema.name || 'handler_' + Object.keys(handlers).length;
        handlers[key] = handler;
      },
    };
    setupTools(mockServer as any);
    callHandler = Object.values(handlers)[1];
  });

  it('NEW-STDIO-SESSION-01: DOES retry safe read-only tool once when StreamableHTTPError 404 session occurs', async () => {
    let firstCallExecuted = false;
    let retryCallExecuted = false;

    const failingClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        firstCallExecuted = true;
        throw new StreamableHTTPError(404, 'Invalid or missing MCP session ID');
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const recoveredClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        retryCallExecuted = true;
        return { content: [{ type: 'text', text: 'Doctor checks pass' }], isError: false };
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    let callCount = 0;
    const ensureSpy = jest.spyOn(stdioModule, 'ensureMcpClient').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return failingClient as any;
      return recoveredClient as any;
    });

    try {
      setMcpClientForTesting(failingClient as any, 1);
      const result = await callHandler({
        params: {
          name: 'chrome_doctor',
          arguments: {},
        },
      });

      expect(firstCallExecuted).toBe(true);
      expect(retryCallExecuted).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('Doctor checks pass');
    } finally {
      ensureSpy.mockRestore();
      resetMcpClientForTesting();
    }
  });

  it('NEW-STDIO-SESSION-01: DOES retry safe read-only tool once when StreamableHTTPError 400 session error occurs', async () => {
    let retryCallExecuted = false;
    const failingClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        throw new StreamableHTTPError(400, 'Invalid SSE session');
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const recoveredClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        retryCallExecuted = true;
        return { content: [{ type: 'text', text: 'Doctor recovered' }], isError: false };
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    let callCount = 0;
    const ensureSpy = jest.spyOn(stdioModule, 'ensureMcpClient').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return failingClient as any;
      return recoveredClient as any;
    });

    try {
      setMcpClientForTesting(failingClient as any, 1);
      const result = await callHandler({
        params: {
          name: 'chrome_doctor',
          arguments: {},
        },
      });

      expect(retryCallExecuted).toBe(true);
      expect(result.isError).toBe(false);
    } finally {
      ensureSpy.mockRestore();
      resetMcpClientForTesting();
    }
  });

  it('NEW-STDIO-SESSION-01: does NOT retry generic 400, business 404, or 403 authorization errors', async () => {
    const makeMock = (err: any) => ({
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: (jest.fn() as any).mockRejectedValue(err),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    const nonRetryableErrors = [
      new Error('Element not found on page (404)'),
      new StreamableHTTPError(400, 'Bad Request: invalid parameter format'),
      new StreamableHTTPError(403, 'Forbidden host'),
    ];

    const stdioModule = await import('./mcp-server-stdio');

    for (const err of nonRetryableErrors) {
      const mockClient = makeMock(err);
      const ensureSpy = jest
        .spyOn(stdioModule, 'ensureMcpClient')
        .mockResolvedValue(mockClient as any);
      try {
        setMcpClientForTesting(mockClient as any, 1);
        const res = await callHandler({
          params: {
            name: 'chrome_doctor',
            arguments: {},
          },
        });

        // Should NOT retry: called exactly once
        expect(mockClient.callTool).toHaveBeenCalledTimes(1);
        expect(res.isError).toBe(true);
      } finally {
        ensureSpy.mockRestore();
        resetMcpClientForTesting();
      }
    }
  });

  it('NEW-STDIO-SESSION-01: does NOT retry mutating tool on 404 session loss, but invalidates stale client', async () => {
    const failingClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: (jest.fn() as any).mockRejectedValue(
        new StreamableHTTPError(404, 'Invalid or missing MCP session ID'),
      ),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(failingClient as any);

    try {
      setMcpClientForTesting(failingClient as any, 1);
      const result = await callHandler({
        params: {
          name: 'chrome_interact_index',
          arguments: { index: 1, action: 'click' },
        },
      });

      // Mutating tool must NOT retry
      expect(failingClient.callTool).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Automatic retry is aborted to protect state');
      // Crucial: stale client MUST have been invalidated (set to null) so subsequent calls are not poisoned
      expect(getActiveMcpClient()).toBeNull();
    } finally {
      ensureSpy.mockRestore();
      resetMcpClientForTesting();
    }
  });

  it('NEW-STDIO-SESSION-01: next call recovers cleanly with fresh client after mutating call 404 failure', async () => {
    const failingClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: (jest.fn() as any).mockRejectedValue(
        new StreamableHTTPError(404, 'Invalid or missing MCP session ID'),
      ),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const freshClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: (jest.fn() as any).mockResolvedValue({
        content: [{ type: 'text', text: 'Fresh call succeeded' }],
        isError: false,
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    let currentMock = failingClient;
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockImplementation(async () => currentMock as any);

    try {
      // Call 1: Mutating tool fails on 404 session error
      setMcpClientForTesting(failingClient as any, 1);
      const res1 = await callHandler({
        params: {
          name: 'chrome_interact_index',
          arguments: { index: 1, action: 'click' },
        },
      });
      expect(res1.isError).toBe(true);
      expect(getActiveMcpClient()).toBeNull();

      // Call 2: Next call happens; transport should now establish freshClient
      currentMock = freshClient;
      const res2 = await callHandler({
        params: {
          name: 'chrome_doctor',
          arguments: {},
        },
      });
      expect(res2.isError).toBe(false);
      expect(res2.content[0].text).toContain('Fresh call succeeded');
    } finally {
      ensureSpy.mockRestore();
      resetMcpClientForTesting();
    }
  });

  it('NEW-STDIO-SESSION-01: late 404 failure from stale generation does NOT nullify newer active client', async () => {
    const olderClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: jest.fn().mockImplementation(async () => {
        // Simulate delay
        await new Promise((r) => setTimeout(r, 20));
        throw new StreamableHTTPError(404, 'Invalid or missing MCP session ID');
      }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const newerClient = {
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      callTool: (jest.fn() as any).mockResolvedValue({ content: [], isError: false }),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const stdioModule = await import('./mcp-server-stdio');
    const ensureSpy = jest
      .spyOn(stdioModule, 'ensureMcpClient')
      .mockResolvedValue(olderClient as any);

    try {
      // Start older call with generation 1
      setMcpClientForTesting(olderClient as any, 1);
      const olderCallPromise = callHandler({
        params: {
          name: 'chrome_interact_index',
          arguments: { index: 5, action: 'click' },
        },
      });

      // Meanwhile, newer connection is established with generation 2
      setMcpClientForTesting(newerClient as any, 2);

      await olderCallPromise;

      // Generational fence: active client must STILL be newerClient (not wiped out by older failure)
      expect(getActiveMcpClient()).toBe(newerClient);
    } finally {
      ensureSpy.mockRestore();
      resetMcpClientForTesting();
    }
  });
});
