import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { sendFileOperationToNative, cancelFileOperation } from '../../native-host';

type OwnerTag = 'performance';

interface StartTraceParams {
  reload?: boolean; // whether to reload the page after starting trace
  autoStop?: boolean; // whether to auto stop after a short duration
  durationMs?: number; // custom duration when autoStop is true (default 5000)
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

interface StopTraceParams {
  saveToDownloads?: boolean; // save trace to Downloads as JSON (default true)
  filenamePrefix?: string; // filename prefix (default 'performance_trace')
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

interface AnalyzeInsightParams {
  insightName?: string; // placeholder for future deep insights
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

type DebuggeeEvent = (source: chrome.debugger.Debuggee, method: string, params?: any) => void;

interface TraceSessionState {
  recording: boolean;
  completed: boolean;
  invalidated?: boolean;
  events: any[];
  startedAt: number;
  pageUrl?: string;
  sessionId?: string;
  listener: DebuggeeEvent;
  stopResolver?: (value: { completed: boolean }) => void;
  stopPromise?: Promise<{ completed: boolean }>;
  autoStopTimer?: any;
  finalizingPromise?: Promise<{
    saved?: { downloadId?: number; filename?: string; fullPath?: string };
    metrics?: Record<string, number>;
    endedAt: number;
    tracingCompleted: boolean;
  }>;
}

export const sessions = new Map<number, TraceSessionState>();
export const SESSION_LAST_RESULTS = new Map<
  string,
  {
    tabId: number;
    events: any[];
    startedAt: number;
    endedAt: number;
    tabUrl: string;
    saved?: { downloadId?: number; filename?: string; fullPath?: string };
    metrics?: Record<string, number>;
  }
>();
export const LAST_RESULTS = new Map<
  number,
  {
    tabId: number;
    events: any[];
    startedAt: number;
    endedAt: number;
    tabUrl: string;
    saved?: { downloadId?: number; filename?: string; fullPath?: string };
    metrics?: Record<string, number>;
  }
>();

function tracingCategories(): string[] {
  // Keep broadly consistent with other project
  return [
    '-*',
    'blink.console',
    'blink.user_timing',
    'devtools.timeline',
    'disabled-by-default-devtools.screenshot',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.invalidationTracking',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'disabled-by-default-v8.cpu_profiler.hires',
    'latencyInfo',
    'loading',
    'disabled-by-default-lighthouse',
    'v8.execute',
    'v8',
  ];
}

async function enablePerformanceMetrics(tabId: number): Promise<Record<string, number>> {
  try {
    await cdpSessionManager.sendCommand(tabId, 'Performance.enable');
    const result = (await cdpSessionManager.sendCommand(tabId, 'Performance.getMetrics')) as {
      metrics: Array<{ name: string; value: number }>;
    };
    await cdpSessionManager.sendCommand(tabId, 'Performance.disable');
    const map: Record<string, number> = {};
    for (const m of result.metrics || []) map[m.name] = m.value;
    return map;
  } catch (e) {
    return {};
  }
}

async function saveTraceToDownloads(
  json: string,
  filenamePrefix = 'performance_trace',
): Promise<{ downloadId?: number; filename?: string; fullPath?: string }> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}_${timestamp}.json`;
    let url: string;
    let cleanupUrl: (() => void) | undefined;

    if (
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function' &&
      typeof Blob !== 'undefined'
    ) {
      const blob = new Blob([json], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      cleanupUrl = () => {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      };
    } else {
      // Robust chunked fallback avoiding unescape/encodeURIComponent memory explosion
      const bytes = new TextEncoder().encode(json);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
      }
      url = `data:application/json;base64,${btoa(binary)}`;
    }

    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    if (cleanupUrl) {
      setTimeout(cleanupUrl, 10000);
    }
    // Attempt to resolve full path
    try {
      await new Promise((r) => setTimeout(r, 120));
      const [item] = await chrome.downloads.search({ id: downloadId });
      return { downloadId, filename, fullPath: item?.filename };
    } catch {
      return { downloadId, filename };
    }
  } catch {
    return {};
  }
}

/**
 * Safe ceiling for trace JSON data sent over Native Messaging to strictly stay under Chrome's 1MB limit.
 * 500KB raw JSON serializes to ~667KB base64, comfortably below the 1MB (1,048,576 bytes) limit.
 */
export const MAX_SAFE_TRACE_JSON_BYTES = 500 * 1024;

export function prepareSafeTraceForNative(events: any[]): string {
  if (!events || !Array.isArray(events) || events.length === 0) {
    return JSON.stringify({ traceEvents: [] });
  }

  const initialJson = JSON.stringify({ traceEvents: events });
  if (initialJson.length <= MAX_SAFE_TRACE_JSON_BYTES) {
    return initialJson;
  }

  // 1. Strip heavy payload data (e.g., base64 screenshot data in args.snapshot)
  const prunedEvents = events.map((ev) => {
    if (ev?.name === 'Screenshot' && ev?.args?.snapshot) {
      const { snapshot, ...restArgs } = ev.args;
      return { ...ev, args: restArgs };
    }
    return ev;
  });

  const prunedJson = JSON.stringify({ traceEvents: prunedEvents });
  if (prunedJson.length <= MAX_SAFE_TRACE_JSON_BYTES) {
    return prunedJson;
  }

  // 2. Prioritize key lifecycle, navigation, and performance mark events
  const priorityEventNames = new Set([
    'navigationStart',
    'fetchStart',
    'domainLookupStart',
    'domainLookupEnd',
    'connectStart',
    'connectEnd',
    'requestStart',
    'responseStart',
    'responseEnd',
    'domLoading',
    'domInteractive',
    'domContentLoadedEventStart',
    'domContentLoadedEventEnd',
    'domComplete',
    'loadEventStart',
    'loadEventEnd',
    'firstPaint',
    'firstContentfulPaint',
    'largestContentfulPaint::Candidate',
    'LayoutShift',
    'RunTask',
    'EventDispatch',
    'CommitLoad',
    'ResourceSendRequest',
    'ResourceReceiveResponse',
    'ResourceFinish',
    'FunctionCall',
    'EvaluateScript',
  ]);

  const priorityEvents = prunedEvents.filter(
    (ev) =>
      ev?.ph === 'M' || // Metadata events
      ev?.cat?.includes('disabled-by-default-devtools.timeline') ||
      priorityEventNames.has(ev?.name),
  );

  const priorityJson = JSON.stringify({ traceEvents: priorityEvents });
  if (priorityJson.length <= MAX_SAFE_TRACE_JSON_BYTES) {
    return priorityJson;
  }

  // 3. Binary search slice to strictly guarantee size under MAX_SAFE_TRACE_JSON_BYTES
  let low = 0;
  let high = priorityEvents.length;
  let best = JSON.stringify({ traceEvents: [] });

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ traceEvents: priorityEvents.slice(0, mid) });
    if (candidate.length <= MAX_SAFE_TRACE_JSON_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

async function saveTraceToNativeTemp(
  events: any[],
  filenamePrefix = 'performance_trace',
): Promise<{ filename?: string; fullPath?: string } | undefined> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${filenamePrefix}_${timestamp}.json`;
    const safeJson = prepareSafeTraceForNative(events);

