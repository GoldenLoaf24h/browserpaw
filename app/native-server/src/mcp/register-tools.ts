import { assertNotSensitivePath } from '../file-handler';
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
import { createBrowserServices } from '../browser-services';
import {
  assertSourceDownloadRequest,
  tryParseCallResult,
  verifySourceDownloadResult,
} from '../browser-tasks';

let browserServices: ReturnType<typeof createBrowserServices> | undefined;
function getBrowserServices() {
  return (browserServices ||= createBrowserServices((name, args, sessionId, signal) =>
    dispatchExtensionCall(name, args, sessionId, 120000, signal),
  ));
}

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
  if (!targetPath) return;

  assertNotSensitivePath(targetPath);

  if (args.base64Data || args.mediaUrl) return;

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

let cachedUpdateNotice: string | null = null;
let updateCheckStarted = false;

export const clearSessionExtraTools = (sessionId: string): void => {
  sessionExtraTools.delete(sessionId);
  if (nativeMessagingHostInstance.isConnected) {
    void nativeMessagingHostInstance
      .sendRequestToExtensionAndWait(
        { sessionId },
        NativeMessageType.RELEASE_SESSION_AFFINITY,
        1500,
      )
      .catch(() => {});
  }
};

export const setupTools = (server: Server, serverSessionId?: string) => {
  const stopModeNotifications = jevModelManager.onModeStateChanged(() => {
    void server.sendToolListChanged().catch(() => {});
  });
  const previousClose = server.onclose;
  server.onclose = () => {
    stopModeNotifications();
    previousClose?.();
  };
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
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const rawArgs = (request.params.arguments || {}) as any;
    const args = {
      ...rawArgs,
      _meta: rawArgs._meta || (request.params as any)?._meta,
    };
    // ARCH-03: Transport principal serverSessionId strictly takes precedence
    // over caller-supplied args to prevent spoofing another session's tools / tab affinity.
    const sessionId = serverSessionId || args?.sessionId || args?.sessionContext;
    if (serverSessionId) {
      args.sessionId = serverSessionId;
      if (args.sessionContext) {
        args.sessionContext = serverSessionId;
      }
    }
    // A disconnected request must not permanently cancel its recoverable task.
    return handleToolCall(request.params.name, args, sessionId, server, extra?.signal);
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
  signal?: AbortSignal,
): Promise<CallToolResult> => {
  try {
    if (signal?.aborted)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              status: 'cancelled',
              retry: false,
              dispatched: false,
            }),
          },
        ],
        isError: true,
      };
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
    if (backendName === 'chrome_task' || backendName === 'chrome_skill') {
      return await getBrowserServices().execute(backendName, args, sessionId, signal);
    }

    if (!nativeMessagingHostInstance.isConnected) {
      const failure = {
        success: false,
        status: 'blocked',
        retry: false,
        dispatched: false,
        error:
          'Chrome extension is not connected to the native bridge host. Please open Chrome and ensure BrowserPaw is loaded.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(failure) }],
        structuredContent: failure,
        isError: true,
      };
    }

    const alignResult = (res: CallToolResult): CallToolResult => {
      // Page data and source URLs are opaque; only generated tool documentation uses aliases.
      if (backendName !== 'chrome_tool_docs') return res;
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
      const activeMode = jevModelManager.getActiveMode();
      if (args?.mode && args.mode !== activeMode) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                status: 'blocked',
                dispatched: false,
                retry: false,
                reason: 'Requested model mode differs from the enabled backend',
              }),
            },
          ],
        };
      }

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
      const modeToken = jevModelManager.captureModeToken();
      const configValidation = await jevModelManager.validateConfiguration(activeMode);
      if (!configValidation.valid) {
        jevModelManager.disableIfCurrent(
          modeToken,
          configValidation.reason || 'invalid_configuration',
        );
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
        async (
          toolName: string,
          toolArgs: any,
          execution?: { signal?: AbortSignal; timeoutMs?: number },
        ) => {
          return callToolInternal(
            toolName,
            { ...toolArgs, ...(args.taskId ? { taskId: args.taskId } : {}) },
            sessionId,
            Math.min(120000, execution?.timeoutMs ?? 120000),
            execution?.signal ?? signal,
          );
        },
        server,
        { signal },
      );

      const result: CallToolResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(actResult, null, 2),
          },
        ],
        isError: false,
      };
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

    // ARCH-03: Consistently inject the resolved principal into both top-level parameter and args
    if (sessionId) {
      args.sessionId = sessionId;
      if (args.sessionContext) {
        args.sessionContext = sessionId;
      }
    }

    const result = await callToolInternal(backendName, args, sessionId, 120000, signal);
    if (autoActivatedCategory && result && Array.isArray(result.content)) {
      result.content.unshift({
        type: 'text',
        text: `[System Note: Tool category "${autoActivatedCategory}" has been dynamically unlocked for this session.]`,
      });
    }
    return alignResult(result);
  } catch (error: any) {
    if (typeof error?.requestDispatched === 'boolean') {
      const failure = {
        success: false,
        status: error.requestDispatched ? 'unknown' : 'blocked',
        retry: false,
        requestDispatched: error.requestDispatched,
        ...(error.requestDispatched ? {} : { dispatched: false }),
        error: alignToolReferences(formatErrorForAgent(error, { context: 'Error calling tool' })),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(failure) }],
        structuredContent: failure,
        isError: true,
      };
    }
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
  signal?: AbortSignal,
): Promise<CallToolResult> => {
  // Preload local model and touch activity timer on any MCP tool invocation
  jevModelManager.onToolInvocation();

  // PERF-01: Initiate update check in background completely out of critical path.
  // In unit test environment, bypass unmocked remote network calls unless explicitly enabled.
  const shouldCheckUpdate =
    process.env.NODE_ENV !== 'test' || process.env.ENABLE_MCP_VERSION_CHECK === 'true';
  if (shouldCheckUpdate && !updateCheckStarted) {
    updateCheckStarted = true;
    agentUpdateNotifier
      .maybeGetFirstCallNotice()
      .then((notice) => {
        if (notice) {
          cachedUpdateNotice = notice;
        }
      })
      .catch(() => {
        // Guarantee no unhandled rejection on network failures
      });
  }

  // Execute tool call immediately without awaiting update check
  const result = await handleToolCallInner(name, args, sessionId, server, signal);

  // If a cached update notice is ready, attach it without blocking
  if (cachedUpdateNotice && result && Array.isArray(result.content)) {
    result.content.unshift({
      type: 'text',
      text: cachedUpdateNotice,
    });
    cachedUpdateNotice = null; // Only prompt once per lifecycle
  }

  return result;
};

