import { screenshotContextManager } from './screenshot-context';

const CAPTURE_TTL_MS = 5 * 60 * 1000;
const SCROLL_COMPARISON_TOLERANCE_CSS_PX = 0.25;

export const SCREENSHOT_CAPTURE_VALIDATION_BOUNDARY =
  'DOM, document, viewport, DPR, scroll, and stylesheet DOM mutations only; canvas-only or pure-CSS animation without DOM mutations and cross-origin frame DOM are not fully observable';

export interface ScreenshotPageState {
  documentId: string;
  documentURL?: string;
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
}

export interface ScreenshotPageStateProbe extends ScreenshotPageState {
  domRevision: number;
  observerInitializedNow: boolean;
}

export interface ScreenshotCaptureRecord extends ScreenshotPageState {
  captureId: string;
  tabId: number;
  capturedAt: number;
  contextTimestamp: number;
  domRevision?: number;
  coordinateValidationSupported: boolean;
  unsupportedReason?: string;
  invalidationReason?: string;
}

export interface ScreenshotCaptureValidation {
  valid: boolean;
  reason?: string;
  record?: ScreenshotCaptureRecord;
}

export interface ScreenshotCoordinateBindingOptions {
  tabId: number;
  captureId?: string;
  coordinateSpace?: 'viewport' | 'screenshot';
  /** Jev vision-frame identity. Kept distinct from the ordinary captureId path. */
  visionFrameId?: string;
}

export interface ScreenshotCoordinateBindingValidation {
  captureId?: string;
  record?: ScreenshotCaptureRecord;
  error?: string;
}

const captures = new Map<string, ScreenshotCaptureRecord>();
const activeCaptureByTab = new Map<number, string>();

export function inPageReadScreenshotState(): ScreenshotPageStateProbe {
  const DOM_REVISION_KEY = '__browserpaw_dom_revision_v1__';
  const g = globalThis as any;
  let state = g[DOM_REVISION_KEY];
  let observerInitializedNow = false;
  if (
    !state ||
    state.document !== document ||
    !state.observer ||
    typeof state.isRelevantMutation !== 'function'
  ) {
    const isRelevantMutation = (record: MutationRecord): boolean => {
      const target = record.target;
      const element =
        target.nodeType === Node.ELEMENT_NODE
          ? (target as Element)
          : (target.parentElement ?? null);
      const isBrowserPawOwned = (node: Node | null): boolean => {
        const candidate =
          node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
        if (!candidate) return false;
        if (candidate.closest?.('#codex-agent-overlay-root, #__mcp_som_overlay_container__')) {
          return true;
        }
        if (
          candidate.matches?.(
            'link[data-browserpaw-injected="true"], link[data-browserpaw-original-favicon], link[data-browserpaw-original-rel]',
          )
        ) {
          return true;
        }
        return false;
      };
      if (isBrowserPawOwned(element)) return false;
      if (
        record.type === 'attributes' &&
        (record.attributeName === 'data-browserpaw-scroll-target' ||
          record.attributeName?.startsWith('data-browserpaw-ref-') ||
          record.attributeName?.startsWith('data-browserpaw-original-') ||
          record.attributeName === 'data-browserpaw-injected')
      ) {
        return false;
      }
      if (record.type === 'childList') {
        const changedNodes = [...record.addedNodes, ...record.removedNodes];
        if (changedNodes.length > 0 && changedNodes.every(isBrowserPawOwned)) {
          return false;
        }
      }
      return true;
    };
    state = {
      document,
      revision: 0,
      observer: null,
      isRelevantMutation,
    };
    state.observer = new MutationObserver((records: MutationRecord[]) => {
      state.revision += records.filter(state.isRelevantMutation).length;
    });
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    g[DOM_REVISION_KEY] = state;
    observerInitializedNow = true;
  }
  const pending = state.observer.takeRecords?.() || [];
  state.revision += pending.filter(state.isRelevantMutation).length;
  const doc = document;
  const win = window;
  const docEl = doc.documentElement;
  const body = doc.body;
  const rawScrollX = win.scrollX ?? win.pageXOffset ?? docEl?.scrollLeft ?? body?.scrollLeft ?? 0;
  const rawScrollY = win.scrollY ?? win.pageYOffset ?? docEl?.scrollTop ?? body?.scrollTop ?? 0;
  const documentId =
    (doc as any)._browserpaw_doc_id ||
    'doc_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now();
  try {
    (doc as any)._browserpaw_doc_id = documentId;
  } catch {}
  return {
    documentId,
    documentURL: doc.URL || win.location?.href || '',
    width: win.innerWidth || docEl?.clientWidth || 1280,
    height: win.innerHeight || docEl?.clientHeight || 800,
    dpr: win.devicePixelRatio || 1,
    scrollX: Number(rawScrollX),
    scrollY: Number(rawScrollY),
    domRevision: state.revision,
    observerInitializedNow,
  };
}

