import { describe, it, expect, vi, beforeEach } from 'vitest';
import { doctorTool } from '../entrypoints/background/tools/browser/doctor';

describe('DoctorTool buildId and verbose reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

    // Accurate test mocks matching extension environment
    (globalThis as any).chrome = {
      storage: {
        local: { get: vi.fn().mockResolvedValue({}) },
        session: { get: vi.fn().mockResolvedValue({}) },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
      },
      windows: {
        getAll: vi.fn().mockResolvedValue([]),
      },
      runtime: {
        id: 'test-extension-id',
        getManifest: vi.fn().mockReturnValue({ version: '4.1.2' }),
      },
    };
  });

  it('safely defaults to unbuilt in test environment and reports buildId on verbose', async () => {
    const res = await doctorTool.execute({ verbose: true });
    expect(res.isError).toBe(false);
    expect(res.content).toHaveLength(1);

    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.buildId).toBe('unbuilt');
    expect(payload.manifestVersion).toBe('4.1.2');
    expect(payload.extensionId).toBe('test-extension-id');
  });

  it('omits buildId when verbose is false or omitted', async () => {
    const res = await doctorTool.execute({});
    expect(res.isError).toBe(false);

    const payload = JSON.parse(res.content[0].text);
    expect(payload.buildId).toBeUndefined();
  });

  it('reports Native-authoritative Jev mode and confirms its extension mirror', async () => {
    const state = { activeMode: 'remote', revision: 9, disabledReason: null, changedAt: 1234 };
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ jevModeState: state });
    globalThis.fetch = vi.fn(
      async (url) =>
        ({
          ok: true,
          json: async () => (String(url).endsWith('/jev/mode-state') ? state : {}),
        }) as Response,
    );

    const result = JSON.parse((await doctorTool.execute({ verbose: true })).content[0].text);
    expect(result.jev).toMatchObject({
      confirmed: true,
      activeMode: 'remote',
      backend: 'TypeSafe Jev',
      revision: 9,
      disabledReason: null,
      mirrorMatches: true,
    });
  });

  it('preserves automatic-off reason without treating off as unhealthy', async () => {
    const state = {
      activeMode: 'off',
      revision: 10,
      disabledReason: 'invalid_response',
      changedAt: 2345,
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => state }) as Response);
    const result = JSON.parse((await doctorTool.execute({ verbose: true })).content[0].text);
    expect(result.jev).toMatchObject({
      confirmed: true,
      activeMode: 'off',
      disabledReason: 'invalid_response',
      mirrorMatches: false,
    });
    expect(result.healthy).toBe(true);
  });

  it('detects a stale requested-mode mirror even when effective mode and revision match', async () => {
    const state = {
      activeMode: 'off',
      requestedMode: 'remote',
      retryAfter: 30000,
      revision: 11,
      disabledReason: 'timeout',
      changedAt: 2345,
    };
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      jevModeState: { ...state, requestedMode: 'off', retryAfter: null },
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => state }) as Response);
    const result = JSON.parse((await doctorTool.execute({ verbose: true })).content[0].text);
    expect(result.jev).toMatchObject({
      requestedMode: 'remote',
      retryAfter: 30000,
      mirrorMatches: false,
    });
  });

  it('does not report cached remote mode as confirmed when Native state cannot be read', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      jevModeState: { activeMode: 'remote', revision: 9 },
    });
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/jev/mode-state')) throw new Error('unavailable');
      return { ok: true } as Response;
    });
    const result = JSON.parse((await doctorTool.execute({ verbose: true })).content[0].text);
    expect(result.jev).toEqual({ confirmed: false });
  });
});
