import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import nativeMessagingHostInstance from '../native-messaging-host';
import {
  filterToolSchemas,
  formatErrorForAgent,
  NativeMessageType,
  profileBlockedMessage,
  resolveToolProfile,
  TOOL_SCHEMAS,
  TOOL_CATEGORIES,
  TOOL_NAME_TO_CATEGORY,
  agentUpdateNotifier,
  normalizeIncomingToolName,
  alignToolReferences,
  getActiveToolPrefix,
  resolveToolName,
  getBaseToolName,
} from 'chrome-mcp-shared';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { mediaAssetStore } from '../media-asset-store';
import { getChromeMcpPort, SERVER_CONFIG } from '../constant';
import { FastDecisionEngine } from '../jev';
import { jevModelManager } from '../server/jev-model-manager';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export async function prepareMediaArgsIfNeeded(name: string, args: any): Promise<void> {
  if (name !== 'chrome_insert_media' || !args) return;
  let targetPath = args.filePath;
  if (
    !targetPath &&
    args.fileUrl &&
    typeof args.fileUrl === 'string' &&
    args.fileUrl.startsWith('file://')
  ) {
    try {
      targetPath = fileURLToPath(args.fileUrl);
    } catch {
      targetPath = args.fileUrl.replace(/^file:\/\/\/?/, '');
    }
  }
  if (!targetPath || args.base64Data || args.mediaUrl) return;

  try {
    const resolvedPath = path.resolve(targetPath);
    const stats = await fs.promises.stat(resolvedPath);
    if (!stats.isFile()) return;

    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.pdf': 'application/pdf',
    };
    const mimeType = args.mimeType || mimeTypes[ext] || 'application/octet-stream';
    const fileName = args.fileName || path.basename(resolvedPath);

    if (stats.size <= 650 * 1024) {
      const buffer = await fs.promises.readFile(resolvedPath);
      args.base64Data = buffer.toString('base64');
      args.fileName = fileName;
      args.mimeType = mimeType;
    } else if (stats.size <= 50 * 1024 * 1024) {
      const assetId = crypto.randomUUID();
      mediaAssetStore.set(assetId, {
        filePath: resolvedPath,
        mimeType,
        fileName,
      });
      const port = getChromeMcpPort();
      args.mediaUrl = `http://${SERVER_CONFIG.HOST}:${port}/media-asset/${assetId}`;
      args.fileName = fileName;
      args.mimeType = mimeType;
    }
  } catch {
    // If file cannot be read here, let extension try or report error
  }
}

// Resolved once at startup: changing the profile requires an MCP server restart.
const TOOL_PROFILE = resolveToolProfile(process.env.CHROME_MCP_TOOL_PROFILE);
const EXPOSED_TOOLS = filterToolSchemas(TOOL_SCHEMAS, TOOL_PROFILE);

const fastDecisionEngine = new FastDecisionEngine();

// Per-session dynamic tool activation store
const sessionExtraTools = new Map<string, Set<string>>();

export const clearSessionExtraTools = (sessionId: string): void => {
  sessionExtraTools.delete(sessionId);
};

export const setupTools = (server: Server, serverSessionId?: string) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const effectiveSessionId = serverSessionId || 'default';
    const extra = sessionExtraTools.get(effectiveSessionId);
    let tools = EXPOSED_TOOLS;
    if (extra && extra.size > 0) {
      tools = TOOL_SCHEMAS.filter(
        (t) => EXPOSED_TOOLS.some((e) => e.name === t.name) || extra.has(t.name),
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
    const rawArgs = (request.params.arguments || {}) as any;
    const args = {
      ...rawArgs,
      _meta: rawArgs._meta || (request.params as any)?._meta,
    };
    const sessionId = args?.sessionId || args?.sessionContext || serverSessionId;
    return handleToolCall(request.params.name, args, sessionId, server);
  });

  // List resources handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  // List prompts handler - REQUIRED BY MCP PROTOCOL
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
};

