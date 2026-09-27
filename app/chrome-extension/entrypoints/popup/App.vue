<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';

import { CURRENT_VERSION } from 'chrome-mcp-shared';
import { checkExtensionVersionUpdate } from '@/utils/version-checker';

const agentEnabled = ref(true);
const serverConnected = ref(false);
const isMcpConnected = computed(() => agentEnabled.value && serverConnected.value);
const cursorMode = ref<'off' | 'auto' | 'always'>('always');
const cursorIconUrl = computed(() => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    try {
      return chrome.runtime.getURL('images/cursor-chat.png');
    } catch {}
  }
  return '/images/cursor-chat.png';
});
const windowMode = ref<'tab' | 'window'>('tab');
const currentVersion = ref(CURRENT_VERSION);
const versionChecked = ref(false);
const hasUpdate = ref(false);
const latestReleaseUrl = ref('https://github.com/GoldenLoaf24h/browserpaw/releases/latest');
const isHydrated = ref(false);
const transitionEnabled = ref(false);

// Jev Engine state
const jevMode = ref<'off' | 'local' | 'remote'>('remote');
const modelDownloaded = ref(false);
const isExpanded = ref(false);
const isCollapsing = ref(false);
const isDownloading = ref(false);
const downloadPercent = ref(0);
const downloadSpeed = ref('');
const downloadError = ref('');
const isCompletedFlash = ref(false);
let progressTimer: any = null;

// Jev Engine Interactive Management state
const isManaging = ref(false);
const showManageBtn = ref(true);
let manageBtnTimer: any = null;

const localModels = ref<string[]>([]);
const activeModelIndex = ref(0);
const activeModelName = computed(() => {
  if (localModels.value.length === 0) return 'No local model installed';
  return (
    localModels.value[activeModelIndex.value] || localModels.value[0] || 'No local model installed'
  );
});

const isDeleting = ref(false);
const isDeleteWiping = ref(false);
const deleteNotice = ref('');

const customModelUrl = ref('');
const isCustomDownloading = ref(false);
const isDownloadSuccess = ref(false);
const customDownloadError = ref('');

const remoteBaseUrl = ref('');
const remoteApiKey = ref('');
const remoteModelId = ref('');
const isRemoteApplied = ref(false);
const envApiKeyDetected = ref(false);
const envKeySourceName = ref('TYPESAFE_API_KEY');

const remoteApiKeyPlaceholder = computed(() => {
  if (remoteApiKey.value) return 'API Key (configured in extension)';
  if (envApiKeyDetected.value) return `Auto-detected: ${envKeySourceName.value}`;
  return 'API Key (or env: TYPESAFE_API_KEY)';
});

const jevModeLabel = computed(() => {
  if (jevMode.value === 'off') return 'Off';
  if (jevMode.value === 'local') return 'Local';
  return 'Remote';
});

const jevBadgeClass = computed(() => {
  return jevMode.value;
});

const headerPillState = computed(() => {
  if (isManaging.value) {
    return {
      text: 'Return',
      key: 'return',
      class: 'jev-header-action return',
      interactive: true,
      title: 'Return to mode switcher',
    };
  }
  if (jevMode.value === 'off') {
    return {
      text: 'Off',
      key: 'off',
      class: 'badge-jev off',
      interactive: false,
      title: '',
    };
  }
  if (showManageBtn.value && (jevMode.value === 'local' || jevMode.value === 'remote')) {
    return {
      text: 'Manage',
      key: 'manage',
      class: 'jev-header-action manage',
      interactive: true,
      title: 'Manage Jev model settings',
    };
  }
  return {
    text: jevModeLabel.value,
    key: `status-${jevMode.value}`,
    class: `badge-jev ${jevMode.value}`,
    interactive: false,
    title: '',
  };
});

const handleHeaderPillClick = () => {
  if (headerPillState.value.interactive) {
    toggleManaging();
  }
};

const openRelease = (url?: string) => {
  const target = url || latestReleaseUrl.value;
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    chrome.tabs.create({ url: target });
  } else if (typeof window !== 'undefined') {
    window.open(target, '_blank', 'noopener,noreferrer');
  }
};

const setCursorMode = async (mode: 'off' | 'auto' | 'always') => {
  transitionEnabled.value = true;
  isHydrated.value = true;
  if (cursorMode.value === mode) return;
  cursorMode.value = mode;
  try {
    await chrome.storage.local.set({ agentCursorMode: mode });
  } catch (e) {
    console.error('Failed to save cursor mode:', e);
  }
};

const setWindowMode = async (mode: 'tab' | 'window') => {
  transitionEnabled.value = true;
  isHydrated.value = true;
  if (windowMode.value === mode) return;
  windowMode.value = mode;
  try {
    await chrome.storage.local.set({ agentWindowMode: mode });
  } catch (e) {
    console.error('Failed to save window mode:', e);
  }
};

const checkJevModelStatus = async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch('http://127.0.0.1:12306/jev/model-status', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      modelDownloaded.value = Boolean(data.downloaded);
      if (Array.isArray(data.models) && data.models.length > 0) {
        localModels.value = data.models;
        const idx = data.activeModel ? data.models.indexOf(data.activeModel) : 0;
        activeModelIndex.value = idx >= 0 ? idx : 0;
      }
      try {
        await chrome.storage.local.set({
          jevModelDownloaded: modelDownloaded.value,
          jevLocalModels: localModels.value,
          jevActiveModel: localModels.value[activeModelIndex.value] || '',
        });
      } catch {}
    }
  } catch {
    // native server offline
  }
};

const pollDownloadProgress = () => {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch('http://127.0.0.1:12306/jev/download-progress', {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        downloadPercent.value = data.percent || 0;
        downloadSpeed.value = data.speed || '';

        if (data.status === 'completed' || data.percent >= 100) {
          clearInterval(progressTimer);
          progressTimer = null;
          isCompletedFlash.value = true;
          modelDownloaded.value = true;
          setTimeout(() => {
            isCompletedFlash.value = false;
            isDownloading.value = false;
            isExpanded.value = false;
            setJevMode('local');
          }, 400);
        } else if (data.status === 'error') {
          clearInterval(progressTimer);
          progressTimer = null;
          isDownloading.value = false;
          downloadError.value = data.error || 'Download failed';
        }
      }
    } catch {}
  }, 600);
};

