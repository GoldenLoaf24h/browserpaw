import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITHUB_REPO_URL } from 'chrome-mcp-shared';
import { checkForCliUpdate } from './cli-update';

describe('CLI update notices', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'browserpaw-update-'));
    jest.replaceProperty(process, 'env', {
      ...process.env,
      BROWSERPAW_HOME: directory,
      BROWSERPAW_NO_UPDATE_CHECK: '0',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  const release = (version: string, repository = GITHUB_REPO_URL) =>
    Response.json({
      name: 'browserpaw',
      version,
      repository: { url: `git+${repository}.git` },
    });

  function expireCheck() {
    const path = join(directory, 'cli-update.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...state, checkedAt: 0 }));
  }

  it('notifies one concurrent CLI, remembers that version after cache refresh, and notifies on the next release', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(release('5000.0.1'))
      .mockResolvedValueOnce(release('5000.0.1'))
      .mockResolvedValueOnce(release('5000.0.2'));
    expect((await Promise.all([checkForCliUpdate(), checkForCliUpdate()])).filter(Boolean)).toEqual(
      ['5000.0.1'],
    );
    expect(await checkForCliUpdate()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expireCheck();
    expect(await checkForCliUpdate()).toBeUndefined();
    expireCheck();
    expect(await checkForCliUpdate()).toBe('5000.0.2');
  });

  it('backs off after a network failure and ignores foreign and prerelease packages', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(release('5000.0.0', 'https://example.com/other'))
      .mockResolvedValueOnce(release('5000.0.0-beta.1'));
    expect(await checkForCliUpdate()).toBeUndefined();
    expect(await checkForCliUpdate()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expireCheck();
    expect(await checkForCliUpdate()).toBeUndefined();
    expireCheck();
    expect(await checkForCliUpdate()).toBeUndefined();
  });

  it('quarantines corrupt state and reclaims an old unreadable lock', async () => {
    const statePath = join(directory, 'cli-update.json');
    const lockPath = join(directory, '.cli-update.lock');
    writeFileSync(statePath, '{"checkedAt":');
    writeFileSync(lockPath, '{"pid":');
    const stale = new Date(Date.now() - 15 * 60 * 1000);
    utimesSync(lockPath, stale, stale);
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(release('5000.0.1'));
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await checkForCliUpdate()).toBe('5000.0.1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(directory).some((name) => name.startsWith('cli-update.json.corrupt.'))).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ latest: '5000.0.1' });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('update state was corrupt'));
  });

  it('keeps a recent unreadable lock busy', async () => {
    const lockPath = join(directory, '.cli-update.lock');
    writeFileSync(lockPath, '{"pid":');
    const fetch = jest.spyOn(globalThis, 'fetch');

    expect(await checkForCliUpdate()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });
});
