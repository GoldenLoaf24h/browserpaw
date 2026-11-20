export const pageCommands = {
  tabs: {
    usage: 'tabs [QUERY...] [--content] [--limit N]',
    summary:
      'List windows and tabs or search titles and URLs. --content also searches loaded pages.',
    keywords: ['open tabs', 'search across tabs'],
  },
  'window list': {
    usage: 'window list',
    summary: 'List browser windows with explicit window IDs.',
  },
  'window open': {
    usage: 'window open URL [--width N] [--height N] [--background]',
    summary: 'Open a URL in a new browser window.',
  },
  'window focus': {
    usage: 'window focus ID',
    summary: 'Focus one explicitly identified browser window.',
  },
  'window close': {
    usage: 'window close ID',
    summary: 'Close one explicitly identified browser window.',
  },
  'group list': {
    usage: 'group list [--window ID] [--title TITLE]',
    summary: 'List tab groups and their explicit tab IDs.',
  },
  'group create': {
    usage:
      'group create TAB... [--group ID] [--window ID] [--title TITLE] [--color COLOR] [--collapsed]',
    summary: 'Create a tab group from explicitly named tabs, or add them to --group ID.',
  },
  'group update': {
    usage: 'group update ID [--title TITLE] [--color COLOR] [--collapsed]',
    summary: 'Update one explicitly identified tab group.',
  },
  'group ungroup': {
    usage: 'group ungroup TAB...',
    summary: 'Remove explicitly named tabs from their groups without closing them.',
  },
  'group close': {
    usage: 'group close ID',
    summary: 'Close agent-owned tabs in one explicitly identified tab group.',
  },
  'tab move': {
    usage: 'tab move TAB INDEX [--window ID]',
    summary: 'Move one explicitly identified tab to a zero-based index.',
  },
  text: {
    usage: 'text [TARGET] [--links|--media|--content] [--max-chars N] [--limit N]',
    summary:
      'Read page text, extract the main content, list links, or inspect one image or media element.',
    keywords: ['page text extraction', 'extract hyperlinks', 'inspect media'],
  },
  select: {
    usage: 'select TARGET [VALUE...]',
    summary: 'List available choices or select by value.',
  },
  scroll: {
    usage:
      'scroll [TARGET] [--up|--down|--top|--bottom] [--by PX] [--until TEXT|--selector CSS] [--max N] [--step PX] [--timeout MS] [--regex]',
    summary: 'Scroll the page or a scroll container, optionally until text or a selector is found.',
  },
  dismiss: {
    usage: 'dismiss [--max N]',
    summary: 'Dismiss visible overlays on the selected page.',
  },
} as const;
