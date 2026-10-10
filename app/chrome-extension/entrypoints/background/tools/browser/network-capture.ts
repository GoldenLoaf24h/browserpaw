import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { networkCaptureStartTool, networkCaptureStopTool } from './network-capture-web-request';
import { networkDebuggerStartTool, networkDebuggerStopTool } from './network-capture-debugger';

type NetworkCaptureBackend = 'webRequest' | 'debugger';

interface NetworkCaptureToolParams {
  action: 'start' | 'stop';
  needResponseBody?: boolean;
  url?: string;
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
  maxCaptureTime?: number;
  inactivityTimeout?: number;
  includeStatic?: boolean;
}

/**
 * Extract text content from ToolResult
 */
function getFirstText(result: ToolResult): string | undefined {
  const first = result.content?.[0];
  return first && first.type === 'text' ? first.text : undefined;
}

/**
 * Decorate JSON result with additional fields
 */
function decorateJsonResult(result: ToolResult, extra: Record<string, unknown>): ToolResult {
  const text = getFirstText(result);
  if (typeof text !== 'string') return result;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify({ ...parsed, ...extra }) }],
      };
    }
  } catch {
    // If the underlying tool didn't return JSON, keep it as-is
  }
  return result;
}

function isDebuggerCaptureActiveOnTab(tabId: number): boolean {
  const captureData = (
    networkDebuggerStartTool as unknown as { captureData?: Map<number, unknown> }
  ).captureData;
  return captureData instanceof Map && captureData.has(tabId);
}

function isWebRequestCaptureActiveOnTab(tabId: number): boolean {
  return networkCaptureStartTool.captureData.has(tabId);
}

const tabCaptureSessions = new Map<number, string>();

/**
 * Unified Network Capture Tool
 *
 * Provides a single entry point for network capture, automatically selecting
 * the appropriate backend based on the `needResponseBody` parameter:
 * - needResponseBody=false (default): uses webRequest API (lightweight, no debugger conflict)
 * - needResponseBody=true: uses Debugger API (captures response body, may conflict with DevTools)
 */
class NetworkCaptureTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_CAPTURE;

  async execute(args: NetworkCaptureToolParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'start' && action !== 'stop') {
      return createErrorResponse('Parameter [action] is required and must be one of: start, stop');
    }

    const wantBody = args?.needResponseBody === true;

    if (action === 'start') {
      return this.handleStart(args, wantBody);
    }

    return this.handleStop(args);
  }

  private async handleStart(
    args: NetworkCaptureToolParams,
    wantBody: boolean,
  ): Promise<ToolResult> {
    const sessionId = args?.sessionId || args?.sessionContext;
    let targetTab: chrome.tabs.Tab;
    try {
      if (typeof args?.tabId === 'number') {
        const t = await this.tryGetTab(args.tabId, sessionId);
        if (!t || !t.id) return createErrorResponse(`Tab ${args.tabId} not found.`);
        targetTab = t;
      } else {
        targetTab = await this.resolveAffinityTab({ tabId: args?.tabId, sessionId });
      }
    } catch (e: any) {
      return createErrorResponse('Failed to resolve target tab: ' + (e?.message || e));
    }

    const tabId = targetTab.id;
    if (typeof tabId !== 'number') {
      return createErrorResponse('Invalid target tab ID');
    }

    const debuggerOnTab = isDebuggerCaptureActiveOnTab(tabId);
    const webOnTab = isWebRequestCaptureActiveOnTab(tabId);

    if (debuggerOnTab || webOnTab) {
      const activeMode = debuggerOnTab ? 'debugger' : 'webRequest';
      return createErrorResponse(
        `Network capture is already active on tab ${tabId} in ${activeMode} mode. Stop it before starting a new capture.`,
      );
    }

    const delegate = wantBody ? networkDebuggerStartTool : networkCaptureStartTool;
    const backend: NetworkCaptureBackend = wantBody ? 'debugger' : 'webRequest';

    const result = await delegate.execute({
      url: args.url,
      tabId,
      maxCaptureTime: args.maxCaptureTime,
      inactivityTimeout: args.inactivityTimeout,
      includeStatic: args.includeStatic,
    } as any);

    // Only register session ownership if start actually succeeded
    if (sessionId && !result.isError) {
      tabCaptureSessions.set(tabId, sessionId);
    }

    return decorateJsonResult(result, { backend, needResponseBody: wantBody, tabId });
  }

  private async handleStop(
    args: NetworkCaptureToolParams,
  ): Promise<ToolResult> {
    const sessionId = args?.sessionId || args?.sessionContext;
    let targetTabId: number | undefined;

    // Explicit tabId provided
    if (typeof args?.tabId === 'number') {
      targetTabId = args.tabId;
      // ARCH-06 / Ownership: If this tab is captured by a different session, reject unauthorized stop!
      const ownerSession = tabCaptureSessions.get(targetTabId);
      if (ownerSession && sessionId && ownerSession !== sessionId) {
        return createErrorResponse(
          `Cannot stop network capture on tab ${targetTabId}: it is owned by another session (${ownerSession}).`,
        );
      }
    } else if (sessionId) {
      // Find tab captured specifically by this session
      for (const [tId, sId] of tabCaptureSessions.entries()) {
        if (sId === sessionId) {
          targetTabId = tId;
          break;
        }
      }
    }

    if (targetTabId === undefined && !sessionId) {
      const targetTab = await this.resolveAffinityTab({ tabId: args?.tabId, sessionId }).catch(() => null);
      if (targetTab?.id && (isDebuggerCaptureActiveOnTab(targetTab.id) || isWebRequestCaptureActiveOnTab(targetTab.id))) {
        targetTabId = targetTab.id;
      }
    }

    if (targetTabId === undefined) {
      return createErrorResponse('No active network captures found for the specified tab or session.');
    }

    const debuggerActive = isDebuggerCaptureActiveOnTab(targetTabId);
    const webActive = isWebRequestCaptureActiveOnTab(targetTabId);

    if (!debuggerActive && !webActive) {
      return createErrorResponse(`No active network captures found on tab ${targetTabId}.`);
    }

    // Determine which backend to stop
    let backendToStop: NetworkCaptureBackend | null = null;

    if (args?.needResponseBody === true) {
      backendToStop = debuggerActive ? 'debugger' : null;
    } else if (args?.needResponseBody === false) {
      backendToStop = webActive ? 'webRequest' : null;
    }

    if (!backendToStop) {
      if (debuggerActive) {
        backendToStop = 'debugger';
      } else if (webActive) {
        backendToStop = 'webRequest';
      }
    }

    if (!backendToStop) {
      return createErrorResponse(`No matching network capture found on tab ${targetTabId}.`);
    }

    const delegateStop =
      backendToStop === 'debugger' ? networkDebuggerStopTool : networkCaptureStopTool;
    const result = await delegateStop.execute({ tabId: targetTabId } as any);

    tabCaptureSessions.delete(targetTabId);

    return decorateJsonResult(result, {
      backend: backendToStop,
      needResponseBody: backendToStop === 'debugger',
      tabId: targetTabId,
    });
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId: number) => {
    tabCaptureSessions.delete(tabId);
  });
}

export const networkCaptureTool = new NetworkCaptureTool();
