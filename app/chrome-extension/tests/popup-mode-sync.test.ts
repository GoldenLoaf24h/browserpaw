import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, compileScript } from 'vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';

function setupPopup(api: ReturnType<typeof vi.fn>) {
  const mounted: Array<() => unknown> = [],
    unmounted: Array<() => unknown> = [];
  const source = readFileSync(resolve(__dirname, '../entrypoints/popup/App.vue'), 'utf8');
  const script = compileScript(parse(source).descriptor, { id: 'mode-contract' }).content;
  const code = ts.transpileModule(script, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as any };
  let setupActive = true;
  const load = (id: string) => {
    if (id === 'vue')
      return {
        ...vue,
        onMounted: (fn: () => unknown) => mounted.push(fn),
        onUnmounted: (fn: () => unknown) => {
          if (setupActive) unmounted.push(fn);
        },
      };
    if (id === 'chrome-mcp-shared') return { CURRENT_VERSION: '4.1.2' };
    if (id === './jev-api') return { jevFetch: api };
    if (id === '@/utils/version-checker')
      return { checkExtensionVersionUpdate: async () => ({ hasUpdate: false }) };
    throw new Error(`Unexpected popup dependency: ${id}`);
  };
  new Function('require', 'module', 'exports', code)(load, module, module.exports);
  const state = module.exports.default.setup({}, { expose: () => {} });
  setupActive = false;
  return {
    state,
    mount: async () => {
      for (const fn of mounted) await fn();
    },
    unmount: () => unmounted.forEach((fn) => fn()),
  };
}