const stopDownload = async () => {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  isDownloading.value = false;
  downloadSpeed.value = '';
  try {
    await fetch('http://127.0.0.1:12306/jev/download-cancel', { method: 'POST' });
  } catch {}
};

const stopCustomDownload = async () => {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  isCustomDownloading.value = false;
  downloadSpeed.value = '';
  try {
    await fetch('http://127.0.0.1:12306/jev/download-cancel', { method: 'POST' });
  } catch {}
};

const retryDownload = async () => {
  downloadError.value = '';
  await triggerDownload();
};

const retryCustomDownload = async () => {
  customDownloadError.value = '';
  await startCustomDownload();
};

const dismissDownloadError = () => {
  downloadError.value = '';
  isExpanded.value = false;
};

const dismissCustomError = () => {
  customDownloadError.value = '';
};

const checkOngoingDownload = async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch('http://127.0.0.1:12306/jev/download-progress', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'downloading') {
        isDownloading.value = true;
        downloadPercent.value = data.percent || 0;
        downloadSpeed.value = data.speed || '';
        pollDownloadProgress();
      }
    }
  } catch {}
};

const triggerManageBtnMorph = () => {
  if (manageBtnTimer) clearTimeout(manageBtnTimer);
  showManageBtn.value = false;
  if (jevMode.value === 'local' || jevMode.value === 'remote') {
    manageBtnTimer = setTimeout(() => {
      showManageBtn.value = true;
    }, 500);
  }
};

const toggleManaging = () => {
  isManaging.value = !isManaging.value;
  isDeleting.value = false;
  isDeleteWiping.value = false;
  if (isManaging.value) {
    isExpanded.value = false;
    if (jevMode.value === 'local') {
      fetchLocalModels();
    } else if (jevMode.value === 'remote') {
      fetchRemoteConfig();
    }
  }
};

const fetchLocalModels = async () => {
  try {
    const res = await fetch('http://127.0.0.1:12306/jev/models');
    if (res.ok) {
      const data = await res.json();
      localModels.value = Array.isArray(data.models) ? data.models : [];
      modelDownloaded.value = localModels.value.length > 0;
      if (localModels.value.length > 0) {
        const idx = data.activeModel ? localModels.value.indexOf(data.activeModel) : 0;
        activeModelIndex.value = idx >= 0 ? idx : 0;
      } else {
        activeModelIndex.value = 0;
      }
      try {
        await chrome.storage.local.set({
          jevLocalModels: localModels.value,
          jevActiveModel: localModels.value[activeModelIndex.value] || '',
          jevModelDownloaded: modelDownloaded.value,
        });
      } catch {}
    }
  } catch {}
};

const prevModel = async () => {
  if (activeModelIndex.value > 0) {
    activeModelIndex.value--;
    const name = localModels.value[activeModelIndex.value];
    try {
      await fetch('http://127.0.0.1:12306/jev/select-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      });
      await chrome.storage.local.set({ jevActiveModel: name });
    } catch {}
  }
};

const nextModel = async () => {
  if (activeModelIndex.value < localModels.value.length - 1) {
    activeModelIndex.value++;
    const name = localModels.value[activeModelIndex.value];
    try {
      await fetch('http://127.0.0.1:12306/jev/select-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      });
      await chrome.storage.local.set({ jevActiveModel: name });
    } catch {}
  }
};

const startDelete = () => {
  if (localModels.value.length === 0) return;
  isDeleting.value = true;
};

const confirmDelete = async () => {
  if (isDeleteWiping.value) return;
  isDeleteWiping.value = true;
  const targetModel = activeModelName.value;

  try {
    const res = await fetch('http://127.0.0.1:12306/jev/delete-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: targetModel }),
    });
    const data = await res.json().catch(() => ({}));

    setTimeout(() => {
      isDeleting.value = false;
      isDeleteWiping.value = false;
      deleteNotice.value = 'Deleted ✓';

      localModels.value = localModels.value.filter((m) => m !== targetModel);
      modelDownloaded.value = localModels.value.length > 0;
      if (localModels.value.length > 0) {
        const fallback = data.fallbackModel || localModels.value[0];
        const idx = localModels.value.indexOf(fallback);
        activeModelIndex.value = idx >= 0 ? idx : 0;
      } else {
        activeModelIndex.value = 0;
      }

      setTimeout(() => {
        deleteNotice.value = '';
      }, 1500);
    }, 280);
  } catch {
    isDeleting.value = false;
    isDeleteWiping.value = false;
  }
};

const startCustomDownload = async () => {
  const url = customModelUrl.value.trim();
  if (!url) return;

  customDownloadError.value = '';
  isCustomDownloading.value = true;
  isDownloadSuccess.value = false;
  downloadPercent.value = 1;
  downloadSpeed.value = 'Connecting...';

  try {
    const res = await fetch('http://127.0.0.1:12306/jev/download-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customUrl: url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Server error starting download');
    }

    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(async () => {
      try {
        const pRes = await fetch('http://127.0.0.1:12306/jev/download-progress');
        if (pRes.ok) {
          const data = await pRes.json();
          downloadPercent.value = data.percent || 0;
          downloadSpeed.value = data.speed || '';

          if (data.status === 'completed' || data.percent >= 100) {
            clearInterval(progressTimer);
            progressTimer = null;
            isDownloadSuccess.value = true;
          } else if (data.status === 'error') {
            clearInterval(progressTimer);
            progressTimer = null;
            isCustomDownloading.value = false;
            customDownloadError.value = data.error || 'Download failed';
          }
        }
      } catch {}
    }, 500);
  } catch (e: any) {
    console.error('Failed to start custom download:', e);
    isCustomDownloading.value = false;
    customDownloadError.value = e?.message || 'Failed to start download';
  }
};

