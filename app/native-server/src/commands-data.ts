import type { ParsedCommand } from 'chrome-mcp-shared';
import { argumentCount, CommandError, integer, type CommandRun } from './command-utils';

export const profileCommands = new Set(['history', 'bookmark', 'downloads', 'cookies']);

export function time(value: string, now = Date.now(), direction: 1 | -1 = -1) {
  const relative = /^(\d+)([mhdw])$/.exec(value);
  const result = relative
    ? now +
      direction *
        Number(relative[1]) *
        { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[relative[2]]!
    : /^\d+$/.test(value)
      ? Number(value)
      : /^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
        ? Date.parse(value)
        : NaN;
  if (!Number.isSafeInteger(result) || result < 0 || result > 8640000000000000)
    throw new CommandError('Use an ISO date, epoch milliseconds, or a relative time such as 7d.');
  return result;
}

function webUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommandError('Expected an absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new CommandError('Expected an HTTP or HTTPS URL without credentials.');
  return url.href;
}

export function dispatchData(command: ParsedCommand, run: CommandRun) {
  const [group, action] = command.name.split(' ');
  if (!profileCommands.has(group) && group !== 'storage') return;
  const { operands, options } = command;
  const [first, second, third] = operands;
  const limit = (max = 200) =>
    options.limit === undefined ? 50 : integer(options.limit, 'Limit', 1, max);
  if (profileCommands.has(group) && (options.task || options.tab || options.frame))
    throw new CommandError(
      'This command applies to the browser profile. Omit --task, --tab and --frame.',
    );
  if (group === 'history') {
    const now = Date.now();
    const since = typeof options.since === 'string' ? time(options.since, now) : undefined;
    const until = typeof options.until === 'string' ? time(options.until, now) : undefined;
    if (since !== undefined && since >= (until ?? now))
      throw new CommandError('The start time must be before the end time.');
    if (action === 'rm') {
      if (since !== undefined || until !== undefined) {
        argumentCount(command, 0);
        if (since === undefined || until === undefined || !options.yes)
          throw new CommandError('Specify both --since and --until with --yes for range removal.');
        return run('chrome_history', { action, since, until }, false);
      }
      argumentCount(command, 1, 100);
      return run('chrome_history', { action, urls: operands.map(webUrl) }, false);
    }
    if (action === 'visits') argumentCount(command, 1);
    if (action === 'top') argumentCount(command, 0);
    return run(
      'chrome_history',
      {
        action,
        since,
        until,
        limit: limit(),
        ...(action === 'visits' ? { url: webUrl(first) } : { query: operands.join(' ') }),
      },
      false,
    );
  }
  if (group === 'bookmark') {
    const folder = options.folder;
    const job = (fields: Record<string, unknown> = {}) =>
      run('chrome_bookmarks', { action, folder, ...fields }, false);
    switch (action) {
      case 'tree':
        argumentCount(command, 0);
        return job();
      case 'search':
        argumentCount(command, 1, Infinity);
        return job({ query: operands.join(' '), limit: limit() });
      case 'add':
        argumentCount(command, 1);
        return job({ url: webUrl(first), title: options.title });
      case 'mkdir':
        argumentCount(command, 1);
        return job({ path: first });
      case 'mv':
        argumentCount(command, 1);
        if (!folder) throw new CommandError('Specify a destination with --folder.');
        return job({
          id: first,
          index: options.index === undefined ? undefined : integer(options.index, 'Index', 0),
        });
      case 'rename':
        argumentCount(command, 2);
        return job({ id: first, title: second });
      case 'rm':
        argumentCount(command, 1, 100);
        return job({ ids: [...new Set(operands)], recursive: !!options.recursive });
      case 'dedupe':
        argumentCount(command, 0);
        if (options.apply && !folder)
          throw new CommandError('Specify --folder when applying bookmark deduplication.');
        return job({ apply: !!options.apply });
      case 'export':
        argumentCount(command, 0);
        if (!options.out || (options.format && !['json', 'html'].includes(String(options.format))))
          throw new CommandError('Specify --out FILE and use format json or html.');
        return job({ format: options.format ?? 'json' });
    }
  }
  if (group === 'downloads') {
    if (action === 'list') {
      argumentCount(command, 0);
      if (
        options.state &&
        !['in_progress', 'interrupted', 'complete'].includes(String(options.state))
      )
        throw new CommandError('Use state in_progress, interrupted, or complete.');
      return run('chrome_downloads', { action, limit: limit(), state: options.state }, false);
    }
    argumentCount(command, 1);
    return run(
      'chrome_downloads',
      { action, id: integer(first, 'Download ID', 0), file: !!options.file },
      false,
    );
  }
  if (group === 'cookies') {
    const job = (fields: Record<string, unknown>) =>
      run('chrome_cookies', { action, ...fields }, false);
    if (action === 'list') {
      argumentCount(command, 0);
      if ((options.url && options.domain) || (options.values && !options.url && !options.domain))
        throw new CommandError('Choose one URL or domain. --values requires a scope.');
      if (
        typeof options.domain === 'string' &&
        !/^\.?[\p{L}\d-]+(?:\.[\p{L}\d-]+)*$/u.test(options.domain)
      )
        throw new CommandError('Expected a bare cookie domain.');
      return job({
        url: typeof options.url === 'string' ? webUrl(options.url) : undefined,
        domain: options.domain,
        values: !!options.values,
        limit: limit(),
      });
    }
    argumentCount(command, action === 'rm' ? 2 : 3);
    const name = second;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new CommandError('Invalid cookie name.');
    const args = { url: webUrl(first), name };
    if (action === 'rm') return job(args);
    if (
      options['same-site'] &&
      !['lax', 'strict', 'no_restriction', 'unspecified'].includes(String(options['same-site']))
    )
      throw new CommandError('Use SameSite lax, strict, no_restriction or unspecified.');
    if (typeof options.path === 'string' && !options.path.startsWith('/'))
      throw new CommandError('Cookie path must start with /.');
    return job({
      ...args,
      value: third,
      path: options.path,
      secure: !!options.secure,
      httpOnly: !!options['http-only'],
      sameSite: options['same-site'],
      expirationDate:
        typeof options.expires === 'string'
          ? time(options.expires, Date.now(), 1) / 1000
          : undefined,
    });
  }
  if (group === 'storage') {
    argumentCount(
      command,
      action === 'set' ? 2 : action === 'rm' ? 1 : 0,
      action === 'get' ? 1 : undefined,
    );
    if (options.frame) throw new CommandError('Storage targets the main document. Omit --frame.');
    return run('chrome_storage', {
      action,
      key: first,
      value: second,
      area: options.session ? 'session' : 'local',
    });
  }
}
