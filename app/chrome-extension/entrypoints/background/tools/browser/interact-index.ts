import { createErrorResponse, ToolResult } from '../../../../common/tool-handler';
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
import { screenshotContextManager, scaleCoordinates } from '../../../../utils/screenshot-context';
import { screenshotOriginViolation } from '../../../../utils/screenshot-guard';
import { computeHumanizedPoints } from '../../../../utils/mouse-trajectory';
import type { CdpEventObserver } from '../../../../utils/cdp-session-manager';
import {
  parseUnifiedCoordinate,
  type PolymorphicCoordinate,
} from '../../../../utils/coordinate-parser';
import { sessionTabAffinity } from '../../../../utils/session-tab-affinity';
import { animateAgentCursor, animateAgentCursorClick } from './agent-cursor';
import {
  captureDeltaIfRequested,
  ensureSnapshotBaseline,
  captureChainedSnapshotSummary,
} from '../../../../utils/delta-helper';
import { tabFaviconManager } from './tab-favicon';
import { startActionNetworkCapture } from '../../../../utils/action-network-capture';

export interface InteractIndexParams {
  index?: number;
  coordinate?: { x: number; y: number } | PolymorphicCoordinate;
  coordinateSpace?: 'viewport' | 'screenshot';
  points?: Array<{ x: number; y: number } | PolymorphicCoordinate>;
  intervalMs?: number;
  action?: 'click' | 'hover' | 'double_click' | 'right_click' | 'drag';
  path?: Array<{ x: number; y: number }>;
  end?: { index?: number; coordinate?: { x: number; y: number } | PolymorphicCoordinate };
  steps?: number;
  holdMs?: number;
  dnd?: boolean;
  modifiers?: string[];
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

export async function getSubframeViewportOffset(
  tabId: number,
  frameId: number,
): Promise<{ offsetX: number; offsetY: number }> {
  if (!frameId || frameId === 0) return { offsetX: 0, offsetY: 0 };
  let cdpOffset: { offsetX: number; offsetY: number } | null = null;
  const rawToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const probeAttr = 'data-bp-fprobe-' + rawToken.replace(/[^a-z0-9_]/gi, '');

  try {
    // Phase 1: Tag target frame document element using chrome.scripting (bridges Isolated & Main worlds)
    await chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (attrName: string) => {
          try {
            document.documentElement.setAttribute(attrName, '1');
          } catch {}
        },
        args: [probeAttr],
      })
      .catch(() => null);

