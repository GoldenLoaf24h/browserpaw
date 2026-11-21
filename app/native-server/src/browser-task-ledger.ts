import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskLedger, TaskLedgerLoad } from './browser-task-types';

export const LEDGER_VERSION = 1 as const;

export function taskLedgerFile(storageDir?: string): string {
  return path.join(
    storageDir || process.env.BROWSERPAW_HOME || path.join(os.homedir(), '.browserpaw'),
    'tasks.json',
  );
}

export function emptyTaskLedger(): TaskLedger {
  return { version: LEDGER_VERSION, tasks: {} };
}

export function pruneTerminalTasks(ledger: TaskLedger, maxTerminalTasks = 30): boolean {
  const terminal = Object.values(ledger.tasks)
    .filter((task) => task.status === 'finished' || task.status === 'cancelled')
    .sort(
      (left, right) =>
        (right.finishedAt ?? right.updatedAt ?? right.createdAt) -
        (left.finishedAt ?? left.updatedAt ?? left.createdAt),
    );
  const stale = terminal
    .slice(maxTerminalTasks)
    .filter(
      (task) =>
        !task.pages.some((page) => page.ownership === 'owned' && page.state === 'active') &&
        !task.pages.some((page) => page.ownership === 'owned' && Boolean(page.recovery)) &&
        task.pendingCreations.length === 0,
    );
  for (const item of stale) delete ledger.tasks[item.id];
  return stale.length > 0;
}

export async function readTaskLedger(ledgerFile: string): Promise<TaskLedgerLoad> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(ledgerFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { ledger: emptyTaskLedger(), changed: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const timestamp = new Date().toISOString().replace(/\D/g, '');
    const quarantine = `${ledgerFile}.corrupt.${timestamp}`;
    await fs.promises.rename(ledgerFile, quarantine);
    console.error(
      `BrowserPaw task ledger was corrupt; quarantined it at ${quarantine} and started with an empty ledger.`,
    );
    return { ledger: emptyTaskLedger(), changed: true };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== LEDGER_VERSION ||
    !(parsed as { tasks?: unknown }).tasks ||
    typeof (parsed as { tasks?: unknown }).tasks !== 'object' ||
    Array.isArray((parsed as { tasks?: unknown }).tasks)
  ) {
    throw new Error(`Unsupported or corrupt task ledger: ${ledgerFile}`);
  }
  const ledger = parsed as TaskLedger;
  let changed = false;
  for (const task of Object.values(ledger.tasks)) {
    if (!Array.isArray(task.pendingCreations)) {
      task.pendingCreations = [];
      changed = true;
    }
  }
  changed = pruneTerminalTasks(ledger) || changed;
  return { ledger, changed };
}

export async function writeTaskLedger(ledgerFile: string, ledger: TaskLedger): Promise<void> {
  pruneTerminalTasks(ledger);
  await fs.promises.mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
  const tempFile = `${ledgerFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const body = `${JSON.stringify(ledger, null, 2)}\n`;
  try {
    await fs.promises.writeFile(tempFile, body, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tempFile, ledgerFile);
  } catch (error) {
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}
