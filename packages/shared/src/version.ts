/**
 * BrowserPaw Version & Update Checker
 * Provides SemVer parsing/comparison, sliding-TTL/ETag GitHub releases caching,
 * and single-turn agent notification formatting.
 */

export const GITHUB_REPO_OWNER = 'GoldenLoaf24h';
export const GITHUB_REPO_NAME = 'browserpaw';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;
export const GITHUB_API_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;
export const CURRENT_VERSION = '3.2.0';
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour sliding TTL
export const DEFAULT_MAX_SLIDING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours maximum sliding window

export interface SemVerParsed {
  major: number;
  minor: number;
  patch: number;
  build?: number;
  prerelease?: string;
  raw: string;
}

/**
 * Strict SemVer parser that normalizes 'v' prefix, whitespace, and handles pre-releases.
 * Returns null if the version string is invalid or cannot be parsed safely.
 */
export function parseSemver(versionStr: string | null | undefined): SemVerParsed | null {
  if (!versionStr || typeof versionStr !== 'string') return null;
  const trimmed = versionStr.trim();
  if (!trimmed) return null;

  // Remove leading refs/tags/, release-, or 'v'/'V'
  const clean = trimmed
    .replace(/^refs\/tags\//, '')
    .replace(/^release-/i, '')
    .replace(/^[vV]/, '')
    .trim();
  if (!clean) return null;

  // Split into core version and prerelease / build metadata
  // Format: core-prerelease+build or core+build
  const plusIdx = clean.indexOf('+');
  const withoutBuild = plusIdx !== -1 ? clean.slice(0, plusIdx) : clean;

  const dashIdx = withoutBuild.indexOf('-');
  const corePart = dashIdx !== -1 ? withoutBuild.slice(0, dashIdx) : withoutBuild;
  const prereleasePart = dashIdx !== -1 ? withoutBuild.slice(dashIdx + 1) : undefined;

  // Split core into numeric parts (supports 1 to 4 segments, e.g. 2.9.3 or 2.9.3.1)
  const segments = corePart.split('.');
  if (segments.length === 0 || segments.length > 4) return null;

  const numSegments: number[] = [];
  for (const seg of segments) {
    if (!/^\d+$/.test(seg)) return null;
    const num = Number.parseInt(seg, 10);
    if (!Number.isFinite(num) || num < 0) return null;
    numSegments.push(num);
  }

  const major = numSegments[0];
  const minor = numSegments.length > 1 ? numSegments[1] : 0;
  const patch = numSegments.length > 2 ? numSegments[2] : 0;
  const build = numSegments.length > 3 ? numSegments[3] : undefined;

  return {
    major,
    minor,
    patch,
    build,
    prerelease: prereleasePart && prereleasePart.trim() ? prereleasePart.trim() : undefined,
    raw: trimmed,
  };
}

/**
 * Compare two SemVer strings.
 * Returns:
 *   1 if a > b
 *  -1 if a < b
 *   0 if a === b
 *
 * Rules:
 * - Numerical comparison of major, minor, patch, and build.
 * - If core versions are identical:
 *   - Normal release > prerelease (e.g. 2.9.4 > 2.9.4-beta.1).
 *   - If both have prerelease, dot-separated identifiers are compared:
 *     numeric vs numeric -> numeric comparison;
 *     string vs string -> lexical comparison;
 *     numeric vs string -> numeric has lower precedence than string (SemVer 2.0.0 rule).
 * - If either version is unparseable, returns 0 to prevent false-positive comparisons.
 */
export function compareSemver(aStr: string, bStr: string): number {
  const a = parseSemver(aStr);
  const b = parseSemver(bStr);
  if (!a || !b) return 0;

  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  const aBuild = a.build ?? 0;
  const bBuild = b.build ?? 0;
  if (aBuild !== bBuild) return aBuild > bBuild ? 1 : -1;

  // Prerelease comparison:
  // When core parts are equal:
  // - version without prerelease > version with prerelease
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && !b.prerelease) return 0;

  // Both have prereleases: compare dot-separated identifiers
  const aParts = a.prerelease!.split('.');
  const bParts = b.prerelease!.split('.');
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLen; i++) {
    const aP = aParts[i];
    const bP = bParts[i];
    if (aP === undefined) return -1; // shorter prerelease set has lower precedence
    if (bP === undefined) return 1;
    if (aP === bP) continue;

    const aNum = /^\d+$/.test(aP) ? Number.parseInt(aP, 10) : null;
    const bNum = /^\d+$/.test(bP) ? Number.parseInt(bP, 10) : null;

    if (aNum !== null && bNum !== null) {
      return aNum > bNum ? 1 : -1;
    }
    if (aNum !== null && bNum === null) {
      return -1; // numeric identifier has lower precedence than string identifier
    }
    if (aNum === null && bNum !== null) {
      return 1;
    }
    return aP.localeCompare(bP);
  }

  return 0;
}