    // Track 1: DOM traversal across accessible browsing context tree with full ancestor chain verification
    const domResult = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: (attrName: string) => {
          try {
            const visited = new Set<Window>();
            function findTargetIframe(win: Window): HTMLIFrameElement | null {
              if (!win || visited.has(win)) return null;
              visited.add(win);
              const iframes = Array.from(win.document.querySelectorAll('iframe'));
              for (const ifr of iframes) {
                try {
                  const doc = ifr.contentDocument || ifr.contentWindow?.document;
                  if (doc && doc.documentElement.hasAttribute(attrName)) {
                    return ifr;
                  }
                  if (ifr.contentWindow && ifr.contentWindow !== win) {
                    const deep = findTargetIframe(ifr.contentWindow);
                    if (deep) return deep;
                  }
                } catch {
                  // Inaccessible cross-origin iframe boundary
                }
              }
              return null;
            }

            const targetIfr = findTargetIframe(window);
            if (!targetIfr) return null;

            let totalX = 0;
            let totalY = 0;
            let curr: HTMLIFrameElement | null = targetIfr;
            let reachedTop = false;

            while (curr) {
              const r = curr.getBoundingClientRect();
              const win = curr.ownerDocument.defaultView || window;
              const s = win.getComputedStyle(curr);
              const bl = parseFloat(s?.borderLeftWidth || '0') || 0;
              const bt = parseFloat(s?.borderTopWidth || '0') || 0;
              totalX += r.left + bl;
              totalY += r.top + bt;

              const parentWin: any = curr.ownerDocument.defaultView;
              if (!parentWin || parentWin === window) {
                reachedTop = true;
                break;
              }

              try {
                const grandParentDoc: any = parentWin.parent?.document;
                if (!grandParentDoc) {
                  return null; // Cannot traverse parent document, fall through to Track 2
                }
                const parentIframes: any[] = Array.from(grandParentDoc.querySelectorAll('iframe'));
                const matchedParent: any = parentIframes.find(
                  (f: any) => f.contentWindow === parentWin,
                );
                if (!matchedParent) {
                  return null; // Broken parent chain, fall through to Track 2
                }
                curr = matchedParent;
              } catch {
                return null; // Cross-origin parent boundary, fall through to Track 2
              }
            }

            if (!reachedTop) {
              return null; // Partial path rejected, must reach top window
            }

            return { offsetX: Math.round(totalX), offsetY: Math.round(totalY) };
          } catch {
            return null;
          }
        },
        args: [probeAttr],
      })
      .catch(() => null);

    const track1Res = domResult?.[0]?.result;
    if (
      track1Res &&
      typeof track1Res.offsetX === 'number' &&
      typeof track1Res.offsetY === 'number'
    ) {
      return track1Res;
    }

    // Track 2: CDP FrameTree + Page.createIsolatedWorld + Runtime.evaluate({contextId}) + DOM.getFrameOwner
    if (cdpSessionManager.isAttached(tabId)) {
      try {
        await (async () => {
          await cdpSessionManager.sendCommand(tabId, 'DOM.enable').catch(() => {});
          const treeRes: any = await cdpSessionManager.sendCommand(tabId, 'Page.getFrameTree');
          const rootTree = treeRes?.frameTree;

          let matchedCdpFrameId: string | null = null;

          const checkCdpFrameNode = async (frameNode: any): Promise<string | null> => {
            if (!frameNode || !frameNode.frame) return null;
            const fid = frameNode.frame.id;
            if (fid && frameNode.frame.parentId) {
              try {
                const worldRes: any = await cdpSessionManager.sendCommand(
                  tabId,
                  'Page.createIsolatedWorld',
                  {
                    frameId: fid,
                    worldName: 'bp_probe_world_' + fid,
                    grantUniveralAccess: false,
                  },
                );
                const contextId = worldRes?.executionContextId;
                if (typeof contextId === 'number') {
                  const evalExpr =
                    "Boolean(document.documentElement && document.documentElement.hasAttribute('" +
                    probeAttr +
                    "'))";
                  const evalRes: any = await cdpSessionManager.sendCommand(
                    tabId,
                    'Runtime.evaluate',
                    {
                      contextId,
                      expression: evalExpr,
                      returnByValue: true,
                    },
                  );
                  if (evalRes?.result?.value === true) {
                    return fid; // EXACT UNAMBIGUOUS UNIQUE ATTRIBUTE MATCH
                  }
                }
              } catch {}
            }
            if (Array.isArray(frameNode.childFrames)) {
              for (const child of frameNode.childFrames) {
                const res = await checkCdpFrameNode(child);
                if (res) return res;
              }
            }
            return null;
          };

          if (rootTree) {
            matchedCdpFrameId = await checkCdpFrameNode(rootTree);
          }

          if (matchedCdpFrameId) {
            const owner: any = await cdpSessionManager.sendCommand(tabId, 'DOM.getFrameOwner', {
              frameId: matchedCdpFrameId,
            });
            if (owner?.backendNodeId) {
              const boxRes: any = await cdpSessionManager.sendCommand(tabId, 'DOM.getBoxModel', {
                backendNodeId: owner.backendNodeId,
              });
              const model = boxRes?.model;
              if (model?.content && Array.isArray(model.content) && model.content.length >= 2) {
                cdpOffset = {
                  offsetX: Math.round(model.content[0]),
                  offsetY: Math.round(model.content[1]),
                };
              }
            }
          }
        })();
      } catch (cdpErr) {
        console.warn('Track 2 CDP frame resolution failed:', cdpErr);
      }
    }

    if (cdpOffset) {
      return cdpOffset;
    }
  } finally {
    // Phase 3: Await cleanup of our specific ephemeral attribute
    await chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (attrName: string) => {
          try {
            document.documentElement.removeAttribute(attrName);
          } catch {}
        },
        args: [probeAttr],
      })
      .catch(() => null);
  }

  throw new Error(
    'Could not resolve bounding rect for subframe ' +
      frameId +
      ': target iframe not found in parent document',
  );
}

/**
 * Resolve an indexed drag endpoint in the current top-level viewport.
 */
