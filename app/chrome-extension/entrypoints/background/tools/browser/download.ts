import { createErrorResponse, type ToolCallContext, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { interactIndexTool } from './interact-index';
import {
  ScopedDownloadError,
  waitForDownload,
  waitForScopedDownload,
  type DownloadDetails,
  type WaitForDownloadOptions,
} from './download-waiter';

export { waitForDownload, type WaitForDownloadOptions, type DownloadDetails };

interface HandleDownloadParams {
  tabId?: number;
  guid?: string;
  clickTargetIndex?: number;
  frameId?: number;
  filenameContains?: string;
  timeoutMs?: number;
  waitForComplete?: boolean;
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function validGuid(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 128 && value.trim() === value
  );
}

function isScoped(args: HandleDownloadParams): boolean {
  return (
    args?.tabId !== undefined ||
    args?.guid !== undefined ||
    args?.clickTargetIndex !== undefined ||
    args?.frameId !== undefined
  );
}

function scopedFailure(
  message: string,
  fields: Record<string, unknown>,
  trigger?: ToolResult,
): ToolResult {
  const payload = { success: false, error: message, retry: false, ...fields };
  return mergeSource(trigger, payload);
}

function mergeSource(
  trigger: ToolResult | undefined,
  payload: Record<string, unknown>,
): ToolResult {
  if (!trigger) {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: payload.success !== true,
    };
  }
  const content = [...trigger.content];
  const structured = trigger.structuredContent || {};
  let merged: Record<string, unknown> = { ...structured, ...payload };
  let replaced = false;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        merged = { ...parsed, ...structured, ...payload };
        content[i] = { type: 'text', text: JSON.stringify(merged) };
        replaced = true;
        break;
      }
    } catch {
      // Keep non-JSON diagnostics from the trigger.
    }
  }
  if (!replaced) content.push({ type: 'text', text: JSON.stringify(merged) });
  return { ...trigger, content, structuredContent: merged, isError: payload.success !== true };
}

function scopedArgs(args: HandleDownloadParams):
  | { error: ToolResult }
  | {
      tabId: number;
      guid?: string;
      clickTargetIndex?: number;
      frameId?: number;
      filenameContains?: string;
      waitForComplete: boolean;
      timeoutMs: number;
    } {
  const blocked = (message: string) => ({
    error: scopedFailure(message, { status: 'blocked', dispatched: false, guids: [] }),
  });
  if (!positiveInt(args.tabId))
    return blocked('tabId must be a positive integer for a scoped download');
  const hasGuid = args.guid !== undefined;
  const hasClick = args.clickTargetIndex !== undefined;
  if (hasGuid && hasClick) return blocked('guid and clickTargetIndex are mutually exclusive');
  if (args.frameId !== undefined && !hasClick) {
    return blocked('frameId is only valid with clickTargetIndex');
  }
  if (args.frameId !== undefined && (!Number.isSafeInteger(args.frameId) || args.frameId < 0)) {
    return blocked('frameId must be a non-negative integer');
  }
  if (hasClick && !positiveInt(args.clickTargetIndex)) {
    return blocked('clickTargetIndex must be a positive integer');
  }
  if (hasGuid && !validGuid(args.guid)) return blocked('guid must be a 1-128 character string');
  if (!hasGuid && !hasClick) return blocked('scoped download requires guid or clickTargetIndex');
  if (args.waitForComplete !== undefined && typeof args.waitForComplete !== 'boolean') {
    return blocked('waitForComplete must be a boolean');
  }
  if (args.filenameContains !== undefined && typeof args.filenameContains !== 'string') {
    return blocked('filenameContains must be a string');
  }
  if (args.timeoutMs === undefined) {
    return {
      tabId: args.tabId,
      guid: hasGuid ? args.guid : undefined,
      clickTargetIndex: hasClick ? args.clickTargetIndex : undefined,
      frameId: args.frameId,
      filenameContains: args.filenameContains?.trim() || undefined,
      waitForComplete: args.waitForComplete !== false,
      timeoutMs: 60000,
    };
  }
  if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 50 || args.timeoutMs > 300000) {
    return blocked('timeoutMs must be an integer from 50 to 300000');
  }
  return {
    tabId: args.tabId,
    guid: hasGuid ? args.guid : undefined,
    clickTargetIndex: hasClick ? args.clickTargetIndex : undefined,
    frameId: args.frameId,
    filenameContains: args.filenameContains?.trim() || undefined,
    waitForComplete: args.waitForComplete !== false,
    timeoutMs: args.timeoutMs,
  };
}

class HandleDownloadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD as any;

  async execute(args: HandleDownloadParams, context?: ToolCallContext): Promise<ToolResult> {
    if (isScoped(args || {})) return this.executeScoped(args || {}, context);
    const filenameContains = String(args?.filenameContains || '').trim();
    const waitForComplete = args?.waitForComplete !== false;
    const timeoutMs = Math.max(50, Math.min(Number(args?.timeoutMs ?? 60000), 300000));
    try {
      const result = await waitForDownload({
        filenameContains,
        waitForComplete,
        timeoutMs,
        signal: context?.signal,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, download: result }) }],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Handle download failed: ${e?.message || String(e)}`);
    }
  }

  private async executeScoped(
    args: HandleDownloadParams,
    context?: ToolCallContext,
  ): Promise<ToolResult> {
    const parsed = scopedArgs(args);
    if ('error' in parsed) return parsed.error;
    if (context?.signal?.aborted) {
      return scopedFailure('Download wait aborted', {
        status: 'cancelled',
        dispatched: false,
        guids: [],
      });
    }
    try {
      const status = await waitForScopedDownload({
        tabId: parsed.tabId,
        guid: parsed.guid,
        filenameContains: parsed.filenameContains,
        waitForComplete: parsed.waitForComplete,
        timeoutMs: parsed.timeoutMs,
        signal: context?.signal,
        trigger: parsed.guid
          ? undefined
          : () =>
              interactIndexTool.execute({
                tabId: parsed.tabId,
                index: parsed.clickTargetIndex!,
                ...(parsed.frameId !== undefined ? { frameId: parsed.frameId } : {}),
                action: 'click',
                includeDelta: false,
              }),
      });
      if (status.kind === 'trigger-stopped') return status.result;
      const download = status.download;
      return mergeSource(status.trigger, {
        success: true,
        download,
        started: download.state === 'inProgress' || download.state === 'completed',
        browserCompleted: download.state === 'completed',
        verifiedPath: false,
      });
    } catch (error) {
      if (error instanceof ScopedDownloadError) {
        return scopedFailure(
          error.message,
          {
            status: error.status,
            ...(error.outcome ? { outcome: error.outcome } : {}),
            ...(error.dispatched !== undefined ? { dispatched: error.dispatched } : {}),
            ...(error.requestDispatched ? { requestDispatched: true } : {}),
            ...(error.source ? { source: error.source } : {}),
            guids: error.guids,
            ...(error.downloads.length > 0 ? { downloads: error.downloads } : {}),
            ...(error.receipt !== undefined ? { receipt: error.receipt } : {}),
          },
          error.result,
        );
      }
      const carried = (error as { result?: ToolResult })?.result;
      if (carried && Array.isArray(carried.content)) return carried;
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Handle download failed: ${message}`);
    }
  }
}

export const handleDownloadTool = new HandleDownloadTool();