function pruneCaptures(): void {
  const now = Date.now();
  for (const [captureId, record] of captures) {
    if (now - record.capturedAt > CAPTURE_TTL_MS) {
      captures.delete(captureId);
      if (activeCaptureByTab.get(record.tabId) === captureId) {
        activeCaptureByTab.delete(record.tabId);
      }
    }
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  try {
    chrome.tabs.onRemoved.addListener((tabId: number) => clearScreenshotValidity(tabId));
  } catch {}
}

export async function readScreenshotPageState(tabId: number): Promise<ScreenshotPageStateProbe> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: inPageReadScreenshotState,
  });
  const state = results?.[0]?.result;
  if (
    !state ||
    !state.documentId ||
    !Number.isFinite(state.width) ||
    !Number.isFinite(state.height) ||
    !Number.isFinite(state.dpr) ||
    !Number.isFinite(state.scrollX) ||
    !Number.isFinite(state.scrollY) ||
    !Number.isFinite(state.domRevision)
  ) {
    throw new Error('Failed to read current page state for screenshot validity');
  }
  return state;
}

export function assertScreenshotCaptureStable(
  before: ScreenshotPageState,
  after: ScreenshotPageState,
  options?: { allowScrollChange?: boolean; compareDpr?: boolean },
): void {
  if (before.documentId !== after.documentId) {
    throw new Error(
      `Document changed during screenshot capture: pre="${before.documentId}" post="${after.documentId}"`,
    );
  }
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `Viewport changed during screenshot capture: pre=${before.width}x${before.height} post=${after.width}x${after.height}`,
    );
  }
  if (options?.compareDpr !== false && before.dpr !== after.dpr) {
    throw new Error(
      `Device pixel ratio changed during screenshot capture: pre=${before.dpr} post=${after.dpr}`,
    );
  }
  if (!options?.allowScrollChange) {
    if (
      Math.abs(before.scrollX - after.scrollX) > SCROLL_COMPARISON_TOLERANCE_CSS_PX ||
      Math.abs(before.scrollY - after.scrollY) > SCROLL_COMPARISON_TOLERANCE_CSS_PX
    ) {
      throw new Error(
        `Page scrolled during screenshot capture: pre=(${before.scrollX},${before.scrollY}) post=(${after.scrollX},${after.scrollY})`,
      );
    }
  }
}

