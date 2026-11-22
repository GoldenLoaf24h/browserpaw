/**
 * Single source of truth for pages Chrome blocks extension content scripts /
 * CDP input from (browser internal pages, web store, etc.).
 *
 * Kept shared so chrome_read_dom / chrome_click_element / chrome_keyboard /
 * batch / screenshot all produce the SAME friendly error instead of leaking
 * the raw "Cannot access a chrome:// URL" exception into the extension error
 * panel with a spurious "ping content script failed" log line first.
 */

const CLOUD_METADATA_IPV4_HOSTS = new Set([
  '169.254.169.254',
  '169.254.169.253',
  '169.254.170.2',
  '169.254.170.23',
  '169.254.0.2',
  '100.100.100.200',
]);

const CLOUD_METADATA_HOSTNAMES = new Set([
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.internal',
]);

const CLOUD_METADATA_HOSTNAME_SUFFIXES = [
  '.metadata.google.internal',
  '.metadata.goog',
  '.metadata.internal',
];

function parseIpv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function parseIpv6Groups(rawHost: string): number[] | null {
  const withoutZone = rawHost.split('%')[0];
  if (!withoutZone.includes(':')) return null;
  const halves = withoutZone.split('::');
  if (halves.length > 2) return null;

  const parseSide = (segment: string): number[] | null => {
    if (!segment) return [];
    const tokens = segment.split(':');
    const groups: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.includes('.')) {
        if (index !== tokens.length - 1) return null;
        const octets = parseIpv4Octets(token);
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        groups.push(parseInt(token, 16));
      }
    }
    return groups;
  };

  const left = parseSide(halves[0]);
  if (!left) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseSide(halves[1]);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function ipv4FromHighLow(highWord: number, lowWord: number): string {
  return [(highWord >>> 8) & 0xff, highWord & 0xff, (lowWord >>> 8) & 0xff, lowWord & 0xff].join(
    '.',
  );
}

function isCloudMetadataIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (
    g0 === 0xfd00 &&
    g1 === 0x0ec2 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 0x0254
  ) {
    return true;
  }
  const isIpv4Mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const isIpv4Translated =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0;
  const isIpv4Compatible =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && (g6 !== 0 || g7 > 1);
  const isNat64 = g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (isIpv4Mapped || isIpv4Translated || isIpv4Compatible || isNat64) {
    return CLOUD_METADATA_IPV4_HOSTS.has(ipv4FromHighLow(g6, g7));
  }
  if (g0 === 0x2002) {
    return CLOUD_METADATA_IPV4_HOSTS.has(ipv4FromHighLow(g1, g2));
  }
  return false;
}

export function isCloudMetadataUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.+$/, '');
    if (!host) return false;
    if (CLOUD_METADATA_IPV4_HOSTS.has(host) || CLOUD_METADATA_HOSTNAMES.has(host)) {
      return true;
    }
    if (CLOUD_METADATA_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return true;
    }
    const ipv6Groups = parseIpv6Groups(host);
    if (ipv6Groups) {
      return isCloudMetadataIpv6(ipv6Groups);
    }
    return false;
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
 * keyboard, keyboard-helper answers its file-set ping. Every mismatch cost a 300ms ping timeout plus a
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
