import {
  createErrorResponse,
  type ToolCallContext,
  ToolResult,
} from '../../../../common/tool-handler';
import { throwIfAborted, waitWithAbort, TaskCancelledError } from '../../../../utils/action-abort';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName, type CaptureNetworkOptions } from 'chrome-mcp-shared';
import { cdpSessionManager } from '../../../../utils/cdp-session-manager';
import {
  raceCdp,
  DialogOpenedError,
  createDialogInterruptResponse,
  StalePageError,
  createTargetOccludedResponse,
  createMousePressGuard,
  dispatchMousePressRelease,
  isCdpOutcomeUncertainError,
} from '../../../../utils/race-cdp';
import { executeInPage } from './in-page-engine';
import { waitForPageSettle, waitForNetworkQuiescence } from '../../../../utils/action-watchdog';
import {
  inPageArmDeliveryProbe,
  inPageReadDeliveryProbe,
  computePerceptiveDelta,
} from './dom-indexer';
import {
  screenshotContextManager,
  scaleCoordinates,
  scaleVisionFrameCoordinates,
  type VisionFrameContext,
} from '../../../../utils/screenshot-context';
import { screenshotOriginViolation, validateVisionFrame } from '../../../../utils/screenshot-guard';
import {
  SCREENSHOT_CAPTURE_VALIDATION_BOUNDARY,
  validateScreenshotCoordinateBinding,
} from '../../../../utils/screenshot-validity';
import { computeHumanizedPoints } from '../../../../utils/mouse-trajectory';
import type { CdpEventObserver } from '../../../../utils/cdp-session-manager';
import {
  parseUnifiedCoordinate,
  type PolymorphicCoordinate,
} from '../../../../utils/coordinate-parser';
import { sessionTabAffinity } from '../../../../utils/session-tab-affinity';
import {
  animateAgentCursor,
  animateAgentCursorClick,
  formatAgentCursorAction,
} from './agent-cursor';
import {
  captureChainedSnapshot,
  captureGoalObservation,
  ensureSnapshotBaseline,
} from '../../../../utils/delta-helper';
import { tabFaviconManager } from './tab-favicon';
import { startActionNetworkCapture } from '../../../../utils/action-network-capture';
import { projectFramePoint } from '../../../../utils/frame-coordinates';
import { withActionReceipt, attachActionReceipt } from '../../../../utils/action-receipt';
import { assertObservedTarget } from '../../../../utils/observed-target-guard';
import {
  createInteractionErrorResponse,
  makeInteractionOutcome,
} from '../../../../utils/interaction-outcome';

export interface InteractIndexParams {
  expectedGuard?: unknown[];
  index?: number;
  frameId?: number;
  coordinate?: { x: number; y: number } | PolymorphicCoordinate;
  coordinateSpace?: 'viewport' | 'screenshot';
  /** Ordinary screenshot identity from chrome_screenshot. Screenshot-space coordinates must name it. */
  captureId?: string;
  /** Internal: Bind action execution to a specific immutable TypeSafe vision frame.
   * If the page or frame has drifted or been superseded, execution fails closed before dispatch. */
  expectedScreenshotId?: string;
  /** Internal: Epoch ms deadline before which the physical click press must be dispatched.
   * If Date.now() >= expectedDeadlineAt at entry or right before mousePressed, execution fails closed. */
  expectedDeadlineAt?: number;
  points?: Array<{ x: number; y: number } | PolymorphicCoordinate>;
  intervalMs?: number;
  action?: 'click' | 'hover' | 'double_click' | 'right_click' | 'drag';
  path?: Array<{ x: number; y: number }>;
  end?: { index?: number; coordinate?: { x: number; y: number } | PolymorphicCoordinate };
  steps?: number;
  holdMs?: number;
  dnd?: boolean;
  modifiers?: string[];
  /** Internal compatibility target for legacy click callers. */
  button?: 'left' | 'right' | 'middle';
  tabId?: number;
  windowId?: number;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  /** Wait for in-flight network requests to settle after interaction before returning (default: false) */
  waitForNetworkQuiescence?: boolean;
  /** Quiescence timeout in ms (default 2000) */
  quiescenceTimeoutMs?: number;
  humanize?: boolean;
  includeDelta?: boolean;
  sessionId?: string;
  sessionContext?: string;
  /** Internal: skip acquiring the per-tab mutex. Only pass true when the caller
   *  already holds sessionTabAffinity.runSerialized for this tabId (prevents
   *  non-reentrant re-entrant deadlock). Not exposed in the MCP schema. */
  skipLock?: boolean;
  autoSnap?: boolean;
  /** Automatically pierce non-opaque, transient, or presentation backdrop masks */
  pierceOverlay?: boolean;
  /** Inline capture of network response triggered by this interaction in a single RTT */
  captureNetwork?: CaptureNetworkOptions;
}

/**
 * Track last known cursor position per tab for smooth humanized trajectories
 */
const lastMousePosMap = new Map<number, { x: number; y: number }>();

// Register tab removal listener to prevent memory leak
if (typeof chrome !== 'undefined' && chrome?.tabs?.onRemoved?.addListener) {
  try {
    chrome.tabs.onRemoved.addListener((closedTabId: number) => {
      lastMousePosMap.delete(closedTabId);
    });
  } catch {}
}

export { computeHumanizedPoints };

/**
 * Resolve an indexed drag endpoint in the current top-level viewport.
 */
async function resolveDragEndPoint(
  tabId: number,
  end: InteractIndexParams['end'],
  frameId?: number,
): Promise<{ x: number; y: number } | null> {
  if (!end) return null;
  if (typeof end.index === 'number' && end.index > 0) {
    const lookupTarget = frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] };
    let coordResult: any = (
      await executeInPage(lookupTarget, 'inPageGetElementCoordinates', [end.index])
    )?.[0]?.result;
    let endFrameId: number | undefined = frameId;
    if (!coordResult?.success && frameId === undefined) {
      const frameResults = await executeInPage(
        { tabId, allFrames: true },
        'inPageGetElementCoordinates',
        [end.index],
      );
      const match = frameResults.find((r) => r.result?.success);
      if (match?.result) {
        coordResult = match.result;
        endFrameId = match.frameId;
      }
    }
    if (
      coordResult?.success &&
      typeof coordResult.x === 'number' &&
      typeof coordResult.y === 'number'
    ) {
      let endX = coordResult.x;
      let endY = coordResult.y;
      if (endFrameId && endFrameId !== 0 && !coordResult.isFrameCompensated) {
        ({ x: endX, y: endY } = await projectFramePoint(tabId, endFrameId, {
          x: endX - (coordResult.frameOffsetX || 0),
          y: endY - (coordResult.frameOffsetY || 0),
        }));
      }
      return { x: endX, y: endY };
    }
    return null;
  }

  return null;
}

/**
 * Dispatch mouse movement to target coordinates.
 * When humanize is true, interpolates 3-5 steps along a cubic ease-out curve with micro-jitter.
 */
async function dispatchMouseMovement(
  tabId: number,
  targetX: number,
  targetY: number,
  modifierMask: number,
  humanize = false,
): Promise<void> {
  if (!humanize) {
    // Dispatch 5 intermediate approach steps tightly within 35px radius (strictly <= 48px check radius)
    // with 25ms frame-pacing to prevent Chromium input coalescing from collapsing events (guarantees >= 3 distinct pointermoves)
    const deltas = [
      { dx: -28, dy: -14 },
      { dx: -18, dy: -9 },
      { dx: -10, dy: -5 },
      { dx: -4, dy: -2 },
      { dx: 0, dy: 0 },
    ];
    for (const d of deltas) {
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(targetX + d.dx),
        y: Math.round(targetY + d.dy),
        modifiers: modifierMask,
      });
      await new Promise((r) => setTimeout(r, 25));
    }
    lastMousePosMap.set(tabId, { x: targetX, y: targetY });
    return;
  }

  const startPos = lastMousePosMap.get(tabId) || {
    x: Math.max(0, targetX - (15 + Math.floor(Math.random() * 20))),
    y: Math.max(0, targetY - (10 + Math.floor(Math.random() * 15))),
  };

  const steps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
  const points = computeHumanizedPoints(startPos.x, startPos.y, targetX, targetY, steps);
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: pt.x,
      y: pt.y,
      modifiers: modifierMask,
    });
    await new Promise((r) => setTimeout(r, 12 + Math.floor(Math.random() * 15)));
  }

  // Micro-approach steps within target's direct neighborhood (< 25px radius) to guarantee realistic pointer tracking (avoids NO_POINTER_PATH)
  const localDeltas = [
    { dx: -20, dy: -12 },
    { dx: -10, dy: -6 },
    { dx: -3, dy: -2 },
    { dx: 0, dy: 0 },
  ];
  for (const d of localDeltas) {
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(targetX + d.dx),
      y: Math.round(targetY + d.dy),
      modifiers: modifierMask,
    });
    await new Promise((r) => setTimeout(r, 15));
  }

  lastMousePosMap.set(tabId, { x: targetX, y: targetY });
}

