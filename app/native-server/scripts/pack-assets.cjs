const { cpSync, existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const version = require('../package.json').version;

const dist = join(__dirname, '..', 'dist', 'v5');
const extension = join(__dirname, '..', '..', 'chrome-extension', '.output', 'chrome-mv3');
for (const file of ['cli.cjs', 'host.cjs', 'skill/browserpaw/SKILL.md']) {
  if (!existsSync(join(dist, file))) throw new Error('Run pnpm build before packing BrowserPaw.');
}
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
if (manifest.version !== version || !manifest.key)
  throw new Error('Build the matching BrowserPaw extension before packing.');
const destination = join(dist, 'extension');
rmSync(destination, { recursive: true, force: true });
cpSync(extension, destination, { recursive: true });
