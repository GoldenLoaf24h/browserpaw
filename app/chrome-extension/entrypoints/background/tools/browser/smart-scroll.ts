import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { raceCdp, DialogOpenedError, createDialogInterruptResponse } from '@/utils/race-cdp';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { executeInPage } from './in-page-engine';
import type { SmartScrollTargetInfo } from './dom-indexer';
import { parseUnifiedCoordinate, type PolymorphicCoordinate } from '@/utils/coordinate-parser';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { animateAgentCursor } from './agent-cursor';

export interface SmartScrollParams {
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  direction?: 'down' | 'up' | 'left' | 'right';
  amount?: string | number;
  selector?: string;
  ref?: number;
  index?: number;
  coordinate?: { x: number; y: number } | PolymorphicCoordinate;
  smooth?: boolean;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  note?: string;
  actionNote?: string;
}

// Background/occluded tabs never ack CDP wheel dispatches; remember the failure
// briefly so consecutive scrolls don't each burn the 3s race before falling back.
const smartScrollWheelSkipUntil = new Map<number, number>();

if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onActivated?.addListener?.(({ tabId }) => {
    smartScrollWheelSkipUntil.delete(tabId);
  });
  chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url) {
      smartScrollWheelSkipUntil.delete(tabId);
    }
  });
  chrome.tabs.onRemoved?.addListener?.((tabId) => {
    smartScrollWheelSkipUntil.delete(tabId);
  });
}

/**
 * Intelligent Container Scrolling Tool
 * Automatically discovers the most prominent scrollable container or targets
 * an element by selector, ref, or coordinate, executing physical wheel scroll with fallback.
 */
