export const dataCommands = {
  'history search': {
    usage: 'history search [QUERY] [--since T] [--until T] [--limit N]',
    summary: 'Find visited pages by text and time.',
  },
  'history visits': {
    usage: 'history visits URL [--since T] [--until T] [--limit N]',
    summary: 'Read individual visits to an exact URL.',
  },
  'history top': {
    usage: 'history top [--since T] [--until T] [--limit N]',
    summary: 'Rank hosts by visits among up to 200 recently matching URLs.',
  },
  'history rm': {
    usage: 'history rm [URL...] [--since T] [--until T] [--yes]',
    summary: 'Remove exact URLs or a bounded time range with both dates and --yes.',
  },
  'bookmark tree': {
    usage: 'bookmark tree [--folder ID_OR_PATH]',
    summary: 'List the bookmark tree or one folder subtree.',
  },
  'bookmark search': {
    usage: 'bookmark search QUERY [--limit N]',
    summary: 'Find bookmarks and folders by title or URL.',
  },
  'bookmark add': {
    usage: 'bookmark add URL [--title TITLE] [--folder ID_OR_PATH]',
    summary: 'Add a URL to the selected bookmark folder.',
  },
  'bookmark mkdir': {
    usage: 'bookmark mkdir PATH [--folder ID_OR_PATH]',
    summary: 'Create folders under an existing root or selected folder.',
  },
  'bookmark mv': {
    usage: 'bookmark mv ID --folder ID_OR_PATH [--index N]',
    summary: 'Move a bookmark or folder to an explicit destination.',
  },
  'bookmark rename': { usage: 'bookmark rename ID TITLE', summary: 'Rename a bookmark or folder.' },
  'bookmark rm': {
    usage: 'bookmark rm ID... [--recursive]',
    summary: 'Remove selected entries. Nonempty folders require --recursive.',
  },
  'bookmark dedupe': {
    usage: 'bookmark dedupe [--folder ID_OR_PATH] [--apply]',
    summary: 'Preview exact duplicate URLs within each folder. --apply requires --folder.',
  },
  'bookmark export': {
    usage: 'bookmark export --out FILE [--folder ID_OR_PATH] [--format FORMAT]',
    summary: 'Write a JSON or Chrome-importable HTML backup.',
  },
  'downloads list': {
    usage: 'downloads list [--limit N] [--state STATE]',
    summary: 'List recent Chrome downloads, optionally by state.',
  },
  'downloads reveal': {
    usage: 'downloads reveal ID',
    summary: 'Show a completed download in the OS file manager.',
  },
  'downloads rm': {
    usage: 'downloads rm ID [--file]',
    summary: 'Erase one download record. --file also removes the downloaded file.',
  },
  'storage get': {
    usage: 'storage get [KEY] [--session]',
    summary: 'Read an entry or list keys in the selected page storage.',
  },
  'storage set': {
    usage: 'storage set KEY VALUE [--session]',
    summary: 'Write one string into the selected page storage.',
  },
  'storage rm': {
    usage: 'storage rm KEY [--session]',
    summary: 'Remove one entry from the selected page storage.',
  },
  'storage clear': {
    usage: 'storage clear [--session]',
    summary: 'Clear the selected page origin and storage area.',
  },
  'cookies list': {
    usage: 'cookies list [--url URL|--domain DOMAIN] [--values] [--limit N]',
    summary: 'List unpartitioned cookies in the default store. Values require an explicit scope.',
  },
  'cookies set': {
    usage:
      'cookies set URL NAME VALUE [--path PATH] [--secure] [--http-only] [--same-site MODE] [--expires T]',
    summary: 'Set a host-only cookie in the default store.',
  },
  'cookies rm': {
    usage: 'cookies rm URL NAME',
    summary: 'Remove the unpartitioned cookie selected by Chrome for this URL and name.',
  },
} as const;
