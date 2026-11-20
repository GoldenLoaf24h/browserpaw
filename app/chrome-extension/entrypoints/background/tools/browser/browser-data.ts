import { createErrorResponse, type ToolResult } from '@/common/tool-handler';

function result(data: Record<string, unknown>): ToolResult {
  return { content: [], structuredContent: data, isError: false };
}

async function removeEach(ids: string[], remove: (id: string) => Promise<void>) {
  const removed: string[] = [];
  for (const id of ids) {
    try {
      await remove(id);
      removed.push(id);
    } catch (error) {
      return {
        ...result({ success: false, removed, failedId: id, error: String(error) }),
        isError: true,
      };
    }
  }
  return result({ removed });
}

export const historyTool = {
  name: 'chrome_history',
  async execute(args: {
    action: string;
    since?: number;
    until?: number;
    limit?: number;
    query?: string;
    url?: string;
    urls?: string[];
  }): Promise<ToolResult> {
    const { action, since, until, limit = 50 } = args;
    if (action === 'rm') {
      if (since !== undefined && until !== undefined && since < until) {
        await chrome.history.deleteRange({ startTime: since, endTime: until });
        return result({ since, until });
      }
      if (!args.urls?.length)
        return createErrorResponse('Select exact URLs or a bounded time range.');
      return removeEach(args.urls, (url) => chrome.history.deleteUrl({ url }));
    }
    const endTime = until ?? Date.now();
    const startTime =
      since ??
      (action === 'visits' ? 0 : Math.max(0, endTime - (action === 'top' ? 7 : 1) * 86400000));
    const visitsWithinRange = async (url: string) =>
      (await chrome.history.getVisits({ url })).filter(
        ({ visitTime }) =>
          visitTime !== undefined && visitTime >= startTime && visitTime <= endTime,
      );
    if (action === 'visits' && args.url) {
      const visits = await visitsWithinRange(args.url);
      return result({
        url: args.url,
        visits: visits.sort((a, b) => (b.visitTime ?? 0) - (a.visitTime ?? 0)).slice(0, limit),
        startTime,
        endTime,
        truncated: visits.length > limit,
      });
    }
    if (action !== 'search' && action !== 'top')
      return createErrorResponse('Unknown history action.');
    const maxResults = action === 'top' ? 201 : limit + 1;
    const items = await chrome.history.search({
      text: args.query ?? '',
      startTime,
      endTime,
      maxResults,
    });
    if (action === 'search')
      return result({
        items: items.slice(0, limit),
        startTime,
        endTime,
        truncated: items.length >= maxResults,
      });

    // Count visits inside the range. HistoryItem.visitCount is an all-time total.
    const selected = items.slice(0, 200);
    const domains = new Map<string, { domain: string; visits: number; lastVisit: number }>();
    for (let index = 0; index < selected.length; index += 10) {
      await Promise.all(
        selected.slice(index, index + 10).map(async ({ url }) => {
          if (!url) return;
          const domain = URL.parse(url)?.hostname;
          if (!domain) return;
          const visits = await visitsWithinRange(url);
          if (!visits.length) return;
          const row = domains.get(domain) ?? { domain, visits: 0, lastVisit: 0 };
          row.visits += visits.length;
          for (const entry of visits) row.lastVisit = Math.max(row.lastVisit, entry.visitTime ?? 0);
          domains.set(domain, row);
        }),
      );
    }
    return result({
      domains: [...domains.values()]
        .sort((a, b) => b.visits - a.visits || a.domain.localeCompare(b.domain))
        .slice(0, limit),
      sampledUrls: selected.length,
      truncated: items.length >= maxResults,
      startTime,
      endTime,
    });
  },
};

type Bookmark = chrome.bookmarks.BookmarkTreeNode;

async function childFolder(parentId: string, title: string) {
  const matches = (await chrome.bookmarks.getChildren(parentId)).filter(
    (node) => !node.url && node.title === title,
  );
  if (matches.length > 1) throw new Error('Bookmark folder path is ambiguous. Use its ID.');
  return matches[0];
}

async function folderId(folder: string) {
  if (!folder.startsWith('/')) {
    const [node] = await chrome.bookmarks.get(folder);
    if (!node || node.url) throw new Error('Expected a bookmark folder ID.');
    return node.id;
  }
  const [root] = await chrome.bookmarks.getTree();
  let id = root.id;
  for (const part of folder.split('/').filter(Boolean)) {
    const child = await childFolder(id, part);
    if (!child) throw new Error('Bookmark folder not found: ' + folder);
    id = child.id;
  }
  return id;
}

