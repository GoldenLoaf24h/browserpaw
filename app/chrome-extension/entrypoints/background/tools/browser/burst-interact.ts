import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { raceCdp, DialogOpenedError, createDialogInterruptResponse } from '@/utils/race-cdp';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { screenshotContextManager, scaleCoordinates } from '@/utils/screenshot-context';
import { parseUnifiedCoordinate, type PolymorphicCoordinate } from '@/utils/coordinate-parser';

export interface BurstInteractParams {
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  coordinateSpace?: 'viewport' | 'screenshot';
  burstClicks?: {
    center: { x: number; y: number } | PolymorphicCoordinate;
    count?: number;
    radius?: number;
    intervalMs?: number;
    button?: 'left' | 'right' | 'middle';
  };
  trajectory?: Array<{
    x: number;
    y: number;
    pauseMs?: number;
    click?: boolean;
    button?: 'left' | 'right' | 'middle';
  }>;
  keySequence?: Array<{
    key: string;
    text?: string;
    delayMs?: number;
  }>;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
}

/**
 * Ultra-low latency rapid interaction tool.
 * Executes bursts of micro clicks, humanized movement trajectories, or key sequences
 * directly over CDP without per-action roundtrip latency.
 */
export class BurstInteractTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.BURST_INTERACT;

  async execute(args: BurstInteractParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId,
      });

      if (!tab.id) {
        return createErrorResponse('No active tab found for chrome_burst_interact');
      }

      const tabId = tab.id;
      const startTime = Date.now();
      let executedActions = 0;

      const isScreenshotSpace = args.coordinateSpace === 'screenshot';
      const projectCoord = (c: any): { x: number; y: number } => {
        const parsed = parseUnifiedCoordinate(c, { tabId });
        if (parsed) return parsed;
        if (!isScreenshotSpace) return { x: Math.round(c.x), y: Math.round(c.y) };
        const ctx = screenshotContextManager.getContext(tabId);
        if (!ctx) return { x: Math.round(c.x), y: Math.round(c.y) };
        const scaled = scaleCoordinates(c.x, c.y, ctx);
        return { x: scaled.x, y: scaled.y };
      };

      await cdpSessionManager.withSession(tabId, 'burst_interact', async () => {
        // 1. Burst clicks
        if (args.burstClicks) {
          const { center: rawCenter, count = 5, radius = 0, intervalMs = 10, button = 'left' } = args.burstClicks;
          const center = projectCoord(rawCenter);
          const totalClicks = Math.max(1, Math.min(100, count));

          for (let i = 0; i < totalClicks; i++) {
            let cx = center.x;
            let cy = center.y;
            if (radius > 0) {
              const angle = Math.random() * 2 * Math.PI;
              const dist = Math.random() * radius;
              cx = Math.round(center.x + Math.cos(angle) * dist);
              cy = Math.round(center.y + Math.sin(angle) * dist);
            }

            await raceCdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: cx,
              y: cy,
            });

            await raceCdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: cx,
              y: cy,
              button,
              clickCount: 1,
            });

            await raceCdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: cx,
              y: cy,
              button,
            });

            executedActions++;

            if (intervalMs > 0 && i < totalClicks - 1) {
              await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
          }
        }

        // 2. Trajectory nodes
        if (args.trajectory && Array.isArray(args.trajectory)) {
          for (let i = 0; i < args.trajectory.length; i++) {
            const rawPoint = args.trajectory[i];
            const projected = projectCoord(rawPoint);
            const point = {
              ...rawPoint,
              x: projected.x,
              y: projected.y,
            };
            await raceCdp(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: point.x,
              y: point.y,
            });
            executedActions++;

            if (point.click) {
              const button = point.button || 'left';
              await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: point.x,
                y: point.y,
                button,
                clickCount: 1,
              });

              await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: point.x,
                y: point.y,
                button,
              });
            }

            if (point.pauseMs && point.pauseMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, point.pauseMs));
            }
          }
        }

        // 3. Key sequence
        if (args.keySequence && Array.isArray(args.keySequence)) {
          for (let i = 0; i < args.keySequence.length; i++) {
            const item = args.keySequence[i];
            await raceCdp(tabId, 'Input.dispatchKeyEvent', {
              type: item.text ? 'keyDown' : 'rawKeyDown',
              key: item.key,
              text: item.text,
              unmodifiedText: item.text,
            });

            if (item.text) {
              await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                type: 'char',
                text: item.text,
                unmodifiedText: item.text,
              });
            }

            await raceCdp(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: item.key,
            });

            executedActions++;

            if (item.delayMs && item.delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, item.delayMs));
            }
          }
        }
      });

      let settleResult: any = undefined;
      if (args.waitForSettle) {
        settleResult = await waitForPageSettle(tabId, { timeoutMs: args.settleTimeoutMs });
      }

      const elapsedMs = Date.now() - startTime;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                executedActions,
                elapsedMs,
                settle: settleResult,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      return createErrorResponse(
        `Error executing chrome_burst_interact: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const burstInteractTool = new BurstInteractTool();
