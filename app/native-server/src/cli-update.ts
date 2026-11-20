import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_VERSION, GITHUB_REPO_URL, isNewerVersion } from 'chrome-mcp-shared';
import { browserPawHome } from './learned-recipes';

const registryUrl = 'https://registry.npmjs.org/browserpaw/latest';
const checkInterval = 24 * 60 * 60 * 1000;
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
type UpdateState = { checkedAt?: number; latest?: string; notified?: string[] };

export async function checkForCliUpdate(): Promise<string | undefined> {
  if (process.env.BROWSERPAW_NO_UPDATE_CHECK === '1') return;
  const root = browserPawHome();
  const statePath = join(root, 'cli-update.json');
  const { ensureDirectory, acquireLock, readJson, atomicWrite } = require('./cli-files.cjs');
  try {
    ensureDirectory(root);
    const unlock = acquireLock(join(root, '.cli-update.lock'));
    try {
      let state: UpdateState | undefined;
      try {
        state = readJson(statePath) as UpdateState | undefined;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const backup = `${statePath}.corrupt.${Date.now()}-${process.pid}`;
        renameSync(statePath, backup);
        console.error(
          `BrowserPaw update state was corrupt; moved it to ${backup} and started from empty state.`,
        );
        state = undefined;
      }
      const notified = Array.isArray(state?.notified) ? state.notified : [];
      const now = Date.now();
      const age = now - (state?.checkedAt ?? NaN);
      const check = !(age >= 0 && age < checkInterval);
      let latest = state?.latest;
      if (check) {
        latest = await fetch(registryUrl, { redirect: 'error', signal: AbortSignal.timeout(1000) })
          .then(async (response) => {
            if (!response.ok) return undefined;
            const manifest = await response.json();
            const repository = manifest?.repository?.url;
            if (
              manifest?.name !== 'browserpaw' ||
              typeof repository !== 'string' ||
              repository.replace(/^git\+/, '').replace(/\.git$/, '') !== GITHUB_REPO_URL
            )
              return;
            const version: unknown = manifest.version;
            if (typeof version === 'string' && stableVersion.test(version)) return version;
          })
          .catch(() => undefined);
      }
      const shouldNotify =
        typeof latest === 'string' &&
        stableVersion.test(latest) &&
        isNewerVersion(latest, CURRENT_VERSION) &&
        !notified.includes(latest);
      if (check || shouldNotify) {
        atomicWrite(
          statePath,
          JSON.stringify({
            checkedAt: check ? now : state?.checkedAt,
            latest,
            notified: shouldNotify ? [...notified, latest] : notified,
          }) + '\n',
        );
      }
      return shouldNotify ? latest : undefined;
    } finally {
      unlock();
    }
  } catch {
    return undefined;
  }
}
