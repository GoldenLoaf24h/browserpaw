<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { GITHUB_REPO_URL } from 'chrome-mcp-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { checkExtensionVersionUpdate } from '@/utils/version-checker';

declare const __BROWSERPAW_BUILD_ID__: string;

const buildId = __BROWSERPAW_BUILD_ID__;
const version = chrome.runtime.getManifest().version;
const DEFAULT_RELEASE_URL = GITHUB_REPO_URL + '/releases/latest';
const releaseUrl = ref(DEFAULT_RELEASE_URL);
const cursorIconUrl = chrome.runtime.getURL('images/cursor-chat.png');
const windowHint =
  'Tab: Works quietly in color-grouped tabs in your current window.\nWindow: Opens a separate dedicated OS window for agent tasks.';
const cursorOptions = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto' },
  { value: 'always', label: 'Always' },
] as const;
const windowOptions = [
  { value: 'tab', label: 'Tab' },
  { value: 'window', label: 'Window' },
] as const;

type CursorMode = (typeof cursorOptions)[number]['value'];
type WindowMode = (typeof windowOptions)[number]['value'];
type Preferences = {
  agentControlEnabled: boolean;
  agentCursorMode: CursorMode;
  agentWindowMode: WindowMode;
};

const statusLabels = {
  checking: 'Checking',
  online: 'Connected',
  offline: 'Offline',
  unavailable: 'Unavailable',
};
const status = ref<keyof typeof statusLabels>('checking');
const preferences = ref<Preferences | null>();
const saving = ref(false);
const saveFailed = ref(false);
const controlsDisabled = computed(() => !preferences.value || saving.value);
const hasUpdate = ref(false);
// Stay still until the stored state is painted, so indicators do not slide in from defaults.
const settled = ref(false);
let statusRead = 0;
let preferencesRead = 0;
let inFlightStatusReads = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshStatus() {
  const read = ++statusRead;
  inFlightStatusReads++;
  try {
    const reply = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS,
    });
    if (read !== statusRead) return;
    status.value =
      reply?.success === true
        ? reply.connected === true && reply.serverStatus?.isRunning === true
          ? 'online'
          : 'offline'
        : 'unavailable';
  } catch {
    if (read === statusRead) status.value = 'unavailable';
  } finally {
    inFlightStatusReads = Math.max(0, inFlightStatusReads - 1);
  }
}

async function readPreferences() {
  const read = ++preferencesRead;
  try {
    const [session, local] = await Promise.all([
      chrome.storage.session.get('agentControlEnabled'),
      chrome.storage.local.get(['agentCursorMode', 'agentWindowMode']),
    ]);
    if (read !== preferencesRead) return;
    preferences.value = {
      agentControlEnabled: session.agentControlEnabled !== false,
      agentCursorMode:
        local.agentCursorMode === 'off' || local.agentCursorMode === 'auto'
          ? local.agentCursorMode
          : 'always',
      agentWindowMode: local.agentWindowMode === 'window' ? 'window' : 'tab',
    };
  } catch {
    if (read === preferencesRead) preferences.value = null;
  }
}

async function savePreference<Key extends keyof Preferences>(key: Key, value: Preferences[Key]) {
  if (controlsDisabled.value || preferences.value?.[key] === value) return;
  saving.value = true;
  saveFailed.value = false;
  const storage = key === 'agentControlEnabled' ? chrome.storage.session : chrome.storage.local;
  try {
    await storage.set({ [key]: value });
  } catch {
    saveFailed.value = true;
  } finally {
    await readPreferences();
    saving.value = false;
  }
}

function handleStorageChange(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (
    (area === 'session' && changes.agentControlEnabled) ||
    (area === 'local' && (changes.agentCursorMode || changes.agentWindowMode))
  ) {
    void readPreferences();
  }
}

function handleRuntimeMessage(message: { type?: string }) {
  if (message?.type === BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED) void refreshStatus();
}

function handleVisibilityChange() {
  if (!document.hidden) {
    void refreshStatus();
  }
}

function resolveReleaseUrl(candidate?: string): string {
  if (typeof candidate === 'string' && candidate.startsWith(`${GITHUB_REPO_URL}/releases/`)) {
    return candidate;
  }
  return DEFAULT_RELEASE_URL;
}

