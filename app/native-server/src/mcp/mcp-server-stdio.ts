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
  normalizeIncomingToolName,
  alignToolReferences,
  getActiveToolPrefix,
  getBaseToolName,
} from 'chrome-mcp-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';
import { readBridgeToken } from '../server/token';
import { jevModelManager } from '../server/jev-model-manager';

let stdioMcpServer: Server | null = null;
let mcpClient: Client | null = null;
let mcpClientGeneration = 0;
let currentClientGeneration = 0;
let connectingPromise: Promise<{ client: Client | null; generation: number }> | null = null;
let connectionError: unknown = null;

export const getMcpClientGeneration = () => mcpClientGeneration;
export const getActiveMcpClient = () => mcpClient;
export const setMcpClientForTesting = (client: Client | null, generation = 0) => {
  mcpClient = client;
  mcpClientGeneration = generation;
};
export const resetMcpClientForTesting = () => {
  mcpClient = null;
  connectingPromise = null;
  currentClientGeneration = 0;
  mcpClientGeneration = 0;
  connectionError = null;
};

// Profile contract: resolved at startup (default is 'core', set CHROME_MCP_TOOL_PROFILE=full to expose all tools).
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

// BUG-18 & PERF-02: Single-flight connection promise, generational isolation, and fast-path reuse
export const ensureMcpClient = async (): Promise<Client | null> => {
  // Fast path (PERF-02): If an active healthy client already exists, reuse it without ping round-trip.
  if (mcpClient) {
    return mcpClient;
  }

  // Single-flight connecting promise (BUG-18): deduplicate concurrent calls
  if (connectingPromise) {
    const res = await connectingPromise;
    return res.client;
  }

  const thisGeneration = ++currentClientGeneration;
  let thisPromise: Promise<{ client: Client | null; generation: number }> | null = null;
  thisPromise = (async () => {
    let localClient: Client | null = null;
    try {
      const targetUrl = new URL(resolveTargetUrl());
      if (
        targetUrl.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(targetUrl.hostname) ||
        targetUrl.username ||
        targetUrl.password
      ) {
        throw new Error('BrowserPaw credentials may only be sent to a local HTTP bridge.');
      }
      const token = readBridgeToken();
      const headers = { Authorization: `Bearer ${token}` };
      localClient = new Client(
        { name: 'Mcp Chrome Proxy', version: '1.0.0' },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(targetUrl, {
        requestInit: { headers, redirect: 'error' },
      });
      await localClient.connect(transport);
      // Only publish to module-level mcpClient if this generation is still current
      if (currentClientGeneration === thisGeneration) {
        mcpClient = localClient;
        mcpClientGeneration = thisGeneration;
        connectionError = null;
      }
      return { client: localClient, generation: thisGeneration };
    } catch (error) {
      if (currentClientGeneration === thisGeneration) connectionError = error;
      try {
        await localClient?.close();
      } catch {}
      // Stale failure must never close or nullify a newer client generation
      if (mcpClient === localClient && mcpClientGeneration === thisGeneration) {
        mcpClient = null;
      }
      console.error('Failed to connect to MCP server:', error);
      return { client: null, generation: thisGeneration };
    } finally {
      // BUG-18: Only clear connectingPromise if it still points to this exact promise
      if (connectingPromise === thisPromise) {
        connectingPromise = null;
      }
    }
  })();
  connectingPromise = thisPromise;

  const res = await thisPromise;
  return res.client;
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
    let tools = EXPOSED_TOOLS;
    if (dynamicExtraTools.size > 0) {
      tools = TOOL_SCHEMAS.filter(
        (t) => EXPOSED_TOOLS.some((e) => e.name === t.name) || dynamicExtraTools.has(t.name),
      );
    }
    // Gating check: If Jev mode is 'off' or neither local nor remote is available, hide chrome_act_toward_goal
    const activeMode = jevModelManager.getActiveMode();
    if (activeMode === 'off' || !jevModelManager.isAvailable()) {
      tools = tools.filter((t) => getBaseToolName(t.name) !== 'act_toward_goal');
    }
    return { tools };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const normalized = normalizeIncomingToolName(name);
    const backendName = normalized.canonicalBackendName;
    const requestedPrefix = normalized.prefix || getActiveToolPrefix();

    let isAllowed =
      EXPOSED_TOOLS.some((t) => t.name === backendName) || dynamicExtraTools.has(backendName);
    let autoActivatedCategory: string | undefined;

    if (!isAllowed) {
      const known = TOOL_SCHEMAS.some((t) => t.name === backendName);
      if (known) {
        const cat = TOOL_NAME_TO_CATEGORY[backendName];
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
                ? profileBlockedMessage(backendName, TOOL_PROFILE)
                : `Tool "${name}" is not a BrowserPaw tool. Call tools/list to see the ${EXPOSED_TOOLS.length} available tools.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Dynamic activation hook for chrome_tool_docs
    if (
      backendName === 'chrome_tool_docs' &&
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

    const res = await handleToolCall(backendName, args);
    if (res && Array.isArray(res.content)) {
      for (const item of res.content) {
        if (item && item.type === 'text' && typeof item.text === 'string') {
          item.text = alignToolReferences(item.text, requestedPrefix);
        }
      }
      if (autoActivatedCategory) {
        res.content.unshift({
          type: 'text',
          text: `[System Note: Tool category "${autoActivatedCategory}" has been dynamically unlocked for this session.]`,
        });
      }
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
    (err instanceof StreamableHTTPError &&
      (err.code === 401 ||
        err.code === 404 ||
        (err.code === 400 && /invalid (or missing mcp session id|sse session)/i.test(msg)))) ||
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

// BUG-19: Strict conservative read-only categorization and explicit target verification.
// On reconnect, a new transport principal is established and previous TabAffinity is reset.
// Replaying tab-sensitive tools without an explicit tabId risks targeting the wrong tab (e.g. user foreground).
const GLOBAL_READ_ONLY_TOOLS = new Set([
  'get_windows_and_tabs',
  'chrome_history',
  'history',
  'chrome_bookmark_search',
  'bookmark_search',
  'chrome_tool_docs',
  'tool_docs',
  'chrome_doctor',
  'doctor',
]);

const TAB_SENSITIVE_READ_ONLY_TOOLS = new Set([
  'chrome_read_dom',
  'read_dom',
  'chrome_get_markdown',
  'get_markdown',
  'chrome_screenshot',
  'screenshot',
  'chrome_get_dropdown_options',
  'get_dropdown_options',
  'chrome_tab_group_list',
  'tab_group_list',
]);

export const isSafeReadOnlyCall = (toolName: string, args: any): boolean => {
  const baseName = getBaseToolName(toolName);
  const normalizedName = baseName.startsWith('chrome_') ? baseName : `chrome_${baseName}`;

  if (GLOBAL_READ_ONLY_TOOLS.has(baseName) || GLOBAL_READ_ONLY_TOOLS.has(normalizedName)) {
    // chrome_tool_docs with activateForSession alters session exposed tools; cannot safely retry
    if (normalizedName === 'chrome_tool_docs' || baseName === 'tool_docs') {
      if (args && Boolean(args.activateForSession)) {
        return false;
      }
    }
    return true;
  }

  if (
    TAB_SENSITIVE_READ_ONLY_TOOLS.has(baseName) ||
    TAB_SENSITIVE_READ_ONLY_TOOLS.has(normalizedName)
  ) {
    // Overlay dismissal on read_dom is mutating (TOOL-02)
    if (normalizedName === 'chrome_read_dom' || baseName === 'read_dom') {
      if (args && Boolean(args.dismissOverlays)) {
        return false;
      }
    }
    // W3 target stability: require explicit integer tabId so reconnect does not fallback to foreground tab
    const hasExplicitTabId =
      args && typeof args.tabId === 'number' && Number.isInteger(args.tabId) && args.tabId > 0;
    return Boolean(hasExplicitTabId);
  }

  return false;
};

const handleToolCall = async (name: string, args: any): Promise<CallToolResult> => {
  jevModelManager.onToolInvocation();
  const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;
  let callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
  if (getBaseToolName(name) === 'act_toward_goal' && args && typeof args === 'object') {
    const rawTimeout = Number(args.timeoutMs);
    if (Number.isFinite(rawTimeout) && rawTimeout > 0) {
      callTimeoutMs = Math.min(
        Math.max(DEFAULT_CALL_TIMEOUT_MS, Math.floor(rawTimeout) + 15_000),
        315_000,
      );
    }
  }

  let activeCallClient: Client | null = null;
  let activeCallGeneration = 0;

  const executeCall = async (): Promise<CallToolResult> => {
    const client = await ensureMcpClient();
    if (!client) {
      throw connectionError || new Error('Failed to connect to MCP server');
    }
    activeCallClient = client;
    activeCallGeneration = mcpClientGeneration;
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: callTimeoutMs,
    });
    return result as CallToolResult;
  };

  try {
    return await executeCall();
  } catch (error: any) {
    if (isConnectionError(error)) {
      console.warn(
        `[Stdio MCP] Connection lost during tool call (${error.message}). Invalidating client if still matching...`,
      );
      // BUG-18: Only invalidate global mcpClient if the active client identity and generation match!
      // A stale failed request must NEVER close or nullify a newer client created by a subsequent request.
      const clientToInvalidate = activeCallClient as Client | null;
      const generationToInvalidate: number = activeCallGeneration;

      if (mcpClient === clientToInvalidate && mcpClientGeneration === generationToInvalidate) {
        mcpClient = null;
      }
      try {
        await clientToInvalidate?.close();
      } catch {}

      // BUG-19: Do NOT automatically replay mutating tools when connection is lost.
      // Tools with side effects (or read_dom with dismissOverlays) must return unknown state error.
      if (!isSafeReadOnlyCall(name, args)) {
        const isTabSensitiveWithoutTarget =
          (TAB_SENSITIVE_READ_ONLY_TOOLS.has(name) ||
            TAB_SENSITIVE_READ_ONLY_TOOLS.has(getBaseToolName(name))) &&
          !(args && typeof args.tabId === 'number' && args.tabId > 0);
        const reason = isTabSensitiveWithoutTarget
          ? `Tool "${name}" is read-only but lacks an explicit valid "tabId". Upon reconnection, transport TabAffinity is reset; replaying without explicit target would risk reading the wrong foreground tab.`
          : `Tool "${name}" is mutating or has unverified side effects. The operation result is unknown and may have already been executed by the browser.`;

        return {
          content: [
            {
              type: 'text',
              text: `Connection lost during execution (${error.message}). ${reason} Automatic retry is aborted to protect state. Please inspect state and retry with explicit target if needed.`,
            },
          ],
          isError: true,
        };
      }

      // Safe read-only tools may retry once after re-establishing connection
      try {
        console.warn(`[Stdio MCP] Retrying safe read-only tool "${name}" after reconnect...`);
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

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error Chrome MCP Server main():', error);
    process.exit(1);
  });
}
