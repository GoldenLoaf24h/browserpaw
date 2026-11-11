import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CORE_TOOL_NAMES, getToolDocumentation, TOOL_SCHEMAS } from 'chrome-mcp-shared';
import nativeHost from '../native-messaging-host';
import { jevModelManager } from '../server/jev-model-manager';
import { setupTools as setupNative, handleToolCall } from './register-tools';
import {
  setupTools as setupStdio,
  setMcpClientForTesting,
  resetMcpClientForTesting,
} from './mcp-server-stdio';

const servers: any[] = [];
function serverFor(setup: (server: any, id?: string) => void, id?: string) {
  const handlers = new Map();
  const server: any = {
    setRequestHandler: (schema: unknown, handler: unknown) => handlers.set(schema, handler),
    sendToolListChanged: jest.fn().mockResolvedValue(undefined),
  };
  setup(server, id);
  servers.push(server);
  return {
    server,
    call: (args: Record<string, unknown> = {}, name = 'chrome_tool_docs') =>
      handlers.get(CallToolRequestSchema)({ params: { name, arguments: args } }, {}),
    list: async () =>
      (await handlers.get(ListToolsRequestSchema)()).tools.map((tool: any) => tool.name),
  };
}

beforeEach(() => {
  jest.spyOn(jevModelManager, 'getActiveMode').mockReturnValue('off');
  jest.spyOn(jevModelManager, 'isAvailable').mockReturnValue(false);
});
afterEach(() => {
  for (const server of servers.splice(0)) server.onclose?.();
  nativeHost.isConnected = false;
  resetMcpClientForTesting();
  jest.restoreAllMocks();
});

