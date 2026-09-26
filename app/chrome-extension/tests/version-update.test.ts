import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseSemver,
  compareSemver,
  isNewerVersion,
  checkVersionUpdate,
  formatAgentUpdateNotice,
  AgentUpdateNotifier,
  MemoryVersionCacheStorage,
  VersionCacheEntry,
} from 'chrome-mcp-shared';
import { chromeVersionStorage, checkExtensionVersionUpdate } from '../utils/version-checker';

describe('Version & Update Checker - SemVer Parsing & Precision Comparison', () => {
  it('parses valid 3-segment SemVer strings with or without v prefix', () => {
    const v1 = parseSemver('2.9.3');
    expect(v1).toEqual({
      major: 2,
      minor: 9,
      patch: 3,
      build: undefined,
      prerelease: undefined,
      raw: '2.9.3',
    });

    const v2 = parseSemver('v2.10.1');
    expect(v2).toEqual({
      major: 2,
      minor: 10,
      patch: 1,
      build: undefined,
      prerelease: undefined,
      raw: 'v2.10.1',
    });
  });

  it('parses 4-segment Chrome extension version strings', () => {
    const v = parseSemver('v2.9.3.1');
    expect(v).toEqual({
      major: 2,
      minor: 9,
      patch: 3,
      build: 1,
      prerelease: undefined,
      raw: 'v2.9.3.1',
    });
  });

  it('parses prerelease and ignores build metadata', () => {
    const v = parseSemver('v2.9.4-rc.1+build.42');
    expect(v).toEqual({
      major: 2,
      minor: 9,
      patch: 4,
      build: undefined,
      prerelease: 'rc.1',
      raw: 'v2.9.4-rc.1+build.42',
    });
  });

  it('safely rejects invalid or malformed version strings (zero false-positives)', () => {
    expect(parseSemver('')).toBeNull();
    expect(parseSemver(null as any)).toBeNull();
    expect(parseSemver(undefined as any)).toBeNull();
    expect(parseSemver('abc')).toBeNull();
    expect(parseSemver('1.x.3')).toBeNull();
    expect(parseSemver('1.2.3.4.5')).toBeNull();
    expect(parseSemver('v-1.0.0')).toBeNull();
  });

  it('correctly compares SemVer versions numerically', () => {
    expect(compareSemver('2.9.4', '2.9.3')).toBe(1);
    expect(compareSemver('2.10.0', '2.9.9')).toBe(1); // Numerical, not alphabetical!
    expect(compareSemver('3.0.0', '2.99.99')).toBe(1);
    expect(compareSemver('2.9.3', '2.9.3')).toBe(0);
    expect(compareSemver('v2.9.3', '2.9.3')).toBe(0);
    expect(compareSemver('2.9.2', '2.9.3')).toBe(-1);
    expect(compareSemver('2.9.3.1', '2.9.3.0')).toBe(1);
    expect(compareSemver('2.9.3.0', '2.9.3')).toBe(0);
  });

  it('correctly handles prerelease precedence', () => {
    // Normal release has higher precedence than prerelease
    expect(compareSemver('2.9.4', '2.9.4-beta.1')).toBe(1);
    expect(compareSemver('2.9.4-beta.1', '2.9.4')).toBe(-1);
    expect(compareSemver('2.9.4-beta.2', '2.9.4-beta.1')).toBe(1);
    expect(compareSemver('2.9.4-rc.1', '2.9.4-beta.1')).toBe(1); // 'rc' > 'beta'
  });

  it('isNewerVersion guarantees zero false-positives', () => {
    expect(isNewerVersion('2.9.4', '2.9.3')).toBe(true);
    expect(isNewerVersion('v2.10.0', '2.9.3')).toBe(true);
    expect(isNewerVersion('3.0.0', '2.9.3')).toBe(true);

    // False for equal or older
    expect(isNewerVersion('2.9.3', '2.9.3')).toBe(false);
    expect(isNewerVersion('v2.9.3', '2.9.3')).toBe(false);
    expect(isNewerVersion('2.9.2', '2.9.3')).toBe(false);
    expect(isNewerVersion('2.9.3-alpha', '2.9.3')).toBe(false);

    // False for invalid
    expect(isNewerVersion('invalid', '2.9.3')).toBe(false);
    expect(isNewerVersion('2.9.4', 'invalid')).toBe(false);
    expect(isNewerVersion('', '')).toBe(false);
  });
});

