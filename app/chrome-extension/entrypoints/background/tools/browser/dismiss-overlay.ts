import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { tabFaviconManager } from './tab-favicon';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { raceCdp, createMousePressGuard } from '@/utils/race-cdp';

export interface DismissOverlayToolParams {
  tabId?: number;
  windowId?: number;
  maxOverlays?: number;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  sessionId?: string;
  sessionContext?: string;
}

export class DismissOverlayTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DISMISS_OVERLAY;

  async execute(args: DismissOverlayToolParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse('No active tab found for chrome_dismiss_overlay');
      }
      const targetTabId: number = tab.id;
      tabFaviconManager.markTabActive(targetTabId);

      const maxDismissals =
        typeof args.maxOverlays === 'number' && args.maxOverlays > 0 ? args.maxOverlays : 5;

      const inPageRes = (
        await executeInPage({ tabId: targetTabId }, 'inPageDismissOverlays', [{ maxDismissals }])
      )?.[0]?.result;

      // Native CDP physical click fallback for React/Vue frameworks requiring isTrusted === true.
      // Punch-Through prevention: evaluate each overlay individually. Only fallback to CDP click
      // if the specific overlay did NOT dismiss from synthetic click AND its coordinates still
      // point to an active overlay, preventing punch-through to underlying page elements while
      // ensuring second-layer overlays are not skipped.
      const clickErrors: string[] = [];
      if (Array.isArray(inPageRes?.overlays) && inPageRes.overlays.length > 0) {
        const clickableOverlays = inPageRes.overlays.filter(
          (ov: any) =>
            (ov.needsPhysicalFallback === true ||
              (ov.dismissed !== true && (inPageRes?.dismissedCount ?? 0) === 0)) &&
            typeof ov.x === 'number' &&
            typeof ov.y === 'number',
        );
        if (clickableOverlays.length > 0) {
          try {
            await cdpSessionManager.withSession(targetTabId, 'dismiss-overlay', async () => {
              for (const ov of clickableOverlays) {
                const guard = createMousePressGuard(
                  (eventParams) => raceCdp(targetTabId, 'Input.dispatchMouseEvent', eventParams),
                  {
                    type: 'mouseReleased',
                    x: ov.x,
                    y: ov.y,
                    button: 'left',
                    buttons: 0,
                    clickCount: 1,
                  },
                );
                try {
                  await guard.press({
                    type: 'mousePressed',
                    x: ov.x,
                    y: ov.y,
                    button: 'left',
                    buttons: 1,
                    clickCount: 1,
                  });
                  await new Promise((r) => setTimeout(r, 25));
                  await guard.release();
                } finally {
                  await guard.compensate();
                }
                (ov as any).isTrusted = true;
                (ov as any).dismissed = true;
                inPageRes.dismissedCount = (inPageRes.dismissedCount ?? 0) + 1;
              }
            });
          } catch (error) {
            // Surface the failure instead of reporting a dismissal that never happened.
            clickErrors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }

      if (args.waitForSettle !== false && (inPageRes?.dismissedCount ?? 0) > 0) {
        await waitForPageSettle(targetTabId, {
          timeoutMs: args.settleTimeoutMs ?? 800,
        });
      }

      const dismissedCount = inPageRes?.dismissedCount ?? 0;
      const success = clickErrors.length === 0;
      const outcome = {
        success,
        tabId: targetTabId,
        dismissedCount,
        overlays: inPageRes?.overlays ?? [],
        ...(clickErrors.length > 0 ? { errors: clickErrors } : {}),
        message:
          success && dismissedCount > 0
            ? `Successfully dismissed ${dismissedCount} overlay(s)/popup(s)`
            : success
              ? 'No active marketing popups or overlays detected on the page'
              : dismissedCount > 0
                ? `Dismissed ${dismissedCount} overlay(s), but ${clickErrors.length} physical click fallback(s) failed: ${clickErrors.join('; ')}`
                : `No overlay was dismissed: physical click fallback failed (${clickErrors.join('; ')})`,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(outcome),
          },
        ],
        isError: !success,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_dismiss_overlay: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const dismissOverlayTool = new DismissOverlayTool();
