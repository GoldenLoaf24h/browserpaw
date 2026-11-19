import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const build = [
  '../app/native-server/dist/v5',
  '../app/chrome-extension/.output',
  '../app/chrome-extension/.wxt',
  '../packages/shared/dist',
];
const dependencies = [
  '../node_modules',
  '../app/native-server/node_modules',
  '../app/chrome-extension/node_modules',
  '../packages/shared/node_modules',
];
const mode = process.argv[2] ?? 'dist';
const paths =
  mode === 'dist'
    ? build
    : mode === 'modules'
      ? dependencies
      : mode === 'all'
        ? [...build, ...dependencies]
        : undefined;
if (!paths) {
  console.error('Usage: node scripts/clean.js dist|modules|all');
  process.exitCode = 2;
} else {
  for (const relative of paths) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    rmSync(path, { recursive: true, force: true });
    console.log(`Cleared ${path}`);
  }
}
