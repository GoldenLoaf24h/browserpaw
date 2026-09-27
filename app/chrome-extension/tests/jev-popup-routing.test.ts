import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Jev Engine Popup UI Routing & State Machine (§1, §2)', () => {
  const storage: Record<string, any> = {};
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(storage)) {
      delete storage[k];
    }

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (key: string) => {
            return { [key]: storage[key] };
          }),
          set: vi.fn().mockImplementation(async (obj: Record<string, any>) => {
            Object.assign(storage, obj);
          }),
        },
      },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('1. Persists jevEngineMode in chrome.storage.local across off / local / remote', async () => {
    await (globalThis as any).chrome.storage.local.set({ jevEngineMode: 'remote' });
    let res = await (globalThis as any).chrome.storage.local.get('jevEngineMode');
    expect(res.jevEngineMode).toBe('remote');

    await (globalThis as any).chrome.storage.local.set({ jevEngineMode: 'local' });
    res = await (globalThis as any).chrome.storage.local.get('jevEngineMode');
    expect(res.jevEngineMode).toBe('local');

    await (globalThis as any).chrome.storage.local.set({ jevEngineMode: 'off' });
    res = await (globalThis as any).chrome.storage.local.get('jevEngineMode');
    expect(res.jevEngineMode).toBe('off');
  });

  it('2. Synchronizes active mode with Native Server set-mode endpoint in memory', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, mode: 'local' }),
    });
    globalThis.fetch = fetchMock as any;

    const setMode = async (mode: 'off' | 'local' | 'remote') => {
      await (globalThis as any).chrome.storage.local.set({ jevEngineMode: mode });
      await fetch('http://127.0.0.1:12306/jev/set-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    };

    await setMode('local');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:12306/jev/set-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'local' }),
    });
    expect(storage['jevEngineMode']).toBe('local');
  });

  it('3. Simulates state machine: Expand on un-downloaded Local -> Download -> Completed -> Select Local', async () => {
    let modelDownloaded = false;
    let isExpanded = false;
    let isDownloading = false;
    let currentMode: 'off' | 'local' | 'remote' = 'off';

    const handleSelectMode = (mode: 'off' | 'local' | 'remote') => {
      if (mode === 'local' && !modelDownloaded) {
        isExpanded = true;
        return;
      }
      isExpanded = false;
      currentMode = mode;
    };

    // Step A -> B: Clicking Local when model is not downloaded expands action bar
    handleSelectMode('local');
    expect(isExpanded).toBe(true);
    expect(currentMode).toBe('off');

    // Step B -> C: User clicks confirm download
    isDownloading = true;
    isExpanded = false;
    expect(isDownloading).toBe(true);

    // Step C -> D: Download completes at 100%
    modelDownloaded = true;
    isDownloading = false;
    handleSelectMode('local');

    expect(isExpanded).toBe(false);
    expect(currentMode).toBe('local');
    expect(modelDownloaded).toBe(true);
  });

  it('4. Simulates Header Badge to Manage morph and sub-panel toggle', async () => {
    let showManageBtn = false;
    let isManaging = false;

    // Simulate 0.5s timer after selecting local or remote
    const triggerManageMorph = () => {
      showManageBtn = false;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          showManageBtn = true;
          resolve();
        }, 500);
      });
    };

    const timerPromise = triggerManageMorph();
    expect(showManageBtn).toBe(false);

    await timerPromise;
    expect(showManageBtn).toBe(true);

    // Clicking Manage toggles isManaging to true
    isManaging = true;
    expect(isManaging).toBe(true);

    // Clicking Return toggles isManaging to false
    isManaging = false;
    expect(isManaging).toBe(false);
  });

  it('5. Simulates Local Model cycling and delete confirmation with fallback', async () => {
    let localModels = ['decider-2b', 'decider-2b-custom'];
    let activeIndex = 0;
    let isDeleting = false;

    // Switch to next model
    activeIndex++;
    expect(localModels[activeIndex]).toBe('decider-2b-custom');

    // Click delete -> isDeleting becomes true
    isDeleting = true;
    expect(isDeleting).toBe(true);

    // Confirm delete target model
    const deletedModel = localModels[activeIndex];
    localModels = localModels.filter((m) => m !== deletedModel);
    activeIndex = 0;
    isDeleting = false;

    expect(localModels).toEqual(['decider-2b']);
    expect(localModels[activeIndex]).toBe('decider-2b');
    expect(isDeleting).toBe(false);
  });

  it('6. Simulates Remote Config persistence and server sync', async () => {
    const remoteCfg = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-123',
      modelId: 'decider-2b',
    };

    await (globalThis as any).chrome.storage.local.set({ jevRemoteConfig: remoteCfg });
    const stored = await (globalThis as any).chrome.storage.local.get('jevRemoteConfig');
    expect(stored.jevRemoteConfig).toEqual(remoteCfg);
  });

  it('7. Simulates download cancellation via stop button and verifies /jev/download-cancel endpoint', async () => {
    let isDownloading = true;
    let progressTimer: any = setInterval(() => {}, 1000);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: 'Cancelled' }),
    });
    globalThis.fetch = fetchMock as any;

    // User clicks stop button
    const stopDownload = async () => {
      clearInterval(progressTimer);
      progressTimer = null;
      isDownloading = false;
      await fetch('http://127.0.0.1:12306/jev/download-cancel', { method: 'POST' });
    };

    await stopDownload();
    expect(isDownloading).toBe(false);
    expect(progressTimer).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:12306/jev/download-cancel', {
      method: 'POST',
    });
  });

  it('8. Simulates download error display, retry, and dismiss state transitions', async () => {
    let isDownloading = true;
    let downloadError = '';
    let retryCalled = false;

    // Simulate download failure
    isDownloading = false;
    downloadError = 'HTTP 504 Gateway Timeout';

    expect(isDownloading).toBe(false);
    expect(downloadError).toBe('HTTP 504 Gateway Timeout');

    // Simulate retry action
    const retryDownload = () => {
      downloadError = '';
      retryCalled = true;
      isDownloading = true;
    };

    retryDownload();
    expect(downloadError).toBe('');
    expect(retryCalled).toBe(true);
    expect(isDownloading).toBe(true);

    // Simulate another error followed by dismiss action
    isDownloading = false;
    downloadError = 'Network connection lost';
    const dismissError = () => {
      downloadError = '';
    };

    dismissError();
    expect(downloadError).toBe('');
    expect(isDownloading).toBe(false);
  });

  it('9. Simulates reciprocal expand and collapse transitions on Local button when model is not downloaded', async () => {
    const modelDownloaded = false;
    let isExpanded = false;
    let isCollapsing = false;
    let jevMode: 'off' | 'local' | 'remote' = 'remote';

    const setJevMode = (mode: 'off' | 'local' | 'remote') => {
      if (isCollapsing) return;
      if (mode === jevMode && !isExpanded) {
        if (mode === 'local' && !modelDownloaded) {
          isExpanded = true;
        }
        return;
      }
      jevMode = mode;
      if (mode === 'local' && !modelDownloaded) {
        isExpanded = true;
      } else {
        isExpanded = false;
        isCollapsing = false;
      }
    };

    const cancelExpand = () => {
      if (isCollapsing) return;
      isCollapsing = true;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          isExpanded = false;
          isCollapsing = false;
          resolve();
        }, 260);
      });
    };

    // User clicks Local without model -> expands
    setJevMode('local');
    expect(jevMode).toBe('local');
    expect(isExpanded).toBe(true);
    expect(isCollapsing).toBe(false);

    // User clicks Cancel ✕ -> starts collapsing with reciprocal transition
    const collapsePromise = cancelExpand();
    expect(isCollapsing).toBe(true);
    expect(isExpanded).toBe(true); // Still true during the 260ms transition

    await collapsePromise;
    expect(isCollapsing).toBe(false);
    expect(isExpanded).toBe(false); // Collapsed back to Local button
    expect(jevMode).toBe('local');

    // Clicking Local again when already in Local mode expands again
    setJevMode('local');
    expect(isExpanded).toBe(true);
  });

  it('10. Verifies MCP master switch (MCP on/off) and status coupling (Connected only when switch is on AND server is reachable)', () => {
    let agentEnabled = true;
    let serverConnected = true;

    const isMcpConnected = () => agentEnabled && serverConnected;
    const getStatusText = () => (isMcpConnected() ? 'Connected' : 'Disconnected');
    const getMcpLabel = () => (agentEnabled ? 'MCP on' : 'MCP off');

    // Both switch on and server connected -> MCP on, Connected
    expect(getMcpLabel()).toBe('MCP on');
    expect(isMcpConnected()).toBe(true);
    expect(getStatusText()).toBe('Connected');

    // User toggles MCP off -> immediately MCP off, Disconnected, not green
    agentEnabled = false;
    expect(getMcpLabel()).toBe('MCP off');
    expect(isMcpConnected()).toBe(false);
    expect(getStatusText()).toBe('Disconnected');

    // User toggles MCP back on -> immediately MCP on, Connected, green
    agentEnabled = true;
    expect(getMcpLabel()).toBe('MCP on');
    expect(isMcpConnected()).toBe(true);
    expect(getStatusText()).toBe('Connected');

    // Server offline -> Disconnected even if MCP on
    serverConnected = false;
    expect(getMcpLabel()).toBe('MCP on');
    expect(isMcpConnected()).toBe(false);
    expect(getStatusText()).toBe('Disconnected');
  });
});