describe('Version & Update Checker - Sliding TTL & ETag Caching', () => {
  let storage: MemoryVersionCacheStorage;

  beforeEach(() => {
    storage = new MemoryVersionCacheStorage();
    vi.restoreAllMocks();
  });

  it('fetches remote GitHub API on cache miss and stores entry with ETag', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ etag: '"etag-12345"' }),
      json: async () => ({
        tag_name: 'v2.10.0',
        html_url: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.10.0',
      }),
    });

    const result = await checkVersionUpdate({
      currentVersion: '2.9.3',
      storage,
      ttlMs: 3600_000,
      fetchFn: mockFetch as any,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('v2.10.0');
    expect(result.releaseUrl).toBe(
      'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.10.0',
    );
    expect(result.isFromCache).toBe(false);
    expect(result.etag).toBe('"etag-12345"');

    // Verify stored in cache
    const cached = storage.get();
    expect(cached).not.toBeNull();
    expect(cached?.latestVersion).toBe('v2.10.0');
    expect(cached?.etag).toBe('"etag-12345"');
  });

  it('returns cached entry directly and slides TTL on subsequent call within TTL', async () => {
    const mockFetch = vi.fn();
    const now = Date.now();
    storage.set({
      latestVersion: 'v2.10.0',
      releaseUrl: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.10.0',
      etag: '"etag-123"',
      lastChecked: now - 1000,
      expiresAt: now + 500_000, // Still valid
    });

    const result = await checkVersionUpdate({
      currentVersion: '2.9.3',
      storage,
      ttlMs: 3600_000,
      fetchFn: mockFetch as any,
    });

    // fetchFn must NOT be called because cache is valid!
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.isFromCache).toBe(true);
    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('v2.10.0');

    // TTL must be slid forward
    const updatedCache = storage.get();
    expect(updatedCache?.expiresAt).toBeGreaterThan(now + 3500_000);
  });

  it('handles 304 Not Modified by using cached data and sliding expiration', async () => {
    const now = Date.now();
    storage.set({
      latestVersion: 'v2.9.4',
      releaseUrl: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.9.4',
      etag: '"etag-abc"',
      lastChecked: now - 4000_000,
      expiresAt: now - 1000, // Expired
    });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 304,
      headers: new Headers(),
    });

    const result = await checkVersionUpdate({
      currentVersion: '2.9.3',
      storage,
      ttlMs: 3600_000,
      fetchFn: mockFetch as any,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Verified header sent with ETag
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers['If-None-Match']).toBe('"etag-abc"');

    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('v2.9.4');
    expect(result.isFromCache).toBe(true);

    // Cache updated and slid
    const updatedCache = storage.get();
    expect(updatedCache?.expiresAt).toBeGreaterThan(now);
  });

  it('safely handles GitHub API 403 rate-limiting without throwing or reporting false updates', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 403,
      headers: new Headers({ 'x-ratelimit-remaining': '0' }),
      json: async () => ({ message: 'API rate limit exceeded' }),
    });

    const result = await checkVersionUpdate({
      currentVersion: '2.9.3',
      storage,
      fetchFn: mockFetch as any,
    });

    // Zero false positives!
    expect(result.hasUpdate).toBe(false);
    expect(result.latestVersion).toBe('2.9.3');
    expect(result.isFromCache).toBe(false);
  });

  it('safely handles network exceptions without throwing or reporting false updates', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Failed to fetch (DNS error)'));

    const result = await checkVersionUpdate({
      currentVersion: '2.9.3',
      storage,
      fetchFn: mockFetch as any,
    });

    expect(result.hasUpdate).toBe(false);
    expect(result.latestVersion).toBe('2.9.3');
  });

  it('enforces maximum sliding window and queries remote when lastChecked exceeds max window', async () => {
    const now = Date.now();
    const maxWindow = 24 * 3600_000;
    storage.set({
      latestVersion: '2.9.3',
      releaseUrl: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.9.3',
      etag: '"etag-old"',
      lastChecked: now - (maxWindow + 1000), // Exceeded max sliding window!
      expiresAt: now + 500_000, // Still within sliding TTL
    });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ etag: '"etag-new"' }),
      json: async () => ({
        tag_name: 'v2.10.0',
        html_url: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.10.0',
      }),
    });

    const result = await checkVersionUpdate({
      currentVersion: '2.9.3',
      storage,
      ttlMs: 3600_000,
      maxSlidingWindowMs: maxWindow,
      fetchFn: mockFetch as any,
    });

    // Must fetch remote because max sliding window was exceeded!
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('v2.10.0');
    expect(result.isFromCache).toBe(false);
  });

  it('omits User-Agent header in browser environment to avoid forbidden header violation', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      json: async () => ({
        tag_name: 'v2.9.3',
        html_url: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.9.3',
      }),
    });

    // Simulate browser environment with window defined
    (globalThis as any).window = {};

    try {
      await checkVersionUpdate({
        currentVersion: '2.9.3',
        storage,
        fetchFn: mockFetch as any,
      });

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers['User-Agent']).toBeUndefined();
    } finally {
      delete (globalThis as any).window;
    }
  });

  it('correctly parses tags with refs/tags/ and release- prefixes', () => {
    expect(parseSemver('refs/tags/v2.9.4')?.raw).toBe('refs/tags/v2.9.4');
    expect(parseSemver('refs/tags/v2.9.4')?.patch).toBe(4);
    expect(parseSemver('release-2.9.4')?.patch).toBe(4);
  });
});

describe('Chrome Extension Storage Adapter & Popup Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).chrome = {
      storage: {
        local: {
          store: {} as Record<string, any>,
          async get(key: string) {
            return { [key]: (this as any).store[key] };
          },
          async set(obj: Record<string, any>) {
            Object.assign((this as any).store, obj);
          },
        },
      },
      runtime: {
        getManifest() {
          return { version: '2.9.3' };
        },
      },
    };
  });

  it('stores and retrieves cache via chrome.storage.local', async () => {
    const entry: VersionCacheEntry = {
      latestVersion: '2.9.4',
      releaseUrl: 'https://github.com/GoldenLoaf24h/browserpaw/releases/latest',
      etag: '"test-tag"',
      lastChecked: 1000,
      expiresAt: 2000,
    };

    await chromeVersionStorage.set(entry);
    const retrieved = await chromeVersionStorage.get();
    expect(retrieved).toEqual(entry);
  });

  it('checkExtensionVersionUpdate reads manifest version and executes check', async () => {
    const now = Date.now();
    await chromeVersionStorage.set({
      latestVersion: '2.9.4',
      releaseUrl: 'https://github.com/GoldenLoaf24h/browserpaw/releases/tag/v2.9.4',
      lastChecked: now,
      expiresAt: now + 3600_000,
    });

    const res = await checkExtensionVersionUpdate();
    expect(res.currentVersion).toBe('2.9.3');
    expect(res.latestVersion).toBe('2.9.4');
    expect(res.hasUpdate).toBe(true);
  });
});
