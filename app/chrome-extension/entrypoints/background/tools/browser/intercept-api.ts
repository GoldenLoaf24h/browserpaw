import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

export interface InterceptApiParams {
  urlPattern: string;
  triggerAction?: 'inspect_recent' | 'wait_next';
  timeoutMs?: number;
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

interface CapturedApiResponse {
  requestId: string;
  url: string;
  status: number;
  mimeType: string;
  timestamp: number;
  data: any;
  generation?: number;
  sessionId?: string;
  byteLength?: number;
}

export function decodeBase64Utf8(base64Str: string): string {
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(base64Str, 'base64').toString('utf-8');
    }
    const binStr = atob(base64Str);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    try {
      return atob(base64Str);
    } catch {
      return base64Str;
    }
  }
}

const MAX_CACHE_PER_TAB = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ITEM_BYTES = 512 * 1024; // 512KB per item
const MAX_TAB_TOTAL_BYTES = 2 * 1024 * 1024; // 2MB total per tab

function getUtf8ByteLength(data: any): number {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str).length;
    }
    return str.length;
  } catch {
    return 0;
  }
}

class ApiInterceptorStore {
  private recentResponses = new Map<number, CapturedApiResponse[]>();
  private tabGenerations = new Map<number, number>();
  private globalMonotonicGen = 1;

  public getGeneration(tabId: number): number {
    return this.tabGenerations.get(tabId) || 0;
  }

  public incrementGeneration(tabId: number): number {
    const next = ++this.globalMonotonicGen;
    this.tabGenerations.set(tabId, next);
    this.recentResponses.delete(tabId);
    return next;
  }

  public addResponse(tabId: number, item: CapturedApiResponse, generation?: number, sessionId?: string): void {
    const currentGen = this.getGeneration(tabId);
    if (typeof generation === 'number' && generation !== currentGen) {
      return;
    }

    const byteLength = getUtf8ByteLength(item.data);
    if (byteLength > MAX_ITEM_BYTES) {
      return;
    }

    item.generation = currentGen;
    item.sessionId = sessionId;
    item.byteLength = byteLength;

    const list = this.recentResponses.get(tabId) || [];
    list.push(item);
    while (list.length > MAX_CACHE_PER_TAB) {
      list.shift();
    }
    let totalBytes = list.reduce((acc, cur) => acc + (cur.byteLength || 0), 0);
    while (list.length > 0 && totalBytes > MAX_TAB_TOTAL_BYTES) {
      const removed = list.shift();
      if (removed) totalBytes -= (removed.byteLength || 0);
    }
    this.recentResponses.set(tabId, list);
  }

  public findRecent(tabId: number, pattern: string, sessionId?: string): CapturedApiResponse | undefined {
    const list = this.recentResponses.get(tabId);
    if (!list) return undefined;
    const currentGen = this.getGeneration(tabId);
    const now = Date.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      if (item.generation !== undefined && item.generation !== currentGen) continue;
      if (now - item.timestamp > CACHE_TTL_MS) continue;
      // Strict session isolation: undefined matches only undefined, session matches only matching session
      if (item.sessionId !== sessionId) continue;
      if (this.matchesPattern(item.url, pattern)) return item;
    }
    return undefined;
  }

  public matchesPattern(url: string, pattern: string): boolean {
    if (!pattern || pattern === '*') return true;
    const clean = pattern.trim().toLowerCase();
    const targetUrl = url.toLowerCase();
    if (clean.includes('*')) {
      try {
        const escaped = clean.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        let regexStr = escaped;
        if (clean.startsWith('*') || /^[a-z]+:\/\//i.test(clean)) {
          regexStr = '^' + regexStr;
        } else if (clean.startsWith('/')) {
          regexStr = '(?:^|[a-z]+://[^/?#]+)' + regexStr;
        }

        if (clean.endsWith('*')) {
          regexStr = regexStr + '$';
        } else {
          regexStr = regexStr + '(?=[/?#]|$)';
        }

        return new RegExp(regexStr).test(targetUrl);
      } catch {
        return false;
      }
    }
    return targetUrl.includes(clean);
  }
  public clearTab(tabId: number): void {
    this.recentResponses.delete(tabId);
    this.tabGenerations.set(tabId, ++this.globalMonotonicGen);
  }
}

const apiInterceptorStore = new ApiInterceptorStore();

export function registerInterceptorTabListeners(targetChrome: any = typeof chrome !== 'undefined' ? chrome : undefined): void {
  if (!targetChrome) return;
  try {
    if (targetChrome.tabs?.onRemoved?.addListener) {
      targetChrome.tabs.onRemoved.addListener((tabId: number) => {
        apiInterceptorStore.clearTab(tabId);
      });
    }
    if (targetChrome.tabs?.onUpdated?.addListener) {
      targetChrome.tabs.onUpdated.addListener((tabId: number, changeInfo: any) => {
        if (changeInfo.status === 'loading' || changeInfo.url) {
          apiInterceptorStore.incrementGeneration(tabId);
        }
      });
    }
    if (targetChrome.debugger?.onDetach?.addListener) {
      targetChrome.debugger.onDetach.addListener((source: chrome.debugger.Debuggee) => {
        if (typeof source.tabId === 'number') {
          apiInterceptorStore.incrementGeneration(source.tabId);
        }
      });
    }
  } catch {}
}

