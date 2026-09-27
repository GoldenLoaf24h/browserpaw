import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

/**
 * Read Web Storage / cookie state for the current tab.
 *
 * localStorage and sessionStorage live in the page's origin, so they are read
 * through the in-page engine. Cookies need the chrome.cookies permission
 * because document.cookie cannot see HttpOnly cookies, which are usually the
 * ones worth inspecting on a logged-in session.
 */
export interface StorageParams {
  /** Which stores to read. Defaults to all three. */
  types?: Array<'localStorage' | 'sessionStorage' | 'cookies'>;
  /** Only return entries whose key or value matches this substring (case-insensitive). */
  filter?: string;
  /** Cap on returned entries per store (default 200). */
  limit?: number;
  /** Include HttpOnly cookies (default true). */
  includeHttpOnly?: boolean;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

const DEFAULT_LIMIT = 200;
const MAX_VALUE_CHARS = 2000;

export class StorageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.STORAGE;

  async execute(args: StorageParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id || !tab.url) {
        return createErrorResponse('No active tab found for chrome_storage');
      }

      const types =
        Array.isArray(args.types) && args.types.length > 0
          ? args.types
          : (['localStorage', 'sessionStorage', 'cookies'] as const);
      const filter = String(args.filter ?? '').toLowerCase();
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : DEFAULT_LIMIT;

      const result: Record<string, any> = { url: tab.url, title: tab.title };

      if (types.includes('localStorage') || types.includes('sessionStorage')) {
        const wanted = (['localStorage', 'sessionStorage'] as const).filter((k) =>
          types.includes(k),
        );
        const frameResults = await this.safeExecuteScript<any[]>(tab.id, {
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: (kinds: string[], flt: string, lim: number, maxChars: number) => {
            const out: Record<string, any> = {};
            for (const kind of kinds) {
              let store: Storage;
              try {
                store = kind === 'localStorage' ? window.localStorage : window.sessionStorage;
              } catch (error) {
                out[kind] = { available: false, error: String(error), entries: [], total: 0 };
                continue;
              }
              const entries: Array<{ key: string; value: string; truncated?: boolean }> = [];
              let total = 0;
              for (let i = 0; i < store.length; i++) {
                const key = store.key(i);
                if (key === null) continue;
                const raw = store.getItem(key) ?? '';
                if (flt && !key.toLowerCase().includes(flt) && !raw.toLowerCase().includes(flt)) {
                  continue;
                }
                total += 1;
                if (entries.length >= lim) continue;
                entries.push({
                  key,
                  value: raw.length > maxChars ? raw.slice(0, maxChars) : raw,
                  ...(raw.length > maxChars ? { truncated: true } : {}),
                });
              }
              out[kind] = { available: true, entries, total };
            }
            return out;
          },
          args: [wanted as unknown as string[], filter, limit, MAX_VALUE_CHARS],
        });
        Object.assign(result, frameResults?.[0]?.result ?? {});
      }

      if (types.includes('cookies')) {
        const isHttpUrl = tab.url && /^(?:https?|file):/i.test(tab.url);
        const cookies = isHttpUrl ? await chrome.cookies.getAll({ url: tab.url }) : [];
        // S5: default to HIDING HttpOnly values. chrome.cookies can read them,
        // but echoing raw session cookie values into agent transcripts is an
        // unnecessary exfiltration channel; the metadata (name/domain/httpOnly
        // flags) is what tooling usually needs. valueIncluded: false marks the
        // redaction; explicit includeHttpOnly: true opts back in.
        const includeHttpOnly = args.includeHttpOnly !== false;
        const revealHttpOnlyValues = args.includeHttpOnly === true;
        const filtered = cookies.filter((c) => {
          if (!includeHttpOnly && c.httpOnly) return false;
          if (!filter) return true;
          const matchesName = c.name.toLowerCase().includes(filter);
          const matchesDomain = (c.domain || '').toLowerCase().includes(filter);
          const matchesValue =
            (revealHttpOnlyValues || !c.httpOnly) && (c.value || '').toLowerCase().includes(filter);
          return matchesName || matchesDomain || matchesValue;
        });
        const entries = filtered.slice(0, limit).map((c) => ({
          name: c.name,
          ...(c.httpOnly && !revealHttpOnlyValues
            ? { valueIncluded: false }
            : {
                value:
                  (c.value || '').length > MAX_VALUE_CHARS
                    ? (c.value || '').slice(0, MAX_VALUE_CHARS)
                    : c.value || '',
                ...((c.value || '').length > MAX_VALUE_CHARS ? { truncated: true } : {}),
              }),
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          session: c.session,
          expirationDate: c.expirationDate,
        }));
        result.cookies = { available: true, entries, total: filtered.length };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_storage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const storageTool = new StorageTool();
