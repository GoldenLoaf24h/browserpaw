<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

declare const __BROWSERPAW_BUILD_ID__: string;

const buildId = __BROWSERPAW_BUILD_ID__;
const version = chrome.runtime.getManifest().version;
const connection = ref<{ isRunning?: boolean; port?: number; error?: string }>({});
const enabled = ref(true);

async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS,
    });
    connection.value = status?.serverStatus ?? {};
    const current = await chrome.storage.session.get('agentControlEnabled');
    enabled.value = current.agentControlEnabled !== false;
  } catch {
    connection.value = {};
  }
}

async function toggle() {
  await chrome.storage.session.set({ agentControlEnabled: !enabled.value });
  await refresh();
}

let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 1000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <main>
    <h1>BrowserPaw</h1>
    <p role="status">{{ connection.isRunning ? 'Connected' : 'Disconnected' }}</p>
    <p v-if="connection.isRunning">Local port {{ connection.port }}</p>
    <p v-else>Run <code>browserpaw setup</code> or <code>browserpaw doctor</code>.</p>
    <button type="button" :aria-pressed="enabled" @click="toggle">
      {{ enabled ? 'Pause Agent control' : 'Enable Agent control' }}
    </button>
    <small>Version {{ version }} · {{ buildId }}</small>
  </main>
</template>

<style scoped>
main {
  min-width: 260px;
  padding: 16px;
  font:
    14px system-ui,
    sans-serif;
}
h1 {
  margin: 0;
  font-size: 19px;
}
small {
  display: block;
  margin-top: 12px;
  overflow-wrap: anywhere;
}
</style>
