import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { executeInPage } from './in-page-engine';
import { scrubUrl } from '@/utils/url-sanitizer';

export interface PageToolParams {
  action: 'window_focus' | 'window_close' | 'tab_move' | 'text_links' | 'tabs_search';
  query?: string;
  windowId?: number;
  tabId?: number;
  index?: number;
  selector?: string;
  limit?: number;
  sameOriginOnly?: boolean;
  includeEmptyHref?: boolean;
  sessionId?: string;
  sessionContext?: string;
}

function positiveInteger(value: unknown, label: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  return value;
}

export class PageTool extends BaseBrowserToolExecutor {
  name = 'chrome_page';

  async execute(args: PageToolParams): Promise<ToolResult> {
    try {
      if (args.action === 'tabs_search') {
        const query = args.query?.trim().toLowerCase();
        if (!query) return createErrorResponse('Enter text to search.');
        const tabs = await chrome.tabs.query({});
        const eligible = tabs.filter(
          (tab) => !tab.discarded && /^https?:\/\//i.test(tab.url ?? ''),
        );
        const scanned = eligible.slice(0, 50);
        const snippets = new Map<number, string>();
        let skipped = tabs.length - scanned.length;
        for (let i = 0; i < scanned.length; i += 6) {
          await Promise.all(
            scanned.slice(i, i + 6).map(async (tab) => {
              if (!tab.id) return;
              try {
                const [execution] = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: (needle, url) => {
                    if (location.href !== url) return null;
                    const text = (document.body?.innerText ?? '').slice(0, 128000);
                    const offset = text.toLowerCase().indexOf(needle);
                    return offset < 0 ? '' : text.slice(Math.max(0, offset - 50), offset + 160);
                  },
                  args: [query, tab.url ?? ''],
                });
                if (execution?.result == null) skipped++;
                else if (execution.result) snippets.set(tab.id, execution.result);
              } catch {
                skipped++;
              }
            }),
          );
        }
        const matches = tabs.flatMap((tab) => {
          if (!tab.id) return [];
          const url = scrubUrl(tab.url ?? '');
          const snippet = snippets.get(tab.id);
          return snippet || `${tab.title ?? ''}\n${url}`.toLowerCase().includes(query)
            ? [{ tabId: tab.id, windowId: tab.windowId, title: tab.title, url, snippet }]
            : [];
        });
        const limit = args.limit ?? 50;
        return {
          content: [],
          isError: false,
          structuredContent: {
            tabs: matches.slice(0, limit),
            totalMatches: matches.length,
            scanned: scanned.length,
            skipped,
            truncated: matches.length > limit || eligible.length > scanned.length,
          },
        };
      }
      if (args.action === 'window_focus') {
        const windowId = positiveInteger(args.windowId, 'windowId');
        const window = await chrome.windows.update(windowId, { focused: true });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, action: args.action, windowId, window }),
            },
          ],
          isError: false,
        };
      }

      if (args.action === 'window_close') {
        const windowId = positiveInteger(args.windowId, 'windowId');
        await chrome.windows.remove(windowId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, action: args.action, windowId }),
            },
          ],
          isError: false,
        };
      }

      if (args.action === 'tab_move') {
        const tabId = positiveInteger(args.tabId, 'tabId');
        const index = positiveInteger(args.index, 'index', 0);
        const windowId =
          args.windowId === undefined ? undefined : positiveInteger(args.windowId, 'windowId');
        const tab = await chrome.tabs.move(tabId, {
          index,
          ...(windowId === undefined ? {} : { windowId }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, action: args.action, tab }),
            },
          ],
          isError: false,
        };
      }

      if (args.action === 'text_links') {
        const tab = await this.resolveAffinityTab({
          tabId: args.tabId,
          sessionId: args.sessionId || args.sessionContext,
        });
        if (typeof tab.id !== 'number') return createErrorResponse('No target tab found.');
        const limit = args.limit === undefined ? 100 : positiveInteger(args.limit, 'limit');
        if (limit > 500) throw new Error('limit must not exceed 500');
        const links =
          (
            await executeInPage<
              Array<{ url: string; text: string; internal: boolean; nofollow: boolean }>
            >({ tabId: tab.id }, 'inPageGetLinks', [
              {
                ...(args.index === undefined
                  ? {}
                  : { index: positiveInteger(args.index, 'index') }),
                ...(args.selector ? { selector: args.selector } : {}),
                sameOriginOnly: args.sameOriginOnly === true,
                includeEmptyHref: args.includeEmptyHref === true,
              },
            ])
          )?.[0]?.result ?? [];
        const bounded = links.slice(0, limit);
        const data = {
          success: true,
          tabId: tab.id,
          count: bounded.length,
          totalCount: links.length,
          truncated: links.length > bounded.length,
          links: bounded,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
          isError: false,
        };
      }

      return createErrorResponse(`Unsupported chrome_page action: ${String(args.action)}`);
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_page: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const pageTool = new PageTool();