const applyDownloadedModel = async () => {
  let modelName = 'decider-2b';
  const url = customModelUrl.value.trim();
  if (url) {
    const raw = url
      .replace(/^https?:\/\/huggingface\.co\//, '')
      .replace(/^https?:\/\/hf-mirror\.com\//, '')
      .replace(/\/+$/, '');
    const parts = raw.split('/');
    modelName = parts[parts.length - 1] || raw;
  }

  if (!localModels.value.includes(modelName)) {
    localModels.value.push(modelName);
  }
  activeModelIndex.value = localModels.value.indexOf(modelName);

  try {
    await fetch('http://127.0.0.1:12306/jev/select-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
    });
    await chrome.storage.local.set({ jevActiveModel: modelName });
  } catch {}

  isCustomDownloading.value = false;
  isDownloadSuccess.value = false;
  customModelUrl.value = '';
};

const fetchRemoteConfig = async () => {
  try {
    const stored = await chrome.storage.local.get('jevRemoteConfig');
    if (stored?.jevRemoteConfig) {
      remoteBaseUrl.value = stored.jevRemoteConfig.baseUrl || '';
      remoteApiKey.value = stored.jevRemoteConfig.apiKey || '';
      const rawModel = (stored.jevRemoteConfig.modelId || '').trim();
      // If stored model was erroneously set to a local model name (e.g. decider-2b)
      if (
        rawModel === 'decider-2b' ||
        rawModel.startsWith('decider-') ||
        rawModel === 'jev-latest'
      ) {
        remoteModelId.value = '';
        if (rawModel !== 'jev-latest') {
          await chrome.storage.local.set({
            jevRemoteConfig: {
              ...stored.jevRemoteConfig,
              modelId: 'jev-latest',
            },
          });
        }
      } else {
        remoteModelId.value = rawModel;
      }
    }
    const res = await fetch('http://127.0.0.1:12306/jev/remote-config');
    if (res.ok) {
      const cfg = await res.json();
      envApiKeyDetected.value = Boolean(cfg.hasEnvApiKey);
      if (cfg.envKeySource) {
        envKeySourceName.value = cfg.envKeySource;
      }
      if (!stored?.jevRemoteConfig) {
        remoteBaseUrl.value = cfg.baseUrl || '';
        remoteApiKey.value = cfg.apiKey || '';
        const rawModel = (cfg.modelId || '').trim();
        if (
          rawModel === 'decider-2b' ||
          rawModel.startsWith('decider-') ||
          rawModel === 'jev-latest'
        ) {
          remoteModelId.value = '';
        } else {
          remoteModelId.value = rawModel;
        }
      }
    }
  } catch {}
};

const applyRemoteConfig = async () => {
  const rawModel = remoteModelId.value.trim();
  const effectiveModel =
    !rawModel || rawModel === 'decider-2b' || rawModel.startsWith('decider-')
      ? 'jev-latest'
      : rawModel;

  const cfg = {
    baseUrl: remoteBaseUrl.value.trim(),
    apiKey: remoteApiKey.value.trim(),
    modelId: effectiveModel,
  };

  try {
    await chrome.storage.local.set({ jevRemoteConfig: cfg });
    await fetch('http://127.0.0.1:12306/jev/remote-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    isRemoteApplied.value = true;
    setTimeout(() => {
      isRemoteApplied.value = false;
    }, 1500);
  } catch (e) {
    console.error('Failed to apply remote config:', e);
  }
};

const setJevMode = async (mode: 'off' | 'local' | 'remote') => {
  if (isCollapsing.value) return;
  transitionEnabled.value = true;
  isHydrated.value = true;
  if (mode === jevMode.value && !isExpanded.value) {
    if (mode === 'local' && !modelDownloaded.value && !isDownloading.value) {
      isExpanded.value = true;
    }
    return;
  }

  const prevMode = jevMode.value;
  jevMode.value = mode;

  if (mode === 'local') {
    if (!modelDownloaded.value || localModels.value.length === 0) {
      await checkJevModelStatus();
      await fetchLocalModels();
    }
    if (!modelDownloaded.value && !isDownloading.value) {
      isExpanded.value = true;
    } else {
      isExpanded.value = false;
    }
  } else {
    isExpanded.value = false;
    isCollapsing.value = false;
  }

  if (mode === 'off') {
    showManageBtn.value = false;
    isManaging.value = false;
  } else {
    if (mode !== prevMode) {
      triggerManageBtnMorph();
    }
  }

  try {
    await chrome.storage.local.set({ jevEngineMode: mode });
  } catch (e) {
    console.error('Failed to save jev mode:', e);
  }

  fetch('http://127.0.0.1:12306/jev/set-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  }).catch(() => {});
};

const cancelExpand = () => {
  if (isCollapsing.value) return;
  isCollapsing.value = true;
  setTimeout(() => {
    isExpanded.value = false;
    isCollapsing.value = false;
  }, 260);
};

const triggerDownload = async () => {
  downloadError.value = '';
  isDownloading.value = true;
  isExpanded.value = false;
  isCollapsing.value = false;
  downloadPercent.value = 1;
  downloadSpeed.value = 'Connecting...';

  try {
    const res = await fetch('http://127.0.0.1:12306/jev/download-start', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Server error starting download');
    }
    pollDownloadProgress();
  } catch (e: any) {
    console.error('Failed to trigger download:', e);
    isDownloading.value = false;
    downloadError.value = e?.message || 'Failed to start download';
  }
};

const checkServerStatus = async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch('http://127.0.0.1:12306/ping', { signal: controller.signal });
    clearTimeout(timeout);
    serverConnected.value = res.ok;
  } catch {
    serverConnected.value = false;
  }
};

const toggleAgent = async () => {
  agentEnabled.value = !agentEnabled.value;
  try {
    await chrome.storage.session.set({ agentControlEnabled: agentEnabled.value });
  } catch (e) {
    console.error('Failed to save agent control state:', e);
  }
};

onMounted(async () => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('enable') === '1') {
    try {
      await chrome.storage.session.set({ agentControlEnabled: true });
    } catch {}
  }
  if (urlParams.get('reload') === '1') {
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch {}
    }, 100);
  }

  try {
    const storagePromise = Promise.all([
      typeof chrome !== 'undefined' && chrome.storage?.session
        ? chrome.storage.session.get('agentControlEnabled')
        : Promise.resolve({}),
      typeof chrome !== 'undefined' && chrome.storage?.local
        ? chrome.storage.local.get('agentCursorMode')
        : Promise.resolve({}),
      typeof chrome !== 'undefined' && chrome.storage?.local
        ? chrome.storage.local.get('agentWindowMode')
        : Promise.resolve({}),
      typeof chrome !== 'undefined' && chrome.storage?.local
        ? chrome.storage.local.get([
            'jevEngineMode',
            'jevModelDownloaded',
            'jevLocalModels',
            'jevActiveModel',
          ])
        : Promise.resolve({}),
    ]);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 300),
    );
    const [session, localCursor, localWin, localJev] = (await Promise.race([
      storagePromise,
      timeoutPromise,
    ])) as any;

    agentEnabled.value = session?.agentControlEnabled !== false;

    if (localCursor?.agentCursorMode) {
      cursorMode.value = localCursor.agentCursorMode;
    } else {
      cursorMode.value = 'always';
      try {
        await chrome.storage.local.set({ agentCursorMode: 'always' });
      } catch {}
    }

    if (localWin?.agentWindowMode) {
      windowMode.value = localWin.agentWindowMode;
    } else {
      windowMode.value = 'tab';
    }

    if (localJev?.jevModelDownloaded !== undefined) {
      modelDownloaded.value = Boolean(localJev.jevModelDownloaded);
    }
    if (
      localJev?.jevLocalModels &&
      Array.isArray(localJev.jevLocalModels) &&
      localJev.jevLocalModels.length > 0
    ) {
      localModels.value = localJev.jevLocalModels;
      modelDownloaded.value = true;
      if (localJev.jevActiveModel) {
        const idx = localModels.value.indexOf(localJev.jevActiveModel);
        activeModelIndex.value = idx >= 0 ? idx : 0;
      }
    }

    if (localJev?.jevEngineMode) {
      jevMode.value = localJev.jevEngineMode;
    } else if (modelDownloaded.value) {
      jevMode.value = 'local';
      try {
        await chrome.storage.local.set({ jevEngineMode: 'local' });
      } catch {}
    } else {
      jevMode.value = 'remote';
      try {
        await chrome.storage.local.set({ jevEngineMode: 'remote' });
      } catch {}
    }

    if (jevMode.value === 'local' || jevMode.value === 'remote') {
      showManageBtn.value = true;
    } else {
      showManageBtn.value = false;
    }
    await fetchLocalModels();
    await fetchRemoteConfig();
  } catch {
    // Keep defaults
  }

  setTimeout(() => {
    isHydrated.value = true;
    transitionEnabled.value = true;
  }, 50);

  await checkServerStatus();

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const manifest = chrome.runtime.getManifest();
      if (manifest?.version) {
        currentVersion.value = manifest.version;
      }
    }
  } catch {}

  checkExtensionVersionUpdate()
    .then((res) => {
      versionChecked.value = true;
      hasUpdate.value = res.hasUpdate;
      if (res.releaseUrl) {
        latestReleaseUrl.value = res.releaseUrl;
      }
    })
    .catch(() => {
      versionChecked.value = true;
      hasUpdate.value = false;
    });

  await checkJevModelStatus();
  await checkOngoingDownload();

  fetch('http://127.0.0.1:12306/jev/set-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: jevMode.value }),
  }).catch(() => {});
});

