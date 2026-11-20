import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import prettier from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { COMMANDS, TARGET_HELP } = require('../packages/shared/dist/index.js');
const markdown = [
  '# BrowserPaw commands',
  '',
  'Run `browserpaw help COMMAND` for help from the installed version.',
  'Use `browserpaw search KEYWORD...` to find commands by name, purpose, or option. Common English and Chinese keywords work, such as `browserpaw search network throttling`, `browserpaw search export bookmarks`, and `browserpaw search 导出书签 --limit 3 --json`.',
  'Page commands take `--tab ID` or `--task ID`. Use `--frame ID` on frame-aware commands.',
  '`--json` emits a single receipt. Use `--` before an argument starting with a dash.',
  '',
  TARGET_HELP,
  '',
  '| Command | Purpose |',
  '| --- | --- |',
  ...Object.values(COMMANDS).map(
    ({ usage, summary }) => `| \`${usage.replaceAll('|', '\\|')}\` | ${summary} |`,
  ),
  '',
].join('\n');
const commandReference = path.join(root, 'docs/COMMANDS.md');
const doc = await prettier.format(markdown, {
  ...(await prettier.resolveConfig(commandReference)),
  filepath: commandReference,
});
for (const file of ['docs/COMMANDS.md', 'skills/browserpaw/references/commands.md']) {
  const target = path.join(root, file);
  if (process.argv.includes('--check')) {
    if (
      !fs.existsSync(target) ||
      fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== doc
    ) {
      console.error(`Command documentation drift in ${file}. Run pnpm docs:commands.`);
      process.exitCode = 1;
    }
  } else fs.writeFileSync(target, doc);
}
