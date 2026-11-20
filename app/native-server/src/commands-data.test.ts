import { parseCommand } from 'chrome-mcp-shared';
import { dispatchData, time } from './commands-data';

const run = jest.fn(async () => ({ content: [] }));
const dispatch = (...argv: string[]) => dispatchData(parseCommand(argv), run);

beforeEach(() => run.mockClear());

test('validates destructive scope before dispatch', () => {
  expect(() => dispatch('history', 'rm', '--since', '7d', '--until', '1d')).toThrow('--yes');
  expect(() => dispatch('history', 'rm', 'https://example.com', '--since', '7d')).toThrow();
  expect(() => dispatch('bookmark', 'dedupe', '--apply')).toThrow('--folder');
  expect(() => dispatch('cookies', 'list', '--values')).toThrow('scope');
  expect(run).not.toHaveBeenCalled();
});

test('maps bookmarks, tab storage, and cookie metadata without values', () => {
  dispatch('bookmark', 'mv', '12', '--folder', '/Bookmarks bar/Research', '--index', '0');
  expect(run).toHaveBeenLastCalledWith(
    'chrome_bookmarks',
    {
      action: 'mv',
      id: '12',
      folder: '/Bookmarks bar/Research',
      index: 0,
    },
    false,
  );
  dispatch('storage', 'set', 'key', '', '--session', '--tab', '42');
  expect(run).toHaveBeenLastCalledWith('chrome_storage', {
    action: 'set',
    key: 'key',
    value: '',
    area: 'session',
  });
  dispatch('cookies', 'list', '--url', 'https://example.com/path');
  expect(run).toHaveBeenLastCalledWith(
    'chrome_cookies',
    expect.objectContaining({ values: false }),
    false,
  );
});

test('relative history ranges use a common clock', () => {
  const now = Date.UTC(2026, 10, 20);
  expect(time('1d', now)).toBe(Date.UTC(2026, 10, 19));
  expect(time('2026-11-19')).toBe(Date.UTC(2026, 10, 19));
  expect(() => time('unbounded', now)).toThrow();
});