onUnmounted(() => {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
});
</script>

<template>
  <div class="popup-box" :class="{ 'no-transition': !isHydrated }">
    <!-- Row 1: Agent Control Switch -->
    <div class="row">
      <span class="label">{{ agentEnabled ? 'MCP on' : 'MCP off' }}</span>
      <button
        class="switch"
        :class="{ active: agentEnabled }"
        type="button"
        role="switch"
        :aria-checked="agentEnabled"
        @click="toggleAgent"
      >
        <span class="slider"></span>
      </button>
    </div>

    <!-- Row 2: Service Status Indicator -->
    <div class="row">
      <span class="label">{{ isMcpConnected ? 'Connected' : 'Disconnected' }}</span>
      <div class="status">
        <span class="dot" :class="{ online: isMcpConnected }"></span>
      </div>
    </div>

    <!-- Row 3: Agent Cursor Mode 3-Step Slider -->
    <div class="cursor-row">
      <div class="cursor-header">
        <div class="label-with-tooltip">
          <span class="label">Agent Cursor</span>
          <img
            class="cursor-hint-icon"
            :src="cursorIconUrl"
            alt="Virtual Mouse Cursor"
            title="Agent Cursor: Virtual mouse pointer for visual browser automation"
          />
        </div>
      </div>
      <div class="segmented-control">
        <div class="segment-indicator" :class="cursorMode"></div>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: cursorMode === 'off' }"
          @click="setCursorMode('off')"
        >
          Off
        </button>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: cursorMode === 'auto' }"
          @click="setCursorMode('auto')"
        >
          Auto
        </button>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: cursorMode === 'always' }"
          @click="setCursorMode('always')"
        >
          Always
        </button>
      </div>
    </div>

    <!-- Row 4: Window Mode (Tab vs Window) -->
    <div class="cursor-row">
      <div class="cursor-header">
        <div class="label-with-tooltip">
          <span class="label">Window Mode</span>
          <span
            class="info-icon"
            title="Tab: Works quietly in color-grouped tabs in your current window.&#10;Window: Opens a separate dedicated OS window for agent tasks."
            >i</span
          >
        </div>
      </div>
      <div class="segmented-control two-step">
        <div class="segment-indicator-two" :class="windowMode"></div>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: windowMode === 'tab' }"
          @click="setWindowMode('tab')"
        >
          Tab
        </button>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: windowMode === 'window' }"
          @click="setWindowMode('window')"
        >
          Window
        </button>
      </div>
    </div>

    <!-- Row: Jev Engine -->
    <div class="cursor-row">
      <div class="cursor-header">
        <div class="label-with-tooltip">
          <span class="label">Jev Engine</span>
          <span class="info-icon" title="Fast System 1 local/remote semantic decision loop">i</span>
        </div>
        <div class="jev-header-right">
          <button
            type="button"
            class="jev-header-pill"
            :class="headerPillState.class"
            :disabled="!headerPillState.interactive"
            @click="handleHeaderPillClick"
            :title="headerPillState.title"
          >
            <Transition v-if="transitionEnabled" name="pill-text" mode="out-in">
              <span :key="headerPillState.key" class="jev-pill-text">
                {{ headerPillState.text }}
              </span>
            </Transition>
            <span v-else class="jev-pill-text">
              {{ headerPillState.text }}
            </span>
          </button>
        </div>
      </div>

      <!-- State: Sub-panel when isManaging is true -->
      <div v-if="isManaging" class="jev-subpanel">
        <!-- Local Sub-panel (2 Inset Rows) -->
        <div v-if="jevMode === 'local'" class="jev-local-panel">
          <!-- Row 1: Model Switcher & Delete Action -->
          <div class="jev-model-card">
            <!-- Empty state if no models are installed -->
            <div v-if="localModels.length === 0" class="jev-no-models">
              No local model installed
            </div>

            <!-- Normal State: Prev, Model Name, Next, Delete button -->
            <div v-else-if="!isDeleting" class="jev-model-row">
              <button
                type="button"
                class="jev-nav-btn"
                :disabled="activeModelIndex <= 0"
                @click="prevModel"
                title="Previous model"
              >
                «
              </button>
              <div class="jev-active-model-name" :title="activeModelName">
                {{ activeModelName }}
              </div>
              <button
                type="button"
                class="jev-nav-btn"
                :disabled="activeModelIndex >= localModels.length - 1"
                @click="nextModel"
                title="Next model"
              >
                »
              </button>
              <button
                type="button"
                class="jev-delete-btn"
                @click="startDelete"
                title="Delete this model"
              >
                🗑
              </button>
            </div>

            <!-- Delete Confirmation State: Expands right-to-left into red bar -->
            <div
              v-else
              class="delete-confirm-bar"
              :class="{ 'wipe-exit': isDeleteWiping }"
              @click="confirmDelete"
            >
              <span class="delete-confirm-text">
                {{ isDeleteWiping ? 'Deleting...' : deleteNotice || 'Confirm Delete?' }}
              </span>
            </div>
          </div>

          <!-- Row 2: Custom Download Input & Streaming Progress -->
          <div class="jev-download-card">
            <!-- Progress Bar State (During download / Completed) -->
            <div v-if="isCustomDownloading" class="jev-progress-bar">
              <div class="jev-progress-fill" :style="{ width: `${downloadPercent}%` }"></div>
              <div v-if="!isDownloadSuccess" class="jev-progress-inner">
                <span class="jev-progress-text jev-halo-glow">
                  Downloading... {{ downloadPercent }}%
                  <span v-if="downloadSpeed" class="jev-speed-badge">({{ downloadSpeed }})</span>
                </span>
                <button
                  type="button"
                  class="jev-stop-btn"
                  title="Stop download"
                  @click.stop="stopCustomDownload"
                >
                  ■
                </button>
              </div>
              <button
                v-else
                type="button"
                class="jev-apply-downloaded-btn"
                @click="applyDownloadedModel"
              >
                ✓ Ready - Apply
              </button>
            </div>

            <!-- Error State for custom download -->
            <div v-else-if="customDownloadError" class="jev-error-bar">
              <span class="jev-error-text" :title="customDownloadError"
                >⚠️ {{ customDownloadError }}</span
              >
              <div class="jev-error-actions">
                <button type="button" class="jev-error-btn retry" @click="retryCustomDownload"
                  >Retry</button
                >
                <button type="button" class="jev-error-btn dismiss" @click="dismissCustomError"
                  >✕</button
                >
              </div>
            </div>

            <!-- Normal input state -->
            <div v-else class="jev-custom-input-row">
              <input
                type="text"
                v-model="customModelUrl"
                placeholder="url link"
                class="jev-custom-input"
                @keyup.enter="startCustomDownload"
              />
              <button type="button" class="jev-custom-download-btn" @click="startCustomDownload">
                Download
              </button>
            </div>
          </div>
        </div>

        <!-- Remote Sub-panel (3 Rows) -->
        <div v-else-if="jevMode === 'remote'" class="jev-remote-panel">
          <div class="remote-input-group">
            <input
              type="text"
              v-model="remoteBaseUrl"
              placeholder="Default: https://api.typesafe.ai/v1"
              class="remote-input"
            />
          </div>
          <div
            class="remote-input-group"
            :title="
              envApiKeyDetected
                ? `Auto-detected API key from environment (${envKeySourceName})`
                : 'Configurable here or via TYPESAFE_API_KEY environment variable'
            "
          >
            <input
              type="password"
              v-model="remoteApiKey"
              :placeholder="remoteApiKeyPlaceholder"
              class="remote-input"
            />
            <span
              v-if="envApiKeyDetected && !remoteApiKey"
              class="env-key-badge"
              title="Auto-detected in environment"
            >
              ENV ✓
            </span>
          </div>
          <div class="remote-input-group remote-apply-row">
            <input
              type="text"
              v-model="remoteModelId"
              placeholder="Default: jev-latest"
              class="remote-input"
            />
            <button
              type="button"
              class="remote-apply-btn"
              :class="{ applied: isRemoteApplied }"
              @click="applyRemoteConfig"
            >
              <Transition name="apply-fade" mode="out-in">
                <span v-if="isRemoteApplied" key="applied">Applied ✓</span>
                <span v-else key="apply">Apply</span>
              </Transition>
            </button>
          </div>
        </div>
      </div>

      <!-- Fluid Morphing Container (Fixed 28px height, 100% width) for normal mode -->
      <div v-else class="jev-morph-container">
        <!-- State C: Realtime Progress Bar -->
        <div v-if="isDownloading" class="jev-progress-bar">
          <div class="jev-progress-fill" :style="{ width: `${downloadPercent}%` }"></div>
          <div class="jev-progress-inner">
            <span class="jev-progress-text">
              {{ isCompletedFlash ? 'Completed!' : `Downloading... ${downloadPercent}%` }}
              <span v-if="downloadSpeed && !isCompletedFlash" class="jev-speed-badge"
                >({{ downloadSpeed }})</span
              >
            </span>
            <button
              v-if="!isCompletedFlash"
              type="button"
              class="jev-stop-btn"
              title="Stop download"
              @click.stop="stopDownload"
            >
              ■
            </button>
          </div>
        </div>

        <!-- State Error: Download Error inside bar -->
        <div v-else-if="downloadError" class="jev-error-bar">
          <span class="jev-error-text" :title="downloadError">⚠️ {{ downloadError }}</span>
          <div class="jev-error-actions">
            <button type="button" class="jev-error-btn retry" @click="retryDownload">Retry</button>
            <button type="button" class="jev-error-btn dismiss" @click="dismissDownloadError"
              >✕</button
            >
          </div>
        </div>

        <!-- Normal State: 3-Step Segmented Control & Morphing Overlay -->
        <template v-else>
          <div class="segmented-control three-step">
            <div class="segment-indicator-three" :class="jevMode"></div>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: jevMode === 'off' }"
              @click="setJevMode('off')"
            >
              Off
            </button>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: jevMode === 'local' }"
              @click="setJevMode('local')"
            >
              Local
            </button>
            <button
              type="button"
              class="segment-btn"
              :class="{ active: jevMode === 'remote' }"
              @click="setJevMode('remote')"
            >
              Remote
            </button>
          </div>

          <!-- State B: Expanded Confirm Action Bar (Overlays & Morphs from/to Local button) -->
          <div
            v-if="isExpanded || isCollapsing"
            class="jev-expand-bar"
            :class="{ 'is-collapsing': isCollapsing }"
          >
            <button type="button" class="jev-download-btn" @click="triggerDownload">
              <span class="jev-btn-icon">☁️</span>
              <span class="jev-btn-text">Download Model (3.8GB)</span>
            </button>
            <button type="button" class="jev-cancel-btn" title="Cancel" @click="cancelExpand">
              ✕
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- Row: Version & Update Status (Bottom Row) -->
    <div class="version-row">
      <span class="version-text">v{{ currentVersion }}</span>
      <span v-if="versionChecked && !hasUpdate" class="status-latest">latest</span>
      <div v-if="versionChecked && hasUpdate" class="update-info">
        <span class="update-text">new version</span>
        <a
          class="view-link"
          :href="latestReleaseUrl"
          target="_blank"
          rel="noopener noreferrer"
          @click.prevent="openRelease(latestReleaseUrl)"
          >view</a
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.popup-box {
  width: 220px;
  padding: 14px 16px;
  box-sizing: border-box;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  user-select: none;
}

