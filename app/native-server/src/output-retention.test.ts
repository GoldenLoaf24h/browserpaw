import { expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOutput } from './output-retention';

it('removes old managed output and preserves active tasks, the current request and user files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'browserpaw-receipt-test-'));
  try {
    const root = join(home, 'out');
    const task = randomUUID();
    const now = Date.now();
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const receipt = (bucket: string, filename: string, time = old) => {
      const directory = join(root, bucket, randomUUID());
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, filename), 'fixture');
      utimesSync(directory, time, time);
      return directory;
    };
    writeFileSync(
      join(home, 'tasks.json'),
      JSON.stringify({ tasks: { [task]: { status: 'active' } } }),
    );
    const current = receipt('misc', 'result.json');
    const expired = receipt('misc', 'item-1.png');
    const active = receipt(task, 'result.json');
    const user = receipt('misc', 'keep-me.png');
    const recent = receipt('misc', 'result.json', new Date(now));
    await pruneOutput(root, current, now);
    expect(existsSync(expired)).toBe(false);
    for (const kept of [current, active, user, recent]) expect(existsSync(kept)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
