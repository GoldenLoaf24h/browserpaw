import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('browser identity survives workers without trusting reused tab numbers', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  it('reuses storage.session identity across module reloads and deduplicates concurrent reads', async () => {
    const state: Record<string, unknown> = {};
    const get = vi.fn(async () => ({ ...state }));
    const set = vi.fn(async (values: object) => {
      Object.assign(state, values);
    });
    vi.stubGlobal('chrome', { storage: { session: { get, set } } });
    const first = await import('../utils/browser-identity');
    const ids = await Promise.all([first.getBrowserInstanceId(), first.getBrowserInstanceId()]);
    expect(ids[0]).toBe(ids[1]);
    expect(set).toHaveBeenCalledTimes(1);
    vi.resetModules();
    const next = await import('../utils/browser-identity');
    expect(await next.getBrowserInstanceId()).toBe(ids[0]);
    expect(set).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
  it('retries a failed storage read instead of caching the rejection', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue({ browserpaw_browser_instance_id: 'existing-browser' });
    vi.stubGlobal('chrome', { storage: { session: { get } } });
    const { getBrowserInstanceId } = await import('../utils/browser-identity');
    await expect(getBrowserInstanceId()).rejects.toThrow('storage unavailable');
    expect(await getBrowserInstanceId()).toBe('existing-browser');
    vi.unstubAllGlobals();
  });
});