.popup-box.no-transition,
.popup-box.no-transition * {
  transition: none !important;
  animation: none !important;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
}

.label {
  font-size: 13px;
  font-weight: 500;
  color: #1f2937;
}

.switch {
  position: relative;
  width: 36px;
  height: 20px;
  background: #e5e7eb;
  border-radius: 9999px;
  border: none;
  cursor: pointer;
  padding: 2px;
  transition: background-color 0.2s ease;
  outline: none;
}

.switch.active {
  background: #10b981;
}

.slider {
  display: block;
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s ease;
  transform: translateX(0);
}

.switch.active .slider {
  transform: translateX(16px);
}

.status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
  transition: background-color 0.2s ease;
}

.dot.online {
  background: #10b981;
  box-shadow: 0 0 4px rgba(16, 185, 129, 0.6);
}

.status-text {
  font-size: 12px;
  color: #4b5563;
}

.cursor-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid #f3f4f6;
}

.cursor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
  box-sizing: border-box;
}

.segmented-control {
  position: relative;
  display: flex;
  width: 100%;
  height: 28px;
  box-sizing: border-box;
  background: #f3f4f6;
  border-radius: 8px;
  padding: 2px;
}

.segment-indicator {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc((100% - 4px) / 3);
  background: #ffffff;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  transition: transform 0.28s cubic-bezier(0.34, 1.08, 0.64, 1);
}

