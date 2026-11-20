import type { CallToolResult, ParsedCommand } from 'chrome-mcp-shared';
import {
  argumentCount,
  CommandError,
  integer,
  parseTarget,
  type CommandRun,
} from './command-utils';

type Fields = Record<string, unknown>;

function dataOf(result: CallToolResult): Fields {
  if (result.structuredContent) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Fields;
    } catch {
      // Markdown and image receipts are not inventories.
    }
  }
  return {};
}

function json(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    ...(data && typeof data === 'object' && !Array.isArray(data)
      ? { structuredContent: data as Fields }
      : {}),
    isError,
  };
}

function inventoryWindows(result: CallToolResult): Fields[] {
  const windows = dataOf(result).windows;
  return Array.isArray(windows)
    ? windows.filter(
        (item): item is Fields => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function inventoryFailure(result: CallToolResult) {
  const data = dataOf(result);
  return result.isError === true || data.success === false || data.ok === false;
}

function windowSummary(window: Fields) {
  return {
    windowId: window.windowId,
    focused: window.focused,
    state: window.state,
    bounds: window.bounds,
    tabCount: Array.isArray(window.tabs) ? window.tabs.length : 0,
  };
}

function taskScoped(command: ParsedCommand) {
  return typeof command.options.task === 'string';
}

function rejectTask(command: ParsedCommand, action: string) {
  if (taskScoped(command))
    throw new CommandError(
      `${action} cannot run inside a task. Use task-owned page commands instead.`,
    );
}

function limitOption(command: ParsedCommand, fallback: number, maximum = 200) {
  return command.options.limit === undefined
    ? fallback
    : integer(command.options.limit, 'Limit', 1, maximum);
}

function tabIds(command: ParsedCommand) {
  argumentCount(command, 1, 100);
  return command.operands.map((id) => integer(id, 'Tab ID'));
}

function withInventory(
  run: CommandRun,
  transform: (windows: Fields[]) => CallToolResult,
): Promise<CallToolResult> {
  return run('get_windows_and_tabs', {}, false).then((result) => {
    if (inventoryFailure(result)) return result;
    const windows = inventoryWindows(result);
    if (!Array.isArray(dataOf(result).windows))
      return json(
        { error: 'Browser inventory did not contain windows.', inventory: dataOf(result) },
        true,
      );
    return transform(windows);
  });
}

function truncateTextResult(result: CallToolResult, maxChars: number): CallToolResult {
  const textIndex = result.content.findIndex((block) => block.type === 'text');
  if (textIndex < 0) return result;
  const block = result.content[textIndex];
  if (block.type !== 'text') return result;
  const text = block.text.slice(0, maxChars);
  const truncated = text.length !== block.text.length;
  return {
    ...result,
    content: result.content.map((item, index) =>
      index === textIndex && item.type === 'text' ? { ...item, text } : item,
    ),
    structuredContent: {
      ...(result.structuredContent ?? {}),
      truncated,
      originalChars: block.text.length,
    },
  };
}

export function dispatchPage(
  command: ParsedCommand,
  run: CommandRun,
): Promise<CallToolResult> | undefined {
  const name = command.name as string;
  const { options } = command;
  const [first, second] = command.operands;

  if (name === 'tabs') {
    const limit = limitOption(command, 50);
    if (options.content) {
      argumentCount(command, 1, Infinity);
      return run(
        'chrome_page',
        {
          action: 'tabs_search',
          query: command.operands.join(' '),
          limit,
        },
        false,
      );
    }
    return withInventory(run, (windows) => {
      if (command.operands.length === 0)
        return {
          content: [{ type: 'text', text: JSON.stringify({ windows }) }],
          structuredContent: { windows },
        };

      const query = command.operands.join(' ').toLocaleLowerCase();
      const matches = windows.flatMap((window) =>
        (Array.isArray(window.tabs) ? window.tabs : [])
          .filter(
            (tab): tab is Fields => Boolean(tab) && typeof tab === 'object' && !Array.isArray(tab),
          )
          .filter((tab) =>
            `${String(tab.title ?? '')}\n${String(tab.url ?? '')}`
              .toLocaleLowerCase()
              .includes(query),
          )
          .map((tab) => ({ ...tab, windowId: tab.windowId ?? window.windowId })),
      );
      return json({
        query: command.operands.join(' '),
        count: Math.min(matches.length, limit),
        totalMatches: matches.length,
        truncated: matches.length > limit,
        tabs: matches.slice(0, limit),
      });
    });
  }

  if (name === 'window list') {
    argumentCount(command, 0);
    return withInventory(run, (windows) =>
      json({ windowCount: windows.length, windows: windows.map(windowSummary) }),
    );
  }

  if (name === 'window open') {
    argumentCount(command, 1);
    rejectTask(command, 'window open');
    return run(
      'chrome_navigate',
      {
        url: first,
        newWindow: true,
        background: Boolean(options.background),
        ...(options.width === undefined
          ? {}
          : { width: integer(options.width, 'Window width', 320, 10000) }),
        ...(options.height === undefined
          ? {}
          : { height: integer(options.height, 'Window height', 240, 10000) }),
      },
      false,
    );
  }

  if (name === 'window focus' || name === 'window close') {
    argumentCount(command, 1);
    rejectTask(command, name);
    return run(
      'chrome_page',
      {
        action: name === 'window focus' ? 'window_focus' : 'window_close',
        windowId: integer(first, 'Window ID'),
      },
      false,
    );
  }

  if (name === 'group list') {
    argumentCount(command, 0);
    return run(
      'chrome_tab_group_list',
      {
        ...(options.window === undefined ? {} : { windowId: integer(options.window, 'Window ID') }),
        ...(typeof options.title === 'string' ? { title: options.title } : {}),
      },
      false,
    );
  }

  if (name === 'group create') {
    rejectTask(command, name);
    if (options.group && options.window)
      throw new CommandError('Choose an existing --group or a --window for a new group.');
    return run(
      'chrome_tab_group_create',
      {
        tabIds: tabIds(command),
        ...(options.group === undefined ? {} : { groupId: integer(options.group, 'Group ID') }),
        ...(options.window === undefined ? {} : { windowId: integer(options.window, 'Window ID') }),
        ...(typeof options.title === 'string' ? { title: options.title } : {}),
        ...(typeof options.color === 'string' ? { color: options.color } : {}),
        ...(options.collapsed ? { collapsed: true } : {}),
      },
      false,
    );
  }

  if (name === 'group update') {
    argumentCount(command, 1);
    rejectTask(command, name);
    return run(
      'chrome_tab_group_update',
      {
        groupId: integer(first, 'Group ID'),
        ...(typeof options.title === 'string' ? { title: options.title } : {}),
        ...(typeof options.color === 'string' ? { color: options.color } : {}),
        ...(options.collapsed ? { collapsed: true } : {}),
      },
      false,
    );
  }

  if (name === 'group ungroup') {
    rejectTask(command, name);
    return run('chrome_tab_group_ungroup', { tabIds: tabIds(command) }, false);
  }

  if (name === 'group close') {
    argumentCount(command, 1);
    rejectTask(command, name);
    return run('chrome_tab_group_close', { groupId: integer(first, 'Group ID') }, false);
  }

  if (name === 'tab move') {
    argumentCount(command, 2);
    rejectTask(command, name);
    return run(
      'chrome_page',
      {
        action: 'tab_move',
        tabId: integer(first, 'Tab ID'),
        index: integer(second, 'Tab index', 0),
        ...(options.window === undefined ? {} : { windowId: integer(options.window, 'Window ID') }),
      },
      false,
    );
  }

  if (name === 'text') {
    argumentCount(command, 0, 1);
    const variants = [options.links, options.media, options.content].filter(Boolean).length;
    if (variants > 1) throw new CommandError('Select only one of --links, --media, or --content.');
    if (variants === 0) return;

    if (options.content) {
      argumentCount(command, 0);
      const result = run('chrome_get_markdown', { fit: true });
      return options['max-chars'] === undefined
        ? result
        : result.then((value) =>
            truncateTextResult(value, integer(options['max-chars'], 'Character limit')),
          );
    }

    if (options.links) {
      const target = first ? parseTarget(first) : {};
      if (target.coordinate)
        throw new CommandError('Link extraction requires a ref, css:SELECTOR, or no target.');
      return run('chrome_page', {
        action: 'text_links',
        ...target,
        limit: limitOption(command, 100, 500),
      });
    }

    argumentCount(command, 1);
    const target = parseTarget(first);
    if (!target.index && !target.selector)
      throw new CommandError('Media inspection requires an observed ref or css:SELECTOR.');
    return run('chrome_inspect_media', target);
  }

  if (name === 'scroll' && (options.until !== undefined || options.selector !== undefined)) {
    argumentCount(command, 0, 1);
    if (options.until !== undefined && options.selector !== undefined)
      throw new CommandError('Select either --until TEXT or --selector CSS.');
    const target = first ? parseTarget(first) : {};
    return run('chrome_smart_scroll', {
      until: {
        ...(typeof options.until === 'string' ? { query: options.until } : {}),
        ...(typeof options.selector === 'string' ? { selector: options.selector } : {}),
        ...(target.selector ? { containerSelector: target.selector } : {}),
        direction: options.up ? 'up' : 'down',
        ...(options.max === undefined
          ? {}
          : { maxSteps: integer(options.max, 'Maximum steps', 1, 1000) }),
        ...(options.step === undefined
          ? {}
          : { stepPx: integer(options.step, 'Step size', 1, 100000) }),
        ...(options.timeout === undefined
          ? {}
          : { timeoutMs: integer(options.timeout, 'Timeout', 1000, 60000) }),
        ...(options.regex ? { isRegex: true } : {}),
      },
    });
  }

  if (name === 'dismiss') {
    argumentCount(command, 0);
    return run('chrome_dismiss_overlay', {
      ...(options.max === undefined
        ? {}
        : { maxOverlays: integer(options.max, 'Overlay limit', 1, 50) }),
    });
  }

  return;
}