const dispatchExtensionCall = async (
  name: string,
  args: any,
  sessionId?: string,
  timeoutMs = 120000,
  signal?: AbortSignal,
): Promise<any> => {
  if (name === 'browserpaw_set_owned_viewport' || name === 'browserpaw_release_owned_page') {
    const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
      {
        ...args,
        ownership: 'owned',
        action: name === 'browserpaw_set_owned_viewport' ? 'viewport' : 'release',
      },
      NativeMessageType.TASK_PAGE_CONTROL,
      15000,
      signal,
    );
    if (response.status !== 'success')
      throw new Error(response.error || 'Task page control failed');
    return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
  }
  jevModelManager.onToolInvocation();
  await prepareMediaArgsIfNeeded(name, args);
  // ARCH-03: Consistently inject resolved principal into args in all internal caller paths
  if (sessionId) {
    args.sessionId = sessionId;
    if (args.sessionContext) {
      args.sessionContext = sessionId;
    }
  }
  const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
    {
      name,
      args,
      sessionId,
    },
    NativeMessageType.CALL_TOOL,
    name === 'chrome_handle_download'
      ? Math.max(timeoutMs, Math.min(Number(args.timeoutMs) || 60000, 300000) + 30000)
      : timeoutMs,
    signal,
  );
  if (response.status === 'success') {
    return response.data;
  }
  throw new Error(response.error || `Error calling internal tool: ${name}`);
};

export const callToolInternal = async (
  name: string,
  args: any,
  sessionId?: string,
  timeoutMs = 120000,
  signal?: AbortSignal,
): Promise<CallToolResult> => {
  if (typeof args?.taskId === 'string') {
    return getBrowserServices().tasks.callTool(args.taskId, name, args, sessionId, signal);
  }
  const sourceDownload =
    name === 'chrome_handle_download' &&
    ['tabId', 'guid', 'clickTargetIndex', 'frameId'].some((key) => args?.[key] !== undefined);
  if (sourceDownload) {
    const observation = await dispatchExtensionCall(
      'get_windows_and_tabs',
      {},
      sessionId,
      timeoutMs,
      signal,
    );
    if (observation.isError)
      throw Object.assign(new Error('Cannot verify download source capability'), {
        requestDispatched: false,
      });
    const inventory = tryParseCallResult(observation);
    const capabilities = inventory?.capabilities as { sourceDownloads?: boolean } | undefined;
    assertSourceDownloadRequest(args, capabilities?.sourceDownloads === true);
  }
  const result = await dispatchExtensionCall(name, args, sessionId, timeoutMs, signal);
  return sourceDownload ? verifySourceDownloadResult(args, result) : result;
};