    // Optimized string to base64 encoding without unescape/encodeURIComponent memory explosion
    const bytes = new TextEncoder().encode(safeJson);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    const base64 = btoa(binary);

    const requestId = `trace-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = 30000;
    const resp = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        cancelFileOperation(requestId);
        reject(new Error('Native temp save timed out'));
      }, timeoutMs);

      const ok = sendFileOperationToNative(
        {
          type: 'file_operation',
          requestId,
          payload: {
            action: 'prepareFile',
            base64Data: base64,
            fileName: filename,
          },
        },
        (message: any) => {
          clearTimeout(timer);
          resolve(message.payload);
        },
      );

      if (!ok) {
        clearTimeout(timer);
        reject(new Error('Native host not connected'));
      }
    });

    if (resp && resp.success && resp.filePath) {
      return { filename, fullPath: resp.filePath };
    }
  } catch {
    // ignore, fallback will apply
  }
  return undefined;
}

async function cleanupNativeTempFile(filePath: string): Promise<void> {
  if (!filePath) return;
  try {
    const requestId = `trace-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = 10000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cancelFileOperation(requestId);
        resolve(); // best-effort
      }, timeoutMs);

      const ok = sendFileOperationToNative(
        {
          type: 'file_operation',
          requestId,
          payload: {
            action: 'cleanupFile',
            filePath,
          },
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );

      if (!ok) {
        clearTimeout(timer);
        resolve();
      }
    });
  } catch {
    // ignore
  }
}

function getOrCreateStopPromise(session: TraceSessionState): Promise<{ completed: boolean }> {
  if (session.stopPromise) return session.stopPromise;
  session.stopPromise = new Promise((resolve) => {
    session.stopResolver = resolve;
  });
  return session.stopPromise;
}

