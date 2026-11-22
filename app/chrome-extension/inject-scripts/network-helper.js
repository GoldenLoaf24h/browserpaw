/**
 * Network Capture Helper
 *
 * This script helps replay network requests with the original cookies and headers.
 */

// Prevent duplicate initialization
if (window.__NETWORK_CAPTURE_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__NETWORK_CAPTURE_HELPER_INITIALIZED__ = true;

  const FORBIDDEN_METADATA_IPV4 = new Set([
    '169.254.169.254',
    '169.254.169.253',
    '169.254.170.2',
    '169.254.170.23',
    '169.254.0.2',
    '100.100.100.200',
  ]);

  const FORBIDDEN_METADATA_HOSTS = new Set([
    'instance-data',
    'instance-data.ec2.internal',
    'metadata.google.internal',
    'metadata.goog',
    'metadata.internal',
  ]);

  function parseIpv6ToGroups(rawHost) {
    const withoutZone = rawHost.split('%')[0];
    if (!withoutZone.includes(':')) return null;
    const halves = withoutZone.split('::');
    if (halves.length > 2) return null;
    const parseSegment = (segment) => {
      if (!segment) return [];
      const parts = segment.split(':');
      const groups = [];
      for (let index = 0; index < parts.length; index++) {
        const token = parts[index];
        if (token.includes('.')) {
          if (index !== parts.length - 1) return null;
          const octets = token.split('.');
          if (octets.length !== 4) return null;
          const nums = [];
          for (const octet of octets) {
            if (!/^\d{1,3}$/.test(octet)) return null;
            const num = Number(octet);
            if (num < 0 || num > 255) return null;
            nums.push(num);
          }
          groups.push((nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]);
        } else {
          if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
          groups.push(parseInt(token, 16));
        }
      }
      return groups;
    };
    const left = parseSegment(halves[0]);
    if (!left) return null;
    if (halves.length === 1) return left.length === 8 ? left : null;
    const right = parseSegment(halves[1]);
    if (!right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...new Array(missing).fill(0), ...right];
  }

  function isForbiddenTargetUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    const trimmed = rawUrl.trim();
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith('file:') ||
      lower.startsWith('chrome://') ||
      lower.startsWith('edge://') ||
      lower.startsWith('devtools://') ||
      lower.startsWith('chrome-extension://') ||
      lower.startsWith('view-source:')
    ) {
      return true;
    }
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.+$/, '');
      if (FORBIDDEN_METADATA_IPV4.has(host) || FORBIDDEN_METADATA_HOSTS.has(host)) {
        return true;
      }
      if (
        host.endsWith('.metadata.google.internal') ||
        host.endsWith('.metadata.goog') ||
        host.endsWith('.metadata.internal')
      ) {
        return true;
      }
      const groups = parseIpv6ToGroups(host);
      if (groups) {
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
        const toIpv4 = (hi, lo) =>
          [(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff].join('.');
        if (
          (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) ||
          (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) ||
          (g0 === 0 &&
            g1 === 0 &&
            g2 === 0 &&
            g3 === 0 &&
            g4 === 0 &&
            g5 === 0 &&
            (g6 !== 0 || g7 > 1)) ||
          (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
        ) {
          return FORBIDDEN_METADATA_IPV4.has(toIpv4(g6, g7));
        }
        if (g0 === 0x2002) {
          return FORBIDDEN_METADATA_IPV4.has(toIpv4(g1, g2));
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Replay a network request
   * @param {string} url - The URL to send the request to
   * @param {string} method - The HTTP method to use
   * @param {Object} headers - The headers to include in the request
   * @param {any} body - The body of the request
   * @param {number} timeout - Timeout in milliseconds (default: 30000)
   * @returns {Promise<Object>} - The response data
   */
  async function replayNetworkRequest(
    url,
    method,
    headers,
    body,
    timeout = 30000,
    formDataDescriptor = null,
  ) {
    try {
      // Create fetch options
      const options = {
        method: method,
        headers: headers || {},
        credentials: 'include', // Include cookies
        mode: 'cors',
        cache: 'no-cache',
      };

      // Helper: convert base64 to Blob
      const base64ToBlob = (base64, contentType = 'application/octet-stream') => {
        try {
          const decodedString = atob(base64);
          const len = decodedString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = decodedString.charCodeAt(i);
          return new Blob([bytes], { type: contentType });
        } catch (e) {
          return new Blob([]);
        }
      };

      // Build multipart/form-data if descriptor is provided
      if (method !== 'GET' && method !== 'HEAD' && formDataDescriptor) {
        const fd = new FormData();
        try {
          if (Array.isArray(formDataDescriptor)) {
            for (const item of formDataDescriptor) {
              if (!Array.isArray(item) || item.length < 2) continue;
              const name = String(item[0] || 'file');
              const spec = String(item[1] || '');
              const filenameHint = item[2] ? String(item[2]) : undefined;
              if (/^(https?:\/\/|url:)/i.test(spec)) {
                const url = spec.replace(/^url:/i, '');
                if (isForbiddenTargetUrl(url)) {
                  throw new Error(
                    'Security Restriction: Navigation or requests to cloud instance metadata service are strictly forbidden.',
                  );
                }
                const resp = await fetch(url);
                if (isForbiddenTargetUrl(resp.url)) {
                  throw new Error(
                    'Security Restriction: Redirect to cloud instance metadata or restricted URL is strictly forbidden.',
                  );
                }
                const blob = await resp.blob();
                const fn =
                  filenameHint || url.split('?')[0].split('#')[0].split('/').pop() || 'file';
                fd.append(name, blob, fn);
              } else if (/^base64:/i.test(spec)) {
                const b64 = spec.replace(/^base64:/i, '');
                const blob = base64ToBlob(b64);
                fd.append(name, blob, filenameHint || 'file');
              } else {
                // treat as string field
                fd.append(name, spec);
              }
            }
          } else if (typeof formDataDescriptor === 'object') {
            const fds = formDataDescriptor;
            const fields = fds.fields || {};
            const files = Array.isArray(fds.files) ? fds.files : [];
            for (const [k, v] of Object.entries(fields)) fd.append(String(k), String(v));
            for (const file of files) {
              const name = String(file.name || 'file');
              if (file.fileUrl) {
                const targetFileUrl = String(file.fileUrl);
                if (isForbiddenTargetUrl(targetFileUrl)) {
                  throw new Error(
                    'Security Restriction: Navigation or requests to cloud instance metadata service are strictly forbidden.',
                  );
                }
                const resp = await fetch(targetFileUrl);
                if (isForbiddenTargetUrl(resp.url)) {
                  throw new Error(
                    'Security Restriction: Redirect to cloud instance metadata or restricted URL is strictly forbidden.',
                  );
                }
                const blob = await resp.blob();
                const fn =
                  file.filename ||
                  String(file.fileUrl).split('?')[0].split('#')[0].split('/').pop() ||
                  'file';
                fd.append(name, blob, fn);
              } else if (typeof file.base64Data === 'string') {
                const blob = base64ToBlob(
                  String(file.base64Data),
                  String(file.contentType || 'application/octet-stream'),
                );
                fd.append(name, blob, file.filename || 'file');
              }
            }
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('Security Restriction:')) {
            throw e;
          }
          console.warn('Failed to construct FormData:', e);
        }
        // Let browser set the correct multipart boundary
        try {
          if (options.headers) {
            delete options.headers['content-type'];
            delete options.headers['Content-Type'];
          }
        } catch {}
        options.body = fd;
      } else if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
        // Fallback to raw body
        options.body = body;
      }

      // Create a fetch request with timeout
      const fetchWithTimeout = async (url, options, timeout) => {
        const controller = new AbortController();
        const signal = controller.signal;

        // Set up abort timeout
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(url, { ...options, signal });
          clearTimeout(timeoutId);
          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      };

      // Send request with timeout controller
      const response = await fetchWithTimeout(url, options, timeout);

      if (isForbiddenTargetUrl(response.url)) {
        return {
          success: false,
          error:
            'Security Restriction: Redirect to cloud instance metadata service (' +
            response.url +
            ') is strictly forbidden.',
        };
      }

      // Process response
      const responseData = {
        status: response.status,
        statusText: response.statusText,
        ...(response.url ? { url: response.url } : {}),
        headers: {},
      };

      // Get response headers
      response.headers.forEach((value, key) => {
        responseData.headers[key] = value;
      });

      // Try to get response body based on content type
      const contentType = response.headers.get('content-type') || '';

      try {
        if (contentType.includes('application/json')) {
          responseData.body = await response.json();
        } else if (
          contentType.includes('text/') ||
          contentType.includes('application/xml') ||
          contentType.includes('application/javascript')
        ) {
          responseData.body = await response.text();
        } else {
          // For binary data, just indicate it was received but not parsed
          responseData.body = '[Binary data not displayed]';
        }
      } catch (error) {
        responseData.body = `[Error parsing response body: ${error.message}]`;
      }

      return {
        success: true,
        response: responseData,
      };
    } catch (error) {
      console.error('Error replaying request:', error);
      return {
        success: false,
        error: `Error replaying request: ${error.message}`,
      };
    }
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    // Respond to ping message
    if (
      request.action === 'chrome_network_request_ping' ||
      String(request.action || '').startsWith('mcp_ping_')
    ) {
      sendResponse({ status: 'pong' });
      return false; // Synchronous response
    } else if (request.action === 'sendPureNetworkRequest') {
      replayNetworkRequest(
        request.url,
        request.method,
        request.headers,
        request.body,
        request.timeout,
        request.formData,
      )
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            success: false,
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    }
  });
}
