import {
  checkVersionUpdate,
  CURRENT_VERSION,
  type VersionCacheStorage,
  type VersionCacheEntry,
  type VersionCheckResult,
} from 'chrome-mcp-shared';

export const VERSION_CACHE_STORAGE_KEY = 'browserpaw_version_cache';

export const chromeVersionStorage: VersionCacheStorage = {
  async get(): Promise<VersionCacheEntry | null> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const res = await chrome.storage.local.get(VERSION_CACHE_STORAGE_KEY);
        return res[VERSION_CACHE_STORAGE_KEY] || null;
      }
    } catch {}
    return null;
  },
  async set(entry: VersionCacheEntry): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ [VERSION_CACHE_STORAGE_KEY]: entry });
      }
    } catch {}
  },
};

export async function checkExtensionVersionUpdate(): Promise<VersionCheckResult> {
  let currentVersion = CURRENT_VERSION;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const manifest = chrome.runtime.getManifest();
      if (manifest?.version) {
        currentVersion = manifest.version;
      }
    }
  } catch {}

  return checkVersionUpdate({
    currentVersion,
    storage: chromeVersionStorage,
  });
}