.segment-indicator.off {
  transform: translateX(0%);
}

.segment-indicator.auto {
  transform: translateX(100%);
}

.segment-indicator.always {
  transform: translateX(200%);
}

.label-with-tooltip {
  display: flex;
  align-items: center;
  gap: 5px;
}

.info-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #e5e7eb;
  color: #4b5563;
  font-size: 10px;
  font-weight: 700;
  font-style: italic;
  cursor: help;
  user-select: none;
  line-height: 1;
}

.info-icon:hover {
  background: #3b82f6;
  color: #ffffff;
}

.cursor-hint-icon {
  width: 14px;
  height: 14px;
  object-fit: contain;
  display: inline-block;
  cursor: help;
  user-select: none;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.12));
  transition: transform 0.2s cubic-bezier(0.34, 1.08, 0.64, 1);
}

.cursor-hint-icon:hover {
  transform: scale(1.18);
}

.segmented-control.two-step .segment-indicator-two {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc((100% - 4px) / 2);
  background: #ffffff;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  transition: transform 0.28s cubic-bezier(0.34, 1.08, 0.64, 1);
}

.segment-indicator-two.tab {
  transform: translateX(0%);
}

.segment-indicator-two.window {
  transform: translateX(100%);
}

.segment-btn {
  position: relative;
  z-index: 1;
  flex: 1;
  height: 24px;
  background: transparent;
  border: none;
  outline: none;
  font-size: 11px;
  font-weight: 500;
  color: #6b7280;
  cursor: pointer;
  transition: color 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.segment-btn.active {
  color: #111827;
  font-weight: 600;
}

.version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  border-top: 1px solid #f3f4f6;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}

.version-text {
  font-size: 11px;
  color: #9ca3af;
  font-weight: 400;
  user-select: text;
}

.status-latest {
  font-size: 11px;
  color: #9ca3af;
  font-weight: 400;
}

.update-info {
  display: flex;
  align-items: center;
  gap: 5px;
}

.update-text {
  font-size: 11px;
  color: #ea580c;
  font-weight: 500;
}

.view-link {
  font-size: 11px;
  color: #2563eb;
  text-decoration: underline;
  cursor: pointer;
  font-weight: 500;
}

.view-link:hover {
  color: #1d4ed8;
}

/* Jev Engine Badges */
.badge-jev.off {
  color: #6b7280;
  background: #f3f4f6;
}
.badge-jev.local {
  color: #374151;
  background: #e5e7eb;
}
.badge-jev.remote {
  color: #374151;
  background: #e5e7eb;
}

/* Jev Morph Container */
.jev-morph-container {
  position: relative;
  width: 100%;
  height: 28px;
  border-radius: 8px;
  overflow: hidden;
  box-sizing: border-box;
}

/* Sliding Indicator for 3-step control */
.segmented-control.three-step {
  height: 28px;
  padding: 2px;
  box-sizing: border-box;
}

.segment-indicator-three {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc((100% - 4px) / 3);
  background: #ffffff;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  transition: transform 0.28s cubic-bezier(0.34, 1.08, 0.64, 1);
}

.segment-indicator-three.off {
  transform: translateX(0%);
}

.segment-indicator-three.local {
  transform: translateX(100%);
}

.segment-indicator-three.remote {
  transform: translateX(200%);
}

.jev-morph-container {
  position: relative;
  width: 100%;
  height: 28px;
}

/* State B: Expanded Confirm Action Bar (Overlays & Morphs from/to Local button) */
.jev-expand-bar {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 28px;
  display: flex;
  align-items: center;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 8px;
  padding: 0 4px;
  box-sizing: border-box;
  z-index: 5;
  overflow: hidden;
  animation: jevExpandBarOpen 0.28s cubic-bezier(0.34, 1.08, 0.64, 1) forwards;
}

.jev-expand-bar.is-collapsing {
  animation: jevExpandBarClose 0.26s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  pointer-events: none;
}

@keyframes jevExpandBarOpen {
  0% {
    left: calc((100% - 4px) / 3 + 2px);
    width: calc((100% - 4px) / 3);
    top: 2px;
    height: 24px;
    opacity: 0.5;
    border-radius: 6px;
  }
  100% {
    left: 0;
    width: 100%;
    top: 0;
    height: 28px;
    opacity: 1;
    border-radius: 8px;
  }
}

@keyframes jevExpandBarClose {
  0% {
    left: 0;
    width: 100%;
    top: 0;
    height: 28px;
    opacity: 1;
    border-radius: 8px;
  }
  100% {
    left: calc((100% - 4px) / 3 + 2px);
    width: calc((100% - 4px) / 3);
    top: 2px;
    height: 24px;
    opacity: 0;
    border-radius: 6px;
  }
}

.jev-download-btn {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: transparent;
  border: none;
  cursor: pointer;
  outline: none;
  font-size: 11px;
  font-weight: 600;
  color: #15803d;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 2px;
  animation: jevExpandContentFadeIn 0.22s ease 0.06s both;
}

.jev-download-btn:hover {
  color: #166534;
}

.jev-btn-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.jev-btn-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jev-cancel-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: #9ca3af;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    color 0.15s ease,
    background 0.15s ease;
  animation: jevExpandContentFadeIn 0.22s ease 0.06s both;
}

