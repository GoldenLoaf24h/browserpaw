import { screenshotContextManager, type VisionFrameContext } from './screenshot-context';
import type { PerceptiveSignature } from '../entrypoints/background/tools/browser/dom-indexer';

/**
 * Compares two perceptive signatures across all fields:
 * question, progress, stepCurrent, stepTotal, title, url, alerts, and activeInputs.
 * Returns a human-readable drift description if any field changed, or null if identical.
 */
export function diffPerceptiveSignatures(
  captured: PerceptiveSignature,
  current: PerceptiveSignature,
): string | null {
  if (captured.url !== current.url) {
    return `URL changed from "${captured.url}" to "${current.url}"`;
  }
  if (captured.title !== current.title) {
    return `Title changed from "${captured.title}" to "${current.title}"`;
  }
  if (captured.question !== current.question) {
    return `question heading changed from "${captured.question ?? ''}" to "${current.question ?? ''}"`;
  }
  if (captured.progress !== current.progress) {
    return `progress indicator changed from "${captured.progress ?? ''}" to "${current.progress ?? ''}"`;
  }
  if (captured.stepCurrent !== current.stepCurrent) {
    return `form stepCurrent changed from ${captured.stepCurrent} to ${current.stepCurrent}`;
  }
  if (captured.stepTotal !== current.stepTotal) {
    return `form stepTotal changed from ${captured.stepTotal} to ${current.stepTotal}`;
  }

  const capAlerts = captured.alerts || [];
  const curAlerts = current.alerts || [];
  if (capAlerts.length !== curAlerts.length || capAlerts.some((a, i) => a !== curAlerts[i])) {
    return `alerts changed from [${capAlerts.join(', ')}] to [${curAlerts.join(', ')}]`;
  }

  const capInputs = captured.activeInputs || [];
  const curInputs = current.activeInputs || [];
  if (capInputs.length !== curInputs.length) {
    return `active inputs count changed from ${capInputs.length} to ${curInputs.length}`;
  }
  for (let i = 0; i < capInputs.length; i++) {
    const ci = capInputs[i];
    const curr = curInputs[i];
    if (
      ci.tagName !== curr.tagName ||
      ci.type !== curr.type ||
      ci.name !== curr.name ||
      ci.placeholder !== curr.placeholder ||
      ci.ariaLabel !== curr.ariaLabel ||
      ci.value !== curr.value ||
      ci.index !== curr.index
    ) {
      return `active input [${i}] changed: captured ${JSON.stringify(ci)} vs current ${JSON.stringify(curr)}`;
    }
  }

  return null;
}

function hostnameOf(url: string | undefined): string {
  try {
    return new URL(url || '').hostname;
  } catch {
    return '';
  }
}

/**
 * Guard: the most recent screenshot for this tab must be from the same
 * origin the agent is about to act on, otherwise screenshot-space
 * coordinates would map onto a foreign page. Returns an error message when
 * the check fails, or null when it passes.
 */
export function screenshotOriginViolation(
  tabId: number,
  tabUrl: string | undefined,
  action: string,
): string | null {
  const ctx = screenshotContextManager.getContext(tabId);
  const contextHostname = ctx?.hostname;
  const currentHostname = hostnameOf(tabUrl);
  if (contextHostname && contextHostname !== currentHostname) {
    return `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during ${action}. Capture a new screenshot or use ref/selector.`;
  }
  return null;
}

/** Optional down-up dwell between press and release (anti-instant-click targets). */
export function dwell(ms: number | undefined): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, Math.min(ms, 2000)));
}

export interface VisionFrameValidationOptions {
  expectedScreenshotId: string;
  currentTabId: number;
  currentUrl?: string;
  currentDocumentId?: string;
  currentScroll?: { scrollX: number; scrollY: number };
  currentViewport?: { viewportWidth: number; viewportHeight: number };
  currentPerceptiveSignature?: PerceptiveSignature | null;
  tolerancePx?: number;
}

export interface VisionFrameValidationResult {
  valid: boolean;
  frame?: VisionFrameContext;
  error?: string;
  reason?: string;
}

/**
 * Validates that an expected vision frame is still fresh, unmodified, and safe to execute against.
 * Fail-closed policy: any drift in tab affinity, replacement, TTL, URL, scroll, viewport, or perceptual signature
 * causes validation to fail with zero clicks/inputs dispatched.
 *
 * shortcut: Signatures cover URL, title, question/progress markers, alerts, and active inputs.
 * Pixel-only redraws and other layout changes require independent outcome verification;
 * add pixel comparison if dynamic canvas or video controls need stronger freshness checks.
 */
