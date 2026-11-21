import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCommand, commandHelp, searchCommands } = require('../packages/shared/dist/index.js');

test('typed commands parse shell arguments and preserve literal text', () => {
  const command = parseCommand(['fill', '2', '--tab', '6', '--json', '--', '--json']);
  assert.equal(command.name, 'fill');
  assert.deepEqual(command.operands, ['2', '--json']);
  assert.equal(command.options.tab, '6');
  assert.equal(command.options.json, true);
  assert.throws(() => parseCommand(['click', '2', '--tab']), /Missing value/);
  assert.throws(() => parseCommand(['click', '2', '--tab', '3', '--tab', '4']), /Repeated option/);
  assert.throws(() => parseCommand(['click', '2', '--artifacts', 'out']), /Unknown option/);
  assert.equal(parseCommand(['setup', '--browser', 'chromium']).options.browser, 'chromium');
  assert.equal(
    parseCommand(['setup', '--skill-scope', 'project']).options['skill-scope'],
    'project',
  );
  const found = parseCommand([
    'recipe',
    'find',
    'twitter',
    'search',
    '--url',
    'https://x.com',
    '--all',
  ]);
  assert.equal(found.name, 'recipe find');
  assert.deepEqual(found.operands, ['twitter', 'search']);
  assert.equal(found.options.url, 'https://x.com');
  assert.equal(found.options.all, true);
  assert.equal(parseCommand(['recipe', 'show', 'x-search-thread']).name, 'recipe show');
  assert.equal(parseCommand(['recipe', 'validate', 'x-search-thread']).name, 'recipe validate');
  const patch = parseCommand([
    'recipe',
    'patch',
    'x-search-thread',
    '--step',
    '1',
    '--',
    'wait',
    'css:main',
  ]);
  assert.equal(patch.name, 'recipe patch');
  assert.equal(patch.options.step, '1');
  assert.deepEqual(patch.operands, ['x-search-thread', 'wait', 'css:main']);
});

test('legacy inventory and select flags resolve to canonical commands without appearing in help', () => {
  assert.deepEqual(
    parseCommand(['tabs', '--windows', '--json']),
    parseCommand(['window', 'list', '--json']),
  );
  assert.deepEqual(
    parseCommand(['select', '12', '--list', '--tab', '7']),
    parseCommand(['select', '12', '--tab', '7']),
  );
  assert.throws(() => parseCommand(['tabs', '--windows', '--limit', '2']), /window list/);
  assert.throws(() => parseCommand(['select', '12', 'blue', '--list']), /select TARGET/);
  assert.deepEqual(parseCommand(['select', '12', '--', '--list']).operands, ['12', '--list']);
  assert.doesNotMatch(commandHelp('tabs'), /--windows/);
  assert.doesNotMatch(commandHelp('select'), /--list/);
});

test('help is available offline and contains supported command topics', () => {
  assert.match(commandHelp(), /task start.*observe/);
  assert.match(commandHelp('task'), /task finish/);
  assert.match(commandHelp('task resume'), /task resume --task ID \[--adopt\]/);
  assert.doesNotMatch(commandHelp('task resume'), /--tab|--frame/);
  assert.match(commandHelp('click'), /--capture/);
  assert.match(commandHelp('setup'), /--skill-scope/);
  assert.match(commandHelp('recipe'), /recipe find/);
  assert.match(commandHelp('recipe'), /recipe validate/);
  assert.match(commandHelp('recipe patch'), /--step INDEX/);
  assert.throws(() => commandHelp('chrome_navigate'), /Unknown help topic/);
  for (const command of ['chrome_navigate', 'mcp', 'repl', 'session', 'jev']) {
    assert.throws(() => parseCommand([command]), /Unknown command/);
  }
});

test('command search ranks exact names and finds English and Chinese keywords and options', () => {
  assert.equal(searchCommands('BOOKMARK export')[0].name, 'bookmark export');
  assert.equal(searchCommands('network response body')[0].name, 'network show');
  assert.equal(searchCommands('pending navigation')[0].name, 'task resume');
  assert.equal(searchCommands('恢复任务')[0].name, 'task resume');
  for (const [query, name] of [
    ['export bookmarks', 'bookmark export'],
    ['find duplicate bookmarks', 'bookmark dedupe'],
    ['network throttling', 'emulate'],
    ['mobile emulation', 'emulate'],
    ['print to PDF', 'pdf'],
    ['read localStorage', 'storage get'],
    ['search across tabs', 'tabs'],
  ]) {
    assert.equal(searchCommands(query)[0]?.name, name, query);
  }
  assert.equal(searchCommands('导出书签')[0].name, 'bookmark export');
  assert.equal(searchCommands('截图 --full')[0].name, 'screenshot');
  assert.match(searchCommands('full page screenshot')[0].example, /^browserpaw screenshot /);
  assert.deepEqual(searchCommands('network nonexistent-keyword-xyz'), []);
  assert.match(commandHelp(), /browserpaw search KEYWORD/);
  assert.match(commandHelp('search'), /8 matches by default/);
  assert.doesNotMatch(commandHelp('search'), /--tab/);
});