registerInterceptorTabListeners();
export class InterceptApiTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.INTERCEPT_API;

  public matchesPattern(url: string, pattern: string): boolean {
    return apiInterceptorStore.matchesPattern(url, pattern);
  }

  public invalidateTab(tabId: number): void {
    apiInterceptorStore.incrementGeneration(tabId);
  }

  async execute(args: InterceptApiParams): Promise<ToolResult> {
    if (!args || !args.urlPattern || !args.urlPattern.trim()) {
      return createErrorResponse('urlPattern is required (e.g. "*/api/v1/data*")');
    }

    const sessionId = args.sessionId || args.sessionContext;
    let targetTab: chrome.tabs.Tab;
    try {
      if (typeof args.tabId === 'number') {
        const t = await this.tryGetTab(args.tabId, sessionId);
        if (!t || !t.id) return createErrorResponse('Tab not found');
        targetTab = t;
      } else {
        targetTab = await this.resolveAffinityTab({ tabId: args.tabId, sessionId });
      }
    } catch (e: any) {
      return createErrorResponse('Failed to resolve tab: ' + e.message);
    }

    const tabId = targetTab.id;
    if (typeof tabId !== 'number') return createErrorResponse('Invalid tab ID');

    const pattern = args.urlPattern.trim();
    const action = args.triggerAction || 'inspect_recent';
    const timeoutMs =
      typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 10000;

    if (action === 'inspect_recent') {
      const cached = apiInterceptorStore.findRecent(tabId, pattern, sessionId);
      if (cached) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, source: 'recent-cache', ...cached }, null, 2),
            },
          ],
          isError: false,
        };
      }
    }

    let listener:
      ((source: chrome.debugger.Debuggee, method: string, params?: any) => void) | null = null;
    let detachListener: ((source: chrome.debugger.Debuggee) => void) | null = null;
    let tabRemovedListener: ((removedTabId: number) => void) | null = null;
    let timeoutTimer: any = null;
    const fallbackTimers = new Map<string, any>();
    const inFlightReads = new Set<string>();
    const pendingFinishedReads = new Set<string>();
    let active = true;
    let resolved = false;
    let networkEnabledByUs = false;
    const currentGeneration = apiInterceptorStore.getGeneration(tabId);

    const cleanup = () => {
      active = false;
      fallbackTimers.forEach((t) => clearTimeout(t));
      fallbackTimers.clear();
      if (listener && typeof chrome !== 'undefined' && chrome.debugger?.onEvent?.removeListener) {
        try {
          chrome.debugger.onEvent.removeListener(listener);
          listener = null;
        } catch {}
      }
      if (detachListener && typeof chrome !== 'undefined' && chrome.debugger?.onDetach?.removeListener) {
        try {
          chrome.debugger.onDetach.removeListener(detachListener);
          detachListener = null;
        } catch {}
      }
      if (tabRemovedListener && typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.removeListener) {
        try {
          chrome.tabs.onRemoved.removeListener(tabRemovedListener);
          tabRemovedListener = null;
        } catch {}
      }
    };

    try {
      await cdpSessionManager.attach(tabId, 'intercept-api');
      await cdpSessionManager.enableDomain(tabId, 'Network');
      networkEnabledByUs = true;
      const capturePromise = new Promise<{
        success: boolean;
        item?: CapturedApiResponse;
        error?: string;
        status?: number;
        url?: string;
        requestId?: string;
      }>((resolve) => {
        const pendingResponses = new Map<
          string,
          { url: string; status: number; mimeType: string }
        >();

        const processBody = async (
          requestId: string,
          meta: { url: string; status: number; mimeType: string },
          fromFallback = false,
        ) => {
          if (!active || resolved || inFlightReads.has(requestId)) {
            if (inFlightReads.has(requestId) && !fromFallback) {
              pendingFinishedReads.add(requestId);
            }
            return;
          }
          inFlightReads.add(requestId);
          try {
            const bodyObj: any = await cdpSessionManager.sendCommand(
              tabId,
              'Network.getResponseBody',
              { requestId },
            );
            if (!active || resolved || apiInterceptorStore.getGeneration(tabId) !== currentGeneration) {
              return;
            }
            resolved = true;
            cleanup();
            let decoded = bodyObj?.body || '';
            if (bodyObj?.base64Encoded) {
              try {
                decoded = decodeBase64Utf8(decoded);
              } catch {}
            }
            let parsed: any = decoded;
            try {
              parsed = JSON.parse(decoded);
            } catch {}

            const item: CapturedApiResponse = {
              requestId,
              url: meta.url,
              status: meta.status,
              mimeType: meta.mimeType,
              timestamp: Date.now(),
              data: parsed,
            };
            apiInterceptorStore.addResponse(tabId, item, currentGeneration, sessionId);
            resolve({ success: true, item });
          } catch (e: any) {
            inFlightReads.delete(requestId);
            if (fromFallback && pendingFinishedReads.has(requestId)) {
              pendingFinishedReads.delete(requestId);
              // Singleflight re-trigger once upon loadingFinished arrival
              void processBody(requestId, meta, false);
              return;
            }
            if (!fromFallback) {
              if (!active || resolved || apiInterceptorStore.getGeneration(tabId) !== currentGeneration) {
                return;
              }
              resolved = true;
              cleanup();
              resolve({
                success: false,
                error: e.message || String(e),
                status: meta.status,
                url: meta.url,
                requestId,
              });
            }
          }
        };

        listener = async (source: chrome.debugger.Debuggee, method: string, params?: any) => {
          if (source.tabId !== tabId || !active || resolved) return;

          if (method === 'Page.frameNavigated' && !params?.frame?.parentId) {
            apiInterceptorStore.incrementGeneration(tabId);
            if (!active || resolved) return;
            resolved = true;
            cleanup();
            resolve({
              success: false,
              error: 'Navigation occurred before response was intercepted',
            });
            return;
          }

          if (method === 'Network.responseReceived' && params?.response && params?.requestId) {
            const respUrl = params.response.url || '';
            if (apiInterceptorStore.matchesPattern(respUrl, pattern)) {
              const meta = {
                url: respUrl,
                status: params.response.status,
                mimeType: params.response.mimeType || 'application/json',
              };
              pendingResponses.set(params.requestId, meta);

              const t = setTimeout(() => {
                if (active && !resolved && pendingResponses.has(params.requestId)) {
                  processBody(params.requestId, meta, true);
                }
              }, 80);
              fallbackTimers.set(params.requestId, t);
            }
            return;
          }

          if (method === 'Network.loadingFinished' && params?.requestId) {
            const meta = pendingResponses.get(params.requestId);
            if (!meta) return;
            const t = fallbackTimers.get(params.requestId);
            if (t) {
              clearTimeout(t);
              fallbackTimers.delete(params.requestId);
            }
            await processBody(params.requestId, meta, false);
            return;
          }

          if (method === 'Network.loadingFailed' && params?.requestId) {
            const meta = pendingResponses.get(params.requestId);
            if (!meta) return;
            const t = fallbackTimers.get(params.requestId);
            if (t) {
              clearTimeout(t);
              fallbackTimers.delete(params.requestId);
            }
            if (!active || resolved) return;
            resolved = true;
            cleanup();
            resolve({
              success: false,
              error: params.errorText || 'loadingFailed',
              status: meta.status,
              url: meta.url,
              requestId: params.requestId,
            });
          }
        };
        chrome.debugger.onEvent.addListener(listener);

        detachListener = (source: chrome.debugger.Debuggee) => {
          if (source.tabId === tabId && active && !resolved) {
            resolved = true;
            cleanup();
            resolve({
              success: false,
              error: 'Debugger detached before response was intercepted',
            });
          }
        };
        if (chrome.debugger?.onDetach?.addListener) {
          chrome.debugger.onDetach.addListener(detachListener);
        }

        tabRemovedListener = (removedId: number) => {
          if (removedId === tabId && active && !resolved) {
            resolved = true;
            cleanup();
            resolve({
              success: false,
              error: 'Tab closed before response was intercepted',
            });
          }
        };
        if (chrome.tabs?.onRemoved?.addListener) {
          chrome.tabs.onRemoved.addListener(tabRemovedListener);
        }
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          cleanup();
          reject(new Error('Timed out waiting for API response matching: ' + pattern));
        }, timeoutMs);
      });

      const outcome = await Promise.race([capturePromise, timeoutPromise]);
      clearTimeout(timeoutTimer);
      if (!outcome.success) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                source: 'live-intercept',
                status: outcome.status,
                url: outcome.url,
                requestId: outcome.requestId,
                error: outcome.error,
                data: { error: outcome.error },
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, source: 'live-intercept', ...outcome.item }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (e: any) {
      cleanup();
      clearTimeout(timeoutTimer);
      return createErrorResponse('API intercept failed: ' + e.message);
    } finally {
      cleanup();
      if (networkEnabledByUs) {
        await cdpSessionManager.disableDomain(tabId, 'Network').catch(() => {});
      }
      await cdpSessionManager.detach(tabId, 'intercept-api').catch(() => {});
    }
  }
}

export const interceptApiTool = new InterceptApiTool();