export function bookmarkDuplicates(nodes: Bookmark[]) {
  const groups: { folderId?: string; url: string; keep: string; remove: string[] }[] = [];
  function walk(children: Bookmark[]) {
    const byUrl = new Map<string, Bookmark[]>();
    for (const child of children) {
      if (child.children) walk(child.children);
      if (!child.url) continue;
      const matches = byUrl.get(child.url) ?? [];
      matches.push(child);
      byUrl.set(child.url, matches);
    }
    for (const [url, entries] of byUrl) {
      if (entries.length < 2) continue;
      const [keep, ...duplicates] = entries
        .slice()
        .sort((a, b) => (a.dateAdded ?? Infinity) - (b.dateAdded ?? Infinity));
      groups.push({
        folderId: keep.parentId,
        url,
        keep: keep.id,
        remove: duplicates.map((node) => node.id),
      });
    }
  }
  walk(nodes);
  return groups;
}

function bookmarkHtml(nodes: Bookmark[]): string {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
    );
  const tree = (entries: Bookmark[]): string =>
    '<DL><p>\n' +
    entries
      .map((item) =>
        item.url
          ? '<DT><A HREF="' + escape(item.url) + '">' + escape(item.title) + '</A>\n'
          : '<DT><H3>' + escape(item.title) + '</H3>\n' + tree(item.children ?? []),
      )
      .join('') +
    '</DL><p>\n';
  return (
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n' +
    tree(nodes)
  );
}

export const bookmarksTool = {
  name: 'chrome_bookmarks',
  async execute(args: {
    action: string;
    folder?: string;
    id?: string;
    ids?: string[];
    url?: string;
    title?: string;
    path?: string;
    index?: number;
    limit?: number;
    query?: string;
    recursive?: boolean;
    apply?: boolean;
    format?: 'html' | 'json';
  }): Promise<ToolResult> {
    const { action, id, title } = args;
    const api = chrome.bookmarks;
    const parentId = args.folder === undefined ? undefined : await folderId(args.folder);
    switch (action) {
      case 'search': {
        const items = await api.search(args.query ?? '');
        const limit = args.limit ?? 50;
        return result({ items: items.slice(0, limit), truncated: items.length > limit });
      }
      case 'add':
        if (!args.url) return createErrorResponse('Expected a bookmark URL.');
        return result({ bookmark: await api.create({ parentId, title, url: args.url }) });
      case 'mkdir': {
        const parts = args.path?.split('/').filter(Boolean) ?? [];
        if (!parts.length) return createErrorResponse('Expected a nonempty folder path.');
        let parent = parentId;
        if (args.path?.startsWith('/')) {
          if (parent !== undefined || parts.length < 2)
            return createErrorResponse(
              'Absolute paths start at an existing Chrome folder. Omit --folder.',
            );
          parent = await folderId('/' + parts.shift());
        }
        const created: string[] = [];
        for (const name of parts) {
          try {
            const existing = parent === undefined ? undefined : await childFolder(parent, name);
            const node: Bookmark =
              existing ?? (await api.create({ parentId: parent, title: name }));
            if (!existing) created.push(node.id);
            parent = node.id;
          } catch (error) {
            return { ...result({ success: false, created, error: String(error) }), isError: true };
          }
        }
        return result({ id: parent, created });
      }
      case 'mv':
        if (!id || !parentId) return createErrorResponse('Select a bookmark and destination.');
        return result({ bookmark: await api.move(id, { parentId, index: args.index }) });
      case 'rename':
        if (!id || title === undefined) return createErrorResponse('Select a bookmark and title.');
        return result({ bookmark: await api.update(id, { title }) });
      case 'rm': {
        if (!args.ids?.length) return createErrorResponse('Select bookmark IDs.');
        const [first, ...rest] = args.ids;
        const nodes = await api.get([first, ...rest]);
        if (nodes.some((node) => !node.parentId || node.parentId === '0' || node.unmodifiable))
          return createErrorResponse('Chrome root and managed folders cannot be removed.');
        // Do not delete a child again after removing one of its ancestors.
        const selected = new Set(args.ids);
        const ids: string[] = [];
        for (const node of nodes) {
          let parent = node.parentId;
          while (args.recursive && parent && parent !== '0' && !selected.has(parent)) {
            const [ancestor] = await api.get(parent);
            parent = ancestor?.parentId;
          }
          if (!args.recursive || !parent || !selected.has(parent)) ids.push(node.id);
          if (!args.recursive && !node.url && (await api.getChildren(node.id)).length)
            return createErrorResponse('Nonempty folders require --recursive.');
        }
        return removeEach(ids, (target) =>
          args.recursive ? api.removeTree(target) : api.remove(target),
        );
      }
      case 'tree':
      case 'dedupe':
      case 'export': {
        const nodes = parentId === undefined ? await api.getTree() : await api.getSubTree(parentId);
        if (action === 'tree') return result({ nodes });
        if (action === 'export') {
          const html = args.format === 'html';
          const body = html
            ? bookmarkHtml(nodes[0]?.id === '0' ? (nodes[0].children ?? []) : nodes)
            : JSON.stringify(nodes, null, 2) + '\n';
          return {
            ...result({ format: html ? 'html' : 'json' }),
            content: [{ type: 'text', text: body }],
          };
        }
        const groups = bookmarkDuplicates(nodes);
        if (!args.apply) return result({ groups });
        if (!parentId || parentId === '0')
          return createErrorResponse('Apply deduplication to a specific non-root folder.');
        return removeEach(
          groups.flatMap((group) => group.remove),
          (id) => api.remove(id),
        );
      }
      default:
        return createErrorResponse('Unknown bookmark action.');
    }
  },
};