/**
 * Convert modifiers array to Chrome DevTools Protocol Input.dispatchMouseEvent modifiers bitmask:
 * Alt = 1, Control/Ctrl = 2, Meta/Command = 4, Shift = 8
 */
function computeModifierMask(modifiers?: string[]): number {
  if (!modifiers || !Array.isArray(modifiers)) return 0;
  let mask = 0;
  for (const mod of modifiers) {
    const m = String(mod).toLowerCase().trim();
    if (m === 'alt') mask |= 1;
    else if (m === 'ctrl' || m === 'control') mask |= 2;
    else if (m === 'meta' || m === 'cmd' || m === 'command') mask |= 4;
    else if (m === 'shift') mask |= 8;
  }
  return mask;
}

export class InteractIndexTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.INTERACT_INDEX;

  async execute(args: InteractIndexParams, context?: ToolCallContext): Promise<ToolResult> {
    const signal = context?.signal;
    let actionDispatched = false;
    const action = args.action ?? 'click';
    const hasPath = action === 'drag' && Array.isArray(args.path) && args.path.length >= 2;
    const hasIndex = typeof args?.index === 'number' && args.index > 0;
    const hasPoints = Array.isArray(args?.points) && args.points.length > 0;
    const hasCoord = Boolean(
      (args?.coordinate &&
        typeof (args.coordinate as any).x === 'number' &&
        typeof (args.coordinate as any).y === 'number' &&
        !isNaN((args.coordinate as any).x) &&
        !isNaN((args.coordinate as any).y)) ||
      (args?.coordinate && parseUnifiedCoordinate(args.coordinate)),
    );
    const blockedError = (message: string, reason = 'invalid_arguments') =>
      createInteractionErrorResponse(
        message,
        makeInteractionOutcome('not_dispatched', 'not_requested', reason, 0),
        { status: 'blocked', requestDispatched: false },
      );
    const normalizeInteractionFailure = (result: ToolResult): ToolResult => {
      if (!result.isError) return result;
      const first = result.content?.[0];
      if (first?.type !== 'text' || typeof first.text !== 'string') return result;
      let payload: any;
      try {
        payload = JSON.parse(first.text);
      } catch {
        const executionStatus = actionDispatched ? 'unknown' : 'not_dispatched';
        const unknown = executionStatus === 'unknown';
        return {
          ...result,
          content: [
            {
              ...first,
              text: JSON.stringify({
                success: false,
                status: unknown ? 'unknown' : 'blocked',
                requestDispatched: unknown,
                retry: !unknown,
                error: first.text,
                interaction: makeInteractionOutcome(
                  executionStatus,
                  'not_requested',
                  first.text,
                  unknown ? 1 : 0,
                ),
              }),
            },
            ...result.content.slice(1),
          ],
        };
      }
      if (!payload || typeof payload !== 'object' || payload.interaction) return result;
      const explicitlyNotDispatched =
        payload.requestDispatched === false || payload.dispatched === false;
      const executionStatus =
        explicitlyNotDispatched || !actionDispatched ? 'not_dispatched' : 'unknown';
      const unknown = executionStatus === 'unknown';
      return {
        ...result,
        content: [
          {
            ...first,
            text: JSON.stringify({
              ...payload,
              status: payload.status ?? (unknown ? 'unknown' : 'blocked'),
              requestDispatched: payload.requestDispatched ?? unknown,
              retry: payload.retry ?? !unknown,
              interaction: makeInteractionOutcome(
                executionStatus,
                'not_requested',
                typeof payload.error === 'string' ? payload.error : undefined,
                unknown ? 1 : 0,
              ),
            }),
          },
          ...result.content.slice(1),
        ],
      };
    };

    if (args.captureId && args.expectedScreenshotId) {
      return blockedError(
        'captureId and expectedScreenshotId are distinct screenshot identities and cannot be combined. Use captureId for ordinary screenshot coordinates or expectedScreenshotId for a Jev vision-frame click.',
        'conflicting_capture_identity',
      );
    }
    if (args.captureId && !hasCoord && !hasPoints && !hasPath) {
      return blockedError(
        'captureId only supports screenshot coordinate actions (coordinate, points, or drag path); index/selector-only actions do not use screenshot coordinates.',
        'invalid_capture_target',
      );
    }

    if (hasPoints && action !== 'click') {
      return blockedError(
        'points is only supported for click sequences; use path or end for drag',
        'invalid_points_action',
      );
    }
    if (!hasIndex && !hasCoord && !hasPoints && !hasPath) {
      return blockedError(
        `Either index (positive 1-based integer) or coordinate ({ x: number, y: number }) must be provided for ${resolveToolName('interact_index')}`,
        'missing_target',
      );
    }

    const validActions = ['click', 'hover', 'double_click', 'right_click', 'drag'];
    if (!validActions.includes(action)) {
      return blockedError(
        `Unsupported action "${action}". Allowed actions: ${validActions.join(', ')}`,
        'unsupported_action',
      );
    }

    if (args.expectedScreenshotId) {
      if (action !== 'click') {
        return blockedError(
          `expectedScreenshotId only supports action="click", received "${action}"`,
          'invalid_screenshot_action',
        );
      }
      if (
        args.index !== undefined ||
        (args as any).selector !== undefined ||
        (args as any).ref !== undefined ||
        args.path !== undefined ||
        args.points !== undefined
      ) {
        return blockedError(
          'expectedScreenshotId only supports direct coordinate click (index/selector/ref/path/points are rejected)',
          'invalid_screenshot_target',
        );
      }
      if (!args.coordinate) {
        return blockedError(
          'expectedScreenshotId requires coordinate',
          'missing_screenshot_coordinate',
        );
      }
      if (
        typeof args.expectedDeadlineAt !== 'number' ||
        !Number.isFinite(args.expectedDeadlineAt)
      ) {
        return blockedError(
          'expectedDeadlineAt must be a finite number when expectedScreenshotId is provided',
          'invalid_screenshot_deadline',
        );
      }
      if (Date.now() >= args.expectedDeadlineAt) {
        return blockedError(
          `Interaction deadline expired before execution (now=${Date.now()}, deadline=${args.expectedDeadlineAt})`,
          'deadline_expired',
        );
      }
    }

    try {
      throwIfAborted(signal, 'before interact_index');
      // D3: snapshot BEFORE resolveAffinityTab — its active-tab fallback binds
      // the fallback tab, so post-resolution checks always pass (live-tested).
      const interactHadPreexistingBinding = sessionTabAffinity.hasBinding(
        args.sessionId || args.sessionContext,
      );
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      const tabId = tab.id;
      if (!tabId) {
        return blockedError(
          `No active tab found for ${resolveToolName('interact_index')}`,
          'no_active_tab',
        );
      }
      if (args.frameId !== undefined && (!Number.isSafeInteger(args.frameId) || args.frameId < 0)) {
        return blockedError('frameId must be a non-negative safe integer', 'invalid_frame_id');
      }

      // Declared outside runAction so the surrounding finally can cancel it on every
      // exit path: rejected visual clicks return before waitForHandover() runs.
      let handoverTracker: ReturnType<typeof sessionTabAffinity.startHandoverTracking> | null =
        null;
      const cancelHandoverTracker = () => {
        handoverTracker?.cancel();
        handoverTracker = null;
      };

      const runAction = async (): Promise<ToolResult> => {
        throwIfAborted(signal, 'before interact_index action');
        const previousUrl = tab.url || '';
        tabFaviconManager.markTabActive(tabId);

        const isScreenshotSpace =
          args.coordinateSpace === 'screenshot' ||
          Boolean(args.captureId) ||
          Boolean(args.expectedScreenshotId);
        let captureBindingValidated = false;
        const validateCaptureBinding = async (): Promise<string | undefined> => {
          const binding = await validateScreenshotCoordinateBinding({
            tabId,
            captureId: args.captureId,
            coordinateSpace: args.coordinateSpace,
            visionFrameId: args.expectedScreenshotId,
          });
          if (binding.error) return binding.error;
          captureBindingValidated = Boolean(binding.captureId);
          return undefined;
        };
        const assertCaptureBinding = async () => {
          const error = await validateCaptureBinding();
          if (error) throw new Error(error);
        };

        const initialBindingError = await validateCaptureBinding();
        if (initialBindingError) return createErrorResponse(initialBindingError);

        const preSignature = await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
          .then((r) => r?.[0]?.result)
          .catch(() => null);

        await ensureSnapshotBaseline(tabId, !args.expectedGuard && args.includeDelta !== false);

        // D3 (TESTING-NOTES #19): when no explicit tabId/session bound the
        // target, resolveAffinityTab fell through to the user's ACTIVE tab -
        // input silently landed on whatever page the user was viewing. Surface
        // that fallback in the response so the agent can correct with an
        // explicit tabId. Non-blocking for backward compatibility.
        const explicitOrBound = typeof args.tabId === 'number' || interactHadPreexistingBinding;
        const affinityWarning = explicitOrBound
          ? undefined
          : `input routed to active tab (tabId=${tabId}); pass explicit tabId to target another tab`;

        let visionFrame: VisionFrameContext | undefined;
        if (args.expectedScreenshotId) {
          const scrollRes = await executeInPage({ tabId }, 'inPageGetScrollState', []).catch(
            () => null,
          );
          const scrollState = scrollRes?.[0]?.result;
          const currentDocId = scrollRes?.[0]?.documentId || scrollState?.documentId;
          const currentUrl = scrollState?.documentURL || tab.url || '';

          const currentPerceptiveSignature = await executeInPage(
            { tabId },
            'inPageDetectPerceptiveSignature',
            [],
          )
            .then((r) => r?.[0]?.result)
            .catch(() => null);

          const validation = validateVisionFrame({
            expectedScreenshotId: args.expectedScreenshotId,
            currentTabId: tabId,
            currentUrl,
            currentDocumentId: currentDocId,
            currentScroll: scrollState
              ? { scrollX: scrollState.scrollX, scrollY: scrollState.scrollY }
              : undefined,
            currentViewport: scrollState
              ? {
                  viewportWidth: scrollState.viewportWidth,
                  viewportHeight: scrollState.viewportHeight,
                }
              : undefined,
            currentPerceptiveSignature,
          });

          if (!validation.valid || !validation.frame) {
            return createErrorResponse(
              validation.error || 'Vision frame validation failed: frame is stale or invalid',
            );
          }
          visionFrame = validation.frame;
        }

        let screenshotCtx: any;
        if (isScreenshotSpace && !visionFrame) {
          screenshotCtx = screenshotContextManager.getContext(tabId);
          if (!screenshotCtx) {
            return createErrorResponse(
              'Screenshot context expired or not found. Capture a screenshot before using coordinateSpace: "screenshot".',
            );
          }
          if (tab.url) {
            const originErr = screenshotOriginViolation(tabId, tab.url, action);
            if (originErr) return createErrorResponse(originErr);
          }
        }

        let lastCoordinateError: string | undefined;

        // Helper to project screenshot-space or polymorphic coordinates to viewport space
        const projectCoord = (
          c: any,
        ): { x: number; y: number; isDocumentSpace?: boolean } | null => {
          if (!c) return null;
          if (visionFrame) {
            const rawParsed = parseUnifiedCoordinate(c, {
              viewportWidth: visionFrame.width,
              viewportHeight: visionFrame.height,
              originX: 0,
              originY: 0,
            });
            if (!rawParsed) return null;
            const scaled = scaleVisionFrameCoordinates(rawParsed.x, rawParsed.y, visionFrame);
            if ('error' in scaled) {
              lastCoordinateError = scaled.error;
              return null;
            }
            return { x: scaled.x, y: scaled.y };
          }
          if (isScreenshotSpace && screenshotCtx) {
            const rawParsed = parseUnifiedCoordinate(c, {
              viewportWidth: screenshotCtx.screenshotWidth,
              viewportHeight: screenshotCtx.screenshotHeight,
              originX: 0,
              originY: 0,
            });
            if (!rawParsed) return null;
            const scaled = scaleCoordinates(rawParsed.x, rawParsed.y, screenshotCtx);
            return { x: scaled.x, y: scaled.y, isDocumentSpace: scaled.isDocumentSpace };
          }
          // Viewport coordinates use CSS dimensions without screenshot scaling or crop offsets.
          const ctx = screenshotContextManager.getContext(tabId);
          const parsed = parseUnifiedCoordinate(c, {
            viewportWidth: ctx?.viewportWidth,
            viewportHeight: ctx?.viewportHeight,
          });
          if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            return parsed;
          }
          return { x: Math.round(c?.x ?? 0), y: Math.round(c?.y ?? 0) };
        };

        const alignVisualCoordinate = async (coord: {
          x: number;
          y: number;
          isDocumentSpace?: boolean;
        }): Promise<{ x: number; y: number }> => {
          let cx = coord.x;
          let cy = coord.y;

          const scrollState = (
            await executeInPage({ tabId }, 'inPageGetScrollState', []).catch(() => null)
          )?.[0]?.result ?? {
            scrollX: 0,
            scrollY: 0,
            viewportWidth: 1280,
            viewportHeight: 800,
          };

          const ctx = isScreenshotSpace
            ? (visionFrame ?? screenshotContextManager.getContext(tabId))
            : undefined;
          const isDoc = Boolean(coord.isDocumentSpace || ctx?.captureMode === 'fullpage');

          const baseScrollX = ctx?.scrollX ?? scrollState.scrollX;
          const baseScrollY = ctx?.scrollY ?? scrollState.scrollY;

          // Convert target to document-space coordinates
          const docX = isDoc ? cx : baseScrollX + cx;
          const docY = isDoc ? cy : baseScrollY + cy;

          const vh = scrollState.viewportHeight;
          const vw = scrollState.viewportWidth;

          // If target document point has scrolled out of view or is outside the current viewport,
          // instantly scroll to center it in the viewport rather than clamping to viewport edge (0,0)
          const isOutsideVp =
            docY < scrollState.scrollY ||
            docY > scrollState.scrollY + vh ||
            docX < scrollState.scrollX ||
            docX > scrollState.scrollX + vw;

          if (isOutsideVp) {
            const targetY = Math.max(0, Math.round(docY - vh / 2));
            const targetX = Math.max(0, Math.round(docX - vw / 2));
            await executeInPage({ tabId }, 'inPageInstantScrollTo', [targetX, targetY]).catch(
              () => null,
            );
            scrollState.scrollX = targetX;
            scrollState.scrollY = targetY;
          }

          cx = docX - scrollState.scrollX;
          cy = docY - scrollState.scrollY;

          // Clamp to active viewport boundary
          cx = Math.max(0, Math.min(scrollState.viewportWidth - 1, cx));
          cy = Math.max(0, Math.min(scrollState.viewportHeight - 1, cy));
          return { x: cx, y: cy };
        };

        // D1: arm one-shot delivery probe BEFORE dispatch (TESTING-NOTES #27).
        // Hidden-tab throttling acks CDP commands but drops the events; the
        // probe records whether any trusted event actually reached the page.
        let probeArmed = false;
        const armProbe = async (scope?: any) => {
          try {
            await executeInPage(scope ?? { tabId }, 'inPageArmDeliveryProbe', [
              action === 'click' || action === 'double_click' || action === 'right_click'
                ? ['mousedown', 'mouseup', 'click']
                : action === 'drag'
                  ? ['mousedown', 'mousemove', 'mouseup']
                  : ['mousemove', 'mouseover'],
            ]);
            probeArmed = true;
          } catch {
            // Restricted page / renderer gone: dispatch below will error anyway.
          }
        };

        // Start Child Tab Affinity Handover tracking for click actions
        const isClickAction = action === 'click' || action === 'double_click';
        handoverTracker =
          isClickAction || hasPoints
            ? sessionTabAffinity.startHandoverTracking(
                tabId,
                args.sessionId || args.sessionContext,
                { windowId: args.windowId },
              )
            : null;

        // Click sequence: CDP-dispatch a rapid burst of full clicks at the given
        // viewport points. One MCP round-trip, page-side interval down to ~35ms —
        // the only way to hit fast-moving canvas targets (rAF-animated hitboxes).
        if (hasPoints) {
          await armProbe();
          const interval = Math.min(500, Math.max(5, args.intervalMs ?? 35));
          const scaledPoints: Array<{ x: number; y: number }> = [];
          for (const rawPt of args.points || []) {
            const proj = projectCoord(rawPt);
            if (!proj) {
              if (lastCoordinateError) return createErrorResponse(lastCoordinateError);
              return createErrorResponse('Failed to parse point coordinates in points array');
            }
            const aligned = await alignVisualCoordinate(proj);
            scaledPoints.push(aligned);
          }
          let dispatched = 0;
          const shouldLockScroll = !args.captureId;
          if (shouldLockScroll) {
            await executeInPage({ tabId }, 'inPageLockScroll', [true]).catch(() => {});
          }
          try {
            await cdpSessionManager.withSession(tabId, 'interact-index', async () => {
              await assertCaptureBinding();
              for (const pt of scaledPoints) {
                throwIfAborted(signal, 'before sequence click press');
                await assertCaptureBinding();
                await dispatchMousePressRelease(
                  (params) => raceCdp(tabId, 'Input.dispatchMouseEvent', params),
                  {
                    type: 'mousePressed',
                    x: pt.x,
                    y: pt.y,
                    button: 'left',
                    buttons: 1,
                    clickCount: 1,
                  },
                );
                dispatched++;
                if (dispatched < scaledPoints.length) {
                  await new Promise((r) => setTimeout(r, interval));
                }
              }
            });
            lastMousePosMap.set(tabId, { x: scaledPoints.at(-1)!.x, y: scaledPoints.at(-1)!.y });
          } catch (burstErr) {
            if (burstErr instanceof DialogOpenedError) {
              return createDialogInterruptResponse(burstErr);
            }
            return createErrorResponse(
              `click_sequence failed after ${dispatched} points: ${burstErr instanceof Error ? burstErr.message : String(burstErr)}`,
            );
          } finally {
            if (shouldLockScroll) {
              await executeInPage({ tabId }, 'inPageLockScroll', [false]).catch(() => {});
            }
          }
          // D1: read back the delivery probe before returning. click_sequence is
          // a native-CDP path, so delivered=false here means throttling ate the
          // burst (TESTING-NOTES #27).
          let burstDelivery: Record<string, unknown> = {};
          if (probeArmed) {
            try {
              const probe = (await executeInPage({ tabId }, 'inPageReadDeliveryProbe', [true]))?.[0]
                ?.result;
              burstDelivery = probe?.delivered
                ? { deliveryVerified: true }
                : { deliveryVerified: false, deliveryHits: probe?.hits ?? [] };
            } catch {
              burstDelivery = {};
            }
          }
          const tabHandover = handoverTracker ? await handoverTracker.waitForHandover(800) : null;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    success: true,
                    interaction: makeInteractionOutcome(
                      'dispatched',
                      'not_requested',
                      undefined,
                      dispatched,
                    ),
                    action: 'click_sequence',
                    pointsDispatched: dispatched,
                    coordinates: scaledPoints,
                    ...(tabHandover ? { tabHandover } : {}),
                    ...(affinityWarning ? { affinityWarning } : {}),
                    ...burstDelivery,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: false,
          };
        }

        // 1. Locate element coordinates inside the tab (DOM index vs pure visual coordinate)
        let x: number;
        let y: number;
        let tagName: string | undefined;
        let text: string | undefined;
        let targetFrameId: number | undefined;
        let coordResult: any = undefined;
        let isFallback = false;
        let isSelectOptionInteracted = false;
        let usedNativeCDP = false;
        let coordWarning: string | undefined = undefined;
        let dragStartProjection: { x: number; y: number; isDocumentSpace?: boolean } | undefined;
        let dragPoints: Array<{ x: number; y: number }> | undefined;

        if (hasPath || (hasCoord && !hasIndex)) {
          const projected = projectCoord(hasPath ? args.path![0] : args.coordinate!);
          if (!projected) {
            return createErrorResponse(lastCoordinateError || 'Failed to parse coordinate');
          }
          if (action === 'drag') dragStartProjection = projected;
          const aligned = action === 'drag' ? projected : await alignVisualCoordinate(projected);
          x = aligned.x;
          y = aligned.y;
          tagName = 'visual_target';
          text = undefined;
          targetFrameId = 0;
          if (args.autoSnap !== false && action !== 'drag') {
            try {
              const snap = (await executeInPage({ tabId }, 'inPageSnapCoordinate', [x, y, 24]))?.[0]
                ?.result;
              if (snap?.snapped) {
                x = snap.x;
                y = snap.y;
                if (snap.targetTag) tagName = `visual_target_snapped_${snap.targetTag}`;
              }
            } catch {}
          }
        } else {
          const frameScopedTarget =
            args.frameId === undefined ? { tabId } : { tabId, frameIds: [args.frameId] };
          coordResult = (
            await executeInPage(frameScopedTarget, 'inPageWaitForActionable', [args.index!, action])
          )?.[0]?.result;

          // Check subframes if not in main frame
          if (coordResult?.notFound === false && !coordResult.success) {
            return createErrorResponse(coordResult.error || 'Target is not actionable');
          }
          if ((!coordResult || !coordResult.success) && args.frameId === undefined) {
            const frameResults = await executeInPage(
              { tabId, allFrames: true },
              'inPageWaitForActionable',
              [args.index!, action],
            );
            const match = frameResults.find(
              (r) => r.result?.success || r.result?.notFound === false,
            );
            if (match?.result) {
              coordResult = match.result;
              targetFrameId = match.frameId;
            }
          }

          // [ACT-01] Stagehand-inspired Self-Healing Retry:
          // If the element index was momentarily detached due to dynamic framework rerendering,
          // perform a micro quiet-wait and retry coordinate resolution once before giving up.
          if (coordResult?.notFound === false && !coordResult.success) {
            return createErrorResponse(coordResult.error || 'Target is not actionable');
          }
          if (!coordResult || !coordResult.success) {
            await new Promise((r) => setTimeout(r, 120));
            coordResult = (
              await executeInPage(frameScopedTarget, 'inPageWaitForActionable', [
                args.index!,
                action,
              ])
            )?.[0]?.result;
            if (
              (!coordResult || !coordResult.success) &&
              coordResult?.notFound !== false &&
              args.frameId === undefined
            ) {
              const frameResults = await executeInPage(
                { tabId, allFrames: true },
                'inPageWaitForActionable',
                [args.index!, action],
              );
              const match = frameResults.find(
                (r) => r.result?.success || r.result?.notFound === false,
              );
              if (match?.result) {
                coordResult = match.result;
                targetFrameId = match.frameId;
              }
            }
          }

          if (coordResult?.notFound === false && !coordResult.success) {
            return createErrorResponse(coordResult.error || 'Target is not actionable');
          }
          if (!coordResult || !coordResult.success) {
            if (hasCoord) {
              // Hybrid Visual Fallback: DOM extraction failed, fallback to coordinate
              const projected = projectCoord(args.coordinate!);
              if (!projected) {
                return createErrorResponse(
                  lastCoordinateError || 'Failed to parse visual fallback coordinate',
                );
              }
              if (action === 'drag') dragStartProjection = projected;
              const aligned =
                action === 'drag' ? projected : await alignVisualCoordinate(projected);
              x = aligned.x;
              y = aligned.y;
              tagName = 'visual_fallback';
              targetFrameId = 0;
              isFallback = true;
              if (args.autoSnap !== false && action !== 'drag') {
                try {
                  const snap = (
                    await executeInPage({ tabId }, 'inPageSnapCoordinate', [x, y, 24])
                  )?.[0]?.result;
                  if (snap?.snapped) {
                    x = snap.x;
                    y = snap.y;
                    if (snap.targetTag) tagName = `visual_fallback_snapped_${snap.targetTag}`;
                  }
                } catch {}
              }
            } else {
              return createErrorResponse(
                (coordResult?.error ||
                  `Element with index [${args.index}] not found in active DOM index map`) +
                  `. Hint: Element may reside inside a dynamic or closed ShadowRoot. Try calling ${resolveToolName('javascript')} to inspect or dispatch, or re-scan with ${resolveToolName('read_dom')}.`,
              );
            }
          } else {
            x = coordResult.x!;
            y = coordResult.y!;
            if (args.frameId !== undefined) {
              targetFrameId = args.frameId;
            }
            tagName = coordResult.tagName;
            text = coordResult.text;
            if (coordResult.warning) {
              coordWarning = coordResult.warning;
            }
            if (coordResult.isSelectOption && (action === 'click' || !action)) {
              await assertObservedTarget(tabId, args.index, targetFrameId, args.expectedGuard);
              throwIfAborted(signal, 'before observed option selection');
              const selectRes = (
                await executeInPage(
                  targetFrameId ? { tabId, frameIds: [targetFrameId] } : { tabId },
                  'inPageInteractIndex',
                  [args.index!, 'click'],
                )
              )?.[0]?.result;
              if (selectRes?.success) {
                isSelectOptionInteracted = true;
                usedNativeCDP = false;
              }
            }
          }
        }

        if (typeof x !== 'number' || typeof y !== 'number') {
          return createErrorResponse(`Failed to resolve valid pixel coordinates for interaction`);
        }

        const localPoint = {
          x: x - (coordResult?.frameOffsetX || 0),
          y: y - (coordResult?.frameOffsetY || 0),
        };
        if (targetFrameId && !isFallback && !coordResult?.isFrameCompensated) {
          ({ x, y } = await projectFramePoint(tabId, targetFrameId, localPoint));
        }

        if (action === 'drag') {
          const readScrollState = async () => {
            const state = (await executeInPage({ tabId }, 'inPageGetScrollState', []))?.[0]?.result;
            if (
              !state ||
              ![state.scrollX, state.scrollY, state.viewportWidth, state.viewportHeight].every(
                Number.isFinite,
              ) ||
              state.viewportWidth <= 0 ||
              state.viewportHeight <= 0
            ) {
              throw new Error('Failed to read viewport geometry for drag');
            }
            return state;
          };
          let state = await readScrollState();
          const toDocument = (
            point: { x: number; y: number; isDocumentSpace?: boolean },
            fromScreenshot: boolean,
          ) => ({
            x: point.isDocumentSpace
              ? point.x
              : point.x +
                (fromScreenshot ? (screenshotCtx?.scrollX ?? state.scrollX) : state.scrollX),
            y: point.isDocumentSpace
              ? point.y
              : point.y +
                (fromScreenshot ? (screenshotCtx?.scrollY ?? state.scrollY) : state.scrollY),
          });
          const documentPoints = hasPath
            ? args.path!.map((point) => {
                const projected = projectCoord(point);
                if (!projected && lastCoordinateError) throw new Error(lastCoordinateError);
                if (!projected) throw new Error('Failed to parse drag path coordinate');
                return toDocument(projected, isScreenshotSpace);
              })
            : [
                toDocument(
                  dragStartProjection ?? { x, y },
                  Boolean(dragStartProjection) && isScreenshotSpace,
                ),
              ];
          if (!hasPath) {
            const indexedEnd = typeof args.end?.index === 'number' && args.end.index > 0;
            const end = indexedEnd
              ? await resolveDragEndPoint(tabId, args.end, args.frameId)
              : projectCoord(args.end?.coordinate);
            if (args.end?.coordinate && !end && lastCoordinateError) {
              return createErrorResponse(lastCoordinateError);
            }
            if (!end)
              return createErrorResponse(
                'drag requires end.index, end.coordinate, or a path with at least two points',
              );
            // Resolving a live DOM index can scroll the page; its viewport origin is current.
            if (indexedEnd) state = await readScrollState();
            documentPoints.push(toDocument(end, !indexedEnd && isScreenshotSpace));
          }
          if (
            documentPoints.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
          ) {
            return createErrorResponse('Drag coordinates must be finite');
          }
          const vw = state.viewportWidth;
          const vh = state.viewportHeight;
          const minX = Math.min(...documentPoints.map((point) => point.x));
          const maxX = Math.max(...documentPoints.map((point) => point.x));
          const minY = Math.min(...documentPoints.map((point) => point.y));
          const maxY = Math.max(...documentPoints.map((point) => point.y));
          const lowerX = Math.max(0, maxX - vw + 1);
          const lowerY = Math.max(0, maxY - vh + 1);
          if (lowerX > minX || lowerY > minY) {
            return createErrorResponse(
              `Drag coordinates cannot fit simultaneously within viewport (${vw}x${vh})`,
            );
          }
          const targetX =
            state.scrollX < lowerX || state.scrollX > minX
              ? Math.round(Math.max(lowerX, Math.min(minX, (minX + maxX - vw) / 2)))
              : state.scrollX;
          const targetY =
            state.scrollY < lowerY || state.scrollY > minY
              ? Math.round(Math.max(lowerY, Math.min(minY, (minY + maxY - vh) / 2)))
              : state.scrollY;
          if (targetX !== state.scrollX || targetY !== state.scrollY) {
            const outcome = (
              await executeInPage({ tabId }, 'inPageInstantScrollTo', [targetX, targetY]).catch(
                () => null,
              )
            )?.[0]?.result;
            if (
              !outcome?.success ||
              !Number.isFinite(outcome.scrollX) ||
              !Number.isFinite(outcome.scrollY)
            ) {
              return createErrorResponse('Failed to scroll page to align drag coordinates');
            }
            state.scrollX = outcome.scrollX;
            state.scrollY = outcome.scrollY;
          }
          const inViewport = (point: { x: number; y: number }) =>
            point.x >= 0 && point.x < vw && point.y >= 0 && point.y < vh;
          dragPoints = documentPoints.map((point) => ({
            x: Math.round(point.x - state.scrollX),
            y: Math.round(point.y - state.scrollY),
          }));
          if (!dragPoints.every(inViewport)) {
            return createErrorResponse(
              'Drag coordinates are outside viewport boundaries after scrolling',
            );
          }
          [x, y] = [dragPoints[0].x, dragPoints[0].y];
          // An explicit path owns its geometry; magnetic snapping must not distort it.
          if (!hasPath && dragStartProjection && args.autoSnap !== false) {
            const snap = (
              await executeInPage({ tabId }, 'inPageSnapCoordinate', [x, y, 24]).catch(() => null)
            )?.[0]?.result;
            if (snap?.snapped) {
              const afterSnap = await readScrollState();
              dragPoints = documentPoints.map((point) => ({
                x: Math.round(point.x - afterSnap.scrollX),
                y: Math.round(point.y - afterSnap.scrollY),
              }));
              dragPoints[0] = { x: snap.x, y: snap.y };
              if (
                !dragPoints.every(
                  (point) =>
                    Number.isFinite(point.x) && Number.isFinite(point.y) && inViewport(point),
                )
              ) {
                return createErrorResponse(
                  'Drag coordinates are outside viewport boundaries after snapping',
                );
              }
              [x, y] = [snap.x, snap.y];
            }
          }
        }

        const targetScope =
          targetFrameId !== undefined && targetFrameId !== 0 && !isFallback
            ? { tabId, frameIds: [targetFrameId] }
            : { tabId };

        // Animate virtual agent cursor to target position before physical interaction
        const actName = String(action);
        const actNote =
          (args as any).note ||
          (args as any).actionNote ||
          formatAgentCursorAction(actName, {
            text,
            tagName,
            role: coordResult?.role,
            inputType: coordResult?.inputType,
            attributes: coordResult?.attributes,
          });
        await animateAgentCursor(tabId, x, y, {
          waitForArrival: true,
          timeoutMs: 350,
          actionNote: actNote,
        });

        // Start inline network capture if requested
        const netCapture = startActionNetworkCapture(tabId, args.captureNetwork);

        // Shadow DOM penetrating interception check (self-healing feedback)
        let maskPierced: { description: string; reason: string } | undefined;
        if (args.index !== undefined && !isFallback && action === 'click') {
          try {
            const interceptRes = (
              await executeInPage(targetScope, 'inPageCheckInterception', [
                args.index,
                localPoint.x,
                localPoint.y,
              ])
            )?.[0]?.result;
            if (interceptRes?.intercepted && interceptRes?.description) {
              if (interceptRes.canPierce && args.pierceOverlay !== false) {
                maskPierced = {
                  description: interceptRes.description,
                  reason: interceptRes.pierceReason || 'transient_mask',
                };
              } else {
                netCapture.dispose();
                return createTargetOccludedResponse(
                  new StalePageError(
                    `Element [${args.index}] click intercepted by ${interceptRes.description}. Please dismiss or interact with the overlay/dialog first. Hint: If this is an open modal, interact with its buttons to dismiss. If it is a captcha or human verification, call ${resolveToolName('request_human_intervention')}.`,
                  ),
                );
              }
            }
          } catch {
            // Non-blocking on inspection failure
          }
        }

        const modifierMask = computeModifierMask(args.modifiers);
        const clickButton = args.button ?? 'left';
        const clickButtons = clickButton === 'right' ? 2 : clickButton === 'middle' ? 4 : 1;
        usedNativeCDP = false;
        let dragOutcome: any = undefined;
        if (action === 'drag') {
          dragOutcome = { dragIntercepted: false, dndDispatched: false };
          const endPoint = dragPoints![dragPoints!.length - 1];
          await cdpSessionManager.withSession(tabId, 'interact-index-drag', async () => {
            await assertCaptureBinding();
            const enableDnd = args.dnd !== false;
            const dragSteps = Math.max(2, Math.min(120, args.steps ?? 48));
            const holdMs = Math.max(0, Math.min(1000, args.holdMs ?? 80));
            if (enableDnd) {
              await cdpSessionManager.sendCommand(tabId, 'Input.setInterceptDrags', {
                enabled: true,
              });
            }
            let dragData: any = null;
            const observer: CdpEventObserver = (tid, method, params) => {
              if (tid === tabId && method === 'Input.dragIntercepted') {
                dragData = (params as any)?.data ?? null;
              }
            };
            cdpSessionManager.addCdpEventObserver(observer);
            // A failed drag must never leave the left button down on the page.
            const dragMouseGuard = createMousePressGuard(
              (params) => raceCdp(tabId, 'Input.dispatchMouseEvent', params),
              {
                type: 'mouseReleased',
                x: endPoint.x,
                y: endPoint.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
                modifiers: modifierMask,
              },
            );
            try {
              const startX = x;
              const startY = y;

              await dispatchMouseMovement(tabId, startX, startY, modifierMask, false);
              const dragPrePress = Math.max(
                0,
                Math.min(300, (args as any).prePressDelayMs ?? (args.humanize === true ? 80 : 0)),
              );
              if (dragPrePress > 0) {
                await new Promise((r) => setTimeout(r, dragPrePress));
              }

              throwIfAborted(signal, 'before drag mousePressed');
              await dragMouseGuard.press({
                type: 'mousePressed',
                x: startX,
                y: startY,
                button: 'left',
                buttons: 1,
                clickCount: 1,
                modifiers: modifierMask,
              });
              if (holdMs > 0) {
                await waitWithAbort(holdMs, signal, 'during drag hold');
              }

              // Concurrently animate virtual cursor to drag destination during physical drag
              const dragCursorArrivalPromise = animateAgentCursor(tabId, endPoint.x, endPoint.y, {
                immediate: false,
                waitForArrival: true,
                timeoutMs: 350,
                actionNote: actNote,
              });

              if (hasPath) {
                for (let pi = 1; pi < dragPoints!.length && !dragData; pi++) {
                  throwIfAborted(signal, 'during drag step');
                  const pt = dragPoints![pi];
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: Math.round(pt.x),
                    y: Math.round(pt.y),
                    button: 'left',
                    buttons: 1,
                    modifiers: modifierMask,
                  }).catch((err) => {
                    if (dragData && isCdpOutcomeUncertainError(err)) return;
                    throw err;
                  });
                  await new Promise((r) => setTimeout(r, 16));
                }
              } else {
                // D2 fix (TESTING-NOTES #43): after dragIntercepted fires, Chrome
                // stops acking Input.dispatchMouseEvent entirely - the old loop
                // kept blind-sending mouseMoved and hung 30s+. Bail out of the
                // move loop the moment interception is observed; dispatchDragEvent
                // below completes the HTML5 drag without any further input acks.
                let dragIntercepted = false;
                for (let i = 1; i <= dragSteps && !dragIntercepted; i++) {
                  throwIfAborted(signal, 'during drag step');
                  const curX = Math.round(startX + (endPoint.x - startX) * (i / dragSteps));
                  const curY = Math.round(startY + (endPoint.y - startY) * (i / dragSteps));
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: curX,
                    y: curY,
                    button: 'left',
                    buttons: 1,
                    modifiers: modifierMask,
                  }).catch((err) => {
                    if (isCdpOutcomeUncertainError(err)) {
                      dragIntercepted = true;
                      return undefined;
                    }
                    throw err;
                  });
                  if (!dragIntercepted) {
                    dragIntercepted = Boolean(dragData);
                  }
                  await new Promise((r) => setTimeout(r, 12));
                }
              }
              if (enableDnd) {
                const deadline = Date.now() + 300;
                while (!dragData && Date.now() < deadline) {
                  await new Promise((r) => setTimeout(r, 25));
                }
              }
              if (dragData) {
                await cdpSessionManager.sendCommand(tabId, 'Input.dispatchDragEvent', {
                  type: 'dragEnter',
                  x: endPoint.x,
                  y: endPoint.y,
                  data: dragData,
                  modifiers: modifierMask,
                });
                await cdpSessionManager.sendCommand(tabId, 'Input.dispatchDragEvent', {
                  type: 'dragOver',
                  x: endPoint.x,
                  y: endPoint.y,
                  data: dragData,
                  modifiers: modifierMask,
                });
                await cdpSessionManager.sendCommand(tabId, 'Input.dispatchDragEvent', {
                  type: 'drop',
                  x: endPoint.x,
                  y: endPoint.y,
                  data: dragData,
                  modifiers: modifierMask,
                });
                dragOutcome.dndDispatched = true;
              }
              // Wait for concurrent visual cursor drag arrival before releasing
              await dragCursorArrivalPromise;
              dragOutcome.dragIntercepted = Boolean(dragData);
              dragOutcome.dragSteps = hasPath ? dragPoints!.length - 1 : dragSteps;
              // CDP-synthetic pointer drags: deliver one final pointermove to
              // the element under the press point, because hit-tested moves
              // stop reaching narrow targets (resize handles, sliders) once
              // the cursor outruns them. HTML5 drags skip this: they consume
              // dragIntercepted data instead of pointermove.
              if (!dragData && !hasPath) {
                try {
                  const pmResult = (
                    await executeInPage({ tabId }, 'inPagePointerDragMove', [
                      x,
                      y,
                      endPoint.x,
                      endPoint.y,
                    ])
                  )?.[0]?.result;
                  dragOutcome.pointerMove = pmResult ?? null;
                } catch (pmErr) {
                  dragOutcome.pointerMove = {
                    error: String(pmErr instanceof Error ? pmErr.message : pmErr),
                  };
                }
              }
              await dragMouseGuard.release({
                type: 'mouseReleased',
                x: endPoint.x,
                y: endPoint.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
                modifiers: modifierMask,
              });
              lastMousePosMap.set(tabId, { x: endPoint.x, y: endPoint.y });
            } finally {
              cdpSessionManager.removeCdpEventObserver(observer);
              await dragMouseGuard.compensate();
              if (enableDnd) {
                try {
                  await cdpSessionManager.sendCommand(tabId, 'Input.setInterceptDrags', {
                    enabled: false,
                  });
                } catch {}
              }
            }
          });
          usedNativeCDP = true;
        } else if (isSelectOptionInteracted) {
          // Task B4: Direct in-page select option interaction complete, skip CDP mouse dispatch
        } else {
          // Primary path: Native CDP Mouse Event Dispatch (isTrusted=true)
          try {
            // Phase M1: 1ms Instantaneous Occlusion Circuit Breaker
            if (args.index !== undefined && !isFallback && action !== 'hover') {
              const occResult = (
                await executeInPage(targetScope, 'inPageCheckOcclusion', [
                  { node: args.index, kind: action },
                ])
              )?.[0];

              if (occResult && !occResult.result) {
                throw new StalePageError(
                  `Element [${args.index}] is occluded by an overlay, out of viewport, or detached from DOM.`,
                );
              }
              const occRes = occResult?.result;
              if (occRes && typeof occRes.x === 'number' && typeof occRes.y === 'number') {
                let targetX = occRes.x;
                let targetY = occRes.y;
                if (targetFrameId !== undefined && targetFrameId !== 0 && !isFallback) {
                  ({ x: targetX, y: targetY } = await projectFramePoint(tabId, targetFrameId, {
                    x: targetX,
                    y: targetY,
                  }));
                }
                if (x !== targetX || y !== targetY) {
                  x = targetX;
                  y = targetY;
                  await animateAgentCursor(tabId, x, y, {
                    waitForArrival: true,
                    timeoutMs: 350,
                    immediate: false,
                  });
                }
              }
            }

            await armProbe(targetScope);
            const shouldLockScroll = !args.captureId;
            if (shouldLockScroll) {
              await executeInPage({ tabId }, 'inPageLockScroll', [true]).catch(() => {});
            }
            try {
              await cdpSessionManager.withSession(tabId, 'interact-index', async () => {
                await assertCaptureBinding();
                // Always dispatch mouse movement to target coordinates before pressing (ensures authentic pointer path)
                await dispatchMouseMovement(tabId, x, y, modifierMask, args.humanize === true);

                if (action === 'click') {
                  const clickPrePress = Math.max(
                    0,
                    Math.min(
                      300,
                      (args as any).prePressDelayMs ?? (args.humanize === true ? 80 : 0),
                    ),
                  );
                  if (clickPrePress > 0) {
                    await new Promise((r) => setTimeout(r, clickPrePress));
                  }

                  let physicalPressDispatched = false;
                  const clickGuard = createMousePressGuard(
                    async (params) => {
                      if (params.type === 'mousePressed') {
                        throwIfAborted(signal, 'before mousePressed');
                        await assertObservedTarget(
                          tabId,
                          args.index,
                          targetFrameId,
                          args.expectedGuard,
                        );
                        throwIfAborted(signal, 'after observed target validation');
                        if (visionFrame) {
                          // Check deadline immediately before press
                          if (
                            typeof args.expectedDeadlineAt === 'number' &&
                            Date.now() >= args.expectedDeadlineAt
                          ) {
                            throw new Error(
                              `Interaction deadline expired before physical press (now=${Date.now()}, deadline=${args.expectedDeadlineAt})`,
                            );
                          }

                          // Re-probe fresh page state after movement/prepress
                          const freshScrollRes = await executeInPage(
                            { tabId },
                            'inPageGetScrollState',
                            [],
                          ).catch(() => null);
                          const freshScroll = freshScrollRes?.[0]?.result;
                          const freshDocId =
                            freshScrollRes?.[0]?.documentId || freshScroll?.documentId;
                          const freshUrl = freshScroll?.documentURL || tab.url || '';

                          const freshSigRes = await executeInPage(
                            { tabId },
                            'inPageDetectPerceptiveSignature',
                            [],
                          ).catch(() => null);
                          const freshSig = freshSigRes?.[0]?.result;

                          const validation = validateVisionFrame({
                            expectedScreenshotId: visionFrame.id,
                            currentTabId: tabId,
                            currentUrl: freshUrl,
                            currentDocumentId: freshDocId,
                            currentScroll: freshScroll
                              ? { scrollX: freshScroll.scrollX, scrollY: freshScroll.scrollY }
                              : undefined,
                            currentViewport: freshScroll
                              ? {
                                  viewportWidth: freshScroll.viewportWidth,
                                  viewportHeight: freshScroll.viewportHeight,
                                }
                              : undefined,
                            currentPerceptiveSignature: freshSig,
                          });

                          if (!validation.valid) {
                            throw new Error(
                              validation.error ||
                                'Vision frame validation failed right before mouse press',
                            );
                          }

                          // Re-check deadline after probe
                          if (
                            typeof args.expectedDeadlineAt === 'number' &&
                            Date.now() >= args.expectedDeadlineAt
                          ) {
                            throw new Error(
                              `Interaction deadline expired after validation probe (now=${Date.now()}, deadline=${args.expectedDeadlineAt})`,
                            );
                          }

                          // Atomic consume before dispatch
                          const consumed = screenshotContextManager.consumeVisionFrame(
                            visionFrame.id,
                          );
                          if (!consumed) {
                            throw new Error(
                              `Vision frame "${visionFrame.id}" could not be consumed (already consumed, superseded, or expired)`,
                            );
                          }
                        } else if (args.captureId) {
                          await assertCaptureBinding();
                        }

                        physicalPressDispatched = true;
                        actionDispatched = true;
                        return raceCdp(tabId, 'Input.dispatchMouseEvent', params);
                      }

                      if (params.type === 'mouseReleased') {
                        // Suppress compensating mouseReleased if mousePressed was never dispatched
                        if (
                          (visionFrame || args.captureId || args.expectedGuard !== undefined) &&
                          !physicalPressDispatched
                        ) {
                          return;
                        }
                        return raceCdp(tabId, 'Input.dispatchMouseEvent', params);
                      }

                      return raceCdp(tabId, 'Input.dispatchMouseEvent', params);
                    },
                    {
                      type: 'mouseReleased',
                      x,
                      y,
                      button: clickButton,
                      buttons: 0,
                      clickCount: 1,
                      modifiers: modifierMask,
                    },
                  );
                  try {
                    await clickGuard.press({
                      type: 'mousePressed',
                      x,
                      y,
                      button: clickButton,
                      buttons: clickButtons,
                      clickCount: 1,
                      modifiers: modifierMask,
                    });
                    // Animate cursor ONLY after successful press
                    await animateAgentCursorClick(tabId, x, y, actNote);
                    const clickHoldMs = Math.max(35, Math.min(3000, args.holdMs ?? 45));
                    await waitWithAbort(clickHoldMs, signal, 'during click hold');
                    await clickGuard.release();
                  } finally {
                    await clickGuard.compensate();
                  }
                } else if (action === 'double_click') {
                  await animateAgentCursorClick(tabId, x, y, actNote);
                  // First click
                  throwIfAborted(signal, 'before double_click first press');
                  const firstClickGuard = createMousePressGuard(
                    (params) => raceCdp(tabId, 'Input.dispatchMouseEvent', params),
                    {
                      type: 'mouseReleased',
                      x,
                      y,
                      button: clickButton,
                      buttons: 0,
                      clickCount: 1,
                      modifiers: modifierMask,
                    },
                  );
                  try {
                    await firstClickGuard.press({
                      type: 'mousePressed',
                      x,
                      y,
                      button: clickButton,
                      buttons: clickButtons,
                      clickCount: 1,
                      modifiers: modifierMask,
                    });
                    await waitWithAbort(45, signal, 'during double_click first hold');
                    await firstClickGuard.release();
                    actionDispatched = true;
                  } finally {
                    await firstClickGuard.compensate();
                  }
                  // Inter-click pause for OS double-click recognition
                  await waitWithAbort(60, signal, 'between double_click presses');
                  // Second click with clickCount: 2
                  throwIfAborted(signal, 'before double_click second press');
                  await animateAgentCursorClick(tabId, x, y, actNote);
                  await dispatchMousePressRelease(
                    (params) => raceCdp(tabId, 'Input.dispatchMouseEvent', params),
                    {
                      type: 'mousePressed',
                      x,
                      y,
                      button: clickButton,
                      buttons: clickButtons,
                      clickCount: 2,
                      modifiers: modifierMask,
                    },
                    {
                      type: 'mouseReleased',
                      x,
                      y,
                      button: clickButton,
                      buttons: 0,
                      clickCount: 2,
                      modifiers: modifierMask,
                    },
                  );
                } else if (action === 'right_click') {
                  await animateAgentCursorClick(tabId, x, y, actNote);
                  const rightPrePress = Math.max(
                    0,
                    Math.min(
                      300,
                      (args as any).prePressDelayMs ?? (args.humanize === true ? 80 : 0),
                    ),
                  );
                  if (rightPrePress > 0) {
                    await new Promise((r) => setTimeout(r, rightPrePress));
                  }
                  throwIfAborted(signal, 'before right_click press');
                  await dispatchMousePressRelease(
                    (params) => raceCdp(tabId, 'Input.dispatchMouseEvent', params),
                    {
                      type: 'mousePressed',
                      x,
                      y,
                      button: 'right',
                      buttons: 2,
                      clickCount: 1,
                      modifiers: modifierMask,
                    },
                    {
                      type: 'mouseReleased',
                      x,
                      y,
                      button: 'right',
                      buttons: 0,
                      clickCount: 1,
                      modifiers: modifierMask,
                    },
                  );

                  // Secondary guarantee for right_click: contextmenu synthetic event
                  try {
                    const targetSubframeScope =
                      targetFrameId && targetFrameId !== 0
                        ? { tabId, frameIds: [targetFrameId] }
                        : { tabId };
                    if (typeof args.index === 'number') {
                      await executeInPage(targetSubframeScope, 'inPageInteractIndex', [
                        args.index,
                        'right_click',
                      ]);
                    } else {
                      await executeInPage(targetSubframeScope, 'inPageDispatchSyntheticClick', [
                        x,
                        y,
                        'right_click',
                      ]);
                    }
                  } catch {}
                } else if (action === 'hover') {
                  // Mouse movement already dispatched above
                }
              });
              usedNativeCDP = true;
            } finally {
              if (shouldLockScroll) {
                await executeInPage({ tabId }, 'inPageLockScroll', [false]).catch(() => {});
              }
            }
          } catch (cdpErr) {
            if (args.expectedGuard !== undefined) {
              netCapture.dispose();
              throw cdpErr;
            }
            if (cdpErr instanceof DialogOpenedError) {
              throw cdpErr;
            }
            if (cdpErr instanceof StalePageError) {
              netCapture.dispose();
              return createTargetOccludedResponse(cdpErr);
            }
            if (isCdpOutcomeUncertainError(cdpErr)) {
              let isCaptcha = false;
              try {
                const checkRes = (await executeInPage({ tabId }, 'inPageCheckCaptcha', []))?.[0]
                  ?.result;
                isCaptcha = Boolean(checkRes?.detected);
              } catch {}
              if (isCaptcha) {
                return createErrorResponse(
                  `[CAPTCHA_BLOCKED: Slider / human verification detected] The page is blocked by anti-bot verification. Call ${resolveToolName('request_human_intervention')} to let the user solve it.`,
                );
              }
              return createErrorResponse(
                `${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}. Hint: If a native dialog is open, call ${resolveToolName('handle_dialog')}. If this is a slider or captcha verification, call ${resolveToolName('request_human_intervention')}.`,
              );
            }
            if (cdpErr instanceof TaskCancelledError) {
              netCapture.dispose();
              throw cdpErr;
            }
            if (visionFrame) {
              netCapture.dispose();
              return createErrorResponse(cdpErr instanceof Error ? cdpErr.message : String(cdpErr));
            }
            if (args.captureId) {
              netCapture.dispose();
              return createErrorResponse(
                `${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}. The capture-bound action was not replayed through the synthetic fallback; inspect page state before retrying.`,
              );
            }
            console.warn(
              `CDP native mouse event dispatch failed for tab ${tabId}, falling back to synthetic event:`,
              cdpErr,
            );
            // Fallback to inPageInteractIndex if CDP is unavailable and index is provided
            if (typeof args.index === 'number' && args.index > 0) {
              if (args.button === 'middle') {
                return createErrorResponse(
                  `CDP middle click failed for index [${args.index}]: ${
                    cdpErr instanceof Error ? cdpErr.message : String(cdpErr)
                  }`,
                );
              }
              const frameTarget = targetFrameId ? { tabId, frameIds: [targetFrameId] } : { tabId };
              const fallbackResults = await executeInPage(frameTarget, 'inPageInteractIndex', [
                args.index,
                action,
              ]);
              const fallbackOutcome = fallbackResults?.[0]?.result;
              if (!fallbackOutcome?.success) {
                return createErrorResponse(
                  fallbackOutcome?.error || `Failed to interact with index [${args.index}]`,
                );
              }
            } else {
              return createErrorResponse(
                `CDP mouse event dispatch failed for visual coordinates (${x}, ${y}): ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`,
              );
            }
          }
        }

        // 3. Action Settle & Auto-Wait Watchdog
        let settleResult: any = undefined;
        let networkSettled: boolean | undefined = undefined;

        if (args.waitForNetworkQuiescence) {
          networkSettled = await waitForNetworkQuiescence(tabId, args.quiescenceTimeoutMs || 2000);
        }

        if (args.waitForSettle) {
          settleResult = await waitForPageSettle(tabId, {
            timeoutMs: args.settleTimeoutMs,
            action: { kind: action, node: args.index },
          });
        }

        // D1: read back the delivery probe. Only meaningful when armed and the
        // action used native CDP (synthetic fallback fires the same listeners
        // synchronously, so a false there would be a probe artifact).
        // If native CDP click delivery is uncertain, return verifiable diagnostic
        // hints without blind synthetic re-dispatch (avoids double submission / toggle bounce).
        let deliveryVerified: boolean | undefined;
        let deliveryHits: any[] | undefined;
        let deliveryWarning: string | undefined;
        if (probeArmed && usedNativeCDP) {
          try {
            const probe = (await executeInPage(targetScope, 'inPageReadDeliveryProbe', [true]))?.[0]
              ?.result;
            deliveryVerified = Boolean(probe?.delivered);
            if (!deliveryVerified) {
              deliveryHits = probe?.hits ?? [];
              deliveryWarning = maskPierced
                ? `Native click was dispatched over transient overlay (${maskPierced.description}), but delivery probe was unconfirmed. Inspect page state before retrying.`
                : 'Native click was dispatched via CDP, but delivery probe was unconfirmed (possible background throttling, custom pointer handler, or late event). Inspect page state before retrying.';
            }
          } catch {
            deliveryVerified = undefined;
          }
        }

        if (visionFrame && deliveryVerified === false) {
          return createErrorResponse(
            'Visual click delivery is unverified; inspect page state before any further action.',
          );
        }

        // Visibility: screenshot-context TTL silently expires after 5 minutes;
        // surface the remaining budget so stale coordinate projection is detected
        const ctxTtlMs = visionFrame
          ? screenshotContextManager.getVisionFrameTtlRemaining(visionFrame.id)
          : screenshotContextManager.getTtlRemaining(tabId);
        const screenshotCtxWarning =
          ctxTtlMs >= 0 && ctxTtlMs < 30_000
            ? `screenshot coordinate context expires in ${Math.round(ctxTtlMs / 1000)}s; re-capture to refresh`
            : undefined;

        const observation =
          !args.expectedGuard && args.includeDelta !== false
            ? await captureChainedSnapshot(tabId, previousUrl, {
                maxItems: 10,
                delayMs: 80,
                frameId: targetFrameId,
              })
            : undefined;
        const chainedSnapshot = observation?.summary;
        const delta = args.includeDelta === true ? observation?.delta : undefined;

        let currentUrl = previousUrl;
        try {
          const updatedTab = await chrome.tabs.get(tabId);
          currentUrl = updatedTab.url || previousUrl;
        } catch {}
        const urlChanged = Boolean(previousUrl && currentUrl && previousUrl !== currentUrl);

        const networkResult = await netCapture.waitForResult();

        const postSignature = await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
          .then((r) => r?.[0]?.result)
          .catch(() => null);
        const perceptiveDelta = computePerceptiveDelta(preSignature, postSignature);

        const goalObservation = args.expectedGuard
          ? await captureGoalObservation(tabId, args.sessionId || args.sessionContext)
          : undefined;

        const tabHandover = handoverTracker ? await handoverTracker.waitForHandover(800) : null;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  interaction: makeInteractionOutcome('dispatched'),
                  urlChanged,
                  previousUrl,
                  currentUrl,
                  index: args.index ?? null,
                  action,
                  tagName,
                  text,
                  ...(coordWarning || deliveryWarning
                    ? { warning: [coordWarning, deliveryWarning].filter(Boolean).join('; ') }
                    : {}),
                  ...(deliveryWarning ? { deliveryWarning } : {}),
                  ...(networkResult ? { networkResult } : {}),
                  isTrusted: usedNativeCDP,
                  ...(coordResult?.method
                    ? {
                        actionability: {
                          method: coordResult.method,
                          stableFrames: coordResult.stableFrames,
                        },
                      }
                    : {}),
                  coordinates: { x, y },
                  ...(args.captureId && captureBindingValidated
                    ? {
                        captureId: args.captureId,
                        captureValidated: true,
                        captureValidationBoundary: SCREENSHOT_CAPTURE_VALIDATION_BOUNDARY,
                      }
                    : {}),
                  ...(tabHandover ? { tabHandover } : {}),
                  ...(maskPierced ? { piercedOverlay: maskPierced } : {}),
                  mode: isFallback
                    ? 'hybrid_visual_fallback'
                    : hasCoord && !hasIndex
                      ? 'visual_coordinate'
                      : 'dom_index',
                  modifiers: args.modifiers || [],
                  humanized: Boolean(args.humanize),
                  drag: action === 'drag' ? dragOutcome : undefined,
                  settle: settleResult,
                  ...(typeof networkSettled === 'boolean' ? { networkSettled } : {}),
                  screenshotCtxWarning,
                  ...(affinityWarning ? { affinityWarning } : {}),
                  ...(delta ? { delta } : {}),
                  ...(chainedSnapshot ? { chainedSnapshot } : {}),
                  ...(perceptiveDelta ? { perceptiveDelta } : {}),
                  ...(goalObservation ? { goalObservation } : {}),
                  ...(deliveryVerified === undefined
                    ? {}
                    : deliveryVerified
                      ? { deliveryVerified: true }
                      : { deliveryVerified: false, deliveryHits: deliveryHits ?? [] }),
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      };

      try {
        const result = args.skipLock
          ? await withActionReceipt(tabId, runAction)
          : await sessionTabAffinity.runSerialized(tabId, () =>
              withActionReceipt(tabId, runAction),
            );
        return normalizeInteractionFailure(result);
      } finally {
        // Every exit path must release the tracker, otherwise its navigation and tab
        // listeners leak for the life of the extension.
        cancelHandoverTracker();
      }
    } catch (error) {
      if ((error as any)?.status === 'blocked' && (error as any)?.requestDispatched === false) {
        return attachActionReceipt(
          {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  status: 'blocked',
                  requestDispatched: false,
                  interaction: makeInteractionOutcome('not_dispatched', 'not_requested'),
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          },
          (error as any)?.receipt,
        );
      }
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      if (error instanceof TaskCancelledError && actionDispatched) {
        return attachActionReceipt(
          {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  status: 'unknown',
                  retry: false,
                  dispatched: true,
                  interaction: makeInteractionOutcome('unknown', 'not_requested', error.message, 1),
                  error: error.message,
                }),
              },
            ],
            isError: true,
          },
          (error as any)?.receipt,
        );
      }
      return attachActionReceipt(
        createInteractionErrorResponse(
          `Error executing ${resolveToolName('interact_index')}: ${error instanceof Error ? error.message : String(error)}`,
          makeInteractionOutcome(
            actionDispatched ? 'unknown' : 'not_dispatched',
            'not_requested',
            actionDispatched ? 'dispatch_unknown' : 'interaction_preparation_failed',
            actionDispatched ? 1 : 0,
          ),
          {
            status: actionDispatched ? 'unknown' : 'blocked',
            requestDispatched: actionDispatched,
            retry: actionDispatched ? false : true,
          },
        ),
        (error as any)?.receipt,
      );
    }
  }
}

export const interactIndexTool = new InteractIndexTool();
