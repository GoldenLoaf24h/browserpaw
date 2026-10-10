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
        getManifest: vi.fn().mockReturnValue({ version: '4.0.0' }),
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
    expect(payload.manifestVersion).toBe('4.0.0');
    expect(payload.extensionId).toBe('test-extension-id');
  });

  it('omits buildId when verbose is false or omitted', async () => {
    const res = await doctorTool.execute({});
    expect(res.isError).toBe(false);

    const payload = JSON.parse(res.content[0].text);
    expect(payload.buildId).toBeUndefined();
  });
});
