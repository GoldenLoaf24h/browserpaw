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

const backends = {
  debugger: { start: networkDebuggerStartTool, stop: networkDebuggerStopTool },
  webRequest: { start: networkCaptureStartTool, stop: networkCaptureStopTool },
};
const tabCaptureSessions = new Map<
  number,
  { backend: NetworkCaptureBackend; sessionId?: string; busy: boolean }
>();

function captureBackend(tabId: number): NetworkCaptureBackend | undefined {
  const selected = tabCaptureSessions.get(tabId)?.backend;
  if (selected) return selected;
  return (['debugger', 'webRequest'] as const).find((backend) =>
    backends[backend].start.captureData.has(tabId),
  );
}

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

    const sessionId = args.sessionId || args.sessionContext;
    const tab = await this.resolveAffinityTab({ tabId: args.tabId, sessionId });
    if (typeof tab.id !== 'number') return createErrorResponse('No target tab.');
    const capture = tabCaptureSessions.get(tab.id);
    if (capture && capture.sessionId !== sessionId)
      return createErrorResponse('Capture belongs to another task.');
    if (capture?.busy) return createErrorResponse('Network capture is changing state.');
    const backend = captureBackend(tab.id);
    const tools = backend ? backends[backend] : undefined;
    if (action === 'stop') {
      if (!tools || (wantBody && backend !== 'debugger'))
        return createErrorResponse('No matching network capture on this tab.');
      if (capture) capture.busy = true;
      try {
        const result = await tools.stop.execute({ tabId: tab.id, keepResult: true });
        return decorateJsonResult(result, {
          backend,
          needResponseBody: backend === 'debugger',
          tabId: tab.id,
        });
      } finally {
        if (capture) capture.busy = false;
      }
    }

    {
      const recording = tools?.start.captureData.get(tab.id);
      const retained = tools?.start.hasTerminalResult(tab.id)
        ? tools.start.terminalResults.get(tab.id)?.result
        : undefined;
      const requests = recording?.requests ?? retained?.requests ?? {};
      if (action === 'clear') {
        if (recording) {
          recording.requests = {};
          tools?.start.requestCounters.set(tab.id, 0);
        }
        tools?.start.terminalResults.delete(tab.id);
        if (!recording) tabCaptureSessions.delete(tab.id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                tabId: tab.id,
                cleared: Boolean(recording || retained),
              }),
            },
          ],
          isError: false,
        };
      }
      let entries = Object.values(requests) as Array<Record<string, any>>;
      if (action === 'show') {
        const requestId = args.requestId;
        if (!requestId)
          return createErrorResponse('Use network show ID to inspect one captured request.');
        const item = entries.find((entry) => String(entry.requestId) === requestId);
        if (!item) return createErrorResponse(`Network request ${requestId} was not found.`);
        return this.showNetworkRequest(tab.id, item, args.outputPath);
      }
      const method = typeof args.method === 'string' ? args.method.toUpperCase() : undefined;
      const status = Number(args.status);
      const type =
        typeof args.resourceType === 'string' ? args.resourceType.toLowerCase() : undefined;
      const limit =
        Number.isSafeInteger(args.limit) && Number(args.limit) > 0
          ? Math.min(Number(args.limit), 100)
          : 100;
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
      const payload = {
        tabId: tab.id,
        recording: Boolean(recording),
        requestCount: entries.length,
        requests: entries.slice(0, limit).map((entry) => ({
          id: String(entry.requestId),
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
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
    }
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

    if (
      tabCaptureSessions.get(tabId)?.busy ||
      Object.values(backends).some(({ start }) => start.captureData.has(tabId))
    ) {
      return createErrorResponse(
        `Network capture is already active on tab ${tabId}. Stop it before starting a new capture.`,
      );
    }

    for (const [previousTab, previous] of tabCaptureSessions) {
      const { start } = backends[previous.backend];
      if (
        !previous.busy &&
        !start.captureData.has(previousTab) &&
        !start.hasTerminalResult(previousTab)
      )
        tabCaptureSessions.delete(previousTab);
    }
    for (const { start } of Object.values(backends)) start.terminalResults.delete(tabId);
    const backend = wantBody ? 'debugger' : 'webRequest';
    const state: { backend: NetworkCaptureBackend; sessionId?: string; busy: boolean } = {
      backend,
      sessionId,
      busy: true,
    };
    tabCaptureSessions.set(tabId, state);
    try {
      const result = await backends[backend].start.execute({
        url: args.url,
        tabId,
        maxCaptureTime: args.maxCaptureTime,
        inactivityTimeout: args.inactivityTimeout,
        includeStatic: args.includeStatic,
        requestUrlPattern: args.requestUrlPattern,
      });
      if (result.isError) tabCaptureSessions.delete(tabId);
      return decorateJsonResult(result, { backend, needResponseBody: wantBody, tabId });
    } finally {
      state.busy = false;
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
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId: number) => {
    tabCaptureSessions.delete(tabId);
  });
}

export const networkCaptureTool = new NetworkCaptureTool();