/**
 * Checks whether remoteVersion is strictly newer than currentVersion.
 * Zero false-positives guaranteed:
 * - If remoteVersion or currentVersion cannot be parsed -> returns false.
 * - If remoteVersion <= currentVersion -> returns false.
 * - Returns true ONLY if remoteVersion > currentVersion.
 */
export function isNewerVersion(remoteVersion: string, currentVersion: string): boolean {
  const remote = parseSemver(remoteVersion);
  const current = parseSemver(currentVersion);
  if (!remote || !current) return false;
  return compareSemver(remote.raw, current.raw) > 0;
}

export interface VersionCacheEntry {
  latestVersion: string;
  releaseUrl: string;
  etag?: string;
  lastChecked: number;
  expiresAt: number;
}

export interface VersionCacheStorage {
  get(): Promise<VersionCacheEntry | null> | VersionCacheEntry | null;
  set(entry: VersionCacheEntry): Promise<void> | void;
}

export class MemoryVersionCacheStorage implements VersionCacheStorage {
  private entry: VersionCacheEntry | null = null;
  get(): VersionCacheEntry | null {
    return this.entry;
  }
  set(entry: VersionCacheEntry): void {
    this.entry = entry;
  }
}

export const defaultMemoryCacheStorage = new MemoryVersionCacheStorage();

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  checkedAt: number;
  isFromCache: boolean;
  etag?: string;
}

export interface CheckVersionUpdateOptions {
  currentVersion?: string;
  storage?: VersionCacheStorage;
  ttlMs?: number;
  maxSlidingWindowMs?: number;
  timeoutMs?: number;
  apiUrl?: string;
  fallbackReleaseUrl?: string;
  fetchFn?: typeof fetch;
  forceRefresh?: boolean;
}

/**
 * Check for updates against GitHub Releases API with sliding TTL and ETag support.
 * Guaranteed to never throw unhandled exceptions and never report false-positive updates.
 */