describe('actual popup mode synchronization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      ...chrome,
      storage: { ...chrome.storage, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({ jevEngineMode: 'remote' });
    vi.spyOn(chrome.storage.session, 'get').mockResolvedValue({ agentControlEnabled: true });
    vi.spyOn(chrome.runtime, 'sendMessage').mockResolvedValue({ isRunning: true });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const makeApi = () =>
    vi.fn(async (path: string) => ({
      ok: true,
      json: async () =>
        path === '/jev/mode-state'
          ? { activeMode: 'off', revision: 4, disabledReason: 'invalid_key', changedAt: 1 }
          : path === '/jev/models'
            ? { models: [] }
            : {},
    }));
  it('opening adopts Native off without writing cached remote mode back', async () => {
    const api = makeApi(),
      popup = setupPopup(api);
    await popup.mount();
    expect(popup.state.jevMode.value).toBe('off');
    expect(popup.state.jevDisabledReason.value).toBe('invalid_key');
    expect(api.mock.calls.some(([path]) => path === '/jev/set-mode')).toBe(false);
    popup.unmount();
  });
  it('switching follows the confirmed Native result', async () => {
    const api = makeApi(),
      popup = setupPopup(api);
    api.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        mode: 'off',
        modeState: { activeMode: 'off', disabledReason: 'local_model_missing' },
      }),
    }));
    await popup.state.setJevMode('local');
    expect(popup.state.jevMode.value).toBe('off');
    expect(popup.state.jevDisabledReason.value).toBe('local_model_missing');
    popup.unmount();
  });
  it('removes the mode storage listener when the popup closes', async () => {
    const add = vi.spyOn(chrome.storage.onChanged, 'addListener');
    const remove = vi.spyOn(chrome.storage.onChanged, 'removeListener');
    const popup = setupPopup(makeApi());
    await popup.mount();
    const listener = add.mock.calls[0][0];
    popup.unmount();
    expect(remove).toHaveBeenCalledWith(listener);
  });
  it('shows unconfirmed instead of treating cached remote mode as active while disconnected', async () => {
    const api = makeApi();
    const normal = api.getMockImplementation()!;
    api.mockImplementation(async (path) => {
      if (path === '/jev/mode-state') throw new Error('Native unavailable');
      return normal(path);
    });
    const popup = setupPopup(api);
    await popup.mount();
    expect(popup.state.headerPillState.value.text).toBe('Unconfirmed');
    popup.unmount();
  });
  it('opening with temporary pause adopts requestedMode in UI and displays Paused badge without manual re-enable', async () => {
    const api = vi.fn(async (path) => ({
      ok: true,
      json: async () =>
        path === '/jev/mode-state'
          ? {
              activeMode: 'off',
              requestedMode: 'remote',
              retryAfter: Date.now() + 30000,
              disabledReason: 'network_error',
            }
          : path === '/jev/models'
            ? { models: [] }
            : {},
    }));
    const popup = setupPopup(api);
    await popup.mount();
    expect(popup.state.jevMode.value).toBe('off');
    expect(popup.state.jevRequestedMode.value).toBe('remote');
    expect(popup.state.isTemporarilyPaused.value).toBe(true);
    expect(popup.state.headerPillState.value.text).toBe('Paused');
    expect(popup.state.jevOffReasonText.value).toBe(
      'Temporarily paused; retries automatically on next use',
    );
    expect(api.mock.calls.some(([path]) => path === '/jev/set-mode')).toBe(false);
    popup.unmount();
  });
  it('switching explicitly to off clears requested preference and displays Off without Paused badge', async () => {
    const api = makeApi(),
      popup = setupPopup(api);
    api.mockImplementation(async (path) => ({
      ok: true,
      json: async () =>
        path === '/jev/set-mode'
          ? {
              mode: 'off',
              modeState: {
                activeMode: 'off',
                requestedMode: 'off',
                retryAfter: null,
                disabledReason: 'user_turned_off',
              },
            }
          : {},
    }));
    await popup.state.setJevMode('off');
    expect(popup.state.jevMode.value).toBe('off');
    expect(popup.state.jevRequestedMode.value).toBe('off');
    expect(popup.state.isTemporarilyPaused.value).toBe(false);
    expect(popup.state.headerPillState.value.text).toBe('Off');
    popup.unmount();
  });
  it('storage change with temporary pause updates requestedMode and Paused badge without writing back to cache', async () => {
    const add = vi.spyOn(chrome.storage.onChanged, 'addListener');
    const setSpy = vi.spyOn(chrome.storage.local, 'set');
    const popup = setupPopup(makeApi());
    await popup.mount();
    const listener = add.mock.calls[0][0];
    setSpy.mockClear();
    listener(
      {
        jevModeState: {
          oldValue: { activeMode: 'remote', requestedMode: 'remote' },
          newValue: {
            activeMode: 'off',
            requestedMode: 'remote',
            retryAfter: Date.now() + 30000,
            disabledReason: 'rate_limited',
          },
        },
      },
      'local',
    );
    expect(popup.state.jevMode.value).toBe('off');
    expect(popup.state.jevRequestedMode.value).toBe('remote');
    expect(popup.state.isTemporarilyPaused.value).toBe(true);
    expect(popup.state.headerPillState.value.text).toBe('Paused');
    expect(setSpy).not.toHaveBeenCalled();
    popup.unmount();
  });
  it('reloading popup does not lose Remote requested preference', async () => {
    vi.spyOn(chrome.storage.local, 'get').mockImplementation(async () => ({
      jevModeState: {
        activeMode: 'off',
        requestedMode: 'remote',
        retryAfter: Date.now() + 30000,
        disabledReason: 'network_error',
      },
    }));
    const api = makeApi();
    const original = api.getMockImplementation()!;
    api.mockImplementation(async (path) =>
      path === '/jev/mode-state'
        ? {
            ok: true,
            json: async () => ({
              activeMode: 'off',
              requestedMode: 'remote',
              retryAfter: 30000,
              disabledReason: 'network_error',
            }),
          }
        : original(path),
    );
    const popup = setupPopup(api);
    await popup.mount();
    expect(popup.state.jevRequestedMode.value).toBe('remote');
    popup.unmount();
  });
});
