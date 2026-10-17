import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { computed, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../entrypoints/popup/App.vue'), 'utf8');

function loadPopup(
  stored: Record<string, unknown> = { jevRemoteConfig: { modelId: 'jev-1.13.0' } },
) {
  // Exercise the real setup functions without running popup lifecycle/network polling.
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
  const js = ts.transpileModule(script.replace(/^import .*?;\r?$/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const api = vi.fn();
  const set = vi.spyOn(chrome.storage.local, 'set').mockResolvedValue();
  vi.spyOn(chrome.storage.local, 'get').mockResolvedValue(stored);
  const popup = new Function(
    'ref',
    'computed',
    'onMounted',
    'onUnmounted',
    'nextTick',
    'CURRENT_VERSION',
    'checkExtensionVersionUpdate',
    'jevFetch',
    `${js}; return { remoteModelId, visionModelHint, remoteConfigError, isRemoteApplied, fetchRemoteConfig, applyRemoteConfig };`,
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

describe('popup remote config', () => {
  it('pins no model id and derives no vision consent in the extension', () => {
    const { popup } = loadPopup();

    // The release that decides whether `box` is available is reported by upstream at request
    // time, so the popup must not carry a model-name predicate of its own.
    expect(source).not.toMatch(/VISION_MODEL_PATTERN|modelEnablesVision/);
    expect(source).not.toMatch(/visionEnabled/);

    expect(popup.visionModelHint.value).toContain('Jev 1.14');
    expect(popup.visionModelHint.value).toContain('this endpoint reports');
  });

  it('hydrates the model field from storage without computing consent', async () => {
    const { popup, api } = loadPopup({ jevRemoteConfig: { modelId: 'jev-1.13.0' } });
    api.mockResolvedValue({ ok: true, json: async () => ({}) });

    await popup.fetchRemoteConfig();

    expect(popup.remoteModelId.value).toBe('jev-1.13.0');
  });

  it('applies a model id verbatim and only confirms a successful server save', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { popup, api, set } = loadPopup({});

    popup.remoteModelId.value = 'jev-preview';
    api.mockResolvedValue({ ok: false });
    await popup.applyRemoteConfig();
    expect(JSON.parse(api.mock.calls[0][1].body)).toMatchObject({ modelId: 'jev-preview' });
    expect(set).not.toHaveBeenCalled();
    expect(popup.isRemoteApplied.value).toBe(false);
    expect(popup.remoteConfigError.value).not.toBe('');

    api.mockResolvedValue({ ok: true });
    await popup.applyRemoteConfig();
    expect(set).toHaveBeenCalledWith({
      jevRemoteConfig: expect.objectContaining({ modelId: 'jev-preview' }),
    });
    expect(popup.isRemoteApplied.value).toBe(true);
    expect(popup.remoteConfigError.value).toBe('');

    // A custom gateway id is forwarded unchanged; the popup never judges it.
    popup.remoteModelId.value = 'my-vision-gateway';
    await popup.applyRemoteConfig();
    const lastBody = JSON.parse(api.mock.calls[api.mock.calls.length - 1][1].body);
    expect(lastBody).toMatchObject({ modelId: 'my-vision-gateway' });
    expect(lastBody).not.toHaveProperty('visionEnabled');
  });
});