async function checkForUpdate() {
  try {
    const result = await checkExtensionVersionUpdate();
    hasUpdate.value = result.hasUpdate;
    releaseUrl.value = result.hasUpdate
      ? resolveReleaseUrl(result.releaseUrl)
      : DEFAULT_RELEASE_URL;
  } catch {
    hasUpdate.value = false;
    releaseUrl.value = DEFAULT_RELEASE_URL;
  }
}

onMounted(() => {
  settleTimer = setTimeout(() => {
    settleTimer = undefined;
    settled.value = true;
  }, 80);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  chrome.storage.onChanged.addListener(handleStorageChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void refreshStatus();
  void readPreferences();
  void checkForUpdate();
  pollTimer = setInterval(() => {
    if (document.hidden || inFlightStatusReads > 0) return;
    void refreshStatus();
  }, 3000);
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  chrome.storage.onChanged.removeListener(handleStorageChange);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (settleTimer !== undefined) {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
});
</script>

<template>
  <main class="popup-shell" :class="{ settled }" :data-build-id="buildId">
    <header class="header">
      <h1>BrowserPaw</h1>
      <span class="connection" :class="status" role="status">{{ statusLabels[status] }}</span>
    </header>

    <fieldset
      class="controls"
      aria-label="Browser settings"
      :class="{ pending: !preferences }"
      :disabled="controlsDisabled"
    >
      <div class="row">
        <span id="agent-control" class="label">Agent Control</span>
        <button
          type="button"
          class="switch"
          :class="{ active: preferences?.agentControlEnabled }"
          role="switch"
          aria-labelledby="agent-control"
          :aria-checked="preferences?.agentControlEnabled"
          @click="savePreference('agentControlEnabled', !preferences?.agentControlEnabled)"
        >
          <span class="knob"></span>
        </button>
      </div>

      <div class="mode-row">
        <div class="mode-header">
          <span id="cursor-mode" class="label">Agent Cursor</span>
          <img
            class="cursor-hint"
            :src="cursorIconUrl"
            alt=""
            title="Agent Cursor: Virtual mouse pointer for visual browser automation"
          />
        </div>
        <div class="segments" role="group" aria-labelledby="cursor-mode">
          <span
            class="indicator three"
            :class="preferences?.agentCursorMode ?? 'always'"
            aria-hidden="true"
          ></span>
          <button
            v-for="option in cursorOptions"
            :key="option.value"
            type="button"
            :aria-pressed="preferences?.agentCursorMode === option.value"
            @click="savePreference('agentCursorMode', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div class="mode-row">
        <div class="mode-header">
          <span id="window-mode" class="label">Window Mode</span>
          <span class="info" :title="windowHint">i</span>
        </div>
        <div class="segments" role="group" aria-labelledby="window-mode">
          <span
            class="indicator two"
            :class="preferences?.agentWindowMode ?? 'tab'"
            aria-hidden="true"
          ></span>
          <button
            v-for="option in windowOptions"
            :key="option.value"
            type="button"
            :aria-pressed="preferences?.agentWindowMode === option.value"
            @click="savePreference('agentWindowMode', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </fieldset>

    <p v-if="saveFailed || preferences === null" class="error" role="alert">
      {{ saveFailed ? "Couldn't save settings." : 'Settings unavailable.' }}
    </p>

    <footer class="footer">
      <a
        class="repo"
        :href="GITHUB_REPO_URL"
        target="_blank"
        rel="noopener noreferrer"
        title="Star BrowserPaw on GitHub"
        aria-label="Star BrowserPaw on GitHub"
      >
        <i-lucide-github aria-hidden="true" />
        <i-lucide-star class="star" aria-hidden="true" />
      </a>
      <a
        v-if="hasUpdate"
        class="version update"
        :href="releaseUrl"
        target="_blank"
        rel="noopener noreferrer"
        title="Extension update available — open release"
        :aria-label="'v' + version + ' · Extension update available — open release'"
        >v{{ version }}</a
      >
      <span v-else class="version">v{{ version }}</span>
    </footer>
  </main>
</template>
