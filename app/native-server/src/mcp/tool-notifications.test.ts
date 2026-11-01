import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServerInstance } from './mcp-server';

jest.mock('./register-tools', () => ({ setupTools: jest.fn() }));

it('negotiates tool-list notifications with a real MCP client and delivers them', async () => {
  const server = createMcpServerInstance('notification-test');
  const client = new Client({ name: 'notification-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let delivered!: () => void;
  const notification = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    delivered();
  });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    await server.sendToolListChanged();
    await notification;
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
