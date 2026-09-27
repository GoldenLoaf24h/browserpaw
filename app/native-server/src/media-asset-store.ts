export interface MediaAssetEntry {
  filePath?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName: string;
  createdAt?: number;
}

const MEDIA_ASSET_TTL_MS = 10 * 60 * 1000; // 10 minutes TTL

class MediaAssetStore extends Map<string, MediaAssetEntry> {
  constructor() {
    super();
    const timer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  override set(key: string, value: MediaAssetEntry): this {
    this.cleanup();
    return super.set(key, { ...value, createdAt: Date.now() });
  }

  override get(key: string): MediaAssetEntry | undefined {
    const entry = super.get(key);
    if (!entry) return undefined;
    if (entry.createdAt && Date.now() - entry.createdAt > MEDIA_ASSET_TTL_MS) {
      super.delete(key);
      return undefined;
    }
    return entry;
  }

  override has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [k, v] of super.entries()) {
      if (v.createdAt && now - v.createdAt > MEDIA_ASSET_TTL_MS) {
        super.delete(k);
      }
    }
  }
}

export const mediaAssetStore = new MediaAssetStore();