describe.each(['Native', 'stdio'])('%s progressive discovery', (transport) => {
  function connect() {
    if (transport === 'stdio') {
      setMcpClientForTesting({
        callTool: ({ name, arguments: args }: any) => handleToolCall(name, args, 'downstream'),
      } as any);
    }
    return serverFor(transport === 'Native' ? setupNative : setupStdio, 'discovery');
  }

  it('keeps exactly nine tools within 26 KiB and works while Chrome is disconnected', async () => {
    const client = connect();
    expect((await client.list()).sort()).toEqual([...CORE_TOOL_NAMES].sort());
    const schemas = TOOL_SCHEMAS.filter((tool) => CORE_TOOL_NAMES.has(tool.name));
    expect(Buffer.byteLength(JSON.stringify(schemas), 'utf8')).toBeLessThanOrEqual(26 * 1024);
    for (const args of [{}, { category: 'act' }, { names: ['browserpaw_screenshot'] }]) {
      expect((await client.call(args)).isError).toBe(false);
    }
    expect(await client.list()).toHaveLength(9);
    expect(client.server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('rejects unknown tools without changing visibility', async () => {
    const client = connect();
    const result = await client.call({}, 'chrome_nonexistent');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('is not a BrowserPaw tool');
    expect(await client.list()).toHaveLength(9);
    expect(client.server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('replaces, deduplicates, and resets selections without notifying on equivalent lists', async () => {
    const client = connect();
    const choose = (names: string[]) => client.call({ names, activateForSession: true });
    await choose(['browserpaw_screenshot', 'chrome_screenshot']);
    expect(await client.list()).toContain('chrome_screenshot');
    await choose(['chrome_screenshot', 'chrome_read_dom']);
    expect(client.server.sendToolListChanged).toHaveBeenCalledTimes(1);
    await choose(['chrome_keyboard']);
    expect(await client.list()).not.toContain('chrome_screenshot');
    expect(await client.list()).toContain('chrome_keyboard');
    await choose([]);
    await choose([]);
    expect(await client.list()).toHaveLength(9);
    expect(client.server.sendToolListChanged).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid or legacy activation without a partial update', async () => {
    const client = connect();
    for (const args of [
      { names: ['chrome_screenshot', 'no_such_tool'], activateForSession: true },
      { names: ['chrome_screenshot'], category: 'act', activateForSession: true },
      { category: 'manage', activateForSession: true },
      { category: '__proto__' },
      { names: [4], activateForSession: true },
      { activateForSession: true },
    ])
      expect((await client.call(args)).isError).toBe(true);
    expect(await client.list()).toHaveLength(9);
    expect(client.server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('does not grow after 100 ordinary and hidden calls', async () => {
    const client = connect();
    nativeHost.isConnected = true;
    const send = jest.spyOn(nativeHost, 'sendRequestToExtensionAndWait').mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: 'read' }] },
    });
    for (let i = 0; i < 100; i++) {
      const result = await client.call(
        { tabId: 1 },
        i % 2 ? 'chrome_read_dom' : 'chrome_screenshot',
      );
      expect(result.isError).not.toBe(true);
    }
    expect(send).toHaveBeenCalledTimes(100);
    expect(await client.list()).toHaveLength(9);
    expect(client.server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('serializes selections and leaves Jev unavailable until configured', async () => {
    const client = connect();
    await Promise.all([
      client.call({ names: ['chrome_screenshot'], activateForSession: true }),
      client.call({ names: ['chrome_keyboard'], activateForSession: true }),
    ]);
    expect(await client.list()).toContain('chrome_keyboard');
    expect(await client.list()).not.toContain('chrome_screenshot');
    await client.call({ names: ['chrome_act_toward_goal'], activateForSession: true });
    expect(await client.list()).not.toContain('chrome_act_toward_goal');
    nativeHost.isConnected = true;
    expect((await client.call({ goal: 'do something' }, 'chrome_act_toward_goal')).isError).toBe(
      true,
    );
  });
});

it('keeps selections isolated and clears them when a Native session closes', async () => {
  const first = serverFor(setupNative, 'first');
  const second = serverFor(setupNative, 'second');
  await first.call({ names: ['chrome_screenshot'], activateForSession: true });
  expect(await second.list()).not.toContain('chrome_screenshot');
  first.server.onclose();
  const reopened = serverFor(setupNative, 'first');
  expect(await reopened.list()).not.toContain('chrome_screenshot');
});

it('updates stdio only after successful acknowledgement and survives failed selections', async () => {
  const client = serverFor(setupStdio);
  const call = jest
    .fn()
    .mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'denied' }] });
  setMcpClientForTesting({ callTool: call } as any);
  await client.call({ names: ['chrome_screenshot'], activateForSession: true });
  expect(await client.list()).not.toContain('chrome_screenshot');
  expect(client.server.sendToolListChanged).not.toHaveBeenCalled();
});

it('returns complete independent schemas, not shared mutable objects', () => {
  const docs = getToolDocumentation({ names: ['chrome_batch_actions'] });
  const value = JSON.parse((docs.result.content[0] as any).text);
  expect(value.tools[0].inputSchema.properties.actions.items.properties).toHaveProperty('type');
  value.tools[0].inputSchema.properties = {};
  expect(getToolDocumentation({ names: ['chrome_batch_actions'] }).result).toEqual(docs.result);
});

it('does not notify Native clients on Jev changes that leave the visible list unchanged', async () => {
  let changed!: () => void;
  jest.spyOn(jevModelManager, 'onModeStateChanged').mockImplementation((listener) => {
    changed = listener as () => void;
    return () => {};
  });
  const client = serverFor(setupNative, 'mode-change');
  changed();
  await client.call({ names: ['chrome_screenshot'], activateForSession: true });
  changed();
  expect(client.server.sendToolListChanged).toHaveBeenCalledTimes(1);
});

it('does not apply a late stdio acknowledgement after closing the session', async () => {
  let acknowledge!: (result: any) => void;
  setMcpClientForTesting({
    callTool: () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  } as any);
  const client = serverFor(setupStdio);
  const pending = client.call({ names: ['chrome_screenshot'], activateForSession: true });
  for (let i = 0; i < 20 && !acknowledge; i++) await Promise.resolve();
  expect(acknowledge).toBeDefined();
  client.server.onclose();
  acknowledge({ content: [] });
  await pending;
  expect(await client.list()).not.toContain('chrome_screenshot');
  expect(client.server.sendToolListChanged).not.toHaveBeenCalled();
});