const handleToolCallInner = async (
  name: string,
  args: any,
  sessionId?: string,
  server?: Server,
): Promise<CallToolResult> => {
  try {
    const effectiveSessionId = sessionId || 'default';
    const normalized = normalizeIncomingToolName(name);
    const backendName = normalized.canonicalBackendName;
    const requestedPrefix = normalized.prefix || getActiveToolPrefix();

    const extra = sessionExtraTools.get(effectiveSessionId);
    let isAllowed =
      EXPOSED_TOOLS.some((t) => t.name === backendName) || (extra && extra.has(backendName));
    let autoActivatedCategory: string | undefined;

    if (!isAllowed) {
      const known = TOOL_SCHEMAS.some((t) => t.name === backendName);
      if (known) {
        const cat = TOOL_NAME_TO_CATEGORY[backendName];
        if (cat) {
          const catList = TOOL_CATEGORIES[cat] ? TOOL_CATEGORIES[cat].split(' ') : [];
          const set = sessionExtraTools.get(effectiveSessionId) || new Set<string>();
          for (const tName of catList) set.add(tName);
          sessionExtraTools.set(effectiveSessionId, set);
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
    if (!nativeMessagingHostInstance.isConnected) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error calling tool: Chrome extension is not connected to the native bridge host. Please open Chrome and ensure the Chrome MCP extension is loaded.',
          },
        ],
        isError: true,
      };
    }

    const alignResult = (res: CallToolResult): CallToolResult => {
      if (!res || !Array.isArray(res.content)) return res;
      for (const item of res.content) {
        if (item && item.type === 'text' && typeof item.text === 'string') {
          item.text = alignToolReferences(item.text, requestedPrefix);
        }
      }
      return res;
    };

    // Autonomous semantic micro-loop tool runs locally on Native Server
    if (backendName === 'chrome_act_toward_goal') {
      const activeMode = args?.mode || jevModelManager.getActiveMode();

      // 1. If Jev mode is off, intercept and prompt that explicit user authorization is required
      if (activeMode === 'off') {
        return {
          content: [
            {
              type: 'text',
              text: [
                `[Jev Authorization Required]`,
                `Autonomous semantic micro-loop (${resolveToolName('act_toward_goal', requestedPrefix)}) is currently disabled (mode: "off").`,
                `The agent must obtain explicit user authorization before enabling Jev (Local or Remote mode) in the BrowserPaw extension popup.`,
                `Remediation: Ask the user for permission to perform autonomous browser control. If granted, ask the user to switch Jev to "Local" or "Remote" in the extension popup. Otherwise, execute the task deterministically step-by-step using ${resolveToolName('read_dom', requestedPrefix)}, ${resolveToolName('interact_index', requestedPrefix)}, and ${resolveToolName('fill_index', requestedPrefix)}.`,
              ].join('\n'),
            },
          ],
          isError: true,
        };
      }

      // 2. Validate configuration (local weights downloaded or remote API key configured)
      const configValidation = await jevModelManager.validateConfiguration(activeMode);
      if (!configValidation.valid) {
        return {
          content: [
            {
              type: 'text',
              text: [
                `[Jev Configuration Error: ${configValidation.reason}]`,
                `Message: ${configValidation.message}`,
                configValidation.diagnostics ? `Diagnostics: ${configValidation.diagnostics}` : '',
                `Remediation: ${configValidation.remediation}`,
                `Do not silently fall back to heuristic. Please fix the configuration above or use standard deterministic tools (${resolveToolName('read_dom', requestedPrefix)}, ${resolveToolName('interact_index', requestedPrefix)}).`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
          isError: true,
        };
      }

      const actResult = await fastDecisionEngine.run(
        args,
        async (toolName: string, toolArgs: any) => {
          return callToolInternal(toolName, toolArgs, sessionId);
        },
        server,
      );

      let guidanceNote: string | undefined;
      if (actResult.fallbackReason === 'no_api_key' || actResult.engine === 'heuristic') {
        if (actResult.status === 'escalate') {
          const topCandidates = (actResult.currentElements || []).slice(0, 6).join('\n  ');
          guidanceNote = [
            `[System Guidance: Jev API Key not configured (running in local Heuristic fallback mode)]`,
            `The heuristic rule engine recommends handing over to deterministic execution.`,
            `Goal: "${args.goal || ''}"`,
            `Status: ${actResult.status} (Reason: ${actResult.reason || 'Heuristic rules require manual confirmation'})`,
            topCandidates
              ? `Current page interactive candidates are ready below — proceed directly without calling ${resolveToolName('read_dom')}:\n  ${topCandidates}`
              : `Current page elements are ready in the payload.`,
            `Next Step: Call ${resolveToolName('interact_index')}({ index: <N>, action: "click" }) or ${resolveToolName('fill_index')}({ index: <N>, text: "..." }) to continue.`,
          ].join('\n');
        } else if (actResult.status === 'done') {
          guidanceNote = `[System Guidance: Jev API Key not configured. Goal successfully completed via local Heuristic rule engine.]`;
        }
      }

      const result: CallToolResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(actResult, null, 2),
          },
        ],
        isError: false,
      };
      if (guidanceNote && result && Array.isArray(result.content)) {
        result.content.unshift({
          type: 'text',
          text: guidanceNote,
        });
      }
      if (autoActivatedCategory && result && Array.isArray(result.content)) {
        result.content.unshift({
          type: 'text',
          text: `[System Note: Tool category "${autoActivatedCategory}" has been dynamically unlocked for this session.]`,
        });
      }
      return alignResult(result);
    }

    // Dynamic activation hook for chrome_tool_docs
    if (backendName === 'chrome_tool_docs' && args?.activateForSession && args?.category) {
      const catList = TOOL_CATEGORIES[args.category]
        ? TOOL_CATEGORIES[args.category].split(' ')
        : [];
      if (catList.length > 0) {
        const set = sessionExtraTools.get(effectiveSessionId) || new Set<string>();
        for (const tName of catList) set.add(tName);
        sessionExtraTools.set(effectiveSessionId, set);
      }
      if (server && typeof (server as any).sendToolListChanged === 'function') {
        (server as any).sendToolListChanged().catch(() => {});
      }
    }

    await prepareMediaArgsIfNeeded(backendName, args);

    const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
      {
        name: backendName,
        args,
        sessionId,
      },
      NativeMessageType.CALL_TOOL,
      120000, // Extended to 120 seconds to prevent timeouts on long-running tasks like performance profiling
    );
    if (response.status === 'success') {
      const result = response.data;
      if (autoActivatedCategory && result && Array.isArray(result.content)) {
        result.content.unshift({
          type: 'text',
          text: `[System Note: Tool category "${autoActivatedCategory}" has been dynamically unlocked for this session.]`,
        });
      }
      return alignResult(result);
    } else {
      return {
        content: [
          {
            type: 'text',
            text: alignToolReferences(`Error calling tool: ${response.error}`, requestedPrefix),
          },
        ],
        isError: true,
      };
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: alignToolReferences(formatErrorForAgent(error, { context: 'Error calling tool' })),
        },
      ],
      isError: true,
    };
  }
};