export const downloadsTool = {
  name: 'chrome_downloads',
  async execute(args: {
    action: string;
    id?: number;
    file?: boolean;
    limit?: number;
    state?: 'in_progress' | 'interrupted' | 'complete';
  }): Promise<ToolResult> {
    const api = chrome.downloads;
    if (args.action === 'list') {
      const limit = args.limit ?? 50;
      const items = await api.search({
        state: args.state,
        orderBy: ['-startTime'],
        limit: limit + 1,
      });
      return result({ items: items.slice(0, limit), truncated: items.length > limit });
    }
    if (typeof args.id !== 'number') return createErrorResponse('Select a download ID.');
    const id = args.id;
    const [item] = await api.search({ id });
    if (!item) return createErrorResponse('Download not found.');
    if (args.action === 'reveal') {
      if (item.state !== 'complete' || !item.exists)
        return createErrorResponse('The downloaded file is unavailable.');
      api.show(id);
      return result({ id, revealRequested: true });
    }
    if (args.action !== 'rm') return createErrorResponse('Unknown downloads action.');
    if (args.file) await api.removeFile(id);
    try {
      const erased = await api.erase({ id });
      return result({ id, erased, fileRemoved: !!args.file });
    } catch (error) {
      return {
        ...result({ success: false, id, fileRemoved: !!args.file, error: String(error) }),
        isError: true,
      };
    }
  },
};

function cookieSummary({ value: _value, ...metadata }: chrome.cookies.Cookie) {
  return metadata;
}

export const cookiesTool = {
  name: 'chrome_cookies',
  async execute(args: {
    action: string;
    url?: string;
    domain?: string;
    name?: string;
    value?: string;
    values?: boolean;
    limit?: number;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: chrome.cookies.SameSiteStatus;
    expirationDate?: number;
  }): Promise<ToolResult> {
    const { action, url, domain, name, value, path, secure, httpOnly, sameSite, expirationDate } =
      args;
    if (action === 'list') {
      const items = await chrome.cookies.getAll({ url, domain });
      const limit = args.limit ?? 50;
      return result({
        items: items
          .slice(0, limit)
          .map((cookie) => (args.values ? cookie : cookieSummary(cookie))),
        truncated: items.length > limit,
      });
    }
    if (!url || !name) return createErrorResponse('Select a URL and cookie name.');
    if (action === 'rm') return result({ removed: await chrome.cookies.remove({ url, name }) });
    if (action !== 'set' || value === undefined)
      return createErrorResponse('Expected a cookie value.');
    const item = await chrome.cookies.set({
      url,
      name,
      value,
      path,
      secure,
      httpOnly,
      sameSite,
      expirationDate,
    });
    return item
      ? result({ cookie: cookieSummary(item) })
      : createErrorResponse('Chrome did not set the cookie.');
  },
};

export const storageTool = {
  name: 'chrome_storage',
  async execute(args: {
    action: string;
    area: 'local' | 'session';
    tabId?: number;
    key?: string;
    value?: string;
  }): Promise<ToolResult> {
    const { tabId, action, area, key, value } = args;
    if (typeof tabId !== 'number') return createErrorResponse('Select a page for storage.');
    const document = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    const origin = document?.url && URL.parse(document.url)?.origin;
    if (!document?.documentId || !origin || origin === 'null')
      return createErrorResponse('Storage requires a verifiable page origin.');
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [document.documentId] },
      world: 'MAIN',
      func: (expected, area, action, key, value) => {
        if (location.origin !== expected) return null;
        const store = area === 'session' ? sessionStorage : localStorage;
        if (action === 'get')
          return key === null ? { keys: Object.keys(store) } : { key, value: store.getItem(key) };
        if (action === 'clear') store.clear();
        else if (action === 'rm' && key !== null) store.removeItem(key);
        else if (action === 'set' && key !== null && value !== null) store.setItem(key, value);
        else return null;
        return key === null ? { changed: true } : { changed: true, key };
      },
      args: [origin, area, action, key ?? null, value ?? null],
    });
    if (execution?.result === null)
      return createErrorResponse('The selected document changed before the storage action.');
    if (!execution?.result)
      return {
        ...result({
          success: false,
          status: action === 'get' ? 'failed' : 'unknown',
          requestDispatched: true,
          retry: false,
          error: 'Chrome returned no storage receipt.',
        }),
        isError: true,
      };
    return result({ origin, area, ...execution.result });
  },
};