export function validateVisionFrame(
  options: VisionFrameValidationOptions,
): VisionFrameValidationResult {
  const frame = screenshotContextManager.getVisionFrame(options.expectedScreenshotId);
  if (!frame) {
    return {
      valid: false,
      error: `Vision frame "${options.expectedScreenshotId}" not found or expired. Capture a fresh screenshot before executing actions.`,
    };
  }

  if (frame.tabId !== options.currentTabId) {
    return {
      valid: false,
      error: `Security check failed: Vision frame belongs to tab ${frame.tabId}, but action is targeting tab ${options.currentTabId}.`,
    };
  }

  if (frame.consumed) {
    return {
      valid: false,
      error: `Vision frame "${frame.id}" has already been consumed by a prior interaction (single-use protection). Capture a fresh screenshot.`,
    };
  }

  if (frame.isInvalidated) {
    return {
      valid: false,
      error: `Vision frame "${frame.id}" was invalidated: ${frame.invalidationReason || 'superseded or expired'}.`,
    };
  }

  const activeId = screenshotContextManager.getActiveVisionFrameId(frame.tabId);
  if (activeId && activeId !== frame.id) {
    screenshotContextManager.invalidateVisionFrame(
      frame.id,
      `Superseded by newer frame ${activeId}`,
    );
    return {
      valid: false,
      error: `Vision frame "${frame.id}" was superseded by a newer capture "${activeId}" on tab ${frame.tabId}.`,
    };
  }

  // Fail-closed policy on missing probes: if probes could not be gathered, execution cannot proceed safely
  if (!options.currentScroll) {
    return {
      valid: false,
      error: 'Missing current scroll state probe; cannot verify frame stability.',
    };
  }

  if (!options.currentViewport) {
    return {
      valid: false,
      error: 'Missing current viewport probe; cannot verify frame stability.',
    };
  }

  if (frame.perceptiveSignature && !options.currentPerceptiveSignature) {
    return {
      valid: false,
      error: 'Missing current perceptive signature probe; cannot verify frame stability.',
    };
  }

  if (frame.documentId && !options.currentDocumentId) {
    return {
      valid: false,
      error: 'Missing current document ID probe; cannot verify frame stability.',
    };
  }

  // Check document identity: fail closed if document navigated or reloaded
  if (
    frame.documentId &&
    options.currentDocumentId &&
    frame.documentId !== options.currentDocumentId
  ) {
    return {
      valid: false,
      error: `Document ID mismatch: captured "${frame.documentId}" vs current "${options.currentDocumentId}". Page was reloaded or replaced.`,
    };
  }

  // Check full URL (including query and hash)
  if (frame.url && !options.currentUrl) {
    return {
      valid: false,
      error: 'Missing current URL probe; cannot verify frame stability.',
    };
  }
  if (options.currentUrl && frame.url && options.currentUrl !== frame.url) {
    return {
      valid: false,
      error: `Page URL changed since vision frame capture (captured: "${frame.url}", current: "${options.currentUrl}").`,
    };
  }

  const tolerance = typeof options.tolerancePx === 'number' ? options.tolerancePx : 4;

  if (typeof frame.scrollX === 'number' && typeof frame.scrollY === 'number') {
    const dx = Math.abs(options.currentScroll.scrollX - frame.scrollX);
    const dy = Math.abs(options.currentScroll.scrollY - frame.scrollY);
    if (dx > tolerance || dy > tolerance) {
      return {
        valid: false,
        error: `Page scroll drift detected (captured: [${frame.scrollX}, ${frame.scrollY}], current: [${options.currentScroll.scrollX}, ${options.currentScroll.scrollY}], drift: [${dx}, ${dy}]px > tolerance ${tolerance}px). Capture a new screenshot.`,
      };
    }
  }

  if (typeof frame.viewportWidth === 'number' && typeof frame.viewportHeight === 'number') {
    const dw = Math.abs(options.currentViewport.viewportWidth - frame.viewportWidth);
    const dh = Math.abs(options.currentViewport.viewportHeight - frame.viewportHeight);
    if (dw > tolerance || dh > tolerance) {
      return {
        valid: false,
        error: `Viewport dimension change detected (captured: ${frame.viewportWidth}x${frame.viewportHeight}, current: ${options.currentViewport.viewportWidth}x${options.currentViewport.viewportHeight}, diff: [${dw}, ${dh}]px > tolerance ${tolerance}px).`,
      };
    }
  }

  if (frame.perceptiveSignature && options.currentPerceptiveSignature) {
    const diff = diffPerceptiveSignatures(
      frame.perceptiveSignature,
      options.currentPerceptiveSignature,
    );
    if (diff) {
      return {
        valid: false,
        error: `DOM perceptive signature mismatch: ${diff}.`,
      };
    }
  }

  return {
    valid: true,
    frame,
  };
}