export function createScreenshotCapture(input: {
  tabId: number;
  state: ScreenshotPageState;
  contextTimestamp: number;
  domRevision?: number;
  coordinateValidationSupported: boolean;
  unsupportedReason?: string;
}): Readonly<ScreenshotCaptureRecord> {
  pruneCaptures();
  const previousId = activeCaptureByTab.get(input.tabId);
  if (previousId) {
    const previous = captures.get(previousId);
    if (previous) {
      previous.invalidationReason = 'Superseded by a subsequent screenshot capture';
    }
    activeCaptureByTab.delete(input.tabId);
  }

  const captureId = `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const state: ScreenshotPageState = {
    documentId: input.state.documentId,
    documentURL: input.state.documentURL,
    width: input.state.width,
    height: input.state.height,
    dpr: input.state.dpr,
    scrollX: input.state.scrollX,
    scrollY: input.state.scrollY,
  };
  const record: ScreenshotCaptureRecord = {
    ...state,
    captureId,
    tabId: input.tabId,
    capturedAt: Date.now(),
    contextTimestamp: input.contextTimestamp,
    domRevision: input.domRevision,
    coordinateValidationSupported: input.coordinateValidationSupported,
    unsupportedReason: input.unsupportedReason,
  };
  captures.set(captureId, record);
  activeCaptureByTab.set(input.tabId, captureId);
  return record;
}

export function getScreenshotCapture(captureId: string): ScreenshotCaptureRecord | undefined {
  pruneCaptures();
  return captures.get(captureId);
}

export function validateScreenshotCapture(
  captureId: string,
  tabId: number,
  current: ScreenshotPageState,
  contextTimestamp?: number,
  currentDomRevision?: number,
): ScreenshotCaptureValidation {
  pruneCaptures();
  const record = captures.get(captureId);
  if (!record || record.invalidationReason) {
    return {
      valid: false,
      reason: `Screenshot capture ${captureId} not found or superseded`,
    };
  }
  if (record.tabId !== tabId) {
    return {
      valid: false,
      reason: `Screenshot capture belongs to tab ${record.tabId}, not ${tabId}`,
    };
  }
  if (activeCaptureByTab.get(tabId) !== captureId) {
    return {
      valid: false,
      reason: `Screenshot capture ${captureId} not found or superseded`,
    };
  }
  if (!record.coordinateValidationSupported) {
    return {
      valid: false,
      reason:
        record.unsupportedReason ||
        'Screenshot capture does not provide a reliable coordinate space',
    };
  }
  if (record.documentId !== current.documentId) {
    return { valid: false, reason: 'Document changed since screenshot capture' };
  }
  if (record.width !== current.width || record.height !== current.height) {
    return {
      valid: false,
      reason: `Viewport changed since screenshot capture: expected ${record.width}x${record.height}, got ${current.width}x${current.height}`,
    };
  }
  if (record.dpr !== current.dpr) {
    return {
      valid: false,
      reason: `Device pixel ratio changed since screenshot capture: expected ${record.dpr}, got ${current.dpr}`,
    };
  }
  if (
    Math.abs(record.scrollX - current.scrollX) > SCROLL_COMPARISON_TOLERANCE_CSS_PX ||
    Math.abs(record.scrollY - current.scrollY) > SCROLL_COMPARISON_TOLERANCE_CSS_PX
  ) {
    return {
      valid: false,
      reason: `Page scroll changed since screenshot capture: expected (${record.scrollX},${record.scrollY}), got (${current.scrollX},${current.scrollY})`,
    };
  }
  if (record.domRevision === undefined || currentDomRevision === undefined) {
    return { valid: false, reason: 'DOM revision could not be verified' };
  }
  if (record.domRevision !== currentDomRevision) {
    return {
      valid: false,
      reason: `DOM changed since screenshot capture: expected revision ${record.domRevision}, got ${currentDomRevision}`,
    };
  }
  if (contextTimestamp !== record.contextTimestamp) {
    return {
      valid: false,
      reason: 'Screenshot scaling context changed since capture',
    };
  }
  return { valid: true, record };
}

/**
 * The single source of truth for screenshot-bound coordinate dispatch.
 * Screenshot-space coordinates must name the exact capture they came from;
 * Jev's expectedScreenshotId is a separate, already-validated identity.
 */
export async function validateScreenshotCoordinateBinding(
  options: ScreenshotCoordinateBindingOptions,
): Promise<ScreenshotCoordinateBindingValidation> {
  const captureId = options.captureId?.trim() || undefined;

  if (captureId && options.visionFrameId) {
    return {
      error:
        'captureId and expectedScreenshotId are distinct screenshot identities and cannot be combined. Use captureId for ordinary screenshot coordinates or expectedScreenshotId for a Jev vision-frame click.',
    };
  }

  if (!captureId) {
    if (options.coordinateSpace === 'screenshot' && !options.visionFrameId) {
      return {
        error:
          'coordinateSpace "screenshot" requires an explicit captureId from a fresh screenshot; the latest screenshot context is not a valid identity. Capture a fresh screenshot and pass its captureId before dispatching coordinates.',
      };
    }
    return {};
  }

  const context = screenshotContextManager.getContext(options.tabId);
  if (!context) {
    return {
      error: `Screenshot context expired or not found for captureId ${captureId}. Capture a fresh screenshot before dispatching coordinates.`,
    };
  }

  let current: ScreenshotPageStateProbe;
  try {
    current = await readScreenshotPageState(options.tabId);
  } catch (error) {
    return {
      error: `Failed to validate screenshot captureId ${captureId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (current.observerInitializedNow) {
    return {
      error:
        'Invalid screenshot captureId: DOM mutation observer continuity was lost. Capture a fresh screenshot before dispatching coordinates.',
    };
  }

  const validation = validateScreenshotCapture(
    captureId,
    options.tabId,
    current,
    context.timestamp,
    current.domRevision,
  );
  if (!validation.valid) {
    return {
      error: `Invalid screenshot captureId: ${validation.reason}. Capture a fresh screenshot before dispatching coordinates.`,
    };
  }
  return { captureId, record: validation.record };
}

export function clearScreenshotValidity(tabId?: number): void {
  if (typeof tabId === 'number') {
    for (const [captureId, record] of captures) {
      if (record.tabId === tabId) captures.delete(captureId);
    }
    activeCaptureByTab.delete(tabId);
    return;
  }
  captures.clear();
  activeCaptureByTab.clear();
}
