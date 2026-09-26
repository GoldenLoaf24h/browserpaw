#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  filterToolSchemas,
  profileBlockedMessage,
  resolveToolProfile,
  TOOL_SCHEMAS,
  TOOL_CATEGORIES,
  TOOL_NAME_TO_CATEGORY,
} from 'chrome-mcp-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';
import { resolveBridgeToken } from '../server/token';

let stdioMcpServer: Server | null = null;
let mcpClient: Client | null = null;

// Same profile contract as the HTTP server (register-tools.ts): resolved once
// at startup, full by default, CHROME_MCP_TOOL_PROFILE=core to trim to 26.
const TOOL_PROFILE = resolveToolProfile(process.env.CHROME_MCP_TOOL_PROFILE);
const EXPOSED_TOOLS = filterToolSchemas(TOOL_SCHEMAS, TOOL_PROFILE);

// Dynamic tool activation store for stdio session
const dynamicExtraTools = new Set<string>();

// Resolve MCP target URL from environment or configuration
const resolveTargetUrl = (): string => {
  if (process.env.MCP_SERVER_URL) {
    return process.env.MCP_SERVER_URL;
  }
  const host = process.env.CHROME_MCP_HOST || '127.0.0.1';
  const port = process.env.CHROME_MCP_PORT || process.env.MCP_HTTP_PORT;
  if (port) {
    return `http://${host}:${port}/mcp`;
  }
  try {
    const configPath = path.join(__dirname, 'stdio-config.json');
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(configData);
      if (parsed?.url) return parsed.url;
    }
  } catch {}
  return `http://${host}:12306/mcp`;
};

