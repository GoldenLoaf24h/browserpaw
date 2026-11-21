import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const managedFile = /^(?:result\.json|bookmarks|item-[1-9]\d*\.(?:bin|jpg|png|txt|webp))$/;
const day = 24 * 60 * 60 * 1000;

export async function pruneOutput(root: string, current: string, now = Date.now()) {
  const { assertNoLinks, readJson } = require('./cli-files.cjs');
  assertNoLinks(root);
  const ledger = readJson(join(dirname(root), 'tasks.json'));
  const active = ledger?.tasks ?? {};
  const requests: { bucket: string; path: string; mtimeMs: number }[] = [];
  for (const bucket of await readdir(root, { withFileTypes: true })) {
    if (!bucket.isDirectory() || (bucket.name !== 'misc' && !uuid.test(bucket.name))) continue;
    const directory = join(root, bucket.name);
    if (
      bucket.name !== 'misc' &&
      (directory === dirname(current) ||
        active[bucket.name]?.status === 'active' ||
        active[bucket.name]?.status === 'paused')
    )
      continue;
    assertNoLinks(directory);
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const request of children) {
      if (!request.isDirectory() || !uuid.test(request.name)) continue;
      const path = join(directory, request.name);
      if (path === current) continue;
      const stat = await lstat(path).catch(() => undefined);
      if (stat?.isDirectory()) requests.push({ bucket: directory, path, mtimeMs: stat.mtimeMs });
    }
  }
  requests.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const [index, request] of requests.entries()) {
    const age = now - request.mtimeMs;
    if (age <= 7 * day && (index < 200 || age < 10 * 60 * 1000)) continue;
    assertNoLinks(request.path);
    const files = await readdir(request.path, { withFileTypes: true }).catch(() => undefined);
    if (!files?.every((file) => file.isFile() && managedFile.test(file.name))) continue;
    for (const file of files) await unlink(join(request.path, file.name)).catch(() => {});
    await rmdir(request.path).catch(() => {});
    await rmdir(request.bucket).catch(() => {});
  }
}