async function finalizeTraceSession(
  tabId: number,
  session: TraceSessionState,
  completed: boolean,
  saveToDownloads = true,
  filenamePrefix = 'performance_trace',
): Promise<{
  saved?: { downloadId?: number; filename?: string; fullPath?: string };
  metrics?: Record<string, number>;
  endedAt: number;
  tracingCompleted: boolean;
}> {
  if (session.finalizingPromise) {
    return session.finalizingPromise;
  }

  session.finalizingPromise = (async () => {
    if (session.autoStopTimer) {
      clearTimeout(session.autoStopTimer);
      session.autoStopTimer = undefined;
    }
    try {
      chrome.debugger.onEvent.removeListener(session.listener);
    } catch {}
    const metrics = await enablePerformanceMetrics(tabId).catch(() => ({}));
    try {
      await cdpSessionManager.detach(tabId, 'performance');
    } catch {}

    const endedAt = Date.now();
    const trace = { traceEvents: session.events };
    const json = JSON.stringify(trace);

    let saved: { downloadId?: number; filename?: string; fullPath?: string } | undefined;
    if (saveToDownloads) {
      saved = await saveTraceToDownloads(json, filenamePrefix);
    } else {
      const tempSaved = await saveTraceToNativeTemp(session.events, filenamePrefix);
      if (tempSaved) {
        saved = { ...tempSaved } as any;
      }
    }

    const resultRecord = {
      tabId,
      events: session.events,
      startedAt: session.startedAt,
      endedAt,
      tabUrl: session.pageUrl || '',
      saved,
      metrics,
    };

    // Identity Guard: if session was invalidated (e.g. by tab close/detach cleanup)
    // or has already been replaced by a newer session on this tab, do NOT write to cache
    // and do NOT delete the new active session!
    if (session.invalidated || sessions.get(tabId) !== session) {
      return {
        saved,
        metrics,
        endedAt,
        tracingCompleted: false,
      };
    }

    LAST_RESULTS.set(tabId, resultRecord);
    if (session.sessionId) {
      SESSION_LAST_RESULTS.set(session.sessionId, resultRecord);
    }

    sessions.delete(tabId);

    return {
      saved,
      metrics,
      endedAt,
      tracingCompleted: completed,
    };
  })();

  return session.finalizingPromise;
}

async function stopAndFinalizeTrace(
  tabId: number,
  session: TraceSessionState,
  saveToDownloads = true,
  filenamePrefix = 'performance_trace',
): Promise<{
  saved?: { downloadId?: number; filename?: string; fullPath?: string };
  metrics?: Record<string, number>;
  endedAt: number;
  tracingCompleted: boolean;
}> {
  if (session.finalizingPromise) {
    return session.finalizingPromise;
  }

  let stopResult: { completed: boolean } = { completed: false };
  if (session.recording) {
    const stopPromise = getOrCreateStopPromise(session);
    await cdpSessionManager.sendCommand(tabId, 'Tracing.end').catch(() => {});
    stopResult = await Promise.race([
      stopPromise,
      new Promise<{ completed: boolean }>((resolve) =>
        setTimeout(() => resolve({ completed: false }), 2000),
      ),
    ]);
  } else {
    stopResult = { completed: session.completed };
  }

  return finalizeTraceSession(
    tabId,
    session,
    stopResult.completed,
    saveToDownloads,
    filenamePrefix,
  );
}

/**
 * Start performance trace
 */
class PerformanceStartTraceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE;

  async execute(args: StartTraceParams): Promise<ToolResult> {
    const { reload = false, autoStop = false, durationMs = 5000 } = args || {};
    const sessionId = args?.sessionId || args?.sessionContext;

    try {
      const targetTab = await this.resolveAffinityTab({ tabId: args?.tabId, sessionId });
      if (!targetTab?.id) {
        return createErrorResponse('No active tab found');
      }
      const tabId = targetTab.id;
      const existed = sessions.get(tabId);
      if (existed?.recording) {
        return {
          content: [{ type: 'text', text: 'Error: a performance trace is already running.' }],
          isError: false,
        };
      }

      await cdpSessionManager.attach(tabId, 'performance');

      const state: TraceSessionState = {
        recording: true,
        completed: false,
        events: [],
        startedAt: Date.now(),
        pageUrl: targetTab.url || '',
        sessionId,
        listener: (source, method, params) => {
          if (source.tabId !== tabId) return;
          if (method === 'Tracing.dataCollected' && params?.value) {
            try {
              state.events.push(...(params.value as any[]));
            } catch {
              // ignore
            }
          } else if (method === 'Tracing.tracingComplete') {
            state.recording = false;
            state.completed = true;
            state.stopResolver?.({ completed: true });
          }
        },
      };
      chrome.debugger.onEvent.addListener(state.listener);
      sessions.set(tabId, state);

      try {
        // Start tracing with categories
        const cats = tracingCategories().join(',');
        await cdpSessionManager.sendCommand(tabId, 'Tracing.start', {
          categories: cats,
          options: 'record-as-much-as-possible',
          transferMode: 'ReportEvents',
        });

        if (reload) {
          try {
            await cdpSessionManager.sendCommand(tabId, 'Page.reload', { ignoreCache: true });
          } catch {
            // best effort; ignore if fails
          }
        }
      } catch (startErr: any) {
        // BUG-10: Rollback registered listener, session, and lease
        try {
          chrome.debugger.onEvent.removeListener(state.listener);
        } catch {}
        sessions.delete(tabId);
        await cdpSessionManager.detach(tabId, 'performance').catch(() => {});
        throw startErr;
      }

      if (autoStop) {
        state.autoStopTimer = setTimeout(
          async () => {
            try {
              await stopAndFinalizeTrace(tabId, state, false, 'performance_trace');
            } catch {
              // ignore
            }
          },
          Math.max(10, Math.min(durationMs, 60000)),
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Performance trace is recording. Use performance_stop_trace to stop it.',
              tabId,
              reload,
              autoStop,
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Failed to start performance trace: ${e?.message || e}`);
    }
  }
}

/**
 * Stop performance trace
 */
class PerformanceStopTraceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE;

  async execute(args: StopTraceParams): Promise<ToolResult> {
    const { saveToDownloads = true, filenamePrefix } = args || {};
    const sessionId = args?.sessionId || args?.sessionContext;
    try {
      let targetTabId: number | undefined;
      let session: TraceSessionState | undefined;

      // Explicit tabId ALWAYS takes precedence: do NOT fallback to other tabs
      if (typeof args?.tabId === 'number') {
        session = sessions.get(args.tabId);
        if (session) {
          targetTabId = args.tabId;
          // Owner Guard: If caller provided a sessionId and this tab belongs to another principal session, reject!
          if (sessionId && session.sessionId && session.sessionId !== sessionId) {
            return createErrorResponse(
              'Cannot stop performance trace on tab ' + args.tabId + ': it is owned by another session (' + session.sessionId + ').'
            );
          }
        }
      } else if (sessionId) {
        // Strict session principal: resolve strictly by caller's sessionId across recording sessions.
        // If not found, reject directly without fallback to affinityTab (prevents hijacking other sessions).
        for (const [tId, s] of sessions.entries()) {
          if (s.sessionId === sessionId) {
            targetTabId = tId;
            session = s;
            break;
          }
        }
      } else {
        // Legacy unauthenticated callers without tabId or sessionId: fallback to foreground/affinity tab
        const targetTab = await this.resolveAffinityTab({ tabId: args?.tabId, sessionId }).catch(() => null);
        if (targetTab?.id && sessions.has(targetTab.id)) {
          targetTabId = targetTab.id;
          session = sessions.get(targetTab.id);
        }
      }

      if (!session) {
        return {
          content: [
            { type: 'text', text: 'No performance trace session found for the current tab.' },
          ],
          isError: false,
        };
      }

      const tabId = targetTabId!;
      const finalized = await stopAndFinalizeTrace(
        tabId,
        session,
        saveToDownloads,
        filenamePrefix || 'performance_trace',
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'The performance trace has been stopped.',
              tabId,
              eventCount: session.events.length,
              saved: finalized.saved,
              metrics: finalized.metrics,
              startedAt: session.startedAt,
              endedAt: finalized.endedAt,
              durationMs: finalized.endedAt - session.startedAt,
              url: session.pageUrl || '',
              tracingCompleted: finalized.tracingCompleted,
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Failed to stop performance trace: ${e?.message || e}`);
    }
  }
}

/**
 * Analyze last trace (lightweight)
 * Note: Deep insights require DevTools front-end trace engine on the native side; this is a
 * pragmatic first step returning basic metrics and a quick event histogram.
 */
class PerformanceAnalyzeInsightTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT;

  async execute(args: AnalyzeInsightParams & { timeoutMs?: number }): Promise<ToolResult> {
    const { insightName } = args || {};
    const sessionId = args?.sessionId || args?.sessionContext;
    try {
      let result: any;
      // Explicit tabId ALWAYS takes precedence
      if (typeof args?.tabId === 'number') {
        if (LAST_RESULTS.has(args.tabId)) {
          result = LAST_RESULTS.get(args.tabId);
        }
      } else if (sessionId) {
        // Strict session isolation: only return trace recorded for this session, never fallback!
        if (SESSION_LAST_RESULTS.has(sessionId)) {
          result = SESSION_LAST_RESULTS.get(sessionId);
        }
      } else {
        const targetTab = await this.resolveAffinityTab({ tabId: args?.tabId, sessionId }).catch(() => null);
        if (targetTab?.id && LAST_RESULTS.has(targetTab.id)) {
          result = LAST_RESULTS.get(targetTab.id);
        }
      }

      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: 'No recorded traces found. Start and stop a performance trace first.',
            },
          ],
          isError: false,
        };
      }

      // Prefer native-side deep analysis when we have a saved file path
      const fullPath = (result.saved && (result.saved as any).fullPath) || undefined;
      if (fullPath) {
        try {
          const requestId = `trace-analyze-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const timeoutMs = Math.max(10000, Math.min((args as any)?.timeoutMs ?? 60000, 300000));
          const resp = await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
              cancelFileOperation(requestId);
              reject(new Error('Native trace analysis timed out'));
            }, timeoutMs);

            const ok = sendFileOperationToNative(
              {
                type: 'file_operation',
                requestId,
                payload: { action: 'analyzeTrace', traceFilePath: fullPath, insightName },
              },
              (message: any) => {
                clearTimeout(timer);
                resolve(message?.payload);
              },
            );

            if (!ok) {
              clearTimeout(timer);
              reject(new Error('Native host not connected'));
            }
          });
          if (resp && resp.success) {
            // Best-effort cleanup for temp files (Downloads paths are ignored by native cleaner)
            await cleanupNativeTempFile(fullPath);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    url: result.tabUrl,
                    startedAt: result.startedAt,
                    endedAt: result.endedAt,
                    durationMs: result.endedAt - result.startedAt,
                    metrics: result.metrics || {},
                    saved: result.saved,
                    summary: resp.summary,
                    insight: resp.insight,
                  }),
                },
              ],
              isError: false,
            };
          }
          // If native returned error, fall through to lightweight analysis
        } catch (e) {
          // Fallback to lightweight analysis below
        }
      }

      // Lightweight fallback (when no saved file path)
      const counts = new Map<string, number>();
      for (const ev of result.events.slice(0, 100000)) {
        const n = typeof (ev as any)?.name === 'string' ? (ev as any).name : 'unknown';
        counts.set(n, (counts.get(n) || 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([name, count]) => ({ name, count }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              info: 'Lightweight analysis (no saved file path). Native-side deep analysis unavailable.',
              requestedInsight: insightName || null,
              url: result.tabUrl,
              startedAt: result.startedAt,
              endedAt: result.endedAt,
              durationMs: result.endedAt - result.startedAt,
              metrics: result.metrics || {},
              topEventNames: top,
              saved: result.saved,
            }),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Failed to analyze trace: ${e?.message || e}`);
    }
  }
}

export const performanceStartTraceTool = new PerformanceStartTraceTool();
export const performanceStopTraceTool = new PerformanceStopTraceTool();
export const performanceAnalyzeInsightTool = new PerformanceAnalyzeInsightTool();

/**
 * Tab removal listener: cleans up session and cached trace results to prevent memory leaks.
 */
export function cleanupTabPerformanceData(tabId: number): void {
  const session = sessions.get(tabId);
  if (session) {
    session.invalidated = true;
    if (session.autoStopTimer) {
      clearTimeout(session.autoStopTimer);
      session.autoStopTimer = undefined;
    }
    try {
      chrome.debugger.onEvent.removeListener(session.listener);
    } catch {}
    void cdpSessionManager.detach(tabId, 'performance').catch(() => {});
    sessions.delete(tabId);
  }
  // Clear ALL SESSION_LAST_RESULTS belonging to this tabId even if trace was already finalized
  for (const [sId, rec] of SESSION_LAST_RESULTS.entries()) {
    if (rec.tabId === tabId) {
      SESSION_LAST_RESULTS.delete(sId);
    }
  }
  LAST_RESULTS.delete(tabId);
}

if (typeof chrome !== 'undefined') {
  if (chrome.tabs?.onRemoved?.addListener) {
    chrome.tabs.onRemoved.addListener((tabId: number) => {
      cleanupTabPerformanceData(tabId);
    });
  }
  if (chrome.debugger?.onDetach?.addListener) {
    chrome.debugger.onDetach.addListener((source: chrome.debugger.Debuggee) => {
      if (typeof source.tabId === 'number') {
        cleanupTabPerformanceData(source.tabId);
      }
    });
  }
}