export const ensureMcpClient = async () => {
  try {
    if (mcpClient) {
      try {
        const pingResult = await mcpClient.ping();
        if (pingResult) {
          return mcpClient;
        }
      } catch {
        try {
          await mcpClient.close();
        } catch {}
        mcpClient = null;
      }
    }

    const targetUrl = resolveTargetUrl();
    const token = resolveBridgeToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    mcpClient = new Client({ name: 'Mcp Chrome Proxy', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(targetUrl), {
      requestInit: { headers },
    });
    await mcpClient.connect(transport);
    return mcpClient;
  } catch (error) {
    mcpClient?.close();
    mcpClient = null;
    console.error('Failed to connect to MCP server:', error);
  }
};

export const getStdioMcpServer = () => {
  if (stdioMcpServer) {
    return stdioMcpServer;
  }
  stdioMcpServer = new Server(
    {
      name: 'StdioChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  setupTools(stdioMcpServer);
  return stdioMcpServer;
};

export const setupTools = (server: Server) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (dynamicExtraTools.size === 0) return { tools: EXPOSED_TOOLS };
    const combined = TOOL_SCHEMAS.filter(
      (t) => EXPOSED_TOOLS.some((e) => e.name === t.name) || dynamicExtraTools.has(t.name),
    );
    return { tools: combined };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    let isAllowed = EXPOSED_TOOLS.some((t) => t.name === name) || dynamicExtraTools.has(name);
    let autoActivatedCategory: string | undefined;

    if (!isAllowed) {
      const known = TOOL_SCHEMAS.some((t) => t.name === name);
      if (known) {
        const cat = TOOL_NAME_TO_CATEGORY[name];
        if (cat) {
          const catList = TOOL_CATEGORIES[cat] ? TOOL_CATEGORIES[cat].split(' ') : [];
          for (const tName of catList) dynamicExtraTools.add(tName);
          autoActivatedCategory = cat;
          isAllowed = true;
          if (server && typeof (server as any).sendToolListChanged === 'function') {
            (server as any).sendToolListChanged().catch(() => {});
          }
        }
      }

      if (!isAllowed) {
        return {
          content: [
            {
              type: 'text',
              text: known
                ? profileBlockedMessage(name, TOOL_PROFILE)
                : `Tool "${name}" is not a BrowserPaw tool. Call tools/list to see the ${EXPOSED_TOOLS.length} available tools.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Dynamic activation hook for chrome_tool_docs
    if (
      name === 'chrome_tool_docs' &&
      (args as any)?.activateForSession &&
      (args as any)?.category
    ) {
      const cat = (args as any).category;
      const catList = TOOL_CATEGORIES[cat] ? TOOL_CATEGORIES[cat].split(' ') : [];
      for (const tName of catList) dynamicExtraTools.add(tName);
      if (server && typeof (server as any).sendToolListChanged === 'function') {
        (server as any).sendToolListChanged().catch(() => {});
      }
    }

    const res = await handleToolCall(name, args);
    if (autoActivatedCategory && res && Array.isArray(res.content)) {
      res.content.unshift({
        type: 'text',
        text: `[System Note: Tool category "${autoActivatedCategory}" has been dynamically unlocked for this session.]`,
      });
    }
    return res;
  });

  // List resources handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  // List prompts handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
};

const isConnectionError = (err: any): boolean => {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return (
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'epipe' ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('connection reset') ||
    msg.includes('connection refused') ||
    msg.includes('socket hang up') ||
    msg.includes('eof') ||
    msg.includes('closed') ||
    msg.includes('fetch failed')
  );
};

const handleToolCall = async (name: string, args: any): Promise<CallToolResult> => {
  const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;

  const executeCall = async (): Promise<CallToolResult> => {
    const client = await ensureMcpClient();
    if (!client) {
      throw new Error('Failed to connect to MCP server');
    }
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: DEFAULT_CALL_TIMEOUT_MS,
    });
    return result as CallToolResult;
  };

  try {
    return await executeCall();
  } catch (error: any) {
    if (isConnectionError(error)) {
      console.warn(
        `[Stdio MCP] Connection lost during tool call (${error.message}). Attempting auto-reconnect...`,
      );
      try {
        mcpClient?.close();
      } catch {}
      mcpClient = null;

      try {
        return await executeCall();
      } catch (retryErr: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error calling tool after reconnect retry: ${retryErr.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

let isExiting = false;
export async function triggerCleanExit(code = 0): Promise<void> {
  if (isExiting) return;
  isExiting = true;

  // Force exit timer capped at 800ms
  const forceTimer = setTimeout(() => {
    process.exit(code);
  }, 800);
  forceTimer.unref();

  // Teardown client and transport
  if (mcpClient) {
    try {
      await mcpClient.close();
    } catch {}
  }
  if (stdioMcpServer) {
    try {
      await stdioMcpServer.close();
    } catch {}
  }

  // Allow stdio streams to flush before exiting
  if (process.stdout.writableLength > 0 || process.stderr.writableLength > 0) {
    await new Promise<void>((resolve) => {
      let remaining = 2;
      const done = () => {
        if (--remaining <= 0) resolve();
      };
      process.stdout.write('', () => done());
      process.stderr.write('', () => done());
      setTimeout(resolve, 100);
    });
  }

  process.exit(code);
}

export function startParentWatchdog(parentPid: number): void {
  if (!parentPid || isNaN(parentPid)) return;
  const interval = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        triggerCleanExit(0);
      }
    }
  }, 500);
  interval.unref();
}

async function main() {
  // Listen for stdin EOF and close
  process.stdin.on('end', () => triggerCleanExit(0));
  process.stdin.on('close', () => triggerCleanExit(0));
  process.stdin.on('error', () => triggerCleanExit(0));

  // Process termination signals
  process.on('SIGINT', () => triggerCleanExit(0));
  process.on('SIGTERM', () => triggerCleanExit(0));
  process.on('SIGHUP', () => triggerCleanExit(0));

  // Check parent PID from args or env or default to process.ppid
  const parentPidArgIndex = process.argv.indexOf('--parent-pid');
  const parentPidVal =
    parentPidArgIndex !== -1 ? parseInt(process.argv[parentPidArgIndex + 1], 10) : undefined;
  const parentPid =
    parentPidVal ||
    (process.env.MCP_PARENT_PID ? parseInt(process.env.MCP_PARENT_PID, 10) : process.ppid);
  if (parentPid && parentPid > 1) {
    startParentWatchdog(parentPid);
  }

  const transport = new StdioServerTransport();
  await getStdioMcpServer().connect(transport);
}

main().catch((error) => {
  console.error('Fatal error Chrome MCP Server main():', error);
  process.exit(1);
});