async function resolveDragEndPoint(
  tabId: number,
  end: InteractIndexParams['end'],
): Promise<{ x: number; y: number } | null> {
  if (!end) return null;
  if (typeof end.index === 'number' && end.index > 0) {
    let coordResult: any = (
      await executeInPage({ tabId }, 'inPageGetElementCoordinates', [end.index])
    )?.[0]?.result;
    let endFrameId: number | undefined = undefined;
    if (!coordResult?.success) {
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
        const offset = await getSubframeViewportOffset(tabId, endFrameId);
        endX += offset.offsetX;
        endY += offset.offsetY;
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

  async execute(args: InteractIndexParams): Promise<ToolResult> {
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

    if (hasPoints && action !== 'click') {
      return createErrorResponse(
        'points is only supported for click sequences; use path or end for drag',
      );
    }
    if (!hasIndex && !hasCoord && !hasPoints && !hasPath) {
      return createErrorResponse(
        `Either index (positive 1-based integer) or coordinate ({ x: number, y: number }) must be provided for ${resolveToolName('interact_index')}`,
      );
    }

    const validActions = ['click', 'hover', 'double_click', 'right_click', 'drag'];
    if (!validActions.includes(action)) {
      return createErrorResponse(
        `Unsupported action "${action}". Allowed actions: ${validActions.join(', ')}`,
      );
    }

    try {
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
        return createErrorResponse(`No active tab found for ${resolveToolName('interact_index')}`);
      }

      const runAction = async (): Promise<ToolResult> => {
        const previousUrl = tab.url || '';
        tabFaviconManager.markTabActive(tabId);

        const preSignature = await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
          .then((r) => r?.[0]?.result)
          .catch(() => null);

        await ensureSnapshotBaseline(tabId, args.includeDelta !== false);

        // D3 (TESTING-NOTES #19): when no explicit tabId/session bound the
        // target, resolveAffinityTab fell through to the user's ACTIVE tab -
        // input silently landed on whatever page the user was viewing. Surface
        // that fallback in the response so the agent can correct with an
        // explicit tabId. Non-blocking for backward compatibility.
        const explicitOrBound = typeof args.tabId === 'number' || interactHadPreexistingBinding;
        const affinityWarning = explicitOrBound
          ? undefined
          : `input routed to active tab (tabId=${tabId}); pass explicit tabId to target another tab`;

        const isScreenshotSpace = args.coordinateSpace === 'screenshot';
        let screenshotCtx: any;
        if (isScreenshotSpace) {
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

        // Helper to project screenshot-space or polymorphic coordinates to viewport space
        const projectCoord = (
          c: any,
        ): { x: number; y: number; isDocumentSpace?: boolean } | null => {
          if (!c) return null;
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

          const ctx = isScreenshotSpace ? screenshotContextManager.getContext(tabId) : undefined;
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
        const handoverTracker =
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
              return createErrorResponse('Failed to parse point coordinates in points array');
            }
            const aligned = await alignVisualCoordinate(proj);
            scaledPoints.push(aligned);
          }
          let dispatched = 0;
          await executeInPage({ tabId }, 'inPageLockScroll', [true]).catch(() => {});
          try {
            await cdpSessionManager.withSession(tabId, 'interact-index', async () => {
              for (const pt of scaledPoints) {
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
            await executeInPage({ tabId }, 'inPageLockScroll', [false]).catch(() => {});
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
            return createErrorResponse('Failed to parse coordinate');
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
          coordResult = (
            await executeInPage({ tabId }, 'inPageGetElementCoordinates', [args.index!])
          )?.[0]?.result;

          // Check subframes if not in main frame
          if (!coordResult || !coordResult.success) {
            const frameResults = await executeInPage(
              { tabId, allFrames: true },
              'inPageGetElementCoordinates',
              [args.index!],
            );
            const match = frameResults.find((r) => r.result?.success);
            if (match?.result) {
              coordResult = match.result;
              targetFrameId = match.frameId;
            }
          }

          // [ACT-01] Stagehand-inspired Self-Healing Retry:
          // If the element index was momentarily detached due to dynamic framework rerendering,
          // perform a micro quiet-wait and retry coordinate resolution once before giving up.
          if (!coordResult || !coordResult.success) {
            await new Promise((r) => setTimeout(r, 120));
            coordResult = (
              await executeInPage({ tabId }, 'inPageGetElementCoordinates', [args.index!])
            )?.[0]?.result;
            if (!coordResult || !coordResult.success) {
              const frameResults = await executeInPage(
                { tabId, allFrames: true },
                'inPageGetElementCoordinates',
                [args.index!],
              );
              const match = frameResults.find((r) => r.result?.success);
              if (match?.result) {
                coordResult = match.result;
                targetFrameId = match.frameId;
              }
            }
          }

          if (!coordResult || !coordResult.success) {
            if (hasCoord) {
              // Hybrid Visual Fallback: DOM extraction failed, fallback to coordinate
              const projected = projectCoord(args.coordinate!);
              if (!projected) {
                return createErrorResponse('Failed to parse visual fallback coordinate');
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
            tagName = coordResult.tagName;
            text = coordResult.text;
            if (coordResult.warning) {
              coordWarning = coordResult.warning;
            }
            if (coordResult.isSelectOption && (action === 'click' || !action)) {
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

        if (action === 'drag') {
          if (targetFrameId && !isFallback && !coordResult?.isFrameCompensated) {
            const offset = await getSubframeViewportOffset(tabId, targetFrameId);
            x += offset.offsetX;
            y += offset.offsetY;
          }
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
              ? await resolveDragEndPoint(tabId, args.end)
              : projectCoord(args.end?.coordinate);
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
          (actName === 'click'
            ? `Clicking [${args.index ?? ''}]`
            : actName === 'hover'
              ? `Hovering [${args.index ?? ''}]`
              : actName === 'double_click'
                ? `Double clicking [${args.index ?? ''}]`
                : actName === 'focus'
                  ? `Focusing [${args.index ?? ''}]`
                  : actName);
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
              await executeInPage(targetScope, 'inPageCheckInterception', [args.index, x, y])
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
        usedNativeCDP = false;
        // 2. Compensate cumulative frame offset if target is inside a nested or cross-origin subframe
        if (
          action !== 'drag' &&
          targetFrameId !== undefined &&
          targetFrameId !== 0 &&
          !isFallback
        ) {
          const offset = await getSubframeViewportOffset(tabId, targetFrameId);
          // Only add external subframe offset if not already compensated inside page
          const alreadyCompensated = Boolean(coordResult?.isFrameCompensated);
          if (!alreadyCompensated) {
            x = x + offset.offsetX;
            y = y + offset.offsetY;
          }
        }

        let dragOutcome: any = undefined;
        if (action === 'drag') {
          dragOutcome = { dragIntercepted: false, dndDispatched: false };
          const endPoint = dragPoints![dragPoints!.length - 1];
          await cdpSessionManager.withSession(tabId, 'interact-index-drag', async () => {
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
                await new Promise((r) => setTimeout(r, holdMs));
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
                  const offset = await getSubframeViewportOffset(tabId, targetFrameId);
                  targetX += offset.offsetX;
                  targetY += offset.offsetY;
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
            await executeInPage({ tabId }, 'inPageLockScroll', [true]).catch(() => {});
            try {
              await cdpSessionManager.withSession(tabId, 'interact-index', async () => {
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
                  await animateAgentCursorClick(tabId, x, y, actNote);
                  const clickGuard = createMousePressGuard(
                    (params) => raceCdp(tabId, 'Input.dispatchMouseEvent', params),
                    {
                      type: 'mouseReleased',
                      x,
                      y,
                      button: 'left',
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
                      button: 'left',
                      buttons: 1,
                      clickCount: 1,
                      modifiers: modifierMask,
                    });
                    const clickHoldMs = Math.max(35, Math.min(3000, args.holdMs ?? 45));
                    await new Promise((r) => setTimeout(r, clickHoldMs));
                    await clickGuard.release();
                  } finally {
                    await clickGuard.compensate();
                  }
                } else if (action === 'double_click') {
                  await animateAgentCursorClick(tabId, x, y, actNote);
                  // First click
                  const firstClickGuard = createMousePressGuard(
                    (params) => raceCdp(tabId, 'Input.dispatchMouseEvent', params),
                    {
                      type: 'mouseReleased',
                      x,
                      y,
                      button: 'left',
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
                      button: 'left',
                      buttons: 1,
                      clickCount: 1,
                      modifiers: modifierMask,
                    });
                    await new Promise((r) => setTimeout(r, 45));
                    await firstClickGuard.release();
                  } finally {
                    await firstClickGuard.compensate();
                  }
                  // Inter-click pause for OS double-click recognition
                  await new Promise((r) => setTimeout(r, 60));
                  // Second click with clickCount: 2
                  await animateAgentCursorClick(tabId, x, y, actNote);
                  await dispatchMousePressRelease(
                    (params) => raceCdp(tabId, 'Input.dispatchMouseEvent', params),
                    {
                      type: 'mousePressed',
                      x,
                      y,
                      button: 'left',
                      buttons: 1,
                      clickCount: 2,
                      modifiers: modifierMask,
                    },
                    {
                      type: 'mouseReleased',
                      x,
                      y,
                      button: 'left',
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
              await executeInPage({ tabId }, 'inPageLockScroll', [false]).catch(() => {});
            }
          } catch (cdpErr) {
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
            console.warn(
              `CDP native mouse event dispatch failed for tab ${tabId}, falling back to synthetic event:`,
              cdpErr,
            );
            // Fallback to inPageInteractIndex if CDP is unavailable and index is provided
            if (typeof args.index === 'number' && args.index > 0) {
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
        let deliveryVerified: boolean | undefined;
        let deliveryHits: any[] | undefined;
        let fallbackTriggered: string | undefined;
        if (probeArmed && usedNativeCDP) {
          try {
            const probe = (await executeInPage(targetScope, 'inPageReadDeliveryProbe', [true]))?.[0]
              ?.result;
            deliveryVerified = Boolean(probe?.delivered);
            if (!deliveryVerified || maskPierced) {
              deliveryHits = probe?.hits ?? [];
              // Click Probe / Mask Piercing Fallback: if native CDP events were dropped (e.g. background tab throttling)
              // or if a transparent/transient mask intercepted the click, fall back to synthetic DOM event dispatch
              // directly on the underlying target element to ensure 100% execution.
              if (action === 'click') {
                try {
                  const synRes = (
                    await executeInPage(targetScope, 'inPageDispatchSyntheticClick', [
                      args.index ?? null,
                      x,
                      y,
                    ])
                  )?.[0]?.result;
                  if (synRes) {
                    deliveryVerified = true;
                    fallbackTriggered = maskPierced
                      ? 'synthetic_click_pierce'
                      : 'synthetic_click_probe';
                    usedNativeCDP = false;
                  }
                } catch {
                  // Ignore fallback error
                }
              }
            }
          } catch {
            deliveryVerified = undefined;
          }
        } else if (maskPierced && action === 'click') {
          try {
            const synRes = (
              await executeInPage(targetScope, 'inPageDispatchSyntheticClick', [
                args.index ?? null,
                x,
                y,
              ])
            )?.[0]?.result;
            if (synRes) {
              deliveryVerified = true;
              fallbackTriggered = 'synthetic_click_pierce';
              usedNativeCDP = false;
            }
          } catch {}
        }

        // Visibility: screenshot-context TTL silently expires after 5 minutes;
        // surface the remaining budget so stale coordinate projection is detected
        const ctxTtlMs = screenshotContextManager.getTtlRemaining(tabId);
        const screenshotCtxWarning =
          ctxTtlMs >= 0 && ctxTtlMs < 30_000
            ? `screenshot coordinate context expires in ${Math.round(ctxTtlMs / 1000)}s; re-capture to refresh`
            : undefined;

        const chainedSnapshot =
          args.includeDelta !== false
            ? await captureChainedSnapshotSummary(tabId, previousUrl, { maxItems: 10, delayMs: 80 })
            : undefined;
        const delta =
          args.includeDelta === true ? await captureDeltaIfRequested(tabId, true, 0) : undefined;

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

        const tabHandover = handoverTracker ? await handoverTracker.waitForHandover(800) : null;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  urlChanged,
                  previousUrl,
                  currentUrl,
                  index: args.index ?? null,
                  action,
                  tagName,
                  text,
                  ...(coordWarning ? { warning: coordWarning } : {}),
                  ...(networkResult ? { networkResult } : {}),
                  isTrusted: usedNativeCDP,
                  coordinates: { x, y },
                  fallbackTriggered,
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
                  ...(deliveryVerified === undefined
                    ? {}
                    : deliveryVerified
                      ? { deliveryVerified: true }
                      : { deliveryVerified: false, deliveryHits }),
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      };

      return args.skipLock
        ? await runAction()
        : await sessionTabAffinity.runSerialized(tabId, runAction);
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      return createErrorResponse(
        `Error executing ${resolveToolName('interact_index')}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const interactIndexTool = new InteractIndexTool();
