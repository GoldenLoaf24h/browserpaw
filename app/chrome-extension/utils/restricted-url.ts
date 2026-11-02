/**
 * Single source of truth for pages Chrome blocks extension content scripts /
 * CDP input from (browser internal pages, web store, etc.).
 *
 * Kept shared so chrome_read_dom / chrome_click_element / chrome_keyboard /
 * batch / screenshot all produce the SAME friendly error instead of leaking
 * the raw "Cannot access a chrome:// URL" exception into the extension error
 * panel with a spurious "ping content script failed" log line first.
 */

export function isCloudMetadataUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      h === '169.254.169.254' ||
      h === '169.254.169.253' ||
      h === '100.100.100.200' ||
      h === '169.254.0.2' ||
      h === 'instance-data' ||
      h === 'metadata.google.internal' ||
      h === 'metadata.internal' ||
      h.endsWith('.metadata.google.internal') ||
      h === 'fd00:ec2::254'
    );
  } catch {
    return false;
  }
}

const CHROMIUM_ERROR_PAGE_URL = /^[a-z][a-z0-9+.-]*-error:\/\/chromewebdata(?:[/:?#]|$)/i;

export function isChromiumErrorPageUrl(url: string | undefined | null): boolean {
  return typeof url === 'string' && CHROMIUM_ERROR_PAGE_URL.test(url.trim());
}

export function isErrorPageInjectionError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /is showing error page/i.test(message);
}

export class ExpectedPageRestrictionError extends Error {
  readonly code = 'page_restriction';

  constructor(message: string) {
    super(message);
    this.name = 'ExpectedPageRestrictionError';
  }
}

export function isExpectedPageRestrictionError(error: unknown): boolean {
  if (error instanceof ExpectedPageRestrictionError) return true;
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    isErrorPageInjectionError(error) ||
    /Cannot operate on this browser internal page or web store page/i.test(message) ||
    /Security Restriction: Navigation or requests to cloud instance metadata service/i.test(message)
  );
}

export function logUnexpectedToolError(message: string, error: unknown): void {
  if (isExpectedPageRestrictionError(error)) return;
  console.error(message, error);
}

export function errorPageInjectionErrorMessage(url: string | undefined | null): string {
  return (
    'Chrome is showing an error page for this tab. Reload or navigate to a working page before retrying: ' +
    (url || 'unknown URL')
  );
}

export function isRestrictedChromeUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const lowerUrl = url.trim().toLowerCase();
  return (
    isChromiumErrorPageUrl(lowerUrl) ||
    lowerUrl.startsWith('chrome://') ||
    lowerUrl.startsWith('edge://') ||
    lowerUrl.startsWith('devtools://') ||
    lowerUrl.startsWith('chrome-extension://') ||
    lowerUrl.startsWith('view-source:') ||
    lowerUrl.startsWith('https://chrome.google.com/webstore') ||
    lowerUrl.startsWith('https://chromewebstore.google.com') ||
    lowerUrl.startsWith('https://microsoftedge.microsoft.com/') ||
    isCloudMetadataUrl(lowerUrl)
  );
}

export function restrictedUrlErrorMessage(url: string | undefined | null): string {
  if (isChromiumErrorPageUrl(url)) {
    return errorPageInjectionErrorMessage(url);
  }
  if (isCloudMetadataUrl(url)) {
    return (
      'Security Restriction: Navigation or requests to cloud instance metadata service (' +
      (url || 'unknown URL') +
      ') are strictly forbidden.'
    );
  }
  return (
    'Cannot operate on this browser internal page or web store page due to security restrictions: ' +
    (url || 'unknown URL')
  );
}

/**
 * Throw the friendly restricted-page error when the tab cannot be scripted.
 *
 * Every chrome.scripting.executeScript call site funnels through this so the
 * raw "Cannot access a chrome:// URL" exception never reaches the extension
 * error panel — previously only the content-script injection and in-page
 * engine entry points were guarded, while javascript / scroll_to_text /
 * upload_file / batch_actions / computer hover still leaked the raw error.
 */
export async function assertTabInjectable(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (isRestrictedChromeUrl(tab?.url)) {
    throw new ExpectedPageRestrictionError(restrictedUrlErrorMessage(tab?.url));
  }
}

/**
 * Derive the ping action for a set of injected files.
 *
 * The previous per-tool ping (`${this.name}_ping`) could never match helpers
 * that answer a fixed action: accessibility-tree-helper answers
 * chrome_read_page_ping but is also injected by computer / interaction /
 * keyboard, wait-helper answers wait_helper_ping, web-fetcher-helper answers
 * chrome_web_fetcher_ping. Every mismatch cost a 300ms ping timeout plus a
 * "ping content script failed" log line before the script was re-injected
 * anyway. Keying the ping on the injected file set makes the answer depend on
 * what was actually injected, not on who asked.
 */
export const PING_ACTION_PREFIX = 'mcp_ping_';

export function pingActionForFiles(files: string[]): string {
  let hash = 5381;
  const key = files.join(',');
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
  }
  return `${PING_ACTION_PREFIX}${hash.toString(36)}`;
}
