const { cpSync, existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const version = require('../package.json').version;

const dist = join(__dirname, '..', 'dist', 'v5');
const extension = join(__dirname, '..', '..', 'chrome-extension', '.output', 'chrome-mv3');
const requiredDistFiles = [
  'cli.cjs',
  'host.cjs',
  'cli-files.cjs',
  'run_host.bat',
  'run_host.sh',
  'skill/browserpaw/SKILL.md',
  'skill/browserpaw/references/commands.md',
  'skill/browserpaw/references/recipe-contract.md',
  'recipes/developer.mozilla.org.md',
  'recipes/bilibili-popular-videos.json',
  'recipes/bilibili-video-detail.json',
  'recipes/github-issue-thread.json',
  'recipes/github-releases.json',
  'recipes/github-repo-readme.json',
  'recipes/github-repo-search.json',
  'recipes/mdn-search.json',
  'recipes/npm-compare.json',
  'recipes/reddit-post-read.json',
  'recipes/reddit-subreddit-posts.json',
  'recipes/v2ex-node-topics.json',
  'recipes/v2ex-topic-read.json',
  'recipes/x-profile-posts.json',
  'recipes/x-search-thread.json',
  'recipes/x-visible-thread.json',
  'recipes/youtube-search-videos.json',
  'recipes/youtube-video-read.json',
];
for (const file of requiredDistFiles) {
  if (!existsSync(join(dist, file))) {
    throw new Error(`Run pnpm build before packing BrowserPaw (missing dist/v5/${file}).`);
  }
}
for (const extFile of ['manifest.json', 'popup.html']) {
  if (!existsSync(join(extension, extFile))) {
    throw new Error(`Build the matching BrowserPaw extension before packing (missing ${extFile}).`);
  }
}
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
if (manifest.version !== version || !manifest.key)
  throw new Error('Build the matching BrowserPaw extension before packing.');
const destination = join(dist, 'extension');
rmSync(destination, { recursive: true, force: true });
cpSync(extension, destination, { recursive: true });
