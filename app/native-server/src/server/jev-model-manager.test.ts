import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import {
  JevModelManager,
  jevModelManager,
  resolveOptimalDownloadUrl,
  HF_DOMESTIC_MIRRORS,
} from './jev-model-manager';

describe('JevModelManager & Downloader (§1, §3)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jevModelManager.setActiveMode('remote');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('1. In-memory mode switching takes <= 2ms and updates state accurately', () => {
    const start = performance.now();
    jevModelManager.setActiveMode('local');
    const elapsedLocal = performance.now() - start;

    expect(elapsedLocal).toBeLessThan(2);
    expect(jevModelManager.getActiveMode()).toBe('local');

    jevModelManager.setActiveMode('off');
    expect(jevModelManager.getActiveMode()).toBe('off');

    jevModelManager.setActiveMode('remote');
    expect(jevModelManager.getActiveMode()).toBe('remote');

    // Invalid mode ignored
    jevModelManager.setActiveMode('invalid_mode' as any);
    expect(jevModelManager.getActiveMode()).toBe('remote');
  });

  test('2. getStatus returns comprehensive model & service info', async () => {
    const status = await jevModelManager.getStatus();

    expect(status).toHaveProperty('downloaded');
    expect(status).toHaveProperty('path');
    expect(status).toHaveProperty('sizeBytes');
    expect(status).toHaveProperty('activeMode', 'remote');
    expect(status).toHaveProperty('localServiceOnline');
    expect(typeof status.downloaded).toBe('boolean');
    expect(typeof status.path).toBe('string');
  });

  test('3. detectOptimalBaseUrl selects official source when reachable', async () => {
    global.fetch = jest.fn().mockImplementation((url: any) => {
      if (String(url).includes('huggingface.co')) {
        return Promise.resolve({ ok: true, status: 200 } as any);
      }
      return Promise.reject(new Error('fail'));
    }) as any;

    const url = await jevModelManager.detectOptimalBaseUrl();
    expect(url).toBe('https://huggingface.co');
  });

  test('4. detectOptimalBaseUrl silently falls back to mirror when official is blocked', async () => {
    global.fetch = jest.fn().mockImplementation((url: any) => {
      if (String(url).includes('huggingface.co')) {
        return Promise.reject(new Error('Timeout / Blocked'));
      }
      if (String(url).includes('myip.ipip.net')) {
        return Promise.resolve({
          ok: true,
          text: async () => '当前 IP: 114.114.114.114 来自: 中国 江苏 南京',
        } as any);
      }
      return Promise.resolve({ ok: true } as any);
    }) as any;

    const url = await resolveOptimalDownloadUrl();
    expect(HF_DOMESTIC_MIRRORS).toContain(url);
  });

  test('5. getProgress returns initial idle state structure', () => {
    const progress = jevModelManager.getProgress();
    expect(progress).toHaveProperty('status');
    expect(progress).toHaveProperty('percent');
    expect(progress).toHaveProperty('speed');
    expect(progress).toHaveProperty('currentFile');
  });

  test('6. detectOptimalBaseUrl detects Mainland China via Baidu ping and chooses mirror', async () => {
    global.fetch = jest.fn().mockImplementation((url: any) => {
      if (String(url).includes('baidu.com')) {
        return Promise.resolve({ ok: true, status: 200 } as any);
      }
      if (String(url).includes('huggingface.co')) {
        return Promise.reject(new Error('Blocked / GFW timeout'));
      }
      return Promise.reject(new Error('unreachable'));
    }) as any;

    const url = await jevModelManager.detectOptimalBaseUrl();
    expect(url).toBe('https://hf-mirror.com');
  });

  test('7. local model listing, active switching, and remote config storage', async () => {
    const models = jevModelManager.listModels();
    expect(Array.isArray(models)).toBe(true);

    const activeBefore = jevModelManager.getActiveModel();
    expect(typeof activeBefore).toBe('string');

    jevModelManager.setActiveModel('custom-model-test');
    expect(jevModelManager.getActiveModel()).toBe('custom-model-test');

    jevModelManager.setRemoteConfig({
      baseUrl: 'https://api.my-endpoint.com/v1',
      apiKey: 'sk-test-key-12345',
      modelId: 'decider-2b-pro',
    });

    const cfg = jevModelManager.getRemoteConfig();
    expect(cfg.baseUrl).toBe('https://api.my-endpoint.com/v1');
    expect(cfg.apiKey).toBe('sk-test-key-12345');
    expect(cfg.modelId).toBe('decider-2b-pro');
  });

  test('8. cancelDownload cancels active download and resets state safely', () => {
    // When no download is active
    const resNoDownload = jevModelManager.cancelDownload();
    expect(resNoDownload.success).toBe(true);

    const progress = jevModelManager.getProgress();
    expect(progress.status).toBe('idle');
  });

  test('9. isHuggingFaceTarget correctly identifies HF vs custom non-HF URLs', () => {
    const { isHuggingFaceTarget } = require('./jev-model-manager');
    expect(isHuggingFaceTarget('Mapika/decider-2b')).toBe(true);
    expect(isHuggingFaceTarget('https://huggingface.co/Mapika/decider-2b')).toBe(true);
    expect(isHuggingFaceTarget('https://hf-mirror.com/Mapika/decider-2b')).toBe(true);
    expect(isHuggingFaceTarget('https://hf-mirror.net/Mapika/decider-2b')).toBe(true);
    expect(isHuggingFaceTarget('https://aifasthub.com/Mapika/decider-2b')).toBe(true);

    // Non-HF platforms
    expect(isHuggingFaceTarget('https://modelscope.cn/models/decider.safetensors')).toBe(false);
    expect(isHuggingFaceTarget('https://gitee.com/ai/decider.safetensors')).toBe(false);
    expect(isHuggingFaceTarget('http://localhost:8000/weights.bin')).toBe(false);
  });

  test('10. detectOptimalBaseUrl strictly avoids foreign source when domestic network is reachable even with active proxy', async () => {
    // Both baidu and huggingface succeed (user has proxy enabled)
    global.fetch = jest.fn().mockImplementation((url: any) => {
      if (String(url).includes('baidu.com')) {
        return Promise.resolve({ ok: true, status: 200 } as any);
      }
      if (String(url).includes('hf-mirror.net')) {
        return Promise.resolve({ ok: true, status: 200 } as any);
      }
      if (String(url).includes('huggingface.co')) {
        // Fast overseas proxy response
        return Promise.resolve({ ok: true, status: 200 } as any);
      }
      return Promise.resolve({ ok: true, status: 200 } as any);
    }) as any;

    const url = await jevModelManager.detectOptimalBaseUrl();
    expect(url).not.toBe('https://huggingface.co');
    expect(url.startsWith('https://hf-mirror.') || url.includes('aifasthub.com')).toBe(true);
  });

  test('11. touchActivity updates timestamp and onToolInvocation preloads local model', async () => {
    const t0 = jevModelManager.getLastActivityTime();
    await new Promise((r) => setTimeout(r, 10));
    jevModelManager.touchActivity();
    expect(jevModelManager.getLastActivityTime()).toBeGreaterThanOrEqual(t0);

    // Spy on ensureLocalServiceRunning
    const ensureSpy = jest
      .spyOn(jevModelManager, 'ensureLocalServiceRunning')
      .mockResolvedValue({ success: true });
    jest.spyOn(jevModelManager, 'isModelDownloaded').mockReturnValue(true);
    jest.spyOn(jevModelManager, 'isLocalServiceOnline').mockResolvedValue(false);

    jevModelManager.setActiveMode('local');
    jevModelManager.onToolInvocation();

    await new Promise((r) => setTimeout(r, 20));
    expect(ensureSpy).toHaveBeenCalled();
  });

  test('12. unloadLocalModel sends unload signal and cleans state safely', async () => {
    global.fetch = jest.fn().mockImplementation((url: any) => {
      if (String(url).includes('/unload')) {
        return Promise.resolve({ ok: true, status: 200 } as any);
      }
      return Promise.resolve({ ok: true } as any);
    }) as any;

    const res = await jevModelManager.unloadLocalModel();
    expect(res.success).toBe(true);
    expect(res.message).toContain('unloaded');
  });

  test('13. getStatus reports idleTimeoutMs and lastActivityTime', async () => {
    const status = await jevModelManager.getStatus();
    expect(status.idleTimeoutMs).toBe(10 * 60 * 1000);
    expect(typeof status.lastActivityTime).toBe('number');
  });

  test('14. detectCudaAvailable returns true when CUDA environment is functional', () => {
    process.env.MOCK_CUDA_AVAILABLE = 'true';
    expect(jevModelManager.detectCudaAvailable('python')).toBe(true);

    process.env.MOCK_CUDA_AVAILABLE = 'false';
    expect(jevModelManager.detectCudaAvailable('python')).toBe(false);
    delete process.env.MOCK_CUDA_AVAILABLE;
  });
});
