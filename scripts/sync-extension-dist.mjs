import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC = resolve('app/chrome-extension/.output/chrome-mv3');
const TARGETS = ['D:/workspace/browserclaw', 'D:/workspace/browserpaw'];

if (existsSync(SRC)) {
  for (const target of TARGETS) {
    if (existsSync(target)) {
      try {
        // Clean stale hashed chunks and assets to prevent historical build bloat
        for (const sub of ['chunks', 'assets']) {
          const subPath = join(target, sub);
          if (existsSync(subPath)) {
            rmSync(subPath, { recursive: true, force: true });
          }
        }
        cpSync(SRC, target, { recursive: true, force: true });
        console.log(`[SYNC] Automatically synced extension build output to: ${target}`);
      } catch (err) {
        console.warn(`[SYNC] Failed to sync to ${target}:`, err.message);
      }
    }
  }
}