.jev-cancel-btn:hover {
  color: #374151;
  background: #e5e7eb;
}

.jev-expand-bar.is-collapsing .jev-download-btn,
.jev-expand-bar.is-collapsing .jev-cancel-btn {
  animation: jevExpandContentFadeOut 0.12s ease both;
}

@keyframes jevExpandContentFadeIn {
  0% {
    opacity: 0;
    transform: scale(0.95);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes jevExpandContentFadeOut {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(0.92);
  }
}

@keyframes jevFluidEntrance {
  0% {
    opacity: 0;
    transform: scale(0.97);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

/* State C: Realtime Progress Bar */
.jev-progress-bar {
  position: relative;
  width: 100%;
  height: 28px;
  background: #f3f4f6;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: jevFluidEntrance 0.28s cubic-bezier(0.34, 1.08, 0.64, 1) forwards;
}

.jev-progress-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: linear-gradient(90deg, #10b981 0%, #059669 100%);
  border-radius: 8px;
  transition: width 0.28s cubic-bezier(0.34, 1.08, 0.64, 1);
}

.jev-progress-inner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 100%;
  padding: 0 6px 0 10px;
  box-sizing: border-box;
}

.jev-progress-text {
  position: relative;
  z-index: 1;
  font-size: 11px;
  font-weight: 600;
  color: #111827;
  text-shadow: 0 0 2px rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jev-speed-badge {
  font-size: 9px;
  font-weight: 500;
  opacity: 0.8;
  margin-left: 4px;
}

.jev-stop-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.08);
  border: none;
  color: #374151;
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  transition: all 0.2s cubic-bezier(0.34, 1.08, 0.64, 1);
  outline: none;
  flex-shrink: 0;
}

.jev-stop-btn:hover {
  background: rgba(239, 68, 68, 0.16);
  color: #dc2626;
  transform: scale(1.08);
}

.jev-stop-btn:active {
  transform: scale(0.92);
}

/* Error Bar inside progress container */
.jev-error-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 28px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 0 6px 0 8px;
  box-sizing: border-box;
  animation: jevFluidEntrance 0.28s cubic-bezier(0.34, 1.08, 0.64, 1) forwards;
}

.jev-error-text {
  flex: 1;
  font-size: 10px;
  font-weight: 500;
  color: #dc2626;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 4px;
}

.jev-error-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.jev-error-btn {
  height: 20px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 4px;
  cursor: pointer;
  border: none;
  transition: all 0.15s ease;
  line-height: 20px;
}

.jev-error-btn.retry {
  background: #dc2626;
  color: #ffffff;
}

.jev-error-btn.retry:hover {
  background: #b91c1c;
}

.jev-error-btn.dismiss {
  width: 20px;
  padding: 0;
  background: transparent;
  color: #9ca3af;
  display: flex;
  align-items: center;
  justify-content: center;
}

.jev-error-btn.dismiss:hover {
  background: #fee2e2;
  color: #dc2626;
}

/* Header Action / Manage / Return Buttons & Badges (Single Persistent Pill) */
.jev-header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.jev-header-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 22px;
  box-sizing: border-box;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  line-height: 1;
  user-select: none;
  padding: 0;
  border: none;
  outline: none;
  cursor: default;
  transition:
    background-color 0.22s cubic-bezier(0.34, 1.08, 0.64, 1),
    color 0.22s cubic-bezier(0.34, 1.08, 0.64, 1);
}

.jev-header-pill.jev-header-action {
  cursor: pointer;
}

.jev-header-pill.badge-jev.off {
  color: #6b7280;
  background: #f3f4f6;
  cursor: default;
}

.jev-header-pill.badge-jev.local {
  color: #374151;
  background: #e5e7eb;
  cursor: default;
}

.jev-header-pill.badge-jev.remote {
  color: #374151;
  background: #e5e7eb;
  cursor: default;
}

.jev-header-pill.jev-header-action.manage {
  background: #dbeafe;
  color: #1d4ed8;
}

.jev-header-pill.jev-header-action.manage:hover {
  background: #bfdbfe;
  color: #1e40af;
}

.jev-header-pill.jev-header-action.return {
  background: #dbeafe;
  color: #1d4ed8;
  font-weight: 600;
}

.jev-header-pill.jev-header-action.return:hover {
  background: #bfdbfe;
  color: #1e40af;
}

.jev-pill-text {
  display: inline-block;
  white-space: nowrap;
}

/* Text-only transition: fast exit (80ms), smooth non-linear entrance (180ms) */
.pill-text-leave-active {
  transition:
    opacity 0.08s ease-in,
    filter 0.08s ease-in,
    transform 0.08s ease-in;
}

.pill-text-leave-to {
  opacity: 0;
  filter: blur(3px);
  transform: scale(0.92);
}

