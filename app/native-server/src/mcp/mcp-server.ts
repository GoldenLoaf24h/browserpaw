import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

export function createMcpServerInstance(sessionId?: string): Server {
  const server = new Server(
    {
      name: 'BrowserPaw',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: {},
        prompts: {},
      },
    },
  );

  setupTools(server, sessionId);
  return server;
}

export let mcpServer: Server | null = null;

export const getMcpServer = () => {
  if (mcpServer) {
    return mcpServer;
  }
  mcpServer = createMcpServerInstance();
  return mcpServer;
};
