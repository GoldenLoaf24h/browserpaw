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
    `${js}; return { remoteModelId, visionModelHint, modelEnablesVision, remoteConfigError, isRemoteApplied, fetchRemoteConfig, applyRemoteConfig };`,
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
  it('derives vision consent from the model name alone', () => {
    const { popup } = loadPopup();

    // TypeSafe `box` — which the visual click fallback needs — requires Jev 1.14.
    expect(popup.modelEnablesVision('jev-preview')).toBe(true);
    expect(popup.modelEnablesVision('jev-1.14.0')).toBe(true);
    expect(popup.modelEnablesVision('jev-1.14')).toBe(true);
    expect(popup.modelEnablesVision('jev-1.14.0-preview')).toBe(true);

    // `jev-latest` still resolves to Jev 1.13, which accepts images but cannot answer `box`.
    expect(popup.modelEnablesVision('jev-latest')).toBe(false);
    expect(popup.modelEnablesVision('jev-1.13.0')).toBe(false);
    expect(popup.modelEnablesVision('gpt-4o')).toBe(false);

    // A model merely containing the word must not silently enable screenshot upload.
    expect(popup.modelEnablesVision('previewish-model')).toBe(false);
    expect(popup.modelEnablesVision('my-vision-gateway')).toBe(false);
    expect(popup.modelEnablesVision('my-1.140-model')).toBe(false);

    expect(popup.remoteModelId.value).toBe('');
    expect(popup.visionModelHint.value).toContain('Vision off');

    popup.remoteModelId.value = 'jev-preview';
    expect(popup.visionModelHint.value).toContain('Vision enabled');
  });

  it('hydrates the model field from storage and keeps vision off for a text model', async () => {
    const { popup, api } = loadPopup({ jevRemoteConfig: { modelId: 'jev-1.13.0' } });
    api.mockResolvedValue({ ok: true, json: async () => ({ visionEnabled: true }) });

    await popup.fetchRemoteConfig();

    expect(popup.remoteModelId.value).toBe('jev-1.13.0');
    expect(popup.modelEnablesVision(popup.remoteModelId.value)).toBe(false);
  });

  it('sends the derived consent and only confirms a successful server save', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { popup, api, set } = loadPopup({});

    popup.remoteModelId.value = 'jev-preview';
    api.mockResolvedValue({ ok: false });
    await popup.applyRemoteConfig();
    expect(JSON.parse(api.mock.calls[0][1].body).visionEnabled).toBe(true);
    expect(set).not.toHaveBeenCalled();
    expect(popup.isRemoteApplied.value).toBe(false);
    expect(popup.remoteConfigError.value).not.toBe('');

    api.mockResolvedValue({ ok: true });
    await popup.applyRemoteConfig();
    expect(set).toHaveBeenCalledWith({
      jevRemoteConfig: expect.objectContaining({ modelId: 'jev-preview', visionEnabled: true }),
    });
    expect(popup.isRemoteApplied.value).toBe(true);
    expect(popup.remoteConfigError.value).toBe('');

    // Switching back to a text-only model must withdraw consent in the same request.
    popup.remoteModelId.value = 'jev-latest';
    await popup.applyRemoteConfig();
    const lastBody = JSON.parse(api.mock.calls[api.mock.calls.length - 1][1].body);
    expect(lastBody).toMatchObject({ modelId: 'jev-latest', visionEnabled: false });
  });
});