.pill-text-enter-active {
  transition:
    opacity 0.18s cubic-bezier(0.34, 1.08, 0.64, 1),
    filter 0.18s cubic-bezier(0.34, 1.08, 0.64, 1),
    transform 0.18s cubic-bezier(0.34, 1.08, 0.64, 1);
}

.pill-text-enter-from {
  opacity: 0;
  filter: blur(4px);
  transform: scale(0.9);
}

/* Jev Sub-Panel Container */
.jev-subpanel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  animation: jevAccordionDown 0.28s cubic-bezier(0.34, 1.08, 0.64, 1) forwards;
}

@keyframes jevAccordionDown {
  0% {
    opacity: 0;
    transform: translateY(-6px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Local Panel (2 Rows) */
.jev-local-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

/* Row 1: Model Card */
.jev-model-card {
  position: relative;
  width: 100%;
  height: 28px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
  box-sizing: border-box;
  display: flex;
  align-items: center;
}

.jev-no-models {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 11px;
  font-weight: 500;
  color: #9ca3af;
  user-select: none;
}

.jev-model-row {
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
  padding: 0 4px;
  box-sizing: border-box;
  gap: 4px;
  transition: opacity 0.2s ease;
}

.jev-nav-btn {
  width: 18px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: #9ca3af;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
  outline: none;
  padding: 0;
}

.jev-nav-btn:hover:not(:disabled) {
  color: #374151;
  background: #e5e7eb;
}

.jev-nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.jev-active-model-name {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  color: #1f2937;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 2px;
}

.jev-delete-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: #9ca3af;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.34, 1.08, 0.64, 1);
  outline: none;
  padding: 0;
}

.jev-delete-btn:hover {
  background: #fee2e2;
  color: #ef4444;
}

/* Delete Confirmation Bar (Expands Right to Left) */
.delete-confirm-bar {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  background: #ef4444;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  animation: deleteExpandRightToLeft 0.28s cubic-bezier(0.34, 1.08, 0.64, 1) forwards;
  transform-origin: right center;
  user-select: none;
  box-sizing: border-box;
}

@keyframes deleteExpandRightToLeft {
  0% {
    transform: scaleX(0);
    opacity: 0;
    filter: blur(2px);
  }
  100% {
    transform: scaleX(1);
    opacity: 1;
    filter: blur(0);
  }
}

/* Wipe exit left to right */
.delete-confirm-bar.wipe-exit {
  animation: deleteWipeLeftToRight 0.28s cubic-bezier(0.34, 1.08, 0.64, 1) forwards;
  transform-origin: right center;
}

@keyframes deleteWipeLeftToRight {
  0% {
    clip-path: inset(0 0 0 0);
    opacity: 1;
  }
  100% {
    clip-path: inset(0 0 0 100%);
    opacity: 0;
  }
}

/* Row 2: Custom Download Card */
.jev-download-card {
  position: relative;
  width: 100%;
  height: 28px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
  box-sizing: border-box;
}

.jev-custom-input-row {
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
  padding: 0 2px 0 6px;
  box-sizing: border-box;
  gap: 4px;
}

.jev-custom-input {
  flex: 1;
  height: 22px;
  border: none;
  background: transparent;
  outline: none;
  font-size: 11px;
  color: #1f2937;
  min-width: 0;
}

.jev-custom-input::placeholder {
  color: #9ca3af;
  font-size: 10px;
}

.jev-custom-download-btn {
  height: 22px;
  padding: 0 8px;
  background: #374151;
  color: #ffffff;
  border: none;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.34, 1.08, 0.64, 1);
  white-space: nowrap;
}

.jev-custom-download-btn:hover {
  background: #1f2937;
}

/* Text Halo Glow Animation */
.jev-halo-glow {
  animation: jevTextHaloGlow 2s ease-in-out infinite;
}

@keyframes jevTextHaloGlow {
  0%,
  100% {
    text-shadow: 0 0 2px rgba(16, 185, 129, 0.3);
    opacity: 0.9;
  }
  50% {
    text-shadow:
      0 0 8px rgba(16, 185, 129, 0.7),
      0 0 12px rgba(16, 185, 129, 0.35);
    opacity: 1;
  }
}

.jev-apply-downloaded-btn {
  position: relative;
  z-index: 2;
  width: 100%;
  height: 100%;
  background: #059669;
  color: #ffffff;
  border: none;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
}

.jev-apply-downloaded-btn:hover {
  background: #047857;
}

/* Remote Sub-panel (3 Rows) */
.jev-remote-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.remote-input-group {
  width: 100%;
  height: 28px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 0 6px;
}

.remote-input {
  width: 100%;
  height: 22px;
  border: none;
  background: transparent;
  outline: none;
  font-size: 11px;
  color: #1f2937;
}

.remote-input::placeholder {
  color: #9ca3af;
  font-size: 10px;
}

.env-key-badge {
  font-size: 9px;
  font-weight: 700;
  color: #059669;
  background: #ecfdf5;
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
  user-select: none;
  line-height: 1.2;
}

.remote-apply-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 2px;
}

.remote-apply-btn {
  width: 48px;
  height: 22px;
  box-sizing: border-box;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(37, 99, 235, 0.85);
  color: #ffffff;
  border: none;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition:
    width 0.28s cubic-bezier(0.34, 1.08, 0.64, 1),
    background-color 0.28s cubic-bezier(0.34, 1.08, 0.64, 1),
    opacity 0.2s ease;
  white-space: nowrap;
  overflow: hidden;
  user-select: none;
  flex-shrink: 0;
}

.remote-apply-btn:hover {
  background: rgba(29, 78, 216, 0.95);
}

.remote-apply-btn.applied {
  width: 68px;
  background: rgba(5, 150, 105, 0.88);
}

.remote-apply-btn.applied:hover {
  background: rgba(4, 120, 87, 0.96);
}

.apply-fade-leave-active {
  transition:
    opacity 0.08s ease-in,
    filter 0.08s ease-in,
    transform 0.08s ease-in;
}

.apply-fade-leave-to {
  opacity: 0;
  filter: blur(2px);
  transform: scale(0.92);
}

.apply-fade-enter-active {
  transition:
    opacity 0.18s cubic-bezier(0.34, 1.08, 0.64, 1),
    filter 0.18s cubic-bezier(0.34, 1.08, 0.64, 1),
    transform 0.18s cubic-bezier(0.34, 1.08, 0.64, 1);
}

.apply-fade-enter-from {
  opacity: 0;
  filter: blur(2px);
  transform: scale(0.92);
}
</style>
