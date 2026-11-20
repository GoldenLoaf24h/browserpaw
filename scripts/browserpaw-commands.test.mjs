import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCommand, commandHelp } = require('../packages/shared/dist/index.js');

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
  assert.equal(parseCommand(['setup', '--skill-scope', 'project']).options['skill-scope'], 'project');
  const found = parseCommand(['recipe', 'find', 'twitter', 'search', '--url', 'https://x.com', '--all']);
  assert.equal(found.name, 'recipe find');
  assert.deepEqual(found.operands, ['twitter', 'search']);
  assert.equal(found.options.url, 'https://x.com');
  assert.equal(found.options.all, true);
  assert.equal(parseCommand(['recipe', 'show', 'x-search-thread']).name, 'recipe show');
  assert.equal(parseCommand(['recipe', 'validate', 'x-search-thread']).name, 'recipe validate');
});

test('help is available offline and contains supported command topics', () => {
  assert.match(commandHelp(), /task start.*observe/);
  assert.match(commandHelp('task'), /task finish/);
  assert.match(commandHelp('click'), /--capture/);
  assert.match(commandHelp('setup'), /--skill-scope/);
  assert.match(commandHelp('recipe'), /recipe find/);
  assert.match(commandHelp('recipe'), /recipe validate/);
  assert.throws(() => commandHelp('chrome_navigate'), /Unknown help topic/);
  assert.throws(() => parseCommand(['chrome_navigate', 'https://example.com']), /Unknown command/);
});