export class SmartScrollTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SMART_SCROLL;

  async execute(args: SmartScrollParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId,
      });

      if (!tab.id) {
        return createErrorResponse('No active tab found for chrome_smart_scroll');
      }

      const tabId = tab.id;

      return await sessionTabAffinity.runSerialized(tabId, async () => {
        const direction = args.direction || 'down';

        let resolvedCoordinate = args.coordinate;
        if (args.coordinate) {
          const parsed = parseUnifiedCoordinate(args.coordinate, { tabId });
          if (parsed) {
            resolvedCoordinate = parsed;
          }
        }

        const refIndex = args.ref ?? args.index;

        // Targeted scroll: if an indexed element is specified without explicit direction/amount,
        // bring it into safe view respecting sticky margins and safe viewport margin
        if (typeof refIndex === 'number' && refIndex > 0 && !args.direction && !args.amount) {
          await executeInPage({ tabId }, 'inPageScrollToIndex', [refIndex]);
        }

        // 1. Locate optimal scroll target container
        const targetResults = await executeInPage({ tabId }, 'inPageFindSmartScrollTarget', [
          {
            selector: args.selector,
            ref: refIndex,
            coordinate: resolvedCoordinate,
            direction,
          },
        ]);

        const target = (targetResults?.[0]?.result || {
          found: true,
          isWindow: true,
          tagName: 'window',
          x: 400,
          y: 300,
          width: 800,
          height: 600,
          scrollLeft: 0,
          scrollTop: 0,
          scrollWidth: 800,
          scrollHeight: 1200,
          clientWidth: 800,
          clientHeight: 600,
          canScrollDown: true,
          canScrollUp: false,
          canScrollRight: false,
          canScrollLeft: false,
        }) as SmartScrollTargetInfo;

        // 2. Compute pixel distance
        let pixelDistance: number;
        const refHeight = target.isWindow ? target.height : target.clientHeight;
        const refWidth = target.isWindow ? target.width : target.clientWidth;

        if (args.amount === 'half_page') {
          pixelDistance = Math.round(
            (direction === 'left' || direction === 'right' ? refWidth : refHeight) * 0.5,
          );
        } else if (args.amount === 'page' || args.amount === undefined) {
          pixelDistance = Math.round(
            (direction === 'left' || direction === 'right' ? refWidth : refHeight) * 0.85,
          );
        } else {
          const parsed = Number(args.amount);
          pixelDistance = !isNaN(parsed) && parsed > 0 ? parsed : Math.round(refHeight * 0.85);
        }

        let deltaX = 0;
        let deltaY = 0;
        if (direction === 'down') deltaY = pixelDistance;
        else if (direction === 'up') deltaY = -pixelDistance;
        else if (direction === 'right') deltaX = pixelDistance;
        else if (direction === 'left') deltaX = -pixelDistance;

        let isBackground = false;
        try {
          const fullTab = await chrome.tabs.get(tabId).catch(() => null);
          isBackground = Boolean(fullTab && !fullTab.active);
        } catch {}

        const scrollLabel =
          args.note ||
          args.actionNote ||
          (direction === 'down'
            ? 'Scrolling down timeline'
            : direction === 'up'
              ? 'Scrolling back up'
              : direction === 'right'
                ? 'Scrolling right'
                : 'Scrolling left');

        // Animate virtual agent cursor smoothly to target container before physical scrolling
        if (!isBackground) {
          try {
            await animateAgentCursor(tabId, target.x, target.y, {
              waitForArrival: true,
              timeoutMs: 350,
              actionNote: scrollLabel,
            });
          } catch {}
        }

        // 3. Attempt physical CDP mouseWheel scroll
        let cdpSuccess = false;
        const skipUntil = smartScrollWheelSkipUntil.get(tabId) || 0;
        if (!isBackground && skipUntil < Date.now()) {
          try {
            await cdpSessionManager.withSession(tabId, 'smart_scroll', async () => {
              if (args.smooth !== false) {
                // Progressive multi-step wheel easing matching macOS momentum curve (10-14 steps over ~180-260ms)
                const STEPS = Math.abs(deltaY || deltaX) > 400 ? 14 : 10;
                const stepDelayMs = 18;
                let accumulatedX = 0;
                let accumulatedY = 0;

                for (let i = 1; i <= STEPS; i++) {
                  // Sinusoidal ease-in-out curve
                  const progress = 0.5 * (1 - Math.cos((Math.PI * i) / STEPS));
                  const targetX = Math.round(deltaX * progress);
                  const targetY = Math.round(deltaY * progress);
                  const stepX = targetX - accumulatedX;
                  const stepY = targetY - accumulatedY;
                  accumulatedX += stepX;
                  accumulatedY += stepY;

                  if (stepX !== 0 || stepY !== 0) {
                    await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mouseWheel',
                      x: target.x,
                      y: target.y,
                      deltaX: stepX,
                      deltaY: stepY,
                    });
                  }
                  if (i < STEPS) {
                    await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
                  }
                }
              } else {
                await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                  type: 'mouseWheel',
                  x: target.x,
                  y: target.y,
                  deltaX,
                  deltaY,
                });
              }
            });
            cdpSuccess = true;
            smartScrollWheelSkipUntil.delete(tabId);
          } catch (wheelErr) {
            if (wheelErr instanceof DialogOpenedError) {
              return createDialogInterruptResponse(wheelErr);
            }
            smartScrollWheelSkipUntil.set(tabId, Date.now() + 60_000);
            console.warn(
              '[SmartScrollTool] CDP wheel dispatch failed, falling back to in-page scroll:',
              wheelErr,
            );
            // Fall back to in-page scroll
          }
        }

        // 4. In-page scroll fallback if CDP wheel failed
        if (!cdpSuccess) {
          await executeInPage({ tabId }, 'inPagePerformSmartScroll', [
            target.isWindow,
            target.selector,
            deltaX,
            deltaY,
            args.smooth !== false,
          ]);
        }

        // 5. Wait for page settle
        let settleResult: any = undefined;
        if (args.waitForSettle !== false) {
          settleResult = await waitForPageSettle(tabId, { timeoutMs: args.settleTimeoutMs });
        }

        // 6. Inspect updated container status
        let updatedStatus: SmartScrollTargetInfo | null = null;
        try {
          const updateCheck = await executeInPage({ tabId }, 'inPageFindSmartScrollTarget', [
            {
              selector: target.isWindow ? undefined : target.selector,
              ref: args.ref,
              direction,
              isWindow: target.isWindow,
            },
          ]);
          updatedStatus = updateCheck?.[0]?.result as SmartScrollTargetInfo;
        } catch {}

        const currentScrollTop = updatedStatus
          ? updatedStatus.scrollTop
          : target.scrollTop + deltaY;
        const currentScrollLeft = updatedStatus
          ? updatedStatus.scrollLeft
          : target.scrollLeft + deltaX;
        const maxScrollY = Math.max(
          1,
          (updatedStatus?.scrollHeight || target.scrollHeight) -
            (updatedStatus?.clientHeight || target.clientHeight),
        );
        const scrollProgress = Math.round(
          Math.min(100, Math.max(0, (currentScrollTop / maxScrollY) * 100)),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  direction,
                  scrolledPixels: pixelDistance,
                  scrollProgress: `${scrollProgress}%`,
                  target: {
                    isWindow: target.isWindow,
                    tagName: target.tagName,
                    selector: target.selector,
                    coordinate: { x: target.x, y: target.y },
                  },
                  container: {
                    scrollTop: currentScrollTop,
                    scrollLeft: currentScrollLeft,
                    scrollHeight: updatedStatus?.scrollHeight ?? target.scrollHeight,
                    clientHeight: updatedStatus?.clientHeight ?? target.clientHeight,
                  },
                  canScrollDown: updatedStatus
                    ? updatedStatus.canScrollDown
                    : currentScrollTop < maxScrollY,
                  canScrollUp: updatedStatus ? updatedStatus.canScrollUp : currentScrollTop > 0,
                  settle: settleResult,
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      });
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      return createErrorResponse(
        `Error executing chrome_smart_scroll: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const smartScrollTool = new SmartScrollTool();
