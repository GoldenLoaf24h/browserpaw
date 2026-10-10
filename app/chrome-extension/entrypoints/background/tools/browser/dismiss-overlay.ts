import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { tabFaviconManager } from './tab-favicon';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { raceCdp } from '@/utils/race-cdp';

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
      if (Array.isArray(inPageRes?.overlays) && inPageRes.overlays.length > 0) {
        const clickableOverlays = inPageRes.overlays.filter(
          (ov: any) =>
            (ov.needsPhysicalFallback === true || (ov.dismissed !== true && (inPageRes?.dismissedCount ?? 0) === 0)) &&
            typeof ov.x === 'number' &&
            typeof ov.y === 'number',
        );
        if (clickableOverlays.length > 0) {
          try {
            await cdpSessionManager.withSession(targetTabId, 'dismiss-overlay', async () => {
              for (const ov of clickableOverlays) {
                await raceCdp(targetTabId, 'Input.dispatchMouseEvent', {
                  type: 'mousePressed',
                  x: ov.x,
                  y: ov.y,
                  button: 'left',
                  buttons: 1,
                  clickCount: 1,
                });
                await new Promise((r) => setTimeout(r, 25));
                await raceCdp(targetTabId, 'Input.dispatchMouseEvent', {
                  type: 'mouseReleased',
                  x: ov.x,
                  y: ov.y,
                  button: 'left',
                  buttons: 0,
                  clickCount: 1,
                });
                (ov as any).isTrusted = true;
                (ov as any).dismissed = true;
                inPageRes.dismissedCount = (inPageRes.dismissedCount ?? 0) + 1;
              }
            });
          } catch {}
        }
      }

      if (args.waitForSettle !== false && (inPageRes?.dismissedCount ?? 0) > 0) {
        await waitForPageSettle(targetTabId, {
          timeoutMs: args.settleTimeoutMs ?? 800,
        });
      }

      const outcome = {
        success: true,
        tabId: targetTabId,
        dismissedCount: inPageRes?.dismissedCount ?? 0,
        overlays: inPageRes?.overlays ?? [],
        message:
          (inPageRes?.dismissedCount ?? 0) > 0
            ? `Successfully dismissed ${inPageRes.dismissedCount} overlay(s)/popup(s)`
            : 'No active marketing popups or overlays detected on the page',
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(outcome),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_dismiss_overlay: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const dismissOverlayTool = new DismissOverlayTool();
