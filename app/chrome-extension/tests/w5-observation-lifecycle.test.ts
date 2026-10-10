import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InterceptApiTool, registerInterceptorTabListeners } from '../entrypoints/background/tools/browser/intercept-api';
import { performanceStartTraceTool, performanceStopTraceTool, performanceAnalyzeInsightTool, sessions as perfSessions, LAST_RESULTS as perfLastResults, SESSION_LAST_RESULTS as perfSessionLastResults } from '../entrypoints/background/tools/browser/performance';
import { consoleTool } from '../entrypoints/background/tools/browser/console';
import { networkCaptureTool } from '../entrypoints/background/tools/browser/network-capture';
import { networkDebuggerStartTool, networkDebuggerStopTool } from '../entrypoints/background/tools/browser/network-capture-debugger';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';

describe('W5 Observation Lifecycle & Performance Regressions', () => {
  let tabUpdatedListeners: Array<(tabId: number, changeInfo: any, tab?: any) => void> = [];
  let tabRemovedListeners: Array<(tabId: number) => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    perfSessions.clear();
    perfLastResults.clear();
    perfSessionLastResults.clear();
    tabUpdatedListeners = [];
    tabRemovedListeners = [];

    (globalThis as any).chrome = {
      runtime: { id: 'test-ext-id' },
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1, url: 'https://tab' + id + '.test', status: 'complete' })),
        query: vi.fn(async (queryInfo: any) => {
          if (queryInfo.active) {
            return [{ id: 99, windowId: 1, url: 'https://foreground-active.test', status: 'complete' }];
          }
          return [];
        }),
        create: vi.fn(async (opts: any) => ({ id: 101, windowId: 1, url: opts.url })),
        onRemoved: {
          addListener: vi.fn((fn) => tabRemovedListeners.push(fn)),
          removeListener: vi.fn(),
        },
        onUpdated: {
          addListener: vi.fn((fn) => tabUpdatedListeners.push(fn)),
          removeListener: vi.fn(),
        },
        onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      debugger: {
        attach: vi.fn(async () => {}),
        detach: vi.fn(async () => {}),
        sendCommand: vi.fn(async () => ({})),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    };

    registerInterceptorTabListeners((globalThis as any).chrome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('BUG-09: Interceptor late body cache, generation & session isolation', () => {
    it('does not write to recent-cache if getResponseBody finishes after timeout has rejected', async () => {
      const tool = new InterceptApiTool();
      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });

      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          await new Promise((r) => setTimeout(r, 100));
          return {
            body: JSON.stringify({ delayed: 'polluted-data' }),
            base64Encoded: false,
          };
        }
        return {};
      });

      const execPromise = tool.execute({
        tabId: 1,
        urlPattern: '*/api/delayed*',
        triggerAction: 'wait_next',
        timeoutMs: 40,
      });

      setTimeout(() => {
        if (attachedListener) {
          attachedListener({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'req-delayed-1',
            response: {
              url: 'https://example.com/api/delayed',
              status: 200
            },
          });
          attachedListener({ tabId: 1 }, 'Network.loadingFinished', {
            requestId: 'req-delayed-1',
          });
        }
      }, 10);

      const timeoutRes = await execPromise;
      expect(timeoutRes.isError).toBe(true);
      expect((timeoutRes.content[0] as any).text).toContain('Timed out');

      await new Promise((r) => setTimeout(r, 150));

      const cachedRes = await tool.execute({
        tabId: 1,
        urlPattern: '*/api/delayed*',
        triggerAction: 'inspect_recent',
        timeoutMs: 50,
      });

      const isCached = Boolean(cachedRes.content?.[0] && (cachedRes.content[0] as any).text?.includes('polluted-data'));
      expect(isCached).toBeFalsy();
    });

    it('invalidates cached responses when tab navigates to a new page via real chrome.tabs.onUpdated event', async () => {
      const tool = new InterceptApiTool();
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          return { body: JSON.stringify({ initial: true }), base64Encoded: false };
        }
        return {};
      });

      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });

      const liveExec = tool.execute({
        tabId: 1,
        urlPattern: '*/api/v1/nav*',
        triggerAction: 'wait_next',
        timeoutMs: 500,
      });

      setTimeout(() => {
        if (attachedListener) {
          attachedListener({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'req-nav-1',
            response: { url: 'https://example.com/api/v1/nav', status: 200, mimeType: 'application/json' },
          });
          attachedListener({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'req-nav-1' });
        }
      }, 10);

      await liveExec;

      const cacheBefore = await tool.execute({
        tabId: 1,
        urlPattern: '*/api/v1/nav*',
        triggerAction: 'inspect_recent',
        timeoutMs: 50,
      });
      expect(cacheBefore.isError).toBe(false);
      expect((cacheBefore.content[0] as any).text).toContain('recent-cache');

      // Fire real onUpdated event
      for (const listener of tabUpdatedListeners) {
        listener(1, { status: 'loading', url: 'https://example.com/new-url' });
      }

      const cacheAfter = await tool.execute({
        tabId: 1,
        urlPattern: '*/api/v1/nav*',
        triggerAction: 'inspect_recent',
        timeoutMs: 50,
      });
      expect(cacheAfter.isError).toBe(true);
      expect((cacheAfter.content[0] as any).text).toContain('Timed out');
    });

    it('strictly isolates cache across sessions (sessionId !== item.sessionId)', async () => {
      const tool = new InterceptApiTool();
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          return { body: JSON.stringify({ secret: 'session-A-data' }), base64Encoded: false };
        }
        return {};
      });

      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });

      const liveExec = tool.execute({
        tabId: 1,
        sessionId: 'session-A',
        urlPattern: '*/api/secret*',
        triggerAction: 'wait_next',
        timeoutMs: 500,
      });

      setTimeout(() => {
        if (attachedListener) {
          attachedListener({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'req-secret-1',
            response: { url: 'https://example.com/api/secret', status: 200, mimeType: 'application/json' },
          });
          attachedListener({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'req-secret-1' });
        }
      }, 10);

      await liveExec;

      // Session B must NOT read Session A's cache
      const cacheB = await tool.execute({
        tabId: 1,
        sessionId: 'session-B',
        urlPattern: '*/api/secret*',
        triggerAction: 'inspect_recent',
        timeoutMs: 50,
      });
      expect(cacheB.isError).toBe(true);

      // Unspecified session must NOT read Session A's cache
      const cacheNone = await tool.execute({
        tabId: 1,
        urlPattern: '*/api/secret*',
        triggerAction: 'inspect_recent',
        timeoutMs: 50,
      });
      expect(cacheNone.isError).toBe(true);

      // Session A CAN read it
      const cacheA = await tool.execute({
        tabId: 1,
        sessionId: 'session-A',
        urlPattern: '*/api/secret*',
        triggerAction: 'inspect_recent',
        timeoutMs: 50,
      });
      expect(cacheA.isError).toBe(false);
      expect((cacheA.content[0] as any).text).toContain('session-A-data');
    });

    it('clearTab monotonically advances generation on tab remove event', async () => {
      const tool = new InterceptApiTool();
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          return { body: JSON.stringify({ tab: 1 }), base64Encoded: false };
        }
        return {};
      });

      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });

      const liveExec = tool.execute({
        tabId: 1,
        urlPattern: '*/api/test*',
        triggerAction: 'wait_next',
        timeoutMs: 500,
      });

      setTimeout(() => {
        if (attachedListener) {
          attachedListener({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'req-t1',
            response: { url: 'https://example.com/api/test', status: 200, mimeType: 'application/json' },
          });
          attachedListener({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'req-t1' });
        }
      }, 10);

      await liveExec;

      // Trigger real onRemoved listener
      for (const listener of tabRemovedListeners) {
        listener(1);
      }

      const cacheRes = await tool.execute({
        tabId: 1,
        urlPattern: '*/api/test*',
        triggerAction: 'inspect_recent',
        timeoutMs: 50,
      });
      expect(cacheRes.isError).toBe(true);
    });
  });

  describe('BUG-20: Reading body failure / loadingFailed must return top-level isError: true', () => {
    it('returns top-level isError: true when Network.loadingFailed occurs', async () => {
      const tool = new InterceptApiTool();
      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      const execPromise = tool.execute({
        tabId: 1,
        urlPattern: '*/api/failed*',
        triggerAction: 'wait_next',
        timeoutMs: 1000,
      });

      setTimeout(() => {
        if (attachedListener) {
          attachedListener({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'req-fail-1',
            response: {
              url: 'https://example.com/api/failed',
              status: 502,
              mimeType: 'application/json',
            },
          });
          attachedListener({ tabId: 1 }, 'Network.loadingFailed', {
            requestId: 'req-fail-1',
            errorText: 'net::ERR_CONNECTION_RESET',
          });
        }
      }, 30);

      const res = await execPromise;
      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe(502);
      expect(parsed.data?.error || parsed.error).toContain('ERR_CONNECTION_RESET');
    });

    it('returns top-level isError: true when getResponseBody throws an error', async () => {
      const tool = new InterceptApiTool();
      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          throw new Error('No resource with given identifier found');
        }
        return {};
      });

      const execPromise = tool.execute({
        tabId: 1,
        urlPattern: '*/api/nobody*',
        triggerAction: 'wait_next',
        timeoutMs: 1000,
      });

      setTimeout(() => {
        if (attachedListener) {
          attachedListener({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'req-nobody-1',
            response: {
              url: 'https://example.com/api/nobody',
              status: 200,
              mimeType: 'application/json',
            },
          });
          attachedListener({ tabId: 1 }, 'Network.loadingFinished', {
            requestId: 'req-nobody-1',
          });
        }
      }, 30);

      const res = await execPromise;
      expect(res.isError).toBe(true);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.success).toBe(false);
      expect(parsed.data?.error || parsed.error).toContain('No resource with given identifier');
    });

    it('returns isError: false when HTTP response status is 404/500 but body reading succeeded', async () => {
      const tool = new InterceptApiTool();
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
        if (method === 'Network.enable') return {};
        if (method === 'Network.getResponseBody') {
          return { body: JSON.stringify({ error: 'not found' }), base64Encoded: false };
        }
        return {};
      });

      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });

      const execPromise = tool.execute({
        tabId: 1,
        urlPattern: '*/api/404*',
        triggerAction: 'wait_next',
        timeoutMs: 1000,
      });

      setTimeout(() => {
        if (attachedListener) {
          attachedListener({ tabId: 1 }, 'Network.responseReceived', {
            requestId: 'req-404-1',
            response: { url: 'https://example.com/api/404', status: 404, mimeType: 'application/json' },
          });
          attachedListener({ tabId: 1 }, 'Network.loadingFinished', { requestId: 'req-404-1' });
        }
      }, 30);

      const res = await execPromise;
      // Target HTTP non-2xx status code is NOT tool error
      expect(res.isError).toBe(false);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe(404);
    });
  });

  describe('BUG-10: Trace lifecycle, rollback & bounded finalize', () => {
    it('rolls back session, listeners and lease when Tracing.start fails', async () => {
      const startTool = performanceStartTraceTool;
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      const detachSpy = vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(new Error('Tracing domain crashed'));

      const res = await startTool.execute({} as any);
      expect(res.isError).toBe(true);
      expect(perfSessions.has(99)).toBe(false);
      expect(detachSpy).toHaveBeenCalledWith(99, 'performance');
    });

    it('creates stopResolver BEFORE Tracing.end so fast tracingComplete is never missed', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;

      let debuggerListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        debuggerListener = fn;
      });

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (tabId, method) => {
        if (method === 'Tracing.end') {
          if (debuggerListener) {
            debuggerListener({ tabId }, 'Tracing.tracingComplete', {});
          }
          return {};
        }
        return {};
      });

      await startTool.execute({} as any);

      const stopRes = await stopTool.execute({ saveToDownloads: false } as any);
      expect(stopRes.isError).toBe(false);
      const parsed = JSON.parse((stopRes.content[0] as any).text);
      expect(parsed.tracingCompleted).toBe(true);
    }, 2000);

    it('single finalize cleans up lease, listener and timer when tracingComplete never arrives (timeout)', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      const detachSpy = vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      await startTool.execute({} as any);
      expect(perfSessions.has(99)).toBe(true);

      // Stop trace when Tracing.tracingComplete never arrives
      const stopRes = await stopTool.execute({ saveToDownloads: false } as any);
      expect(stopRes.isError).toBe(false);
      const parsed = JSON.parse((stopRes.content[0] as any).text);
      // Must indicate tracing was incomplete rather than hanging
      expect(parsed.tracingCompleted).toBe(false);
      // Cleaned up properly
      expect(perfSessions.has(99)).toBe(false);
      expect(detachSpy).toHaveBeenCalledWith(99, 'performance');
    }, 3000);
  });

  describe('ARCH-05: Session TabAffinity in performance trace and console', () => {
    it('performance stop and analyze locate trace by session tab rather than foreground active tab', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;
      const analyzeTool = performanceAnalyzeInsightTool;

      vi.spyOn(sessionTabAffinity, 'resolveSessionTab').mockImplementation(async (sessionId: string) => {
        if (sessionId === 'session-A') return { id: 1, windowId: 1, url: 'https://tab1.test' } as any;
        return null;
      });
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      let debuggerListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        debuggerListener = fn;
      });
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (tabId, method) => {
        if (method === 'Tracing.end') {
          if (debuggerListener) debuggerListener({ tabId }, 'Tracing.tracingComplete', {});
          return {};
        }
        return {};
      });

      const startRes = await startTool.execute({ sessionId: 'session-A' } as any);
      expect(startRes.isError).toBe(false);
      expect(perfSessions.has(1)).toBe(true);
      expect(perfSessions.has(99)).toBe(false);

      const stopRes = await stopTool.execute({ sessionId: 'session-A', saveToDownloads: false } as any);
      expect(stopRes.isError).toBe(false);
      const parsedStop = JSON.parse((stopRes.content[0] as any).text);
      expect(parsedStop.success).toBe(true);
      expect(parsedStop.tabId).toBe(1);

      const analyzeRes = await analyzeTool.execute({ sessionId: 'session-A' } as any);
      expect(analyzeRes.isError).toBe(false);
      const analyzeText = (analyzeRes.content[0] as any).text;
      expect(analyzeText).not.toContain('No recorded traces found');
    });

    it('console tool defaults to session TabAffinity instead of querying foreground active tab', async () => {
      vi.spyOn(sessionTabAffinity, 'resolveSessionTab').mockImplementation(async (sessionId: string) => {
        if (sessionId === 'session-A') return { id: 1, windowId: 1, url: 'https://tab1.test' } as any;
        return null;
      });
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      const res = await consoleTool.execute({ sessionId: 'session-A', mode: 'buffer', buffer: true } as any);
      expect(res.isError).toBe(false);
      const text = (res.content[0] as any).text;
      const parsed = JSON.parse(text);
      expect(parsed.tabId).toBe(1);
    });
  });

  describe('ARCH-06: Network capture isolation across tabs and sessions', () => {
    it('allows concurrent captures on different tabs and does not globally block new starts', async () => {
      (networkDebuggerStartTool as any)['captureData'].set(1, { tabId: 1, requests: [] });

      const resTab2 = await networkCaptureTool.execute({
        action: 'start',
        tabId: 2,
        sessionId: 'session-B',
        needResponseBody: true,
      } as any);

      expect(resTab2.isError).toBe(false);
      const parsed = JSON.parse((resTab2.content[0] as any).text);
      expect(parsed.tabId).toBe(2);

      (networkDebuggerStartTool as any)['captureData'].clear();
    });

    it('stop capture on Tab 1 does NOT stop ongoing capture on Tab 2', async () => {
      (networkDebuggerStartTool as any)['captureData'].set(1, { tabId: 1, requests: [] });
      (networkDebuggerStartTool as any)['captureData'].set(2, { tabId: 2, requests: [] });

      vi.spyOn(networkDebuggerStopTool as any, 'performStop').mockImplementation(async (_startTool: any, tabId: number) => {
        (networkDebuggerStartTool as any)['captureData'].delete(tabId);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, tabId }) }],
          isError: false,
        };
      });

      await networkCaptureTool.execute({
        action: 'stop',
        tabId: 1,
        sessionId: 'session-A',
        needResponseBody: true,
      } as any);

      expect((networkDebuggerStartTool as any)['captureData'].has(2)).toBe(true);
      expect((networkDebuggerStartTool as any)['captureData'].has(1)).toBe(false);

      (networkDebuggerStartTool as any)['captureData'].clear();
    });
  });

  describe('PERF-03: Console snapshot fast flush vs explicit future observation', () => {
    it('executes console snapshot fast without 2000ms delay', async () => {
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      const start = Date.now();
      const res = await consoleTool.execute({ tabId: 1, mode: 'snapshot' });
      const elapsed = Date.now() - start;

      expect(res.isError).toBe(false);
      // Must finish well under 1000ms (50ms flush delay vs previous 2000ms)
      expect(elapsed).toBeLessThan(800);
    });

    it('waits explicitly requested duration when waitMs is provided', async () => {
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      const start = Date.now();
      const res = await consoleTool.execute({ tabId: 1, mode: 'snapshot', waitMs: 150 });
      const elapsed = Date.now() - start;

      expect(res.isError).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(130);
    });
  });

  describe('W5 Round 2 Root Causes & Gate Verifications', () => {
    it('[GATE-W5-01-REFS-100] 100 cycles of intercept_api conserve Network domain refs and release on exit without leaking refs or mis-decrementing', async () => {
      const tool = new InterceptApiTool();
      let networkRefCount = 1; // Existing owner holds 1 ref
      let enableCalls = 0;
      let disableCalls = 0;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'enableDomain').mockImplementation(async (_tabId, domain) => {
        if (domain === 'Network') {
          enableCalls++;
          networkRefCount++;
        }
      });
      vi.spyOn(cdpSessionManager, 'disableDomain').mockImplementation(async (_tabId, domain) => {
        if (domain === 'Network') {
          disableCalls++;
          networkRefCount--;
        }
      });
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
        if (method === 'Network.getResponseBody') {
          return { body: JSON.stringify({ ok: true }), base64Encoded: false };
        }
        return {};
      });

      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });

      // Run 100 cycles of intercept
      for (let i = 0; i < 100; i++) {
        const p = tool.execute({
          tabId: 1,
          urlPattern: '*/api/cycle*',
          triggerAction: 'wait_next',
          timeoutMs: 100,
        });
        setTimeout(() => {
          if (attachedListener) {
            attachedListener({ tabId: 1 }, 'Network.responseReceived', {
              requestId: 'req-cycle-' + i,
              response: { url: 'https://example.com/api/cycle', status: 200, mimeType: 'application/json' },
            });
            attachedListener({ tabId: 1 }, 'Network.loadingFinished', {
              requestId: 'req-cycle-' + i,
            });
          }
        }, 2);
        await p;
      }

      // Must be conserved: networkRefCount must remain 1, enableCalls === disableCalls === 100
      expect(enableCalls).toBe(100);
      expect(disableCalls).toBe(100);
      expect(networkRefCount).toBe(1);

      // If enableDomain fails, disableDomain must NOT be called (to avoid mis-decrementing other owners)
      (cdpSessionManager.enableDomain as any).mockRejectedValueOnce(new Error('Network enable failed'));
      const failedExec = await tool.execute({
        tabId: 1,
        urlPattern: '*/api/fail*',
        triggerAction: 'wait_next',
        timeoutMs: 50,
      });
      expect(failedExec.isError).toBe(true);
      expect(networkRefCount).toBe(1); // Not mis-decremented to 0
    });

    it('[GATE-W5-02-FALLBACK-SINGLEFLIGHT] 80ms fallback in-flight read collision with loadingFinished does not deadlock or force-timeout', async () => {
      const tool = new InterceptApiTool();
      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });

      let readAttempt = 0;
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'enableDomain').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'disableDomain').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tabId, method) => {
        if (method === 'Network.getResponseBody') {
          readAttempt++;
          if (readAttempt === 1) {
            // First attempt from 80ms fallback: transiently rejects
            throw new Error('Response body not ready');
          }
          // Second attempt from loadingFinished pending trigger: succeeds
          return { body: JSON.stringify({ recovered: true }), base64Encoded: false };
        }
        return {};
      });

      const execPromise = tool.execute({
        tabId: 1,
        urlPattern: '*/api/race*',
        triggerAction: 'wait_next',
        timeoutMs: 1500,
      });

      await new Promise((r) => setTimeout(r, 10));

      // 1. responseReceived triggers 80ms fallback timer
      attachedListener({ tabId: 1 }, 'Network.responseReceived', {
        requestId: 'req-race-1',
        response: { url: 'https://example.com/api/race', status: 200, mimeType: 'application/json' },
      });

      // 2. Wait 85ms for fallback to fire and start reading (attempt 1)
      await new Promise((r) => setTimeout(r, 85));

      // 3. loadingFinished arrives while readAttempt 1 is in-flight or transiently failed
      attachedListener({ tabId: 1 }, 'Network.loadingFinished', {
        requestId: 'req-race-1',
      });

      // Must recover via singleflight re-trigger rather than waiting 1500ms and timing out
      const res = await execPromise;
      expect(res.isError).toBe(false);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.recovered).toBe(true);
    });

    it('[GATE-W5-03-NAVIGATION-DETACH-SETTLE] topframe navigation / tab removed / debugger detach immediately settles error without hanging for timeout', async () => {
      const tool = new InterceptApiTool();
      let attachedListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        attachedListener = fn;
      });
      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'enableDomain').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'disableDomain').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      const start = Date.now();
      const execPromise = tool.execute({
        tabId: 1,
        urlPattern: '*/api/nav-cancel*',
        triggerAction: 'wait_next',
        timeoutMs: 5000, // 5s timeout
      });

      // Top-frame navigation occurs
      setTimeout(() => {
        attachedListener({ tabId: 1 }, 'Page.frameNavigated', { frame: {} });
      }, 30);

      const res = await execPromise;
      const elapsed = Date.now() - start;
      expect(res.isError).toBe(true);
      expect(elapsed).toBeLessThan(500); // Settle immediately, not after 5000ms!
      expect((res.content[0] as any).text).toContain('Navigation');
    });

    it('[GATE-W5-04-TRACE-AUTOSTOP-FINALIZE] trace autoStop performs full finalizeTraceSession without leaving dangling session; concurrent stop uses singleflight', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      const detachSpy = vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      let debuggerListener: any;
      (chrome.debugger.onEvent.addListener as any).mockImplementation((fn: any) => {
        debuggerListener = fn;
      });
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (tabId, method) => {
        if (method === 'Tracing.end') {
          if (debuggerListener) debuggerListener({ tabId }, 'Tracing.tracingComplete', {});
          return {};
        }
        return {};
      });

      await startTool.execute({ autoStop: true, durationMs: 40, tabId: 1 } as any);
      expect(perfSessions.has(1)).toBe(true);

      // Wait for autoStop timer (40ms) and tracingComplete to finalize automatically
      await new Promise((r) => setTimeout(r, 80));

      // Must be fully finalized without dangling session!
      expect(perfSessions.has(1)).toBe(false);
      expect(perfLastResults.has(1)).toBe(true);
      expect(detachSpy).toHaveBeenCalledWith(1, 'performance');
    });

    it('[GATE-W5-05-STOP-ANALYZE-EXPLICIT-TAB] explicit tab takes precedence over sessionId; session without record never fallbacks to other session trace', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;
      const analyzeTool = performanceAnalyzeInsightTool;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      // Start trace on tab 1 with session-A, and on tab 2 with session-B
      await startTool.execute({ tabId: 1, sessionId: 'session-A' } as any);
      await startTool.execute({ tabId: 2, sessionId: 'session-B' } as any);

      // Call stop with explicit tabId: 2 (without conflicting principal) -> MUST stop tab 2!
      const stopRes = await stopTool.execute({ tabId: 2, saveToDownloads: false } as any);
      expect(stopRes.isError).toBe(false);
      const parsedStop = JSON.parse((stopRes.content[0] as any).text);
      expect(parsedStop.tabId).toBe(2);
      expect(perfSessions.has(2)).toBe(false);
      expect(perfSessions.has(1)).toBe(true); // tab 1 must still be recording

      // Clean up tab 1
      await stopTool.execute({ tabId: 1, saveToDownloads: false } as any);

      // Now session-C analyzes insight -> must NOT fall back to session-A or session-B results!
      const analyzeC = await analyzeTool.execute({ sessionId: 'session-C' } as any);
      const analyzeText = (analyzeC.content[0] as any).text;
      expect(analyzeText).toContain('No recorded traces found');
    });

    it('[GATE-W5-06-NETWORK-CAPTURE-SESSION-OWNERSHIP] network capture handleStart does not register tabCaptureSessions on failure, and handleStop never stops other session capture on explicit tab', async () => {
      // 1. handleStart failure does not pollute tabCaptureSessions
      vi.spyOn(networkDebuggerStartTool, 'execute').mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Simulated start error' }],
        isError: true,
      });

      const failStart = await networkCaptureTool.execute({
        action: 'start',
        tabId: 5,
        sessionId: 'session-failed',
        needResponseBody: true,
      } as any);
      expect(failStart.isError).toBe(true);

      // 2. Tab 5 capturing by session-X
      vi.spyOn(networkDebuggerStartTool, 'execute').mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ success: true, tabId: 5 }) }],
        isError: false,
      });
      await networkCaptureTool.execute({
        action: 'start',
        tabId: 5,
        sessionId: 'session-X',
        needResponseBody: true,
      } as any);

      // 3. session-Y tries to stop with explicit tabId: 5 -> MUST NOT stop session-X's capture!
      const stopByY = await networkCaptureTool.execute({
        action: 'stop',
        tabId: 5,
        sessionId: 'session-Y',
        needResponseBody: true,
      } as any);

      expect(stopByY.isError).toBe(true);
      expect((stopByY.content[0] as any).text).toContain('owned by another session');

      // Clean up
      await networkCaptureTool.execute({
        action: 'stop',
        tabId: 5,
        sessionId: 'session-X',
        needResponseBody: true,
      } as any);
    });

    it('[DEFECT-P1-01-EXPLICIT-TAB-NO-FALLBACK] stopTrace with explicit tabId having no recording trace must fail immediately and NOT fallback to other tab of same sessionId', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      // Start trace on Tab 1 with session-A
      await startTool.execute({ tabId: 1, sessionId: 'session-A' } as any);
      expect(perfSessions.has(1)).toBe(true);

      // Call stop explicitly for Tab 2 (which has no trace) with sessionId: 'session-A'
      // Must NOT fallback to Tab 1! Tab 1 must remain recording, and stop must report no trace on Tab 2
      const stopRes = await stopTool.execute({ tabId: 2, sessionId: 'session-A', saveToDownloads: false } as any);
      const text = (stopRes.content[0] as any).text;
      expect(text).toContain('No performance trace session found');
      expect(perfSessions.has(1)).toBe(true); // Tab 1 must NOT be stopped!

      // Cleanup Tab 1
      await stopTool.execute({ tabId: 1, saveToDownloads: false } as any);
    });

    it('[DEFECT-P1-02-NO-AFFINITY-HIJACK-ON-SESSION] stopTrace with sessionId must NOT fallback through resolveAffinityTab to hijack another session trace', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      // Tab 1 is recording trace for session-OTHER
      await startTool.execute({ tabId: 1, sessionId: 'session-OTHER' } as any);
      expect(perfSessions.has(1)).toBe(true);

      // session-A has affinity to Tab 1, but session-A has NO trace of its own.
      vi.spyOn(sessionTabAffinity, 'resolveSessionTab').mockResolvedValue({ id: 1, windowId: 1, url: 'https://tab1.test' } as any);

      // session-A calls stopTrace without tabId. Must NOT hijack and stop session-OTHER's trace on Tab 1!
      const stopRes = await stopTool.execute({ sessionId: 'session-A', saveToDownloads: false } as any);
      const text = (stopRes.content[0] as any).text;
      expect(text).toContain('No performance trace session found');
      expect(perfSessions.has(1)).toBe(true); // session-OTHER's trace is intact!

      // Cleanup session-OTHER
      await stopTool.execute({ tabId: 1, saveToDownloads: false } as any);
    });

    it('[DEFECT-P1-03-CLEANUP-FINALIZED-SESSION-CACHE] cleanupTabPerformanceData removes SESSION_LAST_RESULTS by matching tabId even after trace was already finalized', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      // Start & Stop trace on Tab 1 with session-A
      await startTool.execute({ tabId: 1, sessionId: 'session-A' } as any);
      await stopTool.execute({ tabId: 1, sessionId: 'session-A', saveToDownloads: false } as any);

      // Trace is finalized: sessions map is empty, but SESSION_LAST_RESULTS has session-A entry
      expect(perfSessions.has(1)).toBe(false);
      expect(perfSessionLastResults.has('session-A')).toBe(true);

      // Tab 1 is closed
      const { cleanupTabPerformanceData } = await import('../entrypoints/background/tools/browser/performance');
      cleanupTabPerformanceData(1);

      // SESSION_LAST_RESULTS entry for Tab 1 must be cleaned up!
      expect(perfSessionLastResults.has('session-A')).toBe(false);
      expect(perfLastResults.has(1)).toBe(false);
    });

    it('[DEFECT-P1-04-FINALIZE-IDENTITY-GUARD] suspended finalize race with cleanup and new trace does NOT delete new session or pollute cache with old delayed results', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);

      let sendCommandHook: ((tabId: number, method: string) => Promise<any>) | null = null;
      vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (tabId, method, params) => {
        if (sendCommandHook) {
          return sendCommandHook(tabId, method);
        }
        return {};
      });

      // 1. Start Trace 1 on Tab 1 with session-OLD
      await startTool.execute({ tabId: 1, sessionId: 'session-OLD' } as any);
      const oldSession = perfSessions.get(1);

      // 2. Begin stopTrace for Trace 1, but delay inside metrics/detach
      let finishDelay: () => void;
      const delayedPromise = new Promise<void>((resolve) => {
        finishDelay = resolve;
      });

      sendCommandHook = async (_tabId, method) => {
        if (method === 'Performance.enable') {
          await delayedPromise; // suspend finalize!
        }
        return {};
      };

      const oldStopPromise = stopTool.execute({ tabId: 1, sessionId: 'session-OLD', saveToDownloads: false } as any);

      // Wait a tick to ensure oldStopPromise entered finalizeTraceSession and is suspended
      await new Promise((r) => setTimeout(r, 20));

      // 3. Tab 1 triggers cleanup (e.g. detach/navigation)
      const { cleanupTabPerformanceData } = await import('../entrypoints/background/tools/browser/performance');
      cleanupTabPerformanceData(1);
      expect(perfSessions.has(1)).toBe(false);

      // 4. A brand new trace is started on Tab 1 by session-NEW
      sendCommandHook = null; // restore normal sendCommand
      await startTool.execute({ tabId: 1, sessionId: 'session-NEW' } as any);
      const newSession = perfSessions.get(1);
      expect(newSession).toBeDefined();
      expect(newSession).not.toBe(oldSession);

      // 5. Old suspended finalize now resumes and completes
      finishDelay!();
      await oldStopPromise;

      // Identity Guard Check:
      // The new session on Tab 1 must NOT be deleted by old finalize!
      expect(perfSessions.get(1)).toBe(newSession);
      // Cache must NOT be polluted with session-OLD delayed results!
      expect(perfSessionLastResults.has('session-OLD')).toBe(false);

      // Cleanup new session
      await stopTool.execute({ tabId: 1, sessionId: 'session-NEW', saveToDownloads: false } as any);
    });

    it('[DEFECT-P1-05-STOP-TRACE-OWNER-GUARD] stopTrace with explicit tabId rejects unauthorized caller if tab is owned by a different session', async () => {
      const startTool = performanceStartTraceTool;
      const stopTool = performanceStopTraceTool;

      vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'detach').mockResolvedValue(undefined);
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      // Tab 1 started by session-X
      await startTool.execute({ tabId: 1, sessionId: 'session-X' } as any);
      expect(perfSessions.has(1)).toBe(true);

      // session-Y tries to stop Tab 1 with explicit tabId: 1
      const unauthorizedStop = await stopTool.execute({ tabId: 1, sessionId: 'session-Y', saveToDownloads: false } as any);
      expect(unauthorizedStop.isError).toBe(true);
      expect((unauthorizedStop.content[0] as any).text).toContain('owned by another session');

      // Tab 1 must remain recording!
      expect(perfSessions.has(1)).toBe(true);

      // session-X can stop normally
      const authorizedStop = await stopTool.execute({ tabId: 1, sessionId: 'session-X', saveToDownloads: false } as any);
      expect(authorizedStop.isError).toBe(false);
      expect(perfSessions.has(1)).toBe(false);
    });
  });

});
