import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { STORAGE_KEYS } from '@/common/constants';

interface ServerConnection {
  port: number;
  token?: string;
}

let cachedConnection: ServerConnection | null = null;
let lastConnectionFetch = 0;

/**
 * Resolves active server port and token via GET_SERVER_STATUS background message
 * with fallback to chrome.storage.local serverStatus and default port 12306.
 */
export async function getServerConnection(forceRefresh = false): Promise<ServerConnection> {
  const now = Date.now();
  if (!forceRefresh && cachedConnection && now - lastConnectionFetch < 5000) {
    return cachedConnection;
  }

  let port = 12306;
  let token: string | undefined;

  // 1. Try background message GET_SERVER_STATUS
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const resp = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage(
          { type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS },
          (response) => {
            if (chrome.runtime?.lastError) {
              resolve(null);
            } else {
              resolve(response);
            }
          },
        );
      });

      if (resp?.serverStatus?.port) {
        port = resp.serverStatus.port;
      }
      if (resp?.serverStatus?.token) {
        token = resp.serverStatus.token;
      }
    }
  } catch {}

  // 2. Fallback to chrome.storage.local
  if (!token) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const stored = await chrome.storage.local.get([STORAGE_KEYS.SERVER_STATUS, STORAGE_KEYS.NATIVE_SERVER_PORT]);
        const s = stored?.[STORAGE_KEYS.SERVER_STATUS];
        if (s?.port) port = s.port;
        else if (stored?.[STORAGE_KEYS.NATIVE_SERVER_PORT]) port = stored[STORAGE_KEYS.NATIVE_SERVER_PORT];
        if (s?.token) token = s.token;
      }
    } catch {}
  }

  cachedConnection = { port, token };
  lastConnectionFetch = now;
  return cachedConnection;
}

/**
 * Unified helper for all Jev API requests from extension popup.
 * Automatically injects the correct port and Authorization Bearer token.
 */
export async function jevFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const conn = await getServerConnection();
  const url = `http://127.0.0.1:${conn.port}${path.startsWith('/') ? path : '/' + path}`;

  const headers = new Headers(options.headers || {});
  if (conn.token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${conn.token}`);
  }

  return fetch(url, {
    ...options,
    headers,
  });
}

