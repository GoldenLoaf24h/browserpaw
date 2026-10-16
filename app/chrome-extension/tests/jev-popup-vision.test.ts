import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { computed, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../entrypoints/popup/App.vue'), 'utf8');

function loadPopup() {
  // Exercise the real setup functions without running popup lifecycle/network polling.
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
  const js = ts.transpileModule(script.replace(/^import .*?;\r?$/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const api = vi.fn();
  const set = vi.spyOn(chrome.storage.local, 'set').mockResolvedValue();
  vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({
    jevRemoteConfig: { visionEnabled: true },
  });
  const popup = new Function(
    'ref',
    'computed',
    'onMounted',
    'onUnmounted',
    'nextTick',
    'CURRENT_VERSION',
    'checkExtensionVersionUpdate',
    'jevFetch',
    `${js}; return { remoteVisionEnabled, remoteConfigError, isRemoteApplied, fetchRemoteConfig, applyRemoteConfig };`,
  )(
    ref,
    computed,
    () => {},
    () => {},
    async () => {},
    'test',
    vi.fn(),
    api,
  );
  return { popup, api, set };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('popup vision consent', () => {
  it('uses server consent rather than a stale local enabled value', async () => {
    const { popup, api } = loadPopup();
    expect(popup.remoteVisionEnabled.value).toBe(false);
    api.mockResolvedValue({ ok: true, json: async () => ({ visionEnabled: false }) });
    await popup.fetchRemoteConfig();
    expect(popup.remoteVisionEnabled.value).toBe(false);
    api.mockResolvedValue({ ok: true, json: async () => ({ visionEnabled: true }) });
    await popup.fetchRemoteConfig();
    expect(popup.remoteVisionEnabled.value).toBe(true);
  });

  it('sends explicit consent and only confirms a successful server save', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { popup, api, set } = loadPopup();
    popup.remoteVisionEnabled.value = true;
    api.mockResolvedValue({ ok: false });
    await popup.applyRemoteConfig();
    expect(JSON.parse(api.mock.calls[0][1].body).visionEnabled).toBe(true);
    expect(set).not.toHaveBeenCalled();
    expect(popup.isRemoteApplied.value).toBe(false);
    expect(popup.remoteConfigError.value).not.toBe('');
    api.mockResolvedValue({ ok: true });
    await popup.applyRemoteConfig();
    expect(set).toHaveBeenCalledWith({
      jevRemoteConfig: expect.objectContaining({ visionEnabled: true }),
    });
    expect(popup.isRemoteApplied.value).toBe(true);
    expect(popup.remoteConfigError.value).toBe('');
  });
});