export async function checkVersionUpdate(
  options?: CheckVersionUpdateOptions,
): Promise<VersionCheckResult> {
  const currentVersion = options?.currentVersion || CURRENT_VERSION;
  const storage = options?.storage || defaultMemoryCacheStorage;
  const ttlMs = options?.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxSlidingWindowMs = options?.maxSlidingWindowMs ?? DEFAULT_MAX_SLIDING_WINDOW_MS;
  const timeoutMs = options?.timeoutMs ?? 3000;
  const apiUrl = options?.apiUrl || GITHUB_API_LATEST_RELEASE_URL;
  const fallbackReleaseUrl = options?.fallbackReleaseUrl || `${GITHUB_REPO_URL}/releases/latest`;
  const customFetch = options?.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  const forceRefresh = options?.forceRefresh ?? false;

  const now = Date.now();

  let cached: VersionCacheEntry | null = null;
  try {
    cached = await storage.get();
  } catch {
    cached = null;
  }

  // 1. Sliding TTL check: If cached entry exists and is within TTL and within max sliding window,
  // slide expiration and return cached entry immediately without making a network call.
  // When beyond maxSlidingWindowMs or forceRefresh is true, proceed to revalidate with ETag.
  const isWithinMaxWindow = !cached?.lastChecked || now - cached.lastChecked < maxSlidingWindowMs;
  if (
    !forceRefresh &&
    cached &&
    now < cached.expiresAt &&
    isWithinMaxWindow &&
    cached.latestVersion
  ) {
    cached.expiresAt = Math.min(
      now + ttlMs,
      cached.lastChecked ? cached.lastChecked + maxSlidingWindowMs : now + ttlMs,
    );
    try {
      await storage.set(cached);
    } catch {}

    const hasUpdate = isNewerVersion(cached.latestVersion, currentVersion);
    return {
      currentVersion,
      latestVersion: cached.latestVersion,
      hasUpdate,
      releaseUrl: cached.releaseUrl || fallbackReleaseUrl,
      checkedAt: cached.lastChecked,
      isFromCache: true,
      etag: cached.etag,
    };
  }

  // If no fetch function available, fallback safely
  if (!customFetch) {
    const latest = cached?.latestVersion || currentVersion;
    return {
      currentVersion,
      latestVersion: latest,
      hasUpdate: isNewerVersion(latest, currentVersion),
      releaseUrl: cached?.releaseUrl || fallbackReleaseUrl,
      checkedAt: cached?.lastChecked || now,
      isFromCache: !!cached,
    };
  }

  // 2. Fetch remote GitHub API with ETag and headers
  let timeoutId: any = null;
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
    };
    // GitHub API requires User-Agent in Node.js runtime. In browsers, User-Agent is a forbidden header.
    if (typeof window === 'undefined') {
      headers['User-Agent'] = 'BrowserPaw';
    }
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (controller && timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    const res = await customFetch(apiUrl, {
      method: 'GET',
      headers,
      signal: controller?.signal,
    });
    if (timeoutId) clearTimeout(timeoutId);

    // 3. Handle 304 Not Modified: Cache is still valid
    if (res.status === 304 && cached) {
      cached.lastChecked = now;
      cached.expiresAt = now + ttlMs; // slide TTL
      try {
        await storage.set(cached);
      } catch {}

      const hasUpdate = isNewerVersion(cached.latestVersion, currentVersion);
      return {
        currentVersion,
        latestVersion: cached.latestVersion,
        hasUpdate,
        releaseUrl: cached.releaseUrl || fallbackReleaseUrl,
        checkedAt: cached.lastChecked,
        isFromCache: true,
        etag: cached.etag,
      };
    }

    // 4. Handle 200 OK: Process new release info
    if (res.status === 200) {
      const data = await res.json();
      const rawTag = (data?.tag_name || data?.name || '').trim();
      const releaseUrl = (data?.html_url || fallbackReleaseUrl).trim();
      const etag = res.headers?.get?.('etag') || undefined;

      const remoteParsed = parseSemver(rawTag);
      // If tag is valid semver, compare; otherwise fallback to currentVersion (no update)
      const latestVersion = remoteParsed ? remoteParsed.raw : currentVersion;
      const hasUpdate = isNewerVersion(latestVersion, currentVersion);

      const entry: VersionCacheEntry = {
        latestVersion,
        releaseUrl,
        etag,
        lastChecked: now,
        expiresAt: now + ttlMs,
      };

      try {
        await storage.set(entry);
      } catch {}

      return {
        currentVersion,
        latestVersion,
        hasUpdate,
        releaseUrl,
        checkedAt: now,
        isFromCache: false,
        etag,
      };
    }

    // 5. Handle rate limit (403/429) or other errors: Fallback to existing cache if available
    if (cached) {
      cached.expiresAt = now + Math.min(ttlMs, 5 * 60 * 1000); // Back off temporarily during rate limit
      try {
        await storage.set(cached);
      } catch {}
      return {
        currentVersion,
        latestVersion: cached.latestVersion,
        hasUpdate: isNewerVersion(cached.latestVersion, currentVersion),
        releaseUrl: cached.releaseUrl || fallbackReleaseUrl,
        checkedAt: cached.lastChecked,
        isFromCache: true,
        etag: cached.etag,
      };
    }

    // Safe fallback when no cache exists and remote failed: never report false-positive
    // Cache safe fallback temporarily to avoid hammering GitHub when rate limited
    try {
      await storage.set({
        latestVersion: currentVersion,
        releaseUrl: fallbackReleaseUrl,
        lastChecked: now,
        expiresAt: now + Math.min(ttlMs, 5 * 60 * 1000),
      });
    } catch {}

    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      releaseUrl: fallbackReleaseUrl,
      checkedAt: now,
      isFromCache: false,
    };
  } catch {
    if (timeoutId) clearTimeout(timeoutId);
    // Network error or unexpected exception: fallback safely
    if (cached) {
      cached.expiresAt = now + ttlMs;
      return {
        currentVersion,
        latestVersion: cached.latestVersion,
        hasUpdate: isNewerVersion(cached.latestVersion, currentVersion),
        releaseUrl: cached.releaseUrl || fallbackReleaseUrl,
        checkedAt: cached.lastChecked,
        isFromCache: true,
        etag: cached.etag,
      };
    }

    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      releaseUrl: fallbackReleaseUrl,
      checkedAt: now,
      isFromCache: false,
    };
  }
}

/**
 * Format the update notice to be presented to the agent.
 */
export function formatAgentUpdateNotice(latestVersion: string, releaseUrl: string): string {
  const cleanVer =
    latestVersion.startsWith('v') || latestVersion.startsWith('V')
      ? latestVersion
      : `v${latestVersion}`;
  return `[System Notice: A new version of BrowserPaw is available (${cleanVer}). It is recommended to update to the latest release for new features and improvements: ${releaseUrl}]`;
}

/**
 * AgentUpdateNotifier ensures the update prompt is strictly limited to the agent's FIRST MCP tool call.
 * Strictly forbidden from appearing multiple times. Zero false positives.
 */
export class AgentUpdateNotifier {
  private hasCheckedFirstCall = false;
  private hasNotified = false;
  private inFlightPromise: Promise<string | null> | null = null;

  public async maybeGetFirstCallNotice(
    options?: CheckVersionUpdateOptions,
  ): Promise<string | null> {
    // If the first call has already been checked/evaluated, STRICTLY return null.
    if (this.hasCheckedFirstCall) {
      return null;
    }
    this.hasCheckedFirstCall = true;

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const res = await checkVersionUpdate(options);
        if (res.hasUpdate && !this.hasNotified) {
          this.hasNotified = true;
          return formatAgentUpdateNotice(res.latestVersion, res.releaseUrl);
        }
      } catch {
        // Zero false-positives
      }
      return null;
    })();

    return this.inFlightPromise;
  }

  public resetForTesting(): void {
    this.hasCheckedFirstCall = false;
    this.hasNotified = false;
    this.inFlightPromise = null;
  }
}

export const agentUpdateNotifier = new AgentUpdateNotifier();