export const handleToolCall = async (
  name: string,
  args: any,
  sessionId?: string,
  server?: Server,
): Promise<CallToolResult> => {
  // Preload local model and touch activity timer on any MCP tool invocation
  jevModelManager.onToolInvocation();

  // Concurrently initiate the single-turn update check to overlap latency with tool execution.
  // In unit test environment, bypass unmocked remote network calls unless explicitly enabled.
  const shouldCheckUpdate =
    process.env.NODE_ENV !== 'test' || process.env.ENABLE_MCP_VERSION_CHECK === 'true';
  const noticePromise = shouldCheckUpdate
    ? agentUpdateNotifier.maybeGetFirstCallNotice().catch(() => null)
    : Promise.resolve(null);
  const result = await handleToolCallInner(name, args, sessionId, server);
  try {
    const notice = await noticePromise;
    if (notice && result && Array.isArray(result.content)) {
      result.content.unshift({
        type: 'text',
        text: notice,
      });
    }
  } catch {
    // Non-blocking fallback to ensure tool call never fails due to update check
  }
  return result;
};

export const callToolInternal = async (
  name: string,
  args: any,
  sessionId?: string,
  timeoutMs = 120000,
): Promise<any> => {
  jevModelManager.onToolInvocation();
  await prepareMediaArgsIfNeeded(name, args);
  const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
    {
      name,
      args,
      sessionId,
    },
    NativeMessageType.CALL_TOOL,
    timeoutMs,
  );
  if (response.status === 'success') {
    return response.data;
  }
  throw new Error(response.error || `Error calling internal tool: ${name}`);
};
