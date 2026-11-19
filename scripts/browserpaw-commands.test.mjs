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
});

test('help is available offline and contains supported command topics', () => {
  assert.match(commandHelp(), /task start.*observe/);
  assert.match(commandHelp('task'), /task finish/);
  assert.match(commandHelp('click'), /--capture/);
  assert.throws(() => commandHelp('chrome_navigate'), /Unknown help topic/);
  assert.throws(() => parseCommand(['chrome_navigate', 'https://example.com']), /Unknown command/);
});
