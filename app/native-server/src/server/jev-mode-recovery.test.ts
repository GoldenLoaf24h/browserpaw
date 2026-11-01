import { jevModelManager } from './jev-model-manager';

describe('Jev requested mode and temporary failure recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(100000);
    jest
      .spyOn(jevModelManager, 'unloadLocalModel')
      .mockResolvedValue({ success: true, message: 'test' });
    jevModelManager.setActiveMode('off');
    jevModelManager.setRemoteConfig({ apiKey: 'test-key', modelId: 'jev-latest' });
  });
  afterEach(() => {
    jevModelManager.setActiveMode('off');
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('recovers a temporary pause on next use without a background request', () => {
    jevModelManager.setActiveMode('remote');
    jevModelManager.disableIfCurrent(jevModelManager.captureModeToken(), 'network_error');
    expect(jevModelManager.getModeState()).toMatchObject({
      activeMode: 'off',
      requestedMode: 'remote',
      retryAfter: 130000,
    });
    const fetch = jest.spyOn(globalThis, 'fetch');
    jest.advanceTimersByTime(29999);
    expect(jevModelManager.getActiveMode()).toBe('off');
    jest.advanceTimersByTime(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(jevModelManager.captureModeToken().activeMode).toBe('remote');
    expect(jevModelManager.getModeState()).toMatchObject({
      activeMode: 'remote',
      requestedMode: 'remote',
      retryAfter: null,
      disabledReason: null,
    });
  });

  test('manual off cancels automatic recovery permanently', () => {
    jevModelManager.setActiveMode('remote');
    jevModelManager.disableIfCurrent(jevModelManager.captureModeToken(), 'network_error');
    jevModelManager.setActiveMode('off');
    jest.advanceTimersByTime(600000);
    expect(jevModelManager.getActiveMode()).toBe('off');
    expect(jevModelManager.getModeState()).toMatchObject({
      requestedMode: 'off',
      retryAfter: null,
    });
    jevModelManager.setRemoteConfig({ apiKey: 'replacement-key' });
    expect(jevModelManager.getActiveMode()).toBe('off');
  });

  test('authentication failure stays disabled until configuration is corrected', () => {
    jevModelManager.setActiveMode('remote');
    jevModelManager.disableIfCurrent(jevModelManager.captureModeToken(), 'invalid_key');
    jest.advanceTimersByTime(600000);
    expect(jevModelManager.getActiveMode()).toBe('off');
    expect(jevModelManager.getModeState()).toMatchObject({
      requestedMode: 'remote',
      retryAfter: null,
    });
    jevModelManager.setRemoteConfig({ apiKey: 'corrected-key' });
    expect(jevModelManager.getActiveMode()).toBe('remote');
  });

  test('a late failure cannot disable the recovered configuration', () => {
    jevModelManager.setActiveMode('remote');
    const old = jevModelManager.captureModeToken();
    jevModelManager.disableIfCurrent(old, 'network_error');
    jest.advanceTimersByTime(30000);
    const recovered = jevModelManager.captureModeToken();
    expect(recovered.activeMode).toBe('remote');
    expect(recovered.revision).toBeGreaterThan(old.revision);
    expect(jevModelManager.disableIfCurrent(old, 'invalid_key')).toBe(false);
    expect(jevModelManager.getActiveMode()).toBe('remote');
  });

  test('retains a paused preference and recovered remote mode across Native restart', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bp-jev-recovery-'));
    const originalHome = process.env.BROWSERPAW_HOME;
    const originalEnv = process.env.NODE_ENV;
    process.env.BROWSERPAW_HOME = root;
    process.env.NODE_ENV = 'production';
    try {
      fs.writeFileSync(
        path.join(root, 'jev-remote.json'),
        JSON.stringify({
          activeMode: 'off',
          requestedMode: 'remote',
          retryAfter: 130000,
          disabledReason: 'network_error',
          revision: 5,
          apiKey: 'test-key',
        }),
      );
      let restored: typeof jevModelManager;
      jest.isolateModules(() => {
        restored = require('./jev-model-manager').jevModelManager;
      });
      expect(restored!.getModeState()).toMatchObject({
        activeMode: 'off',
        requestedMode: 'remote',
        retryAfter: 130000,
      });
      jest.advanceTimersByTime(30000);
      expect(restored!.getActiveMode()).toBe('remote');
      jest.isolateModules(() => {
        restored = require('./jev-model-manager').jevModelManager;
      });
      expect(restored!.getModeState()).toMatchObject({
        activeMode: 'remote',
        requestedMode: 'remote',
        retryAfter: null,
      });
      fs.writeFileSync(
        path.join(root, 'jev-remote.json'),
        JSON.stringify({
          activeMode: 'off',
          requestedMode: 'remote',
          disabledReason: 'remote_key_missing',
          apiKey: 'test-key',
        }),
      );
      jest.isolateModules(() => {
        restored = require('./jev-model-manager').jevModelManager;
      });
      expect(restored!.getActiveMode()).toBe('remote');
    } finally {
      if (originalHome === undefined) delete process.env.BROWSERPAW_HOME;
      else process.env.BROWSERPAW_HOME = originalHome;
      if (originalEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnv;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
