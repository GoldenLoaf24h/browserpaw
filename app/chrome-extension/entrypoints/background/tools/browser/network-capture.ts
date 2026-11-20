import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { networkCaptureStartTool, networkCaptureStopTool } from './network-capture-web-request';
import { networkDebuggerStartTool, networkDebuggerStopTool } from './network-capture-debugger';

type NetworkCaptureBackend = 'webRequest' | 'debugger';

interface NetworkCaptureToolParams {
  action: 'start' | 'stop' | 'status' | 'list' | 'show' | 'clear';
  needResponseBody?: boolean;
  url?: string;
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
  maxCaptureTime?: number;
  inactivityTimeout?: number;
  includeStatic?: boolean;
  requestUrlPattern?: string;
  method?: string;
  status?: number;
  resourceType?: string;
  limit?: number;
  requestId?: string;
  outputPath?: string;
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

function hasRetainedResultOnTab(tabId: number): boolean {
  return (
    networkDebuggerStartTool.hasTerminalResult(tabId) ||
    networkCaptureStartTool.hasTerminalResult(tabId)
  );
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
    if (!['start', 'stop', 'status', 'list', 'show', 'clear'].includes(action)) {
      return createErrorResponse(
        'Parameter [action] must be start, stop, status, list, show, or clear',
      );
    }

    const wantBody = args?.needResponseBody === true;

    if (action === 'start') {
      return this.handleStart(args, wantBody);
    }

    if (action === 'status' || action === 'list' || action === 'show' || action === 'clear') {
      const tab = await this.resolveAffinityTab({ tabId: args.tabId, sessionId: args.sessionId });
      if (!tab.id) return createErrorResponse('No target tab.');
      const owner = tabCaptureSessions.get(tab.id);
      if (owner && owner !== args.sessionId)
        return createErrorResponse('Capture belongs to another task.');
      const debug = (
        networkDebuggerStartTool as unknown as {
          captureData: Map<number, { requests: Record<string, unknown> }>;
        }
      ).captureData.get(tab.id);
      const recording = debug ?? networkCaptureStartTool.captureData.get(tab.id);
      const retained =
        (
          networkDebuggerStartTool as unknown as { terminalResults: Map<number, { result: any }> }
        ).terminalResults.get(tab.id)?.result ??
        networkCaptureStartTool.terminalResults.get(tab.id)?.result;
      if (
        !recording &&
        !retained &&
        (action === 'list' || action === 'show' || action === 'clear')
      ) {
        const history = await this.tabHistory(tab.id);
        if (action === 'clear')
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  tabId: tab.id,
                  cleared: false,
                  message: 'No active or retained capture.',
                }),
              },
            ],
            isError: false,
          };
        if (!history.length)
          return createErrorResponse(
            `No active, retained, or page-helper network capture found on tab ${tab.id}. Start network start before inspecting traffic.`,
          );
        if (action === 'show') {
          if (!args.requestId)
            return createErrorResponse('Use network show ID to inspect one captured request.');
          const item = history.find((entry: any) => String(entry.requestId) === args.requestId);
          if (!item) return createErrorResponse(`Network request ${args.requestId} was not found.`);
          return this.showNetworkRequest(tab.id, item, args.outputPath);
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ tabId: tab.id, recording: false, requests: history }),
            },
          ],
          isError: false,
        };
      }
      const requests = recording?.requests ?? retained?.requests ?? {};
      if (action === 'status') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                tabId: tab.id,
                recording: Boolean(recording),
                requestCount: Object.keys(requests).length,
                requests: Object.values(requests),
              }),
            },
          ],
          isError: false,
        };
      }
      if (action === 'clear') {
        if (recording?.requests) recording.requests = {};
        if (retained?.requests) retained.requests = {};
        if (debug) {
          (
            networkDebuggerStartTool as unknown as { requestCounters: Map<number, number> }
          ).requestCounters.set(tab.id, 0);
        } else {
          (
            networkCaptureStartTool as unknown as { requestCounters: Map<number, number> }
          ).requestCounters.set(tab.id, 0);
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify({ success: true, tabId: tab.id, cleared: true }) },
          ],
          isError: false,
        };
      }
      const method = typeof args.method === 'string' ? args.method.toUpperCase() : undefined;
      const status = Number(args.status);
      const type =
        typeof args.resourceType === 'string' ? args.resourceType.toLowerCase() : undefined;
      const limit =
        Number.isSafeInteger(args.limit) && Number(args.limit) > 0
          ? Math.min(Number(args.limit), 100)
          : 100;
      let entries = Object.values(requests) as Array<Record<string, any>>;
      if (args.requestUrlPattern)
        entries = entries.filter((entry) => {
          const pattern = String(args.requestUrlPattern);
          const regex = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
          if (!regex)
            return String(entry.url || '')
              .toLowerCase()
              .includes(pattern.toLowerCase());
          try {
            const compiled = new RegExp(regex[1], regex[2]);
            return compiled.test(String(entry.url || ''));
          } catch {
            return false;
          }
        });
      if (method)
        entries = entries.filter((entry) => String(entry.method || '').toUpperCase() === method);
      if (Number.isFinite(status))
        entries = entries.filter(
          (entry) => Number(entry.statusCode ?? entry.status) === Math.floor(status),
        );
      if (type)
        entries = entries.filter((entry) => String(entry.type || '').toLowerCase() === type);
      entries.sort((a, b) => Number(a.requestTime || 0) - Number(b.requestTime || 0));
      if (action === 'show') {
        const requestId = args.requestId;
        if (!requestId)
          return createErrorResponse('Use network show ID to inspect one captured request.');
        const item = entries.find(
          (entry, index) =>
            String(entry.requestId) === requestId || String(index + 1) === requestId,
        );
        if (!item) return createErrorResponse(`Network request ${requestId} was not found.`);
        return this.showNetworkRequest(tab.id, item, args.outputPath);
      }
      if (action === 'list')
        entries = entries.slice(0, limit).map((entry, index) => ({
          id: entry.requestId,
          index: index + 1,
          method: entry.method,
          url: entry.url,
          status: entry.statusCode ?? entry.status,
          type: entry.type,
          requestTime: entry.requestTime,
          responseTime: entry.responseTime,
          mimeType: entry.mimeType,
          encodedDataLength: entry.encodedDataLength ?? entry.responseSize,
          responseBody: entry.responseBody
            ? {
                chars: entry.responseBody.length,
                truncated: entry.responseBody.includes('[Response truncated'),
              }
            : undefined,
        }));
      const payload = {
        tabId: tab.id,
        recording: Boolean(recording),
        requests: entries,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
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
      requestUrlPattern: args.requestUrlPattern,
    } as any);

    // Only register session ownership if start actually succeeded
    if (sessionId && !result.isError) {
      tabCaptureSessions.set(tabId, sessionId);
    }

    return decorateJsonResult(result, { backend, needResponseBody: wantBody, tabId });
  }

  private async tabHistory(tabId: number) {
    try {
      await this.injectContentScript(tabId, ['inject-scripts/network-helper.js']);
      const response = await this.sendMessageToTab(
        tabId,
        { action: 'GET_NETWORK_HISTORY' },
        undefined,
        10000,
      );
      const entries = Array.isArray(response?.requests) ? response.requests : [];
      return entries;
    } catch {
      return [];
    }
  }

  private showNetworkRequest(tabId: number, item: Record<string, any>, outputPath?: string) {
    const body = typeof item.responseBody === 'string' ? item.responseBody : undefined;
    if (outputPath && body === undefined)
      return createErrorResponse(
        `Network request ${item.requestId} has no textual response body${item.bodyOmitted ? ` (${item.bodyOmitted})` : ''}.`,
      );
    const result: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ tabId, request: item }) }],
      isError: false,
    };
    if (body !== undefined && outputPath) {
      const bytes = new TextEncoder().encode(body);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      const mimeType = /json/i.test(String(item.mimeType || ''))
        ? 'application/json'
        : 'text/plain';
      (result.content as any[]).push({
        type: 'resource',
        resource: {
          uri: `browserpaw://network/${encodeURIComponent(String(item.requestId))}/body.txt`,
          mimeType,
          blob: btoa(binary),
        },
      });
      result.structuredContent = {
        tabId,
        request: item,
        file: {
          path: null,
          name: `${item.requestId}.txt`,
          mimeType,
          bytes: bytes.length,
          outputPath,
          resourceUri: `browserpaw://network/${encodeURIComponent(String(item.requestId))}/body.txt`,
        },
      };
    }
    return result;
  }

  private async handleStop(args: NetworkCaptureToolParams): Promise<ToolResult> {
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
      const targetTab = await this.resolveAffinityTab({ tabId: args?.tabId, sessionId }).catch(
        () => null,
      );
      if (
        targetTab?.id &&
        (isDebuggerCaptureActiveOnTab(targetTab.id) ||
          isWebRequestCaptureActiveOnTab(targetTab.id) ||
          hasRetainedResultOnTab(targetTab.id))
      ) {
        targetTabId = targetTab.id;
      }
    }

    if (targetTabId === undefined) {
      return createErrorResponse(
        'No active network captures found for the specified tab or session.',
      );
    }

    const debuggerActive = isDebuggerCaptureActiveOnTab(targetTabId);
    const webActive = isWebRequestCaptureActiveOnTab(targetTabId);

    if (!debuggerActive && !webActive) {
      let retainedBackend: NetworkCaptureBackend | null = null;
      if (args?.needResponseBody === true) {
        retainedBackend = networkDebuggerStartTool.hasTerminalResult(targetTabId)
          ? 'debugger'
          : null;
      } else if (args?.needResponseBody === false) {
        retainedBackend = networkCaptureStartTool.hasTerminalResult(targetTabId)
          ? 'webRequest'
          : null;
      } else if (networkDebuggerStartTool.hasTerminalResult(targetTabId)) {
        retainedBackend = 'debugger';
      } else if (networkCaptureStartTool.hasTerminalResult(targetTabId)) {
        retainedBackend = 'webRequest';
      }

      if (retainedBackend) {
        const delegateStop =
          retainedBackend === 'debugger' ? networkDebuggerStopTool : networkCaptureStopTool;
        const result = await delegateStop.execute({ tabId: targetTabId } as any);
        tabCaptureSessions.delete(targetTabId);
        return decorateJsonResult(result, {
          backend: retainedBackend,
          needResponseBody: retainedBackend === 'debugger',
          tabId: targetTabId,
        });
      }
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
