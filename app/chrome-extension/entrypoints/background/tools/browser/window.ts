import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { scrubUrl } from '@/utils/url-sanitizer';
import { tabGroupManager } from './tab-group-manager';
import { getBrowserInstanceId } from '@/utils/browser-identity';
import { downloadsWatchdog } from '../../watchdogs/downloads-watchdog';

class WindowTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS;
  async execute(): Promise<ToolResult> {
    try {
      await tabGroupManager.ensureStorageLoaded();
      let sourceDownloads = false;
      try {
        await downloadsWatchdog.ensureReady();
        sourceDownloads = downloadsWatchdog.sourceTrackingAvailable;
      } catch {
        // Inventory remains usable; source-scoped download calls must fail closed.
      }
      const windows = await chrome.windows.getAll({ populate: true });
      const browserInstanceId = await getBrowserInstanceId();
      const documentIds = new Map<number, string>();
      await Promise.all(
        windows.flatMap((window) =>
          (window.tabs || []).map(async (tab) => {
            if (typeof tab.id !== 'number') return;
            try {
              const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
              if (frame?.documentId) documentIds.set(tab.id, frame.documentId);
            } catch {
              // Restricted or closing pages have no verifiable document identity.
            }
          }),
        ),
      );
      let tabCount = 0;

      const structuredWindows = windows.map((window) => {
        const tabs =
          window.tabs?.map((tab) => {
            tabCount++;
            return {
              tabId: tab.id || 0,
              documentId: documentIds.get(tab.id || 0),
              openerTabId: tab.openerTabId,
              url: scrubUrl(tab.url || ''),
              pendingUrl: tab.pendingUrl ? scrubUrl(tab.pendingUrl) : null,
              title: tab.title || '',
              active: tab.active || false,
              // 'unloaded'/'loading'/'complete' distinguishes blank placeholders
              // from real pages when debugging why input silently misses a tab.
              status: tab.status || 'unknown',
              // discardable = tab dropped from memory; a strong hint that the
              // renderer is not live and CDP input will not be acked.
              discarded: tab.discarded ?? false,
              downloads: sourceDownloads ? downloadsWatchdog.getPageDownloads(tab.id || 0) : [],
              isAgentManaged:
                typeof tab.id === 'number' ? tabGroupManager.isAgentTab(tab.id) : false,
            };
          }) || [];

        return {
          windowId: window.id || 0,
          // Window geometry/state make occlusion observable: a minimized or
          // fully covered window is why CDP input can be dropped silently.
          focused: window.focused ?? false,
          state: window.state || 'normal',
          bounds: {
            left: window.left ?? null,
            top: window.top ?? null,
            width: window.width ?? null,
            height: window.height ?? null,
          },
          tabs: tabs,
        };
      });

      const result = {
        browserInstanceId,
        capabilities: { sourceDownloads },
        windowCount: windows.length,
        tabCount: tabCount,
        windows: structuredWindows,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in WindowTool.execute:', error);
      return createErrorResponse(
        `Error getting windows and tabs information: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const windowTool = new WindowTool();
