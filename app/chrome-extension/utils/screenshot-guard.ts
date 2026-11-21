import { screenshotContextManager } from './screenshot-context';

function hostnameOf(url: string | undefined): string {
  try {
    return new URL(url || '').hostname;
  } catch {
    return '';
  }
}

export function screenshotOriginViolation(
  tabId: number,
  tabUrl: string | undefined,
  action: string,
): string | null {
  const contextHostname = screenshotContextManager.getContext(tabId)?.hostname;
  const currentHostname = hostnameOf(tabUrl);
  if (contextHostname && contextHostname !== currentHostname) {
    return `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during ${action}. Capture a new screenshot or use ref/selector.`;
  }
  return null;
}

export function dwell(ms: number | undefined): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2000)));
}
