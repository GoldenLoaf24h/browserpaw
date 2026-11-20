import { NativeMessageType, TOOL_NAMES, type CallToolResult } from 'chrome-mcp-shared';
import host from './native-messaging-host';
import { createBrowserServices } from './browser-services';
import { assertNotSensitivePath } from './file-handler';
import {
  assertSourceDownloadRequest,
  tryParseCallResult,
  verifySourceDownloadResult,
  withStructuredPayload,
} from './browser-tasks';

type Fields = Record<string, unknown>;

async function extension(
  name: string,
  args: Fields,
  sessionId?: string,
  signal?: AbortSignal,
  timeoutMs = 120000,
): Promise<CallToolResult> {
  if (name === 'browserpaw_set_owned_viewport' || name === 'browserpaw_release_owned_page') {
    const response = await host.sendRequestToExtensionAndWait(
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
  const explicitTimeout = Number(args.timeout ?? args.timeoutMs);
  const requestedTimeout =
    Number.isFinite(explicitTimeout) && explicitTimeout > 0
      ? Math.min(explicitTimeout, 300000)
      : name === TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD
        ? 60000
        : undefined;
  const transportTimeout =
    requestedTimeout === undefined ? timeoutMs : Math.max(timeoutMs, requestedTimeout + 30000);
  const response = await host.sendRequestToExtensionAndWait(
    { name, args: { ...args, ...(sessionId ? { sessionId } : {}) }, sessionId },
    NativeMessageType.CALL_TOOL,
    transportTimeout,
    signal,
  );
  if (response.status !== 'success') {
    throw Object.assign(new Error(response.error || `Extension failed to run ${name}`), {
      requestDispatched: true,
    });
  }
  return response.data;
}

let services: ReturnType<typeof createBrowserServices> | undefined;

export async function callToolInternal(
  name: string,
  args: Fields,
  sessionId?: string,
  timeoutMs = 120000,
  signal?: AbortSignal,
) {
  if (typeof args.taskId === 'string') {
    services ??= createBrowserServices(extension);
    return services.tasks.callTool(args.taskId, name, args, sessionId, signal);
  }
  const sourceDownload =
    name === 'chrome_handle_download' &&
    !args.directUrl &&
    ['tabId', 'guid', 'clickTargetIndex', 'frameId'].some((key) => args[key] !== undefined);
  if (sourceDownload) {
    const observation = await extension('get_windows_and_tabs', {}, sessionId, signal, timeoutMs);
    if (observation.isError)
      throw Object.assign(new Error('Cannot verify download source capability'), {
        requestDispatched: false,
      });
    const inventory = tryParseCallResult(observation);
    const capabilities = inventory?.capabilities as { sourceDownloads?: boolean } | undefined;
    assertSourceDownloadRequest(args, capabilities?.sourceDownloads === true);
  }
  const result = await extension(name, args, sessionId, signal, timeoutMs);
  return sourceDownload ? verifySourceDownloadResult(args, result) : result;
}

export async function handleBrowserCall(
  name: string,
  args: Fields,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    signal.throwIfAborted();
    if (name === TOOL_NAMES.BROWSER.FILE_UPLOAD) {
      const filePaths = Array.isArray(args.filePaths) ? args.filePaths : [];
      for (const candidate of [args.filePath, ...filePaths]) {
        if (typeof candidate === 'string') assertNotSensitivePath(candidate);
      }
    }
    if (name === 'chrome_task' || name === 'chrome_skill') {
      services ??= createBrowserServices(extension);
      return await services.execute(name, args, sessionId, signal);
    }
    if (!host.isConnected)
      return withStructuredPayload(undefined, {
        status: 'blocked',
        success: false,
        retry: false,
        requestDispatched: false,
        code: 'extension_disconnected',
        error: 'Chrome extension is not connected.',
      });
    return await callToolInternal(name, args, sessionId, 120000, signal);
  } catch (failure) {
    const error = failure as { message?: string; requestDispatched?: boolean };
    return withStructuredPayload(undefined, {
      status: error.requestDispatched ? 'unknown' : signal.aborted ? 'cancelled' : 'failed',
      success: false,
      error: error.message ?? String(failure),
      ...(error.requestDispatched === undefined
        ? {}
        : { requestDispatched: error.requestDispatched }),
      retry: false,
    });
  }
}
